import { type NextRequest } from "next/server"

export const GHL_BASE_URL = "https://services.leadconnectorhq.com"
export const GHL_API_VERSION = "2021-07-28"
export const USED_TAG = "business-analyzer-used"

export interface GHLContact {
  id: string
  tags?: string[]
}

// A custom field on the upsert body must be keyed by the GHL field id; the value
// goes in `field_value` (per the Contacts v2 spec).
export interface ResolvedCustomField {
  id: string
  field_value: unknown
}

export interface UpsertContactInput {
  firstName?: string
  lastName?: string
  companyName?: string
  email?: string
  phone?: string
  source?: string
  customFields?: ResolvedCustomField[]
}

interface GHLLocationCustomField {
  id: string
  name?: string
  fieldKey?: string
  dataType?: string
}

interface GHLUpsertResponse {
  // Upsert returns the affected contact plus a `new` flag (created vs. updated).
  new?: boolean
  contact?: GHLContact
  // Some responses put the record at the top level; read defensively.
  id?: string
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

// Creates or updates a contact by email/phone and returns the record (with its id).
// Upsert is idempotent — it honors the location's "Allow Duplicate Contact" setting,
// so it dedupes instead of creating a second contact. Returning the id synchronously
// is what lets the caller tag in the same request without racing GHL's indexing.
export async function upsertContact(
  input: UpsertContactInput,
  token: string,
  locationId: string,
): Promise<GHLContact> {
  const res = await fetch(`${GHL_BASE_URL}/contacts/upsert`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      locationId,
      firstName: input.firstName || undefined,
      lastName: input.lastName || undefined,
      companyName: input.companyName || undefined,
      email: input.email || undefined,
      phone: input.phone || undefined,
      // Per-call source; defaults to the BAT value so existing BAT behavior is unchanged.
      source: input.source || "Business Loan Analyzer",
      customFields: input.customFields && input.customFields.length > 0 ? input.customFields : undefined,
    }),
    cache: "no-store",
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`GHL upsert failed (${res.status}): ${detail}`)
  }

  const data = (await res.json()) as GHLUpsertResponse
  const contact = data.contact ?? (data.id ? { id: data.id, tags: data.tags } : null)
  if (!contact?.id) {
    throw new Error("GHL upsert returned no contact id")
  }
  return contact
}

// Slugify a label/key into GHL's underscore style so "Gross Monthly Revenue",
// "gross_monthly_revenue" and "gross-monthly-revenue" all collapse to one lookup key.
function slugifyFieldKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

// The location's contact custom-field list rarely changes, so cache it in module
// scope with a short TTL to avoid an extra GHL round-trip on every warm invocation.
let fieldCache: { at: number; fields: GHLLocationCustomField[] } | null = null
const FIELD_CACHE_TTL_MS = 5 * 60 * 1000

async function getLocationContactFields(token: string, locationId: string): Promise<GHLLocationCustomField[]> {
  const now = Date.now()
  if (fieldCache && now - fieldCache.at < FIELD_CACHE_TTL_MS) return fieldCache.fields

  const res = await fetch(`${GHL_BASE_URL}/locations/${locationId}/customFields?model=contact`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      Accept: "application/json",
    },
    cache: "no-store",
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`GHL get custom fields failed (${res.status}): ${detail}`)
  }

  const data = (await res.json()) as { customFields?: GHLLocationCustomField[] }
  const fields = data.customFields ?? []
  fieldCache = { at: now, fields }
  return fields
}

// Maps caller-supplied { key: value } analyzer fields onto real GHL custom-field ids.
// Matching is tolerant: it resolves by fieldKey (with or without the "contact." prefix)
// and by slugified field name. Anything that doesn't resolve is returned in `unresolved`
// so the caller can log it — a missing field never blocks the contact write.
export async function resolveContactCustomFields(
  incoming: Record<string, unknown>,
  token: string,
  locationId: string,
): Promise<{ resolved: ResolvedCustomField[]; unresolved: string[] }> {
  const entries = Object.entries(incoming).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  )
  if (entries.length === 0) return { resolved: [], unresolved: [] }

  const fields = await getLocationContactFields(token, locationId)

  const lookup = new Map<string, string>() // normalized key -> field id
  for (const f of fields) {
    if (!f.id) continue
    if (f.fieldKey) {
      const suffix = f.fieldKey.includes(".") ? f.fieldKey.split(".").slice(1).join(".") : f.fieldKey
      lookup.set(slugifyFieldKey(suffix), f.id)
    }
    if (f.name) lookup.set(slugifyFieldKey(f.name), f.id)
  }

  const resolved: ResolvedCustomField[] = []
  const unresolved: string[] = []
  for (const [key, value] of entries) {
    const id = lookup.get(slugifyFieldKey(key))
    if (id) resolved.push({ id, field_value: value })
    else unresolved.push(key)
  }
  return { resolved, unresolved }
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
