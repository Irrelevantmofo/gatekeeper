import { extractText, getDocumentProxy } from "unpdf"

// ─────────────────────────────────────────────────────────────────────────────
// Wrong-document pre-check (ZERO AI cost). Runs before the OpenRouter call so an
// accidental or abusive non-credit-report PDF never burns extraction tokens.
//
// Strategy: extract the PDF's text layer (free, fast, via unpdf's serverless
// PDF.js build) and look for credit-report signals. Fail-OPEN on ambiguity
// (unparseable or image-only PDFs pass through — we can't sniff them, and a real
// paying user shouldn't be blocked by a parser hiccup); fail-CLOSED only when we
// have real text and it clearly isn't a credit report.
// ─────────────────────────────────────────────────────────────────────────────

// Distinct signals a real US tri-bureau report reliably contains many of.
const SIGNALS = [
  "transunion", "experian", "equifax", "credit report", "credit score", "vantagescore",
  "fico", "credit limit", "revolving", "installment", "tradeline", "inquir",
  "past due", "date opened", "account status", "payment history",
]
const MIN_SIGNALS = 3
const MIN_TEXT_CHARS = 300 // below this we assume image-only → can't sniff → allow

export interface PrecheckResult {
  ok: boolean
  reason?: string // user-facing message when ok === false
  pages?: number
}

export async function precheckCreditReport(bytes: ArrayBuffer, maxPages: number): Promise<PrecheckResult> {
  let text = ""
  let pages = 0
  try {
    // pdf.js DETACHES the ArrayBuffer it's given (transfers it to its worker),
    // which would break the caller's later Buffer.from(bytes) for extraction.
    // Parse a COPY so the caller's buffer stays intact.
    const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)))
    const res = await extractText(pdf, { mergePages: true })
    pages = res.totalPages
    const t = res.text as unknown // string with mergePages:true; be defensive anyway
    text = (Array.isArray(t) ? t.join("\n") : String(t ?? "")).toLowerCase()
  } catch (err) {
    // Parser failure — inconclusive. Fail open so a hiccup can't block a real report.
    console.log("[credit] precheck parse failed (allowing through):", err instanceof Error ? err.message : err)
    return { ok: true }
  }

  if (pages > maxPages) {
    return { ok: false, pages, reason: `This PDF has ${pages} pages (limit ${maxPages}). Please upload only your credit report.` }
  }

  // Image-only / scanned PDF: no meaningful text layer to sniff → allow.
  if (text.replace(/\s/g, "").length < MIN_TEXT_CHARS) return { ok: true, pages }

  const hits = new Set(SIGNALS.filter((s) => text.includes(s)))
  if (hits.size < MIN_SIGNALS) {
    return {
      ok: false,
      pages,
      reason: "This doesn't look like a credit report. Please upload the full credit report PDF from your credit-monitoring service.",
    }
  }
  return { ok: true, pages }
}
