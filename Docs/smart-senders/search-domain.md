# Search Domain

| | |
|---|---|
| **Endpoint** | `GET https://smart-senders.smartlead.ai/api/v1/smart-senders/search-domain` |
| **Category** | smart-senders |
| **Source** | https://api.smartlead.ai/api-reference/smart-senders/search-domain |
| **Auth** | API key (query param `api_key`) |

Checks which domains matching a name you type are available to buy from a chosen supplier, at fifteen dollars or less.

## 1. Epic

**Sending infrastructure procurement**

The epic gives a Harry user a way to get more places to send from — buying a lookalike domain, provisioning mailboxes on it, pointing it at the real website, and having those mailboxes turn up on the Mailboxes page ready to warm up — without leaving the app for a registrar and a mail-hosting console. It matters because Harry's entire sending capacity today is whatever Gmail accounts the user already owns and connects by OAuth, so growing outreach means an afternoon of manual work somewhere else.

**Honest gap note:** Harry does none of this. There is no registrar integration, no supplier relationship, no billing (the README is explicit that the published prices are presentational and nothing charges a card), and no support for a mailbox that is not a Google OAuth or sandbox account. This is the only category in this backlog that cannot start as engineering work: it needs a commercial arrangement and a payment path first.

## 2. User story

**As a** marketer who needs a second sending domain, **I want** to type a name and see what is available and what it costs, **so that** I can pick a sensible lookalike of my real domain without visiting a registrar.

**Acceptance criteria**
- [ ] Given a `domain_name` fragment such as `techbuilddemo` and a `vendor_id`, when the search runs, then available domains are returned and each result shows its full name and price.
- [ ] Given the documented rule that results are priced at fifteen dollars or less, when results render, then that ceiling is stated once above the list so an absent premium domain is not a mystery.
- [ ] Given `domain_name` is empty, when search is attempted, then no request is made and the input asks for at least two characters.
- [ ] Given `vendor_id` is missing, when search is attempted, then the flow sends the user back to the supplier step rather than guessing a default supplier.
- [ ] Given nothing matching is available, when the response comes back with an empty `data`, then the panel reads "Nothing available under that name" and suggests trying a variation, listing two or three automatic suggestions based on what was typed.
- [ ] Given the user's real sending domain is known from their connected mailboxes, when the search box is first opened, then it is prefilled with a lookalike suggestion, because a domain unrelated to the business is the wrong answer for cold outreach.
- [ ] Given a result is chosen, when the user continues, then the chosen domain and its price are carried forward and shown at every later step, and nothing is bought at this stage.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Call with `vendor_id=1&domain_name=techbuilddemo` against a stub returning three available domains | 200, `ok: true`, three results with names and prices, all at or under the documented ceiling |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; "Domain purchasing is not connected" |
| TC-3 | Not found / wrong workspace | Call with a `vendor_id` the account cannot use | The supplier error is surfaced as "That supplier is not available to you" and the flow returns to the supplier step |
| TC-4 | Validation failure | Call with `domain_name` empty, then with `vendor_id` absent | 400 each time; the UI prevents both before any request is made |
| TC-5 | Rate limited | Type quickly so 30 searches fire in a second | 429 avoided by debouncing to one request per 500ms; if it occurs, one backoff retry and the previous results stay |
| TC-6 | Empty result set | Search a name with nothing available | 200 with `data: []`; "Nothing available under that name" plus two or three variations to try |
| TC-7 | Price ceiling | Stub a result above the ceiling | It is not shown, and the stated ceiling above the list explains why |
| TC-8 | Marketplace down | Force a 500 | One unavailable state for the purchasing panel; Mailboxes and sending are unaffected |
| TC-9 | Lookalike prefill | Open the search with a connected mailbox at `acme.com` | The box is prefilled with a lookalike such as `acmehq` or `getacme`, editable and clearable |
| TC-10 | Nothing is bought | Select a result, then leave the flow | No order exists, no charge is made, and reopening the flow starts clean |

## 4. Frontend user story

**As a** marketer, **I want** domain search to feel like any other search box, **so that** the least familiar part of the product is not also the most fiddly.

**Scope**
- Mailboxes → "Get more mailboxes" flow, step two: a single search input, a stated price ceiling, and a results list with name, price and a Select action.
- The chosen supplier stays in the flow header. Selecting a domain moves to the mailbox-naming step; nothing is purchased and no payment detail is asked for here.
- Loading shows skeleton rows beneath the input; empty shows the "nothing available" message with suggested variations; error shows the panel's single unavailable state.
- Accessibility: the input is labelled with format help, results are a list with each Select button naming its domain in its accessible label, and result counts are announced politely. On narrow screens results stack full width.

**Definition of done**
- [ ] Search is debounced and cancels superseded requests.
- [ ] The price ceiling is stated once, near the results.
- [ ] No payment or billing control appears at this step.
- [ ] Empty, loading, error and prefill behaviour have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** search proxied through the env-gated adapter, **so that** the marketplace key never reaches the browser and search results can be sanity-checked before display.

**Scope**
- Route: `GET /api/senders/domains/search?vendor_id&q` in `server/routes.js`, delegating to `server/senders.js`. The marketplace API key lives in the server environment only and is never sent to the client.
- Data model: none. Search results are transient; nothing is stored until an order is placed.
- Results above the documented price ceiling are filtered server-side as a defence in depth, and any result whose name does not match the requested fragment is dropped, so a supplier cannot upsell an unrelated domain into the list.
- Short timeout, non-fatal failure, per-workspace rate limit on search to keep a typing user from hammering a third party.
- Telemetry: search latency and result count. Nothing to `events` — searching is not a commitment.

**Definition of done**
- [ ] The marketplace key never appears in a client response or a client-side bundle.
- [ ] Ceiling and relevance filtering are applied server-side and covered by tests.
- [ ] An unconfigured workspace returns a clean unconfigured response.
- [ ] Search latency appears on Monitoring.

## 6. End-to-end test ticket

**Title:** E2E — Search for an available sending domain

**Preconditions:** A workspace with marketplace access against a stubbed supplier, one connected Gmail mailbox at `acme.com`, and stub data containing available, unavailable and over-ceiling domains.

**Flow**
1. Sign in and open Mailboxes → "Get more mailboxes".
2. Choose a supplier and continue.
3. Read the prefilled search term and search it.
4. Search a term with nothing available.
5. Select an available domain and continue, then abandon the flow.
6. Reopen the flow.

**Assertions**
- [ ] The search box is prefilled with a lookalike of `acme.com` and is editable.
- [ ] Results show only available domains at or under the ceiling, with the ceiling stated once.
- [ ] The unavailable search shows the empty message and suggested variations.
- [ ] Selecting a domain never asks for payment details at this step.
- [ ] After abandoning, no order and no charge exist, and reopening starts at the supplier step.
- [ ] Network inspection shows no marketplace API key in any client request.

**Teardown:** Reset the stub, clear the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes → purchasing flow | A search step with results | Low | One input and a list inside a flow the vendor story already introduces |
| Everywhere else | Nothing | Low | Search is transient and stores nothing |

**Verdict:** Fits an existing surface

Search is a step inside a flow that already exists once suppliers are chosen, so it adds no navigation and no persistent state. The one design decision worth keeping is prefilling a lookalike of the user's real domain: it is the difference between a flow that makes a good choice easy and one that hands someone a blank box in the part of outreach where a bad choice damages deliverability.
