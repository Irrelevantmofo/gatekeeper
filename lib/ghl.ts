import { type NextRequest } from "next/server"

export const GHL_BASE_URL = "https://services.leadconnectorhq.com"
export const GHL_API_VERSION = "2021-07-28"
// ---------------------------------------------------------------------------
// BAT ships as two surfaces: a neutral tool that brokers share, and a Credit CRB
// branded copy embedded in WordPress. They are tagged differently so GoHighLevel
// workflows can branch, most importantly to send a neutral results email to
// neutral leads instead of a Credit CRB one.
//
// USED_TAG stays the neutral tag and stays exported, so any caller that does not
// send a variant behaves exactly as before.
// ---------------------------------------------------------------------------
export const USED_TAG = "business-analyzer-used"

/** Variant slug, as sent by the frontend, mapped to the tag it earns. */
export const ANALYZER_VARIANT_TAGS: Record<string, string> = {
  neutral: USED_TAG,
  creditcrb: "business-analyzer-creditcrb-used",
}

/**
 * The tag a submission should apply.
 *
 * Unknown or missing variants fall back to the neutral tag rather than inventing
 * one, so a broker slug we have not mapped still gates correctly. Own-property
 * check because a plain object index walks the prototype chain.
 */
export function resolveVariantTag(variant?: string | null): string {
  if (!variant) return USED_TAG
  const key = variant.trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(ANALYZER_VARIANT_TAGS, key)) return USED_TAG
  return ANALYZER_VARIANT_TAGS[key]
}

/**
 * Has this contact used ANY variant of the analyzer?
 *
 * The gate exists to allow one estimate per business, not one per surface. So it
 * closes on any variant tag: without this, someone could run the neutral tool and
 * the branded tool and generate two leads for the same business.
 */
export function hasAnyAnalyzerTag(tags: string[]): boolean {
  const owned = Object.values(ANALYZER_VARIANT_TAGS)
  return tags.some((t) => owned.includes(t))
}

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
/**
 * Applies the analyzer used-tag. Defaults to the neutral tag so existing callers
 * that pass no tag are unchanged.
 */
export async function addUsedTag(
  contactId: string,
  token: string,
  tag: string = USED_TAG,
): Promise<void> {
  const res = await fetch(`${GHL_BASE_URL}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ tags: [tag] }),
    cache: "no-store",
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`GHL add tag failed (${res.status}): ${detail}`)
  }
}

// Send an email to a contact via the GHL Conversations API. The message threads
// into the contact's Conversation (so replies fire the "Customer Replied" trigger
// for the feedback-loop automation) and `attachments` are HTTPS URLs GHL fetches
// and attaches. Requires the token scope `conversations/message.write`.
// (Verify the exact field names against current GHL docs if this ever 4xxs.)
export async function sendGhlEmail(
  params: { contactId: string; subject: string; html: string; attachments?: string[]; emailFrom?: string; replyTo?: string },
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = {
    type: "Email",
    contactId: params.contactId,
    subject: params.subject,
    html: params.html,
  }
  if (params.attachments?.length) body.attachments = params.attachments
  if (params.emailFrom) body.emailFrom = params.emailFrom
  if (params.replyTo) body.replyTo = params.replyTo

  const res = await fetch(`${GHL_BASE_URL}/conversations/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (!res.ok) {
    const detail = await res.text()
    return { ok: false, error: `GHL email send failed (${res.status}): ${detail.slice(0, 300)}` }
  }
  return { ok: true }
}
