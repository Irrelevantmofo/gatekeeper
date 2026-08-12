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
| **2** — Extraction | `/api/analyze` → OpenAI vision + Structured Outputs → persist → delete PDF → tag | ✅ **Validated** end-to-end (real OpenRouter/Luna); account_status fix confirmed |
| **3** — Simulator | deterministic `simulate()` engine + `/api/simulate` + `/api/best-path`, suggested-scenario curation | ✅ **Validated live** (1 tiny deltaRange display fix pending redeploy) |
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
| `OPENAI_API_KEY` | 🟡 optional now | Unset → `/api/analyze` uses **mock** extraction. Set to enable real Luna extraction. |
| `OPENAI_MODEL` | 🟡 optional | Defaults `gpt-5.6-luna` (plan §7.4) |
| `CREDIT_ANALYZE_MOCK` | 🟡 optional | Force mock even with a key set (default false) |
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

### 2026-08-06 — Research/decision: OpenAI model for extraction

**Goal:** pick the cheapest OpenAI model with good enough accuracy for tri-bureau PDF extraction.

**Findings (web research, verified Aug 2026 pricing):** GPT-5.6 family (Sol/Terra/Luna), all with vision + Structured Outputs + 1.05M context. Rates per 1M in/out: Sol $5/$30, **Terra $2/$12**, **Luna $0.20/$1.20** (cached input = 10%). Chunking a PDF across calls costs 3–7% accuracy; stable-prompt caching saves 40–60% on the input prefix.

**Decision:** default **`gpt-5.6-luna`** (cheapest vision tier), with **`gpt-5.6-terra` as the accuracy fallback**. Lower-risk because the LLM only extracts facts (deterministic engine does the math) + strict-schema validation + repair retry. **Requires a validation pass** (3–5 redacted reports, Luna vs Terra, checking per-bureau balance/limit alignment) before production. Model stays in `OPENAI_MODEL` env var → switch without a deploy. Rough cost ~$0.02/report (Luna) vs ~$0.20 (Terra).

**Changed:** plan §7.4 rewritten with verified pricing + recommendation; `.env.example` `OPENAI_MODEL` default → `gpt-5.6-luna`. (No code — OpenAI not wired until Phase 2.)

### 2026-08-06 — Phase 2: extraction (`/api/analyze` + `/api/status`)

**Goal:** turn an uploaded PDF into persisted structured facts and return the analysis — testable end-to-end **without** an OpenAI key.

**Changed (all additive):**
- **`lib/credit-extraction.ts`** (new) — `RawExtraction` types + the strict tri-bureau **JSON schema** (plan §17.2), stable **system prompt** (privacy: no SSN/DOB/address), `buildMockExtraction()` (mirrors the real Sternberg sample), and `toAnalysis()` mapping facts → the frontend §8 object (3 bureau scores, per-bureau utilization, `actionable` flag on individual/open/revolving accounts, summary). `suggestedScenarios` intentionally empty (Phase 3).
- **`lib/openai-extract.ts`** (new) — **isolated** OpenAI Responses API call via raw `fetch` (no SDK dep), strict Structured Output, `input_file` base64 PDF, one repair retry (§7.6). Clearly flagged to verify request/response field names when the key is wired.
- **`app/api/analyze/route.ts`** (new) — `POST { reportId }`: status→processing → download PDF → extract (**mock if no `OPENAI_API_KEY`**, else Luna) → upsert `report_analysis` → **delete PDF** + set `pdf_deleted_at`/status→analyzed → return `{ status, mock, analysis }`. `runtime=nodejs`, `maxDuration=60`. Used-tag deferred (prod only, when gate enforced) to avoid polluting test contacts.
- **`app/api/status/route.ts`** (new) — `GET ?reportId=` → `{ status }` / `{ status:"failed", error }` / `{ status:"analyzed", analysis }`.
- **`lib/credit.ts`** — added `getOpenAIModel()`, `useMockExtraction()`, `applyCreditUsedTag()` (reuses `ghl.ts` constants read-only).
- **`.env.example`** — `CREDIT_ANALYZE_MOCK`; **frontend contract §6** — marked analyze/status live in mock mode.

**Mock mode:** with no `OPENAI_API_KEY`, `/api/analyze` still downloads + **deletes** the PDF (exercises retention plumbing) and returns a realistic tri-bureau analysis (`mock:true`). Flips to real Luna extraction the instant the key is set — same response shape.

