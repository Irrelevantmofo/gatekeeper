import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/ghl"
import { getSupabaseAdmin } from "@/lib/supabase"
import { toAnalysis, type RawExtraction } from "@/lib/credit-extraction"
import { simulate, type SimScenario } from "@/lib/credit-simulator"

// POST /api/simulate — deterministic score projection (plan §8, §15). No AI, no
// LLM cost; safe to call on every slider change. Loads the stored facts and
// recomputes each bureau's estimated score for the given scenario.

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

  let body: { reportId?: string; scenario?: SimScenario }
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

  // toAnalysis gives accounts with stable accountIds + per-bureau balances/limits
  // and the actionable flag — exactly what the simulator consumes.
  const analysis = toAnalysis(reportId, row.extracted as RawExtraction)
  const result = simulate(analysis, body.scenario ?? {})

  return NextResponse.json({ reportId, ...result }, { status: 200, headers: cors })
}
