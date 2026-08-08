# Get All Leads Activities

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/all-leads-activities` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/all-leads-activities |
| **Auth** | API key (query param `api_key`) |

Returns a single, time-ordered stream of what leads have done — opens, clicks, replies — across every campaign in the workspace.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner running several campaigns at once, **I want** one feed of lead activity across all of them, **so that** I can see what is happening today without opening each campaign in turn.

**Acceptance criteria**
- [ ] Given activity exists across several campaigns, when I request the feed, then I get a paged list where each entry carries the lead's email, the campaign id and name, the activity type and the event time — the fields the source API returns as `lead_email`, `campaign_id`, `campaign_name`, `activity_type`, `event_time` — plus a `total` count.
- [ ] Given I ask for a window, when I pass a from and to timestamp (ISO 8601, the `event_time_from` / `event_time_to` behaviour), then only activity inside that window is returned, inclusive of the boundaries.
- [ ] Given a large workspace, when I page with offset and limit, then the default page is 100 entries, the maximum is 1000, and offset cannot be negative.
- [ ] Given no activity in the requested window, when I request the feed, then I get a 200 with an empty list and a `total` of 0, and the UI shows an empty state rather than a spinner or an error.
- [ ] Given activity in campaigns I do not have access to, when I request the feed, then those entries are absent — the feed is workspace-scoped, never account-wide across workspaces.
- [ ] Given entries at the same timestamp, when they are returned, then ordering is stable (newest first, tie-broken by id) so paging cannot skip or repeat an entry.
- [ ] Given a lead was deleted, when its past activity is returned, then the entry still shows the email it applied to rather than failing the whole request.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET the feed with `limit=100` on a workspace with 250 activities | 200, `total: 250`, `data` array of 100 entries each with `lead_email`, `campaign_id`, `campaign_name`, `activity_type`, `event_time` |
| TC-2 | Missing/invalid API key | GET with no credentials | 401; UI redirects to sign-in, feed state discarded |
| TC-3 | Wrong workspace | Sign in as a user in workspace B and request the feed | 200 but zero entries from workspace A's campaigns |
| TC-4 | Validation failure | GET with `limit=5000` and `offset=-1` | 422 with field-level messages naming `limit` (max 1000) and `offset` (min 0) |
| TC-5 | Rate limited | Poll the feed every second for a minute | 429 on the excess; client falls back to the standard refresh interval and shows "Live updates paused" |
| TC-6 | Empty result set | Request a window in the future | 200, `total: 0`, empty `data`; UI shows "No activity in this period" |
| TC-7 | Date window filter | Set the window to today only on a workspace with a week of history | Only today's entries returned; the count matches a manual count in Reports |
| TC-8 | Paging consistency | Fetch offset 0 and offset 100 with limit 100 | No entry appears in both pages; concatenated, the two pages are strictly newest-first |
| TC-9 | Malformed date | Pass `event_time_from=yesterday` | 422 naming the parameter and stating ISO 8601 is required |
| TC-10 | Activity type coverage | Trigger a send, open, click and reply on one lead | All four appear as distinct `activity_type` values on the same lead, in the right order |

## 4. Frontend user story

**As a** campaign owner, **I want** the Dashboard activity trail to cover every campaign with a date filter, **so that** my first screen each morning tells me what moved overnight.

**Scope**
- Dashboard: the existing agent activity trail gains cross-campaign lead activity, a date-range control (Today / 7 days / 30 days / custom) and a filter by activity type.
- Each row links straight to the lead on Leads and to the thread in Inbox, so the feed is a way in rather than a dead end.
- Infinite scroll in pages of 100 with a "Load more" fallback; loading shows skeleton rows, the empty case says "No activity in this period" with the filter that produced it named, errors show a retry that keeps the current filter.
- Accessibility: the feed is a list with each entry a single readable sentence ("Priya at Northwind opened your second email — 2:31pm"); the date control is keyboard-operable; activity types are labelled in text, not by icon alone. Responsive: rows wrap to two lines under 640px with the timestamp on its own line.

**Definition of done**
- [ ] The Dashboard trail shows activity from every campaign in the workspace, newest first.
- [ ] Date range and activity-type filters both work and are reflected in the URL so a view can be shared.
- [ ] Paging never repeats or drops an entry while new activity arrives.
- [ ] Loading, empty and error states are all designed and verified.

## 5. Backend user story

**As a** Harry API, **I want** a paged, filterable cross-campaign activity feed, **so that** the Dashboard can render one stream without querying each campaign separately.

**Scope**
- Route in `server/routes.js`: `GET /api/activity` accepting `from`, `to`, `limit` (default 100, max 1000), `offset` (min 0) and optional `type`, workspace-scoped like the neighbouring handlers.
- Data model: no new table. The feed is a union over `messages` (sent, opened, clicked, replied), `events` (agent decisions, approvals) and outcome changes, ordered by timestamp descending with id as tiebreaker. Add an index on `(workspace_id, created_at desc)` for each source table so the query stays fast as history grows.
- Pagination by offset to match the source contract, with the total returned alongside; the query caps at 1000 rows regardless of what is asked. Standard app rate limiting; the client backs off on 429.
- Logged: `telemetry` records feed query duration and row counts so Monitoring can flag when the union query starts to slow down. No `events` row is written — reading the trail is not itself an event.

**Definition of done**
- [ ] One query returns the union, correctly ordered, with a stable tiebreaker.
- [ ] Filters for date window and activity type are covered by tests, including boundary timestamps.
- [ ] Indexes added and a test asserts query time stays within budget on a 100k-row fixture.
- [ ] Cross-workspace leakage is covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — One activity feed across every campaign

**Preconditions:** A workspace with two campaigns, one sandbox mailbox each, three leads per campaign, approvals on, tracking enabled.

**Flow**
1. Launch both campaigns and approve one draft in each from Inbox → Needs your OK.
2. Simulate an open and a click on one sandbox message, and a reply on another.
3. Open Dashboard.
4. Set the date filter to Today.
5. Filter by activity type "replied".
6. Click through from a feed row to the lead.

**Assertions**
- [ ] The trail shows entries from both campaigns interleaved by time, each naming its campaign.
- [ ] The send, open, click and reply all appear as separate, correctly ordered entries.
- [ ] The "replied" filter narrows the list to exactly one entry.
- [ ] Clicking a row lands on that lead's page with their thread visible.
- [ ] Setting the range to last month yields the empty state, not an error.

**Teardown:** Delete both campaigns, their leads, and the sandbox messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Dashboard | Existing activity trail extended with date and type filters | Medium | Filters default to Today with no chips shown until one is changed; the trail's row format is unchanged |
| Leads | Deep links arrive from the feed | Low | No new component, just an anchor target |
| Reports | Shares the same underlying query | Low | Reports keeps its aggregate charts; the feed stays raw and chronological |

**Verdict:** Fits an existing surface

Harry's Dashboard already ends with a full agent activity trail; this endpoint's job is to widen that trail from agent decisions to lead behaviour and give it a date window. Adding a separate "Activity" page would split one story across two screens, so the work goes into the trail that is already there.
