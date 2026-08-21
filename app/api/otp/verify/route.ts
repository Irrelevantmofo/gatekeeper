import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, getGHLConfig, searchContact } from "@/lib/ghl"
import { getSupabaseAdmin } from "@/lib/supabase"
import { hasAnyCreditUsedTag, isGateEnforced } from "@/lib/credit"
import { checkStoredCode, getBypassCode, isOtpBypass, normalizeUsPhone, signVerificationToken } from "@/lib/otp"

// POST /api/otp/verify — check the code (against our stored hash, or the fixed
// bypass code) and, on success, issue a verificationToken. Also enforces the
// re-entry block: a verified phone whose GHL contact already carries the
// used-tag from EITHER surface (neutral or branded) is refused
// (gate_closed) when the gate is enforced. One analysis per person, not per surface.

export const runtime = "nodejs"

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request)

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json({ error: "Server is missing Supabase configuration." }, { status: 500, headers: cors })
  }

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

  // Check the code — dev bypass accepts the fixed code; else verify our stored hash.
  if (isOtpBypass()) {
    if (code !== getBypassCode()) {
      return NextResponse.json({ status: "invalid_code" }, { status: 200, headers: cors })
    }
  } else {
    const result = await checkStoredCode(supabase, phone, code)
    if (result === "expired") return NextResponse.json({ status: "expired" }, { status: 200, headers: cors })
    if (result === "too_many") return NextResponse.json({ status: "too_many_attempts" }, { status: 429, headers: cors })
    if (result !== "ok") return NextResponse.json({ status: "invalid_code" }, { status: 200, headers: cors })
  }

  // Re-entry block: already-used contact can't run a second report.
  const ghl = getGHLConfig()
  if (ghl && isGateEnforced()) {
    try {
      const contact = await searchContact("", phone, ghl.token, ghl.locationId)
      const tags = (contact?.tags ?? []).map((t) => t.toLowerCase())
      if (hasAnyCreditUsedTag(tags)) {
        return NextResponse.json({ status: "gate_closed", message: "This phone number has already used the analyzer." }, { status: 200, headers: cors })
      }
    } catch (err) {
      console.log("[otp] gate lookup failed (continuing):", err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json({ status: "verified", verificationToken: signVerificationToken(phone) }, { status: 200, headers: cors })
}
