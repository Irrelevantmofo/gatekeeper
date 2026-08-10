# Phone-OTP Access Gate — Backend Plan

> **Status:** Planning (2026-08-08). Backend plan for gating the Credit Simulator behind **phone verification (SMS OTP)**, with verified contacts saved to **GoHighLevel** for SMS follow-up.
>
> **Client decision:** access requires phone OTP. **Rationale:** lead quality + reliable SMS follow-up (more reliable than email).
>
> ⚠️ This supersedes the earlier "no form / pull phone silently from GHL context" idea in `credit-analyzer-plan.md` §4.2. Identity is now an **explicit, verified phone number**, not an inherited one.
>
> **✅ FINAL DECISION (2026-08-11, revised): BACKEND-owned OTP, sent via GHL's SMS API.** We generate/store(hashed)/verify the code ourselves (Supabase `phone_verifications`, migration `0002`) and deliver it through **GHL Conversations `POST /conversations/messages`** on the account's existing A2P 10DLC. This keeps the backend `verificationToken` gate + custom rate limiting, while avoiding Telnyx/10DLC-of-our-own. Built: `lib/otp.ts` (code gen/hash/store/verify + `sendGhlSms`), `POST /api/otp/request`, `POST /api/otp/verify`. **Requires the GHL token scope `conversations/message.write`.** Dev bypass still works (`OTP_BYPASS=on`, `000000`). _(Supersedes both the Telnyx-Verify and GHL-native-form approaches below; those notes are historical.)_

> **Earlier (2026-08-11): use GHL's built-in phone verification.** The GHL account **already has A2P 10DLC registered**, so GHL Forms/Surveys' native **"Verify Phone" OTP** can be used directly — it sends the code via LC Phone and auto-flags the contact verified. This **replaces the Telnyx path** and removes our OTP code from the critical path:
> - **Frontend:** gate the simulator behind a GHL form/survey with the native Verify-Phone element. GHL captures + verifies the phone and tags the contact; then the tool loads.
> - **Backend:** the Telnyx OTP is **parked** (`/api/otp/request`, `/api/otp/verify`, `lib/otp.ts` remain but unused). Set **`OTP_REQUIRED=off`** so `/api/consent` doesn't demand our token. Everything downstream is unchanged: consent → upload → analyze → CRM sync + `credit-analyzer-used` re-entry tag.
> - Telnyx env vars are no longer needed. Optional later: have `/api/consent` verify GHL's "phone verified" flag server-side for defense-in-depth.
>
> _Prior (2026-08-08) decision — Telnyx Verify — is superseded but the code is left in place as a fallback if GHL SMS is ever unavailable._

---

## 1. Goal & flow

**Flow (frontend = GHL Studio thin client; backend = these endpoints):**

```
1. Phone entry screen  → user types phone + ticks SMS consent
      → POST /api/otp/request { phone }
      → backend: upsert GHL contact, generate code, SMS it, rate-limit
2. Code entry screen   → user types the 6-digit code
      → POST /api/otp/verify { phone, code }
      → backend: validate → tag contact "phone-verified" → return verificationToken
3. Upload unlocked     → existing flow, now gated by verificationToken:
      consent(+token) → upload-url → precheck → analyze → simulate
4. After successful analysis → backend enriches the GHL contact with the
      consumer's NAME (pulled from the PDF) and applies the `credit-analyzer-used`
      tag. That tag is the RE-ENTRY BLOCK (§3.5).
```

**Frontend collects the PHONE only** (+ SMS consent). Name comes from the PDF; email isn't needed for phone-OTP.

**Lead is captured even if they drop off:** the GHL contact is created at step 1 (tagged `phone-unverified`), upgraded to `phone-verified` at step 2, and enriched with the real name + `credit-analyzer-used` tag at step 4.

---

## 2. Why GHL sends the SMS (not a separate OTP vendor)

GHL has no native "OTP verify" API, so **we build the OTP logic** (generate, store-hashed, expire, verify) and use **GHL to deliver the SMS** and **hold the contact**. Keeping it in GHL means one system, the verified number lands in the CRM, and SMS follow-up works immediately.

