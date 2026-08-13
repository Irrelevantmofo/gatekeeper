import { type NextRequest, NextResponse } from "next/server"
import crypto from "node:crypto"
import { corsHeaders, getGHLConfig, normalizeEmail, sendGhlEmail, upsertContact } from "@/lib/ghl"
import { CREDIT_REPORTS_BUCKET, getSupabaseAdmin } from "@/lib/supabase"
import { applyCreditResultsOptinTag, CREDIT_CONTACT_SOURCE, useMockExtraction } from "@/lib/credit"
import { normalizeUsPhone, sendGhlSms } from "@/lib/otp"
import { toAnalysis, type RawExtraction } from "@/lib/credit-extraction"
import { buildBestPath, simulate, type SimScenario } from "@/lib/credit-simulator"
import { buildResultsPdf } from "@/lib/results-pdf"

// POST /api/report-email — the user clicked "Email me my results".
//
// Option 2 (backend sends directly) + SMS password:
//   1. Recompute the what-if + fastest path SERVER-SIDE from the persisted facts.
//   2. Render a PASSWORD-PROTECTED PDF (random password) — results live here, NOT
//      in the email body, so credit scores are never exposed in the inbox.
//   3. Upload the PDF to Supabase → short-lived signed URL.
//   4. Send the email via the GHL Conversations API with the PDF ATTACHED (threads
//      into Conversations so a reply fires the "Customer Replied" automation).
//   5. Text the PDF password out-of-band via GHL SMS (best practice).
//   6. Apply the `credit-results-optin` tag (record / segmentation).
//
// Data minimization: no DOB is used or stored; the email address isn't persisted
// in Supabase (GHL is the system of record).

export const runtime = "nodejs"
export const maxDuration = 60

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RESULTS_PREFIX = "results"

// Random open password — 8 chars, no ambiguous glyphs (0/O/1/I/L excluded).
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  const bytes = crypto.randomBytes(8)
  let out = ""
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

function scenarioHasChanges(s: SimScenario): boolean {
  return (s.payDown?.length ?? 0) > 0 || Object.keys(s.factorChanges ?? {}).length > 0
}

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

