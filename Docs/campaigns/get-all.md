# Get All Campaigns

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-all |
| **Auth** | API key (query param `api_key`) |

Lists every campaign in the workspace, newest first, with each one's status, schedule, tracking settings and sending limits.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** one list of all my campaigns with enough detail to tell them apart at a glance, **so that** I can see what is running, what is paused, and what is still a draft without opening each one.

**Acceptance criteria**
- [ ] Given campaigns exist, when I list them, then each entry carries at least the id, name, status, created and updated timestamps — the source API's `id`, `name`, `status`, `created_at`, `updated_at` — with the newest first.
- [ ] Given a campaign's status, when it is shown, then it is one of the lifecycle states the source API uses (`ACTIVE`, `PAUSED`, `STOPPED`, `ARCHIVED`, `DRAFTED`), rendered in Harry's plain-English wording (running, paused, stopped, archived, draft).
- [ ] Given each campaign carries a schedule, when I look at the list, then I can see its sending window without opening it — the timezone, the days of the week, and the start and end hours, matching the source API's `scheduler_cron_value` with `tz`, `days`, `startHour`, `endHour`.
- [ ] Given each campaign carries limits, when I look at it, then the maximum leads per day (`max_leads_per_day`) and the minimum gap between emails (`min_time_btwn_emails`) are visible, because those are what explain a campaign that looks slow.
- [ ] Given tracking can be turned off, when a campaign has open or click tracking disabled (the `track_settings` values `DONT_EMAIL_OPEN` and `DONT_LINK_CLICK`), then that is visible on the row, so nobody wonders why its open rate is zero.
- [ ] Given a campaign is a follow-on of another (`parent_campaign_id` is set), when it is listed, then it is shown under its parent rather than as a peer.
- [ ] Given archived campaigns exist, when I open the list, then they are hidden by default and reachable through a filter.
- [ ] Given a workspace with no campaigns, when I open the list, then I see an empty state with a "New campaign" action, not a blank table.
- [ ] Given a workspace with hundreds of campaigns, when I open the list, then it is paged or virtualised on Harry's side — the source API returns everything at once and explicitly leaves paging to the client.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET the campaign list on a workspace with three campaigns | 200 with an array of three objects, each carrying `id`, `name`, `status`, `created_at`, `updated_at`, `scheduler_cron_value`, `max_leads_per_day`, `min_time_btwn_emails`, ordered newest first |
| TC-2 | Missing/invalid API key | GET unauthenticated | 401, `{"message": "Invalid API Key"}`; the user is sent to sign-in |
| TC-3 | Not found / wrong workspace | Sign in as a member of workspace B | Only workspace B's campaigns are returned; workspace A's are absent, not merely hidden in the UI |
| TC-4 | Validation failure | GET with a malformed filter value (for example `status=RUNNING!`) | 422, `{"error": "Invalid parameters provided"}` with the offending parameter named |
| TC-5 | Rate limited | Poll the list every second | 429 on the excess; the client falls back to its cached list and a "last updated" note rather than showing an error |
| TC-6 | Empty result set | GET on a brand-new workspace | 200 with an empty array; the page shows the "No campaigns yet" empty state |
| TC-7 | Tracking flags | List a campaign whose `track_settings` is `["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"]` | The row shows tracking as off for both, and Reports explains the zero open rate rather than implying failure |
| TC-8 | Schedule rendering | List a campaign with `tz: "America/New_York"`, `days: [1,2,3,4,5]`, `09:00`–`19:00` | The row reads "Weekdays, 9am–7pm New York time" in the viewer's own words, with the campaign's timezone named |
| TC-9 | Follow-on campaigns | List a workspace containing a campaign with `parent_campaign_id` set | The child is nested under its parent and not counted twice in the totals |
| TC-10 | Sorting and ordering | Create a campaign, then list | The new campaign appears first without a manual refresh |
| TC-11 | Large list | List 500 campaigns | The page renders within budget; scrolling is smooth and the request is paged or virtualised client-side |
| TC-12 | Archived visibility | Archive one campaign, then list | It disappears from the default view and appears under the Archived filter with its data intact |

## 4. Frontend user story

