# Get Campaign List

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/campaign/list` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/campaign-list |
| **Auth** | API key (query param `api_key`) |

Returns a light list of every campaign — just the id and the name — so a reporting screen can build its campaign picker without loading whole campaigns.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer looking at Reports, **I want** a fast list of my campaigns by id and name, **so that** I can filter every chart on the page to the campaigns I care about without waiting for full campaign records to load.

**Acceptance criteria**
- [ ] Given a workspace with campaigns, when the Reports page loads, then the picker is populated from `data.campaign_list`, each entry carrying `id` and `name` only.
- [ ] Given a brand new workspace with no campaigns, when the Reports page loads, then the response is a 200 with `campaign_list: []` and the picker shows "No campaigns yet" with a link to Campaigns rather than an empty dropdown.
- [ ] Given the optional `client_ids` filter is supplied as a comma-separated string, when the list is fetched, then only campaigns belonging to those ids are returned.
- [ ] Given `client_ids` contains a value the caller cannot see, when the list is fetched, then those campaigns are silently excluded and no error reveals their existence.
- [ ] Given the API key is missing or wrong, when the list is fetched, then a 401 `{"message": "Invalid API Key"}` is surfaced as one clear banner and the rest of Reports keeps rendering from cached data.
- [ ] Given the list request fails or times out, when Reports renders, then the picker degrades to "All campaigns" and the charts still load.
- [ ] Given two campaigns share a name, when the picker renders, then they remain distinguishable because selection is keyed on `id`, never on `name`.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed three campaigns. Call the endpoint with a valid `api_key` | 200, `ok: true`, `data.campaign_list` has three objects each with `id` (number) and `name` (string) |
| TC-2 | Missing/invalid API key | Call with `api_key` omitted, then with a junk key | 401 with `{"message": "Invalid API Key"}`; UI shows "Reconnect your analytics source" |
| TC-3 | Not found / wrong workspace | Call with `client_ids` set to an id owned by someone else | 200 with `campaign_list: []` — no cross-workspace names leak; a 404 body `{"error": "Resource not found"}` is also handled without a crash |
| TC-4 | Validation failure | Call with `client_ids=abc,,-1` | 422 `{"error": "Invalid parameters provided"}`; message names `client_ids` |
| TC-5 | Rate limited | Call 30 times in one second | 429; client backs off once, then reuses the cached list rather than blanking the picker |
| TC-6 | Empty result set | Call on a workspace with zero campaigns | 200, `campaign_list: []`, picker shows the empty state |
| TC-7 | Multiple `client_ids` | Call with `client_ids=101,102` | Only campaigns under 101 and 102 come back; the count matches the fixture |
| TC-8 | Duplicate names | Seed two campaigns both named "Q1 Cold Outreach" | Both appear; selecting one filters by its `id` and the other stays unselected |
| TC-9 | Large workspace | Seed 500 campaigns | 200 within the normal latency budget; the picker virtualises or searches rather than rendering 500 rows |
| TC-10 | Upstream unavailable | Force a 503 | The picker falls back to "All campaigns", one toast is shown, and no chart request is cancelled |

## 4. Frontend user story

**As a** marketer, **I want** a campaign filter at the top of Reports, **so that** the funnel, rates and 30-day series can be narrowed to the campaigns I am actually running this month.

**Scope**
- Reports page: one campaign multi-select in the existing page header, defaulting to "All campaigns". The same component is reused by the Dashboard KPI tiles so the filter is learned once.
- Loading shows the control disabled with a skeleton label, not a spinner over the page. Empty shows "No campaigns yet" linking to Campaigns. Error keeps the control usable as "All campaigns" and marks it degraded.
- Selection is stored in the URL so a filtered Reports view can be shared with a teammate.
- Accessibility: a labelled combobox with type-ahead, full keyboard operation, and the selected count announced ("3 of 12 campaigns selected"). On narrow screens the control drops to full width above the charts.

**Definition of done**
- [ ] The picker is populated from one request shared by every chart on the page.
- [ ] Selecting campaigns refetches the charts once, not once per chart.
- [ ] Empty, loading and error states are covered by component tests.
- [ ] Reloading a shared URL restores the same selection.

## 5. Backend user story

**As a** Harry server, **I want** a cheap route that returns campaign ids and names for the current workspace, **so that** reporting screens never pull full campaign rows (playbook text included) just to build a dropdown.

**Scope**
- Add `GET /api/analytics/campaigns` to `server/routes.js`, workspace-scoped exactly like the existing campaign routes, returning `[{ id, name }]` only.
- Data model: none. It is a projection over the existing `campaigns` table.
- No pagination needed at Harry's scale, but the response is capped and sorted by `name` so ordering is stable; an optional `ids` query parameter mirrors SmartLead's `client_ids` for symmetry.
- Rate limiting uses the existing API limiter; the result is cached in-process for 30 seconds per workspace.
- Log a `telemetry` row on failure only — a successful picker fetch is not worth an event.

**Definition of done**
- [ ] Route returns ids and names and nothing else, verified by a shape test.
- [ ] Cross-workspace ids are filtered out rather than 404ing.
- [ ] An empty workspace returns `[]` with a 200.
- [ ] Response is under 5 KB for 100 campaigns.

## 6. End-to-end test ticket

**Title:** E2E — filter Reports by campaign

**Preconditions:** A workspace with three campaigns, one of which has zero activity; a sandbox mailbox; leads and messages seeded on the other two.

**Flow**
1. Sign in and open Reports.
2. Open the campaign picker and confirm all three names are listed.
3. Select only the campaign with zero activity.
4. Select all three again.
5. Copy the URL, open it in a new session, and confirm the selection is restored.

**Assertions**
- [ ] The picker lists exactly the three seeded names.
- [ ] With only the inactive campaign selected, the funnel and rate panels show their empty states, not zeros presented as results.
- [ ] With all three selected, the totals match the seeded messages.
- [ ] The shared URL restores the selection without a flash of unfiltered data.

**Teardown:** Delete the seeded campaigns, leads and messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | Adds one campaign filter to the existing header | Low | A single combobox, default "All campaigns", so the page looks unchanged until used |
| Dashboard | Reuses the same filter for the KPI tiles | Low | Same component, same URL parameter — nothing new to learn |
| Campaigns | None | Low | The full campaign list already lives here; this endpoint is only the lightweight projection |

**Verdict:** Fits an existing surface

Harry already knows its campaigns — the Campaigns page lists them in full. What is new is a cheap, id-and-name-only feed for filtering, which belongs in the header of Reports and nowhere else. No new navigation item, and the filter defaults to "All campaigns" so a user who never touches it sees the page exactly as it is today.
