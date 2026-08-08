# Get OTP for Admin Mailbox

| | |
|---|---|
| **Endpoint** | `GET https://smart-senders.smartlead.ai/api/v1/smart-senders/auth-secret` |
| **Category** | smart-senders |
| **Source** | https://api.smartlead.ai/api-reference/smart-senders/get-otp |
| **Auth** | API key (query param `api_key`) |

Fetches a short-lived one-time code for a purchased admin mailbox, so its owner can complete a sign-in that asks for one.

## 1. Epic

**Sending infrastructure procurement**

The epic gives a Harry user a way to get more places to send from — buying a lookalike domain, provisioning mailboxes on it, pointing it at the real website, and having those mailboxes turn up on the Mailboxes page ready to warm up — without leaving the app for a registrar and a mail-hosting console. It matters because Harry's entire sending capacity today is whatever Gmail accounts the user already owns and connects by OAuth, so growing outreach means an afternoon of manual work somewhere else.

**Honest gap note:** Harry does none of this. There is no registrar integration, no supplier relationship, no billing (the README is explicit that the published prices are presentational and nothing charges a card), and no support for a mailbox that is not a Google OAuth or sandbox account. This is the only category in this backlog that cannot start as engineering work: it needs a commercial arrangement and a payment path first.

## 2. User story

**As a** marketer signing in to a mailbox I bought through Harry, **I want** to read the one-time code Harry can fetch for that address, **so that** I can finish the sign-in myself without hunting through a supplier's console.

**Acceptance criteria**
- [ ] Given an `email_account` that belongs to one of the caller's completed orders, when a code is requested, then `data` returns `otp` and `expires_in` (300 seconds in the documented example) and the UI shows the code with a live countdown.
- [ ] Given the code has a short life, when it expires, then the display clears itself and offers a single "Get another code" action rather than leaving a stale number on screen.
- [ ] Given `email_account` is not a mailbox from one of the caller's own orders, when a code is requested, then it is refused with the same not-found wording used for unknown addresses — this route must never become a way to pull a code for an arbitrary address.
- [ ] Given a code is fetched, when it is handled, then it is never stored in Harry's database, never written to a log or to `telemetry`, and never included in any webhook payload or export.
- [ ] Given the code is displayed, when the user acts on it, then they type it into the supplier's sign-in themselves — Harry displays the code and does not enter it into any third-party form or complete any sign-in on the user's behalf.
- [ ] Given a code is requested, when the request succeeds, then one `events` row records that a code was requested for that address, by whom and when, with the code itself absent.
- [ ] Given codes are requested repeatedly, when the rate is unusual, then requests are throttled per address and the owner is shown how many have been requested recently, because repeated code requests are the shape of an account takeover attempt.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `GET ...?email_account=admin@example.com` for an address from the caller's completed order | 200, `ok: true`, `data.otp` present, `data.expires_in` 300; the UI shows the code with a countdown |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; no code shown |
| TC-3 | Not found / wrong workspace | Request a code for an address from another workspace's order, then for a random address | Identical refusal both times; no code, and one `events` row noting the refused attempt |
| TC-4 | Validation failure | Call with `email_account` omitted, then malformed | 400 each time; the UI never issues the call without a valid address |
| TC-5 | Rate limited | Request five codes for one address in a minute | Throttled with a clear message and a wait time; the UI shows how many were requested recently |
| TC-6 | Empty result set | Stub a response with no `otp` | The UI says no code is available right now and offers a retry, rather than rendering an empty box |
| TC-7 | Expiry | Fetch a code and wait past `expires_in` | The code clears itself and only "Get another code" remains |
| TC-8 | Never persisted | Fetch a code, then inspect the database, logs, telemetry and any webhook deliveries | The code value appears in none of them |
| TC-9 | No auto-entry | Observe the flow end to end | Harry displays the code only; it never navigates to or fills a third-party sign-in form |
| TC-10 | Audit trail | Fetch two codes, then read the activity trail | Two entries naming the actor, the address and the time, with no code value |
| TC-11 | Marketplace down | Force a 500 | One clear failure message; nothing else on Mailboxes is affected |

