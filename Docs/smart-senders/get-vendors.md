# Get Vendors

| | |
|---|---|
| **Endpoint** | `GET https://smart-senders.smartlead.ai/api/v1/smart-senders/get-vendors` |
| **Category** | smart-senders |
| **Source** | https://api.smartlead.ai/api-reference/smart-senders/get-vendors |
| **Auth** | API key (query param `api_key`) |

Lists the suppliers who can sell you a domain and set up mailboxes on it, with what each one charges and offers.

## 1. Epic

**Sending infrastructure procurement**

The epic gives a Harry user a way to get more places to send from — buying a lookalike domain, provisioning mailboxes on it, pointing it at the real website, and having those mailboxes turn up on the Mailboxes page ready to warm up — without leaving the app for a registrar and a mail-hosting console. It matters because Harry's entire sending capacity today is whatever Gmail accounts the user already owns and connects by OAuth, so growing outreach means an afternoon of manual work somewhere else.

**Honest gap note:** Harry does none of this. There is no registrar integration, no supplier relationship, no billing (the README is explicit that the published prices are presentational and nothing charges a card), and no support for a mailbox that is not a Google OAuth or sandbox account. This is the only category in this backlog that cannot start as engineering work: it needs a commercial arrangement and a payment path first.

## 2. User story

**As a** marketer about to buy sending capacity, **I want** to see which suppliers are available and what each one offers, **so that** I can choose one knowingly instead of being handed a default.

**Acceptance criteria**
- [ ] Given the vendor list is fetched, when it returns `{"ok": true, "data": [...]}`, then each vendor is shown with its id, name, price and what it includes, and the id is what every later call uses as `vendor_id`.
- [ ] Given no vendor is available in the user's country, when the list is fetched, then the response's empty `data` is shown as "No suppliers available for your region yet" with a link to contact support, not a blank panel.
- [ ] Given the response shape is thin in the published documentation (`data` is an empty array in the only example), when this is built, then the client must tolerate unknown fields and must not break if a vendor lacks a price or a description.
- [ ] Given a vendor is selected, when the user moves on to searching domains, then the selection is carried through as `vendor_id` and shown at every subsequent step, because prices and availability differ per vendor.
- [ ] Given the API key is missing or invalid, when the list is fetched, then the 401 `{"message": "Invalid API Key"}` is shown as "Domain purchasing is not connected" with a link to the setting that enables it.
- [ ] Given the marketplace is unreachable or returns 500, when the list is fetched, then the whole purchasing area shows one honest unavailable state and the rest of the Mailboxes page keeps working.
- [ ] Given the workspace has no payment method configured, when the vendor list renders, then prices are shown but every Buy action is disabled with "Add a payment method first" — nothing in Harry may take a purchase decision on the user's behalf.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Call with a valid key against a stubbed marketplace returning two vendors | 200, `ok: true`, two vendors rendered with id, name and price |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; "Domain purchasing is not connected" |
| TC-3 | Not found / wrong workspace | Call with a key belonging to an account without marketplace access | The access-gated error is shown as "Contact support to enable domain purchasing", with no vendor data |
| TC-4 | Validation failure | Call with a stray unsupported parameter | 400; the client never sends unsupported parameters and the error is logged, not shown |
| TC-5 | Rate limited | Call 30 times in one second | 429; the list is cached for the session and the panel never blanks |
| TC-6 | Empty result set | Stub the marketplace to return `data: []` | 200; "No suppliers available for your region yet" with a contact link |
| TC-7 | Partial vendor record | Stub a vendor with no price and no description | The row renders with what is known and reads "Price shown at checkout" rather than throwing |
| TC-8 | Marketplace down | Force a 500, then a 503 | One unavailable state for the purchasing area; Mailboxes, campaigns and sending are unaffected |
| TC-9 | No payment method | Load the list on a workspace with no payment method | Prices visible, every Buy disabled with "Add a payment method first" |
| TC-10 | Vendor selection carried | Select vendor 2, then open domain search | The search request carries `vendor_id=2` and the chosen supplier is named on screen |

