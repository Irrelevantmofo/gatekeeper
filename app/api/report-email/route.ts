import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, getGHLConfig, normalizeEmail, upsertContact } from "@/lib/ghl"
import { getSupabaseAdmin } from "@/lib/supabase"
import { applyCreditResultsOptinTag, CREDIT_CONTACT_SOURCE, useMockExtraction } from "@/lib/credit"
import { normalizeUsPhone } from "@/lib/otp"

// POST /api/report-email — the user opted in via the results popup to have their
// analysis emailed to them. We attach their email to the SAME GHL contact created
// at /api/otp/request (phone) and enriched at /api/analyze (name + score/action
// custom fields), then apply the `credit-results-optin` tag.
//
// That tag is the TRIGGER for the GHL automation that sends the results +
// recommended-actions + feedback email. All email content, timing, and sending
// live in GHL — this endpoint is a thin trigger. Applying the tag only AFTER the
// email is on the contact guarantees the send always has a destination.
//
// Data minimization (plan §9.3): the email is intentionally NOT persisted in
// Supabase. GHL is the system of record for contact info.

export const runtime = "nodejs"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

  let body: { reportId?: string; email?: string }
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
    const ref = report.contact_ref as string
    // Match the existing contact by its phone (normally E.164 — set at OTP/consent)
    // and add the email to it. If the ref is already an email, match/create on the
    // new email. Never creates a duplicate for the normal phone-based flow.
    const phone = ref.includes("@") ? undefined : normalizeUsPhone(ref) ?? ref
    const contact = await upsertContact(
      { email, phone, source: CREDIT_CONTACT_SOURCE },
      ghl.token,
      ghl.locationId,
    )

    // Fire the automation trigger — email is now on the contact.
    await applyCreditResultsOptinTag(contact.id, ghl.token)
    console.log(`[credit] report-email ok: contact=${contact.id} opted in for results email`)
    return NextResponse.json({ ok: true, synced: true }, { status: 200, headers: cors })
  } catch (err) {
    console.log("[credit] report-email failed (non-fatal to user):", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "We couldn't save your email. Please try again." }, { status: 502, headers: cors })
  }
}
