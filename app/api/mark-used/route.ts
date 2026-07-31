import { type NextRequest, NextResponse } from "next/server"
import { addUsedTag, corsHeaders, getGHLConfig, normalizeEmail, normalizePhone, searchContact } from "@/lib/ghl"

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

  let body: { contactId?: string; email?: string; phone?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: cors })
  }

  const contactId = body.contactId?.trim() ?? ""
  const email = body.email ? normalizeEmail(body.email) : ""
  const phone = body.phone ? normalizePhone(body.phone) : ""

  if (!contactId && !email && !phone) {
    return NextResponse.json(
      { error: "Provide a contactId, email, or phone to mark as used." },
      { status: 400, headers: cors },
    )
  }

  try {
    // Prefer the exact contactId when provided; otherwise resolve by email/phone.
    let resolvedId = contactId

    if (!resolvedId) {
      const contact = await searchContact(email, phone, config.token, config.locationId)
      if (!contact) {
        return NextResponse.json(
          { status: "not_found", message: "No matching contact found to mark as used." },
          { status: 404, headers: cors },
        )
      }
      resolvedId = contact.id
    }

    await addUsedTag(resolvedId, config.token)

    return NextResponse.json(
      { status: "marked", message: "Contact marked as having used the business analyzer.", contactId: resolvedId },
      { status: 200, headers: cors },
    )
  } catch (error) {
    console.log("[v0] GHL mark-used error:", error instanceof Error ? error.message : error)
    return NextResponse.json({ error: "Failed to mark contact as used in GoHighLevel." }, { status: 502, headers: cors })
  }
}
