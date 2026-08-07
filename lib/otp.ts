import crypto from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

// ─────────────────────────────────────────────────────────────────────────────
// Phone OTP via Telnyx Verify (plan: docs/otp-access-plan.md).
//
// Telnyx Verify manages code generation/expiry/checking, so we store NO codes.
// This module isolates: config, US-phone normalization, the Telnyx Verify calls
// (verify against docs), a signed verificationToken, and a coarse rate limiter.
//
// DEV BYPASS: with OTP_BYPASS=on, no Telnyx call is made — the fixed OTP_BYPASS_CODE
// (default "000000") is accepted. Lets the flow be tested without a US number/SMS.
// ─────────────────────────────────────────────────────────────────────────────

export const isOtpBypass = () => process.env.OTP_BYPASS === "on"
export const getBypassCode = () => process.env.OTP_BYPASS_CODE || "000000"
// When on, /api/consent requires a valid verificationToken (turn on for prod).
export const isOtpRequired = () => process.env.OTP_REQUIRED === "on"
export const getResendCooldownSec = () => Number.parseInt(process.env.OTP_RESEND_COOLDOWN_SEC || "45", 10) || 45

export function getTelnyxConfig(): { apiKey: string; profileId: string } | null {
  const apiKey = process.env.TELNYX_API_KEY
  const profileId = process.env.TELNYX_VERIFY_PROFILE_ID
  if (!apiKey || !profileId) return null
  return { apiKey, profileId }
}

// Normalize to E.164 US, or null if it isn't a plausible US number (US-only launch).
export function normalizeUsPhone(raw: string): string | null {
  const digits = (raw || "").replace(/[^\d]/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

// ── Telnyx Verify (ISOLATED — verify request/response against current docs) ───
const TELNYX_BASE = "https://api.telnyx.com/v2"

export async function telnyxSendCode(phone: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = getTelnyxConfig()
  if (!cfg) return { ok: false, error: "Telnyx not configured" }
  const res = await fetch(`${TELNYX_BASE}/verifications/sms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number: phone, verify_profile_id: cfg.profileId, timeout_secs: 300 }),
    cache: "no-store",
  })
  if (!res.ok) return { ok: false, error: `Telnyx send failed (${res.status})` }
  return { ok: true }
}

export async function telnyxCheckCode(phone: string, code: string): Promise<{ accepted: boolean; error?: string }> {
  const cfg = getTelnyxConfig()
  if (!cfg) return { accepted: false, error: "Telnyx not configured" }
  const res = await fetch(`${TELNYX_BASE}/verifications/by_phone_number/${encodeURIComponent(phone)}/actions/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code, verify_profile_id: cfg.profileId }),
    cache: "no-store",
  })
  if (!res.ok) return { accepted: false, error: `Telnyx verify failed (${res.status})` }
  const data = (await res.json()) as { data?: { response_code?: string } }
  return { accepted: (data.data?.response_code ?? "").toLowerCase() === "accepted" }
}

// ── verificationToken: stateless, HMAC-signed { phone, exp } ──────────────────
function tokenSecret(): string | null {
  return process.env.OTP_TOKEN_SECRET || null
}
function ttlMs(): number {
  const m = Number.parseInt(process.env.OTP_VERIFICATION_TTL_MINUTES || "15", 10)
  return (Number.isFinite(m) && m > 0 ? m : 15) * 60_000
}

export function signVerificationToken(phone: string): string | null {
  const secret = tokenSecret()
  if (!secret) return null
  const payload = Buffer.from(JSON.stringify({ phone, exp: Date.now() + ttlMs() })).toString("base64url")
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url")
  return `${payload}.${sig}`
}

export function verifyVerificationToken(token: string | undefined | null, phone: string): boolean {
  const secret = tokenSecret()
  if (!secret || !token) return false
  const [payload, sig] = token.split(".")
  if (!payload || !sig) return false
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url")
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  try {
    const { phone: p, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { phone: string; exp: number }
    return p === phone && typeof exp === "number" && Date.now() < exp
  } catch {
    return false
  }
}

// ── Coarse rate limiting (anti SMS-pumping). Reuses the rate_limits table.
// bucket_key embeds the day, so counters reset daily by key. Read-then-write is
// racy but fine for deterrence. limit<=0 disables that bucket.
export async function otpRateLimitOk(
  supabase: SupabaseClient,
  buckets: { key: string; limit: number }[],
): Promise<boolean> {
  const active = buckets.filter((b) => b.limit > 0)
  for (const b of active) {
    const { data } = await supabase.from("rate_limits").select("count").eq("bucket_key", b.key).maybeSingle()
    if (data && (data.count as number) >= b.limit) return false
  }
  for (const b of active) {
    const { data } = await supabase.from("rate_limits").select("count").eq("bucket_key", b.key).maybeSingle()
    if (data) await supabase.from("rate_limits").update({ count: (data.count as number) + 1 }).eq("bucket_key", b.key)
    else await supabase.from("rate_limits").insert({ bucket_key: b.key, count: 1 })
  }
  return true
}

export const dayStamp = () => new Date().toISOString().slice(0, 10)
