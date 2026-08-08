# Place Order

| | |
|---|---|
| **Endpoint** | `POST https://smart-senders.smartlead.ai/api/v1/smart-senders/place-order` |
| **Category** | smart-senders |
| **Source** | https://api.smartlead.ai/api-reference/smart-senders/place-order |
| **Auth** | API key (query param `api_key`) |

Buys the chosen domains from a supplier and asks for the named mailboxes to be created on them, using the billing details you provide.

## 1. Epic

**Sending infrastructure procurement**

The epic gives a Harry user a way to get more places to send from — buying a lookalike domain, provisioning mailboxes on it, pointing it at the real website, and having those mailboxes turn up on the Mailboxes page ready to warm up — without leaving the app for a registrar and a mail-hosting console. It matters because Harry's entire sending capacity today is whatever Gmail accounts the user already owns and connects by OAuth, so growing outreach means an afternoon of manual work somewhere else.

**Honest gap note:** Harry does none of this. There is no registrar integration, no supplier relationship, no billing (the README is explicit that the published prices are presentational and nothing charges a card), and no support for a mailbox that is not a Google OAuth or sandbox account. This is the only category in this backlog that cannot start as engineering work: it needs a commercial arrangement and a payment path first.

## 2. User story

**As a** marketer who has chosen a domain and named its mailboxes, **I want** to place the order and know exactly what I am paying for, **so that** buying sending capacity is a single explicit decision rather than a background process.

**Acceptance criteria**
- [ ] Given `vendor_id`, `forwarding_domain`, `user_details` and a `domains` array of `{domain_name, mailbox_details[]}`, when the order is placed, then a confirmation is returned with an order reference the user can look up later.
- [ ] Given the order will cost money, when the user reaches this step, then a summary shows every domain, every mailbox, the total price and the currency, and the order is only placed after an explicit confirmation — never as a side effect of an earlier step.
- [ ] Given `user_details` requires real billing and contact information (`email`, `firstName`, `lastName`, `company`, `country`, `city`, `addressLineOne`, `postalCode`, `state`, `phoneCc`, `phone`, `languagePreference`), when the form renders, then those fields are collected once and stored so a second order does not ask again, and the user is told they are passed to the supplier as the domain registrant.
- [ ] Given `forwarding_domain` is required, when the form renders, then it defaults to the user's real website domain with an explanation that purchased domains will redirect there, and it is validated as a resolvable domain.
- [ ] Given a mailbox entry requires `mailbox`, `first_name` and `last_name`, when any is missing, then the order is blocked before submission with the offending row marked.
- [ ] Given `parent_account_id` links a new mailbox to an existing account, when it is used, then Harry maps it to the existing mailbox row and the link is visible on the Mailboxes page.
- [ ] Given the order is placed, when it succeeds, then nothing sends from the new mailboxes until they are connected and warmed — a brand new domain starts at Harry's low daily limit and works up over a fortnight exactly as a new Gmail mailbox does.
- [ ] Given the request fails partway, when the response is not a clean success, then no second attempt is made automatically and the user is shown the order reference to check, because a retried purchase is a duplicate charge.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST a valid order with `vendor_id: 2`, `forwarding_domain: "example.com"`, complete `user_details`, and two domains with three mailboxes between them, against a stub | 200; an order reference is returned and shown on a confirmation screen |
| TC-2 | Missing/invalid API key | POST with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; no order placed, the summary is preserved |
| TC-3 | Not found / wrong workspace | POST with a `vendor_id` the account cannot use | The supplier error is surfaced; no order, no charge |
| TC-4 | Validation failure | POST with `forwarding_domain` missing, then a mailbox row missing `first_name` | 400 each time; the UI blocks both with the offending field marked |
| TC-5 | Rate limited | Submit the order twice quickly | The second submission is prevented client-side by an idempotency key; if it reaches the server, 429 and no duplicate order |
| TC-6 | Empty result set | POST with `domains: []` | Blocked before submission with "Choose at least one domain" |
| TC-7 | Explicit confirmation | Reach the summary and navigate away without confirming | No order exists and no charge is made |
| TC-8 | Duplicate charge protection | Force a timeout after the supplier accepted the order, then retry | The retry carries the same idempotency key and does not create a second order; the user is shown the existing reference |
| TC-9 | Registrant disclosure | Read the order form | It states plainly that `user_details` is passed to the supplier as the domain registrant and may be publicly visible in registration records |
| TC-10 | Warm-up applies | Complete an order against the stub, then connect a resulting mailbox | Its daily limit starts at Harry's new-mailbox floor and climbs over a fortnight, matching an ordinary new Gmail mailbox |
| TC-11 | Forwarding validation | POST `forwarding_domain: "not a domain"` | Blocked with a field-level message; nothing ordered |
| TC-12 | Parent link | POST a mailbox with `parent_account_id` pointing at an existing mailbox | The new mailbox is shown linked to that account on the Mailboxes page |

