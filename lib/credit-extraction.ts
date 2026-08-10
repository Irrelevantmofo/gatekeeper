// ─────────────────────────────────────────────────────────────────────────────
// Credit report extraction — schema, types, mock, and the facts→analysis mapper.
//
// The LLM ONLY extracts facts into `RawExtraction` (plan §17.2 tri-bureau shape).
// It never computes scores. Downstream: the deterministic engine (Phase 3) does
// the math; here we just shape the extracted facts into the frontend `analysis`
// object (frontend contract §8).
// ─────────────────────────────────────────────────────────────────────────────

// ── Types (mirror the strict JSON schema below) ──────────────────────────────
export interface PerBureauAccount {
  bureau: string
  // The account's OPEN/CLOSED state (from the report's "Account Status" row).
  // Non-nullable enum ("unknown" when unstated) — a nullable enum corrupts the
  // strict structured-output grammar and yields empty extractions.
  account_status: "open" | "closed" | "paid" | "transferred" | "derogatory" | "unknown"
  // The current payment standing (from the "Payment Status" row): "current" | "30" | "collection" | ...
  // DISTINCT from account_status — both open and closed accounts can read "current".
  payment_status: string | null
  balance: number | null
  credit_limit: number | null
  past_due: number | null
}

export interface ExtractedAccount {
  creditor: string
  type: string // revolving | installment | mortgage | auto | other
  detail: string | null
  ownership: "individual" | "joint" | "authorized_user" | "unknown"
  recent_late_marks: number | null // derived from the 2-year payment grid
  per_bureau: PerBureauAccount[]
}

export interface ExtractedScore {
  bureau: string
  value: number | null
  band: string | null
  reason_codes: string[]
}

export interface ExtractedInquiry {
  creditor: string
  date: string | null
  bureau: string | null
  business_type: string | null
}

export interface ExtractedPublicRecord {
  kind: string
  date: string | null
}

export interface RawExtraction {
  report_meta: {
    vendor: string | null
    report_type: "3B" | "1B"
    report_date: string | null
    score_model: string | null
    scale: number[]
  }
  // Consumer name (the ONLY PII we extract) → GHL contact firstName/lastName.
  consumer_first_name: string | null
  consumer_last_name: string | null
  scores: ExtractedScore[]
  accounts: ExtractedAccount[]
  inquiries: ExtractedInquiry[]
  public_records: ExtractedPublicRecord[]
}

// ── Strict JSON Schema for OpenAI Structured Outputs (plan §7.3 / §17.2) ──────
// Strict mode rules: every property listed in `required`, additionalProperties
// false, nullability via ["type","null"].
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["report_meta", "consumer_first_name", "consumer_last_name", "scores", "accounts", "inquiries", "public_records"],
  properties: {
    report_meta: {
      type: "object",
      additionalProperties: false,
      required: ["vendor", "report_type", "report_date", "score_model", "scale"],
      properties: {
        vendor: { type: ["string", "null"] },
        report_type: { type: "string", enum: ["3B", "1B"] },
        report_date: { type: ["string", "null"] },
        score_model: { type: ["string", "null"] },
        scale: { type: "array", items: { type: "number" } },
      },
    },
    consumer_first_name: { type: ["string", "null"] },
    consumer_last_name: { type: ["string", "null"] },
    scores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["bureau", "value", "band", "reason_codes"],
        properties: {
          bureau: { type: "string" },
          value: { type: ["integer", "null"] },
          band: { type: ["string", "null"] },
          reason_codes: { type: "array", items: { type: "string" } },
        },
      },
    },
    accounts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["creditor", "type", "detail", "ownership", "recent_late_marks", "per_bureau"],
        properties: {
          creditor: { type: "string" },
          type: { type: "string" },
          detail: { type: ["string", "null"] },
          ownership: { type: "string", enum: ["individual", "joint", "authorized_user", "unknown"] },
          recent_late_marks: { type: ["integer", "null"] },
          per_bureau: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["bureau", "account_status", "payment_status", "balance", "credit_limit", "past_due"],
              properties: {
                bureau: { type: "string" },
                account_status: { type: "string", enum: ["open", "closed", "paid", "transferred", "derogatory", "unknown"] },
                payment_status: { type: ["string", "null"] },
                balance: { type: ["number", "null"] },
                credit_limit: { type: ["number", "null"] },
                past_due: { type: ["number", "null"] },
              },
            },
          },
        },
      },
    },
    inquiries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["creditor", "date", "bureau", "business_type"],
        properties: {
          creditor: { type: "string" },
          date: { type: ["string", "null"] },
          bureau: { type: ["string", "null"] },
          business_type: { type: ["string", "null"] },
        },
      },
    },
    public_records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "date"],
        properties: {
          kind: { type: "string" },
          date: { type: ["string", "null"] },
        },
      },
    },
  },
} as const

