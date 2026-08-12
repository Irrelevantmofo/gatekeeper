# Credit Simulator — Results Email + Feedback Loop Plan

> **What this is:** the approach for (a) capturing the user's email via a **timed popup on the simulator screen**, (b) emailing them their **analysis + recommended actions** (value delivery + a "wanted" email that trains deliverability), and (c) a follow-up **feedback email** that elicits a reply → improves sender reputation and captures 1–5 sentiment.
>
> **Companion docs:** [`credit-analyzer-plan.md`](./credit-analyzer-plan.md) (backend architecture), [`credit-analyzer-build-log.md`](./credit-analyzer-build-log.md) (what's built), [`crm-capture-plan.md`](./crm-capture-plan.md) (analysis → GHL contact sync).
>
> **Where the work lives:** email capture = **frontend popup** (`identityIQ-credit-score-simulator`); attaching the email + firing the workflow = **one small backend endpoint** (`gatekeeper`, additive, **BAT untouched**); the emails themselves = **GHL Workflow** (config, no deploy).

---

## 0. TL;DR — the flow

```
Simulator screen showing (scores + fastest-path/summary visible)
        │  ~30s later (once they've seen value)
        ▼
POPUP: "Want a copy? We'll email your analysis + recommended actions."
       + disclaimer: "check your spam/junk folder — mark us 'not spam' so it lands next time"
        │  user enters email
        ▼
POST /api/report-email { reportId, email }
   → upsert email onto the GHL contact                (contact already has name + score + credit_actions_html from analyze)
   → apply tag `credit-results-optin`                 (workflow trigger — email is now guaranteed present)
        │
        ▼
GHL Workflow (trigger = tag `credit-results-optin`)
   └─ ONE email: results + recommended actions + feedback questions ("just reply 1–5")
      (value delivery + reply-eliciting, in a single send)
```

> **Design locked with client:** a **single** email carries the results, the recommended actions (rendered from `credit_actions_html`), **and** the two feedback questions ("rate 1–5" + "what to improve — just hit reply"). No separate feedback email; the future booking/YouTube email is **out of scope for now**.

Two hard truths this design solves:
1. **The tool is phone-only today** — no email is ever captured (`/api/otp/request` = phone only; `Index.tsx` sends no email). The popup fixes that at the highest-intent moment.
2. **Automated mail hits spam today.** Email A is an *expected, wanted* email (they just asked for it) → a deliverability asset. Email B's reply is the strongest "wanted mail" signal to Gmail/Outlook. Neither works unless the sender is authenticated — see §6.

---

## 1. Decisions

| # | Decision | Choice | Notes |
|---|----------|--------|-------|
| 1 | How to capture email | **Timed popup on the simulator screen** (~30s after results are visible), value-framed ("email me my analysis + recommended actions") | Higher intent than an inline field. Dismissible. §2. |
| 2 | Rating capture | **Reply-only (v1)** | "Just hit reply with 1–5." Zero config; maximizes deliverability. Structured CSAT deferred. §4.2. |
| 3 | Sender identity / domain | **Reuse current GHL sending setup** | Fastest. **Risk: likely why mail spams.** Mandatory auth pre-flight in §6 (no full domain migration). |

**Open (recommended defaults in brackets):**
- Popup dismissible? [**Yes** — value-add, not a gate; show once per session.]
- Popup timing trigger [**30s after best-path result OR summary first renders; fallback 45s after simulator mount** so passive users still get asked].
- Results-email content source [**GHL custom fields already synced** for the numbers; add a small `credit_actions_html` field for the recommended-actions list — §5.1].

---

## 2. Frontend — the email-capture popup

**Component:** new `ResultsEmailModal.tsx`, rendered by `SimulatorScreen.tsx` (which already holds `reportId`).

**When it appears:**
- Start a timer when the user reaches a "seen value" moment. In `SimulatorScreen`, the natural signals are: `bestPath` state becomes non-null (fastest-path card rendered, `SimulatorScreen.tsx:318`) or `showFloatingSummary` becomes true (`:233`). Fire the popup **30s after the first of those**.
- **Fallback:** if neither happens (passive viewer), fire **45s after mount** — scores are visible immediately in the sticky card (`:269`), so there's always value on screen.
- **Show once per session** (a `useRef`/`sessionStorage` guard), so it never nags.

**What it says (value framing, not "feedback"):**
> **Want a copy of your results?**
> Enter your email and we'll send your full 3-bureau analysis and your personalized recommended actions — free.
> `[ email input ]`  `[ Email me my results ]`   ·   *No spam. Unsubscribe anytime.*
> `[ No thanks ]`

- Audience-fit (50–70): 18px+ text, large button, one field, high contrast (matches existing design system).
- Basic email validation client-side (protects list hygiene, §6).

**On submit:** `POST {BASE_URL}/api/report-email { reportId, email }` → on 200, show a brief "✓ Sent! Check your inbox." and close. On failure, keep it non-blocking (they still have the on-screen results).

---

## 3. Backend — one new endpoint (`gatekeeper`)

**`POST /api/report-email` → `{ reportId, email }`** (new route, additive; imports `ghl.ts` read-only-style like the other credit routes; BAT untouched):

1. Validate + `normalizeEmail(email)`.
2. Load the `reports` row by `reportId` → get `contact_ref` (set at consent). Also store the email on the report/consent row for our records.
3. If GHL configured + `contact_ref`: `upsertContact({ email, ... })` so the contact now has a sendable address (the analyze step already put name + score custom fields there).
4. Apply tag **`credit-results-optin`** → this is what triggers the GHL workflow (guarantees email exists before any send). Best-effort try/catch — a GHL hiccup never 500s the popup.
5. Return `{ ok: true }`.

**Why a new tag instead of reusing `credit-analyzer-used`:** `credit-analyzer-used` is applied back at `/api/analyze` — *before* the popup, when there's no email yet. Triggering the workflow on the **opt-in tag** guarantees the email is present when Email A sends.

---

## 4. GHL Workflow — one email

**Trigger:** `Contact Tag Added = credit-results-optin`. **Filters:** email present (always true here) · enter once.

**Action:** send a single email that both delivers value and elicits a reply. Renders the personalized block from the `credit_actions_html` custom field (GHL renders custom-field HTML — same mechanism as the funding-analyzer results email) plus the static feedback questions. Plain, personal, **reply-first** (the deliverability/whitelisting lever):

> **Subject:** Your credit results, {{contact.first_name}}
>
> Hi {{contact.first_name}}, here's what we found in your report:
>
> `{{contact.credit_actions_html}}`   ← 3-bureau scores, what's holding you back, recommended next steps
>
> **Two quick questions — just hit reply:**
> 1. On a scale of **1 to 5**, how helpful was this?
> 2. What's one thing we could do to improve it?
>
> Even a one-word reply helps a lot — thank you!
> — {{sender name}}, Credit CRB
>
> *P.S. If this landed in your spam or Promotions folder, please drag it to your inbox and mark "Not spam" so we can reach you next time.*

- Replies land in GHL Conversations (filterable via the existing `credit-simulator` tag). A human reads the 1–5 + comment — no forms/links needed (reply-only, decision #2).
- The email is *expected* (they just asked for it) → strong positive engagement → helps deliverability. The reply is the strongest "wanted mail" signal.

### 4.1 Out of scope for now
The future booking + YouTube follow-up (previously "Email C") is **deferred** per client. The workflow is a single send; a follow-up branch can be added later without changing the trigger. ⚠️ When it is added: **CROA guardrail** — may *invite* deletion questions, must **not promise** deleting/removing accounts.

---

## 5. Results-email content — data availability

### 5.1 What GHL already has vs. needs
- **Has** (from `/api/analyze` CRM sync): name, middle score / band, funding tier, utilization, key counts, and a best-path summary → enough for the headline numbers.
- **Needs for "recommended actions":** the ranked action list as renderable content. Recommend adding a `credit_actions_html` (or plain-text) custom field to the CRM sync — a small, contained addition mirroring the existing `matched_offers_html` pattern — so Email A can list the actual paydown steps. If we don't add it, Email A v1 can send scores + a "your recommended actions are in the tool" CTA and we enrich later.

---

## 6. Deliverability — required pre-flight (mail spams today)

Reusing the current sender is viable **only if authenticated**. Before enabling the workflow, confirm:
1. **SPF** passes for the sending domain.
2. **DKIM** signed + valid in GHL (missing/failing DKIM is the #1 cause of GHL mail hitting spam).
3. **DMARC** record exists + aligned.
4. **From-address is monitored** (not `noreply@`), matches the authenticated domain — replies to Email B must be seen.
5. **List hygiene** — only send to the validated captured email; suppress bounces.

> Honest note: Email A (wanted) + Email B replies *raise* reputation over time, but can't *repair* broken auth. If mail still spams after 1–4, next step is a dedicated warmed sending subdomain (deferred by decision #3; revisit if spam persists).

---

## 7. Build sequence

1. **Frontend:** `ResultsEmailModal.tsx` + timer/guards in `SimulatorScreen.tsx`; POST to `/api/report-email`.
2. **Backend:** `POST /api/report-email` (attach email + `credit-results-optin` tag). `tsc` clean; confirm BAT untouched.
3. *(optional)* add `credit_actions_html` to CRM sync for richer Email A (§5.1).
4. **GHL pre-flight:** verify SPF/DKIM/DMARC + monitored from/reply-to (§6).
5. **GHL workflow:** trigger `credit-results-optin` → Email A → wait 1d → Email B (+ `feedback-sent` tag). Email C branch later.
6. **Validate:** real analysis → simulator → popup at ~30s → submit email → contact gets email + `credit-results-optin` → Email A **lands in inbox** (test Gmail + Outlook) → Email B next day → reply shows in Conversations.

---

## 8. Open items

- Popup copy/placement final wording; dismiss behavior (once-per-session recommended).
- Whether Email A ships with full action list (`credit_actions_html`) or a CTA-only v1.
- Exact waits (1d / 3d starting points).
- If spam persists after §6 → revisit decision #3 (dedicated warmed subdomain).