## 4. Frontend user story

**As a** marketer, **I want** an order summary that tells me exactly what will be bought and charged before I confirm, **so that** there is no version of this flow where I am surprised by a bill.

**Scope**
- Mailboxes → "Get more mailboxes" flow, final step: a summary listing each domain, each mailbox, the forwarding domain, the total price and the currency, with a single Confirm order action.
- The billing and contact form is collected once and reused; it states clearly what is sent to the supplier and why. It is never prefilled from anything the user did not type.
- After confirming, a confirmation screen shows the order reference and links to the order status view; the flow does not return to the Mailboxes list until the user chooses to.
- Loading disables Confirm and shows progress; a failure keeps the summary and shows the reference to check, with no automatic retry; success is unambiguous.
- Accessibility: the summary is a definition list with the total in the accessible name of the confirm action ("Confirm order, 45 dollars"), the form fields are labelled and grouped, and errors are tied to their fields. On narrow screens the summary stacks and the confirm action is pinned.

**Definition of done**
- [ ] The order is placed only on an explicit confirm, never on step navigation.
- [ ] The total and currency appear in the confirm action's accessible name.
- [ ] A failed order never auto-retries and always surfaces a reference.
- [ ] Registrant disclosure is visible before the form is filled, not after.

## 5. Backend user story

**As a** Harry engineer, **I want** ordering to be idempotent, auditable and gated on an explicit user action, **so that** a spending action can never be caused by a retry, a background job or a page refresh.

**Scope**
- Route: `POST /api/senders/orders` in `server/routes.js`, delegating to `server/senders.js`. Requires an idempotency key generated when the summary screen is opened and accepted only once.
- Data model: new `sender_orders` table (`id`, `user_id`, `vendor_id`, `order_ref`, `status`, `forwarding_domain`, `domains` JSON, `total`, `currency`, `created_at`) and a `sender_billing_details` table for the reusable `user_details`. Billing details are stored once, encrypted at rest, and are never logged.
- No payment instrument is ever handled by Harry. The supplier's own checkout or a payment provider holds the card; Harry stores a reference, never a number. If the commercial arrangement would require Harry to collect card details directly, this story does not ship — that is a deliberate stop, not a gap to fill later.
- Retries are never automatic. A timeout leaves the order in a `pending` state to be reconciled by the order-details lookup, never re-posted.
- Logged to `events`: order placed, by whom, for which domains, at what total — with the order reference and no billing detail. Latency and outcome to `telemetry`.

**Definition of done**
- [ ] The same idempotency key cannot create two orders, proved by a test.
- [ ] No card or payment credential is stored, logged or proxied by Harry.
- [ ] A timeout leaves exactly one `pending` order and no automatic retry.
- [ ] Billing details are encrypted at rest and absent from every log line.

## 6. End-to-end test ticket

**Title:** E2E — Place an order for a domain and mailboxes

**Preconditions:** A workspace with marketplace access against a stubbed supplier that can be made to succeed, fail or time out; a chosen domain and three named mailboxes carried in from earlier steps; no stored billing details.

**Flow**
1. Sign in and reach the summary step.
2. Read the summary and fill in the billing and contact form.
3. Navigate away without confirming, then return.
4. Confirm the order.
5. Repeat the flow with the stub set to time out after accepting, then reconcile.
6. Open the activity trail.

**Assertions**
- [ ] The summary lists every domain and mailbox, the forwarding domain, the total and the currency.
- [ ] After step 3 no order exists and no charge was made.
- [ ] After step 4 a confirmation screen shows an order reference and the billing form is remembered for next time.
- [ ] The timeout case creates exactly one pending order, no duplicate, and no automatic retry.
- [ ] The activity trail records the order with its reference, domains and total, and contains no billing or payment detail.
- [ ] No mailbox from the order sends anything until it is connected and warmed.

**Teardown:** Cancel or mark the stub orders complete, delete the created order rows and stored billing details, clear the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes → purchasing flow | A summary and confirm step, plus a one-time billing form | Medium | Last step of a flow that is absent without marketplace access; billing is collected once and reused |
| Mailboxes | New mailboxes appear as ordinary rows once provisioned | Low | Same row, same health chip, same warm-up rules as a connected Gmail account |
| Activity trail | An order entry | Low | Same row format as every other entry |

**Verdict:** Fits an existing surface

The purchasing flow already exists by this point, so the order step costs a summary and a form rather than a screen. What deserves the real attention is not layout: it is that this is the only place in Harry that spends money, and the design decisions that matter are the explicit confirm, the idempotency key, and the refusal to touch a card number at all.
