import { type NextRequest, NextResponse } from "next/server"
import {
  addUsedTag,
  corsHeaders,
  getGHLConfig,
  normalizeEmail,
  normalizePhone,
  resolveContactCustomFields,
  upsertContact,
} from "@/lib/ghl"

// Contact write for the 35 Lenders Marketplace landing page.
//
// Same shape as /api/submit: resolve custom fields, upsert, tag, all in 1
// server-side request so the tag can never race GHL's indexing of a new contact.
//
// ── Why this is a separate route and not /api/submit ────────────────────────
//
// /api/submit enforces the analyzer's ONE-SUBMISSION GATE. It reads the contact
// first and, if `hasAnyAnalyzerTag` matches, returns `gate_closed` and writes
// nothing. That gate is correct for the analyzer: 1 estimate per business, across
// every surface.
//
// It is wrong here, in 2 separate ways:
//
//   1. A merchant who already used the loan analyzer carries
//      `business-analyzer-used`. Sent through /api/submit, their marketplace
//      enquiry would come back `gate_closed` and the lead would be dropped, for
//      no reason a merchant could understand. The 2 products share a CRM, not a
//      quota.
//   2. There is nothing to gate. The analyzer hands out an estimate that costs
//      money to produce. This form asks to be contacted, and a merchant who fills
//      it in twice next week is a keen lead, not a duplicate to suppress.
//
// So: no read, no gate, no `hasAnyAnalyzerTag`. Upsert is already idempotent and
// GHL merges tags, so a repeat submission updates the same contact rather than
// creating a second one.
//
// The tag is fixed rather than resolved from a variant. There is 1 surface here,
// and `resolveVariantTag` maps analyzer variants only: passing anything through it
// would silently return the analyzer's own tag and trip the gate on that
// merchant's next analyzer visit.

/** The only tag this route applies. GHL workflows branch on it. */
const MARKETPLACE_TAG = "35-lender-marketplace-optin"

/** Distinguishes marketplace leads from analyzer leads in any report by source. */
const MARKETPLACE_SOURCE = "35 Lenders Marketplace"

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request)

  const config = getGHLConfig()
  if (!config) {
    return NextResponse.json(
      { error: "Server is missing GHL_API_TOKEN or GHL_LOCATION_ID configuration." },
      { status: 500, headers: cors },
    )
  }

  let body: {
    firstName?: string
    lastName?: string
    companyName?: string
    email?: string
    phone?: string
    /**
     * Keyed by GHL field KEY, not id. Resolved below. Send these as text fields:
     * a dropdown whose value does not match an option exactly is discarded while
     * the request still succeeds, which looks identical to working.
     */
    customFields?: Record<string, unknown>
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  // The normalizers take a required string, so guard first, same as /api/submit.
  const email = body.email ? normalizeEmail(body.email) : ""
  const phone = body.phone ? normalizePhone(body.phone) : ""

  // An enquiry with no way to reply is not a lead. The caller validates too, but
  // this endpoint is reachable on its own and should not write a dead contact.
  if (!email && !phone) {
    return NextResponse.json(
      { error: "An email or a phone number is required." },
      { status: 400, headers: cors },
    )
  }

  try {
    let resolved: Awaited<ReturnType<typeof resolveContactCustomFields>> = {
      resolved: [],
      unresolved: [],
    }

    if (body.customFields && typeof body.customFields === "object") {
      try {
        resolved = await resolveContactCustomFields(body.customFields, config.token, config.locationId)
        if (resolved.unresolved.length > 0) {
          // The ONLY place a wrong field key is visible. The write succeeds either
          // way, because a missing field must never cost a lead, which also means
          // a wrong key looks exactly like success from the browser.
          console.log("[marketplace-optin] Unmapped custom fields (skipped):", resolved.unresolved.join(", "))
        }
      } catch (cfErr) {
        console.log(
          "[marketplace-optin] Custom field resolution failed, continuing:",
          cfErr instanceof Error ? cfErr.message : cfErr,
        )
      }
    }

    const contact = await upsertContact(
      {
        firstName: body.firstName?.trim(),
        lastName: body.lastName?.trim(),
        companyName: body.companyName?.trim(),
        email,
        phone,
        source: MARKETPLACE_SOURCE,
        customFields: resolved.resolved,
      },
      config.token,
      config.locationId,
    )

    await addUsedTag(contact.id, config.token, MARKETPLACE_TAG)

    return NextResponse.json(
      {
        status: "ok",
        contactId: contact.id,
        customFieldsApplied: resolved.resolved.length,
        customFieldsUnresolved: resolved.unresolved,
        appliedTag: MARKETPLACE_TAG,
        message: "Contact saved and tagged.",
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    console.log("[marketplace-optin] GHL error:", error instanceof Error ? error.message : error)
    return NextResponse.json(
      { error: "Failed to process the enquiry in GoHighLevel." },
      { status: 502, headers: cors },
    )
  }
}
