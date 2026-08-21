# SBA Program Expansion — Gatekeeper / CRM Notes

Companion to `business-loan-analyzer-tool/docs/sba-program-expansion-plan.md`.

**Origin.** Client feedback, 20 Aug 2026: the Business Analyzer only ever
evaluates SBA 7(a), so owners who would fit an **SBA Express** or **SBA
Microloan** see no government option. The fix adds those as real eligibility
branches and renames the card to be programme-neutral.

---

## Read this first: no engine changes happen in this repo

The BAT calculation engine is **entirely in the frontend**, at
`business-loan-analyzer-tool/src/modules/financing-wizard/lib/funding-engine.tsx`.

Verified in this repo: no `SBA`, `buildCategories`, `fundingCapacity` or
`unsecured` logic anywhere in `lib/` or `app/`. BAT is a stateless lead gate here.
`/api/submit` resolves whatever custom-field **keys** the browser sends onto real
GoHighLevel field ids via `resolveContactCustomFields()` and writes them. It never
inspects or validates the offer **values**.

So the gatekeeper needs **no code changes** for this feature. What it needs is
three GoHighLevel configuration checks, below. Getting these wrong loses CRM data
silently on every SBA lead, which is why they are worth doing before the frontend
ships.

---

## 0. Checked against the real field list

Updated after reviewing the BAT merge-tag list supplied 20 Aug 2026 (19 fields).

| Field this plan touches | Exists in GHL? |
|---|---|
| `assigned_offer_tier` | **Yes** |
| `loan_type` | **Yes** |
| `all_matched_offers` | **Yes** |
| `matched_offers_html` | **Yes** |
| `sba_program` | **Yes** — created 20 Aug 2026, key confirmed as `sba_program` |

So the rename in §1 lands on fields that all exist. The field **type** is still
unknown, because a merge tag reveals the key and not whether the field is text or
a dropdown. §1 stands as written.

**Wider context worth knowing before adding a field.** A full audit of every BAT
key against this list is in
`business-loan-analyzer-tool/docs/crm-field-audit.md`. It found that **2 fields
the analyzer already sends do not exist in GHL at all** —
`partner_credit_over_660` and `estimated_real_estate_value` — so their answers are
collected from the owner and discarded. There is therefore an existing precedent
for a key being "sent" while landing nowhere, and it went unnoticed. Treat §2
below as a field that is not working until a log line proves otherwise.

## 1. Field types — RESOLVED, the rename is now safe

Both target fields are text as of 20 Aug 2026, so the CRM side of the SBA rename
carries no risk:

| Field | Type | Accepts the renamed value? |
|---|---|---|
| `assigned_offer_tier` | Multi line (was a dropdown) | Yes |
| `loan_type` | Single line | Yes |
| `all_matched_offers` | Free-form string | Yes |
| `matched_offers_html` | Free-form string | Yes |

**Nothing in GHL now blocks the SBA work.** What remains are the 5 product
decisions in §7 of
`business-loan-analyzer-tool/docs/sba-program-expansion-plan.md`.

The original analysis is kept below, because it explains the failure mode to watch
for on any future dropdown.

### Original: why a dropdown was the risk

The rename changes the **value** arriving in existing fields, from
`"SBA 7(a) Government Loan"` to `"SBA and Other Government Loans"`.

Affected fields:

| CRM key | Carries |
|---|---|
| `assigned_offer_tier` | The featured category name |
| `loan_type` | The featured category name (same value) |
| `all_matched_offers` | Pipe-joined list of every matched category name |
| `matched_offers_html` | Pre-rendered offer table, includes the name |

**The risk.** If `assigned_offer_tier` or `loan_type` is a **single-select /
dropdown** in GoHighLevel rather than a **text** field, an unrecognised option is
rejected or silently dropped. `resolveContactCustomFields()` resolves the field id
successfully, the write appears to succeed, and the value never lands. Nothing in
our logs would flag it, because the failure is inside GHL's field validation.

**Action.** In GHL → Settings → Custom Fields, confirm the type of
`assigned_offer_tier` and `loan_type`.

- **Text** → nothing to do.
- **Dropdown** → either add the new option values before the frontend deploys, or
  convert the fields to text. Adding options is the safer of the two.

`all_matched_offers` and `matched_offers_html` are free-form strings, so they are
unaffected either way.

## 2. New field: `sba_program`

Recommended in the plan (§7.4). The card title becomes programme-neutral, so
without a dedicated field nobody can report on **which** SBA programme is actually
being matched, which is the main thing the client will want to know once this is
live.

