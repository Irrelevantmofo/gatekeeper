// ─────────────────────────────────────────────────────────────────────────────
// Credit Analyzer shared config + helpers.
//
// Kept separate from lib/ghl.ts so the Business Analyzer Tool (BAT) is never
// touched by credit-analyzer changes. BAT keeps using USED_TAG =
// "business-analyzer-used" from lib/ghl.ts; the credit tool uses its own tag.
// ─────────────────────────────────────────────────────────────────────────────

// GHL contact "source" for credit-analyzer leads (distinct from BAT's default).
export const CREDIT_CONTACT_SOURCE = "IdentityIQ Credit Report Analyzer and Simulator"

// ─────────────────────────────────────────────────────────────────────────────
// Surface variants.
//
// The simulator ships as two surfaces: a neutral tool at /credit-simulator that
// brokers share with their own clients, and a Credit CRB branded copy at
// /credit-simulator-creditcrb embedded in WordPress. The frontend sends which
// one it is, and EVERYTHING the backend generates for a user branches on it:
// the used-tag, the OTP text, the results email, the password text, the PDF.
//
// Mirrors ANALYZER_VARIANT_TAGS / resolveVariantTag / hasAnyAnalyzerTag in
// lib/ghl.ts, kept separate so BAT is never touched by credit-analyzer changes.
// ─────────────────────────────────────────────────────────────────────────────
export type CreditVariant = "neutral" | "creditcrb"

export interface CreditVariantBranding {
  /**
   * Name used in SMS bodies and as the PDF's Author metadata.
   *
   * Never null. US A2P 10DLC campaigns are registered with sample bodies and
   * carriers filter on content, so a text with no identification at all risks
   * being dropped as a campaign mismatch. The neutral surface therefore names
   * the TOOL rather than the operator, which identifies the program without
   * telling a broker's client whose funnel they are in.
   */
  senderName: string
  /**
   * The brand as it reads in prose: the PDF's Author, the results-email
   * sign-off, and the password text.
   *
   * Separate from senderName because the branded surface spells them
   * differently — "CreditCRB" in the A2P-registered OTP body, "Credit CRB"
   * everywhere else. Collapsing them would silently reword live copy.
   */
  displayName: string
  /** Logo for the results-email header. null → no logo band at all. */
  emailLogoUrl: string | null
  /** Logo for the results-PDF banner. null → the PDF renders title-only. */
  pdfLogoUrl: string | null
  /** Header/footer colour of the results email. */
  emailAccent: string
  /** Sign-off line above the P.S. null → omit the line entirely. */
  emailSignoff: string | null
  /**
   * Phone for the results-PDF call to action. null → non-phone copy is
   * substituted, so a surface we have no number for never prints a dead CTA.
   */
  phone: string | null
  /**
   * Footer address, and the target of the unsubscribe mailto.
   *
   * Never null on EITHER variant: CAN-SPAM requires a working opt-out, so this
   * is a functional requirement rather than branding. Until a neutral sending
   * domain is verified in GHL there is only one real mailbox, so the neutral
   * footer necessarily shows the operator's address — see the root README's
   * shared open item 1. CREDIT_SUPPORT_EMAIL_NEUTRAL is the one-line switch
   * once that domain exists.
   */
  supportEmail: string
}

interface CreditVariantConfig {
  /**
   * The GHL tag written after a successful analysis. This is what lets
   * GoHighLevel tell the two surfaces apart and branch its workflows.
   */
  usedTag: string
  branding: CreditVariantBranding
}

const DEFAULT_SUPPORT_EMAIL = "office@creditcrbusa.com"
const DEFAULT_EMAIL_LOGO = "https://assets.cdn.filesafe.space/A6Ohu9Xj1Qyu1CvraT26/media/6a342c180a683b64fee5a440.png"
const DEFAULT_PDF_LOGO = "https://assets.cdn.filesafe.space/A6Ohu9Xj1Qyu1CvraT26/media/6995d199b3d5f8d7d94c11ce.png"

/**
 * Read at call time, not module load, so a Vercel env change takes effect on the
 * next invocation rather than needing a cold start to be observable.
 */
