import { type NextRequest, NextResponse } from "next/server"
import { corsHeaders, getGHLConfig, normalizeEmail, normalizePhone, searchContact, USED_TAG } from "@/lib/ghl"

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
    // Read-only lookup. Exact-match on email (with additionalEmails fallback), then phone.
    const contact = await searchContact(email, phone, config.token, config.locationId)

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
