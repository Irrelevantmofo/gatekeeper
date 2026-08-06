# Credit Analyzer — Frontend Integration Contract (GHL AI Studio)

> **Audience:** whoever builds the upload + simulator UI in **GHL AI Studio**.
> **Purpose:** this is the **contract** between the GHL frontend (thin client) and our **Vercel backend**. It tells you exactly *what to call, in what order, and what shape comes back* — so you can build the UI in parallel while the backend is finished.
>
> **Status:** DRAFT contract, agreed shape — **not all endpoints are live yet.** Fields marked 🔜 are planned. If the backend has to change a shape, it changes *here first*. Pair this with the engineering plan (`credit-analyzer-plan.md`); this doc is the frontend's single source of truth.
>
> **Golden rules for the frontend:**
> 1. The frontend holds **no secrets** — no OpenAI key, no Supabase service key, no GHL token. You only ever call our Vercel endpoints and PUT a file to a short-lived signed URL we give you.
> 2. **Show all three bureau scores** (TransUnion, Experian, Equifax) everywhere a score appears. Every score-bearing field below is an **array of three**, one per bureau.
> 3. Never compute or guess a score/delta in the frontend. **Every number is rendered exactly as the backend sends it.** The math is ours; the display is yours.
> 4. Always render the **disclaimers** we return (`disclaimer` fields). Legal requires it (estimated ≠ guaranteed; we are not a credit-repair org).

---

## 1. The flow at a glance

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │ STEP 1  Consent + gate      POST /api/consent      → { consentId }    │
 │         (collect email/phone, show consent copy, get the OK)          │
 ├─────────────────────────────────────────────────────────────────────┤
 │ STEP 2  Ask for upload URL  POST /api/upload-url   → { reportId, url }│
 ├─────────────────────────────────────────────────────────────────────┤
 │ STEP 3  Upload the PDF      PUT  <signed url>      (browser→Supabase) │
 │         direct to storage — NOT through our API                       │
 ├─────────────────────────────────────────────────────────────────────┤
 │ STEP 4  Start analysis      POST /api/analyze      → { status }       │
 ├─────────────────────────────────────────────────────────────────────┤
 │ STEP 5  Poll for result     GET  /api/status       → { status, data }│
 │         (spinner ~15–45s) until status = "analyzed"                   │
 ├─────────────────────────────────────────────────────────────────────┤
 │ STEP 6  Render analysis: 3 scores + reason codes + suggested          │
 │         scenarios ("the personalized questions")                      │
 ├─────────────────────────────────────────────────────────────────────┤
 │ STEP 7  User toggles scenarios → POST /api/simulate → live estimate   │
 │         (instant, no spinner — this is cheap and synchronous)         │
 ├─────────────────────────────────────────────────────────────────────┤
 │ STEP 8  (optional) Delete    POST /api/delete       → { status }      │
 └─────────────────────────────────────────────────────────────────────┘
```

**Two speeds to design for:**
- **Steps 4–5 (analysis) are SLOW** (tens of seconds — a big PDF goes to an AI vision model). Show a progress state and **poll**.
- **Step 7 (simulate) is INSTANT** (deterministic math, no AI). The user can toggle paydown sliders and see the estimate update in real time. No spinner needed.

---

## 2. Conventions

- **Base URL:** `https://<our-vercel-app>.vercel.app` — provided to you separately. All paths below are relative to it. **CONFIRM the exact host before launch.**
- **Method/format:** JSON over HTTPS. Send `Content-Type: application/json`. All bodies and responses are JSON **except** the file PUT in Step 3 (raw PDF bytes).
- **CORS:** your GHL embed origin must be on our allowlist. If you get a CORS error, your origin isn't allowlisted yet — send it to us. (We echo the allowed origin per the existing gatekeeper CORS setup.)
- **Auth:** none from the frontend. Identity is the email/phone you pass in Step 1; the backend ties everything to a GHL contact. There are **no API keys in the browser.**
- **Errors:** non-2xx responses carry `{ "error": "human-readable message" }`. See §11.
- **No raw PII returned:** we never send back SSN, date of birth, street addresses, or full account numbers. Account numbers arrive masked (e.g. `"52009400****"`) if present at all.

---

