# Prompt for the GHL Frontend AI — UPDATE the "Email me my results" popup

> The popup already exists (built from the earlier prompt). These are **change
> instructions** — paste the code block below into the GHL Studio frontend AI. Two
> changes: (1) open it from a **button**, not a timer; (2) send the user's current
> **scenario + target** so the emailed results include their simulated what-if and
> the fastest-path actions.

```
UPDATE the existing "Email me my results" popup in the Identity IQ Credit Score Simulator.
Keep the modal's look, form, validation, success/error states, and the spam disclaimer as they
are. Make ONLY the two changes below.

CHANGE 1 — OPEN FROM A BUTTON, NOT A TIMER
- REMOVE the auto-show behavior entirely: delete the 30-second timer, the 45-second fallback
  timer, and the "resultsEmailPromptShown" sessionStorage auto-show guard. The popup must NOT
  appear on its own anymore.
- Instead, add a button that opens the popup. Place the SAME button on both result cards, so it
  is available wherever the user is looking:
    (a) the "Your Simulation Summary" card (shown after the user makes what-if changes), and
    (b) the "Fastest Path" result card (shown after they tap "Show My Fastest Path to …").
  Button label: "📧 Email me these results". Style it as a clear secondary/emerald button that
  fits each card. Clicking it opens the existing modal.
- Optional but recommended: also show the same button in the bottom action row (near "Reset All"
  / "New Report") so a user who never opened either card can still request the email.
- The modal stays fully dismissible (X, "No thanks", backdrop, Esc) and closing never disturbs
  the simulator. No once-per-session lockout is needed anymore — they open it on demand.

CHANGE 2 — SEND THE CURRENT SCENARIO + TARGET SO THE EMAIL MATCHES THE SCREEN
When the user submits their email, expand the POST body so the backend can render the email with
their live what-if AND the fastest-path steps. POST to the same endpoint:

    POST `${BASE_URL}/api/report-email`
    headers: { "Content-Type": "application/json" }
    body: JSON.stringify({
      reportId,
      email,
      scenario,          // the SAME scenario object the app already builds for POST /api/simulate
      bestPathTarget     // the numeric fastest-path target the app already uses (e.g. 700 or 850)
    })

- `scenario` is exactly what the app currently sends to /api/simulate — reuse that builder
  (the one that returns { payDown, factorChanges } from the current on-screen selections). Send
  the CURRENT state at click time. Its shape (for reference — do not rebuild if you already have it):
      {
        payDown: [ { accountId: string, targetUtilizationPct?: number, amount?: number } ],
        factorChanges: {
          paymentOnTimePct?: { from: number, to: number },   // fractions, e.g. 0.90
          lengthYears?:      { from: number, to: number },
          creditMixTypes?:   { from: number, to: number },
          recentInquiries?:  { from: number, to: number },
          utilizationPct?:   { to: number }
        }
      }
  If the user hasn't made any what-if changes, send the empty/current scenario as-is — the
  backend handles an empty scenario (it just omits the "what-if" section).
- `bestPathTarget` is the number the app already computes for the "Show My Fastest Path to N"
  button (700 when the three-bureau average is under 700, otherwise 850). Send that same value.
  If it isn't computed yet at click time, omit the field — the backend defaults with the same rule.

RESPONSE HANDLING — unchanged
    200 { ok: true }  (or { ok: true, mock: true })  -> SUCCESS state (confirmation + spam reminder)
    4xx/5xx, { ok: false }, or network error         -> ERROR state (keep modal open, allow retry)

DO NOT change any other simulator logic, the analyze/simulate/best-path calls, or the modal's
copy and styling. Only: replace the timed trigger with the button(s), and expand the submit body
with `scenario` and `bestPathTarget`.
```

---

## Backend contract (already deployed-ready, for reference)

`POST /api/report-email` accepts `{ reportId, email, scenario?, bestPathTarget? }`:
- Recomputes the what-if (`simulate`) and fastest path (`buildBestPath`) **server-side** from the
  persisted facts + the forwarded `scenario`/`bestPathTarget`, so the email matches the screen.
- Refreshes the `credit_actions_html` custom field on the contact with: snapshot (scores + reason
  codes) → the user's simulated what-if (actions + per-bureau score changes) → fastest-path steps.
- Attaches the email to the contact and applies the `credit-results-optin` tag (GHL workflow trigger).
- `scenario` and `bestPathTarget` are both optional; missing/empty just drops the what-if section
  and defaults the target with the same 700/850 rule.
