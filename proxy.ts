import { type NextRequest, NextResponse } from "next/server"
import { SECRET_HEADER, evaluate, readGuardConfig } from "@/lib/guard"

// ---------------------------------------------------------------------------
// The caller guard, applied to every API route.
//
// In the proxy layer rather than in each route on purpose. There are 13 routes today
// and the next one will be added by somebody who has not read this file, so a
// guard that has to be remembered per route is a guard that will be missed. Here
// it is impossible to forget and there is 1 place to change it.
//
// See lib/guard.ts for who the 3 callers are and why they authenticate
// differently.
//
// Edge runtime: this reads headers and environment variables only, no Node APIs,
// no database. It has to stay that way, or every request pays for a Node cold
// start before it is even allowed in.
// ---------------------------------------------------------------------------

export const config = {
  // The API only. Nothing else on this deployment is worth guarding, and matching
  // everything would put the middleware in front of static assets for nothing.
  matcher: "/api/:path*",
}

/**
 * CORS headers on a rejection.
 *
 * Without these a browser reports a blocked request as a CORS failure and hides
 * the 403, which sends whoever is debugging a legitimately misconfigured origin
 * looking in the wrong place entirely. The body carries no data, so echoing the
 * origin back on a rejection gives nothing away.
 */
function rejectionHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    ...(origin ? { Vary: "Origin" } : {}),
  }
}

export default function proxy(request: NextRequest) {
  const guard = readGuardConfig({
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    GATEKEEPER_SECRET: process.env.GATEKEEPER_SECRET,
  })

  const origin = request.headers.get("origin")

  const verdict = evaluate(
    {
      method: request.method,
      origin,
      referer: request.headers.get("referer"),
      secret: request.headers.get(SECRET_HEADER),
    },
    guard,
  )

  if (verdict.allow) {
    if (verdict.reason === "unconfigured") {
      // Loud, and on every request, because this is the state where the guard is
      // shipped but doing nothing. Set ALLOWED_ORIGINS and GATEKEEPER_SECRET.
      console.warn(
        "[guard] OPEN TO EVERYONE. Neither ALLOWED_ORIGINS nor GATEKEEPER_SECRET is set, so every caller is allowed. See lib/guard.ts.",
      )
    }
    return NextResponse.next()
  }

  // Logged with the path and the origin, so a rejected legitimate caller is 1
  // log line to diagnose rather than a mystery. Rejections are cheap to read
  // because real traffic never produces them.
  console.warn(
    `[guard] Rejected ${request.method} ${request.nextUrl.pathname}: ${verdict.reason}. Origin: ${origin ?? "none"}.`,
  )

  return NextResponse.json(
    { error: "This API does not accept requests from this caller." },
    { status: 403, headers: rejectionHeaders(origin) },
  )
}
