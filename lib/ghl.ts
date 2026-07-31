import { type NextRequest } from "next/server"

export const GHL_BASE_URL = "https://services.leadconnectorhq.com"
export const GHL_API_VERSION = "2021-07-28"
export const USED_TAG = "business-analyzer-used"

export interface GHLContact {
  id: string
  tags?: string[]
}

interface GHLSearchResponse {
  contacts?: GHLContact[]
}

// Build CORS headers, echoing back the request origin when it's in the allowlist.
// Set ALLOWED_ORIGINS (comma-separated) to restrict; defaults to "*".
export function corsHeaders(request: NextRequest): Record<string, string> {
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

// Basic normalizers so the same input always hits GHL the same way.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "")
}

// Returns the GHL credentials, or null if either is missing.
export function getGHLConfig(): { token: string; locationId: string } | null {
  const token = process.env.GHL_API_TOKEN
  const locationId = process.env.GHL_LOCATION_ID
  if (!token || !locationId) return null
  return { token, locationId }
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

export async function searchContact(
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

// Adds the "used" tag to a contact. GHL merges tags, so this is safe to call
// even if the tag somehow already exists.
export async function addUsedTag(contactId: string, token: string): Promise<void> {
  const res = await fetch(`${GHL_BASE_URL}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ tags: [USED_TAG] }),
    cache: "no-store",
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`GHL add tag failed (${res.status}): ${detail}`)
  }
}
