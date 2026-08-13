# GHL Setup — Results email (backend-sent) + reply tracking

> **Architecture (Option 2):** the **backend** (`/api/report-email`) generates a password-protected
> PDF of the results and **sends the email itself** via the GHL Conversations API with the PDF
> attached. The password is texted to the user via SMS (out-of-band). So there is **no workflow
> "Send Email" step** — GHL's job here is just (1) deliverability DNS and (2) a reply-tracking
> workflow. Companion: [`feedback-loop-plan.md`](./feedback-loop-plan.md).

---

## 0. Deliverability prerequisites (do first — mail spams today)

The email + its reply loop only work if it reaches the inbox:
1. **SPF + DKIM + DMARC** green on the sending domain (Settings → Email Services). Missing DKIM is
   the #1 cause of GHL mail going to spam.
2. Prefer a **sending subdomain** (e.g. `mail.yourdomain.com`); DMARC start at `p=none`.
3. A **real, monitored From/Reply-To** address (never `noreply@`) — set it via `CREDIT_EMAIL_FROM`
   / `CREDIT_EMAIL_REPLYTO` env vars. Replies must be seen (they train deliverability + carry feedback).
4. Physical mailing address set on the account (CAN-SPAM footer + unsubscribe).
5. Verify with MXToolbox + Google Postmaster Tools.

## 1. Token scope

The backend sends via `POST /conversations/messages`, which needs the GHL token scope
**`conversations/message.write`** (already added for OTP SMS). No new scope required.

## 2. What the backend sends (no GHL template needed)

On "Email me my results", `/api/report-email`:
- builds the encrypted **PDF** (scores → what's holding you back → simulation summary → fastest path),
- uploads it to Supabase and gets a short-lived signed URL,
- **emails it, attached**, via the Conversations API — body is a short, personal, reply-first note
  ("results attached, password texted") + the two feedback questions,
- **texts the password** via SMS,
- tags the contact `credit-results-optin`.

The email threads into the contact's **Conversations**, so replies are captured there and can
trigger automation (below). Nothing to build in the email template builder.

## 3. Reply-tracking workflow (this is the automation you build)

`Automation → Workflows → + Create Workflow`:
- **Trigger:** **"Customer Replied"**, filtered to **Reply Channel = Email** (optionally also filter
  to contacts with the `credit-simulator` or `credit-results-optin` tag so only credit-tool replies
  qualify).
- **Actions:** whatever you want on a reply — e.g. notify the team, tag `engaged-reply`, start a
  follow-up sequence, or (later) send the booking/strategy-call invite.

That's the "reply → next automation" you asked for. It works because the backend-sent email lives in
the same Conversations thread the reply lands in.

## 4. Test

1. Real analysis → click "Email me these results".
2. Confirm the email arrives (test Gmail + Outlook) with the **PDF attached**, and it is **not in spam**.
3. Confirm the **password SMS** arrives; open the PDF with it; check scores + simulation summary +
   fastest path all render.
4. Reply to the email → confirm the reply lands in Conversations and fires the "Customer Replied" workflow.
