import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/ghl"
import { CREDIT_REPORTS_BUCKET, getSupabaseAdmin } from "@/lib/supabase"
import { REPORT_STATUS, useMockExtraction } from "@/lib/credit"
import { buildMockExtraction, toAnalysis, type RawExtraction } from "@/lib/credit-extraction"
import { extractReportFacts } from "@/lib/llm-extract"

// POST /api/analyze — extract structured facts from the uploaded PDF, persist
// them, delete the PDF, and return the analysis (plan §4 steps 4–7).
//
// MOCK MODE: when OPENAI_API_KEY is unset (or CREDIT_ANALYZE_MOCK=true) the
// extraction is mocked so the whole pipeline (download → persist → delete PDF →
// analysis shape) is testable without an OpenAI key. Flips to the real Luna
// call automatically once the key is set. See lib/credit.ts useMockExtraction().

export const runtime = "nodejs"
export const maxDuration = 60 // AI extraction on a multi-page PDF can take tens of seconds (plan §5)

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request)

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json(
      { error: "Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY configuration." },
      { status: 500, headers: cors },
    )
  }

  let body: { reportId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const reportId = body.reportId?.trim()
  if (!reportId) {
    return NextResponse.json({ error: "reportId is required." }, { status: 400, headers: cors })
  }

  // Load the report row.
  const { data: report, error: reportErr } = await supabase
    .from("reports")
    .select("id, status, storage_path")
    .eq("id", reportId)
    .single()

  if (reportErr || !report) {
    return NextResponse.json({ error: "Unknown reportId." }, { status: 404, headers: cors })
  }
  if (!report.storage_path) {
    // PDF already deleted (already analyzed, or swept). Nothing to process.
    return NextResponse.json(
      { error: "No PDF to analyze — this report was already processed or its upload never completed." },
      { status: 409, headers: cors },
    )
  }

  const mock = useMockExtraction()

  try {
    await supabase.from("reports").update({ status: REPORT_STATUS.processing }).eq("id", reportId)

    // Download the PDF (service-role). Required for the real path; best-effort in mock.
    const { data: blob, error: dlErr } = await supabase.storage.from(CREDIT_REPORTS_BUCKET).download(report.storage_path)
    if ((dlErr || !blob) && !mock) {
      throw new Error(`Failed to download PDF: ${dlErr?.message ?? "not found"}`)
    }

    // Extract facts.
    let extracted: RawExtraction
    let tokenUsage: unknown = null
    let model: string
    if (mock) {
      extracted = buildMockExtraction()
      model = "mock"
    } else {
      const pdfBase64 = Buffer.from(await blob!.arrayBuffer()).toString("base64")
      const result = await extractReportFacts({ pdfBase64, filename: `${reportId}.pdf` })
      extracted = result.extracted
      tokenUsage = result.tokenUsage
      model = `${result.provider}:${result.model}` // e.g. "openrouter:openai/gpt-5.6-luna"
    }

    // Persist ONLY the structured extraction (plan §6.1 / §9.3). Upsert so a
    // re-run overwrites rather than erroring on the PK.
    const { error: analysisErr } = await supabase
      .from("report_analysis")
      .upsert({ report_id: reportId, model, extracted, token_usage: tokenUsage }, { onConflict: "report_id" })
    if (analysisErr) throw new Error(`Failed to persist analysis: ${analysisErr.message}`)

    // Delete the PDF immediately (plan §4 step 6 / FTC Disposal Rule §9.4).
    const { error: rmErr } = await supabase.storage.from(CREDIT_REPORTS_BUCKET).remove([report.storage_path])
    if (rmErr) console.log("[credit] PDF delete failed (will be swept):", rmErr.message)

    await supabase
      .from("reports")
      .update({
        status: REPORT_STATUS.analyzed,
        analyzed_at: new Date().toISOString(),
        pdf_deleted_at: rmErr ? null : new Date().toISOString(),
        storage_path: rmErr ? report.storage_path : null,
        error: null,
      })
      .eq("id", reportId)

    // NOTE: applying the GHL used-tag (plan step 7) is deferred while the gate is
    // observe-only for testing — tagging would pollute the test contact. It runs
    // in production once CREDIT_GATE_ENFORCED=true. See lib/credit.applyCreditUsedTag.

    return NextResponse.json(
      { status: "analyzed", mock, analysis: toAnalysis(reportId, extracted) },
      { status: 200, headers: cors },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log("[credit] analyze failed:", message)
    await supabase.from("reports").update({ status: REPORT_STATUS.failed, error: message.slice(0, 500) }).eq("id", reportId)
    return NextResponse.json(
      { status: "failed", error: "We couldn't read this report. Please upload the full PDF from your credit-monitoring service." },
      { status: 502, headers: cors },
    )
  }
}
