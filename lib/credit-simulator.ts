// ─────────────────────────────────────────────────────────────────────────────
// Deterministic credit-score simulator (plan §8, §15). NO AI, NO network — pure
// functions, instant, unit-testable.
//
// Model: VantageScore 3.0 is proprietary, so this is an ESTIMATE (labeled as
// such everywhere — plan §9.6). We anchor on the user's REAL current score and
// move it only by the factors we model, using VantageScore-3.0-informed
// influence weights. Unmodeled factors (e.g. delinquency depth) are held
// constant, so the estimate never drifts far from reality.
//
// Sources for weights: VantageScore/Equifax/Experian education pages —
// payment history ~40%, age & type of credit ~21%, utilization ~20%, total
// balances ~11%, recent credit ~5%, available credit ~3%. We collapse the
// "amounts owed" cluster (utilization + balances + available = ~34%) into the
// one lever a user can actually pull fast: paying down revolving balances.
// ─────────────────────────────────────────────────────────────────────────────

import { toAnalysis, type RawExtraction } from "@/lib/credit-extraction"

// Influence weights, VantageScore-3.0-informed, summing to 1.0. Exposed so they
// can be tuned or swapped for a FICO set without touching the math.
export const VANTAGESCORE_3_WEIGHTS = {
  paymentHistory: 0.4,
  utilization: 0.34, // utilization + total balances + available credit (all move when you pay down)
  lengthOfHistory: 0.13,
  creditMix: 0.08,
  newInquiries: 0.05,
} as const

const SCORE_FLOOR = 300
const SCORE_CEIL = 850
const SCORE_RANGE = SCORE_CEIL - SCORE_FLOOR // 550
// Conservatism: shave estimated GAINS so we under-promise, and hard-cap a single
// scenario's improvement. Losses are not damped.
const GAIN_CONSERVATISM = 0.85
const MAX_GAIN = 120

const DISCLAIMER =
  "Estimated only — not a guarantee. We are not FICO or VantageScore, and we are not a credit-repair organization. We do not dispute items on your behalf."

// ── Inputs (structurally satisfied by the toAnalysis() output) ────────────────
export interface SimPerBureau {
  bureau: string
  status: string | null // account_status: open|closed|paid|...
  balance: number | null
  creditLimit: number | null
}
export interface SimAccount {
  accountId: string
  creditor: string
  type: string
  ownership: string
  actionable: boolean
  perBureau: SimPerBureau[]
}
export interface SimInput {
  scores: { bureau: string; value: number | null }[]
  accounts: SimAccount[]
}

export interface SimScenario {
  // Per-account paydown: reduce this account's balance by `amount` dollars, OR
  // pay it to `targetUtilizationPct` (0–1). This lets a suggested scenario's
  // `actions` be passed straight back as a simulate input (plan §15.2).
  payDown?: { accountId: string; amount?: number; targetUtilizationPct?: number }[]
  // Abstract "Your Score, Your Control" sliders. Utilization takes only `to`
  // (current is derived from facts); the rest take from→to since we can't
  // always derive their current value from the extraction.
  factorChanges?: {
    utilizationPct?: { to: number }
    paymentOnTimePct?: { from: number; to: number }
    lengthYears?: { from: number; to: number }
    creditMixTypes?: { from: number; to: number }
    recentInquiries?: { from: number; to: number }
  }
}

export interface SimBureauResult {
  bureau: string
  baseScore: number
  estimatedScore: number
  estimatedRange: [number, number]
  waterfall: { label: string; delta: number; inCombination: boolean }[]
}
export interface SimResult {
  perBureau: SimBureauResult[]
  disclaimer: string
}

// ── Health curves (0 = worst, 1 = ideal) via piecewise-linear interpolation ───
function interp(points: [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1]
  const last = points[points.length - 1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    if (x <= x1) return y0 + (y1 - y0) * ((x - x0) / (x1 - x0))
  }
  return last[1]
}

