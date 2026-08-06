import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/ghl"
import { getSupabaseAdmin } from "@/lib/supabase"
import { type RawExtraction } from "@/lib/credit-extraction"
import { buildAnalysis } from "@/lib/credit-simulator"

// GET /api/status?reportId=... — poll analysis progress (plan §4 step 4, §5).
// Returns { status } while processing, { status:"failed", error } on failure, and
// { status:"analyzed", analysis } once done (analysis = frontend contract §8).

export const runtime = "nodejs"

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request)

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json(
      { error: "Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY configuration." },
      { status: 500, headers: cors },
    )
  }

  const reportId = request.nextUrl.searchParams.get("reportId")?.trim()
  if (!reportId) {
    return NextResponse.json({ error: "reportId query param is required." }, { status: 400, headers: cors })
  }

  const { data: report, error } = await supabase.from("reports").select("status, error").eq("id", reportId).single()
  if (error || !report) {
    return NextResponse.json({ error: "Unknown reportId." }, { status: 404, headers: cors })
  }

  if (report.status === "failed") {
    return NextResponse.json(
      { status: "failed", error: "We couldn't read this report. Please upload the full PDF from your credit-monitoring service." },
      { status: 200, headers: cors },
    )
  }

  if (report.status === "analyzed") {
    const { data: analysis, error: aErr } = await supabase
      .from("report_analysis")
      .select("extracted")
      .eq("report_id", reportId)
      .single()
    if (aErr || !analysis) {
      return NextResponse.json({ status: "processing" }, { status: 200, headers: cors })
    }
    const maxN = Number.parseInt(process.env.RECOMMENDATIONS_MAX_N || "5", 10) || 5
    return NextResponse.json(
      { status: "analyzed", analysis: buildAnalysis(reportId, analysis.extracted as RawExtraction, maxN) },
      { status: 200, headers: cors },
    )
  }

  // awaiting_upload | processing | deleted
  return NextResponse.json({ status: report.status }, { status: 200, headers: cors })
}
