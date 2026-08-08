# Get Purchased Domain List

| | |
|---|---|
| **Endpoint** | `GET https://smart-senders.smartlead.ai/api/v1/smart-senders/get-domain-list` |
| **Category** | smart-senders |
| **Source** | https://api.smartlead.ai/api-reference/smart-senders/domain-list |
| **Auth** | API key (query param `api_key`) |

Lists every domain you have bought through the marketplace, so you can see what you own and what is running on it.

## 1. Epic

**Sending infrastructure procurement**

The epic gives a Harry user a way to get more places to send from — buying a lookalike domain, provisioning mailboxes on it, pointing it at the real website, and having those mailboxes turn up on the Mailboxes page ready to warm up — without leaving the app for a registrar and a mail-hosting console. It matters because Harry's entire sending capacity today is whatever Gmail accounts the user already owns and connects by OAuth, so growing outreach means an afternoon of manual work somewhere else.

**Honest gap note:** Harry does none of this. There is no registrar integration, no supplier relationship, no billing (the README is explicit that the published prices are presentational and nothing charges a card), and no support for a mailbox that is not a Google OAuth or sandbox account. This is the only category in this backlog that cannot start as engineering work: it needs a commercial arrangement and a payment path first.

## 2. User story

**As a** marketer running outreach from several domains, **I want** one list of the domains I have bought, **so that** I know what I am paying for and which domains my mailboxes actually sit on.

**Acceptance criteria**
- [ ] Given domains have been purchased, when the list is fetched, then each is shown with its name and, where the supplier provides it, its status and renewal date; unknown fields are tolerated rather than causing a render failure.
- [ ] Given the published documentation shows only `{"ok": true, "data": []}`, when this is built, then the client must treat the row shape as unknown-tolerant and must display gracefully with only a domain name available.
- [ ] Given nothing has been purchased, when the list is fetched, then it reads "No purchased domains" with a link into the purchasing flow, and it is hidden entirely for workspaces without marketplace access.
- [ ] Given a domain has mailboxes connected in Harry, when it renders, then the count of Harry mailboxes on that domain is shown beside it, joining the marketplace's view to Harry's own.
- [ ] Given a purchased domain has no mailboxes connected in Harry, when it renders, then it is flagged as unused with an action to add its mailboxes, because a paid domain doing nothing is worth surfacing.
- [ ] Given the API key is missing or invalid, when the list is fetched, then the 401 `{"message": "Invalid API Key"}` is shown as "Domain purchasing is not connected" and the rest of Mailboxes is unaffected.
- [ ] Given the marketplace is down, when the list is fetched, then the last known list is shown with an "as of" time rather than an empty panel, because domain ownership does not change minute to minute.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Call with a valid key against a stub returning three domains | 200, `ok: true`; three rows with their names and any status the stub provides |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; "Domain purchasing is not connected" |
| TC-3 | Not found / wrong workspace | Call with a key for an account without marketplace access | The access error is shown as "Contact support to enable domain purchasing"; no domain data |
| TC-4 | Validation failure | Call with an unsupported extra parameter | 400 logged, not shown; the client never sends one |
| TC-5 | Rate limited | Call 30 times in one second | 429; the list is cached and shown with an "as of" time rather than blanking |
| TC-6 | Empty result set | Stub `data: []` | 200; "No purchased domains" with a link into the purchasing flow |
| TC-7 | Minimal row | Stub a domain with only a name | The row renders with the name alone and no error |
| TC-8 | Marketplace down | Force a 500 after a successful load | The previous list is shown with an "as of" time and one quiet notice |
| TC-9 | Mailbox join | Purchase two domains, connect mailboxes on one | The connected domain shows its mailbox count; the other is flagged as unused with an add action |
| TC-10 | Unconfigured workspace | Load Mailboxes with no marketplace credentials | No purchased-domains section appears at all |

## 4. Frontend user story

**As a** marketer, **I want** purchased domains listed where my mailboxes are, **so that** the relationship between what I bought and what I send from is obvious.

**Scope**
- Mailboxes page: a "Purchased domains" section beneath the mailbox list, present only when the workspace has marketplace access and at least one domain.
- Each row shows the domain, its Harry mailbox count, and an unused flag where applicable, with an action leading into the connection path for that domain's mailboxes.
- Loading shows skeleton rows; empty shows the purchase prompt; a marketplace failure shows the cached list with an "as of" time.
- Accessibility: a table with a caption, the unused flag conveyed as text not only colour, and actions named per domain in their accessible labels. On narrow screens rows collapse to two lines.

**Definition of done**
- [ ] The section is absent without marketplace access, not shown empty.
- [ ] Rows with only a domain name render correctly.
- [ ] The cached-with-timestamp fallback is used on failure.
- [ ] Empty, minimal-row, error and unused-domain states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** the domain list cached and joined to Harry's own mailboxes, **so that** one request answers both "what do I own" and "what am I using".

**Scope**
- Route: `GET /api/senders/domains` in `server/routes.js`, delegating to `server/senders.js`, returning the supplier's rows joined to a count of `mailboxes` whose address ends in each domain.
- Data model: none new. The supplier is the source of truth for ownership; Harry caches the last successful response per workspace with a timestamp so a marketplace outage degrades to stale rather than empty.
- Unknown fields are passed through untouched and never required; the mapper reads only the domain name defensively.
- Rate limited per workspace, short timeout, non-fatal failure. Telemetry: latency, row count and whether the cache was served. Nothing to `events`.

**Definition of done**
- [ ] A response containing only domain names is handled without error, covered by a test.
- [ ] The mailbox-count join is case-insensitive on domain and tested against a subdomain.
- [ ] A marketplace failure serves the cached list with its timestamp.
- [ ] An unconfigured workspace returns a clean unconfigured response.

## 6. End-to-end test ticket

**Title:** E2E — See purchased domains beside mailboxes

**Preconditions:** A workspace with marketplace access against a stubbed supplier returning two purchased domains, with Harry mailboxes connected on one of them and none on the other.

**Flow**
1. Sign in and open Mailboxes.
2. Read the Purchased domains section.
3. Use the add action on the unused domain.
4. Stop the stubbed supplier and reload.
5. Sign in to a workspace with no marketplace credentials and open Mailboxes.

**Assertions**
- [ ] Two domains are listed, one with its mailbox count and one flagged unused.
- [ ] The add action leads into the ordinary mailbox connection path, not a second one.
- [ ] With the supplier stopped, the previous list is still shown with an "as of" time and one quiet notice.
- [ ] Connecting an existing Gmail mailbox works normally throughout.
- [ ] The unconfigured workspace shows no Purchased domains section at all.

**Teardown:** Reset the stub, clear the cached list and the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | A Purchased domains section beneath the mailbox list | Low | Present only with marketplace access and at least one domain; same table styling as the mailbox list |
| Everywhere else | Nothing | Low | Ownership data is read-only reference information |

**Verdict:** Fits an existing surface

A list of domains you own is only interesting next to the mailboxes running on them, so it belongs at the bottom of the Mailboxes page and nowhere else. The docs for this endpoint are the thinnest in the category — one parameter and an empty example response — so the honest engineering position is to build it defensively and show only what the supplier actually returns.