| | |
|---|---|
| Field key | `sba_program` — **created, confirmed** |
| Type | **Text** (avoid a dropdown, so future programmes need no CRM change) |
| Values | `SBA 7(a)`, `SBA Express`, `SBA Microloan`, or empty |
| Set by | The frontend, in `buildContactCustomFields()` — **not sent yet** |

> **Status: the field exists, nothing writes to it.** The analyzer only begins
> sending `sba_program` when the tiered SBA resolver is implemented, and that is
> blocked on the 5 decisions in §7 of
> `business-loan-analyzer-tool/docs/sba-program-expansion-plan.md`. Until then the
> field stays empty on every contact, which is expected rather than a fault.

No gatekeeper code change is needed to accept it. `resolveContactCustomFields()`
matches by field key, tolerantly, and logs anything it cannot map as `unresolved`
rather than failing the write.

**Action.** Create the field in GHL **before** the frontend starts sending it.
Until it exists, the value is dropped and logged as unresolved, which is graceful
but means the data is lost for that period.

### ⚠ The key GHL generates may not be the key you typed

This is the trap, and there is direct evidence for it in the existing field list.

The APR qualification field's key is **`7_apr_qualification_status`**, not
`apr_qualification_status`. Nobody would have chosen that `7_` prefix, so GHL
generated it. The analyzer sends the unprefixed key, and it only still works
because `resolveContactCustomFields()` falls back to matching the **slugified
display name**.

So after creating `sba_program`:

1. Open the field in GHL and read its actual merge tag. If it comes back as
   something like `{{contact.1_sba_program}}`, our `sba_program` key will **not**
   match by key.
2. It will still match if the display name slugifies to `sba_program`, so name it
   exactly **"Sba Program"** or **"SBA Program"** to keep the name fallback
   working.
3. Safest of all: send whatever key GHL actually generated. Then the match does
   not depend on the display name, and renaming the field later cannot break it.

Same caution applies to any future field. Create it, read the merge tag, then
confirm with a real submission.

## 3. Reporting continuity

The rename splits historical reporting at the cutover date. Any GHL smart list,
workflow trigger, or report that filters on the literal string
`"SBA 7(a) Government Loan"` stops matching new leads.

**Action.** Search GHL for automations keyed on that string and update them to
match either value. Worth doing before deploy, since a workflow that silently
stops firing is hard to notice.

---

## Checklist

Order matters: all three are GHL-side and should be done **before** the frontend
deploys.

- [x] Confirm `assigned_offer_tier`, `loan_type`, `all_matched_offers` and
      `matched_offers_html` exist — all 4 present in the 20 Aug field list
- [x] Confirm the field **type** of `assigned_offer_tier` — was a **dropdown** with
      the deprecated `Tier A`–`Tier D` options, matching nothing the engine sends
      and discarding the value on every lead. **Converted to Multi line text on
      20 Aug 2026.** See §0 of
      `business-loan-analyzer-tool/docs/crm-field-audit.md`
- [x] Confirm the field **type** of `loan_type` — **text**. Accepts the SBA rename
      with no CRM change
- [x] Create the `sba_program` text custom field — **done**
- [x] **Read its merge tag** — confirmed `{{contact.sba_program}}`, no prefix, so
      the key is exactly `sba_program`. It will match by key, with no dependence on
      the display name, and renaming the field later cannot break it. The
      `7_apr_qualification_status` problem did not recur
- [ ] Audit GHL workflows / smart lists for the literal `SBA 7(a) Government Loan`
- [ ] Confirm the GHL token still has **Custom Fields (view)** scope, which
      `resolveContactCustomFields()` needs to see the new field
- [ ] After the frontend deploys, submit one test lead per programme and confirm
      all four offer fields plus `sba_program` land on the contact
- [ ] On that same test lead, read the `Unmapped custom fields` log line. It is
      the only place a wrong key is visible

While you are in GHL, the audit doc lists 2 unrelated fields worth creating at the
same time, `partner_credit_over_660` and `estimated_real_estate_value`. Both are
being collected from owners today and discarded.

## Where to look if a value goes missing

`/api/submit` logs unmapped fields rather than failing:

```
[v0] Unmapped custom fields (skipped): sba_program
```

That line means the field key did not exist in GHL, or the token lacks Custom
Fields view scope. A field that resolves but arrives **empty** on the contact is
the different failure in §1: a dropdown rejecting an unknown option.
