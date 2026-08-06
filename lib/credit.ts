// ─────────────────────────────────────────────────────────────────────────────
// Credit Analyzer shared config + helpers.
//
// Kept separate from lib/ghl.ts so the Business Analyzer Tool (BAT) is never
// touched by credit-analyzer changes. BAT keeps using USED_TAG =
// "business-analyzer-used" from lib/ghl.ts; the credit tool uses its own tag.
// ─────────────────────────────────────────────────────────────────────────────

// The GHL tag that marks a contact as having used the credit analyzer (plan
// §4.1). Lower-cased for case-insensitive comparison against contact.tags.
export function getCreditUsedTag(): string {
  return (process.env.CREDIT_USED_TAG || "credit-analyzer-used").toLowerCase()
}

// Gate enforcement is OFF by default. While building/testing we want to run the
// same contact through the flow repeatedly WITHOUT getting locked out, so the
// gate only *observes* (reports what it would do) unless this is explicitly
// turned on. Set CREDIT_GATE_ENFORCED=true in production to hard-block repeats.
export function isGateEnforced(): boolean {
  return process.env.CREDIT_GATE_ENFORCED === "true"
}

// TTL (minutes) after which an orphaned/incomplete upload is eligible for the
// cleanup sweep (plan §4 step 9). Defaults to 60 if unset/invalid.
export function getSweepTtlMinutes(): number {
  const n = process.env.SWEEP_TTL_MINUTES ? Number.parseInt(process.env.SWEEP_TTL_MINUTES, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 60
}

// reports.status values (mirrors the DB check constraint in the migration).
export const REPORT_STATUS = {
  awaitingUpload: "awaiting_upload",
  processing: "processing",
  analyzed: "analyzed",
  failed: "failed",
  deleted: "deleted",
} as const

// Best-effort client IP for the consent audit record. Validated loosely so a
// malformed header can never break the `inet` column insert.
export function parseClientIp(request: Request): string | null {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  if (!first) return null
  return /^[0-9a-fA-F:.]+$/.test(first) ? first : null
}
