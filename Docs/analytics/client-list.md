# Get Client List

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/client/list` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/client-list |
| **Auth** | API key (query param `api_key`) |

Returns the id and name of every client under an agency account, so reporting screens can offer a "whose campaigns am I looking at" filter.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** consultant running outreach for several businesses out of one Harry workspace, **I want** a list of the accounts I report on, **so that** every chart on Reports can be narrowed to one client before I send it to them.

**Acceptance criteria**
- [ ] Given clients exist, when the list is requested, then `data.client_list` returns one `{ id, name }` object per client and nothing heavier.
- [ ] Given Harry has no client concept today, when this capability is built, then a client is introduced as a lightweight label on campaigns (a nullable `client_id` on `campaigns`) rather than as a second tenancy model, and every existing campaign keeps working with no client set.
- [ ] Given campaigns with no client, when the picker is used, then an "Unassigned" option groups them so no campaign disappears from a filtered report.
- [ ] Given the optional `client_ids` filter is supplied, when the list is requested, then only those clients are returned.
- [ ] Given the workspace has no clients, when the list is requested, then a 200 with `client_list: []` comes back and the client filter is hidden entirely rather than shown empty.
- [ ] Given the API key is invalid, when the list is requested, then a 401 `{"message": "Invalid API Key"}` is surfaced as one banner and Reports still renders unfiltered.
- [ ] Given a client is renamed, when Reports is reopened, then the new name appears without any cached label surviving.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed two clients, "Acme Corp" and "TechStart Inc". Call with a valid `api_key` | 200, `client_list` has two objects with `id` and `name` only |
| TC-2 | Missing/invalid API key | Call with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; the filter is hidden and one banner is shown |
| TC-3 | Not found / wrong workspace | Call with `client_ids` naming a client in another workspace | 200 with an empty list, or 404 `{"error": "Resource not found"}`; no names leak |
| TC-4 | Validation failure | Call with `client_ids=1,,abc` | 422 `{"error": "Invalid parameters provided"}` naming `client_ids` |
| TC-5 | Rate limited | Call 30 times in a second | 429; the client backs off once and reuses the cached list |
| TC-6 | Empty result set | Call on a workspace where no campaign has a client | 200, `client_list: []`, the client filter is not rendered at all |
| TC-7 | Unassigned campaigns | Seed three campaigns, one with a client and two without | The picker offers "Acme Corp" and "Unassigned"; selecting Unassigned shows the two |
| TC-8 | Rename | Rename a client, reload Reports | The new name shows; no stale label survives in the URL-restored selection |
| TC-9 | Duplicate names | Seed two clients both called "Acme" | Both appear and selection is keyed on `id`, so filtering picks the right one |
| TC-10 | Upstream unavailable | Force a 503 | The filter is hidden, one toast is shown, and no chart request is cancelled |

## 4. Frontend user story

**As a** consultant, **I want** a client filter on Reports that only appears once I actually have clients, **so that** solo users never see a control that means nothing to them.

**Scope**
- Reports page: an optional client select in the header, to the left of the existing campaign filter, rendered only when `client_list` is non-empty. Selecting a client narrows the campaign filter to that client's campaigns.
- Settings: a small "Clients" list where names are created, renamed and removed; the campaign editor gets one optional "Client" field.
- Loading shows the select disabled. Empty means the control is absent, not greyed out. Error hides the control and leaves Reports unfiltered.
- Accessibility: a labelled combobox with type-ahead and the selection announced; on narrow screens both filters stack full-width above the charts.

**Definition of done**
- [ ] The control is invisible for workspaces with no clients.
- [ ] Choosing a client filters the campaign picker and every chart from one refetch.
- [ ] The selection lives in the URL so a client-scoped Reports link can be shared.
- [ ] "Unassigned" is always available when at least one campaign has no client.

## 5. Backend user story

**As a** Harry server, **I want** a cheap route returning client ids and names, **so that** reporting can group campaigns by account without a second tenancy layer.

**Scope**
- Add `GET /api/analytics/clients` to `server/routes.js`, workspace-scoped, returning `[{ id, name }]`.
- Data model: a `clients` table (`id`, `user_id`, `name`, `created_at`) and a nullable `client_id` on `campaigns`, added by migration in `server/db.js`. Nothing is required — existing campaigns stay unassigned and every current query keeps working.
- No pagination. The existing API limiter applies; the list is cached in-process for 30 seconds per workspace.
- Log an `events` row when a client is created, renamed or deleted, so the activity trail explains a change in report grouping.

**Definition of done**
- [ ] The migration is additive and reversible; a workspace that never uses clients sees no behaviour change.
- [ ] Deleting a client sets `client_id` to null on its campaigns rather than deleting them.
- [ ] Cross-workspace clients are never returned.
- [ ] Route returns ids and names only, verified by a shape test.

## 6. End-to-end test ticket

**Title:** E2E — group Reports by client

**Preconditions:** A workspace with two clients, three campaigns (two under client A, one unassigned), leads and messages seeded on a sandbox mailbox.

**Flow**
1. Sign in and open Reports on a workspace with no clients; confirm no client filter is shown.
2. Create client A and client B in Settings and assign two campaigns to A.
3. Reload Reports and select client A.
4. Select "Unassigned".
5. Select client B.

**Assertions**
- [ ] The filter appears only after the first client exists.
- [ ] Client A's view shows only its two campaigns and totals matching their seeded messages.
- [ ] Unassigned shows exactly the third campaign.
- [ ] Client B shows the empty state naming the client, not a zeroed chart.
- [ ] Creating and renaming a client each write one row to the activity trail.

**Teardown:** Delete the seeded clients, campaigns, leads and messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | Adds a client filter that only exists once clients do | Medium | Hidden entirely for solo workspaces, which is most of them |
| Settings | A small Clients list | Low | One simple list, alongside Team, no new navigation item |
| Campaigns | One optional Client field in the editor | Low | Optional and last in the form, so the editor still opens on the playbook |

**Verdict:** Fits an existing surface

Harry has no client concept today — the nearest thing is a Goal, which groups campaigns by outcome rather than by who is paying. This is the one endpoint in the analytics set that needs a small data model addition before it means anything, so the honest scope is a nullable label plus a filter that stays invisible until it is used. No new page and no new navigation item.
