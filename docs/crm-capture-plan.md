# CRM Capture Plan — Credit Analyzer → GHL

> **Goal:** what to push into GHL (beyond basic contact) from a credit-report analysis, so the strategist can prep the call and leads can be segmented/automated. Set these up as **custom fields inside one custom folder** ("Credit Analyzer").
>
> **Principle — capture SIGNALS, not the raw report.** Summary numbers + simulator outcomes, not a full account dump. **Do NOT store** SSN, DOB, full account numbers, street addresses, or employers (sensitive + unnecessary; keeps the FCRA/GLBA surface small even with compliance deferred).
>
> **Source:** all fields derive from `report_analysis.extracted` + the simulator (`/api/simulate`, `/api/best-path`). Backend populates them at the analyze/tag step via `resolveContactCustomFields` (same mechanism BAT uses).

---

## Custom folder: **"Credit Analyzer"**
Group all fields below under one folder for a clean contact record.

## Field list

> **Two columns per field:** the **Field Name** is what you type when creating the field in GHL; the **Key** is what the backend sends. They must stay in sync — the backend matches by **slugifying the field's Name** (lowercase, non-alphanumeric → `_`). The Names below are chosen to slugify exactly to their Key, so if you create the fields with these exact Names, mapping "just works" (no need to hand-edit fieldKeys).

### Standard contact fields (built-in — do NOT create these as custom fields)
GHL already has these native fields on every contact. The backend writes them directly via the standard contact upsert (`upsertContact` in `lib/ghl.ts`), **not** as custom fields — so leave them as-is.

| Standard field | Source | Notes |
|---|---|---|
| Phone | OTP step | E.164; the verified number (primary identity) |
| First Name | PDF | split from the consumer's name on the report |
| Last Name | PDF | split from the consumer's name on the report |
| Email | optional | not collected in the phone-OTP flow; populated only if provided elsewhere |

Everything in sections A–F below is a **custom field** to create.

### A. Scores (the core qualifier)
| Field Name (create in GHL) | Key (backend sends) | Type | Notes |
|---|---|---|---|
| Credit Score TransUnion | `credit_score_transunion` | Number | per-bureau |
| Credit Score Experian | `credit_score_experian` | Number | per-bureau |
| Credit Score Equifax | `credit_score_equifax` | Number | per-bureau |
| Credit Score Middle | `credit_score_middle` | Number | **lenders qualify on the MIDDLE score** — key funding signal |
| Credit Band | `credit_band` | Single-select | Poor / Fair / Good / Very Good / Excellent |
| Funding Tier | `funding_tier` | Single-select | options `<600`, `600-659`, `660-699`, `700+` → routes automations (660 gate) |
| Score Model | `score_model` | Text | e.g. "VantageScore 3.0" |

### B. Debt & utilization (funding capacity)
| Field Name (create in GHL) | Key (backend sends) | Type | Notes |
|---|---|---|---|
| Revolving Utilization | `revolving_utilization` | Number | percent as a whole number, e.g. `87` |
| Total Revolving Balance | `total_revolving_balance` | Monetary | card debt load |
| Total Balances | `total_balances` | Monetary | overall obligations |
| Open Accounts | `open_accounts` | Number | file depth |
| Open Revolving Accounts | `open_revolving_accounts` | Number | # of cards |

### C. Risk / derogatory signals (strategist prep + the "deletions" conversation)
| Field Name (create in GHL) | Key (backend sends) | Type | Notes |
|---|---|---|---|
| Has Derogatory | `has_derogatory` | Single-select (Yes/No) | quick filter |
| Delinquent Accounts | `delinquent_accounts` | Number | accounts with late marks |
| Collections Count | `collections_count` | Number | drives the deletions/strategy call |
| Public Records Count | `public_records_count` | Number | bankruptcies/liens |
| Recent Hard Inquiries 24mo | `recent_hard_inquiries_24mo` | Number | recent credit-seeking |
| Top Reason Code | `top_reason_code` | Text | the #1 thing hurting the score |

### D. Simulator outcomes (personalize the call)
| Field Name (create in GHL) | Key (backend sends) | Type | Notes |
|---|---|---|---|
| Projected Max Score | `projected_max_score` | Number | best achievable via paydowns |
| Reaches 700 | `reaches_700` | Single-select (Yes/No) | "close" vs "needs strategy" |
| Points To 700 | `points_to_700` | Number | how far off |
| Cash To Target | `cash_to_target` | Monetary | "$X gets you there" |
| Top Recommended Action | `top_recommended_action` | Text | e.g. "Pay down CITI under 10%" |

### E. Meta & engagement
| Field Name (create in GHL) | Key (backend sends) | Type | Notes |
|---|---|---|---|
| Report Vendor | `report_vendor` | Text | e.g. "IdentityIQ" |
| Report Date | `report_date` | Date | recency |
| Analyzed At | `analyzed_at` | Date | when they used the tool |
| *(tag, not a field)* | `credit-analyzer-used` | Tag | one-use gate + hot-lead trigger |

> The consumer's **name** is NOT a custom field — it writes to the built-in **First Name / Last Name** (see "Standard contact fields" above).

### F. Optional — rendered summary
| Field Name (create in GHL) | Key (backend sends) | Type | Notes |
|---|---|---|---|
| Credit Analysis Summary HTML | `credit_analysis_summary_html` | Large text / HTML | one-glance strategist summary; reusable in the results email (GHL renders custom-field HTML) |

---

## Do NOT capture (keep out of GHL)
SSN · date of birth · full account numbers · street addresses · employers · the full per-account balance list. Not needed for the sales conversation, and it minimizes sensitive data in the CRM.

## How it drives automation
- `funding_tier` / `credit_band` → route to the right pipeline / nurture (aligns with the existing 660-based routing).
- `reaches_700 = No` or `collections_count > 0` → flag for the "advanced strategy / deletions" call.
- `credit-analyzer-used` tag → mark hot lead + close the one-use gate.

## Backend note
Two writes at the analyze/tag stage, both already supported in `lib/ghl.ts`:
- **Standard fields** (phone, first/last name, email) → `upsertContact` top-level params.
- **Custom fields** (sections A–F) → `resolveContactCustomFields` (`{ key: value }`, matched by slugified Name).

The analyzer already extracts everything needed, so it's one mapping step. Confirm the final field list, create the custom fields in GHL, and we wire the mapping.
