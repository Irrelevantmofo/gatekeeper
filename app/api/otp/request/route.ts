import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, getGHLConfig, normalizePhone, upsertContact } from "@/lib/ghl"
import { getSupabaseAdmin } from "@/lib/supabase"
import { parseClientIp } from "@/lib/credit"
import { dayStamp, getResendCooldownSec, getTelnyxConfig, isOtpBypass, normalizeUsPhone, otpRateLimitOk, telnyxSendCode } from "@/lib/otp"

// POST /api/otp/request — send a phone verification code (plan: docs/otp-access-plan.md).
// Captures the lead in GHL, rate-limits (anti SMS-pumping), then sends via Telnyx
// Verify — unless OTP_BYPASS=on (dev: no SMS, fixed code accepted at /verify).

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

  let body: { phone?: string; firstName?: string; lastName?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const phone = normalizeUsPhone(body.phone ?? "")
  if (!phone) {
    return NextResponse.json({ error: "Please enter a valid US phone number." }, { status: 400, headers: cors })
  }

  // Rate limit (skipped effect in bypass since no SMS, but still bounds abuse).
  const ip = parseClientIp(request) ?? "unknown"
  const day = dayStamp()
  const allowed = await otpRateLimitOk(supabase, [
    { key: `otp:phone:${phone}:${day}`, limit: Number.parseInt(process.env.OTP_RATE_LIMIT_PER_PHONE_DAY || "5", 10) },
    { key: `otp:ip:${ip}:${day}`, limit: Number.parseInt(process.env.OTP_RATE_LIMIT_PER_IP_DAY || "15", 10) },
    { key: `otp:global:${day}`, limit: Number.parseInt(process.env.OTP_GLOBAL_DAY || "0", 10) },
  ])
  if (!allowed) {
    return NextResponse.json({ status: "rate_limited", retryAfter: 900 }, { status: 429, headers: cors })
  }

  // Capture the lead in GHL now (best-effort — a GHL hiccup must not block OTP).
  const ghl = getGHLConfig()
  if (ghl) {
    try {
      await upsertContact(
        { phone: normalizePhone(phone), firstName: body.firstName?.trim(), lastName: body.lastName?.trim() },
        ghl.token,
        ghl.locationId,
      )
    } catch (err) {
      console.log("[otp] contact upsert failed (continuing):", err instanceof Error ? err.message : err)
    }
  }

  // DEV BYPASS — no Telnyx call, no SMS cost.
  if (isOtpBypass()) {
    return NextResponse.json({ status: "sent", bypass: true, resendAfter: getResendCooldownSec() }, { status: 200, headers: cors })
  }

  if (!getTelnyxConfig()) {
    return NextResponse.json({ error: "Verification is not configured." }, { status: 500, headers: cors })
  }
  const sent = await telnyxSendCode(phone)
  if (!sent.ok) {
    console.log("[otp] telnyx send failed:", sent.error)
    return NextResponse.json({ error: "We couldn't send your code. Please check the number and try again." }, { status: 502, headers: cors })
  }

  return NextResponse.json({ status: "sent", resendAfter: getResendCooldownSec() }, { status: 200, headers: cors })
}
