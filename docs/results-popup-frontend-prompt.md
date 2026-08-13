# Prompt for the GHL Frontend AI — Results email popup (consolidated spec)

> Paste the code block below into the GHL Studio frontend AI. It is the full, current spec for the
> "Email me my results" flow: button-triggered, sends the user's scenario, discloses the
> password-protected-PDF delivery, and is styled for a 60+ audience.

```
Build/UPDATE the "Email me my results" flow in the Identity IQ Credit Score Simulator to match this
complete spec. If a popup already exists, modify it to conform. Do not change the analyze / simulate
/ best-path logic.

CONTEXT
- The tool shows a 3-bureau credit simulator. `SimulatorScreen` already holds `reportId` and
  `const BASE_URL = "https://gatekeeper-gold.vercel.app"`. Reuse both.
- After the user views/adjusts their results, they can email themselves a copy. The backend emails a
  SECURE, PASSWORD-PROTECTED PDF (results are NOT shown in the email body). The password is a random
  code that we TEXT to the user's verified phone (out-of-band) — the user does NOT set or type it.

1) TRIGGER — a button, NOT a timer
- Remove any auto-show timer / sessionStorage auto-open behavior. The popup opens only on click.
- Add a button labeled "📧 Email me these results" on BOTH result cards, wherever the user is:
    (a) the "Your Simulation Summary" card, and
    (b) the "Fastest Path" result card.
  Optional: also add it in the bottom action row so it's reachable without opening either card.
- The popup is fully dismissible (X, "No thanks", backdrop click, Esc) and closing never disturbs
  the simulator behind it.

2) POPUP CONTENT (plain-English, 60+ audience)
- Title: "Want a copy of your results?"
- Body: "Enter your email and we'll send your full 3-bureau analysis and your personalized
  recommended actions as a secure, password-protected PDF — free."
- One email input, labeled "Your email address", type="email".
- Primary button: "Email me my results".  Secondary: "No thanks" (closes).
- Password/PDF disclosure note under the field:
  "For your privacy we send the results as a password-protected PDF, and we'll TEXT you the password
   on your verified phone. Open the attached PDF with that code."
- Spam disclosure note:
  "📩 Our email may land in your Spam, Junk, or Promotions folder. Please move it to your inbox and
   mark it 'Not spam' so we can reach you."

3) SUBMIT — send the current scenario + target
- Validate the email client-side; if invalid show "Please enter a valid email address." and don't call the API.
- On valid submit, POST:
      POST `${BASE_URL}/api/report-email`
      headers: { "Content-Type": "application/json" }
      body: JSON.stringify({ reportId, email, scenario, bestPathTarget })
  - `scenario` = the EXACT object the app already builds for POST /api/simulate (the builder that
    returns { payDown, factorChanges } from the current on-screen selections). Capture current state
    at click time. Shape (reuse the existing builder, don't reinvent):
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
    If the user changed nothing, send whatever the builder returns (empty is fine — backend handles it).
  - `bestPathTarget` = the number the app uses for "Show My Fastest Path to N" (700 if the 3-bureau
    average is under 700, else 850). If not available at click time, omit the field (do not send null).

4) RESPONSE HANDLING
    200 { ok: true }  (or { ok: true, mock: true })  -> SUCCESS: replace the form with
        "✓ Sent! Check your inbox in a few minutes (and your Spam/Promotions folder). We've texted
         the password to open the PDF." If the response has smsSent === false, instead say
        "✓ Sent! We couldn't text your password — please call us at 855-291-7557 to get it."
        Auto-close after ~6s or on "Done".
    4xx/5xx, { ok: false }, or network error -> ERROR: keep the popup open, keep the email entered,
        show "We couldn't email your results. Please try again." and re-enable the button.

5) CONSENT SCREEN DISCLOSURE (upload/consent step)
- Near the existing consent checkbox, add a plain-language line:
  "To keep your information private, we email your results as a password-protected PDF and text the
   password to your phone — so only you can open it."

6) DESIGN / ACCESSIBILITY (audience is 60+)
- Minimum 18px text everywhere (helper/disclosure text also >= 18px). Titles 22px+.
- High contrast: deep-navy surface (#0c2340), crisp white text, emerald-green primary button.
- Large tap targets (buttons >= 48px tall). Generous spacing.
- Accessible modal: focus trapped while open, focus returns on close, dialog has aria-label, the
  email input has an associated <label>. Mobile-friendly: full-width on small screens, max-width
  ~480px on desktop, never overflows horizontally.

Do NOT change any other simulator logic or the analyze/simulate/best-path calls.
```
