# Get Top Level Analytics by Date

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/top-level-analytics-by-date` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-top-level-analytics |
| **Auth** | API key (query param `api_key`) |

Returns the headline numbers for one campaign over a date range you choose — how many emails went out, how many landed, and the open and reply rates for that window.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner, **I want** the headline numbers for a campaign over a date range I pick, **so that** I can tell whether last week was better than the week before instead of only seeing an all-time total.

**Acceptance criteria**
- [ ] Given a campaign with sends inside the range, when I request analytics with `start_date` and `end_date`, then I get `total_sent`, `total_delivered`, `open_rate` and `reply_rate` computed only from activity inside that window.
- [ ] Given a range with no activity, when I request analytics, then I get a 200 with `total_sent: 0`, `total_delivered: 0`, and rates of `0` rather than `null` or a division-by-zero error.
- [ ] Given `start_date` is after `end_date`, when I request analytics, then the request is rejected with a field-level validation message and no numbers are shown.
- [ ] Given either date is missing or is not ISO 8601, when I request analytics, then the request is rejected before any query runs.
- [ ] Given a campaign that belongs to another workspace, when I request analytics, then I get a not-found response and no counts leak.
- [ ] Given open tracking has never fired on this campaign, when `open_rate` is `0`, then the response distinguishes "no opens recorded" from "tracking not working" so the UI does not imply failure.
- [ ] Given rates are returned as percentages (for example `45.0`, `8.5`), when they are displayed, then they are rendered to one decimal place and never re-divided by 100.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign with 500 sent, 490 delivered, over Jan 2025. Request with `start_date=2025-01-01T00:00:00Z`, `end_date=2025-01-31T23:59:59Z` | 200 with `total_sent: 500`, `total_delivered: 490`, `open_rate` and `reply_rate` as numbers |
| TC-2 | Missing/invalid API key | Repeat TC-1 with `api_key` omitted | 401; UI shows "Reconnect your analytics source" rather than a blank chart |
| TC-3 | Not found / wrong workspace | Request analytics for a campaign id owned by a different workspace | 404; no counts in the body |
| TC-4 | Validation failure | Send `start_date=2025-02-01`, `end_date=2025-01-01` | 422 with a message naming `start_date` |
| TC-5 | Rate limited | Fire the request 30 times in a second | 429; client backs off and retries once, then shows a "still loading" state, never a partial chart |
| TC-6 | Empty result set | Request a range that predates the campaign's first send | 200, all counters `0`, empty state reads "No activity in this range" |
| TC-7 | Range boundary | Seed one send at exactly `end_date` | That send is counted; the boundary is inclusive and documented |
| TC-8 | Delivered exceeds sent | Force a fixture where delivered > sent | Response is flagged as inconsistent in telemetry, UI clamps the delivery rate at 100% |
| TC-9 | Timezone drift | Request the same day from a browser in UTC+11 and one in UTC | Both resolve to the same ISO window; the label states which timezone is applied |
| TC-10 | Very long range | Request a two-year window | 200 within the normal latency budget, or a documented ceiling with a clear message |

## 4. Frontend user story

**As a** campaign owner, **I want** a date-range switcher on the campaign detail page, **so that** the headline numbers answer "how is it going now", not "how has it ever gone".

**Scope**
- Campaign detail page: a compact range control (Last 7 days / Last 30 days / Custom) above the existing KPI row; Reports page reuses the same control so there is one mental model.
- Loading shows skeleton tiles in place of the four numbers, not a spinner over the page. Empty range shows "No activity between <from> and <to>" with a link to widen the range. Errors keep the last good numbers visible and mark them stale.
- The four figures are `total_sent`, `total_delivered`, `open_rate`, `reply_rate`; each tile carries a short caption in plain English ("490 of 500 landed").
- Accessibility: the range control is a labelled listbox reachable by keyboard; each KPI tile is a definition list entry so screen readers read label and value together. On narrow screens the tiles stack two-up.

**Definition of done**
- [ ] Changing the range updates all four tiles from one request, not four.
- [ ] The selected range is reflected in the URL so a link can be shared.
- [ ] Rates render to one decimal place with a `%` suffix and never show `NaN`.
- [ ] Empty and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** one route that returns a campaign's headline metrics for an explicit window, **so that** the UI never aggregates raw message rows in the browser.

**Scope**
- Add `GET /api/campaigns/:id/analytics?from=&to=` to `server/routes.js`, workspace-scoped like every other campaign route.
- Data model: none. Derive counts from the existing `messages` table plus tracking events; do not store a rollup that can drift.
- Validate both dates as ISO 8601 and reject an inverted range with a 422 naming the offending field. Cap the range length and say so in the error.
- Rate limiting follows the existing API limiter; a repeated identical range is served from a short-lived in-process cache.
- Log a `telemetry` row per call with campaign id, window length and duration so slow ranges are visible on Monitoring.

**Definition of done**
- [ ] Route returns `{ total_sent, total_delivered, open_rate, reply_rate }` with rates as percentages.
- [ ] Zero-activity windows return zeros, never nulls.
- [ ] Cross-workspace access returns 404.
- [ ] Unit tests cover boundary inclusivity and the inverted-range rejection.

## 6. End-to-end test ticket

**Title:** E2E — campaign headline metrics for a chosen date range

**Preconditions:** A workspace with one running campaign, a sandbox mailbox, 10 leads, 8 sends recorded across two distinct weeks, 2 replies in the second week.

**Flow**
1. Sign in and open Campaigns, then the seeded campaign.
2. Confirm the KPI row shows the default range.
3. Switch the range to the first week.
4. Switch the range to the second week.
5. Switch to a custom range that predates all activity.

**Assertions**
- [ ] The first week shows sends but a 0% reply rate.
- [ ] The second week shows a non-zero reply rate matching the seeded replies.
- [ ] The pre-activity range shows the empty state with the range echoed in the message.
- [ ] The URL carries the range and reloading restores the same view.
- [ ] Monitoring shows one telemetry entry per range change.

**Teardown:** Delete the seeded campaign, leads and messages; clear the telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | Adds a range control above the existing KPI row | Low | One control, three presets, custom hidden behind the third option |
| Reports | Existing charts adopt the same range control | Medium | Share one component and one URL parameter so the two pages behave identically |
| Monitoring | New telemetry rows only | Low | No new panel; folds into the existing tick-duration list |

**Verdict:** Fits an existing surface

The campaign detail page already shows headline numbers; this makes them answer a question about a period instead of about all time. No new navigation item, no new page, and the same control is reused on Reports so a user learns it once.