## 4. Frontend user story

**As a** marketer, **I want** the one-time code shown clearly with its countdown, **so that** finishing a sign-in is quick and I am never left staring at a number that has already expired.

**Scope**
- Mailboxes → an order's detail view: a "Get sign-in code" action on each purchased admin mailbox, present only for addresses from that workspace's completed orders.
- The result is a modal showing the code in large monospace text, a copy button, a countdown to expiry, and one line of guidance: type this into the supplier's sign-in yourself. No link that navigates anywhere with the code attached.
- On expiry the code is replaced by the "Get another code" action. Recent request count is shown when it is above one, as a quiet note.
- Loading disables the action with progress; throttling shows the wait time; error shows one message and a retry.
- Accessibility: the code is announced once as a live region and grouped in readable chunks, the countdown is text as well as a visual, and the modal traps focus and restores it on close. On narrow screens the modal is a full-screen sheet.

**Definition of done**
- [ ] The code is never rendered outside the modal and never persists after expiry.
- [ ] Copy works and confirms visibly.
- [ ] The action is absent for any address not from the workspace's own orders.
- [ ] Expiry, throttle, error and copy behaviour have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** the code proxied, scoped and never persisted, **so that** a convenience feature cannot become a credential store or a lookup oracle.

**Scope**
- Route: `GET /api/senders/mailboxes/:address/code` in `server/routes.js`, delegating to `server/senders.js`. The address must match a mailbox on a completed `sender_orders` row owned by the session's workspace; anything else returns the standard not-found.
- Data model: none. The response is passed straight to the client and held in no variable that is logged, cached or serialised.
- Throttled per address and per workspace, with a low ceiling. Repeated refusals for out-of-scope addresses are themselves rate-limited so the route cannot be probed.
- Logged to `events`: the request, the actor, the address, the outcome — never the code. `telemetry` records latency and outcome only. The logging middleware must have an explicit exclusion for this route's response body, tested rather than assumed.
- The adapter must not be reachable from any background job: a code has no meaning without a person waiting to type it.

**Definition of done**
- [ ] A test asserts the code value appears in no log line, telemetry row or stored record.
- [ ] Out-of-scope addresses return the identical response to unknown ones.
- [ ] Throttles apply per address and per workspace and are covered by tests.
- [ ] No background job path can call this route.

## 6. End-to-end test ticket

**Title:** E2E — Fetch a sign-in code for a purchased mailbox

**Preconditions:** A workspace with marketplace access, one completed order with an admin mailbox, a second workspace with its own order, and a stubbed supplier returning a code with a short expiry.

**Flow**
1. Sign in and open Mailboxes → Orders → the completed order.
2. Use "Get sign-in code" on the admin mailbox.
3. Copy the code, then wait past its expiry.
4. Request a code four more times in quick succession.
5. Request a code for the other workspace's address by calling the route directly.
6. Inspect the database, logs, telemetry and the activity trail.

**Assertions**
- [ ] The code appears with a countdown and a copy button.
- [ ] After expiry the code is gone and only "Get another code" remains.
- [ ] Repeated requests are throttled with a stated wait, and the recent-request count is shown.
- [ ] The cross-workspace request is refused with the same wording as an unknown address.
- [ ] No code value exists in the database, logs, telemetry or any webhook delivery.
- [ ] The activity trail lists each request with the actor and address and no code.
- [ ] At no point does Harry navigate to or fill in a supplier sign-in form.

**Teardown:** Reset the stub, clear the run's events and telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes → order detail | A "Get sign-in code" action and a code modal | Low | One action inside a detail view the order stories already build; absent for anything not from the workspace's own orders |
| Activity trail | Code-request entries | Low | Same row format as every other entry |

**Verdict:** Fits an existing surface

The code has one purpose and one moment, so it belongs as an action on the mailbox it is for and nowhere else. The design work here is almost entirely restraint: display it, count it down, log that it was asked for, keep it out of every store, and leave the actual sign-in to the person whose account it is.
