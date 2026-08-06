# Credit Analyzer — Build Log

> **What this is:** the running record of what's actually been built for the Credit Analyzer, phase by phase. Every time a phase (or a meaningful chunk of one) is finished, it gets logged here with what changed, how it was verified, and anything left open.
>
> **How to use it:** this is the *"what we did"* doc. The *"what we're building"* docs are:
> - [`credit-analyzer-plan.md`](./credit-analyzer-plan.md) — backend architecture & decisions (phases defined in §12)
> - [`credit-analyzer-frontend-contract.md`](./credit-analyzer-frontend-contract.md) — the API shape the GHL frontend codes against
>
> **Repo context:** `gatekeeper/` is the **all-in-one backend** for two tools — the **Business Analyzer Tool (BAT)** (existing, stateless, GoHighLevel only) and the **Credit Analyzer** (new, Supabase-backed). BAT must never break; all Credit Analyzer work is additive.

---

## Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| **0** — Accounts & agreements | OpenAI account/billing, ZDR/DPA, Supabase project, legal review of consent copy | ⏳ In progress (Supabase project live) |
| **1** — Consent + gate + storage path | Supabase schema/bucket, `lib/supabase.ts`, `/api/consent`, `/api/upload-url` | 🟡 Foundation + routes built (typecheck clean); live test pending env vars |
| **2** — Extraction | `/api/analyze` → OpenAI vision + Structured Outputs → persist → delete PDF → tag | ⬜ Not started |
| **3** — Simulator | deterministic `simulate()` engine + `/api/simulate`, suggested-scenario curation | ⬜ Not started |
| **4** — Retention & rights | `/api/cleanup` cron, user-initiated delete, IP/global rate limiting, log scrubbing | ⬜ Not started |
| **5** — Hardening/scale | async analysis (queue + poll/Realtime), cost dashboards, SSN/account masking | ⬜ Not started |

Legend: ⬜ not started · 🟡 partially done · ✅ complete · ⏳ external/waiting

---

## Environment (current)

Set in `.env.local` (local) and Vercel (prod). Full reference: [`../.env.example`](../.env.example).

| Var | Status | Notes |
|-----|--------|-------|
| `GHL_API_TOKEN`, `GHL_LOCATION_ID` | ✅ existing (BAT) | Reused by Credit Analyzer gate |
| `ALLOWED_ORIGINS` | ✅ existing | Shared CORS allowlist |
| `SUPABASE_URL` | 🟡 needs setting | `https://helfrkwusmvqfbekysle.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | 🟡 needs setting | Project Settings → API → `service_role` secret. **Server-side only.** |
| `CREDIT_GATE_ENFORCED` | 🟡 optional | **Defaults `false`** (gate observe-only, no lockout) — set `true` for production |
| `CREDIT_USED_TAG` | 🟡 optional | Defaults `credit-analyzer-used`; read by `/api/consent` gate |
| `SWEEP_TTL_MINUTES` | 🟡 optional | Defaults 60; used by `/api/upload-url` to set `sweep_after` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | ⬜ later (Phase 2) | Not wired yet |
| `RATE_LIMIT_PER_IP_DAY`, `RATE_LIMIT_GLOBAL_DAY` | ⬜ later (Phase 4) | Not wired yet |

---

## Log

### 2026-08-06 — Phase 1 foundation: Supabase backend (storage + DB)

**Goal:** stand up the persistence layer for the Credit Analyzer without touching BAT.

**Changed (all additive):**
- **Dependency:** added `@supabase/supabase-js@2.112.1` (`package.json` + `pnpm-lock.yaml` updated together).
- **`lib/supabase.ts`** — service-role admin client, **server-side only**. Guarded with `getSupabaseConfig()` returning `null` when env is missing (mirrors `getGHLConfig()` in `lib/ghl.ts`). Client cached in module scope. Exports `CREDIT_REPORTS_BUCKET` / `CREDIT_REPORTS_TMP_PREFIX`.
- **`supabase/migrations/0001_credit_analyzer_init.sql`** — schema per plan §6.2/§14.5/§17:
  - Tables: `consents`, `reports` (status CHECK + lifecycle/retention columns + 3 indexes), `rate_limits`, `report_analysis` (with `recommendations` jsonb; FK **ON DELETE CASCADE**).
  - **RLS enabled on all four tables, no anon/authenticated policies** → deny-all to the browser; service-role backend bypasses (plan §6.3).
  - Private **`credit-reports`** Storage bucket: `public=false`, `application/pdf` only, 10 MB limit.
- **`.env.example`** — all-in-one env reference (BAT + Credit Analyzer, marked by phase).
- **`supabase/README.md`** — how to apply/verify the migration.

**Applied to the live project** (ref `helfrkwusmvqfbekysle`) via Supabase MCP `apply_migration`. Repo migration file matches what's live.

**Verified:**
- `list_tables` — all four tables present with expected columns, PKs, FKs, the status CHECK constraint, and `rls_enabled: true` on each.
- Storage — `credit-reports` bucket confirmed `public=false`, PDF-only, 10 MB.
- **Security advisors** — only **4× `rls_enabled_no_policy` (INFO)**, one per table. This is the intended deny-all posture, **not** a problem; no `WARN`/`ERROR` findings.
- **TypeScript** — `tsc --noEmit` passes clean; BAT files (`lib/ghl.ts`, `app/api/{submit,check-contact,mark-used}`) untouched.

**BAT safety:** BAT is stateless and imports none of the new modules — confirmed no changes to its routes or `lib/ghl.ts`.

**Open / follow-ups:**
- Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` and Vercel.
- `pg_cron` (1.6.4) and `pgmq` are available on the project for the Phase 4 sweep / Phase 5 async queue; **Vault** installed for optional envelope encryption (§9.5).
- Tooling note: `pnpm` isn't on PATH here — use `corepack pnpm`; run tsc via `node ./node_modules/typescript/bin/tsc`.

