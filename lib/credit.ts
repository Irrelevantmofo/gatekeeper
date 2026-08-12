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

// GHL contact "source" for credit-analyzer leads (distinct from BAT's default).
export const CREDIT_CONTACT_SOURCE = "IdentityIQ Credit Report Analyzer and Simulator"

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

// LLM provider for extraction. Defaults to OpenRouter (client preference — see
// plan §16 decision on OpenRouter + the DEFERRED compliance review). Set
// LLM_PROVIDER=openai to call OpenAI directly instead.
export type LlmProvider = "openrouter" | "openai"

export function getLlmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === "openai" ? "openai" : "openrouter"
}

export function getProviderApiKey(provider: LlmProvider = getLlmProvider()): string | undefined {
  return provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY
}

// Extraction model. OpenRouter uses namespaced ids (e.g. "openai/gpt-5.6-luna");
// OpenAI-direct uses bare ids (e.g. "gpt-5.6-luna"). Luna is the cheapest vision
// tier (plan §7.4). Confirm the exact id in the provider's dashboard.
export function getExtractionModel(provider: LlmProvider = getLlmProvider()): string {
  if (provider === "openrouter") return process.env.OPENROUTER_MODEL || "openai/gpt-5.6-luna"
  return process.env.OPENAI_MODEL || "gpt-5.6-luna"
}

// Mock extraction runs when CREDIT_ANALYZE_MOCK=true or the active provider's key
// is missing. Lets the full analyze pipeline be tested without spending on an LLM.
export function useMockExtraction(): boolean {
  return process.env.CREDIT_ANALYZE_MOCK === "true" || !getProviderApiKey()
}

// Wrong-document pre-check is on unless CREDIT_PRECHECK=off (escape hatch if it
// ever false-rejects a legit report). See lib/credit-precheck.ts.
export function isPrecheckEnabled(): boolean {
  return process.env.CREDIT_PRECHECK !== "off"
}

// Push analysis fields + used-tag into GHL on a real analysis, unless disabled.
// NOTE: callers must ALSO skip this in mock mode so test runs never write fake
// data to the real CRM.
export function isCrmSyncEnabled(): boolean {
  return process.env.CREDIT_CRM_SYNC !== "off"
}

// Max PDF pages accepted for analysis — a cost/abuse ceiling. Default 60 (real
// tri-bureau reports run 20–40 pages).
export function getMaxPages(): number {
  const n = process.env.CREDIT_MAX_PAGES ? Number.parseInt(process.env.CREDIT_MAX_PAGES, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 60
}

// Lead tag applied at OTP/contact creation so every credit-tool conversation is
// filterable into its own GHL Conversation View (keeps OTP SMS out of the main
// inbox). Distinct from the used-tag. Override via CREDIT_LEAD_TAG.
export function getCreditLeadTag(): string {
  return (process.env.CREDIT_LEAD_TAG || "credit-simulator").toLowerCase()
}

// Results opt-in tag applied by /api/report-email once the user gives their
// email in the results popup. This tag is the TRIGGER for the GHL automation
// that emails their analysis + recommended actions + feedback questions. It is
// applied only AFTER the email is on the contact, so the send always has a
// destination. Override via CREDIT_RESULTS_OPTIN_TAG. See docs/feedback-loop-plan.md.
export function getCreditResultsOptinTag(): string {
  return (process.env.CREDIT_RESULTS_OPTIN_TAG || "credit-results-optin").toLowerCase()
}

// Adds a tag to a GHL contact. Reuses lib/ghl.ts constants read-only (BAT
// untouched). GHL merges tags, so this is idempotent.
async function addContactTag(contactId: string, tag: string, token: string): Promise<void> {
  const { GHL_BASE_URL, GHL_API_VERSION } = await import("@/lib/ghl")
  const res = await fetch(`${GHL_BASE_URL}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ tags: [tag] }),
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`GHL add tag failed (${res.status})`)
}

// The re-entry / "used" tag (plan §4.1 step 7), the lead/segmentation tag, and
// the results-email opt-in trigger tag.
export const applyCreditUsedTag = (contactId: string, token: string) => addContactTag(contactId, getCreditUsedTag(), token)
export const applyCreditLeadTag = (contactId: string, token: string) => addContactTag(contactId, getCreditLeadTag(), token)
export const applyCreditResultsOptinTag = (contactId: string, token: string) => addContactTag(contactId, getCreditResultsOptinTag(), token)