## 3. STEP 1 — Consent + gate

`POST /api/consent`

Runs the one-use gate **and** records consent. **No upload may happen until this returns `ok`.**

**No contact form.** Per client request, the UI does **not** ask the user to type name/email/phone. Identity comes from context, not a form:

- **If your GHL embed already knows the contact** (they came through the funding funnel): read the contact's **email/phone from the GHL context / merge fields** and pass them here **silently**. The user never sees a field.
- **If the embed is fully public** (no known contact): see §3.1 — this path is an **open decision**; don't build the public fallback until backend confirms.
- **⚠️ We cannot get email/phone from the uploaded PDF.** Credit reports don't contain them (verified — reports carry name/DOB/address only). And the gate must run *before* the PDF is processed, so identity can't come from the file. Identity must come from GHL context.

**One-click consent stays.** No form ≠ no consent. Show a single **"I authorize this analysis"** checkbox/button with the consent copy before upload, and call this endpoint when they click it. That click is the consent event; the fields below are filled from GHL context, not typed.

**Request**
```jsonc
{
  "email": "barbara@example.com",   // from GHL contact context (NOT a typed field). email OR phone required.
  "phone": "+12165551234",          // from GHL contact context
  "firstName": "Barbara",           // optional, from GHL context if available
  "lastName": "Sternberg",          // optional
  "consentVersion": "2026-08-v1"    // version string of the consent copy shown by the "I authorize" step
}
```

**Response — allowed**
```jsonc
{
  "status": "ok",
  "consentId": "c_9f2a...",
  "gate": { "status": "gate_open", "wouldClose": false, "enforced": false }
}
```
> The `gate` object is **observability** — it reports what the gate saw (`gate_open` | `gate_closed` | `no_contact` | `unknown`) and whether enforcement is on. Handy while testing; the UI can ignore it in production.

**Response — gate closed (already used the analyzer)**
```jsonc
{ "status": "gate_closed", "message": "This contact has already used the credit analyzer." }
```
> **Frontend:** on `gate_closed`, show the "you've already used this" screen and **stop** — do not proceed to upload. (Mirrors the existing funding-analyzer lockout.) This is a **200 OK**, not an error.
>
> ⚠️ **Testing mode (current):** gate enforcement is **OFF** (`CREDIT_GATE_ENFORCED=false`), so `/api/consent` will **not** return `gate_closed` yet — it always returns `ok` (with `gate.wouldClose` telling you what *would* happen). Still build the `gate_closed` screen now; it activates when the backend flips enforcement on for production.

### 3.1 If the embed is fully public (open decision — don't build yet)

If there's **no** GHL contact to inherit email/phone from, the "no form" goal can't fully hold — the backend still needs *something* to gate on. Backend will confirm one of:
- **Single email field** — the one unavoidable input (not a full form), still passed to `/api/consent`; or
- **IP + global-cap gate only** — truly no input, but weaker abuse control and no lead capture (`/api/consent` would gate on IP alone).

**Do not build the public fallback until backend confirms the deployment context.** Default assumption for now: **GHL knows the contact** and you pass it silently.

---

## 4. STEP 2 — Request an upload URL

`POST /api/upload-url`

**Request**
```jsonc
{ "consentId": "c_9f2a..." }
```

**Response**
```jsonc
{
  "reportId":  "r_71c4...",     // use this for every later call (analyze/status/simulate/delete)
  "uploadUrl": "https://<supabase>/storage/v1/object/upload/sign/...token...",
  "expiresAt": "2026-08-06T21:15:00Z",   // signed URL is short-lived — upload promptly
  "constraints": { "maxBytes": 10485760, "maxPages": 15, "mimeType": "application/pdf" }  // 🔜 values may tune
}
```
> **Frontend:** hold onto `reportId`. Enforce `constraints` **before** uploading (reject >10 MB / non-PDF client-side for a nicer error) — but the backend enforces them too.

---

## 5. STEP 3 — Upload the PDF (browser → Supabase, direct)

**`PUT` the raw file to `uploadUrl`.** This does **not** go through our API — the file goes straight to storage so large PDFs don't hit serverless limits.

