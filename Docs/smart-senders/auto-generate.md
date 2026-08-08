# Auto Generate Mailboxes

| | |
|---|---|
| **Endpoint** | `POST https://smart-senders.smartlead.ai/api/v1/smart-senders/auto-generate-mailboxes` |
| **Category** | smart-senders |
| **Source** | https://api.smartlead.ai/api-reference/smart-senders/auto-generate |
| **Auth** | API key (query param `api_key`) |

Suggests sensible mailbox addresses for a domain you are about to buy — three names on `example.com`, say — so you do not have to invent them.

## 1. Epic

**Sending infrastructure procurement**

The epic gives a Harry user a way to get more places to send from — buying a lookalike domain, provisioning mailboxes on it, pointing it at the real website, and having those mailboxes turn up on the Mailboxes page ready to warm up — without leaving the app for a registrar and a mail-hosting console. It matters because Harry's entire sending capacity today is whatever Gmail accounts the user already owns and connects by OAuth, so growing outreach means an afternoon of manual work somewhere else.

**Honest gap note:** Harry does none of this. There is no registrar integration, no supplier relationship, no billing (the README is explicit that the published prices are presentational and nothing charges a card), and no support for a mailbox that is not a Google OAuth or sandbox account. This is the only category in this backlog that cannot start as engineering work: it needs a commercial arrangement and a payment path first.

## 2. User story

**As a** marketer setting up a new sending domain, **I want** Harry to propose the mailbox addresses for me, **so that** I am not stuck naming three inboxes before I can continue.

**Acceptance criteria**
- [ ] Given a `vendor_id` and a `domains` object such as `{"example.com": {"count": 3}}`, when generation runs, then three suggested addresses on that domain are returned and shown as an editable list.
- [ ] Given several domains are in the `domains` object, when generation runs, then suggestions come back grouped per domain and the UI keeps that grouping.
- [ ] Given a suggestion is edited, when the user continues, then their edit is what is ordered — the generated names are a starting point, never a commitment.
- [ ] Given the user's briefing in Settings already names who is writing, when suggestions are requested, then the proposed names lean on that real person's name rather than inventing a fictional sender, because Harry's composer is required to say honestly who is writing.
- [ ] Given `count` is zero, negative or absurdly large, when generation is attempted, then it is refused before the request with a message naming a sensible range.
- [ ] Given the response arrives with an empty `data` (the documented example returns none), when it renders, then the step falls back to a manual entry list prefilled with one address, rather than blocking the flow.
- [ ] Given generation fails or the marketplace is down, when the step renders, then manual entry is offered and the flow continues — suggestion must never be a hard dependency.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"vendor_id": "1", "domains": {"example.com": {"count": 3}}}` against a stub returning three names | 200, `ok: true`; three editable addresses on `example.com` |
| TC-2 | Missing/invalid API key | POST with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the step offers manual entry |
| TC-3 | Not found / wrong workspace | POST with a `vendor_id` the account cannot use | The supplier error is shown and the flow returns to the supplier step |
| TC-4 | Validation failure | POST with `domains` omitted, then with `count: 0` | 400 each time; the UI blocks both before any request |
| TC-5 | Rate limited | Press Suggest 20 times in a second | 429 avoided by disabling the button while in flight; if it occurs, one backoff retry |
| TC-6 | Empty result set | Stub the marketplace to return `data: []` | 200; the step shows one empty manual-entry row and a hint, and the flow is not blocked |
| TC-7 | Multiple domains | POST two domains with counts of 2 and 1 | Suggestions come back grouped per domain and render under two headings |
| TC-8 | Edited suggestion | Change a suggested address, then continue | The order carries the edited address, not the suggestion |
| TC-9 | Honest naming | Set the briefing's sender name to a real person, then generate | Suggestions are built from that name; no invented persona is proposed |
| TC-10 | Marketplace down | Force a 500 | Manual entry is offered with an explanation; the user can complete the flow |
| TC-11 | Duplicate address | Edit two suggestions to the same address | The step blocks continuing and names the duplicate |

## 4. Frontend user story

**As a** marketer, **I want** the mailbox-naming step to arrive already filled in, **so that** the tedious part of setting up a domain takes one glance.

**Scope**
- Mailboxes → "Get more mailboxes" flow, step three: how many mailboxes on the chosen domain, a Suggest action, and an editable list of addresses with first and last name beside each.
- Each row is editable inline; duplicates and invalid addresses are marked as you type. A note explains that fewer, well-warmed mailboxes beat many cold ones, echoing the cold-email hygiene advice already in the README.
- Loading disables Suggest with progress; empty falls back to manual entry; error explains and offers manual entry.
- Accessibility: the list is a table of labelled inputs, errors tied to their inputs, and the Suggest result announced as a count. On narrow screens rows stack.

**Definition of done**
- [ ] The flow can be completed with the marketplace suggestion service unavailable.
- [ ] Duplicates and invalid addresses block continuing with a named reason.
- [ ] Suggestions are always editable and never auto-committed.
- [ ] Empty, error and multi-domain grouping have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** suggestion proxied and validated, **so that** a supplier cannot propose an address on a domain the user is not buying.

**Scope**
- Route: `POST /api/senders/mailboxes/suggest` in `server/routes.js`, delegating to `server/senders.js` with the marketplace key held server-side.
- Data model: none. Suggestions are transient until an order is placed.
- Every returned address is checked to be on one of the requested domains and to be a syntactically valid address; anything else is dropped. `count` is bounded to a sensible range server-side too.
- Non-fatal failure: the route returns `{ ok: true, data: [] }` on a marketplace error so the client's manual-entry fallback is the single code path for "no suggestions".
- Telemetry: latency and suggestion count. Nothing to `events`.

**Definition of done**
- [ ] Off-domain or malformed suggestions are dropped, covered by a test.
- [ ] A marketplace failure produces the same empty shape as a genuinely empty result.
- [ ] `count` bounds are enforced server-side as well as in the UI.
- [ ] No marketplace credential reaches the client.

## 6. End-to-end test ticket

**Title:** E2E — Name the mailboxes for a new domain

**Preconditions:** A workspace with marketplace access against a stubbed supplier, a briefing in Settings naming a real sender, and a selected domain carried in from the search step.

**Flow**
1. Sign in and reach step three of the purchasing flow with a domain selected.
2. Set the count to three and press Suggest.
3. Edit one suggested address and set two to the same value.
4. Fix the duplicate and continue.
5. Stop the stubbed supplier, return to step three, and press Suggest again.

**Assertions**
- [ ] Three suggestions appear on the selected domain, built from the briefing's sender name.
- [ ] The duplicate blocks continuing and names which rows clash.
- [ ] The edited address, not the suggestion, is what is carried to the order step.
- [ ] With the supplier stopped, manual entry is offered and the flow can still be completed.
- [ ] No address on a domain other than the selected one ever appears in the list.

**Teardown:** Abandon the flow, reset the stub, clear the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes → purchasing flow | A naming step with a Suggest action and editable rows | Low | One step inside a flow the vendor and search stories already introduce |
| Everywhere else | Nothing | Low | Suggestions are transient and stored nowhere until an order exists |

**Verdict:** Fits an existing surface

This is the smallest and least risky endpoint in the category: a convenience inside a flow that must work without it. Building the manual-entry path first and treating suggestion as an enhancement is what keeps a third party from being able to block a user mid-purchase.