- **Send channel:** GHL **Conversations API** over LC Phone (Twilio-backed), ~**$0.0079/SMS segment**. Reuses the existing `GHL_API_TOKEN` / `GHL_LOCATION_ID`.
- **⚠️ HARD PREREQUISITE — A2P 10DLC registration.** US carriers (AT&T/Verizon/T-Mobile) filter unregistered business SMS to near-zero delivery. The sub-account must complete **A2P 10DLC** (Agency → Settings → Phone Numbers → A2P 10DLC) **before** OTP will reliably deliver. This has carrier-approval lead time — start now.
- **Alternative considered:** a dedicated OTP provider (e.g. Twilio Verify) handles code gen/expiry/rate-limiting natively and is very robust — but it's a second vendor and the number wouldn't be GHL-native for follow-up. **Recommend GHL** (single system) *contingent on A2P being set up*; keep Twilio Verify as the fallback if GHL SMS deliverability is a problem.

---

## 3. Endpoints

### `POST /api/otp/request`
Body: `{ "phone": "+1..." , "firstName?": "", "lastName?": "" }`
1. Normalize phone to E.164 (reuse/extend `normalizePhone`).
2. **Rate-limit** (§6): per-phone/day, per-IP/day, global/day (cost + A2P reputation). Enforce a resend **cooldown** (e.g. 45s).
3. **Upsert the GHL contact** (existing `upsertContact`) — captures the lead now; tag `simulator-lead` (+ `phone-unverified`).
4. Generate a **6-digit** code; store **hash** (not plaintext) in `phone_verifications` with `expires_at` (~5 min), `attempts=0`.
5. **Send SMS** via GHL Conversations API to the contact: *"Your CreditCrb verification code is 123456. It expires in 5 minutes. Reply STOP to opt out."*
6. Return `{ ok: true, resendAfter: 45 }`. Never reveal whether the number "exists."

### `POST /api/otp/verify`
Body: `{ "phone": "+1...", "code": "123456" }`
1. Load the latest unexpired code for the phone. Check `attempts < max` and not expired; compare hashes.
2. **Fail** → increment `attempts`, return `{ ok: false, attemptsRemaining }` (generic; lock after max).
3. **Success** → set `verified_at`, tag the GHL contact `phone-verified` (remove/ignore `phone-unverified`), and issue a **short-lived verificationToken** (§5). Return `{ ok: true, verificationToken, contactId }`.

### Modify `POST /api/consent` (or `/api/upload-url`)
- Require `verificationToken`; validate signature + expiry + that it matches the submitted phone. **No valid token → no upload.** This replaces the old "email/phone from context" gate. The consent record links to the verified phone.

---

## 3.5 Name enrichment + re-entry block (client decision)

**Reuses the exact tag-gate pattern the Business Analyzer Tool already uses** (`app/api/submit/route.ts`, tag `business-analyzer-used`): look up the contact → if it carries the "used" tag, refuse; otherwise proceed and apply the tag on success. The Credit Analyzer does the same with **`credit-analyzer-used`** (already defined in `lib/credit.ts`).

