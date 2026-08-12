import type { RawExtraction } from "@/lib/credit-extraction"
import type { BestPathResult, SimResult } from "@/lib/credit-simulator"

// ─────────────────────────────────────────────────────────────────────────────
// Renders the personalized results block emailed to the user (GHL merges it via
// the `credit_actions_html` custom field — GHL renders custom-field HTML, same
// as the funding tool's matched_offers_html). See docs/feedback-loop-plan.md.
//
// Kept lean and inline-styled — a light, mostly-text block inboxes better than a
// heavy template. All creditor names / reason codes / notes are HTML-escaped.
//
// Two builders:
//   buildActionsHtml       — snapshot + fastest-path (used at /api/analyze CRM sync)
//   buildResultsEmailHtml  — snapshot + the user's live what-if + fastest-path
//                            (used at /api/report-email when they click "email me")
// ─────────────────────────────────────────────────────────────────────────────

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

function median(nums: number[]): number | null {
  const v = nums.filter(finite).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2)
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const P = 'style="margin:0 0 16px"'
const H3 = 'style="font-size:19px;margin:20px 0 8px"'

// Current scores + top reason codes (from the representative / middle bureau).
function renderSnapshot(raw: RawExtraction): string {
  const scored = raw.scores.filter((s) => finite(s.value))
  if (!scored.length) return ""
  const mid = median(scored.map((s) => s.value).filter(finite))
  const rep = scored.find((s) => s.value === mid)?.bureau ?? scored[0]?.bureau ?? null
  const reasons = (rep ? scored.find((s) => s.bureau === rep)?.reason_codes : []) ?? []

  const line = scored.map((s) => `${esc(s.bureau)} <strong>${s.value}</strong>`).join(" &nbsp;·&nbsp; ")
  let h = `<h2 style="font-size:22px;margin:0 0 12px">Your Credit Snapshot</h2>`
  h += `<p ${P}>${line} <span style="color:#5a6b82">(${esc(raw.report_meta.score_model ?? "VantageScore 3.0")})</span></p>`
  if (reasons.length) {
    h += `<h3 ${H3}>What's holding your score back</h3>`
    h += `<ul ${P}>${reasons.slice(0, 3).map((c) => `<li>${esc(String(c))}</li>`).join("")}</ul>`
  }
  return h
}

// The user's live what-if: the changes they toggled + the resulting per-bureau
// score movement (base → estimated). `actions` are ready human-readable labels.
function renderSimulated(sim: SimResult, actions: string[]): string {
  if (!sim.perBureau.length) return ""
  let h = `<h3 ${H3}>Your Simulation Summary</h3>`
  if (actions.length) {
    h += `<p style="margin:0 0 8px">The changes you tried:</p>`
    h += `<ul ${P}>${actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`
  }
  h += `<p style="margin:0 0 8px">Your projected scores with those changes:</p>`
  h +=
    `<ul ${P}>` +
    sim.perBureau
      .map((b) => {
        const delta = b.estimatedScore - b.baseScore
        const sign = delta >= 0 ? `+${delta}` : `${delta}`
        return `<li>${esc(b.bureau)}: <strong>${b.baseScore} → ${b.estimatedScore}</strong> (${sign} pts)</li>`
      })
      .join("") +
    `</ul>`
  return h
}

// The engine's fastest path to the target: ordered paydown steps + score after each.
function renderFastestPath(bestPath: BestPathResult): string {
  let h = `<h3 ${H3}>Your fastest path to ${bestPath.target}</h3>`
  if (bestPath.steps.length) {
    h +=
      `<ol ${P}>` +
      bestPath.steps
        .map(
          (st) =>
            `<li style="margin-bottom:8px">Pay <strong>${esc(st.creditor)}</strong> ${esc(st.action)} — <strong>+${st.pointsGained} pts</strong> (score about ${st.scoreAfter})</li>`,
        )
        .join("") +
      `</ol>`
    if (bestPath.totalPayDown > 0) {
      h += `<p ${P}><strong>Cash to get there:</strong> $${Math.round(bestPath.totalPayDown).toLocaleString()}</p>`
    }
    h += `<p ${P}><strong>Projected score:</strong> about ${bestPath.projectedScore}</p>`
  } else {
    h += `<p ${P}>Paying down balances alone won't move your score much right now — the bigger levers (like addressing negative items and letting late marks age off) are best mapped on a quick call.</p>`
  }
  if (bestPath.note) h += `<p style="margin:0 0 16px;color:#5a6b82">${esc(bestPath.note)}</p>`
  return h
}

function wrap(inner: string): string {
  if (!inner.trim()) return ""
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.5;color:#0c2340">${inner}</div>`
}

// Analyze-time block: snapshot + fastest path (no live what-if yet).
export function buildActionsHtml(raw: RawExtraction, bestPath: BestPathResult): string {
  return wrap(renderSnapshot(raw) + renderFastestPath(bestPath))
}

// Email-time block: snapshot + the user's live what-if (if any) + fastest path.
export function buildResultsEmailHtml(
  raw: RawExtraction,
  bestPath: BestPathResult,
  sim?: SimResult | null,
  simActions: string[] = [],
): string {
  const simSection = sim ? renderSimulated(sim, simActions) : ""
  return wrap(renderSnapshot(raw) + simSection + renderFastestPath(bestPath))
}
