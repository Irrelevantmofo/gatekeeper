import { EXTRACTION_JSON_SCHEMA, EXTRACTION_SYSTEM_PROMPT, type RawExtraction } from "@/lib/credit-extraction"
import { getExtractionModel, getLlmProvider, getProviderApiKey, type LlmProvider } from "@/lib/credit"

// ─────────────────────────────────────────────────────────────────────────────
// LLM extraction — ISOLATED provider dispatcher (OpenRouter or OpenAI direct).
//
// The rest of the app calls extractReportFacts() and never cares which provider
// ran. Default provider is OpenRouter (client preference). Both paths send the
// PDF + a strict JSON-schema Structured Output; only the request/response shape
// differs (OpenRouter = Chat Completions, OpenAI = Responses API).
//
// ⚠️ COMPLIANCE DEFERRED (plan §16 / §9): OpenRouter is a third-party processor in
// the path for consumer-credit PII. For production with REAL reports we still owe
// a DPA + request-level ZDR + training opt-out + prompt-logging OFF + a pinned
// provider, with legal sign-off. Not enabled here per current client direction —
// revisit before real-PII launch. Use redacted/synthetic reports until then.
//
// ⚠️ VERIFY WHEN WIRING A KEY: confirm exact model ids and request/response field
// names against each provider's current docs. Everything provider-specific lives
// in THIS file.
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

// Reasoning effort is OPT-IN and OFF by default. Setting it to "low" once made
// GPT-5.6 reason MORE than its default and pushed /api/analyze past 60s (504).
// Leave unset to use the provider default (the known-good ~51s baseline); set
// LLM_REASONING_EFFORT=minimal to experiment with a faster tier — no redeploy.
const REASONING_EFFORT = process.env.LLM_REASONING_EFFORT || ""
const reasoningField = REASONING_EFFORT ? { reasoning: { effort: REASONING_EFFORT } } : {}

export class ExtractionError extends Error {}

interface CallResult {
  text: string
  usage: unknown
}

function pdfDataUrl(pdfBase64: string): string {
  return `data:application/pdf;base64,${pdfBase64}`
}

// ── OpenAI (Responses API) ────────────────────────────────────────────────────
function readOpenAIText(payload: unknown): string {
  const p = payload as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }
  if (typeof p.output_text === "string" && p.output_text.length > 0) return p.output_text
  const chunks: string[] = []
  for (const item of p.output ?? []) for (const c of item.content ?? []) if (typeof c.text === "string") chunks.push(c.text)
  return chunks.join("")
}

async function callOpenAI(model: string, apiKey: string, pdfBase64: string, filename: string, userText: string): Promise<CallResult> {
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: EXTRACTION_SYSTEM_PROMPT }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: userText },
          { type: "input_file", filename, file_data: pdfDataUrl(pdfBase64) },
        ],
      },
    ],
    text: { format: { type: "json_schema", name: "credit_report_extraction", strict: true, schema: EXTRACTION_JSON_SCHEMA } },
    ...reasoningField,
  }
  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (!res.ok) throw new ExtractionError(`OpenAI request failed (${res.status}): ${(await res.text()).slice(0, 500)}`)
  const payload = await res.json()
  return { text: readOpenAIText(payload), usage: (payload as { usage?: unknown }).usage ?? null }
}

// ── OpenRouter (Chat Completions API) ─────────────────────────────────────────
function readOpenRouterText(payload: unknown): string {
  const p = payload as { choices?: Array<{ message?: { content?: string } }> }
  return p.choices?.[0]?.message?.content ?? ""
}

async function callOpenRouter(model: string, apiKey: string, pdfBase64: string, filename: string, userText: string): Promise<CallResult> {
  const body = {
    model,
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          // OpenRouter PDF input: a "file" content part with a base64 data URL.
          { type: "file", file: { filename, file_data: pdfDataUrl(pdfBase64) } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "credit_report_extraction", strict: true, schema: EXTRACTION_JSON_SCHEMA } },
    ...reasoningField,
    // For models without native PDF vision, OpenRouter can parse via a plugin:
    //   plugins: [{ id: "file-parser", pdf: { engine: "native" } }]
    // To enable ZDR/no-retention later (see header note): provider.data_collection = "deny".
  }
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "CreditCrb Credit Analyzer",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (!res.ok) throw new ExtractionError(`OpenRouter request failed (${res.status}): ${(await res.text()).slice(0, 500)}`)
  const payload = await res.json()
  return { text: readOpenRouterText(payload), usage: (payload as { usage?: unknown }).usage ?? null }
}

// ── Shared validate + repair-retry orchestration ──────────────────────────────
function isValid(x: unknown): x is RawExtraction {
  const r = x as RawExtraction
  // Require at least one score: a real report always has one, and an empty
  // result (e.g. from a bad schema/grammar) must trigger the repair retry and
  // ultimately fail loudly rather than persist as a silent "analyzed" blank.
  return !!r && !!r.report_meta && Array.isArray(r.scores) && r.scores.length > 0 && Array.isArray(r.accounts)
}

export async function extractReportFacts(
  args: { pdfBase64: string; filename: string },
): Promise<{ extracted: RawExtraction; tokenUsage: unknown; model: string; provider: LlmProvider }> {
  const provider = getLlmProvider()
  const model = getExtractionModel(provider)
  const apiKey = getProviderApiKey(provider)
  if (!apiKey) throw new ExtractionError(`Missing API key for LLM provider "${provider}".`)

  const call = provider === "openrouter" ? callOpenRouter : callOpenAI

  const first = await call(model, apiKey, args.pdfBase64, args.filename, "Extract the structured facts from this credit report PDF, strictly per the schema.")
  let parsed: unknown
  try {
    parsed = JSON.parse(first.text)
  } catch {
    parsed = undefined
  }
  if (isValid(parsed)) return { extracted: parsed, tokenUsage: first.usage, model, provider }

  // One repair attempt (plan §7.6).
  const second = await call(model, apiKey, args.pdfBase64, args.filename, "Your previous output was not valid JSON matching the schema. Re-extract strictly per the schema.")
  const reparsed = JSON.parse(second.text) // throws → route marks status=failed
  if (!isValid(reparsed)) throw new ExtractionError("Extraction did not match schema after repair retry.")
  return { extracted: reparsed, tokenUsage: second.usage, model, provider }
}