- **Extraction change:** re-enable a **single** PII field — `consumer_name` (first/last) — in the extraction schema. Everything else stays excluded (SSN, DOB, full address, employers) — data-minimization holds for all but the name.
- **On successful `/api/analyze`:** (a) update the GHL contact's `firstName`/`lastName` from `consumer_name` (reuses `upsertContact`); (b) apply the `credit-analyzer-used` tag (idempotent — GHL merges tags, same as BAT's `addUsedTag`).
- **Re-entry block:** the tag *is* the block. At the OTP/consent gate, once the phone is verified, `searchContact` the number — if it already carries `credit-analyzer-used`, refuse upload with an "already used" response (same shape as BAT's `gate_closed`). **One verified phone → one analysis.**
- **Toggle:** `CREDIT_GATE_ENFORCED` — OFF during frontend testing (re-run freely), ON in production. Enrichment + tagging still happen regardless; only the *blocking* is gated by this flag.

---

## 4. Supabase data model

```sql
create table if not exists public.phone_verifications (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null,              -- E.164
  code_hash     text not null,              -- hashed OTP, never plaintext
  expires_at    timestamptz not null,
  attempts      int not null default 0,
  max_attempts  int not null default 5,
  verified_at   timestamptz,
  contact_ref   text,                       -- GHL contact id
  ip            inet,
  created_at    timestamptz not null default now()
);
create index if not exists phone_verifications_phone_idx on public.phone_verifications (phone, created_at desc);
```
- Enable RLS, deny-all (service-role only), consistent with the existing tables (`credit_analyzer_init` migration).
- Reuse the existing `rate_limits` table for OTP buckets (keys: `otp:phone:<p>:<day>`, `otp:ip:<ip>:<day>`, `otp:global:<day>`).

---

## 5. Verification token

**Recommend a stateless signed token** (HMAC-SHA256 over `{ phone, exp }` using `OTP_TOKEN_SECRET`), TTL ~15 min. Downstream endpoints verify the signature + expiry + phone match — no extra DB read.
- Alternative: store a session row and pass its id; simpler to revoke but adds a read. Stateless is fine given the short TTL.

---

## 6. Security & compliance

- **Codes:** hashed at rest, 6 digits, ~5 min expiry, **max 5 attempts**, then lock that code.
- **Resend cooldown** (~45s) + **rate limits**: per-phone/day, per-IP/day, and a **global/day cap** as a cost + anti-abuse circuit breaker (each SMS costs money and burns A2P reputation; an attacker could otherwise "SMS-bomb").
- **TCPA / opt-in (required):** the phone-entry screen must show SMS consent copy — *"By entering your number you agree to receive a verification code and occasional messages. Msg & data rates may apply. Reply STOP to opt out."* Include **"Reply STOP to opt out"** in the OTP message; honor opt-outs. Log the consent (tie to the `consents` record).
- **No enumeration / no leakage:** generic responses; never log full codes or tokens; scrub error traces.
- **A2P 10DLC** (see §2) — compliance + deliverability prerequisite.

---

## 7. Environment variables (additions)

```
OTP_LENGTH=6
OTP_TTL_MINUTES=5
OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_SEC=45
OTP_RATE_LIMIT_PER_PHONE_DAY=5
OTP_RATE_LIMIT_PER_IP_DAY=10
OTP_GLOBAL_DAY=            # daily SMS cost circuit-breaker
OTP_TOKEN_SECRET=          # HMAC signing secret for the verificationToken
OTP_VERIFICATION_TTL_MINUTES=15
OTP_BYPASS=off             # "on" for frontend testing → skips SMS + accepts a fixed dev code (no cost). Mirrors CREDIT_ANALYZE_MOCK.
# GHL SMS reuses GHL_API_TOKEN / GHL_LOCATION_ID; confirm an SMS-capable LC number + A2P 10DLC.
```

---

## 8. Build phases

- **Phase A — schema + request:** `phone_verifications` migration; `/api/otp/request` (upsert contact + generate + hash + send SMS + rate limit + cooldown).
- **Phase B — verify + token:** `/api/otp/verify` → validate, tag `phone-verified`, issue verificationToken.
- **Phase C — gate the upload:** require + validate verificationToken in `/api/consent` / `/api/upload-url`; update the frontend contract + flow.
- **Phase D — hardening:** rate-limit tuning, STOP/opt-out handling, logging scrub, `OTP_BYPASS` test mode.

---

## 9. Open decisions

1. ✅ **DECIDED — save on request** (tagged `phone-unverified`) → `phone-verified` on OTP success → enriched with real name + `credit-analyzer-used` tag after analysis (§3.5).
2. **OTP delivery = GHL SMS (recommended) vs Twilio Verify (fallback).** Depends on A2P 10DLC being live and delivering reliably (§2).
3. **A2P 10DLC status?** — confirm with client; it gates go-live and has approval lead time.
4. **Test mode:** ship `OTP_BYPASS=on` for frontend testing (fixed dev code, no SMS cost), like `CREDIT_ANALYZE_MOCK`.
5. ✅ **DECIDED — verified repeat visitors are BLOCKED** by the `credit-analyzer-used` tag (§3.5), exactly like BAT's `business-analyzer-used`. One verified phone → one analysis. (Enforced when `CREDIT_GATE_ENFORCED=on`.)
6. **International numbers?** — assume US-only at launch (matches the FCRA/US-only scope); reject non-US for now.

---

## 10. Sources
- GHL Conversations API / custom providers: https://marketplace.gohighlevel.com/docs/marketplace-modules/ConversationProviders/index.html
- GHL SMS pricing + A2P 10DLC: https://netpartners.marketing/gohighlevel-sms/
- LC Phone messaging policy (opt-in/opt-out): https://help.gohighlevel.com/support/solutions/articles/48001213941-lc-phone-messaging-policy