**Next:** `/api/consent` (gate via `lib/ghl.ts` + consent record) and `/api/upload-url` (signed upload URL via `lib/supabase.ts`), built to the frontend contract. Blocked-ish on the **identity-source decision** (plan §4.2): build for the "GHL knows the contact" path, leave the public fallback as a TODO.

### 2026-08-06 — Phase 1 routes: `/api/consent` + `/api/upload-url`

**Goal:** the pre-analysis flow — record consent + run the (non-blocking) gate, then mint a direct-to-Supabase signed upload URL. Built so the gate **does not block** repeated testing (per request).

**Changed (all additive):**
- **`lib/credit.ts`** (new) — credit-only helpers, kept out of `lib/ghl.ts` so BAT is untouched: `getCreditUsedTag()`, `isGateEnforced()`, `getSweepTtlMinutes()`, `parseClientIp()`, and the `REPORT_STATUS` map.
- **`app/api/consent/route.ts`** (new) — `POST` records a consent row (versioned, IP/UA) and returns `{ consentId, gate }`. Gate is **observe-only by default**: it reports `gate.wouldClose` but only returns `gate_closed` when `CREDIT_GATE_ENFORCED=true`. GHL lookup is best-effort (a GHL hiccup never blocks consent). Reuses `searchContact`/`corsHeaders` from `lib/ghl.ts` (read-only).
- **`app/api/upload-url/route.ts`** (new) — `POST { consentId }` verifies the consent, inserts a `reports` row (`awaiting_upload`), mints `createSignedUploadUrl('tmp/{id}.pdf', { upsert:true })`, stores `storage_path` + `sweep_after`, returns `{ reportId, uploadUrl, token, storagePath, expiresAt, constraints }`.
- **`.env.example`** — added `CREDIT_GATE_ENFORCED=false` (documented as the testing toggle).
- **`credit-analyzer-frontend-contract.md`** §3 — response now includes the `gate` object + a "testing mode: gate off" note.

**Testing behavior (as requested):** with `CREDIT_GATE_ENFORCED` unset/false, the same contact can run consent → upload-url repeatedly without lockout. `gate.wouldClose` still surfaces whether the credit tag is present, so gate logic is observable without being enforced. Flip to `true` for production.

**Verified:**
- **TypeScript** — `tsc --noEmit` passes clean.
- BAT routes + `lib/ghl.ts` untouched (new code imports `ghl.ts` read-only; no edits to it).
- ⏳ **Live runtime test pending** — needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`, then `next dev`. Not yet exercised against the running DB.

**Open / follow-ups:**
- Set the two Supabase env vars locally to run the end-to-end test (consent → upload-url → PUT a PDF → confirm object lands in `credit-reports/tmp/`).
- `/api/consent` does **not** create/tag the GHL contact (by design — tagging happens at `/api/analyze` step 7, Phase 2). It only reads tags for the gate.
- Identity-source decision (plan §4.2) still open: routes accept email/phone/contactId from the caller; public-fallback not built.

**Next:** Phase 2 — `/api/analyze` (download PDF → OpenAI vision + Structured Outputs against the §17 tri-bureau schema → persist `report_analysis` → delete PDF → apply credit used-tag).

### 2026-08-06 — Fix: Vercel `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`

**Symptom:** Vercel build failed at `pnpm install` — *"the current 'overrides' configuration doesn't match the value found in the lockfile."*

**Cause:** the earlier `corepack pnpm add @supabase/supabase-js` pulled **pnpm 11**, which ignores `package.json`'s `pnpm.overrides` (the `hono: 4.12.25` pin) and rewrote `pnpm-lock.yaml` **without** the top-level `overrides:` block. Vercel runs pnpm 9 (reads `pnpm.overrides`), so package.json and the lockfile disagreed → frozen install refused.

**Fix:**
- Pinned **`"packageManager": "pnpm@9.15.9"`** in `package.json` so corepack + Vercel use the same pnpm that honors `pnpm.overrides` (prevents recurrence).
- Regenerated the lockfile with pnpm 9.15.9 (fresh `install`) — the `overrides:\n  hono: 4.12.25` block is back at the top.

**Verified:** `pnpm install --frozen-lockfile` (what Vercel runs) passes; `tsc --noEmit` clean. Only `package.json` + `pnpm-lock.yaml` changed.

**Action to deploy:** commit `package.json` + `pnpm-lock.yaml` and redeploy.

---

<!-- TEMPLATE for future entries — copy below when a phase/chunk completes.

### YYYY-MM-DD — Phase N: <short title>

**Goal:** <what this chunk set out to do>

**Changed:**
- <files/endpoints added or modified>

**Verified:**
- <tests / typecheck / advisors / manual checks and their results>

**BAT safety:** <confirmation BAT is untouched, if relevant>

**Open / follow-ups:**
- <anything deferred>

**Next:** <the following chunk>

-->