export function getCreditVariantConfig(variant: CreditVariant): CreditVariantConfig {
  if (variant === "creditcrb") {
    return {
      usedTag: (process.env.CREDIT_USED_TAG_CREDITCRB || "credit-analyzer-creditcrb-used").toLowerCase(),
      branding: {
        // Byte-identical to the wording used before variants existed, so the
        // branded surface stays consistent with the registered A2P sample.
        senderName: "CreditCRB",
        displayName: "Credit CRB",
        emailLogoUrl: process.env.CREDIT_EMAIL_LOGO_URL || DEFAULT_EMAIL_LOGO,
        pdfLogoUrl: process.env.CREDIT_PDF_LOGO_URL || DEFAULT_PDF_LOGO,
        emailAccent: "#1b4fa1",
        emailSignoff: "— Credit CRB",
        phone: process.env.CREDIT_SUPPORT_PHONE || "855-291-7557",
        supportEmail: process.env.CREDIT_SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL,
      },
    }
  }
  return {
    usedTag: (process.env.CREDIT_USED_TAG || "credit-analyzer-used").toLowerCase(),
    branding: {
      senderName: "Credit Score Simulator",
      displayName: "Credit Score Simulator",
      // No logo and no phone: both would name the operator to a broker's client.
      emailLogoUrl: null,
      pdfLogoUrl: null,
      // The simulator's own green (#2E7D32), not Credit CRB's blue.
      emailAccent: "#2E7D32",
      emailSignoff: null,
      phone: null,
      supportEmail: process.env.CREDIT_SUPPORT_EMAIL_NEUTRAL || process.env.CREDIT_SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL,
    },
  }
}

/**
 * Resolve the variant slug sent by the frontend.
 *
 * Unknown or missing falls back to NEUTRAL, and that direction matters: a stale
 * cached bundle that sends nothing gets the unbranded treatment. The failure
 * mode is a branded visitor seeing a neutral name, never a neutral visitor
 * receiving Credit CRB's name before they have seen a branded page.
 */
export function resolveCreditVariant(variant?: string | null): CreditVariant {
  return (variant ?? "").trim().toLowerCase() === "creditcrb" ? "creditcrb" : "neutral"
}

export const getCreditBranding = (variant?: string | null): CreditVariantBranding =>
  getCreditVariantConfig(resolveCreditVariant(variant)).branding

// ─────────────────────────────────────────────────────────────────────────────
// The used-tag, and the re-entry gate.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tag a completed analysis should apply, for the surface it came from.
 *
 * The neutral tag is deliberately the SAME `credit-analyzer-used` that was
 * written before the tool split into two surfaces. Contacts already carrying it
 * keep gating correctly and existing GoHighLevel workflows keep firing; only the
 * branded surface gets a new tag.
 */
export function getCreditUsedTag(variant?: string | null): string {
  return getCreditVariantConfig(resolveCreditVariant(variant)).usedTag
}

/** Every tag that counts as "already used", across both surfaces. */
export function allCreditUsedTags(): string[] {
  return [getCreditUsedTag("neutral"), getCreditUsedTag("creditcrb")]
}

/**
 * Has this contact used ANY surface of the simulator?
 *
 * The gate is one analysis per person, not one per surface. Without this
 * someone could run the neutral tool and then the branded one for a second bite,
 * which is the same hole hasAnyAnalyzerTag() closes for BAT.
 *
 * Exact element matching, never substring. The lead tag `credit-simulator` is
 * applied to everyone who merely requests an OTP, and these names are close
 * enough that a loose test would eventually close the gate on all of them.
 */
export function hasAnyCreditUsedTag(tags: string[]): boolean {
  const owned = allCreditUsedTags()
  return tags.some((t) => owned.includes(t.trim().toLowerCase()))
}

/** The OTP SMS body for a surface. "Reply STOP" is required on every variant. */
export function buildOtpSmsMessage(code: string, variant?: string | null): string {
  return `Your ${getCreditBranding(variant).senderName} verification code is ${code}. Reply STOP to opt out.`
}

/** The out-of-band text carrying the results-PDF password. */
export function buildResultsPasswordSms(password: string, variant?: string | null): string {
  return `Your ${getCreditBranding(variant).displayName} results password is: ${password}`
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
// The used-tag is per-surface: pass the variant the analysis came from, or the
// contact is tagged neutral and GoHighLevel cannot branch its workflows.
export const applyCreditUsedTag = (contactId: string, token: string, variant?: string | null) =>
  addContactTag(contactId, getCreditUsedTag(variant), token)
export const applyCreditLeadTag = (contactId: string, token: string) => addContactTag(contactId, getCreditLeadTag(), token)
export const applyCreditResultsOptinTag = (contactId: string, token: string) => addContactTag(contactId, getCreditResultsOptinTag(), token)
