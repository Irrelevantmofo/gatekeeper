import { type NextRequest, NextResponse } from "next/server"
import {
  addUsedTag,
  corsHeaders,
  getGHLConfig,
  normalizeEmail,
  normalizePhone,
  resolveContactCustomFields,
  searchContact,
  upsertContact,
  USED_TAG,
} from "@/lib/ghl"

// Single consolidated endpoint for a form submission. In one server-side request it:
//   1. Reads the existing contact (if any) to enforce the one-submission gate.
//      If already tagged -> returns gate_closed WITHOUT writing anything.
//   2. Resolves the analyzer custom fields to real GHL field ids (best-effort).
//   3. Upserts the contact (idempotent create/update) with those custom fields.
//   4. Applies the tag.
//
// Doing create + tag sequentially on the server removes the browser-side race where
// the tag call could arrive before GHL had finished indexing the new contact.

type SubmitStatus = "gate_closed" | "ok"

// Preflight handler — browsers send OPTIONS before a cross-origin POST.
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
    // Analyzer values keyed by GHL field key/name, e.g. { gross_monthly_revenue: 50000 }.
    customFields?: Record<string, unknown>
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const email = body.email ? normalizeEmail(body.email) : ""
  const phone = body.phone ? normalizePhone(body.phone) : ""

  if (!email && !phone) {
    return NextResponse.json({ error: "Provide an email or phone." }, { status: 400, headers: cors })
  }

  try {
    // 1. Gate read — has this person already used the analyzer?
    const existing = await searchContact(email, phone, config.token, config.locationId)
    if (existing) {
      const tags = (existing.tags ?? []).map((t) => t.toLowerCase())
      if (tags.includes(USED_TAG)) {
        // Already submitted. Return without creating/updating or re-tagging.
        return NextResponse.json(
          { status: "gate_closed" as SubmitStatus, message: "Contact has already used the business analyzer." },
          { status: 200, headers: cors },
        )
      }
    }

    // 2. Resolve the analyzer custom fields to real GHL field ids. This is
    //    best-effort: if the lookup fails or a field can't be mapped, we still
    //    write the core contact rather than lose the lead.
    let resolvedCustomFields: Awaited<ReturnType<typeof resolveContactCustomFields>> = {
      resolved: [],
      unresolved: [],
    }
    if (body.customFields && typeof body.customFields === "object") {
      try {
        resolvedCustomFields = await resolveContactCustomFields(body.customFields, config.token, config.locationId)
        if (resolvedCustomFields.unresolved.length > 0) {
          console.log("[v0] Unmapped custom fields (skipped):", resolvedCustomFields.unresolved.join(", "))
        }
      } catch (cfErr) {
        console.log("[v0] Custom field resolution failed, continuing:", cfErr instanceof Error ? cfErr.message : cfErr)
      }
    }

    // 3. Create or update the contact, custom fields included. Idempotent — returns
    //    the id synchronously so we can tag without racing GHL's indexing.
    const contact = await upsertContact(
      {
        firstName: body.firstName?.trim(),
        lastName: body.lastName?.trim(),
        companyName: body.companyName?.trim(),
        email,
        phone,
        customFields: resolvedCustomFields.resolved,
      },
      config.token,
      config.locationId,
    )

    // 4. Tag it in the same request — no cross-call race, real id in hand.
    await addUsedTag(contact.id, config.token)

    return NextResponse.json(
      {
        status: "ok" as SubmitStatus,
        contactId: contact.id,
        created: !existing,
        customFieldsApplied: resolvedCustomFields.resolved.length,
        customFieldsUnresolved: resolvedCustomFields.unresolved,
        message: "Contact saved and tagged.",
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    console.log("[v0] GHL submit error:", error instanceof Error ? error.message : error)
    return NextResponse.json({ error: "Failed to process submission in GoHighLevel." }, { status: 502, headers: cors })
  }
}
