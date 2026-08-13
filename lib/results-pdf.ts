import PDFDocument from "pdfkit"
import type { RawExtraction } from "@/lib/credit-extraction"
import type { BestPathResult, SimResult } from "@/lib/credit-simulator"

// ─────────────────────────────────────────────────────────────────────────────
// Renders the credit results as a PASSWORD-PROTECTED PDF (pdfkit, AES via PDF
// 1.7). The password is generated server-side and delivered out-of-band by SMS
// (best practice) — see /api/report-email. The results live in this encrypted
// file, NOT in the email body, so credit scores are never exposed in the inbox.
//
// pdfkit note: on Next.js/Vercel, keep pdfkit in `serverExternalPackages` (see
// next.config.mjs) so its bundled standard-font AFM data is loaded from
// node_modules at runtime rather than being dropped by the bundler.
// ─────────────────────────────────────────────────────────────────────────────

const NAVY = "#0c2340"
const MUTED = "#33475b"
const RULE = "#c9d2dd"
const GREEN = "#0a7d33"

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)
function median(nums: number[]): number | null {
  const v = nums.filter(finite).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2)
}

export interface ResultsPdfInput {
  raw: RawExtraction
  sim: SimResult | null
  simActions: string[]
  bestPath: BestPathResult
}

// Generate the encrypted PDF as a Buffer. `password` is the user (open) password.
export function buildResultsPdf(input: ResultsPdfInput, password: string): Promise<Buffer> {
  const { raw, sim, simActions, bestPath } = input

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margin: 54,
      // Encryption: a user password gates opening; a distinct owner password
      // holds permissions. PDF 1.7 → AES-128.
      userPassword: password,
      ownerPassword: `${password}::owner`,
      pdfVersion: "1.7",
      permissions: { printing: "highResolution", copying: true, modifying: false },
      info: { Title: "Your Credit Results", Author: "Credit CRB" },
    })

    const chunks: Buffer[] = []
    doc.on("data", (c: Buffer) => chunks.push(c))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    const left = doc.page.margins.left
    const right = doc.page.width - doc.page.margins.right

    const h = (text: string, size = 15) => {
      doc.moveDown(0.6).font("Helvetica-Bold").fontSize(size).fillColor(NAVY).text(text)
      doc.moveDown(0.3)
    }
    const body = (text: string, opts: PDFKit.Mixins.TextOptions = {}) =>
      doc.font("Helvetica").fontSize(12).fillColor(NAVY).text(text, opts)
    const bullet = (text: string) =>
      doc.font("Helvetica").fontSize(12).fillColor(NAVY).text(`•  ${text}`, { indent: 6, paragraphGap: 4 })
    const divider = () => {
      doc.moveDown(0.6)
      const y = doc.y
      doc.strokeColor(RULE).lineWidth(1).moveTo(left, y).lineTo(right, y).stroke()
      doc.moveDown(0.6)
    }

    // ── Title ─────────────────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(22).fillColor(NAVY).text("Your Credit Results")
    doc.font("Helvetica").fontSize(11).fillColor(MUTED).text(
      `${raw.report_meta.score_model ?? "VantageScore 3.0"}${raw.report_meta.report_date ? ` · Report date ${raw.report_meta.report_date}` : ""}`,
    )

    // ── Snapshot ────────────────────────────────────────────────────────────────
    const scored = raw.scores.filter((s) => finite(s.value))
    if (scored.length) {
      h("Your Credit Snapshot", 16)
      for (const s of scored) {
        doc.font("Helvetica").fontSize(13).fillColor(NAVY).text(`${s.bureau}:  `, { continued: true })
        doc.font("Helvetica-Bold").fontSize(15).text(String(s.value))
      }
      const mid = median(scored.map((s) => s.value).filter(finite))
      const rep = scored.find((s) => s.value === mid)?.bureau ?? scored[0]?.bureau ?? null
      const reasons = (rep ? scored.find((s) => s.bureau === rep)?.reason_codes : []) ?? []
      if (reasons.length) {
        h("What's holding your score back", 14)
        reasons.slice(0, 3).forEach((c) => bullet(String(c)))
      }
    }

    // ── Simulation summary (user's what-if, or the fastest-path scenario) ───────
    if (sim && sim.perBureau.length) {
      divider()
      h("Your Simulation Summary", 16)
      if (simActions.length) {
        body("The changes you tried:")
        doc.moveDown(0.2)
        simActions.forEach((a) => bullet(a))
        doc.moveDown(0.3)
      }
      body("Your projected scores with those changes:")
      doc.moveDown(0.2)
      for (const b of sim.perBureau) {
        const delta = b.estimatedScore - b.baseScore
        const sign = delta >= 0 ? `+${delta}` : `${delta}`
        doc.font("Helvetica").fontSize(12).fillColor(NAVY).text(`${b.bureau}:  `, { continued: true })
        doc.font("Helvetica-Bold").text(`${b.baseScore} → ${b.estimatedScore}  `, { continued: true })
        doc.fillColor(delta >= 0 ? GREEN : "#b3261e").text(`(${sign} point${Math.abs(delta) === 1 ? "" : "s"})`)
      }
    }

    // ── Fastest path ─────────────────────────────────────────────────────────────
    divider()
    h(`Your fastest path to ${bestPath.target}`, 16)
    if (bestPath.steps.length) {
      bestPath.steps.forEach((st) => {
        doc.font("Helvetica").fontSize(12).fillColor(NAVY).text(`${st.order}.  Pay `, { continued: true })
        doc.font("Helvetica-Bold").text(`${st.creditor} `, { continued: true })
        doc.font("Helvetica").text(`${st.action} — `, { continued: true })
        doc.fillColor(GREEN).font("Helvetica-Bold").text(`+${st.pointsGained} points `, { continued: true })
        doc.font("Helvetica").fillColor(NAVY).text(`(score about ${st.scoreAfter})`)
        doc.moveDown(0.2)
      })
      if (bestPath.totalPayDown > 0) {
        doc.moveDown(0.2)
        doc.font("Helvetica-Bold").fontSize(12).fillColor(NAVY).text(`Total cash to get there: $${Math.round(bestPath.totalPayDown).toLocaleString()}`)
      }
      doc.font("Helvetica-Bold").fontSize(12).fillColor(NAVY).text(`Your projected score: about ${bestPath.projectedScore}`)
    } else {
      body("Paying down balances alone won't move your score much right now — the bigger levers (like addressing negative items and letting late marks age off) are best mapped on a quick call.")
    }
    if (bestPath.note) {
      doc.moveDown(0.3)
      doc.font("Helvetica").fontSize(11).fillColor(MUTED).text(bestPath.note)
    }

    // ── Disclaimer ────────────────────────────────────────────────────────────
    doc.moveDown(1)
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(
      "Estimated only — not a guarantee. This is educational and not financial or credit-repair advice. We are not a credit-repair organization.",
    )

    doc.end()
  })
}
