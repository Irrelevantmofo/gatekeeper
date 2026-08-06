import { createClient, type SupabaseClient } from "@supabase/supabase-js"

// ─────────────────────────────────────────────────────────────────────────────
// Supabase access for the CREDIT ANALYZER tool only.
//
// The Business Analyzer Tool (BAT) is stateless and never touches Supabase — it
// only calls GoHighLevel via lib/ghl.ts. Nothing here is imported by the BAT
// routes, so this file cannot affect them.
//
// SERVER-SIDE ONLY. This uses the service-role key, which bypasses Row Level
// Security and has full read/write access. It must NEVER be imported into a
// client component or shipped to the browser (see plan §6.3 / §9.5). Next.js
// route handlers under app/api/** run only on the server, which is where this
// belongs.
// ─────────────────────────────────────────────────────────────────────────────

// The private Storage bucket holding transient credit-report PDFs (plan §6.1).
export const CREDIT_REPORTS_BUCKET = "credit-reports"

// Transient uploads land under this prefix and are deleted right after
// extraction (plan §4 step 6) or swept if orphaned (plan §4 step 9).
export const CREDIT_REPORTS_TMP_PREFIX = "tmp"

// Returns the Supabase credentials, or null if either is missing. Mirrors
// getGHLConfig() in lib/ghl.ts so callers can fail soft with a clear 500 rather
// than throwing on a cold config.
export function getSupabaseConfig(): { url: string; serviceRoleKey: string } | null {
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) return null
  return { url, serviceRoleKey }
}

// Cache the admin client in module scope so warm invocations reuse one instance
// instead of constructing a new client (and connection pool) per request.
let adminClient: SupabaseClient | null = null

// Returns the service-role Supabase client, or null if config is missing.
// The credit-analyzer routes are the trust boundary: the browser never queries
// Supabase directly — it only PUTs a PDF to a scoped signed upload URL that we
// mint here server-side.
export function getSupabaseAdmin(): SupabaseClient | null {
  if (adminClient) return adminClient

  const config = getSupabaseConfig()
  if (!config) return null

  adminClient = createClient(config.url, config.serviceRoleKey, {
    auth: {
      // No user sessions here — this is a machine-to-machine service client.
      persistSession: false,
      autoRefreshToken: false,
    },
  })
  return adminClient
}