```js
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "application/pdf" },
  body: fileBlob,                 // the File/Blob from the <input type=file>
});
// A 200/201 from Supabase means the bytes are stored. Then call /api/analyze.
```
> **Frontend:** only PDFs. On a failed PUT (expired URL, too big), send the user back to Step 2 to mint a fresh URL. Do **not** retry analyze until the PUT succeeds.

---

## 6. STEP 4 — Start analysis

> ✅ **Now live (mock mode).** `/api/analyze` + `/api/status` are deployed. Until the backend sets an OpenAI key they return a **realistic MOCK** analysis (tri-bureau VantageScore sample) with `"mock": true` on the analyze response — so you can wire the loading screen and the 3-score display for real now, not against a stub. The shape is identical when real extraction turns on.

`POST /api/analyze`

**Request**
```jsonc
{ "reportId": "r_71c4..." }
```

**Response (recommended async pattern)**
```jsonc
{ "status": "processing" }
```
> The backend may run inline (returning `analyzed` + the full payload directly) or async (`processing`). **Build for async:** if you get `processing`, go to Step 5 and poll. If you happen to get `analyzed` with a `analysis` object inline, skip straight to Step 6.

`status` is always one of: `awaiting_upload | processing | analyzed | failed`.

---

## 7. STEP 5 — Poll for the result

`GET /api/status?reportId=r_71c4...`

Poll every ~2–3 seconds until `status` is `analyzed` or `failed`. Expect **15–45 seconds** total.

**While processing**
```jsonc
{ "status": "processing" }
```

**Failed**
```jsonc
{ "status": "failed", "error": "We couldn't read this report. Please upload the full PDF from your credit-monitoring service." }
```
> **Frontend:** show a friendly retry screen; offer to upload again. (A fresh upload = new `reportId` from Step 2.)

**Done** — returns the full **analysis object** (see §8):
```jsonc
{ "status": "analyzed", "analysis": { /* §8 */ } }
```

---

## 8. STEP 6 — The analysis object (what you render)

This is the heart of the contract. **Every score-bearing field is an array of three bureaus.**