// ── System prompt (keep STABLE so the prompt-cache prefix bills at 10%, §7.4) ─
export const EXTRACTION_SYSTEM_PROMPT = [
  "You extract structured facts from a US consumer credit report PDF.",
  "This is a tri-bureau report: TransUnion, Experian, and Equifax appear side by side and their values DIFFER per bureau. Capture each bureau's values separately in per_bureau.",
  "Return ONLY data that conforms to the provided JSON schema. Do not compute or estimate credit scores — extract only what the report states.",
  "For every score, copy the bureau's Risk Factors / reason codes verbatim into reason_codes.",
  "Set score_model to the exact model named (e.g. 'VantageScore 3.0'). Set report_type to '3B' if three bureaus are present, else '1B'.",
  "For accounts: classify type as one of revolving | installment | mortgage | auto | other. Set ownership from the report (individual | joint | authorized_user; use 'unknown' if unclear). recent_late_marks = count of 30/60/90/120+ day late marks in the last 24 months of the payment grid.",
  "CRITICAL — two DIFFERENT status fields per bureau, do not confuse them: account_status comes from the report's 'Account Status' row and is the OPEN/CLOSED state (normalize to exactly one of: open | closed | paid | transferred | derogatory | unknown; use 'unknown' if a bureau doesn't state it — never leave it blank). payment_status comes from the separate 'Payment Status' row and is the current standing (e.g. 'current', '30', '60', 'collection'; may be null). Both an open and a closed account can show payment_status 'Current' — never copy the payment status into account_status.",
  "If a value is absent on a given bureau, use null. If an account is missing on a bureau, omit that bureau from per_bureau.",
  "KEEP THE RESPONSE COMPACT for speed: if an account is OPEN on at least one bureau, include full per_bureau detail for every bureau it appears on. But if an account is CLOSED, PAID, or TRANSFERRED on ALL bureaus, include just ONE per_bureau entry (any single bureau) with account_status set and balance/credit_limit/past_due as null — full per-bureau detail is not needed for non-open accounts.",
  "The Personal Information section ALWAYS lists the consumer's legal name (it may appear per-bureau, or under 'Name' / 'Also Known As'). Extract their current first and last name into consumer_first_name / consumer_last_name — e.g. name 'BARBARA A STERNBERG' → first 'Barbara', last 'Sternberg'. Only use null if the name is genuinely absent.",
  "PRIVACY: the NAME is the only personal detail to extract. Do NOT extract or output SSN, date of birth, street addresses, employers, or full account numbers.",
].join("\n")

// ── Mock extraction (used when OPENAI_API_KEY is absent or CREDIT_ANALYZE_MOCK) ─
// Mirrors the real sample (plan §17) so the full pipeline + frontend can be
// tested end-to-end without an OpenAI key. Clearly flagged via report_meta.vendor.
export function buildMockExtraction(): RawExtraction {
  const per = (accountStatus: PerBureauAccount["account_status"], balance: number, limit: number): PerBureauAccount[] =>
    ["TransUnion", "Experian", "Equifax"].map((bureau) => ({
      bureau,
      account_status: accountStatus,
      payment_status: "current",
      balance,
      credit_limit: limit,
      past_due: 0,
    }))

  // Set CREDIT_MOCK_PROFILE=low to test the "can't reach the target" flow: low
  // scores + the same near-maxed cards → best-path produces real paydown steps
  // but still lands short of 700 (reachable:false + honest note).
  const low = process.env.CREDIT_MOCK_PROFILE === "low"

  return {
    report_meta: {
      vendor: low ? "MOCK (low-score profile)" : "MOCK (no OpenAI key set)",
      report_type: "3B",
      report_date: "2026-07-14",
      score_model: "VantageScore 3.0",
      scale: [300, 850],
    },
    consumer_first_name: "Barbara",
    consumer_last_name: "Sternberg",
    scores: low
      ? [
          { bureau: "TransUnion", value: 548, band: "Poor", reason_codes: ["Several accounts have missed or late payments", "Balances on revolving accounts are too high compared to credit limits"] },
          { bureau: "Experian", value: 543, band: "Poor", reason_codes: ["Too many of the delinquencies on your accounts are recent", "You have a public record or collection"] },
          { bureau: "Equifax", value: 539, band: "Poor", reason_codes: ["The balances on your accounts are too high compared to loan amounts"] },
        ]
      : [
          {
            bureau: "TransUnion",
            value: 646,
            band: "Fair",
            reason_codes: [
              "You have too many delinquent or derogatory accounts",
              "Balances on revolving accounts are too high compared to credit limits",
            ],
          },
          { bureau: "Experian", value: 643, band: "Fair", reason_codes: ["Too many of the delinquencies on your accounts are recent"] },
          { bureau: "Equifax", value: 639, band: "Fair", reason_codes: ["The balances on your accounts are too high compared to loan amounts"] },
        ],
    accounts: [
      { creditor: "CITI", type: "revolving", detail: "Credit Card", ownership: "individual", recent_late_marks: 0, per_bureau: per("open", 5104, 5440) },
      { creditor: "CAPITAL ONE", type: "revolving", detail: "Credit Card", ownership: "individual", recent_late_marks: 0, per_bureau: per("open", 4440, 4500) },
      { creditor: "CBNA", type: "revolving", detail: "Charge account", ownership: "individual", recent_late_marks: 0, per_bureau: per("open", 2966, 4200) },
      { creditor: "CAP ONE", type: "revolving", detail: "Credit Card", ownership: "authorized_user", recent_late_marks: 0, per_bureau: [{ bureau: "Equifax", account_status: "open", payment_status: "current", balance: 3391, credit_limit: 4500, past_due: 0 }] },
      { creditor: "ACHIEVE PERSONAL LOANS", type: "installment", detail: "Unsecured loan", ownership: "individual", recent_late_marks: 0, per_bureau: per("open", 36402, 50000) },
    ],
    inquiries: [
      { creditor: "PORSCHEFINSE", date: "2026-03-24", bureau: "TransUnion", business_type: "Auto Financing" },
      { creditor: "ALLY FINANCIAL", date: "2026-02-25", bureau: "Experian", business_type: "Auto Financing" },
    ],
    public_records: [],
  }
}

