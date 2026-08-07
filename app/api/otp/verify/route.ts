import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, getGHLConfig, searchContact } from "@/lib/ghl"
import { getCreditUsedTag, isGateEnforced } from "@/lib/credit"
import { getBypassCode, isOtpBypass, normalizeUsPhone, signVerificationToken, telnyxCheckCode } from "@/lib/otp"

// POST /api/otp/verify — check the code and, on success, issue a verificationToken.
// Also enforces the re-entry block: if this verified phone's GHL contact already
// carries the credit-analyzer-used tag (and the gate is enforced), returns
// gate_closed — one verified phone → one analysis (plan §3.5).

export const runtime = "nodejs"

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request)

  let body: { phone?: string; code?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const phone = normalizeUsPhone(body.phone ?? "")
  const code = (body.code ?? "").trim()
  if (!phone) return NextResponse.json({ error: "Please enter a valid US phone number." }, { status: 400, headers: cors })
  if (!code) return NextResponse.json({ error: "Enter the code we sent you." }, { status: 400, headers: cors })

  // Check the code — dev bypass accepts the fixed code; else ask Telnyx.
  const accepted = isOtpBypass() ? code === getBypassCode() : (await telnyxCheckCode(phone, code)).accepted
  if (!accepted) {
    return NextResponse.json({ status: "invalid_code" }, { status: 200, headers: cors })
  }

  // Re-entry block (§3.5): already-used contact can't run a second report.
  const ghl = getGHLConfig()
  if (ghl && isGateEnforced()) {
    try {
      const contact = await searchContact("", phone, ghl.token, ghl.locationId)
      const tags = (contact?.tags ?? []).map((t) => t.toLowerCase())
      if (tags.includes(getCreditUsedTag())) {
        return NextResponse.json({ status: "gate_closed", message: "This phone number has already used the analyzer." }, { status: 200, headers: cors })
      }
    } catch (err) {
      console.log("[otp] gate lookup failed (continuing):", err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json(
    { status: "verified", verificationToken: signVerificationToken(phone) },
    { status: 200, headers: cors },
  )
}