// Utilization: sharp reward below ~30%, heavy penalty when near/over the limit.
const hUtil = (u: number) =>
  interp([[0, 1.0], [0.1, 0.95], [0.3, 0.8], [0.5, 0.62], [0.75, 0.4], [0.9, 0.24], [1.0, 0.12], [1.5, 0.06]], u)
// Payment history: on-time fraction (1.0 = perfect).
const hPayment = (p: number) => interp([[0, 0], [0.5, 0.1], [0.8, 0.35], [0.9, 0.55], [0.95, 0.75], [0.98, 0.9], [1.0, 1.0]], p)
const hLength = (yrs: number) => interp([[0, 0.15], [1, 0.3], [2, 0.45], [4, 0.62], [7, 0.75], [10, 0.85], [15, 0.95], [20, 1.0]], yrs)
const hMix = (types: number) => interp([[0, 0.2], [1, 0.45], [2, 0.7], [3, 0.88], [4, 1.0]], types)
const hInq = (n: number) => interp([[0, 1.0], [1, 0.88], [2, 0.78], [3, 0.7], [5, 0.52], [8, 0.35], [12, 0.2]], n)

const clampScore = (s: number) => Math.max(SCORE_FLOOR, Math.min(SCORE_CEIL, Math.round(s)))
const isOpen = (status: string | null) => (status ?? "").toLowerCase() === "open"

// Aggregate revolving utilization for one bureau. Excludes $0-limit lines (the
// report's "amount in H/C column is credit limit" quirk that otherwise pushes
// utilization above 100% — plan §17.3 follow-up). `paydowns` maps accountId →
// dollars paid down.
export function revolvingUtilization(input: SimInput, bureau: string, paydowns?: Map<string, number>): number | null {
  let bal = 0
  let lim = 0
  for (const a of input.accounts) {
    if (a.type !== "revolving") continue
    const b = a.perBureau.find((x) => x.bureau === bureau)
    if (!b || !isOpen(b.status) || !b.creditLimit || b.creditLimit <= 0) continue
    const paid = paydowns?.get(a.accountId) ?? 0
    bal += Math.max(0, (b.balance ?? 0) - paid)
    lim += b.creditLimit
  }
  return lim > 0 ? bal / lim : null
}

const creditorFor = (input: SimInput, accountId: string) =>
  input.accounts.find((a) => a.accountId === accountId)?.creditor ?? "card"

// The account's highest-balance open, positive-limit bureau line (the representative
// line for converting a target utilization into a dollar amount).
function repLine(a: SimAccount): { balance: number; limit: number } | null {
  let balance = 0
  let limit = 0
  for (const b of a.perBureau) {
    if (isOpen(b.status) && b.creditLimit && b.creditLimit > 0 && (b.balance ?? 0) > balance) {
      balance = b.balance ?? 0
      limit = b.creditLimit
    }
  }
  return limit > 0 ? { balance, limit } : null
}

// Resolve payDown items (amount OR targetUtilizationPct) into concrete dollars.
function normalizePaydowns(input: SimInput, items: NonNullable<SimScenario["payDown"]>): { accountId: string; amount: number }[] {
  return items.map((it) => {
    if (it.amount != null) return { accountId: it.accountId, amount: Math.max(0, it.amount) }
    const a = input.accounts.find((x) => x.accountId === it.accountId)
    const rep = a && it.targetUtilizationPct != null ? repLine(a) : null
    const amount = rep ? Math.max(0, Math.round(rep.balance - it.targetUtilizationPct! * rep.limit)) : 0
    return { accountId: it.accountId, amount }
  })
}

