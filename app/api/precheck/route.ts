import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/ghl"
import { CREDIT_REPORTS_BUCKET, getSupabaseAdmin } from "@/lib/supabase"
import { getMaxPages, isPrecheckEnabled, REPORT_STATUS } from "@/lib/credit"
import { precheckCreditReport } from "@/lib/credit-precheck"

// POST /api/precheck — fast, ZERO-AI pre-flight before /api/analyze:
//   1. Returns the PDF's page count so the loading screen can say
//      "Reading your 34-page report…".
//   2. Rejects a wrong document (not a credit report / too many pages) BEFORE
//      the expensive extraction call — deleting the PDF and failing the report.
//
// Call this right after the upload PUT, then only call /api/analyze if ok:true.
// (analyze still runs its own precheck as a safety net if called directly.)

export const runtime = "nodejs"
export const maxDuration = 30

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

  const { data: report, error: reportErr } = await supabase
    .from("reports")
    .select("id, storage_path")
    .eq("id", reportId)
    .single()

  if (reportErr || !report) {
    return NextResponse.json({ error: "Unknown reportId." }, { status: 404, headers: cors })
  }
  if (!report.storage_path) {
    return NextResponse.json({ error: "No uploaded PDF for this report." }, { status: 409, headers: cors })
  }

  const { data: blob, error: dlErr } = await supabase.storage.from(CREDIT_REPORTS_BUCKET).download(report.storage_path)
  if (dlErr || !blob) {
    return NextResponse.json({ error: "Could not read the uploaded PDF." }, { status: 502, headers: cors })
  }

  const pre = await precheckCreditReport(await blob.arrayBuffer(), getMaxPages())

  // Reject wrong docs here (unless precheck is disabled) — deletes the PDF so no
  // tokens are ever spent on it, and /api/analyze would find nothing to process.
  if (isPrecheckEnabled() && !pre.ok) {
    await supabase.storage.from(CREDIT_REPORTS_BUCKET).remove([report.storage_path])
    await supabase
      .from("reports")
      .update({ status: REPORT_STATUS.failed, error: pre.reason?.slice(0, 500), pdf_deleted_at: new Date().toISOString(), storage_path: null })
      .eq("id", reportId)
    return NextResponse.json({ ok: false, reason: "not_a_credit_report", message: pre.reason, pages: pre.pages ?? null }, { status: 422, headers: cors })
  }

  return NextResponse.json({ ok: true, reportId, pages: pre.pages ?? null }, { status: 200, headers: cors })
}