```jsonc
{
  "reportId": "r_71c4...",
  "reportMeta": {
    "vendor": "IdentityIQ",
    "reportType": "3B",                 // "3B" = tri-bureau (expected) | "1B" = single-bureau
    "reportDate": "2026-07-14",
    "scoreModel": "VantageScore 3.0",   // display this — it's NOT FICO; the model matters
    "scale": [300, 850]
  },

  // ── SHOW ALL THREE ──────────────────────────────────────────────
  "scores": [
    { "bureau": "TransUnion", "value": 646, "band": "Fair",
      "reasonCodes": [
        "You have too many delinquent or derogatory accounts",
        "Balances on revolving accounts are too high compared to credit limits",
        "Too many of the delinquencies on your accounts are recent"
      ] },
    { "bureau": "Experian",   "value": 643, "band": "Fair", "reasonCodes": [ /* ... */ ] },
    { "bureau": "Equifax",    "value": 639, "band": "Fair", "reasonCodes": [ /* ... */ ] }
  ],

  // Portfolio snapshot for a summary panel. Per-bureau because bureaus disagree.
  "summary": {
    "openAccounts":       [ { "bureau": "TransUnion", "value": 8 },  { "bureau": "Experian", "value": 8 },  { "bureau": "Equifax", "value": 9 } ],
    "totalBalances":      [ { "bureau": "TransUnion", "value": 435665 }, { "bureau": "Experian", "value": 434303 }, { "bureau": "Equifax", "value": 435118 } ],
    "revolvingUtilization": [ { "bureau": "TransUnion", "value": 0.86 }, { "bureau": "Experian", "value": 0.85 }, { "bureau": "Equifax", "value": 0.85 } ],
    "hardInquiries24mo":  [ { "bureau": "TransUnion", "value": 16 }, { "bureau": "Experian", "value": 7 }, { "bureau": "Equifax", "value": 3 } ],
    "publicRecords":      [ { "bureau": "TransUnion", "value": 0 },  { "bureau": "Experian", "value": 0 },  { "bureau": "Equifax", "value": 0 } ]
  },

  // Accounts, mainly for an expandable "your accounts" list. `actionable` tells you which
  // ones the simulator can act on (open + revolving + individually owned).
  "accounts": [
    {
      "accountId": "acct_citi_5424",        // stable id — pass this to /api/simulate
      "creditor": "CITI",
      "type": "revolving",                  // revolving | installment | mortgage | auto | other
      "detail": "Credit Card",
      "ownership": "individual",            // individual | joint | authorized_user
      "actionable": true,                   // FALSE for joint/AU/closed → don't offer paydown
      "perBureau": [
        { "bureau": "TransUnion", "status": "open", "balance": 5104, "creditLimit": 5440, "utilizationPct": 0.94, "pastDue": 0 },
        { "bureau": "Experian",   "status": "open", "balance": 5104, "creditLimit": 5440, "utilizationPct": 0.94, "pastDue": 0 },
        { "bureau": "Equifax",    "status": "open", "balance": 5104, "creditLimit": 5440, "utilizationPct": 0.94, "pastDue": 0 }
      ]
    },
    {
      "accountId": "acct_capone_au_4388",
      "creditor": "CAP ONE",
      "type": "revolving", "detail": "Credit Card",
      "ownership": "authorized_user",
      "actionable": false,                  // authorized-user → informational only
      "note": "You're an authorized user on this card — paying it down may not be in your control.",
      "perBureau": [ { "bureau": "Equifax", "status": "open", "balance": 3391, "creditLimit": 4500, "utilizationPct": 0.75, "pastDue": 0 } ]
    }
    // ... closed/paid accounts included with actionable:false, for the history view
  ],

  // ── THE "PERSONALIZED QUESTIONS" (§14 of the plan) ──────────────
  // Backend-curated, ranked, and CAPPED. Render these as the default simulator suggestions.
  // Each one is a ready-to-run scenario: its `actions` array is a valid /api/simulate input.
  "suggestedScenarios": [
    {
      "id": "citi-to-10pct",
      "title": "Pay down your Citi card",
      "rationale": "This card is about 94% used. Getting it under 10% is your single biggest quick win.",
      "effort": { "payDownAmount": 4560, "toUtilizationPct": 0.10, "accountId": "acct_citi_5424" },
      "estimatedImpact": {
        "perBureau": [
          { "bureau": "TransUnion", "before": 646, "after": 664, "delta": 18 },
          { "bureau": "Experian",   "before": 643, "after": 660, "delta": 17 },
          { "bureau": "Equifax",    "before": 639, "after": 655, "delta": 16 }
        ],
        "deltaRange": [16, 18]              // convenience: min–max across bureaus, for a headline
      },
      "actions": [ { "type": "paydown_revolving", "accountId": "acct_citi_5424", "targetUtilizationPct": 0.10 } ],
      "reachesGoal": { "tier": "660", "reached": true }   // optional funding-tier hook; omit if N/A
    }
    // ... capped at ~5 (see `recommendationsMeta.cappedAt`)
  ],

  "recommendationsMeta": { "cappedAt": 5, "generatedBy": "engine+template" },  // "engine+ai" once AI phrasing is on

  // Honesty banner. Some negatives (past late payments) heal only with TIME, not an action —
  // when that's the dominant factor, we say so here. RENDER THIS.
  "coachNote": "Your biggest score drag right now is past late payments, which improve as they age. Paying down your cards helps too and is the fastest thing in your control.",

  "disclaimer": "Estimated scores only — not a guarantee. We are not FICO or VantageScore, and we are not a credit-repair organization. We do not dispute items on your behalf."
}
```

### 8.1 Rendering notes
- **Scores:** three cards/gauges side by side (TU / EX / EQ), each with its band and its own reason-code list. Don't average them.
- **Suggested scenarios = the client's "personalized questions."** Render them as selectable cards ("What if I pay down Citi?"). Each shows its per-bureau impact. Selecting/toggling them drives Step 7.
- **`actionable: false`** accounts (joint, authorized-user, closed): show in the account list for context, but **never** offer a paydown control for them. Surface the `note` if present.
- **Always render `coachNote` and `disclaimer`.**

---

## 9. STEP 7 — Simulate (compound / multi-item scenarios)

`POST /api/simulate`

This is the interactive engine — **deterministic and fast** (no AI, no cost), so call it on every slider change. It handles both UI control groups at once: per-card **paydowns** and the abstract **factor sliders**.

