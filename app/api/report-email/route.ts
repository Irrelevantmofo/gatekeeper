import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, getGHLConfig, normalizeEmail, resolveContactCustomFields, type ResolvedCustomField, upsertContact } from "@/lib/ghl"
import { getSupabaseAdmin } from "@/lib/supabase"
import { applyCreditResultsOptinTag, CREDIT_CONTACT_SOURCE, useMockExtraction } from "@/lib/credit"
import { normalizeUsPhone } from "@/lib/otp"
import { toAnalysis, type RawExtraction } from "@/lib/credit-extraction"
import { buildBestPath, simulate, type SimScenario } from "@/lib/credit-simulator"
import { buildResultsEmailHtml } from "@/lib/results-html"

// POST /api/report-email — the user clicked "Email me my results" on the summary
// or fastest-path card. We attach their email to the SAME GHL contact created at
// /api/otp/request (phone) and enriched at /api/analyze, refresh the
// `credit_actions_html` field so the email reflects what they saw on screen
// (their live what-if + the fastest path), then apply the `credit-results-optin`
// tag which TRIGGERS the GHL results+feedback email.
//
// The email content is recomputed SERVER-SIDE from the persisted facts + the
// scenario/target the client forwards — same engine, same inputs, so it matches
// the UI exactly (no trusting client-rendered HTML). Applying the tag only AFTER
// the email is on the contact guarantees the send always has a destination.
//
// Data minimization (plan §9.3): the email is NOT persisted in Supabase; GHL is
// the system of record for contact info.

export const runtime = "nodejs"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function scenarioHasChanges(s: SimScenario): boolean {
  return (s.payDown?.length ?? 0) > 0 || Object.keys(s.factorChanges ?? {}).length > 0
}

