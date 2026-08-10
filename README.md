# Gatekeeper — all-in-one backend

Next.js (App Router) backend serving **two tools** from one deployment:

1. **Business Analyzer Tool (BAT)** — stateless lead gate; talks only to **GoHighLevel (GHL)**. No database.
2. **Credit Report Analyzer & Simulator** — phone-OTP gate → PDF upload → AI extraction → deterministic score simulator, backed by **Supabase** + **OpenRouter**, syncing results to **GHL**.

> ⚠️ **Don't break BAT.** BAT is stateless and imports none of the credit modules. All Credit Analyzer work is additive. See `CLAUDE.md`.

- **Live:** `https://gatekeeper-gold.vercel.app` (auto-deploys from `main` via Vercel)
- **Design/plan docs:** [`docs/`](./docs) — start with `docs/credit-analyzer-plan.md` and `docs/credit-analyzer-build-log.md` (running change history).

---

## Tech stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Hosting | Vercel |
| Package manager | **pnpm 9.15.9** (pinned via `packageManager`) |
| Database + file storage | Supabase (Postgres + Storage) |
| AI extraction | OpenRouter (`openai/gpt-5.6-luna`) |
| CRM, SMS, lead gate | GoHighLevel (LeadConnector API) |

---

## API routes (`app/api/**`)

**Business Analyzer (existing):**
| Route | Method | Purpose |
|---|---|---|
| `/api/submit` | POST | Create/check/tag a contact in one call |
| `/api/check-contact` | POST | Read-only gate check (has the used tag?) |
| `/api/mark-used` | POST | Apply the BAT used tag |

**Credit Analyzer:**
| Route | Method | Purpose |
|---|---|---|
| `/api/otp/request` | POST | Generate a code, save the lead, send the SMS via GHL |
| `/api/otp/verify` | POST | Verify the code → return a `verificationToken`; enforce the re-entry gate |
| `/api/consent` | POST | Record consent; requires the token when `OTP_REQUIRED=on` |
| `/api/upload-url` | POST | Mint a signed Supabase upload URL for the PDF |
| `/api/precheck` | POST | Zero-AI check: is this a credit report? + page count |
| `/api/analyze` | POST | AI extract → save → delete PDF → sync CRM fields + tag |
| `/api/status` | GET | Poll analysis status / fetch the result |
| `/api/simulate` | POST | Deterministic score projection for a what-if scenario |
| `/api/best-path` | POST | "Quickest path to target score" optimizer |

Every route also handles `OPTIONS` (CORS preflight). Full request/response shapes: [`docs/credit-analyzer-frontend-contract.md`](./docs/credit-analyzer-frontend-contract.md).

---

## Running locally

### Prerequisites
- **Node.js 20+** (Vercel runs 24.x)
- **pnpm 9.15.9** — the repo pins it via `packageManager`, so the easiest way is Corepack (bundled with Node):
  ```bash
  corepack enable
  corepack prepare pnpm@9.15.9 --activate
  ```
  > On this Windows dev box, `pnpm` may not be on PATH — prefix commands with `corepack pnpm ...`.

### 1. Install
```bash
pnpm install            # or: corepack pnpm install
```

### 2. Environment variables
Copy the template and fill in real values:
```bash
cp .env.example .env.local     # .env.local is gitignored
```
`.env.example` documents every variable. The **minimum to boot** without errors is the Supabase pair; the tools degrade gracefully otherwise (see below).

```bash
# Supabase (server-side only — the service key bypasses row security)
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role secret>

# GoHighLevel (shared by BAT + Credit Analyzer)
GHL_API_TOKEN=<private integration token>
GHL_LOCATION_ID=<location id>

# CORS — your GHL embed origin(s); "*" is fine for local
ALLOWED_ORIGINS=*
```

### 3. Run the dev server
```bash
pnpm dev                # http://localhost:3000
```

### 4. Test without spending money (recommended for local dev)
These flags let the whole flow run without OpenRouter charges or sending real SMS:

```bash
CREDIT_ANALYZE_MOCK=true    # /api/analyze returns realistic MOCK data (no AI cost)
OTP_BYPASS=on               # /api/otp/* skip real SMS; verify with the code below
OTP_BYPASS_CODE=000000      # the code accepted while bypass is on
OTP_REQUIRED=off            # /api/consent doesn't require a verified token yet
CREDIT_GATE_ENFORCED=false  # don't hard-block repeat runs while testing
```

**Quick smoke test** (mock + bypass on):
```bash
# 1) request a code (no SMS actually sent)
curl -s localhost:3000/api/otp/request -H 'content-type: application/json' \
  -d '{"phone":"8165551234"}'
# 2) verify with the bypass code -> returns a verificationToken
curl -s localhost:3000/api/otp/verify -H 'content-type: application/json' \
  -d '{"phone":"8165551234","code":"000000"}'
# 3) record consent -> returns { consentId }
curl -s localhost:3000/api/consent -H 'content-type: application/json' \
  -d '{"phone":"8165551234","consentVersion":"local-test"}'
```
For a full upload → analyze run, see the flow in `docs/credit-analyzer-frontend-contract.md`.

### 5. Type-check / build
```bash
# type-check (the sandbox lint-free way used in this repo):
node ./node_modules/typescript/bin/tsc --noEmit
pnpm build              # production build
pnpm lint               # eslint
```

---

## Supabase setup (for the Credit Analyzer)

Apply the migrations in [`supabase/migrations`](./supabase/migrations) (in order) to a fresh project:
- `0001_credit_analyzer_init.sql` — `consents`, `reports`, `rate_limits`, `report_analysis`, RLS (deny-all to anon), and the private `credit-reports` storage bucket.
- `0002_phone_verifications.sql` — OTP code store.

Apply via the Supabase SQL editor or CLI (`supabase db push`). Details: [`supabase/README.md`](./supabase/README.md).

---

## Environment variables reference

Full list with descriptions lives in [`.env.example`](./.env.example). Grouped summary:

- **Core:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GHL_API_TOKEN`, `GHL_LOCATION_ID`, `ALLOWED_ORIGINS`
- **AI:** `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `openai/gpt-5.6-luna`), `CREDIT_ANALYZE_MOCK`, `CREDIT_MOCK_PROFILE`
- **OTP:** `OTP_TOKEN_SECRET`, `OTP_BYPASS`, `OTP_BYPASS_CODE`, `OTP_REQUIRED`, `OTP_CODE_LENGTH`, `OTP_TTL_MINUTES`, `OTP_MAX_ATTEMPTS`, `OTP_SMS_FROM`, `OTP_RATE_LIMIT_*`, `OTP_GLOBAL_DAY`
- **Gate / CRM:** `CREDIT_GATE_ENFORCED`, `CREDIT_USED_TAG`, `CREDIT_LEAD_TAG`, `CREDIT_CRM_SYNC`, `CREDIT_CRM_SYNC_IN_MOCK`
- **Precheck:** `CREDIT_PRECHECK`, `CREDIT_MAX_PAGES`

> **Never** expose `SUPABASE_SERVICE_ROLE_KEY`, `GHL_API_TOKEN`, `OPENROUTER_API_KEY`, or `OTP_TOKEN_SECRET` to the browser (no `NEXT_PUBLIC_` prefix). They are server-side only.

### Required GHL token scopes
The GHL private-integration token needs: **Contacts** (view + write), **Custom Fields** (view — for CRM sync), and **Conversations** (`conversations/message.write` — for OTP SMS).

---

## Deploying
`main` auto-deploys to Vercel. After changing env vars in Vercel, **redeploy** for them to take effect. Keep `pnpm-lock.yaml` committed — the build uses `--frozen-lockfile`.

---

## Project layout
```
app/api/**        API routes (see table above)
lib/ghl.ts        GoHighLevel client (shared; BAT + Credit)
lib/supabase.ts   Supabase admin client
lib/credit*.ts    Credit Analyzer: extraction, simulator, precheck, mapping
lib/otp.ts        OTP: code gen/verify + GHL SMS send
supabase/         Migrations + setup notes
docs/             Plans, frontend contract, running build log
```