// Core: recompute each bureau's estimated score from the scenario.
export function simulate(input: SimInput, scenario: SimScenario): SimResult {
  const W = VANTAGESCORE_3_WEIGHTS
  const fc = scenario.factorChanges ?? {}

  const perBureau: SimBureauResult[] = []
  for (const s of input.scores) {
    if (s.value == null) continue
    const base = s.value
    const waterfall: SimBureauResult["waterfall"] = []
    let total = 0

    const pushGain = (label: string, rawDelta: number, inCombination: boolean) => {
      const d = rawDelta > 0 ? rawDelta * GAIN_CONSERVATISM : rawDelta
      waterfall.push({ label, delta: Math.round(d), inCombination })
      total += d
    }

    // ── Utilization: explicit slider override wins; else derive from paydowns ──
    const curU = revolvingUtilization(input, s.bureau)
    if (fc.utilizationPct?.to != null && curU != null) {
      const newU = Math.max(0, fc.utilizationPct.to)
      pushGain(`Lower utilization to ${Math.round(newU * 100)}%`, SCORE_RANGE * W.utilization * (hUtil(newU) - hUtil(curU)), waterfall.length > 0)
    } else if (scenario.payDown?.length && curU != null) {
      // Marginal (waterfall) contribution per card, largest paydown first, so
      // deltas are honest "in combination" values (utilization is non-additive).
      const ordered = normalizePaydowns(input, scenario.payDown).sort((a, b) => b.amount - a.amount)
      const acc = new Map<string, number>()
      let prevU = curU
      ordered.forEach((item, idx) => {
        acc.set(item.accountId, (acc.get(item.accountId) ?? 0) + item.amount)
        const newU = revolvingUtilization(input, s.bureau, acc)
        if (newU == null) return
        pushGain(`Pay down ${creditorFor(input, item.accountId)}`, SCORE_RANGE * W.utilization * (hUtil(newU) - hUtil(prevU)), idx > 0)
        prevU = newU
      })
    }

    // ── Abstract factor sliders (from → to) ──────────────────────────────────
    if (fc.paymentOnTimePct) pushGain("Improve payment history", SCORE_RANGE * W.paymentHistory * (hPayment(fc.paymentOnTimePct.to) - hPayment(fc.paymentOnTimePct.from)), waterfall.length > 0)
    if (fc.lengthYears) pushGain("Age of accounts grows", SCORE_RANGE * W.lengthOfHistory * (hLength(fc.lengthYears.to) - hLength(fc.lengthYears.from)), waterfall.length > 0)
    if (fc.creditMixTypes) pushGain("Broaden credit mix", SCORE_RANGE * W.creditMix * (hMix(fc.creditMixTypes.to) - hMix(fc.creditMixTypes.from)), waterfall.length > 0)
    if (fc.recentInquiries) pushGain("Fewer recent inquiries", SCORE_RANGE * W.newInquiries * (hInq(fc.recentInquiries.to) - hInq(fc.recentInquiries.from)), waterfall.length > 0)

    const finalDelta = total > 0 ? Math.min(total, MAX_GAIN) : total
    const est = clampScore(base + finalDelta)
    const band = Math.max(4, Math.round(0.12 * Math.abs(finalDelta)))
    perBureau.push({
      bureau: s.bureau,
      baseScore: base,
      estimatedScore: est,
      estimatedRange: [clampScore(est - band), clampScore(est + band)],
      waterfall,
    })
  }

  return { perBureau, disclaimer: DISCLAIMER }
}

// ── Suggested scenarios (plan §14) — code enumerates & scores; templated copy ─
export interface SuggestedScenario {
  id: string
  title: string
  rationale: string
  effort: { payDownAmount: number; toUtilizationPct: number; accountId: string | null }
  estimatedImpact: {
    perBureau: { bureau: string; before: number; after: number; delta: number }[]
    deltaRange: [number, number]
  }
  // Directly runnable as a simulate input: POST /api/simulate { scenario: { payDown: actions } }.
  actions: { accountId: string; targetUtilizationPct: number }[]
}

const TARGET_UTIL = 0.1