// Human-readable labels for the changes the user toggled (for the email's
// "your simulated what-if" section). Uses the extracted accounts for creditor names.
function describeScenario(accounts: { accountId: string; creditor: string }[], s: SimScenario): string[] {
  const creditor = (id: string) => accounts.find((a) => a.accountId === id)?.creditor ?? "your card"
  const labels: string[] = []
  for (const p of s.payDown ?? []) {
    if (p.targetUtilizationPct != null) {
      labels.push(
        p.targetUtilizationPct === 0
          ? `Pay ${creditor(p.accountId)} off completely`
          : `Pay ${creditor(p.accountId)} down to ${Math.round(p.targetUtilizationPct * 100)}% used`,
      )
    } else if (p.amount != null && p.amount > 0) {
      labels.push(`Pay ${creditor(p.accountId)} $${Math.round(p.amount).toLocaleString()}`)
    }
  }
  const fc = s.factorChanges ?? {}
  if (fc.utilizationPct) labels.push(`Overall card usage to ${Math.round(fc.utilizationPct.to * 100)}%`)
  if (fc.paymentOnTimePct) labels.push(`On-time payments ${Math.round(fc.paymentOnTimePct.from * 100)}% → ${Math.round(fc.paymentOnTimePct.to * 100)}%`)
  if (fc.lengthYears) labels.push(`Credit age ${fc.lengthYears.from} → ${fc.lengthYears.to} yrs`)
  if (fc.creditMixTypes) labels.push(`Types of credit ${fc.creditMixTypes.from} → ${fc.creditMixTypes.to}`)
  if (fc.recentInquiries) labels.push(`Recent applications ${fc.recentInquiries.from} → ${fc.recentInquiries.to}`)
  return labels
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request)

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json(
      { error: "Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY configuration." },
      { status: 500, headers: cors },
    )
  }

  let body: { reportId?: string; email?: string; scenario?: SimScenario; bestPathTarget?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const reportId = body.reportId?.trim()
  const email = body.email ? normalizeEmail(body.email) : ""
  if (!reportId) {
    return NextResponse.json({ error: "reportId is required." }, { status: 400, headers: cors })
  }
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400, headers: cors })
  }

  // Find the contact this report belongs to (contact_ref set at consent/upload).
  const { data: report, error: reportErr } = await supabase
    .from("reports")
    .select("id, contact_ref")
    .eq("id", reportId)
    .single()

  if (reportErr || !report) {
    return NextResponse.json({ error: "Unknown reportId." }, { status: 404, headers: cors })
  }

  // Mock analyses never touch the real CRM (mirrors /api/analyze). Return ok so
  // the popup succeeds during frontend testing without tagging a live contact or
  // firing the real email. CREDIT_CRM_SYNC_IN_MOCK=on overrides for mapping tests.
  if (useMockExtraction() && process.env.CREDIT_CRM_SYNC_IN_MOCK !== "on") {
    console.log("[credit] report-email skipped GHL (mock mode)")
    return NextResponse.json({ ok: true, synced: false, mock: true }, { status: 200, headers: cors })
  }

  const ghl = getGHLConfig()
  if (!ghl) {
    return NextResponse.json({ ok: false, error: "Email service is temporarily unavailable." }, { status: 502, headers: cors })
  }
  if (!report.contact_ref) {
    return NextResponse.json({ ok: false, error: "No contact on file for this report." }, { status: 409, headers: cors })
  }

  try {
    // ── Build the personalized results HTML from the persisted facts + the live
    //    scenario/target the client forwarded. Best-effort: if the analysis row
    //    is missing or the custom-field scope is absent, we still attach the
    //    email + tag (the email falls back to the analyze-time snapshot field).
    let customFields: ResolvedCustomField[] = []
    const { data: analysisRow } = await supabase
      .from("report_analysis")
      .select("extracted")
      .eq("report_id", reportId)
      .single()

    if (analysisRow?.extracted) {
      const extracted = analysisRow.extracted as RawExtraction
      const input = toAnalysis(reportId, extracted)

      // Match what the user saw: their target if sent, else the tool's rule
      // (avg < 700 → aim for 700, else 850).
      const vals = extracted.scores.map((s) => s.value).filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0
      const target = Number.isFinite(body.bestPathTarget) ? (body.bestPathTarget as number) : avg >= 700 ? 850 : 700
      const bestPath = buildBestPath(input, target)

      // The "Simulation Summary" reflects the user's manual what-if when the
      // frontend forwards one. If it doesn't (they emailed straight from the
      // fastest-path card), fall back to summarizing the fastest-path scenario
      // itself — so the email ALWAYS shows BOTH a summary and the step-by-step path.
      const manual: SimScenario = body.scenario ?? {}
      const scenario: SimScenario = scenarioHasChanges(manual)
        ? manual
        : bestPath.scenario.payDown.length
          ? { payDown: bestPath.scenario.payDown }
          : {}
      const sim = scenarioHasChanges(scenario) ? simulate(input, scenario) : null
      const simActions = sim ? describeScenario(input.accounts, scenario) : []

      const html = buildResultsEmailHtml(extracted, bestPath, sim, simActions)
      if (html) {
        try {
          const r = await resolveContactCustomFields({ credit_actions_html: html }, ghl.token, ghl.locationId)
          customFields = r.resolved
          if (r.unresolved.length) console.log("[credit] report-email unresolved custom fields:", r.unresolved.join(","))
        } catch (e) {
          console.log("[credit] report-email custom-field resolve failed (attaching email+tag only):", e instanceof Error ? e.message : e)
        }
      }
    }

    const ref = report.contact_ref as string
    // Match the existing contact by its phone (normally E.164 — set at OTP/consent)
    // and add the email + refreshed results HTML. If the ref is already an email,
    // match/create on the new email. Never creates a duplicate for the phone flow.
    const phone = ref.includes("@") ? undefined : normalizeUsPhone(ref) ?? ref
    const contact = await upsertContact(
      { email, phone, source: CREDIT_CONTACT_SOURCE, customFields },
      ghl.token,
      ghl.locationId,
    )

    // Fire the automation trigger — email is now on the contact.
    await applyCreditResultsOptinTag(contact.id, ghl.token)
    console.log(`[credit] report-email ok: contact=${contact.id} fields=${customFields.length} opted in for results email`)
    return NextResponse.json({ ok: true, synced: true }, { status: 200, headers: cors })
  } catch (err) {
    console.log("[credit] report-email failed (non-fatal to user):", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "We couldn't save your email. Please try again." }, { status: 502, headers: cors })
  }
}
