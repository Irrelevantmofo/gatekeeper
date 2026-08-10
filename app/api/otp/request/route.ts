import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, getGHLConfig, normalizePhone, upsertContact } from "@/lib/ghl"
import { getSupabaseAdmin } from "@/lib/supabase"
import { applyCreditLeadTag, CREDIT_CONTACT_SOURCE, parseClientIp } from "@/lib/credit"
import { createAndStoreCode, dayStamp, getResendCooldownSec, isOtpBypass, normalizeUsPhone, otpRateLimitOk, sendGhlSms } from "@/lib/otp"

// POST /api/otp/request — generate a code, store it (hashed), and SMS it via GHL
// (LC Phone / existing A2P). Also captures the lead as a GHL contact. Rate-limited.
// OTP_BYPASS=on skips code generation + the SMS (dev; fixed code at /verify).

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

  // DEV BYPASS — capture the lead best-effort, but no code/SMS.
  if (isOtpBypass()) {
    const ghl = getGHLConfig()
    if (ghl) {
      try {
        const contact = await upsertContact({ phone: normalizePhone(phone), firstName: body.firstName?.trim(), lastName: body.lastName?.trim(), source: CREDIT_CONTACT_SOURCE }, ghl.token, ghl.locationId)
        await applyCreditLeadTag(contact.id, ghl.token)
      } catch (err) {
        console.log("[otp] bypass contact upsert/tag failed (continuing):", err instanceof Error ? err.message : err)
      }
    }
    return NextResponse.json({ status: "sent", bypass: true, resendAfter: getResendCooldownSec() }, { status: 200, headers: cors })
  }

  // Real send needs a GHL contact id (SMS is addressed by contactId).
  const ghl = getGHLConfig()
  if (!ghl) {
    return NextResponse.json({ error: "Server is missing GHL configuration." }, { status: 500, headers: cors })
  }

  let contactId: string
  try {
    const contact = await upsertContact(
      { phone: normalizePhone(phone), firstName: body.firstName?.trim(), lastName: body.lastName?.trim(), source: CREDIT_CONTACT_SOURCE },
      ghl.token,
      ghl.locationId,
    )
    contactId = contact.id
  } catch (err) {
    console.log("[otp] contact upsert failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ error: "We couldn't start verification. Please try again." }, { status: 502, headers: cors })
  }

  // Lead/segmentation tag (best-effort — never block the OTP send).
  try {
    await applyCreditLeadTag(contactId, ghl.token)
  } catch (err) {
    console.log("[otp] lead tag failed (continuing):", err instanceof Error ? err.message : err)
  }

  const code = await createAndStoreCode(supabase, phone, phone, parseClientIp(request))
  const message = `Your CreditCRB verification code is ${code}. Reply STOP to opt out.`
  const sent = await sendGhlSms(contactId, message, ghl.token)
  if (!sent.ok) {
    console.log("[otp] GHL SMS send failed:", sent.error)
    return NextResponse.json({ error: "We couldn't send your code. Please check the number and try again." }, { status: 502, headers: cors })
  }

  return NextResponse.json({ status: "sent", resendAfter: getResendCooldownSec() }, { status: 200, headers: cors })
}
