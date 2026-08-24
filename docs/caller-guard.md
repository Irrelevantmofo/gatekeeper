# The caller guard

Until 25 August 2026 every route on this API accepted a request from anywhere,
unauthenticated. `proxy.ts` now checks who is calling, on every `/api/*` request.

**It is inert until you set the environment variables below.** That is deliberate,
and section 3 explains why.

---

## 1. The 3 callers, and why they do not authenticate the same way

| Caller | Calls from | Identified by |
|---|---|---|
| `business-loan-analyzer-tool` | The browser | `Origin` |
| `identityIQ-credit-score-simulator` | The browser | `Origin` |
| `lender-marketplace-landing-page` | Its own server | A shared secret |

**A browser caller cannot hold a secret.** Anything shipped to the browser is in
the JS bundle and readable by the first person who opens devtools, so a "secret"
there is decoration. What a browser does send, and what page JavaScript cannot
change, is `Origin`. So the 2 browser apps are identified by origin.

**The marketplace can hold one**, because it calls from `app/api/inquiry/route.ts`
on its own server. That request carries no `Origin` at all, so origin rules could
never identify it, and a secret is both possible and necessary.

---

## 2. What to set

**On the gatekeeper project:**

| Variable | Value |
|---|---|
| `ALLOWED_ORIGINS` | Comma separated, no trailing slashes. The 2 browser apps, production and any preview origin you actually use |
| `GATEKEEPER_SECRET` | A long random string. `openssl rand -hex 32` |

```
ALLOWED_ORIGINS=https://<analyzer-domain>,https://<simulator-domain>
GATEKEEPER_SECRET=<the random string>
```

**On the lender marketplace project:**

| Variable | Value |
|---|---|
| `GATEKEEPER_SECRET` | The **same** random string |

Not `NEXT_PUBLIC_GATEKEEPER_SECRET`. That prefix inlines the value into the client
bundle and hands it to anybody who opens the page.

**Local development.** Add `http://localhost:3000` for the analyzer and
`http://localhost:8080` for the simulator to `ALLOWED_ORIGINS`, or leave both
variables unset locally and the guard stays open.

**Vercel reads these at request time for the proxy, but a change still needs a
redeploy to take effect on a new build.** Set them, redeploy, then submit 1 real
lead from each of the 3 apps before believing it works.

---

## 3. Why it fails open when unconfigured

With neither variable set the guard allows everything and logs a warning on every
request:

```
[guard] OPEN TO EVERYONE. Neither ALLOWED_ORIGINS nor GATEKEEPER_SECRET is set...
```

The alternative is that merging this file, before the variables exist, silently
stops all 3 products from working, and the symptom is leads quietly not arriving.
That exact failure is already the documented expensive one in this system:
restrict the origins, forget the redeploy, and nothing looks broken while every
lead is lost.

**A guard that has to be turned on is safe to ship. A guard that is on before it
is configured is not.** So the warning is the trade: noisy logs until somebody
finishes the job.

---

## 4. What this stops, and what it does not

**Stops:** a page on another website calling this API, and every bot that does not
bother to set headers, which is nearly all of them. It also means a leaked
endpoint URL is no longer enough on its own.

**Does not stop:** a determined caller who sets `Origin` by hand from a script.
`Origin` is unforgeable from page JavaScript, not from curl.

Closing that gap needs a per-request token or a challenge such as Cloudflare
Turnstile, and it is worth doing on the endpoints that cost real money before it
is worth doing everywhere:

| Endpoint | What abuse costs |
|---|---|
| `/api/otp/request` | Sends an SMS. Real money per request, and it already has per phone, per IP and global daily limits in Supabase |
| `/api/analyze` | Runs an LLM extraction over an uploaded PDF |
| `/api/report-email` | Renders a PDF and sends an email |
| `/api/upload-url` | Mints a signed upload URL, so storage |

`/api/otp/request` is the only one with its own rate limiting today. The others
are behind a verification token, which is a real barrier but not a rate limit.

---

## 5. Reading a rejection

Every rejection logs the path, the reason and the origin:

```
[guard] Rejected POST /api/submit: origin-not-allowed. Origin: https://example.com.
```

| Reason | Means |
|---|---|
| `origin-not-allowed` | A browser called from an origin not in `ALLOWED_ORIGINS`. If it is one of ours, the list is wrong or the deploy is stale |
| `no-origin` | No `Origin`, no usable `Referer` and no secret. A server side caller that has not been given the secret, or a script |
| `bad-secret` | A secret was sent and did not match. A wrong key is treated as deliberate, with no fallback to the origin rules, so the 2 projects must hold the same value |

Real traffic never produces these, so any of them in the log is worth reading.

`OPTIONS` is never guarded. A browser sends it before a cross origin POST and
cannot attach anything to it, so rejecting it would break the real request before
it was ever evaluated. Nothing happens on an `OPTIONS`.

Rejections carry CORS headers on purpose. Without them a browser reports a blocked
request as a CORS failure and hides the 403, which sends whoever is debugging a
misconfigured origin looking in entirely the wrong place.