// ── Facts → frontend `analysis` object (frontend contract §8) ─────────────────
const DISCLAIMER =
  "Estimated only — not a guarantee. We are not FICO or VantageScore, and we are not a credit-repair organization. We do not dispute items on your behalf."

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

const isOpen = (accountStatus: PerBureauAccount["account_status"]) => (accountStatus ?? "").toLowerCase() === "open"

// Only individually-owned, open, revolving accounts can be "paid down" by the user.
function isActionable(acct: ExtractedAccount): boolean {
  return acct.type === "revolving" && acct.ownership === "individual" && acct.per_bureau.some((b) => isOpen(b.account_status))
}

export function toAnalysis(reportId: string, raw: RawExtraction) {
  const bureaus = raw.scores.map((s) => s.bureau)

  // Aggregate revolving utilization per bureau, EXCLUDING $0-limit lines (the
  // report's "amount in H/C column is credit limit" quirk that otherwise pushes
  // utilization above 100% — plan §17.3).
  const revolvingUtil = bureaus.map((bureau) => {
    let bal = 0
    let lim = 0
    for (const a of raw.accounts) {
      if (a.type !== "revolving") continue
      const b = a.per_bureau.find((x) => x.bureau === bureau)
      if (!b || !isOpen(b.account_status) || !b.credit_limit || b.credit_limit <= 0) continue
      bal += Math.max(0, b.balance ?? 0)
      lim += b.credit_limit
    }
    return { bureau, value: lim > 0 ? bal / lim : null }
  })

  const accounts = raw.accounts.map((a, i) => ({
    accountId: `acct_${i}_${slug(a.creditor)}`,
    creditor: a.creditor,
    type: a.type,
    detail: a.detail,
    ownership: a.ownership,
    actionable: isActionable(a),
    note: a.ownership === "authorized_user" ? "You're an authorized user on this account — paying it down may not be in your control." : undefined,
    perBureau: a.per_bureau.map((b) => ({
      bureau: b.bureau,
      status: b.account_status, // frontend contract §8 "status" = account open/closed state
      paymentStatus: b.payment_status,
      balance: b.balance,
      creditLimit: b.credit_limit,
      utilizationPct: b.credit_limit && b.credit_limit > 0 && b.balance != null ? b.balance / b.credit_limit : null,
      pastDue: b.past_due,
    })),
  }))

  return {
    reportId,
    reportMeta: {
      vendor: raw.report_meta.vendor,
      reportType: raw.report_meta.report_type,
      reportDate: raw.report_meta.report_date,
      scoreModel: raw.report_meta.score_model,
      scale: raw.report_meta.scale,
    },
    scores: raw.scores.map((s) => ({ bureau: s.bureau, value: s.value, band: s.band, reasonCodes: s.reason_codes })),
    summary: {
      openAccounts: bureaus.map((bureau) => ({
        bureau,
        value: raw.accounts.filter((a) => a.per_bureau.some((b) => b.bureau === bureau && isOpen(b.account_status))).length,
      })),
      revolvingUtilization: revolvingUtil,
      hardInquiries24mo: bureaus.map((bureau) => ({ bureau, value: raw.inquiries.filter((q) => q.bureau === bureau).length })),
      publicRecords: bureaus.map((bureau) => ({ bureau, value: raw.public_records.length })),
    },
    accounts,
    // Phase 3 will populate these (deterministic simulator + AI/template curation).
    suggestedScenarios: [],
    recommendationsMeta: { cappedAt: 0, generatedBy: "pending" as const },
    coachNote: null as string | null,
    disclaimer: DISCLAIMER,
  }
}
