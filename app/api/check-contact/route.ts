import { type NextRequest, NextResponse } from "next/server"

const GHL_BASE_URL = "https://services.leadconnectorhq.com"
const GHL_API_VERSION = "2021-07-28"
const USED_TAG = "business-analyzer-used"

type GateStatus = "no_contact" | "gate_closed" | "gate_open"

interface GateResult {
  status: GateStatus
  message: string
}

const MESSAGES: Record<GateStatus, string> = {
  no_contact: "No existing contact found. Safe to proceed.",
  gate_closed: "Gate closed: Contact has already used the business analyzer.",
  gate_open: "Gate open: Contact exists but has not used the analyzer yet.",
}

interface GHLContact {
  id: string
  tags?: string[]
}

interface GHLSearchResponse {
  contacts?: GHLContact[]
}

// Build CORS headers, echoing back the request origin when it's in the allowlist.
// Set ALLOWED_ORIGINS (comma-separated) to restrict; defaults to "*".
function corsHeaders(request: NextRequest): Record<string, string> {
  const allowed = (process.env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)

  const requestOrigin = request.headers.get("origin")
  let allowOrigin = "*"

  if (!allowed.includes("*")) {
    allowOrigin = requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : allowed[0] ?? ""
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  }

  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin
    // Vary on Origin so caches don't serve the wrong CORS header to another origin.
    if (allowOrigin !== "*") headers.Vary = "Origin"
  }

  return headers
}

// Preflight handler — browsers send OPTIONS before a cross-origin POST.
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

// Basic normalizers so the same input always hits GHL the same way.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "")
}

type SearchFilter = Record<string, unknown>

async function searchByFilter(
  filters: SearchFilter[],
  token: string,
  locationId: string,
): Promise<GHLContact | null> {
  const res = await fetch(`${GHL_BASE_URL}/contacts/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      locationId,
      page: 1,
      pageLimit: 1,
      // Exact-match filters are reliable regardless of CRM size, unlike free-text `query`.
      filters,
    }),
    // Never cache identity lookups.
    cache: "no-store",
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`GHL search failed (${res.status}): ${detail}`)
  }

  const data = (await res.json()) as GHLSearchResponse
  return data.contacts?.[0] ?? null
}

async function searchContact(
  email: string,
  phone: string,
  token: string,
  locationId: string,
): Promise<GHLContact | null> {
  // Try exact email first (covers standard + additional emails), then fall back to phone.
  if (email) {
    const byEmail = await searchByFilter([{ field: "email", operator: "eq", value: email }], token, locationId)
    if (byEmail) return byEmail

    const byAdditionalEmail = await searchByFilter(
      [{ field: "additionalEmails", operator: "nested", value: [{ field: "email", operator: "eq", value: email }] }],
      token,
      locationId,
    )
    if (byAdditionalEmail) return byAdditionalEmail
  }

  if (phone) {
    const byPhone = await searchByFilter([{ field: "phone", operator: "eq", value: phone }], token, locationId)
    if (byPhone) return byPhone
  }

  return null
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request)

  const token = process.env.GHL_API_TOKEN
  const locationId = process.env.GHL_LOCATION_ID

  if (!token || !locationId) {
    return NextResponse.json(
      { error: "Server is missing GHL_API_TOKEN or GHL_LOCATION_ID configuration." },
      { status: 500, headers: cors },
    )
  }

  let body: { email?: string; phone?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const email = body.email ? normalizeEmail(body.email) : ""
  const phone = body.phone ? normalizePhone(body.phone) : ""

  if (!email && !phone) {
    return NextResponse.json({ error: "Provide an email or phone to check." }, { status: 400, headers: cors })
  }

  try {
    // Exact-match on email (with additionalEmails fallback), then phone.
    const contact = await searchContact(email, phone, token, locationId)

    let result: GateResult

    if (!contact) {
      result = { status: "no_contact", message: MESSAGES.no_contact }
    } else {
      const tags = (contact.tags ?? []).map((t) => t.toLowerCase())
      const hasUsedTag = tags.includes(USED_TAG)
      result = hasUsedTag
        ? { status: "gate_closed", message: MESSAGES.gate_closed }
        : { status: "gate_open", message: MESSAGES.gate_open }
    }

    return NextResponse.json(result, { status: 200, headers: cors })
  } catch (error) {
    console.log("[v0] GHL contact check error:", error instanceof Error ? error.message : error)
    return NextResponse.json({ error: "Failed to check contact against GoHighLevel." }, { status: 502, headers: cors })
  }
}