**As a** campaign owner, **I want** the Campaigns page to answer "what is running and is it healthy" in one glance, **so that** I only open a campaign when there is something to do.

**Scope**
- Campaigns: a list where each row shows name, status, sending window, daily cap, leads attached, and headline rates (reply, interested), with follow-on campaigns nested under their parent.
- Filters for status (running, paused, draft, archived) as chips, plus text search on name. The active filter is reflected in the URL.
- Rows link to campaign detail; a status chip explains a holding campaign in plain words ("Holding — outside working hours, next email around 9:05am"), reusing the pacing reason the campaign page already computes.
- Loading: skeleton rows, never a spinner over the whole page. Empty: "No campaigns yet" with a New campaign action. Error: a retry banner above the last-known list rather than replacing it.
- Accessibility: the list is a table with proper headers; status is text plus colour, never colour alone; filter chips are toggle buttons with pressed state. Responsive: rows collapse to stacked cards under 768px, with name and status first.

**Definition of done**
- [ ] Every row explains its status in plain English, including why a running campaign is not sending right now.
- [ ] Status filters, search and nesting all work together without contradiction.
- [ ] Archived campaigns are hidden by default and findable in one click.
- [ ] The list stays responsive at 500 campaigns.

## 5. Backend user story

**As a** Harry API, **I want** one list route that returns campaigns with their computed state, **so that** the Campaigns page renders from a single request instead of fanning out per campaign.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns` accepting `status`, `q`, `limit` and `offset`, workspace-scoped, returning `{ campaigns: [], total }`.
- Data model: the existing `campaigns` table plus aggregate counts. Each row carries name, status, `archived_at`, schedule (timezone, days, start and end hour), daily cap, minimum gap, tracking flags, `parent_campaign_id`, linked goal, attached lead count and headline rates.
- Aggregates are computed in the same query rather than per row, so the list is one round trip; an index on `(workspace_id, archived_at, id desc)` keeps ordering cheap.
- Pagination is Harry's own — the source API returns everything and recommends client-side paging, which does not survive a large workspace. Default 50 per page. Standard rate limiting; responses carry a short cache header and the client shows a "last updated" note when serving from cache during a 429.
- Logged: nothing to `events` — listing is not an event. `telemetry` records list query duration so Monitoring can catch the aggregate query degrading.

**Definition of done**
- [ ] One request returns the full row shape the list needs, aggregates included.
- [ ] Paging, status filter and search are covered by tests, including their combination.
- [ ] A 500-campaign fixture returns within the query-time budget.
- [ ] Cross-workspace leakage is covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — Read the whole portfolio from the Campaigns page

**Preconditions:** A workspace with five campaigns: one running inside working hours, one running but outside its window, one paused, one draft, one archived; one has a follow-on campaign; one has open tracking disabled.

**Flow**
1. Open Campaigns.
2. Read the default list.
3. Filter to Running.
4. Search for the paused campaign by name.
5. Switch the filter to Archived.
6. Open the campaign whose window has closed.

**Assertions**
- [ ] The default list shows four campaigns, newest first, with the archived one absent.
- [ ] The follow-on campaign is nested under its parent and not counted as a top-level campaign.
- [ ] The out-of-hours campaign's row explains it is holding and states roughly when the next email goes.
- [ ] The campaign with tracking off shows that on its row rather than reporting a zero open rate without explanation.
- [ ] The Running filter shows exactly two campaigns; the search finds the paused one regardless of the active filter's wording.
- [ ] The Archived filter shows the archived campaign with its counts intact.

**Teardown:** Delete the five campaigns and their leads.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns | Richer rows, status filter chips, search, nesting | Medium | Everything on the row answers a question a user would otherwise open the campaign to answer; no row has more than six values |
| Dashboard | Campaign KPIs read from the same aggregates | Low | No new component; the numbers simply stop disagreeing with the list |
| Reports | Shares the aggregate query | Low | Reports keeps its own charts |

**Verdict:** Fits an existing surface

The Campaigns page already exists and is the natural home for this. The judgement call is how much to put on a row: enough to avoid opening the campaign, not so much that the page becomes a report. Status, sending window, daily cap and headline rates clear that bar; everything else stays on campaign detail.
