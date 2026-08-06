# Credit Report Analyzer & Score Simulator — Backend Architecture Plan

> **Status:** Draft / planning. Focused on the **backend serverless** layer (Vercel + Supabase + OpenAI), since that is what we can build first. Frontend (GHL AI Studio) is treated as a thin client that calls these APIs.
>
> **Scope assumption:** US-based consumers uploading **their own** credit report for a self-service analysis, in the context of our small-business funding offering. This assumption drives the legal section — if we ever pull reports on someone else's behalf, the compliance picture changes completely (see §9).
>
> ⚠️ **This document is engineering planning, not legal advice.** Handling consumer credit reports carries real federal + state legal weight (FCRA, FTC Disposal Rule, GLBA, state privacy law). Before launch, have a **compliance attorney** review the consent flow, retention policy, and vendor agreements. Nothing here substitutes for that review.

---

## 0. TL;DR — the two things that will bite us if ignored

1. **ChatGPT Plus ≠ API access.** The $20/mo ChatGPT Plus subscription is the consumer web app only. It grants **no** programmatic access, and its billing is completely separate from the API. To call GPT from a serverless function we need a **separate OpenAI Platform account** (platform.openai.com) with **pay-as-you-go API billing** and an **API key**. Budget this as a real, usage-based cost line. ([OpenAI: ChatGPT vs API billing](https://help.openai.com/), [analysis](https://folding-sky.com/blog/why-use-api-keys-not-chatgpt))
2. **Don't let the LLM do the score math.** LLMs are inconsistent at arithmetic and non-auditable. Use the LLM **only to extract structured facts** from the PDF (balances, limits, accounts, inquiries, derogatories, current score). Run the **simulator in deterministic TypeScript** so results are consistent, explainable, testable, and cheap. See §8.

---

## 1. Goals & functional requirements

| # | Requirement | Where handled |
|---|-------------|---------------|
| 0 | Deter repeat/abusive use (public tool) | GHL contact gate (`credit-analyzer-used` tag) + IP rate limit — §4.1 |
| 1 | User uploads a credit report PDF | Direct browser → Supabase Storage (signed upload URL) |
| 2 | PDF parsed & analyzed by AI | Vercel function → OpenAI API (file input + Structured Outputs) |
| 3 | PDF stored in a cloud bucket | **Transient only** — extract, then delete the PDF. Persist only the structured extraction (§6.1). Changeable per client. |
| 4 | UI shows a score simulator from the AI analysis | Vercel returns structured JSON; frontend renders |
| 5 | Simulator shows how to raise the score | Deterministic simulation engine (code, not AI) |
| — | Store reports **legally** | §9 Legal & Compliance |
| — | Use the OpenAI API **correctly** | §7 OpenAI integration |

> **Decisions locked (from planning):** public tool, **US-only** at launch (FCRA/FTC/GLBA/state law scope; no GDPR). Persist **only the structured extraction**, not the raw PDF — the PDF is transient and deleted right after extraction (revisit per client need). Abuse deterrence via the **existing GHL gatekeeper pattern** already in this repo.

---

## 2. Tech stack & responsibilities

| Layer | Tool | Responsibility |
|-------|------|----------------|
| Frontend / deploy | **GHL AI Studio** | Upload UI, simulator UI. Thin client; holds **no secrets**. Calls Vercel APIs (CORS-enabled, like the existing gatekeeper). |
| Backend | **Vercel serverless functions** | Signed-upload minting, orchestration of AI analysis, simulation engine, retention/cleanup jobs. Holds all secrets. |
| Storage + DB | **Supabase** | Private Storage bucket for PDFs; Postgres for analysis JSON, consent records, job status; RLS; scheduled deletion (pg_cron). |
| AI | **OpenAI Platform API** (NOT ChatGPT Plus) | Extract structured data from the PDF. Ideally under a **ZDR + DPA** agreement (§7.4). |

---

## 3. High-level architecture

```
                    ┌──────────────────────────┐
                    │  GHL AI Studio frontend   │
                    │  (upload + simulator UI)  │
                    └─────────────┬────────────┘
             1. request upload URL │  4. poll status / fetch analysis
                                   ▼
      ┌───────────────────────────────────────────────────┐
      │                Vercel serverless API               │
      │  /upload-url   /analyze   /status   /simulate      │
      │  /cleanup (cron)                                    │
      └───┬───────────────┬──────────────────┬─────────────┘
          │2. signed URL   │3. read PDF,       │ store analysis,
          │                │   call OpenAI     │ consent, status
          ▼                ▼                   ▼
 ┌─────────────────┐  ┌──────────────┐  ┌──────────────────┐
 │ Supabase Storage│  │  OpenAI API  │  │ Supabase Postgres │
 │ (private bucket)│  │ (extraction) │  │ (RLS + pg_cron)   │
 └─────────────────┘  └──────────────┘  └──────────────────┘
          ▲                                       │
          └────────── scheduled secure delete ────┘
```

**Key design choice — the browser uploads directly to Supabase**, not through Vercel. Credit-report PDFs can be large (many are 20–100 pages) and Vercel functions have body-size and duration limits. A **signed upload URL** lets the file go browser → Supabase directly, keeping big payloads out of the function.

---

## 4. End-to-end data flow

1. **Consent + gate** — Before upload, the UI collects contact info (email/phone, likely already the GHL contact) and shows the explicit consent screen (§9.2). Frontend calls `POST /api/consent` with `{ email, phone }`. The function **(a)** runs the abuse gate (§4.1) and returns `gate_closed` if this contact already used the analyzer, **(b)** otherwise persists a consent record and returns `{ consentId }`. **No consent → no upload. Gate closed → no upload.** Gating here (before any OpenAI spend) is deliberate.
2. **Mint upload URL** — `POST /api/upload-url` with `{ consentId }`. Function verifies consent, generates a Supabase **signed upload URL** scoped to a single object path (e.g. `tmp/{reportId}.pdf`), creates a `reports` row with `status = 'awaiting_upload'`, returns `{ reportId, uploadUrl }`.
3. **Upload** — Browser PUTs the PDF straight to Supabase Storage via the signed URL. Bucket is **private**. The object lives in a **transient** prefix.
4. **Trigger analysis** — `POST /api/analyze` with `{ reportId }`. Function re-checks the gate, sets `status = 'processing'`, and starts extraction (§5 for sync-vs-async).
5. **Extract** — Function downloads the PDF from Storage (service-role), sends it to OpenAI with a **strict JSON schema** (§7). Model returns structured facts.
6. **Persist + delete PDF** — Store the structured analysis in `report_analysis`, set `status = 'analyzed'`, then **immediately delete the PDF object from Storage** (secure erase). We keep only the extraction. **Do not** store raw model prompt/response logs containing full report text.
7. **Mark used** — Apply the `credit-analyzer-used` tag to the GHL contact (§4.1) so the gate closes for next time.
8. **Simulate** — Frontend calls `POST /api/simulate` with scenario knobs (e.g. "pay card X to 10% utilization", "remove 1 collection"). The **deterministic engine** computes the projected score delta from the stored facts. No AI call here.
9. **Sweep (safety net)** — A scheduled `cleanup` job deletes any **orphaned** transient PDFs (uploads that never completed extraction) past a short TTL, and enforces extraction-retention if a client later sets one (§9.4). In the happy path the PDF is already gone at step 6.

### 4.1 Abuse deterrence & rate limiting (public tool)

This is a **public, unauthenticated** tool, so we need to deter repeat/abusive use — both to control OpenAI cost and to keep it a lead-gen funnel rather than a free utility. **Reuse the gatekeeper pattern already in this repo** (`lib/ghl.ts` + `check-contact`/`mark-used`), just with a new tag:

- **Primary gate — GHL contact tag.** On `POST /api/consent`, look up the contact by email/phone (`searchContact`). If they carry the **`credit-analyzer-used`** tag → return `{ status: "gate_closed" }` and the UI shows an "already used" screen (mirrors the funding analyzer's lockout). After a successful analysis (step 7), `addUsedTag(contactId, "credit-analyzer-used")`. This is the same consolidated create-check-tag flow we built for `/api/submit`.
- **Gate BEFORE the OpenAI call**, not after — an abuser must not be able to burn API spend. The consent endpoint gates first; `/api/analyze` re-checks.
- **Secondary layer — IP / rate limit.** Email/phone gating is soft (a determined user can use a new email). Add an **IP-based rate limit** (e.g. N analyses per IP per day) via Vercel middleware / a Supabase counter table, plus a per-day **global cap** as a cost circuit-breaker. Treat these as deterrence, not hard security.
- **Honest limitation:** without real auth, none of this is unbypassable. It raises friction and caps cost; that's the goal. If we later need hard limits, add Supabase Auth or email verification (§10).

### 4.2 Identity capture WITHOUT a contact form (client request: no form in the UI)

The client doesn't want a name/email/phone **form** in the UI. Two constraints make "just read it from the PDF" the wrong answer:

1. **Credit reports don't contain email/phone.** Verified against the real sample (§17): the Personal Information section carries **name, DOB, addresses, employers only — no email, no phone.** The gate (§4.1) and lead-gen key on email/phone; the PDF cannot supply that key. This is true of consumer reports generally, not just this vendor.
2. **Gating from PDF-extracted data is backwards.** To read *anything* from the PDF we must first upload it and run the AI extraction — i.e. **spend the OpenAI money.** §4.1 deliberately gates *before* spend. Deriving identity from the PDF forces a **spend-then-gate** order that defeats the gate's cost-control purpose. So PDF identity can never be the gate key.

**Resolution — "no form" ≠ "no identity":**
- **Preferred (if the tool sits behind a known GHL contact):** the GHL frontend already knows the contact (they came through the funding funnel). It passes the **known email/phone to `/api/consent` silently** — no visible fields, gate + lead capture intact, spend still gated before upload. This satisfies "no form" cleanly.
- **Fallback (fully public/anonymous embed):** there's no contact to inherit. Options: capture a **single email field** once (minimal, not a full form), or **drop the contact-tag gate and rely on IP + global cap only** (weaker abuse control and no lead capture). Decide per deployment.
- **Consent still required, but it's one click, not a form.** Keep a single **"I authorize this analysis"** checkbox/button before upload — the FCRA consent control (§9.2) is non-negotiable, but it isn't a data-entry form. The consent *record* (version, timestamp, IP, UA, contact_ref) is still logged server-side.
- **Optional:** extract **name + address** from the PDF as a *verification/enrichment* signal (confirm the report matches the known contact, or populate the GHL record) — never as the gate key. **Open decision, see §16.**

---

## 5. Sync vs. async processing (important)

AI extraction on a multi-page PDF can take **tens of seconds**. Vercel function duration is limited (short on lower tiers; extendable via `maxDuration` / fluid compute on paid tiers). Two viable patterns:

- **A. Inline (simplest):** `/api/analyze` does the OpenAI call and returns when done. Set `maxDuration` high enough (Pro tier). Frontend shows a spinner. **Risk:** timeouts on very large reports; user waits on an open connection.
- **B. Async job (recommended for robustness):** `/api/analyze` enqueues the work and returns immediately with `status = 'processing'`. A background worker (Vercel Cron picking up queued rows, or a Supabase Edge Function) performs extraction. Frontend **polls `/api/status`** or subscribes to **Supabase Realtime** on the `reports` row.

**Recommendation:** Start with **A** to ship fast (cap report size, e.g. ≤ 15 pages / ≤ 10 MB), then move to **B** as volume grows. Design the `reports` table with a `status` column now so the async move is non-breaking.

---

## 6. Supabase design

### 6.1 Storage — the PDF is transient
- **Bucket `credit-reports`**, `public = false`. Enforce `allowedMimeTypes = ['application/pdf']` and a `fileSizeLimit`. Objects land in a **`tmp/` prefix**.
- **We do not retain the PDF.** It exists only long enough to be sent to OpenAI; on successful extraction the function **deletes it** (data-flow step 6). Only the **structured extraction** (`report_analysis.extracted`) is persisted. This is the low-liability default; a client who later needs the PDF archived can flip it on (§10).
- Access **only** via short-TTL signed URLs (upload) and service-role download (read). All minting happens server-side in Vercel functions using the **service-role key** (never exposed to the browser).
- Encryption at rest is on by default. Because the PDF is short-lived, envelope-encrypting it adds little; the sensitive **persistent** asset is the extraction JSON — see §9.5 for protecting that.

### 6.2 Postgres tables (sketch)

```sql
-- Consent is captured BEFORE any report touches our systems.
create table consents (
  id            uuid primary key default gen_random_uuid(),
  contact_ref   text,                 -- GHL contact id / email if known
  consent_version text not null,      -- which legal copy they agreed to
  agreed_at     timestamptz not null default now(),
  ip            inet,
  user_agent    text
);

create table reports (
  id            uuid primary key default gen_random_uuid(),
  consent_id    uuid not null references consents(id),
  contact_ref   text,
  storage_path  text,                 -- tmp/{id}.pdf; NULLed once the PDF is deleted
  status        text not null default 'awaiting_upload',
                 -- awaiting_upload | processing | analyzed | failed | deleted
  error         text,
  uploaded_at   timestamptz,
  analyzed_at   timestamptz,
  pdf_deleted_at timestamptz,         -- set at step 6 (happy path deletes immediately)
  sweep_after   timestamptz          -- TTL for orphaned/incomplete uploads (safety net)
);

-- Secondary deterrence layer: coarse IP rate limiting + global cost cap (§4.1).
create table rate_limits (
  bucket_key    text primary key,     -- e.g. 'ip:1.2.3.4:2026-08-05' or 'global:2026-08-05'
  count         int not null default 0,
  window_start  timestamptz not null default now()
);

create table report_analysis (
  report_id     uuid primary key references reports(id) on delete cascade,
  model         text not null,        -- e.g. gpt-5.6-terra
  extracted     jsonb not null,       -- structured facts (§7.3 schema)
  token_usage   jsonb,
  created_at    timestamptz not null default now()
);
```

### 6.3 RLS
- Enable RLS on every table. Since this is a **public tool with GHL-based identity (no Supabase Auth)**, keep **all** DB and Storage access **server-side via the service-role key**; the Vercel function is the trust boundary. The browser never queries Supabase directly for report data — it only PUTs the PDF to a scoped signed upload URL.
- Set RLS policies to **deny all** to the `anon`/`authenticated` roles by default (belt-and-suspenders behind the service-role boundary). Revisit only if we later add Supabase Auth for hard per-user limits (§10).

---

## 7. OpenAI integration (correct usage)

### 7.1 Account & key
- Create an **OpenAI Platform** account, add API billing, generate a key. Store as `OPENAI_API_KEY` in **Vercel env vars** (server-side only). Never ship it to the GHL frontend.
- Set a **monthly usage limit / budget alert** in the platform to cap runaway cost.

### 7.2 Sending the PDF
The API accepts **direct PDF file input** on vision-capable models — no need to build our own PDF text extractor. On vision models it extracts **both text and a rendered image of each page**, so it can read tables/columns typical of credit reports. Two ways to attach:
- **Files API** — upload the PDF once, get a `file_id`, reference it in the request (best for larger files / reuse).
- **Inline base64** — embed `file_data` directly in the request (fine for small files).

Per-request limits: each file **< 50 MB**, combined **< 50 MB** per request. ([OpenAI file inputs guide](https://developers.openai.com/api/docs/guides/file-inputs), [announcement](https://community.openai.com/t/direct-pdf-file-input-now-supported-in-the-api/1146647))

**Cost/size control:** big reports = many page-images = many tokens. Cap pages, prefer the Files API, and pick a cost-appropriate model (below). Automatic **prompt caching** bills repeated prefixes (our long system/schema prompt) at ~10% — keep the schema/system prompt stable to benefit.

### 7.3 Structured Outputs (do this)
Use **Structured Outputs (strict JSON Schema)** so the model returns data conforming exactly to our schema — no brittle parsing. Supported on GPT-4o (2024-08-06+), GPT-4.1, GPT-5.x, the o-series, and current GPT-5.6. Treat model **refusals** as first-class errors. ([Structured outputs](https://platform.openai.com/docs/guides/structured-outputs))

Illustrative extraction schema (the LLM fills this; the simulator consumes it). **⚠️ Superseded by §17** — the real sample report is a **tri-bureau, VantageScore 3.0** document, not single-bureau FICO 8. See §17.2 for the corrected schema.

```jsonc
{
  "reported_score": { "value": 612, "model": "FICO 8", "bureau": "Experian" },
  "accounts": [
    { "type": "revolving", "name": "Capital One", "balance": 2400,
      "credit_limit": 3000, "status": "open", "past_due": 0, "opened": "2019-04" }
  ],
  "utilization": { "overall_pct": 0.78, "per_card": [ /* ... */ ] },
  "derogatories": [ { "kind": "collection", "amount": 380, "date": "2023-08" } ],
  "inquiries": { "hard_count_24mo": 5 },
  "credit_age": { "avg_account_age_months": 41, "oldest_account_months": 96 },
  "missed_payments": { "count_24mo": 2 }
}
```

### 7.4 Model choice (verified Aug 2026)
Current family is **GPT-5.6 (Sol / Terra / Luna)** — GA July 9 2026, **1.05M-token context** on all three, **vision + Structured Outputs supported across the lineup**. Verified per-1M-token rates (after OpenAI's July 30 2026 cut to Terra/Luna):

| Tier | Input | Output | Cached input (10%) | Fit |
|------|-------|--------|--------------------|-----|
| Sol (flagship) | $5.00 | $30.00 | $0.50 | Overkill for extraction |
| **Terra** (mid) | $2.00 | $12.00 | $0.20 | Accuracy fallback |
| **Luna** (budget) | **$0.20** | **$1.20** | $0.02 | **Default — cheapest with vision** |

(Legacy `GPT-5.4 Nano` $0.20/$1.25 and `Mini` $0.75/$4.50 also exist but are superseded by Luna for our needs.)

**Recommendation — Luna-first, Terra as fallback.** For lowest cost with good accuracy:
- **Start on `gpt-5.6-luna`.** IdentityIQ reports are *digitally generated* (clean render, just a complex 3-column layout), which vision models read well — a budget tier is a reasonable first choice, and it's **~10× cheaper than Terra** on input.
- **We have a safety net** that makes a budget model lower-risk: the LLM only *extracts facts* (the deterministic engine does the math), output is validated against a **strict JSON schema** with a one-shot repair retry (§7.6), and we never let it compute scores.
- **Validate before trusting it (required).** Run 3–5 real (redacted) reports through Luna **and** Terra, diff the extracted JSON against hand-checked ground truth, focusing on the fields that actually matter: the three bureau scores, open-revolving **per-bureau balance/limit alignment** (the hardest part of the tri-column layout), and reason codes. If Luna misaligns per-bureau values, switch `OPENAI_MODEL` to `gpt-5.6-terra` — a config change, **no deploy** needed.

**Rough per-report cost (order-of-magnitude, validate via logged `token_usage`):** a ~30-page tri-bureau report ≈ tens of thousands of vision input tokens + a few-thousand-token JSON output → **~$0.02/report on Luna vs ~$0.20 on Terra**. Prompt caching (below) cuts the input side further on warm runs.

**Cost controls (apply regardless of tier):**
- **Prompt caching** — keep the system + schema prompt **stable** so the long prefix bills at **10%** (cached input). This is why §7.2 stresses a stable schema.
- **Don't chunk the PDF** — splitting across calls costs **3–7% accuracy** (industry finding); send the whole report in one request (well under the 272K long-context surcharge threshold and the 1.05M window).
- **Cap pages** (§7.2) as a cost + latency guard.
- **Batch API (−50%)** exists but is **async/24h** — not usable for the interactive "user waits ~30s" flow (§5 pattern A); only relevant if we move analysis fully async (Phase 5).
- Keep the model in the **`OPENAI_MODEL`** env var so tier changes need no deploy.

Sources: [aipricing.guru](https://www.aipricing.guru/openai-pricing/) · [costgoat](https://costgoat.com/pricing/openai-api) · [BenchLM](https://benchlm.ai/openai/api-pricing) · OCR-accuracy context: [Parseur vision doc guide](https://parseur.com/blog/vision-ai-document-processing) · [TokenMix](https://tokenmix.ai/blog/best-ai-for-document-processing)

### 7.5 Privacy of what we send (critical for this data)
- **Default API behavior:** data sent via the API is **not used to train** OpenAI models, and is retained ≤ **30 days** for abuse monitoring, then deleted. ([enterprise privacy](https://openai.com/enterprise-privacy/))
- **For credit/financial PII, pursue a signed DPA and a Zero-Data-Retention (ZDR) agreement** so nothing is retained server-side beyond the request. ZDR is requested through OpenAI sales/enterprise and is the posture regulated finance/health customers use. ([ZDR overview](https://openai.com/enterprise-privacy/))
- **Context — the NYT litigation retention order:** a 2025 court order forced retention of API logs for accounts **without** ZDR; ZDR endpoints were exempt, and as of late Sept 2025 new logs were no longer swept in. The lesson stands: **ZDR is the safe path for this data.** ([summary](https://openai.com/index/response-to-nyt-data-demands/))
- **Data minimization before sending:** consider stripping/masking the SSN and full account numbers from what we send if the analysis doesn't need them (the score factors don't). Never log full report text or model payloads.

### 7.6 Robustness
- Timeouts + **bounded retries** with backoff (transient 429/5xx only).
- Validate the returned JSON against the schema even with strict mode; on failure, one repair retry, then `status = 'failed'`.
- Record `token_usage` for cost monitoring.

---

## 8. Credit score simulator (deterministic engine)

**Principle:** the AI produces **facts**; a **rules engine in code** produces the **simulation**. This keeps the score math consistent, explainable ("+18 pts because utilization dropped from 78%→10%"), unit-testable, and free of per-simulation AI cost.

- Model the well-known FICO factor weights as an **approximation** (payment history ~35%, utilization ~30%, age ~15%, mix ~10%, new credit ~10%). We can't reproduce FICO/VantageScore exactly (proprietary), so **label outputs "estimated"** and never present them as guaranteed (§9.6).
- Inputs: the `extracted` JSON. Knobs the user can toggle: pay down card X to N% utilization, remove/settle a collection, age of accounts over time, remove a hard inquiry, add a new tradeline.
- Output: estimated new score range + a ranked, plain-English list of the highest-impact actions.
- Implement as a pure function `simulate(facts, scenario) -> { estimatedScore, deltas[], recommendations[] }` behind `/api/simulate`. Pure = trivially testable with fixtures.

> Optional later: a **one-time** AI pass to generate the *narrative* coaching text from the deterministic result. The numbers still come from code.

---

## 9. Legal & compliance

> Again: **get a compliance attorney to sign off.** This section frames the issues; it does not resolve them.

### 9.1 Which law applies
- **FCRA** governs consumer reports. In our assumed flow the **consumer uploads their own report and authorizes us to analyze it** — their written instruction is a recognized permissible purpose. The linchpin is a **clear, logged consent/authorization** at upload. ([CFPB permissible purposes](https://www.consumerfinance.gov/rules-policy/final-rules/fair-credit-reporting-permissible-purposes-for-furnishing-using-and-obtaining-consumer-reports/))
- **FTC Disposal Rule (16 CFR Part 682)** — anyone holding consumer-report info for a business purpose must **securely dispose** of it (secure erase / destruction). Drives our retention + deletion design. ([FTC](https://www.ftc.gov/business-guidance/resources/disposing-consumer-report-information-rule-tells-how), [eCFR](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-F/part-682))
- **GLBA Safeguards Rule** may apply if we're deemed a financial institution — mandates a written security program, encryption, access controls, vendor oversight.
- **State law** — CCPA/CPRA treats credit data as **sensitive personal information** (access/deletion rights, disclosures); state breach-notification laws apply. Confirm the states we operate in.

### 9.2 Consent (the single most important control)
- Explicit, unbundled consent screen **before** upload: what we collect, why (credit analysis + score simulation), that we use a third-party AI processor (OpenAI) to analyze it, how long we keep it, and how they can delete it.
- Persist a **consent record** (version of the legal copy, timestamp, IP, UA) — the `consents` table. Tie every report to a `consent_id`.
- Version the consent copy so we can prove what a user agreed to on a given date.

### 9.3 Data minimization — **decided: extraction-only**
- We **do not retain the raw PDF**. It's deleted immediately after extraction (data-flow step 6); only the structured `extracted` JSON persists. This is the strongest practical posture and materially lowers our liability surface. Revisit only if a client explicitly requires PDF archival.
- The persisted extraction is **still sensitive** (balances, account info, possibly score). Strongly consider **masking SSN / full account numbers** before sending to OpenAI and before persisting — the score factors don't need them (§7.5).
- Collect only what the analysis needs.

### 9.4 Retention & deletion
- **PDF:** deleted at step 6 (secure erase). No standing PDF retention.
- **Orphan sweep:** a scheduled **`/api/cleanup`** (Vercel Cron) or **pg_cron** job deletes any transient PDFs whose upload never completed extraction, past `sweep_after`.
- **Extraction:** decide a retention window for `report_analysis` with counsel; add a purge to the same cleanup job if set. Deletion must be **secure erase**, per the FTC Disposal Rule.
- Provide a **user-initiated delete** ("delete my analysis now") endpoint to honor CCPA/CPRA deletion — purges the extraction row.

### 9.5 Encryption & security
- **In transit:** HTTPS everywhere (default on Vercel/Supabase).
- **At rest:** Supabase default encryption **plus** consider envelope-encrypting the PDF bytes with a key in **Supabase Vault** / Vercel env, so a Storage-level exposure doesn't reveal plaintext reports.
- **Secrets:** `OPENAI_API_KEY`, Supabase **service-role key**, encryption keys — server-side env vars only. The GHL frontend gets **none** of these; it only ever holds short-lived signed URLs and the Supabase **anon** key (if used).
- **Logging:** never log report contents, model payloads, SSNs, or signed URLs. Scrub error traces.
- Supabase is **SOC 2 Type 2** and offers a **HIPAA BAA** — useful for our compliance posture and vendor due-diligence file. ([Supabase security](https://supabase.com/security))

### 9.6 Product disclaimers
- Label simulated scores **"estimated, not a guarantee"** (we're not FICO/VantageScore). 
- State we are **not a credit repair organization** and don't dispute items on the user's behalf — otherwise **CROA** (Credit Repair Organizations Act) obligations may attach. Confirm messaging with counsel.

---

## 10. Decisions

**Locked:**
- ✅ **Public tool**, **US-only** at launch (FCRA/FTC/GLBA/state scope; no GDPR).
- ✅ **Identity:** GHL-based, **no Supabase Auth**; all Supabase access server-side via service role (§6.3).
- ✅ **Storage:** **extraction-only**; raw PDF is transient and deleted post-extraction (§9.3). Flip to PDF-archival only on explicit client requirement.
- ✅ **Deterrence:** GHL `credit-analyzer-used` tag gate (reuse existing gatekeeper flow) + IP/global rate limit (§4.1).

**Still open:**
1. **Mask SSN/account numbers** before AI + persistence? (Recommended **yes** — factors don't need them.)
2. **Sync vs async** analysis for v1 (§5) — tied to expected report size + volume. (Recommend sync + size cap first.)
3. **ZDR/DPA with OpenAI** — start the enterprise agreement process now (lead time).
4. **Extraction retention window** — how long we keep `report_analysis` (legal + product call, §9.4).
5. **Rate-limit thresholds** — per-IP/day and global/day caps (cost circuit-breaker values).

---

## 11. Environment variables (backend)

```
OPENAI_API_KEY=            # OpenAI PLATFORM key (not ChatGPT Plus)
OPENAI_MODEL=gpt-5.6-terra # swap without a deploy
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY= # server-side only, full access — guard carefully
GHL_API_TOKEN=             # REUSE the existing gatekeeper token (already in this repo)
GHL_LOCATION_ID=           # REUSE existing
CREDIT_USED_TAG=credit-analyzer-used   # deterrence tag
ALLOWED_ORIGINS=           # CORS allowlist for the GHL embed (reuse gatekeeper pattern)
RATE_LIMIT_PER_IP_DAY=     # secondary deterrence
RATE_LIMIT_GLOBAL_DAY=     # cost circuit-breaker
SWEEP_TTL_MINUTES=         # orphaned-upload cleanup window
```
> Note: `GHL_API_TOKEN` / `GHL_LOCATION_ID` and the CORS + `lib/ghl.ts` gate logic **already exist in this repo** — the credit analyzer reuses them rather than standing up a second GHL integration.

---

## 12. Build phases

- **Phase 0 — Accounts & agreements:** OpenAI Platform account + billing + budget cap; begin **ZDR/DPA**; Supabase project + private bucket; confirm legal review of consent copy.
- **Phase 1 — Consent + gate + storage path:** `/api/consent` (reusing `lib/ghl.ts` gate with the `credit-analyzer-used` tag), `/api/upload-url`, `consents`/`reports`/`rate_limits` tables, private bucket, direct browser upload. No AI yet.
- **Phase 2 — Extraction:** `/api/analyze` → gate re-check → OpenAI file input + Structured Outputs → `report_analysis` → **delete PDF** → apply used-tag. Inline (sync) first, size-capped.
- **Phase 3 — Simulator:** deterministic `simulate()` engine + `/api/simulate`, with unit-test fixtures.
- **Phase 4 — Retention & rights:** `/api/cleanup` cron (orphan PDF sweep + optional extraction purge), user-initiated delete, IP/global rate limiting, logging scrub.
- **Phase 5 — Hardening/scale:** move analysis to async (queue + Realtime/poll), cost dashboards, monitoring, SSN/account masking pipeline.

---

## 14. Personalized recommendations — "which levers to surface" (AI-curated, code-scored)

> **Client ask (from planning call):** *"I would [ask] AI what questions are best to ask. And maybe we limit their questions — because they're going to have open trade lines. If they have like 20 trade lines, it might give them the option: you're American Express with a $50,000 limit, balance $30,000; if you pay down $10,000 to under $20,000, how much will that improve your score?"*

**Interpretation — CONFIRMED with client:** "questions" = the **suggested what-if scenarios** the simulator surfaces, **derived directly from what's in the uploaded PDF** — a personalized case scenario. The client's words: *"the simulator will base its questions on what is inside the PDF… the PDF contains the Amex $50,000 credit limit with $30,000 balance, and based on those details we'll curate the simulator questions."* This is precisely the extract-facts → enumerate → score → curate pipeline below. It is **not** an interactive intake Q&A.

### 14.1 The real problem: combinatorial explosion → we must limit
A report with 20 tradelines does **not** have 20 possible actions — it has *hundreds*. Each revolving card alone yields several candidate scenarios (pay to <30%, <10%, $0), times cards, times cross-products for compound scenarios, plus collections, inquiries, new-tradeline, and age levers. You cannot show that. "Limit their questions" is not just UX polish — it is required. Our audience (business owners 40–60; design for **credibility + low anxiety**) needs **3–5 high-impact, plain-English suggestions**, not a wall of knobs.

### 14.2 Architecture — enumerate & score in code, curate & phrase with AI
This preserves the plan's core rule (§0.2, §8): **the LLM never does score math and never invents a number.**

```
extracted facts (§7.3)
      │
      ▼  (deterministic TypeScript — no AI)
1. ENUMERATE candidate levers   → every plausible action for this report
2. SCORE each with simulate()   → estimated Δ points + effort ($ to pay down)
3. RANK & PRUNE                 → impact-per-effort, dedupe, cap to top-N
      │
      ▼  (ONE optional AI call — phrasing only)
4. PHRASE top-N as personalized "questions"/coaching copy
      │
      ▼
suggested_scenarios[]  (each is a ready-to-run simulator scenario, §15)
```

- **Steps 1–3 are pure code.** The AI is handed an already-ranked, already-scored shortlist. It may **reorder within reason, merge, and write the human copy** ("Your Amex is 60% utilized — paying it to under $10k could add roughly **+X pts**") but the **X comes from `simulate()`**, injected into the prompt, never generated by the model. The AI is explicitly instructed it may not alter numbers; validate on return.
- **Why not let AI pick the levers directly?** It's non-auditable, non-testable, inconsistent run-to-run, and would tempt it into the arithmetic we banned. Code ranking is deterministic and unit-testable; AI adds personalization and tone on top.
- **The AI phrasing call is optional and one-time.** Run it once at analysis, persist the result (see 14.5), and serve it from the DB — **no per-view AI cost**. If ZDR/budget pressure is high, ship v1 with a **templated** phrasing (string templates over the ranked scenarios) and add the AI pass later; the schema is identical either way.

### 14.3 Candidate lever taxonomy (schema-stable)
Keep lever types **generic enums**, not client- or card-specific — the client churns product tiers often, so the schema must outlive them (see the repo's schema-stability preference). Magnitudes below are **rough, estimated** and must branch on the reported FICO **model** captured in §7.3 (`reported_score.model`).

| Lever `type` | Applies to | Typical magnitude | Model sensitivity / caveat |
|---|---|---|---|
| `paydown_revolving` | each open revolving acct | **High** — biggest fast lever | Non-linear at 30% / 10% / 0% thresholds; per-card *and* aggregate util both matter |
| `payoff_all_revolving` | all cards | **Very high** | The "aggregate util → single-digit" ceiling scenario |
| `settle_collection` | each collection | Low→High | **FICO 9/10 ignore *paid* collections; FICO 8 still counts presence** — branch on model, or the recommendation over-promises |
| `remove_hard_inquiry` | inquiries <12mo | **Low** (~few pts) | Fades after 12mo; only surface if recent |
| `add_authorized_user` / `add_tradeline` | thin files | Situational | Only surface when file is thin / mix is poor |
| `age_accounts` | whole file | Time-based, **not an action** | Show as "in N months," never as something to "do now" |
| `payoff_installment` | installment loans | **Negligible / sometimes slightly negative** | Do **not** recommend as a score play; guard against the naive "pay everything" suggestion |

The last two rows are the ones a naive AI-picks-the-levers approach gets wrong and code gets right — a good reason to keep ranking deterministic.

### 14.4 Tie recommendations to a funding-tier goal (product hook)
This tool lives inside the small-business **funding** funnel. The most motivating "question" isn't abstract points — it's **"pay down these 2 cards and you cross into the next funding tier."** If the deterministic engine knows the tier thresholds (e.g., the **660** band the formWizard already routes on), it can rank levers by *"what's the cheapest set of actions that reaches the next threshold"* and phrase the goal concretely. This turns a credit-coaching toy into a funding-conversion driver. (Confirm which thresholds to expose; keep them in config, not hardcoded.)

### 14.5 Endpoint, persistence, cost/abuse
- **Fold into `/api/analyze`** (steps 1–4 run right after extraction) so recommendations are persisted alongside the facts and there's **no second gated call**. Add a `recommendations` (or `suggested_scenarios`) `jsonb` column to `report_analysis`, or a sibling column next to `extracted`.
- The abuse gate (§4.1) already covers this — it's the same analysis, one OpenAI phrasing call max. No new per-IP surface.
- **`RECOMMENDATIONS_MAX_N`** env var for the cap (default ~5); **`RECOMMENDATIONS_AI_PHRASING=on|off`** to toggle the phrasing call vs. templates without a deploy (mirrors the plan's env-var-driven model switch).

### 14.6 Suggested-scenario schema (what step 4 emits; frontend renders; feeds §15)
```jsonc
{
  "suggested_scenarios": [
    {
      "id": "amex-to-10pct",
      "title": "Pay down your American Express",             // AI/template phrasing
      "rationale": "This card is 60% utilized...",            // AI/template phrasing
      "estimated_delta_points": 24,                            // from simulate(), NOT the LLM
      "estimated_range": [18, 30],                             // engine-provided band
      "effort": { "pay_down_amount": 10000, "to_utilization_pct": 0.10 },
      "actions": [                                             // a ready-to-run §15 scenario
        { "type": "paydown_revolving", "account_id": "acct_amex", "target_utilization_pct": 0.10 }
      ],
      "reaches_goal": { "tier": "660", "before": 642, "after": 666 }  // §14.4, optional
    }
  ],
  "generated_by": "engine+ai" | "engine+template",
  "capped_at": 5
}
```

---

## 15. Multi-item score simulator — compound scenarios (extends §8)

The client wants "multiple items at a time." The scenario is therefore a **set** of actions, not one knob.

### 15.1 The one correctness rule that matters most
> **Score deltas are NOT additive. Recompute the whole score from the mutated fact-set — never sum per-item deltas.**

Why: utilization is computed on **aggregate** balances/limits and FICO buckets are **non-linear** at thresholds. Paying card A to 10% and card B to 10% does **not** give (ΔA + ΔB) — the aggregate-utilization improvement is shared, and both may cross the same bucket boundary. A simulator that adds per-item deltas will systematically over-promise. So:

```ts
simulate(facts, scenario: Action[]) -> {
  estimatedScore, estimatedRange, deltas /* see 15.3 */, recommendations
}
```
`simulate` **clones the facts, applies every action to the clone, recomputes utilization (per-card + aggregate) and every affected factor, then scores once.** Pure function → trivially unit-testable with fixtures (as §8 already requires).

### 15.2 Action schema (the compound scenario)
Same generic `type` enums as §14.3, so a suggested scenario (§14.6) *is* a valid simulator input — the "AI question" and the "run this" are the same object.
```jsonc
[
  { "type": "paydown_revolving", "account_id": "acct_amex",  "target_utilization_pct": 0.10 },
  { "type": "paydown_revolving", "account_id": "acct_capone","pay_down_amount": 500 },
  { "type": "settle_collection", "collection_id": "col_1" }
]
```
Accept either `target_utilization_pct` or `pay_down_amount` per revolving action (engine converts one to the other from the card's limit/balance).

### 15.3 Explainability with non-additive deltas (waterfall attribution)
Users still want "where did the points come from." Since deltas aren't additive, attribute via an **ordered waterfall** (marginal contribution in a fixed, sensible order — biggest lever first), and label the line items honestly as *"in combination"*:
```
Base 642
 + pay Amex to 10%      → 660   (+18)
 + pay CapOne $500      → 664   (+4, in combination)
 + settle collection    → 668   (+4, in combination)   [FICO 8 only — 0 on FICO 9]
Estimated: 660–672
```
This is cheap, intuitive, and doesn't pretend the parts are independent. (Shapley-style averaging is more "fair" but overkill for this audience and N.)

### 15.4 It's deterministic → cheap → interactive, and needs no gate
- **No AI call, no OpenAI cost** per simulation → the frontend can recompute live as the user toggles items. This is why the plan gates *analysis* but **not** `/api/simulate`.
- Do **not** rate-limit `/api/simulate` for cost reasons (there is none); a light per-report sanity cap is fine only to stop pathological request floods.
- Any **"limit"** on `/api/simulate` is UX, not cost: cap how many actions render at once, offer "top suggestions" (§14) by default with an "advanced: all levers" reveal. Keeps the 40–60 audience out of decision paralysis.

### 15.5 Always-estimated framing (ties to §9.6)
Every simulator response carries the **estimated range**, not a single hero number, and the disclaimer ("estimated, not a guarantee; we are not FICO/VantageScore, not a credit-repair org"). The range also honestly reflects the model-branching uncertainty (e.g., collection removal that only helps on FICO 8).

### 15.6 Build note
Both features slot into **Phase 3** of §12 (the simulator). Sequence: build `simulate(facts, Action[])` + fixtures first (§15), then the deterministic enumerate/rank/prune (§14.2 steps 1–3), then the optional AI phrasing pass (§14.2 step 4). Ship with templated phrasing; add the AI pass once a couple of real (redacted) reports validate the rankings.

---

## 16. Additional open decisions (from §14–15)

Extends §10.

**Locked:**
- ✅ **"Questions" = PDF-derived curated what-if scenarios** (§14), *not* an interactive intake Q&A. Confirmed with client.
- ✅ **Templated phrasing for v1**, AI phrasing pass as a fast-follow. Schema identical either way (§14.6); toggle via `RECOMMENDATIONS_AI_PHRASING`.
- ✅ **LLM provider = OpenRouter** (client preference; default in code via `LLM_PROVIDER`, `gpt-5.6-luna` through it). Env-toggle to OpenAI-direct available. **⚠️ COMPLIANCE DEFERRED — see open item 17.**

**Still open:**
8. **Expose funding-tier goals in recommendations?** (§14.4) — recommend **yes**; strongest conversion hook. Which thresholds (660?).
9. **`RECOMMENDATIONS_MAX_N`** cap value (default ~5) and whether to offer an "advanced: all levers" reveal.
10. **Attribution style** — waterfall (recommended, §15.3) vs. combined-total-only.
11. **Score-model branching source of truth** — rely on `report_meta.score_model` from extraction (the sample is **VantageScore 3.0**, §17.2); decide the default when a report doesn't state it, and support both VantageScore + FICO factor weights via config (§17.1 #2).
12. **Which bureau to simulate/display?** (§17.3) — tri-bureau reports yield **three** scores/balances/limits. Recommend `simulate()` per bureau and show a **range**; decide whether to feature one bureau (e.g. the middle score, lender convention) or all three.
13. **Multi-bureau report detection** — the pipeline must detect 1B vs 3B reports and branch the schema (§17.2). Decide whether to support single-bureau reports at launch or assume tri-bureau (IdentityIQ-style) only.
14. **Authorized-user / joint handling** (§17.3) — confirmed: exclude AU/joint accounts from paydown suggestions. Decide whether to *surface* them as informational ("this AU card hurts your utilization — ask the primary holder").
15. **Identity source when there's no form** (§4.2) — is the analyzer embedded behind a **known GHL contact** (pass email/phone silently → preferred), or a **fully public** embed (single email field, or IP/global-cap-only gate)? **Client to confirm the GHL setup.** Locked: keep a one-click consent affirmation (not a form).
16. **PDF identity extraction as verification only?** (§4.2) — extract name/address from the PDF to confirm the report matches the known contact / enrich GHL? (Recommended optional; never the gate key.)
17. **⚠️ REVISIT — OpenRouter compliance (DEFERRED by client).** Client deprioritized compliance for now ("as long as it's working"), so we're using OpenRouter without the safeguards. **Before launching on REAL consumer-credit PII**, this MUST be revisited with counsel (§9): OpenRouter is a third-party subprocessor in the data path → need a signed **DPA**, request-level **ZDR** on every call, **training opt-out**, **prompt-logging OFF** (never enable the 1% discount), and a **pinned downstream provider** with acceptable retention/training terms. Until then, use **redacted/synthetic reports only**. This is deferred **debt**, not a resolved issue.

---

## 17. Sample-report findings & schema revisions (from a real report)

> Analyzed one real report — **IdentityIQ "Three Bureau Credit Report," 30+ tradelines, VantageScore 3.0**. This section records what the actual document forced us to change. Several §7/§8 assumptions were wrong. (The report was read for structure only; the plaintext extraction was deleted after analysis, per §9.4.)

### 17.1 The five things that broke our assumptions
1. **It's tri-bureau, not single-bureau.** Every section is **three columns — TransUnion / Experian / Equifax** — with *different values per bureau*. Scores: **646 / 643 / 639**. A single account (e.g. a Capital One card) shows **different balances, limits, and even statuses** across the three bureaus ("Closed" on one, "Paid" on another). The §7.3 schema (one value per field) cannot represent this. **Fix in §17.2.**
2. **It's VantageScore 3.0, not FICO 8.** Stated verbatim: *"using the VantageScore® 3.0 model."* §8's FICO factor weights (35/30/15/10/10) are the **wrong model**. VantageScore 3.0 weights differently (payment history is the dominant band, then age/type & utilization). Keep the factor weights in **config, selected by the extracted `model`** so we can support both — never hardcode FICO.
3. **The report hands us the answer key.** Each bureau lists explicit **Risk Factors / reason codes** ("You have too many delinquent or derogatory accounts," "Balances on bankcard or revolving accounts too high compared to credit limits," "Too many of the delinquencies on your accounts are recent"). This is **exactly** the §14 "which levers matter" question, pre-answered by the bureau. **Extract the reason codes and seed the recommendation ranking from them** instead of reverse-engineering — far more reliable than guessing.
4. **Plain-text extraction is unusable on this layout.** `pdftotext -layout` **scrambled** the three-column tables — labels and values misaligned across rows/columns, unrecoverable. This **validates §7.2's vision-model path as mandatory, not optional**: we must send **rendered page images**, not extracted text. Budget accordingly — ~30+ pages of three-column tables is real token cost (reinforces §7.4 page-cap + model-choice discipline).
5. **The client's Amex example was hypothetical.** No "$50k limit, $30k balance Amex" exists here — the real Amex is **closed, $0 / $1,000**. The $50k appears on an **installment** loan. Lesson already in §14 but now proven: **scenarios must be generated from extracted facts, never from the client's illustrative numbers.**

### 17.2 Revised extraction schema (tri-bureau, VantageScore-aware)
```jsonc
{
  "report_meta": { "vendor": "IdentityIQ", "type": "3B", "report_date": "2026-07-14",
                   "score_model": "VantageScore 3.0", "scale": [300, 850] },
  "scores": [                                   // one per bureau — NOT a single score
    { "bureau": "TransUnion", "value": 646, "band": "Fair",
      "reason_codes": ["too many delinquent/derogatory", "revolving balances high vs limits", "..."] },
    { "bureau": "Experian",   "value": 643, "band": "Fair", "reason_codes": ["..."] },
    { "bureau": "Equifax",    "value": 639, "band": "Fair", "reason_codes": ["..."] }
  ],
  "accounts": [
    { "creditor": "CAPITAL ONE", "type": "revolving", "detail": "Credit Card",
      "ownership": "individual",                // individual | joint | authorized_user  ← gates simulation (17.3)
      "per_bureau": {                           // values DIFFER across bureaus — keep all three
        "TransUnion": { "status": "open", "balance": 4440, "credit_limit": 4500, "past_due": 0, "opened": "2025-04" },
        "Experian":   { "status": "open", "balance": 4218, "credit_limit": 4500, "past_due": 0, "opened": "2025-04" },
        "Equifax":    { "status": "open", "balance": 4218, "credit_limit": 4500, "past_due": 0, "opened": "2025-04" }
      },
      "recent_late_marks": 0                    // derived from the 2-year payment grid
    }
  ],
  "inquiries": [ { "creditor": "PORSCHEFINSE", "date": "2026-03-24", "bureau": "TransUnion",
                   "business_type": "Auto Financing" } ],   // keep type+date for rate-shopping dedup (17.3)
  "public_records": []                          // "None Reported" in this sample
}
```
Notes: (a) an account may be **absent on a bureau** — model `per_bureau` as optional keys. (b) **Do not extract** SSN, DOB, addresses, employers — the Personal Information section is full of PII the factors don't need (§7.5/§9.3); instruct the model to skip it.

### 17.3 Simulator corrections this profile exposes
- **Simulate per-bureau, then report a range.** With three scores/limits/balances, `simulate()` runs **per bureau** and returns a **spread** (e.g. "≈ +18–24 across bureaus"), not one number. Pick a display bureau or show all three — **new open decision (§16).**
- **Payment history dominates here — utilization is the #2 story, not the headline.** The reason codes lead with *delinquent/derogatory* and *recent delinquencies*. Open cards are near-maxed (Citi ~94%, one Capital One ~99%), so paydown **is** a real lever — but a utilization-only simulator would **over-promise**, because the biggest drag (past delinquencies) only heals with **time**, which is not an action. This is the §14.3 caveat proven on real data: rank by the **bureau's own reason codes**, and phrase time-based factors honestly ("this improves as the late marks age off," not "do X").
- **Gate scenarios on `ownership`.** Several accounts are **authorized-user** or **joint** (e.g. a "CAP ONE" AU card carrying a $3,391 balance). Do **not** suggest "pay down this card" for accounts the user may not control. `paydown_revolving` should target **individual** open revolving accounts; flag AU/joint separately.
- **Don't tell them to remove rate-shopping inquiries.** The inquiry list is a **cluster of auto-finance pulls in early 2026** — VantageScore de-dupes rate-shopping. Suppress `remove_hard_inquiry` suggestions when inquiries cluster by date/《auto》business type.
- **Act on open accounts only.** ~30 tradelines, but most are **closed/paid**. Enumerate levers (§14.2) over **open** accounts; closed ones inform age/history only. Keeps the "limit their questions" set small naturally.

### 17.4 What did *not* change
The core architecture holds: browser→Supabase upload, vision extraction → Structured Outputs, **deterministic** engine, AI phrasing only, GHL gate, extraction-only retention. The sample **strengthens** the vision-model and "AI-extracts-facts-only" decisions rather than undermining them.

---

## 13. Sources

- OpenAI file inputs / direct PDF: https://developers.openai.com/api/docs/guides/file-inputs · https://community.openai.com/t/direct-pdf-file-input-now-supported-in-the-api/1146647
- Structured Outputs: https://platform.openai.com/docs/guides/structured-outputs · https://openai.com/index/introducing-structured-outputs-in-the-api/
- OpenAI enterprise privacy / ZDR / no-training: https://openai.com/enterprise-privacy/
- NYT retention-order context: https://openai.com/index/response-to-nyt-data-demands/
- Model pricing (2026): https://modelpricing.ai/models/openai
- ChatGPT Plus vs API: https://folding-sky.com/blog/why-use-api-keys-not-chatgpt
- FCRA permissible purposes (CFPB): https://www.consumerfinance.gov/rules-policy/final-rules/fair-credit-reporting-permissible-purposes-for-furnishing-using-and-obtaining-consumer-reports/
- FTC Disposal Rule: https://www.ftc.gov/business-guidance/resources/disposing-consumer-report-information-rule-tells-how · https://www.ecfr.gov/current/title-16/chapter-I/subchapter-F/part-682
- Supabase security / storage: https://supabase.com/docs/guides/security · https://supabase.com/docs/guides/storage/buckets/fundamentals · https://supabase.com/security