## 4. Frontend user story

**As a** marketer, **I want** the supplier choice to be one clear step, **so that** buying sending capacity does not start with a decision I do not understand.

**Scope**
- Mailboxes page: a "Get more mailboxes" panel, hidden entirely unless the workspace has marketplace access. Opening it starts a short flow whose first step is choosing a supplier.
- Each supplier is a card with name, price, what is included, and any regional limits. The chosen supplier stays visible in the flow's header at every later step.
- Loading shows skeleton cards; empty shows the regional message; error shows one unavailable state for the panel only.
- Every price is shown in the currency the supplier quotes, with no conversion invented by Harry.
- Accessibility: the cards are a radio group with a legend, keyboard-selectable, and the selected supplier announced. On narrow screens cards stack full width.

**Definition of done**
- [ ] The panel is absent, not disabled, without marketplace access.
- [ ] A vendor with missing fields renders without error.
- [ ] The chosen supplier is visible at every later step of the flow.
- [ ] Empty, error and no-payment-method states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** the marketplace behind one env-gated adapter, **so that** an unconfigured workspace behaves exactly as Harry already behaves without an Anthropic key or Google OAuth — honestly and without crashing.

**Scope**
- Route: `GET /api/senders/vendors` in `server/routes.js`, returning `{ ok: true, data: [] }` with a clear `configured: false` when the marketplace credentials are absent.
- New module `server/senders.js` following the pattern of `server/google.js`: env-gated credentials, graceful fallback, honest UI when unconfigured. It is the only module that talks to the marketplace host.
- Data model: none for this endpoint. The vendor list is cached in memory for the session with a short TTL; it is reference data, not workspace data.
- Timeouts are short and failures are non-fatal — the marketplace is a third party and must never be able to slow down or break Harry's own pages.
- Telemetry: request latency and outcome per marketplace call to `telemetry`, so Monitoring can show whether the supplier is responding. Nothing to `events` — listing suppliers is not an auditable act.

**Definition of done**
- [ ] With no marketplace credentials configured, every route in this category returns a clean unconfigured response and no page errors.
- [ ] Vendor records with missing optional fields are tolerated, covered by a test.
- [ ] Marketplace latency appears on Monitoring.
- [ ] No marketplace call is made on any page load outside the purchasing panel.

## 6. End-to-end test ticket

**Title:** E2E — Choose a mailbox supplier

**Preconditions:** A workspace with marketplace access enabled against a stubbed supplier service returning two vendors, and a second workspace with no marketplace credentials configured.

**Flow**
1. Sign in to the unconfigured workspace and open Mailboxes.
2. Sign in to the enabled workspace and open Mailboxes.
3. Open "Get more mailboxes".
4. Select a supplier and continue to domain search.
5. Stop the stubbed supplier service and reload.

**Assertions**
- [ ] The unconfigured workspace shows no purchasing panel at all.
- [ ] The enabled workspace shows the panel with two supplier cards and their prices.
- [ ] Selecting a supplier carries its id into the next step and shows its name in the flow header.
- [ ] With no payment method on the workspace, Buy actions are disabled with the reason given.
- [ ] With the supplier service down, the panel shows one unavailable state and connecting an existing Gmail mailbox still works normally.

**Teardown:** Reset the stub, clear cached vendor data and the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | A "Get more mailboxes" panel gated on marketplace access | Medium | Absent entirely without access; the existing Connect Gmail path stays the primary action |
| Monitoring | Marketplace latency in the existing telemetry section | Low | One more row |

**Verdict:** Fits an existing surface

Mailboxes is already the page where sending capacity is added, so the supplier choice belongs at the bottom of it rather than in a new section. The honest caveat is that this whole flow is gated on a commercial arrangement Harry does not have, so the safest build order is the env-gated adapter first — which costs nothing when unconfigured, exactly like `server/google.js`.