**Request**
```jsonc
{
  "reportId": "r_71c4...",
  "scenario": {
    // "Pay Down Your Balances" cards — pay by dollar amount OR to a target utilization.
    "payDown": [
      { "accountId": "acct_1_citi", "targetUtilizationPct": 0.10 },
      { "accountId": "acct_2_capital-one", "amount": 500 }
    ],
    // "Your Score, Your Control" sliders (all optional). utilizationPct takes only `to`;
    // the rest take { from, to } — send the value the UI currently shows as `from`.
    "factorChanges": {
      "utilizationPct":   { "to": 0.10 },
      "paymentOnTimePct": { "from": 0.90, "to": 0.98 },
      "lengthYears":      { "from": 7, "to": 10 },
      "creditMixTypes":   { "from": 2, "to": 3 },
      "recentInquiries":  { "from": 3, "to": 1 }
    }
  }
}
```
Notes:
- Every field is optional — send only what the user changed. An empty `scenario` (`{}`) just echoes the base scores (use it for "Reset").
- `payDown` and `factorChanges.utilizationPct` are two ways to drive utilization; if both are sent, `utilizationPct` wins.
- Only put `payDown` entries for accounts where `actionable: true` (§8).
- **A suggested scenario is directly runnable** — pass its `actions` array straight in as `scenario.payDown`: `{ "reportId": "...", "scenario": { "payDown": suggestion.actions } }`.

**Response**
```jsonc
{
  "reportId": "r_71c4...",
  "perBureau": [
    {
      "bureau": "TransUnion",
      "baseScore": 646,
      "estimatedScore": 668,
      "estimatedRange": [662, 674],
      "waterfall": [                        // per-action attribution, in applied order
        { "label": "Pay Citi to 10%",     "delta": 18, "inCombination": false },
        { "label": "Pay Capital One $500", "delta": 4,  "inCombination": true }
      ]
    },
    { "bureau": "Experian", "baseScore": 643, "estimatedScore": 663, "estimatedRange": [657, 669], "waterfall": [ /* ... */ ] },
    { "bureau": "Equifax",  "baseScore": 639, "estimatedScore": 658, "estimatedRange": [652, 664], "waterfall": [ /* ... */ ] }
  ],
  "disclaimer": "Estimated only — not a guarantee."
}
```

### 9.1 Simulate rendering notes
- **Deltas are NOT additive** — that's why we return a `waterfall` (each step's marginal contribution *in combination*) and a **recomputed** `estimatedScore`, not a sum. Show the waterfall as a step chart; label `inCombination: true` items as "in combination" so users don't add them up themselves.
- Show all three bureaus' `estimatedScore` + `estimatedRange`. Lead with the **range**, not a single hero number.
- Empty `scenario` (`{}`) → echoes `baseScore` as `estimatedScore` (no-op). Use for "Reset".

### 9.2 ⚠️ "How Your Score Is Calculated" panel — use VantageScore weights
Your current panel shows **FICO** weights (35/30/15/10/10), but the score is **VantageScore 3.0** and the engine uses VantageScore-3.0-informed influence. For consistency between the panel and the math, update the panel to:

| Factor | Weight |
|---|---|
| Payment History | **40%** |
| Credit Utilization (amounts owed) | **34%** |
| Length of Credit History | **13%** |
| Credit Mix | **8%** |
| New Credit Inquiries | **5%** |

(Backend source of truth: `VANTAGESCORE_3_WEIGHTS` in `lib/credit-simulator.ts`.)

### 9.3 "Quickest Path to <target>" button

`POST /api/best-path` — one click computes the smartest order of paydowns to reach a target score, and returns a **runnable scenario** you apply to the simulator (auto-moving the components).

**Request**
```jsonc
{ "reportId": "r_71c4...", "target": 700 }   // target optional; omit to auto-pick the next tier
```
> Pick the button's target from the current score: e.g. label it **"Show Quickest Path to 850"** when the score is already high, **"...to 700"** otherwise. Pass that number as `target`. Omit `target` and the backend auto-selects the next tier (660/700/740/780/800/850).

