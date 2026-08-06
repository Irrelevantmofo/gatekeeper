# Supabase — Credit Analyzer backend

This directory holds the database schema for the **Credit Analyzer** tool. The
**Business Analyzer Tool (BAT)** is stateless (GoHighLevel only) and uses none
of this.

- `migrations/0001_credit_analyzer_init.sql` — tables (`consents`, `reports`,
  `rate_limits`, `report_analysis`), RLS (deny-all to anon; service-role only),
  and the private `credit-reports` Storage bucket.

Plan reference: [`../docs/credit-analyzer-plan.md`](../docs/credit-analyzer-plan.md) §6.

## Applying the migration

**Option A — Supabase SQL Editor (quickest for first setup)**
1. Open your project → **SQL Editor**.
2. Paste the contents of `migrations/0001_credit_analyzer_init.sql` and run it.
   It's idempotent, so re-running is safe.

**Option B — Supabase CLI (repeatable / CI)**
```bash
# one-time: link the local repo to your project
supabase link --project-ref <your-project-ref>

# push all migrations in supabase/migrations
supabase db push
```

## After applying — verify

- **Tables:** `consents`, `reports`, `rate_limits`, `report_analysis` exist in
  `public`, each with **RLS enabled** and **no** anon/authenticated policies.
- **Bucket:** Storage → `credit-reports` exists, **not public**, PDF-only,
  10 MB limit.

## Environment

Set these (see [`../.env.example`](../.env.example)) in `.env.local` and Vercel:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role secret>
```

The **service-role key** bypasses RLS and has full access — server-side only,
never shipped to the browser (`lib/supabase.ts`).

## Not included yet (later phases)

- **pg_cron** orphan-PDF sweep (plan §4 step 9 / §9.4) — added with the
  `/api/cleanup` job in Phase 4.
- Any **extraction-retention purge** — pending the retention window decision
  (plan §16 open item).
