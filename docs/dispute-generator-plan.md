# Smart Dynamic Dispute Generator — Build Plan

**Status:** Draft / planning
**Owner:** CreditCrb (Sam Sky)
**Stack:** Gatekeeper (Vercel Next.js edge) · OpenRouter · Supabase · GHL CRM
**Last updated:** 2026-08-12

---

## 0. Positioning & the compliance line (read this first)

The original request was: *"AI that reads dispute rejection letters and re-writes next-round letters using varied legal phrasing that bypasses the automated E-OSCAR filters."*

We are building the **substance-first** version of that, not a phrasing-obfuscation / filter-evasion tool. This is a deliberate design decision, not a limitation, for two grounded reasons:

1. **E-OSCAR does not read prose.** A CRA clerk reduces the entire dispute letter to **one of ~29 two-digit dispute reason codes** (Metro 2 / ACDV) before it reaches the furnisher. Optimizing phrasing to "beat the filter" optimizes the layer that gets discarded.
2. **Obfuscating templated disputes is the exact conduct that triggers liability.** Under the FCRA a furnisher/CRA may deem a dispute *frivolous or irrelevant* when it is vague, duplicative, evidence-free, or "prepared on forms supplied by a credit repair company." The Credit Repair Organizations Act (CROA) carries a **private right of action** (actual + punitive damages up to $1,000/violation individually; class actions up to the lesser of $500k or 1% of net worth; plus attorney's fees), with FTC + CFPB enforcement. Disputing accurate-but-negative items to mislead a bureau is independently illegal.

**What actually clears the frivolous filter and reaches a real investigation is specificity + evidence + procedural escalation.** The generator's job is therefore:

> Read the rejection → determine *why* it was rejected → select the correct escalation strategy → produce an individualized, evidence-grounded, legally-precise next-round letter for a specific factual/Metro 2 inaccuracy.

That output naturally avoids frivolous auto-rejection because it is genuinely substantive — which is also what maximizes deletion/correction outcomes.

### Hard guardrails (enforced in product, not just policy)
- **No disputing of items the user has not attested are inaccurate.** The tool requires a per-item accuracy attestation before it will draft.
- **No "shotgun/jamming"** — it disputes specific, identified inaccuracies, not "delete everything."
- **CROA disclosures + contract + no-upfront-fee handling** are treated as first-class product surfaces if CreditCrb operates as a CRO for clients.
- **Every generated letter is individualized** (facts, account details, and the specific rejection reason are woven in) — never a fill-in-the-blank template.
- **PII is treated as regulated data** (see §6). Dispute letters contain SSN, DOB, full account numbers.

---

## 1. How the dispute lifecycle actually works (design grounding)

```
Round 1 dispute (consumer → CRA)
      │
      ▼
E-OSCAR: clerk maps letter → 2-digit dispute code (ACDV) → furnisher
      │
      ▼
Furnisher reviews internal record → "Verified" / "Updated" / "Deleted"
      │
      ▼
CRA sends consumer a RESULTS / REJECTION letter  ◄── our input
      │
      ▼
Round 2: escalation chosen based on the rejection reason  ◄── our output
```

**The rejection reason determines the correct next move.** The generator's core intelligence is a classifier that maps a rejection letter to one of a small number of reason classes, each with a distinct escalation play:

| Rejection reason (classified) | Correct Round-2 strategy |
| :-- | :-- |
| "Verified as accurate" (no method shown) | **Method-of-Verification demand** under FCRA §611(a)(7) — force CRA to disclose procedure + furnisher contact |
| Deemed **frivolous / insufficient info** | Cure the defect: add specificity + evidence; re-file as a substantive single-item dispute |
| Verified but **Metro 2 field inconsistency** exists (e.g. DOFD, status, balance, date fields contradict) | **Metro 2 accuracy dispute** citing the specific non-compliant field |
| CRA verified but **furnisher never properly investigated** | **§623 direct dispute to the furnisher** (bypass the CRA) |
| **Procedural violation** by CRA/furnisher (missed 30-day, no 5-day frivolous notice, reinserted without notice) | Document the violation; escalate (CFPB complaint / attorney referral) |
| Stall / "please verify identity" letter | Identity-response letter + restart clock |

This table is the product's brain. Everything else is plumbing around it.

---

## 2. What the tool does (user-facing flow)

1. **Intake** — user uploads the CRA results/rejection letter (PDF/photo) + the original disputed item(s). Reuses Gatekeeper's existing `upload-url` + OCR/extraction path.
2. **Parse** — extract the CRA, bureau(s), item(s), stated outcome, and any reason language.
3. **Classify** — map to a rejection-reason class (table above) with a confidence score.
4. **Attest** — user confirms, per item, that the information is actually inaccurate and *why* (dropdown of factual grounds + free text). **Blocking step.**
5. **Strategy** — pick the escalation play; surface it to the user in plain English with the legal basis.
6. **Generate** — draft an individualized letter (facts + specific inaccuracy + correct legal hook), plus the correct enclosures checklist.
7. **Review & send** — human-in-the-loop review, then export (PDF/mail-merge) and log to GHL + Supabase for tracking and the 30-day clock.

---

## 3. Architecture (reuse Gatekeeper — don't fork)

New surface added to the existing `gatekeeper` Next.js app; **do not break the BAT (stateless/GHL) path.**

```
gatekeeper/
  app/api/dispute/
    intake/route.ts        # create case, return signed upload URL (reuse upload-url pattern)
    parse/route.ts         # OCR + LLM extraction of the results letter
    classify/route.ts      # rejection-reason classification (LLM, structured output)
    generate/route.ts      # draft the round-2 letter (LLM + strategy template scaffold)
    case/[id]/route.ts     # fetch/update a dispute case (status, clock)
  lib/
    dispute/
      classify.ts          # reason-class taxonomy + prompt + schema
      strategies.ts        # one module per escalation play (MOV, §623, Metro2, procedural)
      letter-scaffold.ts   # legal skeletons the LLM fills with case facts (NOT canned text)
      metro2.ts            # Metro 2 field-consistency checks (DOFD, status, dates, balance)
      clock.ts             # 30-day / 5-day FCRA deadline tracking
    llm-extract.ts         # REUSE existing OpenRouter wrapper
    ghl.ts / supabase.ts   # REUSE
  supabase/migrations/
    NNNN_dispute_cases.sql
```

**Key reuse points already in the repo:** `lib/llm-extract.ts` (OpenRouter), `lib/ghl.ts` (CRM sync), `lib/supabase.ts`, `app/api/upload-url` + `credit-extraction.ts` (document ingestion pattern). The dispute generator is architecturally the same shape as the existing Credit Analyzer feature, so it should mirror its Supabase-backed conventions.

---

## 4. Data model (Supabase — schema-stable design)

Per the CRB schema-stability preference, keep the surface narrow and push variable structure into JSONB rather than churning columns as strategies evolve.

```sql
-- dispute_cases: one row per item being disputed across rounds
create table dispute_cases (
  id            uuid primary key default gen_random_uuid(),
  contact_id    text not null,              -- GHL contact
  bureau        text not null,              -- experian | equifax | transunion
  furnisher     text,
  item_ref      text,                       -- account/tradeline identifier (tokenized, see §6)
  round         int not null default 1,
  status        text not null default 'open', -- open | awaiting_response | resolved | escalated
  clock_started_at timestamptz,             -- FCRA 30-day deadline anchor
  attested_inaccurate boolean not null default false,
  attestation   jsonb,                      -- grounds the user selected + free text
  created_at    timestamptz default now()
);

-- dispute_events: append-only log (letters in, letters out, classifications, outcomes)
create table dispute_events (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid references dispute_cases(id),
  kind         text not null,              -- rejection_received | classified | letter_generated | sent | outcome
  reason_class text,                       -- from the classifier taxonomy
  confidence   numeric,
  payload      jsonb,                       -- extracted fields, strategy chosen, letter ref
  created_at   timestamptz default now()
);
```

Append-only `dispute_events` gives a full audit trail (important for both outcome analytics and any compliance/dispute-of-our-own-conduct defense) without reshaping tables as the strategy library grows.

---

## 5. The AI pipeline (OpenRouter)

Two LLM stages, both with **structured (JSON-schema) outputs** so downstream code is deterministic:

**Stage A — Extract + Classify** (one call or two):
- Input: OCR'd rejection letter text.
- Output schema: `{ bureau, items[], stated_outcome, reason_class, reason_evidence_quote, confidence }`.
- Low temperature. If `confidence < threshold`, route to human review — never auto-generate on a guessed class.

**Stage B — Generate letter:**
- Input: case facts + user attestation + selected strategy module + a **legal scaffold** (the immovable legal skeleton for that strategy) + the specific inaccuracy.
- The LLM's job is to *individualize* — weave in this consumer's facts, account specifics, and the exact rejection reason. It is explicitly **not** asked to invent legal claims or vary phrasing to dodge a filter.
- Output: letter body + enclosures checklist + which FCRA section(s) are invoked.

**Why scaffolds, not free-form generation:** legal accuracy is non-negotiable and hallucinated statute citations are a liability. The scaffold pins the legal spine; the model supplies the individualized flesh. This also *is* the anti-template mechanism — every letter differs because the facts differ, not because a synonym table was applied.

**Model choice:** keep the existing OpenRouter setup. Use a strong reasoning model for classification (correctness matters), a cheaper model acceptable for generation given the scaffold constrains it.

### 5a. Two-model verification (classifier + adversarial judge)

A wrong classification is the most expensive error in the system (wrong strategy → wasted dispute round or a frivolous flag), so both high-stakes steps get a second, **independent** model as a checker. This is an LLM-as-judge pattern; OpenRouter makes multi-model routing a single API.

**Principles:**
- **Different model families** for A and B — running the same model twice reproduces correlated errors and buys little. Cross-vendor disagreement is the real signal.
- **Adversarial verifier, not a rubber-stamp** — the judge is given the raw letter + the proposed class + the classifier's `reason_evidence_quote`, and asked to *independently classify from scratch and flag any mismatch*, defaulting to "disagree" when uncertain.
- **Gate on agreement, not a single confidence score** — two independent models agreeing is a stronger signal than one model's self-reported confidence.

```
classify (Model A) ─┐
                    ├─ agree + high conf   → proceed
verify   (Model B) ─┘  disagree / low conf → human review
                       (optional Model C tiebreaker before escalating)
```

**The higher-ROI checkpoint — verify the generated letter.** The final draft carries the real liability, so Model B also runs a deterministic-ish checklist over Stage B output before it is shown for sending:
- Every statute citation exists and matches the scaffold (kills hallucinated FCRA cites).
- The letter disputes **only** items the user attested as inaccurate (enforces the §0 guardrail in code, not just policy).
- No fabricated facts beyond the case data.

**Scope:** apply verification to Stage A (classify) and Stage B (final letter) only. The OCR/parse step does not need it. Cost impact is ~2× on small payloads — negligible against the cost of filing a misclassified dispute.

---

## 6. Compliance & PII (blocking — must be resolved before launch)

Dispute letters contain **SSN, DOB, full account numbers, addresses** — this is exactly the "real PII" threshold flagged in the OpenRouter decision (compliance was deferred *until* real PII; this feature crosses that line).

Required before processing real client data:
- **OpenRouter data policy review** — confirm zero-retention routing / a provider + terms acceptable for PII, or run extraction through a provider with a BAA-equivalent posture. Revisit the deferred OpenRouter compliance decision now.
- **PII minimization to the LLM** — tokenize/redact SSN + full account numbers *before* the model call where possible; the classifier rarely needs them.
- **Encryption at rest** for uploads and `item_ref`; short retention windows; access controls in Supabase RLS.
- **CROA productization** (if CreditCrb acts as a CRO): written contract, 3-day cancellation, mandated disclosures, no upfront fees before service rendered.
- **Attestation + audit trail** (§0, §4) as the deception-avoidance control.

---

## 7. Phased build plan

| Phase | Deliverable | Notes |
| :-- | :-- | :-- |
| **0. Compliance gate** | OpenRouter PII decision + CROA posture confirmed | Blocks real data; can build on synthetic data meanwhile |
| **1. Ingestion** | `dispute/intake` + `parse` reusing upload/OCR path | Reuse `credit-extraction.ts` pattern |
| **2. Classifier** | `classify.ts` taxonomy + prompt + schema; confidence gating | The core IP; test against a labeled set of real rejection letters |
| **3. Strategy + scaffolds** | `strategies.ts` + `letter-scaffold.ts` for MOV, §623, Metro 2, procedural | Legal review of each scaffold before use |
| **4. Generation** | `generate` route, individualized output + enclosures checklist | Human-in-the-loop review mandatory |
| **5. Case tracking** | Supabase tables + `clock.ts` + GHL sync | 30-day/5-day deadline automation |
| **6. Outcome loop** | Log outcomes back to `dispute_events`; measure win-rate by reason_class | Turns the tool into a self-improving strategy engine |

**MVP = Phases 1–4 on the single highest-value path: the "Verified, no method shown" → MOV demand under §611(a)(7).** It is the most common rejection and the cleanest, most defensible escalation.

---

## 8. Success metrics
- Deletion/correction rate on Round-2 letters vs. baseline Round-1.
- % of generated disputes that reach investigation vs. frivolous rejection (the real proxy for the original "bypass the filter" goal).
- Classifier accuracy vs. human labels.
- Turnaround time per case.

## 9. Open questions for Sam / next decisions
1. Does CreditCrb file disputes *on behalf of* clients (CRO — CROA applies) or provide tooling for consumers to self-file (different posture)? This changes the compliance surface materially.
2. OpenRouter for PII, or a dedicated compliant extraction provider?
3. Do we integrate outbound mailing (e.g. certified mail API) or export-only for MVP?

---

## Sources
- e-OSCAR mechanics & dispute codes — https://legalclarity.org/e-oscar-how-the-automated-credit-dispute-system-works/
- e-OSCAR overview — https://www.switchlabs.dev/resources/e-oscar:-the-online-solution-for-complete-and-accurate-credit-reporting-disputes
- Why disputes get rejected (frivolous/vague/insufficient/procedural) — https://clientdisputemanagersoftware.com/why-credit-disputes-get-rejected-and-what-to-do-next/
- Frivolous/irrelevant determinations & the Furnisher Rule — https://www.lexology.com/library/detail.aspx?g=2884c296-2301-46b8-a097-6f31885f2291
- Method of Verification / FCRA §611(a)(7) — https://disputevalet.com/learn/section-611-dispute
- §623 direct dispute to furnisher — https://www.credlocity.com/fcra-623-direct-dispute
- CROA provisions, private right of action, enforcement — https://www.sanderslaw.group/blog/credit-repair-organizations-act-croa/
- Existing AI Metro 2 dispute tooling landscape — https://clientdisputemanagersoftware.com/consumer-law-in-credit-repair-utilizing-ai-enhanced-dispute-letters/
