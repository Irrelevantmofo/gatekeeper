import type { PerBureauAccount, RawExtraction } from "@/lib/credit-extraction"
import type { BestPathResult } from "@/lib/credit-simulator"
import { buildActionsHtml } from "@/lib/results-html"

// ─────────────────────────────────────────────────────────────────────────────
// Maps a credit analysis → GHL contact fields (docs/crm-capture-plan.md).
//
// SAFETY: only VALID values are included — a field is omitted entirely when its
// value is null/undefined/NaN or an empty/whitespace string. Nothing blank or
// garbage is ever sent, so we never overwrite a good GHL value with an empty one.
// (resolveContactCustomFields also filters "", but we filter at the source too.)
// ─────────────────────────────────────────────────────────────────────────────

//Test

export interface CrmPayload {
  standard: { firstName?: string; lastName?: string } // native GHL fields
  custom: Record<string, string | number> // custom fields, keyed by slug
}

const isOpen = (s: PerBureauAccount["account_status"]) => (s ?? "").toLowerCase() === "open"
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

function median(nums: number[]): number | null {
  const v = nums.filter(finite).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2)
}

// VantageScore-style bands / funding tiers from a score.
function bandFor(s: number): string {
  if (s < 580) return "Poor"
  if (s < 670) return "Fair"
  if (s < 740) return "Good"
  if (s < 800) return "Very Good"
  return "Excellent"
}
function tierFor(s: number): string {
  if (s < 600) return "<600"
  if (s < 660) return "600-659"
  if (s < 700) return "660-699"
  return "700+"
}

export function buildCrmPayload(raw: RawExtraction, bestPath: BestPathResult): CrmPayload {
  const custom: Record<string, string | number> = {}
  // Only ever writes a valid value (skips null/NaN/empty) — the "no blanks" rule.
  const put = (key: string, val: string | number | null | undefined) => {
    if (val === null || val === undefined) return
    if (typeof val === "number") {
      if (Number.isFinite(val)) custom[key] = val
      return
    }
    const t = val.trim()
    if (t) custom[key] = t
  }

  // ── Scores ────────────────────────────────────────────────────────────────
  const scoreOf = (bureau: string) => raw.scores.find((s) => s.bureau === bureau)?.value ?? undefined
  put("credit_score_transunion", finite(scoreOf("TransUnion")) ? (scoreOf("TransUnion") as number) : undefined)
  put("credit_score_experian", finite(scoreOf("Experian")) ? (scoreOf("Experian") as number) : undefined)
  put("credit_score_equifax", finite(scoreOf("Equifax")) ? (scoreOf("Equifax") as number) : undefined)

  const mid = median(raw.scores.map((s) => s.value).filter(finite))
  if (mid != null) {
    put("credit_score_middle", mid)
    put("credit_band", bandFor(mid))
    put("funding_tier", tierFor(mid))
  }
  put("score_model", raw.report_meta.score_model)

  // Representative bureau = the one carrying the middle score (else first scored).
  const repBureau = raw.scores.find((s) => s.value === mid)?.bureau ?? raw.scores.find((s) => finite(s.value))?.bureau ?? null

  // ── Utilization, balances, counts (on the representative bureau) ────────────
  if (repBureau) {
    let revBal = 0
    let revLim = 0
    let totalBal = 0
    let openCount = 0
    let openRevCount = 0
    for (const a of raw.accounts) {
      const b = a.per_bureau.find((x) => x.bureau === repBureau)
      if (!b || !isOpen(b.account_status)) continue
      openCount++
      totalBal += b.balance ?? 0
      if (a.type === "revolving") {
        openRevCount++
        if (b.credit_limit && b.credit_limit > 0) {
          revBal += b.balance ?? 0
          revLim += b.credit_limit
        }
      }
    }
    if (revLim > 0) put("revolving_utilization", Math.round((revBal / revLim) * 100))
    put("total_revolving_balance", Math.round(revBal))
    put("total_balances", Math.round(totalBal))
    put("open_accounts", openCount)
    put("open_revolving_accounts", openRevCount)
    put("top_reason_code", raw.scores.find((s) => s.bureau === repBureau)?.reason_codes?.[0])
  }

  // ── Risk / derogatory (bureau-agnostic, best-effort) ────────────────────────
  const delinquent = raw.accounts.filter((a) => finite(a.recent_late_marks) && (a.recent_late_marks as number) > 0).length
  const collections = raw.accounts.filter((a) => a.per_bureau.some((b) => (b.payment_status ?? "").toLowerCase().includes("collection"))).length
  const publicRecs = raw.public_records.length
  put("delinquent_accounts", delinquent)
  put("collections_count", collections)
  put("public_records_count", publicRecs)
  put("recent_hard_inquiries_24mo", raw.inquiries.length)
  put("has_derogatory", delinquent > 0 || collections > 0 || publicRecs > 0 ? "Yes" : "No")

  // ── Simulator outcomes (bestPath built with target 700) ─────────────────────
  put("projected_max_score", bestPath.projectedScore)
  put("reaches_700", bestPath.reachable ? "Yes" : "No")
  put("points_to_700", Math.max(0, 700 - bestPath.projectedScore))
  if (bestPath.totalPayDown > 0) put("cash_to_target", Math.round(bestPath.totalPayDown))
  if (bestPath.steps[0]) put("top_recommended_action", `Pay down ${bestPath.steps[0].creditor} under 10%`)

  // ── Results email content — rendered HTML block (GHL renders custom-field HTML)
  put("credit_actions_html", buildActionsHtml(raw, bestPath))

  // ── Meta ────────────────────────────────────────────────────────────────────
  put("report_vendor", raw.report_meta.vendor)
  put("report_date", raw.report_meta.report_date)
  put("analyzed_at", new Date().toISOString().slice(0, 10))

  // ── Standard native fields (name only) ──────────────────────────────────────
  const standard: CrmPayload["standard"] = {}
  const fn = raw.consumer_first_name?.trim()
  const ln = raw.consumer_last_name?.trim()
  if (fn) standard.firstName = fn
  if (ln) standard.lastName = ln

  return { standard, custom }
}