**Verified:** `tsc --noEmit` clean. BAT untouched (new code imports `ghl.ts` read-only). ⏳ **Live runtime test pending** — needs Supabase env vars + `next dev`; real OpenAI path unexercised until a key + the §7.4 validation pass.

**Open / follow-ups:**
- Validate real Luna extraction vs Terra on 3–5 redacted reports (plan §7.4) before production; confirm exact `gpt-5.6-luna` model id + Responses API field names in `lib/openai-extract.ts`.
- Gate re-check inside `/api/analyze` skipped (observe-only mode); revisit when `CREDIT_GATE_ENFORCED=true`.

**Next:** Phase 3 — deterministic `simulate()` engine + `/api/simulate`, and the suggested-scenario curation that fills `analysis.suggestedScenarios`.

### 2026-08-06 — Decision + adapter: OpenRouter as LLM provider (compliance deferred)

**Decision:** client chose **OpenRouter** ("as long as it's working"), explicitly **deprioritizing compliance for now**. Recorded as plan §16 locked decision + **open item 17 (REVISIT before real-PII launch)** — OpenRouter is a subprocessor needing DPA + ZDR + training opt-out + prompt-logging OFF + pinned provider, with legal sign-off. **Deferred debt, not resolved.** Use redacted/synthetic reports until then.

