import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/ghl"
import { getSupabaseAdmin } from "@/lib/supabase"
import { toAnalysis, type RawExtraction } from "@/lib/credit-extraction"
import { buildBestPath } from "@/lib/credit-simulator"

// POST /api/best-path — "Quickest Path to <target>" (client request). Given a
// target score (or an auto-picked next tier), returns the ordered set of
// paydowns to make FIRST, plus a runnable scenario the frontend auto-applies to
// the simulator. Deterministic; no AI. See lib/credit-simulator.buildBestPath.

export const runtime = "nodejs"

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

  let body: { reportId?: string; target?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const reportId = body.reportId?.trim()
  if (!reportId) {
    return NextResponse.json({ error: "reportId is required." }, { status: 400, headers: cors })
  }

  const { data: row, error } = await supabase
    .from("report_analysis")
    .select("extracted")
    .eq("report_id", reportId)
    .single()

  if (error || !row) {
    return NextResponse.json({ error: "No analysis found for this reportId." }, { status: 404, headers: cors })
  }

  const analysis = toAnalysis(reportId, row.extracted as RawExtraction)
  const target = typeof body.target === "number" && body.target > 0 ? body.target : undefined
  const result = buildBestPath(analysis, target)

  return NextResponse.json({ reportId, ...result }, { status: 200, headers: cors })
}