**Response**
```jsonc
{
  "reportId": "r_71c4...",
  "target": 700,
  "reachable": true,
  "baseScore": 643,
  "projectedScore": 704,
  "totalPayDown": 8100,
  "steps": [                                  // ordered — "pay this FIRST"
    { "order": 1, "accountId": "acct_2_capital-one", "creditor": "CAPITAL ONE",
      "action": "Pay under 10%", "payDownAmount": 3990, "pointsGained": 34, "scoreAfter": 677 },
    { "order": 2, "accountId": "acct_1_citi", "creditor": "CITI",
      "action": "Pay under 10%", "payDownAmount": 4560, "pointsGained": 27, "scoreAfter": 704 }
  ],
  "scenario": { "payDown": [ { "accountId": "acct_2_capital-one", "targetUtilizationPct": 0.10 },
                             { "accountId": "acct_1_citi", "targetUtilizationPct": 0.10 } ] },
  "projected": [ { "bureau": "TransUnion", "baseScore": 646, "estimatedScore": 707, "estimatedRange": [700,714], "waterfall": [ ... ] }, ... ],
  "note": null,
  "disclaimer": "Estimated only — not a guarantee."
}
```
Frontend behavior on click:
- **Apply `scenario` to the UI** — select the matching "Pay under 10%" presets on the cards named in `steps`, and update the three gauges to `projected[].estimatedScore`. (You can also just re-POST `scenario` to `/api/simulate` — same result.)
- **Render `steps` as an ordered checklist** ("1. Pay off CAPITAL ONE first (+34) → 677", "2. Then CITI (+27) → 704"), with `totalPayDown` as the cash needed.
- **If `reachable: false`, show `note`** — paydowns alone won't reach the target (the rest needs time/payment history). Do NOT imply the target is guaranteed.

---

## 10. STEP 8 — Delete my analysis (optional but recommended)

`POST /api/delete`

For a "delete my data" button (supports the privacy promise in the consent copy).

**Request** `{ "reportId": "r_71c4..." }` → **Response** `{ "status": "deleted" }`

---

## 11. Error handling

| HTTP | When | Body | Frontend action |
|---|---|---|---|
| **200** `gate_closed` | Already used the analyzer | `{ "status": "gate_closed", ... }` | Show "already used" screen; stop |
| **400** | Bad/missing fields, no email+phone, non-PDF | `{ "error": "..." }` | Fix input, re-submit |
| **404** | Unknown `reportId` | `{ "error": "..." }` | Restart the flow |
| **413** | File too big / too many pages | `{ "error": "..." }` | Ask for a smaller PDF |
| **429** | Rate limited (per-IP or global cap) | `{ "error": "...", "retryAfter": 3600 }` | Show "try again later" |
| **500 / 502** | Server/AI failure | `{ "error": "..." }` | Show retry; offer re-upload |

`status: "failed"` on `/api/status` is the analysis-specific failure (unreadable PDF) — handle it like a 500 but with the friendly re-upload prompt (§7).

---

## 12. What the frontend must NOT do
- ❌ Don't store or display SSN/DOB/addresses — we don't send them.
- ❌ Don't compute scores, deltas, or utilization in JS — render our numbers only.
- ❌ Don't call OpenAI/Supabase/GHL directly — only our Vercel endpoints (+ the one signed-URL PUT).
- ❌ Don't offer paydown controls on `actionable: false` accounts.
- ❌ Don't drop the `disclaimer` / `coachNote` — legal + honesty requirement.

---

## 13. Open items to confirm with backend before build
1. **Base URL / allowlisted origin** for the GHL embed (CORS).
2. **Identity source (§3 / §3.1):** does the GHL embed already know the contact (pass email/phone silently — assumed) or is it fully public (needs the §3.1 fallback)? Decides whether any input at all is shown.
3. **Consent copy + its `consentVersion` string** (legal-approved text behind the one-click "I authorize" step; the version we log must match).
4. **Final upload constraints** (`maxBytes` / `maxPages`) — placeholders above.
5. **Sync vs. async `/api/analyze`** for v1 — build for async/polling regardless (safe either way).
6. **Single-bureau (`1B`) reports** — will the UI need to gracefully render a report with only one `scores` entry, or do we assume tri-bureau only at launch?
