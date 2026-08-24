// ---------------------------------------------------------------------------
// Who is allowed to call this API.
//
// Until now every route accepted a request from anywhere, unauthenticated. CORS
// headers were being set, but CORS is a BROWSER convention: it stops a page on
// another origin from reading a response. It does nothing about curl, a script,
// or a bot, none of which ask permission. So the API was open.
//
// There are exactly 3 callers, and they do not all authenticate the same way:
//
//   business-loan-analyzer-tool      browser  ->  origin
//   identityIQ-credit-score-simulator browser ->  origin
//   lender-marketplace-landing-page  server   ->  shared secret
//
// A browser caller cannot hold a secret. Anything shipped to the browser is in
// the JS bundle and readable by the first person who looks, so a "secret" there
// is decoration. What a browser does send, and cannot forge from page JavaScript,
// is `Origin`. So browser callers are identified by origin and the marketplace,
// which calls from its own server, is identified by a secret it can actually keep.
//
// ── What this does and does not stop ───────────────────────────────────────
//
// It stops: another website's page calling this API, and every bot that does not
// bother to set headers, which is nearly all of them.
//
// It does not stop: a determined caller who sets `Origin` by hand from a script.
// Origin is unforgeable from page JavaScript, not from curl. Closing that needs a
// per-request token or a challenge such as Turnstile, and it is worth doing on the
// endpoints that cost money before it is worth doing everywhere.
//
// ── Failing open when unconfigured, on purpose ─────────────────────────────
//
// If neither ALLOWED_ORIGINS nor GATEKEEPER_SECRET is set, this allows everything
// and logs a warning on every request.
//
// That is deliberate. The alternative is that deploying this file, before the
// environment variables exist, silently stops all 3 products from working, and
// the symptom is leads quietly not arriving. That exact failure is already
// documented in this system as the expensive one. A guard that has to be turned
// on is safe to ship; a guard that is on before it is configured is not.
// ---------------------------------------------------------------------------

/** Header the marketplace's server sends. Never sent from a browser. */
export const SECRET_HEADER = "x-gatekeeper-key"

export interface GuardConfig {
  /** Origins permitted to call from a browser. `["*"]` means unrestricted. */
  allowedOrigins: string[]
  /** Shared secret for server to server callers. Empty means none configured. */
  secret: string
}

export function readGuardConfig(env: Record<string, string | undefined>): GuardConfig {
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean)

  return {
    // An empty ALLOWED_ORIGINS string must not become an empty list, which would
    // reject every browser caller. Treat blank as unset.
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ["*"],
    secret: (env.GATEKEEPER_SECRET ?? "").trim(),
  }
}

export type GuardVerdict =
  | { allow: true; reason: "unconfigured" | "secret" | "origin" | "preflight" }
  | { allow: false; reason: "bad-secret" | "origin-not-allowed" | "no-origin" }

export interface GuardRequest {
  method: string
  origin: string | null
  referer: string | null
  secret: string | null
}

/**
 * The origin of a Referer, for callers that send one but not `Origin`.
 *
 * Same-origin and some older navigations omit `Origin`. Referer is weaker,
 * because it can be suppressed by a referrer policy, so it is a fallback rather
 * than the primary signal.
 */
function refererOrigin(referer: string | null): string | null {
  if (!referer) return null
  try {
    return new URL(referer).origin
  } catch {
    return null
  }
}

export function evaluate(request: GuardRequest, config: GuardConfig): GuardVerdict {
  // Preflight is never guarded. A browser sends OPTIONS before a cross-origin
  // POST and cannot attach anything to it, so rejecting it would break the real
  // request before it was ever evaluated. Nothing happens on an OPTIONS anyway.
  if (request.method === "OPTIONS") return { allow: true, reason: "preflight" }

  const unrestrictedOrigins = config.allowedOrigins.includes("*")
  if (unrestrictedOrigins && !config.secret) return { allow: true, reason: "unconfigured" }

  // 1. Server to server. Checked first, because these callers send no Origin and
  //    would otherwise fall through to the origin rules and be rejected.
  if (request.secret) {
    if (config.secret && request.secret === config.secret) return { allow: true, reason: "secret" }
    // A wrong key is a deliberate attempt, not a misconfiguration to fall back on.
    return { allow: false, reason: "bad-secret" }
  }

  // 2. Browser. `Origin` is set by the browser on every cross-origin request and
  //    page JavaScript cannot change it.
  const origin = request.origin ?? refererOrigin(request.referer)
  if (!origin) return { allow: false, reason: "no-origin" }

  const normalised = origin.replace(/\/+$/, "")
  if (unrestrictedOrigins || config.allowedOrigins.includes(normalised)) {
    return { allow: true, reason: "origin" }
  }

  return { allow: false, reason: "origin-not-allowed" }
}