// Dollars to bring an account to TARGET_UTIL, using its highest-balance bureau.
function paydownToTarget(a: SimAccount): { amount: number; utilPct: number } | null {
  const rep = repLine(a)
  if (!rep) return null
  const amount = Math.max(0, Math.round(rep.balance - TARGET_UTIL * rep.limit))
  return amount > 0 ? { amount, utilPct: rep.balance / rep.limit } : null
}

function impactOf(res: SimResult) {
  const perBureau = res.perBureau.map((r) => ({ bureau: r.bureau, before: r.baseScore, after: r.estimatedScore, delta: r.estimatedScore - r.baseScore }))
  const deltas = perBureau.map((p) => p.delta)
  const avg = deltas.length ? deltas.reduce((x, y) => x + y, 0) / deltas.length : 0
  return { perBureau, deltaRange: [Math.min(...deltas, 0), Math.max(...deltas, 0)] as [number, number], avg }
}

export function buildSuggestedScenarios(input: SimInput, maxN = 5): SuggestedScenario[] {
  const actionable = input.accounts.filter((a) => a.actionable)
  const candidates: (SuggestedScenario & { _avg: number })[] = []

  for (const a of actionable) {
    const p = paydownToTarget(a)
    if (!p) continue
    const res = simulate(input, { payDown: [{ accountId: a.accountId, amount: p.amount }] })
    const impact = impactOf(res)
    candidates.push({
      id: `${a.accountId}-to-10pct`,
      title: `Pay down your ${a.creditor}`,
      rationale: `This card is about ${Math.round(p.utilPct * 100)}% used. Bringing it under 10% could add roughly ${impact.deltaRange[0]}–${impact.deltaRange[1]} points.`,
      effort: { payDownAmount: p.amount, toUtilizationPct: TARGET_UTIL, accountId: a.accountId },
      estimatedImpact: { perBureau: impact.perBureau, deltaRange: impact.deltaRange },
      actions: [{ accountId: a.accountId, targetUtilizationPct: TARGET_UTIL }],
      _avg: impact.avg,
    })
  }

  // Combined "pay all cards under 10%" scenario when there's more than one.
  if (actionable.length > 1) {
    const payDown = actionable.map((a) => ({ a, p: paydownToTarget(a) })).filter((x) => x.p) as { a: SimAccount; p: { amount: number; utilPct: number } }[]
    if (payDown.length > 1) {
      const total = payDown.reduce((sum, x) => sum + x.p.amount, 0)
      const res = simulate(input, { payDown: payDown.map((x) => ({ accountId: x.a.accountId, amount: x.p.amount })) })
      const impact = impactOf(res)
      candidates.push({
        id: "pay-all-cards-to-10pct",
        title: "Pay all your cards under 10%",
        rationale: `Paying down all ${payDown.length} maxed cards together could add roughly ${impact.deltaRange[0]}–${impact.deltaRange[1]} points — your biggest single move.`,
        effort: { payDownAmount: total, toUtilizationPct: TARGET_UTIL, accountId: null },
        estimatedImpact: { perBureau: impact.perBureau, deltaRange: impact.deltaRange },
        actions: payDown.map((x) => ({ accountId: x.a.accountId, targetUtilizationPct: TARGET_UTIL })),
        _avg: impact.avg,
      })
    }
  }

  return candidates
    .sort((a, b) => b._avg - a._avg)
    .slice(0, maxN)
    .map(({ _avg, ...s }) => s)
}

// Full analysis object for the frontend (contract §8): the extracted facts
// mapped by toAnalysis(), enriched with the curated suggested scenarios (§14).
// Used by /api/analyze and /api/status so both return identical, complete data.
export function buildAnalysis(reportId: string, extracted: RawExtraction, maxN = 5) {
  const analysis = toAnalysis(reportId, extracted)
  return {
    ...analysis,
    suggestedScenarios: buildSuggestedScenarios(analysis, maxN),
    recommendationsMeta: { cappedAt: maxN, generatedBy: "engine+template" as const },
  }
}