// Short, personal, reply-first email body (18px+, 60+ audience). Results are in
// the attached PDF, not here. The reply ask is what trains inbox deliverability.
function buildEmailHtml(firstName: string | null): string {
  const hi = firstName?.trim() ? `Hi ${firstName.trim()},` : "Hi there,"
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.7;color:#0c2340;max-width:600px;margin:0 auto">
  <p style="margin:0 0 18px">${hi}</p>
  <p style="margin:0 0 18px">Your credit results are ready! For your privacy, we've attached them as a <strong>password-protected PDF</strong>.</p>
  <p style="margin:0 0 18px">🔑 <strong>We just texted your password to your phone.</strong> Open the attached PDF with that code.</p>
  <div style="border-top:2px solid #c9d2dd;margin:24px 0"></div>
  <p style="margin:0 0 12px;font-size:20px;font-weight:bold">Two quick questions — just hit reply:</p>
  <ol style="margin:0 0 18px;padding-left:26px">
    <li style="margin:0 0 14px">On a scale of <strong>1 to 5</strong>, how helpful was this?</li>
    <li>What's one thing we could do to improve it?</li>
  </ol>
  <p style="margin:0 0 18px">Even a one-word reply helps us a lot — thank you!</p>
  <p style="margin:0 0 4px">— The Credit CRB Team</p>
  <p style="margin:18px 0 0;font-size:18px;color:#33475b">P.S. If this landed in your Spam, Junk, or Promotions folder, please drag it to your inbox and mark it "Not spam" so we can reach you.</p>
</div>`
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

  const { data: report, error: reportErr } = await supabase
    .from("reports")
    .select("id, contact_ref")
    .eq("id", reportId)
    .single()
  if (reportErr || !report) {
    return NextResponse.json({ error: "Unknown reportId." }, { status: 404, headers: cors })
  }

  // Mock analyses never touch the real CRM / never send (mirrors /api/analyze).
  if (useMockExtraction() && process.env.CREDIT_CRM_SYNC_IN_MOCK !== "on") {
    console.log("[credit] report-email skipped send (mock mode)")
    return NextResponse.json({ ok: true, sent: false, mock: true }, { status: 200, headers: cors })
  }

  const ghl = getGHLConfig()
  if (!ghl) {
    return NextResponse.json({ ok: false, error: "Email service is temporarily unavailable." }, { status: 502, headers: cors })
  }
  if (!report.contact_ref) {
    return NextResponse.json({ ok: false, error: "No contact on file for this report." }, { status: 409, headers: cors })
  }

  const { data: analysisRow } = await supabase
    .from("report_analysis")
    .select("extracted")
    .eq("report_id", reportId)
    .single()
  if (!analysisRow?.extracted) {
    return NextResponse.json({ ok: false, error: "No analysis found for this report yet." }, { status: 409, headers: cors })
  }

  try {
    const extracted = analysisRow.extracted as RawExtraction
    const input = toAnalysis(reportId, extracted)

    // Target: client value, else the tool's rule (avg < 700 → 700, else 850).
    const vals = extracted.scores.map((s) => s.value).filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0
    const target = Number.isFinite(body.bestPathTarget) ? (body.bestPathTarget as number) : avg >= 700 ? 850 : 700
    const bestPath = buildBestPath(input, target)

    // Simulation summary reflects the user's manual what-if; if none was sent,
    // fall back to summarizing the fastest-path scenario so the PDF always has it.
    const manual: SimScenario = body.scenario ?? {}
    const scenario: SimScenario = scenarioHasChanges(manual)
      ? manual
      : bestPath.scenario.payDown.length
        ? { payDown: bestPath.scenario.payDown }
        : {}
    const sim = scenarioHasChanges(scenario) ? simulate(input, scenario) : null
    const simActions = sim ? describeScenario(input.accounts, scenario) : []

    // Encrypted PDF (random password, delivered by SMS).
    const password = generatePassword()
    const pdf = await buildResultsPdf({ raw: extracted, sim, simActions, bestPath }, password)

    // Upload + short-lived signed URL for GHL to fetch as an attachment.
    const storagePath = `${RESULTS_PREFIX}/${reportId}.pdf`
    const { error: upErr } = await supabase.storage
      .from(CREDIT_REPORTS_BUCKET)
      .upload(storagePath, pdf, { contentType: "application/pdf", upsert: true })
    if (upErr) throw new Error(`PDF upload failed: ${upErr.message}`)
    const { data: signed, error: signErr } = await supabase.storage
      .from(CREDIT_REPORTS_BUCKET)
      .createSignedUrl(storagePath, 3600)
    if (signErr || !signed?.signedUrl) throw new Error(`Signed URL failed: ${signErr?.message ?? "none"}`)

    // Attach the email to the SAME contact (match by phone), get contactId.
    const ref = report.contact_ref as string
    const phone = ref.includes("@") ? undefined : normalizeUsPhone(ref) ?? ref
    const contact = await upsertContact({ email, phone, source: CREDIT_CONTACT_SOURCE }, ghl.token, ghl.locationId)

    // Send the email with the PDF attached (threads into Conversations → replies
    // fire the "Customer Replied" feedback automation).
    const emailRes = await sendGhlEmail(
      {
        contactId: contact.id,
        subject: `Your credit results${extracted.consumer_first_name ? `, ${extracted.consumer_first_name}` : ""}`,
        html: buildEmailHtml(extracted.consumer_first_name),
        attachments: [signed.signedUrl],
        emailFrom: process.env.CREDIT_EMAIL_FROM || undefined,
        replyTo: process.env.CREDIT_EMAIL_REPLYTO || undefined,
      },
      ghl.token,
    )
    if (!emailRes.ok) throw new Error(emailRes.error ?? "email send failed")

    // Text the password out-of-band. Best-effort: a DND/opt-out failure shouldn't
    // 500 the request — the frontend is told so it can guide the user.
    const smsRes = await sendGhlSms(contact.id, `Your Credit CRB results password is: ${password}`, ghl.token)
    if (!smsRes.ok) console.log("[credit] report-email password SMS failed:", smsRes.code, smsRes.error)

    await applyCreditResultsOptinTag(contact.id, ghl.token)
    console.log(`[credit] report-email sent: contact=${contact.id} sms=${smsRes.ok}`)

    return NextResponse.json({ ok: true, sent: true, smsSent: smsRes.ok }, { status: 200, headers: cors })
  } catch (err) {
    console.log("[credit] report-email failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "We couldn't email your results. Please try again." }, { status: 502, headers: cors })
  }
}
