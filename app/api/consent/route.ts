import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, getGHLConfig, normalizeEmail, normalizePhone, searchContact } from "@/lib/ghl"
import { getSupabaseAdmin } from "@/lib/supabase"
import { hasAnyCreditUsedTag, isGateEnforced, parseClientIp } from "@/lib/credit"
import { isOtpRequired, normalizeUsPhone, verifyVerificationToken } from "@/lib/otp"

// POST /api/consent — records a consent event and runs the one-use gate.
//
// Flow (plan §4 step 1, §9.2): before any upload, the frontend collects the
// contact (from GHL context, not a typed form — plan §4.2) and calls this when
// the user clicks "I authorize this analysis". We:
//   1. Best-effort gate check: does this contact already carry the credit tag?
//   2. Persist a consent record (versioned, with IP/UA) tied to the contact.
//   3. Return { consentId } + the gate's observation.
//
// GATE IS OBSERVE-ONLY BY DEFAULT. We only hard-block (return gate_closed) when
// CREDIT_GATE_ENFORCED=true. This lets us run the same contact through the flow
// repeatedly during testing without lockout. See lib/credit.ts isGateEnforced().

type GateObservation = "gate_open" | "gate_closed" | "no_contact" | "unknown"

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

  let body: { email?: string; phone?: string; contactId?: string; consentVersion?: string; verificationToken?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const email = body.email ? normalizeEmail(body.email) : ""
  // Normalize to E.164 so the phone matches the contact created at /api/otp/request
  // (avoids a duplicate GHL contact). Fall back to loose normalization if not US-parseable.
  const phone = normalizeUsPhone(body.phone ?? "") ?? (body.phone ? normalizePhone(body.phone) : "")
  const consentVersion = body.consentVersion?.trim() || "unversioned"
  const contactRef = body.contactId?.trim() || email || phone || null

  // ── 0. Require a verified phone when OTP is enforced (plan: otp-access-plan.md).
  //    Off by default (OTP_REQUIRED unset) so the current flow is unaffected.
  if (isOtpRequired()) {
    const e164 = normalizeUsPhone(body.phone ?? "")
    if (!e164 || !verifyVerificationToken(body.verificationToken, e164)) {
      return NextResponse.json({ status: "phone_unverified", error: "Please verify your phone number first." }, { status: 401, headers: cors })
    }
  }

  // ── 1. Gate check (best-effort; never throws the request) ──────────────────
  const enforced = isGateEnforced()
  let gate: GateObservation = "unknown"
  let gateWouldClose = false

  const ghl = getGHLConfig()
  if (ghl && (email || phone)) {
    try {
      const contact = await searchContact(email, phone, ghl.token, ghl.locationId)
      if (!contact) {
        gate = "no_contact"
      } else {
        const tags = (contact.tags ?? []).map((t) => t.toLowerCase())
        gateWouldClose = hasAnyCreditUsedTag(tags)
        gate = gateWouldClose ? "gate_closed" : "gate_open"
      }
    } catch (err) {
      // A GHL hiccup must not block consent capture — observe as unknown.
      console.log("[credit] consent gate lookup failed (continuing):", err instanceof Error ? err.message : err)
      gate = "unknown"
    }
  }

  // Only BLOCK when enforcement is explicitly on (production). Default: proceed.
  if (enforced && gateWouldClose) {
    return NextResponse.json(
      { status: "gate_closed", message: "This contact has already used the credit analyzer." },
      { status: 200, headers: cors },
    )
  }

  // ── 2. Persist the consent record ──────────────────────────────────────────
  const { data, error } = await supabase
    .from("consents")
    .insert({
      contact_ref: contactRef,
      consent_version: consentVersion,
      ip: parseClientIp(request),
      user_agent: request.headers.get("user-agent") || null,
    })
    .select("id")
    .single()

  if (error || !data) {
    console.log("[credit] consent insert failed:", error?.message)
    return NextResponse.json({ error: "Failed to record consent." }, { status: 502, headers: cors })
  }

  // ── 3. Respond ───────────────────────────────────────────────────────────—
  return NextResponse.json(
    {
      status: "ok",
      consentId: data.id,
      // Observability so we can see gate behavior during testing without it blocking.
      gate: { status: gate, wouldClose: gateWouldClose, enforced },
    },
    { status: 200, headers: cors },
  )
}
