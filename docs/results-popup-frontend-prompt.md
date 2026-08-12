# Prompt for the GHL Frontend AI — "Email me my results" popup

> Copy everything in the code block below into the frontend AI. It's self-contained (stack, API contract, behavior, copy, and acceptance criteria).

```
Build a "Email me my results" popup for the Identity IQ Credit Score Simulator.

STACK / WHERE IT LIVES
- React 18 + TypeScript + Vite + Tailwind CSS + shadcn/ui (Radix). A <Dialog> component
  already exists at src/components/ui/dialog.tsx — use it.
- Render the popup from src/components/SimulatorScreen.tsx (the results/simulator screen,
  "Step 3"). That component already receives a `reportId: string` prop and defines
  `const BASE_URL = "https://gatekeeper-gold.vercel.app"`. Reuse both.
- Create a new component src/components/ResultsEmailModal.tsx and mount it from SimulatorScreen.

WHAT IT DOES
The user has just seen their credit results on screen. ~30 seconds later, a popup invites them
to get those results by email. Submitting sends their email to the backend, which emails them
their analysis + recommended actions (and asks for feedback). It is a value-add, never a gate.

WHEN IT APPEARS (timing)
- Start a 30-second timer the first time the user has clearly "seen value" on the simulator
  screen. Trigger that timer on the FIRST of these two signals in SimulatorScreen:
    (a) the "Fastest Path" result card renders (the `bestPath` state becomes non-null), OR
    (b) the simulation summary becomes visible (the `showFloatingSummary` condition becomes true).
- FALLBACK: if neither happens, show the popup 45 seconds after the simulator screen mounts
  (the 3-bureau scores are visible immediately, so there is always value on screen).
- Show it AT MOST ONCE per session. Guard with sessionStorage key "resultsEmailPromptShown".
  Once shown (or dismissed, or submitted), never auto-show again this session.
- Clear any pending timers on unmount.

CONTENT / COPY (audience is business owners aged 50–70 — plain, warm, large)
- Title:    "Want a copy of your results?"
- Body:     "Enter your email and we'll send your full 3-bureau analysis and your personalized
             recommended actions — free. No spam, unsubscribe anytime."
- One email text input, labeled "Your email address", placeholder "you@example.com", type="email".
- Primary button:   "Email me my results"
- Secondary action: a "No thanks" text button that closes the popup.
- Spam disclaimer, shown as smaller helper text under the button (but still >= 15px):
    "📩 Tip: our email may land in your Spam, Junk, or Promotions folder. Please move it to your
     inbox and mark it 'Not spam' so we can reach you."

BEHAVIOR ON SUBMIT
- Validate the email client-side (simple format check). If invalid, show an inline message
  "Please enter a valid email address." and do not call the API.
- On valid submit, set a loading state (disable the button, show a spinner/label like "Sending…")
  and POST:
      POST `${BASE_URL}/api/report-email`
      headers: { "Content-Type": "application/json" }
      body: JSON.stringify({ reportId, email })
- Response contract:
      200 { ok: true }               -> SUCCESS
      200 { ok: true, mock: true }   -> SUCCESS (treat identically)
      4xx/5xx or { ok: false } or a network error -> ERROR
- SUCCESS state: replace the form with a confirmation:
      "✓ Sent! Check your inbox in a few minutes — and please peek in your Spam/Promotions folder
       just in case." Auto-close after ~4 seconds, or on a "Done" button.
- ERROR state: keep the popup open, keep the entered email, show:
      "We couldn't save your email. Please try again." and re-enable the button so they can retry.

DISMISS / NON-BLOCKING
- The popup is DISMISSIBLE: an X in the corner, "No thanks", clicking the backdrop, and the Esc key
  all close it. Closing must NOT affect the simulator — the results stay fully interactive behind it.
- Closing (any way) sets the sessionStorage guard so it won't reappear this session.

DESIGN / ACCESSIBILITY
- Match the existing design system: deep-navy surface (#0c2340), crisp white/near-white text,
  emerald-green primary button (same as other CTAs). Rounded corners, soft shadow, comfortable padding.
- Minimum 18px body text; 20px title+. Large tap targets (button height ~48px+). High contrast.
- Accessible modal: focus is trapped inside while open, focus returns to the page on close, the
  dialog has an aria-label/aria-labelledby, and the email input has an associated <label>.
- Mobile-friendly: full-width on small screens, max-width ~480px on desktop, never overflows.

ACCEPTANCE CRITERIA
1. On a normal run, the popup appears ~30s after the Fastest Path card or summary shows (else 45s after mount).
2. It appears at most once per browser session.
3. Submitting a valid email calls POST /api/report-email with { reportId, email } and shows the success state on { ok: true }.
4. Invalid email is caught client-side; API/network errors show the retry message and keep the popup open.
5. X, "No thanks", backdrop click, and Esc all close it without disturbing the simulator, and prevent it re-showing this session.
6. All text >= 18px (helper text >= 15px), navy/emerald theme, keyboard- and screen-reader-accessible.

Do NOT change any existing simulator logic, API calls, or the analyze/simulate/best-path flow.
Only add the popup component and the minimal wiring in SimulatorScreen to mount it and trigger the timers.
```
