import crypto from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { GHL_API_VERSION, GHL_BASE_URL } from "@/lib/ghl"

// ─────────────────────────────────────────────────────────────────────────────
// Phone OTP — BACKEND-OWNED codes, delivered via GHL's SMS API (LC Phone / the
// account's existing A2P 10DLC). We generate, hash-store (Supabase
// phone_verifications), and verify the code ourselves; GHL is just the pipe.
//
// DEV BYPASS: OTP_BYPASS=on skips code generation + the GHL send; the fixed
// OTP_BYPASS_CODE (default "000000") is accepted at /verify — test without SMS.
// ─────────────────────────────────────────────────────────────────────────────

export const isOtpBypass = () => process.env.OTP_BYPASS === "on"
export const getBypassCode = () => process.env.OTP_BYPASS_CODE || "000000"
// When on, /api/consent requires a valid verificationToken (turn on for prod).
export const isOtpRequired = () => process.env.OTP_REQUIRED === "on"
export const getResendCooldownSec = () => Number.parseInt(process.env.OTP_RESEND_COOLDOWN_SEC || "45", 10) || 45

const codeLength = () => {
  const n = Number.parseInt(process.env.OTP_CODE_LENGTH || "6", 10)
  return Number.isFinite(n) && n >= 4 && n <= 8 ? n : 6
}
const ttlMinutes = () => {
  const n = Number.parseInt(process.env.OTP_TTL_MINUTES || "5", 10)
  return Number.isFinite(n) && n > 0 ? n : 5
}
const maxAttempts = () => {
  const n = Number.parseInt(process.env.OTP_MAX_ATTEMPTS || "5", 10)
  return Number.isFinite(n) && n > 0 ? n : 5
}

// Normalize to E.164 US, or null if not a plausible US number (US-only launch).
export function normalizeUsPhone(raw: string): string | null {
  const digits = (raw || "").replace(/[^\d]/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

// ── Code generation + hashing ─────────────────────────────────────────────────
function generateCode(): string {
  const max = 10 ** codeLength()
  return crypto.randomInt(0, max).toString().padStart(codeLength(), "0")
}
// HMAC the code with OTP_TOKEN_SECRET (pepper) so a DB leak doesn't expose codes;
// falls back to plain sha256 if no secret is set.
function hashCode(code: string): string {
  const secret = process.env.OTP_TOKEN_SECRET
  return secret
    ? crypto.createHmac("sha256", secret).update(code).digest("hex")
    : crypto.createHash("sha256").update(code).digest("hex")
}

// ── GHL SMS send (ISOLATED — verify endpoint/version against current docs) ─────
// POST /conversations/messages { type:"SMS", contactId, message, fromNumber? }.
// Requires the token scope `conversations/message.write`.
export async function sendGhlSms(
  contactId: string,
  message: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = { type: "SMS", contactId, message }
  const from = process.env.OTP_SMS_FROM
  if (from) body.fromNumber = from

  const res = await fetch(`${GHL_BASE_URL}/conversations/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (!res.ok) return { ok: false, error: `GHL SMS send failed (${res.status}): ${(await res.text()).slice(0, 300)}` }
  return { ok: true }
}

// ── OTP store + verify (Supabase phone_verifications) ─────────────────────────
// Generate a code, store its hash with a TTL, and return the plaintext to send.
export async function createAndStoreCode(
  supabase: SupabaseClient,
  phone: string,
  contactRef: string | null,
  ip: string | null,
): Promise<string> {
  const code = generateCode()
  await supabase.from("phone_verifications").insert({
    phone,
    code_hash: hashCode(code),
    expires_at: new Date(Date.now() + ttlMinutes() * 60_000).toISOString(),
    max_attempts: maxAttempts(),
    contact_ref: contactRef,
    ip,
  })
  return code
}

export type OtpCheck = "ok" | "invalid" | "expired" | "too_many"

// Verify against the latest unverified code for the phone.
export async function checkStoredCode(supabase: SupabaseClient, phone: string, code: string): Promise<OtpCheck> {
  const { data } = await supabase
    .from("phone_verifications")
    .select("id, code_hash, expires_at, attempts, max_attempts")
    .eq("phone", phone)
    .is("verified_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) return "invalid"
  if (new Date(data.expires_at as string) < new Date()) return "expired"
  if ((data.attempts as number) >= (data.max_attempts as number)) return "too_many"

  if (data.code_hash !== hashCode(code)) {
    await supabase.from("phone_verifications").update({ attempts: (data.attempts as number) + 1 }).eq("id", data.id)
    return "invalid"
  }
  await supabase.from("phone_verifications").update({ verified_at: new Date().toISOString() }).eq("id", data.id)
  return "ok"
}

// ── verificationToken: stateless, HMAC-signed { phone, exp } ──────────────────
function tokenSecret(): string | null {
  return process.env.OTP_TOKEN_SECRET || null
}
function verificationTtlMs(): number {
  const m = Number.parseInt(process.env.OTP_VERIFICATION_TTL_MINUTES || "15", 10)
  return (Number.isFinite(m) && m > 0 ? m : 15) * 60_000
}

export function signVerificationToken(phone: string): string | null {
  const secret = tokenSecret()
  if (!secret) return null
  const payload = Buffer.from(JSON.stringify({ phone, exp: Date.now() + verificationTtlMs() })).toString("base64url")
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

// ── Coarse rate limiting (anti SMS-pumping). Reuses the rate_limits table. ─────
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
