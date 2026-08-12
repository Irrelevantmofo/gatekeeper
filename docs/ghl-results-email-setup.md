# GHL Setup — Results + Feedback Email (tag-triggered)

> How to wire the automation that fires when `/api/report-email` applies the
> **`credit-results-optin`** tag: one email containing the personalized analysis
> (`credit_actions_html`) + the feedback questions. Goal: land in the inbox and
> **elicit a reply** (the strongest signal that trains inbox providers our domain
> is wanted). Companion: [`feedback-loop-plan.md`](./feedback-loop-plan.md).

---

## 0. Do this FIRST — deliverability prerequisites (mail spams today)

The reply loop only works if the email reaches the inbox. Before turning the workflow on:

1. **Authenticate the sending domain** in GHL: **SPF + DKIM + DMARC** must all show green
   (Settings → Email Services / Dedicated Domain). Missing/failing DKIM is the #1 cause of GHL
   mail going to spam.
2. **Send from a subdomain** (e.g. `mail.yourdomain.com`) so tool email can't damage the root
   domain's reputation.
3. **DMARC rollout:** start `p=none` (monitor), move to `p=quarantine` after ~30 clean days.
   Required by Gmail/Yahoo in 2026.
4. **From-address = a real, monitored inbox** (never `noreply@`). Replies must actually be seen.
5. Verify with **MXToolbox** + **Google Postmaster Tools**; enable **hard-bounce suppression**.

> This is a per-contact triggered email (not a blast), so warm-up pressure is lower — but domain
> auth is still non-negotiable. If mail still spams after this, move to a dedicated warmed subdomain.

---

## 1. The "feedback form" = reply-prompt (not an embedded form)

The meeting note says "feedback form," and the rationale is **"eliciting a reply helps whitelist
our domain."** Those two pull in opposite directions, so optimize for the stated rationale:

- **Email forms don't submit** — email clients block `<form>`/JS. And a *link* to a survey earns a
  click, **not a reply** — clicks don't whitelist the domain the way replies do.
- So the "form" is **two questions the user answers by hitting Reply**: "rate 1–5" + "what to
  improve." That IS the feedback capture and it's what drives the deliverability win.
- Replies land in **GHL Conversations** (filter by the `credit-simulator` tag). A human reads them.
- (Optional later: also add a survey link for structured data — but keep "just hit reply" the
  single dominant call to action.)

---

## 2. Build the email template

`Marketing → Emails → Templates → + New → Blank`. Give it a name like **"Credit Results + Feedback."**

**Insert the analysis block (the part that renders our HTML):**
- Add a **Code element** (drag it in), and paste **only** the merge field for our field:
  `{{ contact.credit_actions_html }}`
  - Grab the exact tag from the **Custom Values** picker (Contact → your "Credit Actions HTML"
    field) so the key matches precisely.
  - This mirrors how the funding tool's `matched_offers_html` already renders as real HTML in your
    account. If the Code element ever escapes it, fall back to a plain **Text element** containing
    only that merge field on its own line — do **not** wrap it in other tags or hyperlink it
    (hyperlinking a custom value breaks rendering).
- Everything else (greeting, feedback questions, sign-off, P.S.) can live in the same Code element
  using the shell in §4, or as normal Text elements around the analysis block.

**Keep it light:** mostly text, no heavy images/banners (aim ~60% text). A plain, personal-looking
email inboxes better and invites replies.

**Footer / compliance:** make sure your account has a **physical mailing address** set so GHL's
CAN-SPAM footer + **unsubscribe** link are appended. Keep the footer minimal.

---

## 3. Build the workflow

`Automation → Workflows → + Create Workflow → Start from scratch`.

**Trigger:**
- Add Trigger → **"Contact Tag"** (fires when a tag is added).
- Filter: **Tag = `credit-results-optin`**. (Our backend adds this via API only after the email is
  on the contact, so the send always has a destination.)

**Action — Send Email:**
- Add Action → **Send Email**.
- **Template:** select "Credit Results + Feedback" (from §2).
- **From Name:** a real person, e.g. `Sam at Credit CRB`.
- **From Email:** an address on the authenticated sending (sub)domain, e.g. `sam@mail.yourdomain.com`.
- **Reply-To:** a **monitored** inbox (can be the same as From) — replies flow into GHL Conversations.
- **Subject:** personal + curiosity, e.g. `Your credit results, {{contact.first_name}}` or
  `Here are your credit results + one quick question`.
- No Wait step needed — send immediately.

**Workflow settings:**
- Re-entry: leave **off** for v1 (one send per opt-in). Note: adding a tag that's already present
  won't re-fire, so a repeat user won't be re-emailed unless the tag is removed first.
- Publish (toggle **Publish** on, then Save).

---

## 4. Email shell (paste into a Code element)

Our stored `credit_actions_html` is already a styled `<div>…</div>` (scores → what's holding you
back → your simulated what-if → fastest path). This shell wraps it with the greeting + feedback ask.

Designed for a **60+ audience**: minimum 20px text, high contrast (dark navy on white), generous
spacing, large tap-friendly reply ask. All inline-styled (email-safe).

```html
<div style="font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.7;color:#0c2340;max-width:600px;margin:0 auto;padding:12px">
  <p style="font-size:20px;margin:0 0 18px">Hi {{contact.first_name}},</p>

  <p style="font-size:20px;margin:0 0 18px">Thanks for using our free Credit Score Simulator. Here's
  what we found in your report — and the fastest way to raise your score:</p>

  <!-- Personalized analysis: scores, what's holding you back, your what-if, fastest path -->
  {{ contact.credit_actions_html }}

  <div style="border-top:2px solid #c9d2dd;margin:28px 0"></div>

  <p style="margin:0 0 12px;font-size:23px;font-weight:bold">Two quick questions — just hit reply:</p>
  <ol style="margin:0 0 18px;padding-left:26px">
    <li style="font-size:20px;line-height:1.6;margin:0 0 14px">On a scale of <strong>1 to 5</strong>, how helpful was this?</li>
    <li style="font-size:20px;line-height:1.6">What's one thing we could do to improve it?</li>
  </ol>
  <p style="font-size:20px;margin:0 0 18px">Even a one-word reply helps us a lot — thank you!</p>

  <p style="font-size:20px;margin:0 0 4px">— [Your Name], Credit CRB</p>

  <p style="margin:18px 0 0;font-size:20px;line-height:1.6;color:#33475b">P.S. If this landed in your
  Spam, Junk, or Promotions folder, please drag it to your inbox and mark it "Not spam" so we can
  reach you next time.</p>
</div>
```

Replace `[Your Name]` with the human sender. `{{contact.first_name}}` falls back gracefully if empty
(consider a default like "there" via GHL's fallback syntax `{{contact.first_name | there}}`).

---

## 5. Test before going live

1. On a **test contact**, run a real analysis through the tool, then click "Email me these results"
   in the simulator (or manually set `credit_actions_html` + add the `credit-results-optin` tag).
2. Confirm the workflow fires and the email arrives — test **Gmail AND Outlook**.
3. Confirm `credit_actions_html` renders as formatted HTML (not escaped text) and shows scores +
   what-if + fastest path.
4. Reply to it → confirm the reply appears in **GHL Conversations** under the `credit-simulator` view.
5. Check it isn't in spam; if it is, revisit §0 (auth) before launch.
