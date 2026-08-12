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

// ── Senior-friendly style tokens (audience is 60+): large type, high contrast,
//    generous spacing. Dark navy text on white = strong contrast; secondary text
//    stays dark enough to pass AA; visible dividers; roomy line-height. ──────────
const TEXT = "#0c2340" // primary — very dark navy
const MUTED = "#33475b" // secondary — still high-contrast on white
const RULE = "#c9d2dd" // borders / dividers (clearly visible)
const BOXBG = "#f4f7fb" // soft callout background

// Minimum body font size is 20px per client requirement (60+ audience).
const H2 = 'style="font-size:28px;font-weight:bold;line-height:1.3;margin:0 0 16px"'
const H3 = `style="font-size:23px;font-weight:bold;line-height:1.3;margin:30px 0 12px;color:${TEXT}"`
const P = 'style="font-size:20px;line-height:1.7;margin:0 0 18px"'
const LI = 'style="font-size:20px;line-height:1.6;margin:0 0 14px"'

// Current scores + top reason codes (from the representative / middle bureau).
function renderSnapshot(raw: RawExtraction): string {
  const scored = raw.scores.filter((s) => finite(s.value))
  if (!scored.length) return ""
  const mid = median(scored.map((s) => s.value).filter(finite))
  const rep = scored.find((s) => s.value === mid)?.bureau ?? scored[0]?.bureau ?? null
  const reasons = (rep ? scored.find((s) => s.bureau === rep)?.reason_codes : []) ?? []
  const model = esc(raw.report_meta.score_model ?? "VantageScore 3.0")

  let h = `<h2 ${H2}>Your Credit Snapshot</h2>`
  // Each bureau on its own line with a large, bold number — easy to scan.
  h += `<div style="background:${BOXBG};border:1px solid ${RULE};border-radius:12px;padding:18px 22px;margin:0 0 20px">`
  h += scored
    .map(
      (s) =>
        `<div style="font-size:22px;line-height:1.5;margin:6px 0"><span>${esc(s.bureau)}:</span> <strong style="font-size:30px">${s.value}</strong></div>`,
    )
    .join("")
  h += `<div style="font-size:20px;line-height:1.5;color:${MUTED};margin-top:12px">Scored on the ${model} scale</div>`
  h += `</div>`

  if (reasons.length) {
    h += `<h3 ${H3}>What's holding your score back</h3>`
    h += `<ul style="margin:0 0 18px;padding-left:24px">${reasons
      .slice(0, 3)
      .map((c) => `<li ${LI}>${esc(String(c))}</li>`)
      .join("")}</ul>`
  }
  return h
}

// The user's live what-if: the changes they toggled + the resulting per-bureau
// score movement (base → estimated). `actions` are ready human-readable labels.
function renderSimulated(sim: SimResult, actions: string[]): string {
  if (!sim.perBureau.length) return ""
  let h = `<h3 ${H3}>Your Simulation Summary</h3>`
  if (actions.length) {
    h += `<p style="font-size:20px;line-height:1.6;margin:0 0 10px"><strong>The changes you tried:</strong></p>`
    h += `<ul style="margin:0 0 18px;padding-left:24px">${actions.map((a) => `<li ${LI}>${esc(a)}</li>`).join("")}</ul>`
  }
  h += `<p style="font-size:20px;line-height:1.6;margin:0 0 10px"><strong>Your projected scores with those changes:</strong></p>`
  h += `<ul style="margin:0 0 18px;padding-left:24px;list-style:none">`
  h += sim.perBureau
    .map((b) => {
      const delta = b.estimatedScore - b.baseScore
      const up = delta >= 0
      const badge = `${up ? "+" : ""}${delta} point${Math.abs(delta) === 1 ? "" : "s"}`
      const color = up ? "#0a7d33" : "#b3261e"
      return `<li ${LI}>${esc(b.bureau)}: <strong style="font-size:23px">${b.baseScore} &rarr; ${b.estimatedScore}</strong> <strong style="color:${color}">(${badge})</strong></li>`
    })
    .join("")
  h += `</ul>`
  return h
}

// The engine's fastest path to the target: ordered paydown steps + score after each.
function renderFastestPath(bestPath: BestPathResult): string {
  let h = `<h3 ${H3}>Your fastest path to ${bestPath.target}</h3>`
  if (bestPath.steps.length) {
    h += `<ol style="margin:0 0 18px;padding-left:26px">`
    h += bestPath.steps
      .map(
        (st) =>
          `<li ${LI}>Pay <strong>${esc(st.creditor)}</strong> ${esc(st.action)} &mdash; <strong style="color:#0a7d33">+${st.pointsGained} points</strong> (your score goes to about <strong>${st.scoreAfter}</strong>)</li>`,
      )
      .join("")
    h += `</ol>`
    if (bestPath.totalPayDown > 0) {
      h += `<p ${P}><strong>Total cash to get there:</strong> $${Math.round(bestPath.totalPayDown).toLocaleString()}</p>`
    }
    h += `<p ${P}><strong>Your projected score:</strong> about ${bestPath.projectedScore}</p>`
  } else {
    h += `<p ${P}>Paying down balances alone won't move your score much right now — the bigger levers (like addressing negative items and letting late marks age off) are best mapped on a quick call.</p>`
  }
  if (bestPath.note) h += `<p style="font-size:20px;line-height:1.7;margin:0 0 18px;color:${MUTED}">${esc(bestPath.note)}</p>`
  return h
}

function wrap(inner: string): string {
  if (!inner.trim()) return ""
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.7;color:${TEXT};max-width:600px;margin:0 auto">${inner}</div>`
}

// Analyze-time block: snapshot + fastest path (no live what-if yet).
export function buildActionsHtml(raw: RawExtraction, bestPath: BestPathResult): string {
  return wrap(renderSnapshot(raw) + renderFastestPath(bestPath))
}

const DIVIDER = '<div style="border-top:1px solid #dfe3e8;margin:24px 0"></div>'

// Email-time block: snapshot + the user's live what-if (if any) + fastest path.
export function buildResultsEmailHtml(
  raw: RawExtraction,
  bestPath: BestPathResult,
  sim?: SimResult | null,
  simActions: string[] = [],
): string {
  const simSection = sim ? renderSimulated(sim, simActions) : ""
  // Divider between the Simulation Summary and the fastest-path section (only when
  // the summary is present, so there's never a stray rule).
  const middle = simSection ? simSection + DIVIDER : ""
  return wrap(renderSnapshot(raw) + middle + renderFastestPath(bestPath))
}
