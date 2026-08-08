# Get Order Details

| | |
|---|---|
| **Endpoint** | `GET https://smart-senders.smartlead.ai/api/v1/smart-senders/order-details` |
| **Category** | smart-senders |
| **Source** | https://api.smartlead.ai/api-reference/smart-senders/order-details |
| **Auth** | API key (query param `api_key`) |

Looks up one order by its reference and reports where it has got to, which domain it covers, and which mailboxes have been created.

## 1. Epic

**Sending infrastructure procurement**

The epic gives a Harry user a way to get more places to send from — buying a lookalike domain, provisioning mailboxes on it, pointing it at the real website, and having those mailboxes turn up on the Mailboxes page ready to warm up — without leaving the app for a registrar and a mail-hosting console. It matters because Harry's entire sending capacity today is whatever Gmail accounts the user already owns and connects by OAuth, so growing outreach means an afternoon of manual work somewhere else.

**Honest gap note:** Harry does none of this. There is no registrar integration, no supplier relationship, no billing (the README is explicit that the published prices are presentational and nothing charges a card), and no support for a mailbox that is not a Google OAuth or sandbox account. This is the only category in this backlog that cannot start as engineering work: it needs a commercial arrangement and a payment path first.

## 2. User story

**As a** marketer who has ordered a domain, **I want** to see the order's progress and the mailboxes it produced, **so that** I know when I can start using the new sending capacity and whether anything has stalled.

**Acceptance criteria**
- [ ] Given an `order_id` such as `ORD_12345`, when it is fetched, then `data` carries `order_id`, `status`, `domain`, `email_accounts`, `created_at` and `expires_at`, and the status is shown in plain words with what happens next.
- [ ] Given `status` is `completed`, when the order renders, then each entry in `email_accounts` is listed by address with an action to add it to Mailboxes.
- [ ] Given the response includes a `password` alongside each address, when Harry handles it, then that credential is never stored in Harry's database, never written to a log, never shown in a list view, and only revealed once behind an explicit action — Harry's own mailboxes are OAuth-based and this is the one place a password appears at all.
- [ ] Given a supplier mailbox cannot be connected by OAuth, when the user tries to add it, then Harry says plainly that connecting it needs credentials Harry does not hold and directs the user to complete the connection themselves — Harry does not enter passwords into third-party sign-in forms on the user's behalf.
- [ ] Given `expires_at` is in the future, when the order renders, then the date is shown with what expiry means for the domain; given it has passed, then the order is shown as expired and the affected mailboxes are marked on the Mailboxes page.
- [ ] Given `status` is not yet complete, when the order is open, then it polls at a modest interval with a visible "last checked" time and stops polling when the tab is hidden.
- [ ] Given the `order_id` is unknown, when it is fetched, then the user is told the reference was not found and offered the list of their own orders, with no detail about whether it exists elsewhere.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `GET ...?order_id=ORD_12345` against a stub returning a completed order with two accounts | 200, `ok: true`; status `completed`, domain `sales-outreach.com`, two addresses listed |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the order view shows "Domain purchasing is not connected" |
| TC-3 | Not found / wrong workspace | Call with another workspace's reference, then an unknown one | Both give the same "Reference not found" message with a link to the user's own orders |
| TC-4 | Validation failure | Call with `order_id` omitted | 400; the UI never issues the call without a reference |
| TC-5 | Rate limited | Poll every second for a minute | 429 avoided by polling at a modest interval and pausing on a hidden tab; if it occurs, backoff doubles |
| TC-6 | Empty result set | Stub a completed order with `email_accounts: []` | 200; the order reads "No mailboxes were created" and offers a support link rather than an empty list |
| TC-7 | Pending order | Stub a `pending` status | The view explains what is happening, shows a last-checked time, and does not offer the add-to-Mailboxes action yet |
| TC-8 | Credential handling | Inspect Harry's database, logs and telemetry after fetching a completed order | No password value appears anywhere; the reveal action is the only path and it shows the value once |
| TC-9 | Expired order | Stub `expires_at` in the past | The order shows as expired and any linked mailbox is marked on the Mailboxes page |
| TC-10 | Reconciliation | Place an order that times out, then open its detail | The pending order resolves to its real status from this lookup, with no duplicate order created |
| TC-11 | Failed order | Stub a `failed` status | The reason is shown, no charge is implied, and the user is told what to do next without an automatic retry |

