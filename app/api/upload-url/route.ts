import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/ghl"
import { CREDIT_REPORTS_BUCKET, CREDIT_REPORTS_TMP_PREFIX, getSupabaseAdmin } from "@/lib/supabase"
import { getSweepTtlMinutes, REPORT_STATUS } from "@/lib/credit"

// POST /api/upload-url — mints a scoped, short-lived signed URL the browser PUTs
// the PDF to (plan §4 step 2). The file goes browser → Supabase Storage directly,
// never through this function, so large PDFs don't hit serverless body limits.
//
// Requires a valid consentId (every report is tied to a consent record). We
// create the `reports` row first to get its id, then mint the signed URL for
// tmp/{id}.pdf and record the storage path + orphan-sweep TTL.

// Kept in sync with the frontend contract (§4). Backend is the source of truth.
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const MAX_PAGES = 15
// Supabase signed upload URL token validity (default ~2h; not configurable).
const UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000

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

  let body: { consentId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const consentId = body.consentId?.trim()
  if (!consentId) {
    return NextResponse.json({ error: "consentId is required." }, { status: 400, headers: cors })
  }

  // Verify the consent exists — ties every report to a logged authorization.
  const { data: consent, error: consentErr } = await supabase
    .from("consents")
    .select("id, contact_ref")
    .eq("id", consentId)
    .single()

  if (consentErr || !consent) {
    return NextResponse.json({ error: "Unknown consentId." }, { status: 404, headers: cors })
  }

  // Create the report row first so its id can name the storage object.
  const { data: report, error: reportErr } = await supabase
    .from("reports")
    .insert({
      consent_id: consent.id,
      contact_ref: consent.contact_ref,
      status: REPORT_STATUS.awaitingUpload,
    })
    .select("id")
    .single()

  if (reportErr || !report) {
    console.log("[credit] report insert failed:", reportErr?.message)
    return NextResponse.json({ error: "Failed to create report." }, { status: 502, headers: cors })
  }

  const storagePath = `${CREDIT_REPORTS_TMP_PREFIX}/${report.id}.pdf`

  const { data: signed, error: signErr } = await supabase.storage
    .from(CREDIT_REPORTS_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: true })

  if (signErr || !signed) {
    console.log("[credit] signed upload url failed:", signErr?.message)
    return NextResponse.json({ error: "Failed to create upload URL." }, { status: 502, headers: cors })
  }

  // Record the path + when an orphaned (never-analyzed) upload can be swept.
  const sweepAfter = new Date(Date.now() + getSweepTtlMinutes() * 60_000).toISOString()
  await supabase.from("reports").update({ storage_path: storagePath, sweep_after: sweepAfter }).eq("id", report.id)

  return NextResponse.json(
    {
      reportId: report.id,
      uploadUrl: signed.signedUrl, // absolute URL; browser PUTs the PDF here
      token: signed.token, // alternative: supabase-js uploadToSignedUrl(path, token, file)
      storagePath,
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_MS).toISOString(),
      constraints: { maxBytes: MAX_BYTES, maxPages: MAX_PAGES, mimeType: "application/pdf" },
    },
    { status: 200, headers: cors },
  )
}
