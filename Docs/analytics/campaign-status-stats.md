# Campaign Status Stats

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/campaign/status-stats` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/campaign-status-stats |
| **Auth** | API key (query param `api_key`) |

Counts how many campaigns are sitting in each state right now — started, paused, completed — so you can see the shape of the workload at a glance.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer with a dozen campaigns, **I want** a count of campaigns per status, **so that** I can see at a glance that four are running and three have been paused for a fortnight without scrolling the Campaigns list.

**Acceptance criteria**
- [ ] Given campaigns exist, when I request status stats, then `data.campaign_status_stats` returns one `{ status, count }` object per state present, using Harry's own states (draft, running, holding, paused, completed) rather than SmartLead's `STARTED` / `PAUSED` / `COMPLETED` labels.
- [ ] Given a status has no campaigns, when the stats are rendered, then it is omitted from the response and the UI shows only the states that exist rather than a row of zeros.
- [ ] Given the counts are summed, when compared with the Campaigns page, then the total equals the number of campaigns visible there — no hidden or archived campaign inflates it.
- [ ] Given the optional `client_ids` filter is supplied, when the stats are requested, then only campaigns under those ids are counted.
- [ ] Given the workspace has no campaigns at all, when I request status stats, then I get a 200 with an empty list and the UI shows the existing "Create your first campaign" prompt, not an empty chart.
- [ ] Given a campaign is paused while the page is open, when the stats refresh, then the counts move between states without a full page reload.
- [ ] Given the API key is missing, when the stats are requested, then a 401 is surfaced as one banner and the rest of the Dashboard still renders.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 5 running, 2 paused and 8 completed campaigns. Call with a valid `api_key` | 200, `campaign_status_stats` contains `{status: "STARTED", count: 5}`-equivalent rows totalling 15 |
| TC-2 | Missing/invalid API key | Call with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; the tile shows a reconnect message |
| TC-3 | Not found / wrong workspace | Pass `client_ids` for another workspace | 200 with an empty list or 404 `{"error": "Resource not found"}`; no counts leak |
| TC-4 | Validation failure | Pass `client_ids=not-a-number` | 422 `{"error": "Invalid parameters provided"}` naming `client_ids` |
| TC-5 | Rate limited | Call 30 times in a second | 429; the client backs off and keeps the last known counts, marked stale |
| TC-6 | Empty result set | Call on a workspace with zero campaigns | 200, `campaign_status_stats: []`, the Campaigns empty state is shown instead of a zeroed chart |
| TC-7 | Only one state present | Seed 3 drafts and nothing else | Exactly one row is returned; the UI does not invent rows for the missing states |
| TC-8 | Status change during session | Pause a running campaign, then refresh the stats | Running drops by one and paused rises by one; the totals stay constant |
| TC-9 | Unknown status value | Force a fixture with a status Harry does not recognise | The row is bucketed as "Other" and a telemetry warning is logged; nothing crashes |
| TC-10 | Total agrees with list | Compare the summed counts with the row count on the Campaigns page | The two match exactly for the same workspace |

## 4. Frontend user story

**As a** marketer, **I want** the campaign states summarised on the Dashboard, **so that** I notice a campaign paused by accident before it costs me a week.

**Scope**
- Dashboard: one compact status strip beside the existing KPI tiles — "4 running, 2 holding, 3 paused, 8 done" — where each chip links to the Campaigns page pre-filtered to that state.
- Campaigns page: the same counts appear on the existing filter chips so the two surfaces share one source.
- Loading shows the strip as skeleton chips. Empty falls through to the existing "Create your first campaign" prompt. Error hides the strip entirely rather than showing wrong counts.
- Accessibility: the strip is a list of links with text labels including the count, readable without colour; on narrow screens it wraps rather than scrolling sideways.

**Definition of done**
- [ ] Chips render only for states with at least one campaign.
- [ ] Each chip navigates to Campaigns with the matching filter applied.
- [ ] The strip disappears cleanly on error instead of showing zeros.
- [ ] Counts refresh with the rest of the Dashboard poll, not on their own timer.

## 5. Backend user story

**As a** Harry server, **I want** a single grouped count of campaigns by status, **so that** the Dashboard does not fetch every campaign row to count them in the browser.

**Scope**
- Add `GET /api/analytics/campaigns/status-counts` to `server/routes.js`, workspace-scoped, returning `[{ status, count }]`.
- Data model: none. A `GROUP BY status` over the existing `campaigns` table; the "holding" state is derived from `server/pacing.js` rather than stored, so it is computed in the same query path used by the campaign detail page.
- No pagination. The existing API limiter applies; the result is cached in-process for 15 seconds per workspace.
- Log a `telemetry` row only when an unrecognised status appears, so drift between the parser and the reporting layer is visible on Monitoring.

**Definition of done**
- [ ] States with a zero count are omitted from the payload.
- [ ] The derived "holding" state matches what the campaign detail page says for the same campaign.
- [ ] Cross-workspace campaigns are never counted.
- [ ] A unit test asserts the summed counts equal the workspace's campaign count.

## 6. End-to-end test ticket

**Title:** E2E — campaign status summary on the Dashboard

**Preconditions:** A workspace with two running campaigns, one paused, one draft, one completed, on a sandbox mailbox.

**Flow**
1. Sign in and open the Dashboard.
2. Read the status strip.
3. Click the "paused" chip.
4. Resume the paused campaign from the Campaigns page.
5. Return to the Dashboard.

**Assertions**
- [ ] The strip shows four chips and no chip for states with no campaigns.
- [ ] The paused chip lands on Campaigns filtered to paused, showing exactly one campaign.
- [ ] After resuming, the Dashboard shows three running and no paused chip at all.
- [ ] The summed counts equal the number of rows on the Campaigns page throughout.

**Teardown:** Delete the seeded campaigns.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Dashboard | Adds a one-line status strip near the existing KPI tiles | Low | Text chips, no chart; hidden entirely when there are no campaigns |
| Campaigns | Existing filter chips gain counts | Low | Numbers only, on controls that already exist |
| Monitoring | A telemetry warning for unknown statuses | Low | Folds into the existing incident feed |

**Verdict:** Fits an existing surface

Harry already knows every campaign's state and already filters the Campaigns page by it — this endpoint's value is only that the counts are pre-aggregated so the Dashboard can show them without loading the list. It earns one line of text next to the KPI tiles and nothing more.