## 4. Frontend user story

**As a** marketer, **I want** an order status view that tells me plainly where things stand, **so that** waiting for a domain does not mean emailing support.

**Scope**
- Mailboxes: an Orders list beneath the mailbox list, visible only once an order exists, with each row showing the reference, the domain, the status in plain words and the date. Opening a row shows the detail with its mailboxes.
- A completed order offers "Add to Mailboxes" per address, which hands off to the normal mailbox connection path rather than inventing a second one.
- The credential, if the supplier returns one, is behind a "Reveal once" action requiring re-auth, shown in a copy field with a line saying Harry does not store it and it will not be shown again.
- Loading shows a skeleton; pending shows an explanation and a last-checked time; error keeps the row and offers Retry; expired and failed each have their own plain wording.
- Accessibility: statuses are text as well as colour, the polling update is announced politely and not repeatedly, and the reveal dialog traps focus. On narrow screens rows stack.

**Definition of done**
- [ ] The Orders list is absent until an order exists.
- [ ] A credential is never rendered in a list, only behind the reveal action.
- [ ] Polling pauses on a hidden tab and shows a last-checked time.
- [ ] Pending, completed, failed, expired and empty-accounts states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** order status reconciled from the supplier and stored without credentials, **so that** a pending order can never be lost and a password can never leak into Harry's data.

**Scope**
- Route: `GET /api/senders/orders/:ref` in `server/routes.js`, delegating to `server/senders.js`, scoped so a workspace can only read its own `sender_orders` rows.
- Data model: updates the existing `sender_orders` row's `status`, `domain` and mailbox addresses. The `password` field from the supplier response is stripped in the adapter before the row is ever constructed — it is passed straight through to the single reveal response and held nowhere.
- A background reconciliation pass resolves `pending` orders on a slow schedule so an interrupted purchase settles itself; it reads only, and never re-posts an order.
- Rate limited per workspace. Logged to `events`: status transitions with the reference and domain, never the credential. Latency to `telemetry`.

**Definition of done**
- [ ] A test asserts the serialised order row and every log line contain no password field.
- [ ] Pending orders reconcile without any write to the supplier.
- [ ] Cross-workspace references return the same not-found response as unknown ones.
- [ ] Status transitions appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Follow an order to completion

**Preconditions:** A workspace with marketplace access, a stubbed supplier able to move an order from pending to completed on command, and one order already placed.

**Flow**
1. Sign in and open Mailboxes → Orders.
2. Open the pending order and read its status.
3. Move the stub to completed and wait for the next poll.
4. Use "Reveal once" on a returned credential.
5. Use "Add to Mailboxes" on one address.
6. Inspect the database, logs and telemetry.

**Assertions**
- [ ] The pending order explains itself and shows a last-checked time.
- [ ] After completion the two addresses appear with an add action.
- [ ] The reveal requires re-auth, shows the value once, and says Harry does not store it.
- [ ] "Add to Mailboxes" hands off to the ordinary connection path, and Harry does not attempt to sign in on the user's behalf.
- [ ] No password value exists in the database, logs or telemetry at any point.
- [ ] The activity trail shows the status transition with the reference and domain only.

**Teardown:** Reset the stub, delete the order row and any mailbox created by the run, clear the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | An Orders list beneath the mailboxes, with a detail view | Medium | Absent until an order exists; rows reuse the existing list styling |
| Mailboxes | A one-time credential reveal | Low | Behind re-auth, shown once, never in a list |
| Activity trail | Status transitions | Low | Same row format as every other entry |

**Verdict:** Fits an existing surface

Orders belong on the page where mailboxes live, because the only reason to check one is to find out when new sending capacity is ready. The part worth arguing about is the credential: the honest answer is that Harry is an OAuth product and a supplier password is a foreign object in it, so it passes through once and is never kept.