**Changed:**
- **`lib/llm-extract.ts`** (new, replaces `openai-extract.ts`) — provider dispatcher: OpenRouter (Chat Completions + `response_format` json_schema + `file` PDF part) or OpenAI (Responses API), selected by `LLM_PROVIDER`. Shared validate + repair-retry. Prominent compliance-deferred header comment.
- **`lib/credit.ts`** — `getLlmProvider()` (default `openrouter`), `getProviderApiKey()`, `getExtractionModel()` (namespaced id `openai/gpt-5.6-luna` for OpenRouter), `useMockExtraction()` now provider-aware.
- **`app/api/analyze/route.ts`** — uses the dispatcher; persists `model` as `"<provider>:<model>"`.
- **`.env.example`** — `LLM_PROVIDER`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`.

**Verified:** `tsc --noEmit` clean. Mock still default when no key. BAT untouched.

### 2026-08-06 — Live validation: real report through OpenRouter/Luna ✅ (+1 fix)

**First real end-to-end run** (report `813e89b8`): PDF (4.2 MB IdentityIQ) → OpenRouter `openai/gpt-5.6-luna` → 3 scores + **37 accounts** extracted → persisted → **PDF deleted** (pdf_deleted_at set) → status analyzed. **Cost ~$0.014**, ~37s. Confirms real provider path, retention delete, and cost estimate (§7.4).

**Accuracy (spot-check vs the actual report) — excellent:**
- Scores EXACT: TU 646 / EX 643 / EQ 639. Reason codes verbatim; correctly **empty for Equifax** (report had no Equifax factors).
- Balances/limits exact incl. the hard **per-bureau divergence** (Capital One TU 4440 vs EX/EQ 4218). Installment (ACHIEVEPL) handled (no credit limit).

**⚠️ Bug found — `status` field captured PAYMENT status, not ACCOUNT status.** Luna put "Current" (payment status) into `per_bureau.status` for both open AND closed accounts, so the open/closed distinction is lost. This breaks downstream `isOpen()` → `actionable`, `summary.openAccounts`, and `summary.revolvingUtilization` all read as closed/0. **Fix:** tighten the extraction prompt + schema to capture account status (open|closed|paid|transferred) distinctly from payment status (keep payment/delinquency separately). Re-run one report (~cents) to validate. Must land before Phase 3 (actionable accounts drive the simulator).

**Also:** orphan report `bc8d42c1` stuck at `awaiting_upload` with its 4.2 MB PDF still in the bucket (earlier attempt before analyze was deployed) — the class the Phase 4 sweep will handle.

**Fix applied** (`lib/credit-extraction.ts`): `per_bureau.status` → split into `account_status` (open/closed/paid/…) + `payment_status`; prompt made explicit; schema + mock + `toAnalysis` (isOpen/actionable/utilization/summary) updated; `tsc` clean. **Pending:** redeploy, then re-validate on a real report. Cleanest orphan cleanup = point the fixed `/api/analyze` at `bc8d42c1` (its PDF is still in the bucket) — that re-validates the fix AND deletes the PDF via the proper storage API in one shot. (Raw SQL delete of `storage.objects` would orphan the S3 blob — avoid for credit PII.)

### 2026-08-07 — Re-validation attempt: nullable-enum bug found & fixed

Deployed the first `status`-fix and ran `/api/analyze` on the orphan (`bc8d42c1`, PDF still in bucket).
- **Orphan cleanup: ✅** PDF read (prompt_tokens 46,771) then **deleted** — bucket now empty; report `analyzed`.
- **Extraction: ❌ empty** (completion_tokens 141; scores/accounts []). Root cause: I made `account_status` a **nullable enum** (`type:["string","null"]` + `null` inside `enum`), which corrupted the strict structured-output grammar → schema-valid-but-empty result. The working fields (`ownership`, `report_type`) are **non-nullable** enums.

**Re-fix (uncommitted, tsc clean):**
- `account_status` → non-nullable enum, `"unknown"` instead of null; prompt updated to match.
- `isValid()` hardened to require `scores.length > 0`, so an empty extraction triggers the repair retry and then fails loudly instead of persisting as a silent blank "analyzed".

**Pending:** redeploy, then **one fresh upload** to validate (orphan was consumed, so can't reuse it). Expect: 3 scores + full accounts, `account_status` reading open/closed (not "Current"), `report_type` 3B.

### 2026-08-07 — Phase 2 VALIDATED ✅ (account_status fix confirmed)

Re-fix deployed. Drove a full real run via curl (consent → upload-url → PUT local example PDF → analyze) against the live deployment (report `ae61a0d5`):
- `mock:false`, `reportType:3B`, scoreModel VantageScore 3.0, scores **TU 646 / EX 643 / EQ 639** (exact), **37 accounts**.
- **account_status now distinguishes** open 25 / closed 14 / paid 53 / transferred 3 (previously all "Current"). payment_status captured separately.
- **actionable = 3**: CBNA (71%), CITI (94%), CAPITAL ONE (99%) — the open, individual, revolving cards. AU CAP ONE correctly excluded.
- summary.openAccounts 8/9/8; PDF deleted by the pipeline (per prior verified runs; MCP was disconnected so not re-queried this run).

**Phase 2 done.** Remaining item (GHL used-tag) is intentionally deferred to production (gate enforcement).

**Minor follow-up for Phase 3:** Equifax revolving utilization came out >100% (1.11) because some Equifax entries report `credit_limit = 0` (the report's "amount in H/C column is credit limit" quirk). The simulator/util math should fall back to high-credit or exclude $0-limit revolving lines so utilization can't exceed 100%.

### 2026-08-07 — Phase 3: deterministic simulator + `/api/simulate` + suggested scenarios

**Goal:** turn the extracted facts into score projections and curated paydown suggestions — deterministic, instant, no LLM cost (plan §8, §14, §15).

**Research (web):** VantageScore 3.0 influence — payment history ~40%, age & type ~21%, utilization ~20%, balances ~11%, recent credit ~5%, available credit ~3%. Exact point deltas are proprietary → model is a **labeled estimate**, anchored on the user's real current score.

**Changed (all additive):**
- **`lib/credit-simulator.ts`** (new) — `VANTAGESCORE_3_WEIGHTS` (40/34/13/8/5, "amounts owed" cluster collapsed into utilization), piecewise health curves (util/payment/length/mix/inquiries), `revolvingUtilization()` (**$0-limit-safe** — fixes the EQ >100% bug), `simulate(input, scenario)` → per-bureau `{baseScore, estimatedScore, estimatedRange, waterfall}` with non-additive marginal waterfall + gain conservatism (0.85) + MAX_GAIN cap (120), `buildSuggestedScenarios()` (per-card + combined "pay all under 10%", ranked, capped), `buildAnalysis()` (toAnalysis + scenarios).
- **`app/api/simulate/route.ts`** (new) — `POST { reportId, scenario }` → loads facts → `simulate()`.
- **`app/api/best-path/route.ts`** + `buildBestPath()` (new, client request) — "Quickest Path to <target>": greedy points-per-dollar ordering of paydowns, stops at target, returns ordered `steps` + a runnable `scenario` (frontend auto-applies) + honest `note`/`reachable:false` when paydowns alone can't reach the target. Auto-picks next tier (660/700/740/780/800/850) if no target given.
- **`app/api/analyze` + `/api/status`** — now return `analysis.suggestedScenarios` populated (via `buildAnalysis`), capped by `RECOMMENDATIONS_MAX_N` (default 5).
- **`lib/credit-extraction.ts`** — `toAnalysis` revolving-utilization made $0-limit-safe.
- **Frontend contract §9** rewritten to the real `scenario` shape + §9.2 recommends updating the "How Your Score Is Calculated" panel to VantageScore weights (currently shows FICO).

**Hand-validated magnitudes** (Experian 643, 87% util): pay CITI→10% ≈ +49; pay all three →10% ≈ +108 (damped/capped); waterfall sums correctly and is non-additive. Assertive but defensible; `MAX_GAIN`/conservatism tunable.

**Verified:** `tsc --noEmit` clean. BAT untouched. ⏳ Deploy + end-to-end validation pending (curl `/api/analyze` for suggestedScenarios, `/api/simulate` for projections).

**Open / follow-ups:**
- Length-of-history factor uses frontend-provided `lengthYears` (we don't extract account-open dates yet); add `opened` to extraction later to derive it server-side.
- "Fastest Path to 850" button has no dedicated endpoint yet — frontend can call `/api/simulate` with an aggressive scenario, or add a helper later.
- `/api/delete` (contract §10) still Phase 4.

**Next:** deploy + validate Phase 3; then Phase 4 (cleanup cron, user delete, rate limiting) or wire the AI phrasing pass for scenarios.

### 2026-08-07 — Phase 3 validated live ✅ (+ deltaRange fix)

Deployed; drove all three endpoints via curl against prod (report `77836265`, real OpenRouter):
- **/api/analyze** — `suggestedScenarios` populated (4, capped 5, `engine+template`); "pay all under 10%" ranked #1, then per-card.
- **/api/simulate** — pay CBNA+CITI to 10% → TU 646→**721** / EX→717 / EQ→713; waterfall non-additive (CITI +49, CBNA +26 in-combination).
- **/api/best-path** — target 850 → `reachable:false`, projected **752**, honest note; target 700 → `reachable:true`, **stops early after 2 cards** ($7,106). Greedy points-per-dollar ordering works.

**Bug fixed** (`impactOf` in credit-simulator.ts): `deltaRange` was floored at 0 (`[0,110]`), making rationale read "roughly 0–110 points". Now `[min,max]` across bureaus (`[104,110]`). tsc clean. **Redeploy to pick up.**

### 2026-08-07 — Wrong-document pre-check (prevent AI token spend)

**Ask:** stop non-credit-report PDFs from burning extraction tokens (previously caught only *after* the call by `isValid` → repair retry, which doubled the spend on junk).

**Changed:**
- **Dep:** `unpdf@1.8.0` (serverless PDF.js text extraction).
- **`lib/credit-precheck.ts`** (new) — zero-AI sniff: extract text layer, require ≥3 distinct credit-report signals (bureau names, "credit score", "revolving", "credit limit", …) and ≤ `CREDIT_MAX_PAGES`. **Fail-open** on unparseable/image-only PDFs (don't block real users on a parser hiccup); **fail-closed** only when real text clearly isn't a credit report.
- **`app/api/analyze`** — reads bytes once, runs precheck BEFORE the OpenRouter call; on fail → delete PDF + status `failed` + **HTTP 422** `{reason:"not_a_credit_report"}`, no tokens spent.
- **`lib/credit.ts`** — `isPrecheckEnabled()` (off via `CREDIT_PRECHECK=off`), `getMaxPages()` (default 60).
- **`next.config.mjs`** — `serverExternalPackages: ["unpdf"]`. **`upload-url`** maxPages 15→60 (real reports exceed 15). `.env.example`, frontend contract §11 (422 row) updated.

**Verified:** `tsc` clean; overrides intact in lockfile. ⏳ Deploy + validate (upload a non-credit PDF → expect 422, no OpenRouter cost; real report still passes).

**Regression fixed (2026-08-07, found via Vercel logs):** live symptom — a CORRECT PDF returned the generic failure screen. Log: `[credit] analyze failed: Cannot perform Construct on a detached ArrayBuffer`. Cause: `unpdf`/pdf.js **detaches** the ArrayBuffer passed to it, so the pre-check left `bytes` detached and the subsequent `Buffer.from(bytes)` (extraction) threw. Not a frontend state issue. Fix: pre-check now parses a **copy** (`bytes.slice(0)`) so the caller's buffer stays intact. tsc clean; redeploy to apply.

### 2026-08-07 — `/api/precheck` (page count for loading screen + early wrong-doc gate)

**Ask:** show "Reading your N-page report…" during the (slow) analyze. Since analyze is synchronous, added a fast pre-flight endpoint.

**Changed:**
- **`app/api/precheck/route.ts`** (new) — `POST { reportId }` → downloads PDF, runs the zero-AI `unpdf` precheck → `{ ok:true, pages }` (200) or `{ ok:false, reason:"not_a_credit_report", message, pages }` (422, deletes PDF + marks failed). Returns page count even when precheck is disabled (only the rejection is gated by `CREDIT_PRECHECK`).
- Frontend contract §5.5 added (call after PUT, before analyze; loading copy uses `pages`).

**Flow now:** consent → upload-url → PUT → **precheck (get pages / reject wrong docs)** → analyze. analyze keeps its own precheck as a safety net (double parse of a good doc is ~sub-second vs the ~30–40s AI call). tsc clean. ⏳ deploy + validate.

### 2026-08-07 — `/api/analyze` latency reduction ✅ (51s → 35s live)

**Result:** confirmed **~35s** in production (was ~51s) — a 31% cut, from compact closed-account output + removing the redundant PDF parse (reasoning param left at default). No accuracy loss reported.


**Cause:** analyze time is dominated by LLM **output** generation — the sample report has **37 accounts** → ~5k output tokens, decoded serially. Input/download/DB are ~2–4s. Reasoning was already tiny (457 tok).

**Changes (accuracy-safe):**
1. **Compact closed accounts** (`credit-extraction.ts` prompt) — open accounts keep full per-bureau detail; accounts closed/paid/transferred on all bureaus emit ONE terse per_bureau entry (nulls). ~29 of 37 accounts shrink → big output-token cut. Simulator only uses open revolving + scores + reason codes, so no accuracy loss for what the tool computes; "Other Accounts" list still present.
2. **Reasoning effort → `low`** (`llm-extract.ts`, both providers; `LLM_REASONING_EFFORT` override).
3. **Removed the redundant PDF parse in `/api/analyze`** — the wrong-doc gate + page count now live solely in `/api/precheck` (frontend calls it first). Saves ~1–3s; `isValid` remains the empty-extraction backstop.

**Verified:** tsc clean. ⏳ Deploy + validate: re-time a real run and confirm output tokens dropped, open-account detail intact, closed accounts terse. If the compact-closed prompt ever regresses extraction, revert that one prompt line.

**504 REGRESSION (found via Vercel logs):** after deploying, `/api/analyze` returned **504 "Task timed out after 60 seconds"** (flow: consent✓ upload-url✓ precheck✓ → analyze 504 → simulate 404). Cause: `reasoning:{effort:"low"}` made GPT-5.6 reason MORE than its default (baseline had no param, 457 reasoning tok) → pushed past the 60s `maxDuration`. **Fix:** reasoning is now **opt-in/off by default** (set `LLM_REASONING_EFFORT=minimal` to experiment later, no redeploy); `maxDuration` raised 60→**300** (Vercel clamps to plan max, harmless if lower). Compact-output + no-double-parse retained. tsc clean; redeploy.

### 2026-08-07 — best-path: honest messaging for unreachable / low-score cases

`buildBestPath` only uses paydowns (time-based factors can't be "paid off"), so a target may be unreachable. Behavior: pays down all actionable cards, returns `reachable:false` + `projectedScore` = realistic max + a `note` explaining the gap needs time. Tightened the `note` to cover three cases cleanly: already-at-target (steps=0, reachable), too-low-with-no-payable-balances (steps=0, not reachable), and paid-everything-still-short (steps>0). Never fabricates hitting the target. tsc clean.

### 2026-08-07 — Mock profile switch (`CREDIT_MOCK_PROFILE=low`)

Added a low-score mock profile for testing the unreachable-target UI. `CREDIT_MOCK_PROFILE=low` → scores ~548/543/539 (Poor) with the same near-maxed cards, so best-path (target 700) pays down all cards but lands ~650 → `reachable:false` + steps + honest note. Unset/"standard" keeps the ~640s Fair profile (reaches 700). Mock-mode only. tsc clean.

### 2026-08-08 — Phone-OTP access gate via Telnyx Verify (+ dev bypass)

Client chose **Telnyx Verify** for phone verification (purpose-built OTP; cheaper/higher-throughput than GHL's Twilio SMS) with **GHL** as CRM/follow-up. Telnyx manages codes → **no Supabase OTP table needed**. Plan: `docs/otp-access-plan.md`.

**Built (all additive):**
- **`lib/otp.ts`** — config, US-phone normalize, isolated Telnyx Verify calls (`telnyxSendCode`/`telnyxCheckCode`, verify against docs), HMAC-signed stateless `verificationToken` (sign/verify), coarse rate limiter (reuses `rate_limits` table), and **dev bypass**.
- **`app/api/otp/request`** — upsert GHL contact (lead capture, best-effort) → rate-limit (per-phone/IP/global) → send code via Telnyx, or skip in bypass.
- **`app/api/otp/verify`** — check code (Telnyx, or fixed `OTP_BYPASS_CODE` in bypass) → re-entry block (credit-analyzer-used tag, when `CREDIT_GATE_ENFORCED`) → issue `verificationToken`.
- **`/api/consent`** — requires a valid `verificationToken` **only when `OTP_REQUIRED=on`** (off by default → current flow unaffected).
- `.env.example` — Telnyx + OTP vars.

**Dev bypass:** `OTP_BYPASS=on` + `OTP_REQUIRED=off` → full phone→code→unlock flow with code `000000`, no US number, no Telnyx, no SMS cost.

**Verified:** `tsc` clean; BAT untouched. ⏳ Deploy + validate (bypass path via curl; real Telnyx once `TELNYX_*` set + 10DLC/toll-free registered).

### 2026-08-08 — Scope decision (client transcript): simulator = paydowns only; deletions → booking

Client (Sam Sky) confirmed the simulator does **not** model **deletions** (collections/negative items removed vs. paid) — only paydowns. Deletions are intentionally **out of scope for the tool** and routed to the strategist call. Frontend copy:
- **Low-score asterisk:** if scores are too low the calc can't reach 700; state the ~120-point paydown cap (uses existing `best-path` `reachable:false` + `note`).
- **Booking-CTA asterisk:** invite deletion questions — "…especially about getting accounts deleted and how much that could raise your score — book here."
- ⚠️ **CROA flag:** "getting accounts deleted" positions the call as credit-repair; keep the vendor from *promising* deletions in copy (compliance deferred, but flagged). No backend change — deletion modeling deliberately not built.

### 2026-08-08 — CRM sync: analysis fields → GHL contact (safe, no-blanks)

Implements `docs/crm-capture-plan.md`: on a **real** analysis, push scores/utilization/risk/simulator fields to the GHL contact (custom fields) + name to native First/Last + the `credit-analyzer-used` tag.

**Built (additive):**
- **Extraction:** added nullable `consumer_first_name` / `consumer_last_name` to the schema + prompt + mock (name is the ONLY PII extracted; SSN/DOB/address/employers still excluded). Nullable *plain strings* (safe pattern — not the enum that broke before).
- **`lib/crm-mapping.ts`** (new) — `buildCrmPayload(raw, bestPath)` → `{ standard:{firstName,lastName}, custom:{...} }`. **Only valid values included** — a `put()` helper drops null/NaN/empty/whitespace, so no blank/garbage field is ever sent (no overwriting good CRM data). Derives middle score, band, funding tier, utilization/balances/counts (on the representative bureau), risk counts, and maps simulator outcomes from `buildBestPath(…, 700)`.
- **`/api/analyze`** — after `buildAnalysis`, if **`!mock` && `CREDIT_CRM_SYNC!=off` && GHL configured && contact_ref**: resolve custom fields (`resolveContactCustomFields`) → `upsertContact` (standard + custom) → `applyCreditUsedTag`. **Best-effort try/catch — a GHL failure never fails the analysis.**
- `lib/credit.ts` `isCrmSyncEnabled()`; `.env.example` `CREDIT_CRM_SYNC=on`.

**Safety:** mock mode writes NOTHING to GHL by default (no CRM pollution during frontend testing). If the GHL custom fields don't exist yet, `resolveContactCustomFields` just leaves them unresolved (logged) — no crash; they populate once created. **Test override:** `CREDIT_CRM_SYNC_IN_MOCK=on` lets mock runs push the mock/Sternberg data to GHL to test the mapping without a real analysis (off in production). Requires `reports.contact_ref` (set via `/api/consent`).

**Verified:** `tsc` clean; BAT untouched. ⏳ Needs: create the custom fields in GHL, then a **real** analysis re-validation run (confirm the new name fields extract cleanly AND scores/accounts still come back full — schema changed).

### 2026-08-10 — Fix: CRM fields not landing (phone-format mismatch) + name null

**Symptom:** GHL contact had only the phone — no name, tags, or custom fields. Logs showed no `CRM sync failed` (block didn't throw); DB showed real analysis (`openrouter:…`, 3 scores) + `contact_ref` set. So the block ran but wrote to the wrong contact.

**Root cause:** phone format inconsistency. `/api/otp/request` created the contact as **E.164 `+18163804331`**, but `consent` stored `contact_ref` as **10-digit `8163804331`**, so `/api/analyze`'s upsert didn't match the E.164 contact → name/tag/fields went to a **duplicate**, not the visible contact.

**Fixes:**
- Normalize phone to **E.164 everywhere**: `consent` now stores `contact_ref` via `normalizeUsPhone`; `/api/analyze` normalizes `contact_ref`→E.164 before upserting. All upserts now hit ONE contact.
- Strengthened the name-extraction prompt (model returned `null` on a report that clearly has a name).
- Added `[credit] CRM sync ok: contact=… fields=N unresolved=…` log so we can see exactly which custom fields mapped (and which GHL fields are missing/mis-named).

**Verified:** `tsc` clean. ⏳ Redeploy + re-test; delete the old/duplicate test contacts in GHL first to avoid confusion.

### 2026-08-10 — Root cause: GHL token missing custom-fields scope (401)

Log revealed it: `CRM sync failed: GHL get custom fields failed (401) "The token is not authorized for this scope."` — mapping custom fields calls `GET /locations/{id}/customFields`, which the GHL token lacks scope for. That call is FIRST in the CRM block, so it threw before the contact upsert + tag → name AND tag missing too (not just custom fields). (Contact upsert/tags use `contacts.write`, which the token has — hence phone captured, BAT fine.)

**Fixes:**
- **Code:** custom-field resolution is now **best-effort** (its own try/catch) — a missing scope no longer aborts the block, so **name + tag write regardless**; custom fields populate once the scope is added.
- **Config (user):** add the **"View Custom Fields"** scope (`locations/customFields.readonly`) to the GHL private-integration token, then update `GHL_API_TOKEN` in Vercel.

**Verified:** `tsc` clean. After redeploy + scope, the `[credit] CRM sync ok: contact=… fields=N unresolved=…` log confirms how many fields mapped (unresolved = not-yet-created / mis-named GHL fields).

### 2026-08-11 — OTP pivot: backend-owned codes, sent via GHL SMS (Telnyx retired)

Client has A2P 10DLC on GHL → deliver OTP through **GHL Conversations API** instead of Telnyx, but keep verification **backend-owned** (our token gate + rate limits).

**Built:**
- **Migration `0002_phone_verifications`** — `phone_verifications` table (hashed code, expiry, attempts, verified_at), RLS deny-all. Applied via MCP.
- **`lib/otp.ts`** rewritten — `generateCode`/`hashCode` (HMAC-peppered with `OTP_TOKEN_SECRET`), `createAndStoreCode` + `checkStoredCode` (expiry/attempts), and **`sendGhlSms`** = `POST {GHL}/conversations/messages {type:"SMS",contactId,message,fromNumber?}` (isolated; verify endpoint/version vs docs). Telnyx functions removed.
- **`/api/otp/request`** — upsert contact (need `contactId` to address SMS) → store code → GHL SMS. **`/api/otp/verify`** — `checkStoredCode` (or bypass) → re-entry gate → `verificationToken`.
- `.env.example` — new `OTP_CODE_LENGTH`/`OTP_TTL_MINUTES`/`OTP_MAX_ATTEMPTS`/`OTP_SMS_FROM`; Telnyx retired.

**⚠️ Requires GHL token scope `conversations/message.write`** (add it, like the custom-fields scope earlier). **Verified:** `tsc` clean; BAT untouched. ⏳ Add the scope + redeploy; test send (a US number to receive, or read outbound in GHL Conversations). Dev bypass unaffected.

### 2026-08-11 — Lead tag for GHL Conversation-View segmentation

To keep OTP SMS out of the main inbox: apply a distinct **`credit-simulator`** tag (env `CREDIT_LEAD_TAG`) to the contact at `/api/otp/request` (both bypass + real paths), so all credit-tool threads can be filtered into their own GHL **Conversation View**. `lib/credit.ts` refactored to a generic `addContactTag()` with `applyCreditUsedTag`/`applyCreditLeadTag` wrappers. Best-effort — never blocks the OTP send. `.env.example` updated. tsc clean.

### 2026-08-11 — OTP send: surface GHL "DND active" distinctly

"We couldn't send your code" on a repeat number was **GHL DND**: `400 CONVERSATIONS_MSG_DND_ACTIVE_SMS` — the contact has SMS Do-Not-Disturb on (opted out / STOP). Confirms the `conversations/message.write` scope now works (request reached GHL). `sendGhlSms` now returns a `code:"dnd"`, and `/api/otp/request` returns **`409 { status:"sms_opted_out" }`** with a clear message instead of the generic 502, so the frontend can guide the user. **⚠️ Product note:** using GHL SMS for OTP means any DND/opted-out number can't receive a code → locked out of the tool (a dedicated verify service wouldn't have this). Immediate fix for testing: clear DND on the contact in GHL. tsc clean.

### 2026-08-12 — Results-email opt-in: `/api/report-email` + `credit_actions_html` (feedback loop)

**Goal:** capture the user's email via a results-popup on the simulator screen and trigger a GHL automation that emails their analysis + recommended actions + feedback questions ("rate 1–5, reply"). Plan: [`docs/feedback-loop-plan.md`](./feedback-loop-plan.md). Design locked with client: **single email**, GHL-workflow-driven (tag trigger), reply-only sentiment capture, booking/YouTube follow-up deferred.

**Built (all additive; BAT untouched):**
- **`app/api/report-email/route.ts`** (new) — `POST { reportId, email }`: validates email, loads the report's `contact_ref`, **upserts the email onto the existing GHL contact** (matches by E.164 phone so no duplicate — mirrors the `/api/analyze` upsert), then applies the **`credit-results-optin`** tag which TRIGGERS the GHL email automation. Thin trigger: all email content/timing/sending lives in GHL. **Mock-safe** (skips GHL in mock mode unless `CREDIT_CRM_SYNC_IN_MOCK=on`). **Data minimization:** the email is NOT persisted in Supabase (GHL is the system of record).
- **`lib/credit.ts`** — `getCreditResultsOptinTag()` (env `CREDIT_RESULTS_OPTIN_TAG`, default `credit-results-optin`) + `applyCreditResultsOptinTag()` wrapper (reuses the generic `addContactTag`).
- **`lib/crm-mapping.ts`** — `buildActionsHtml(raw, bestPath)` renders a lean, inline-styled HTML block (3-bureau scores, top reason codes, fastest-path steps, cash needed, projected score) into the **`credit_actions_html`** custom field (registered in GHL by the user); the results email merges it. Handles empty-steps / low-score fallback and HTML-escapes creditor names + reason codes.

**Trigger design:** deliberately a NEW tag (`credit-results-optin`), not the existing `credit-analyzer-used` — the used-tag is applied back at `/api/analyze` *before* an email exists, so it can't guarantee a send destination. The opt-in tag is applied only after the email is on the contact.

**Verified:** `tsc --noEmit` clean. BAT files (`lib/ghl.ts`, `app/api/{submit,check-contact,mark-used}`) untouched.

**Open / follow-ups:**
- Add `CREDIT_RESULTS_OPTIN_TAG` to `.env.example`.
- **GHL config (user):** build the workflow (trigger = tag `credit-results-optin` → the single results+feedback email), and confirm the `credit_actions_html` field key slugifies to `credit_actions_html`. **Deliverability pre-flight** (SPF/DKIM/DMARC + monitored from/reply-to) is required since mail currently spams — see plan §6.
- **Frontend:** build the results-email popup (prompt handed to the GHL Frontend AI) — 30s-after-value timing, email field, spam disclaimer, `POST /api/report-email`.
- Live validation: real analysis → popup → submit → contact gets email + `credit-results-optin` → workflow email lands (test Gmail + Outlook) → reply shows in Conversations.

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
