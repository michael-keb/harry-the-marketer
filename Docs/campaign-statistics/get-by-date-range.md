# Fetch Campaign Statistics by Date Range

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/analytics-by-date` |
| **Category** | campaign-statistics |
| **Source** | https://api.smartlead.ai/api-reference/campaign-statistics/get-by-date-range |
| **Auth** | API key (query param `api_key`) |

Returns one campaign's sending and engagement numbers for a chosen window of days, read in a timezone you name.

## 1. Epic

**Per-campaign performance breakdown**

The epic gives a Harry user the numbers behind a single campaign — sent, opened, clicked, replied, unsubscribed, bounced — sliced by playbook step, by lead, by mailbox and by date, without leaving the campaign they are already looking at. It matters because Reports answers "how is outreach going" for the whole workspace, while the decisions that change next week (rewrite this step, rest that mailbox, stop chasing this segment) are made inside one campaign, where Harry today shows only node counts.

## 2. User story

**As a** marketer on a campaign detail page, **I want** that campaign's stats for a date range I pick, **so that** I can tell whether the change I made last Tuesday actually improved replies.

**Acceptance criteria**
- [ ] Given a running campaign and a `start_date` and `end_date` in `YYYY-MM-DD`, when the range is applied, then only activity inside that window is counted and the campaign header reads "12 Mar – 26 Mar".
- [ ] Given no `time_zone` is supplied, when the range is applied, then day boundaries are computed in the browser's IANA timezone (the same one Harry already reads for sending hours) and that timezone is named on screen.
- [ ] Given `time_zone` is set to `America/New_York`, when the same range is fetched again, then the day buckets shift accordingly and totals may differ from the UTC reading without either being an error.
- [ ] Given a range in which the campaign sent nothing, when the response returns `{"ok": true, "data": []}`, then the page shows "Nothing sent in this range" and offers the campaign's full lifetime as one click, not a blank chart.
- [ ] Given `end_date` is earlier than `start_date`, when the range is applied, then the request is rejected client-side with "End date must be on or after the start date" and no call is made.
- [ ] Given the API key is missing or invalid, when stats are fetched, then the 401 `{"message": "Invalid API Key"}` is shown once as "Reporting is disconnected" and the rest of the campaign page still renders.
- [ ] Given the campaign id belongs to another workspace, when stats are fetched, then a 404 is surfaced as "Campaign not found" with no detail about the other workspace.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign with sends across 1–31 Jan. Call with `start_date=2024-01-01&end_date=2024-01-31` | 200, `ok: true`, `data` is an array of per-day rows whose sent total matches the fixture |
| TC-2 | Missing/invalid API key | Call with `api_key` omitted, then with `api_key=junk` | 401 `{"message": "Invalid API Key"}`; UI banner "Reporting is disconnected", campaign page still usable |
| TC-3 | Not found / wrong workspace | Call with a campaign id owned by another workspace | 404; UI shows "Campaign not found", no name or counts leak |
| TC-4 | Validation failure | Call with `start_date=01-01-2024` | 400 with a message naming `start_date`; UI marks the date field and keeps the previous chart |
| TC-5 | Rate limited | Fire 30 range changes in one second by dragging the date slider | 429 handled by debouncing to one request per 400ms, then one backoff retry; no flicker |
| TC-6 | Empty result set | Call for a range before the campaign launched | 200 with `data: []`; "Nothing sent in this range" plus a "Show all time" button |
| TC-7 | Timezone shift | Call the same range with `time_zone=UTC` and `time_zone=Australia/Sydney` | Both 200; the boundary day's counts differ, and the UI labels which timezone produced the figures |
| TC-8 | Missing end date | Call with `start_date` only | 400; UI requires both dates before enabling Apply |
| TC-9 | Very long range | Call with a 2-year range | 200; the chart aggregates to weeks rather than rendering 730 points |
| TC-10 | Upstream slow | Force a 10s response | Chart keeps the previous range visible with a "Updating…" label, then swaps in one paint; no layout jump |

## 4. Frontend user story

**As a** marketer, **I want** a date-range control on the campaign detail page, **so that** I can compare this fortnight against the last one without exporting anything.

**Scope**
- Campaign detail page: a compact range control beside the existing Node performance panel, with presets (Last 7 days, Last 30 days, All time) and a custom range. The same control is reused on Reports so it is learned once.
- Loading keeps the previous numbers visible and dims them; empty shows "Nothing sent in this range" with a one-click escape to all time; error keeps the page and shows one banner.
- The selected range lives in the URL so a teammate opening the link sees the same window.
- Accessibility: the range control is a labelled group of two date inputs with keyboard entry as well as a picker; the chart has a text summary beneath it that screen readers can read instead of the SVG. On narrow screens the presets collapse to a select.

**Definition of done**
- [ ] Changing the range issues one request, not one per panel on the page.
- [ ] The timezone used is displayed next to the range and matches the browser's.
- [ ] Empty, loading, error and long-range aggregation are covered by component tests.
- [ ] Reloading the URL restores the same range.

## 5. Backend user story

**As a** Harry engineer, **I want** a route that returns per-day campaign stats for a range, **so that** the campaign page and Reports read the same numbers from one place.

**Scope**
- Route: `GET /api/campaigns/:id/analytics-by-date?start_date&end_date&time_zone`, mirroring the existing campaign routes in `server/routes.js` and guarded by the same workspace check.
- Data model: none new. Counts are derived from `messages` (sent, opened, clicked, replied, bounced) and `events` (unsubscribed) with day buckets computed in the requested IANA timezone, so nothing can drift the way a stored aggregate would.
- Validate `start_date`/`end_date` as `YYYY-MM-DD` and reject a reversed range with 400; cap the range at 400 days; apply the workspace rate limit already used for the reporting routes and answer 429 with `Retry-After`.
- Telemetry: one `telemetry` row per query with campaign id, range length, timezone and duration, so Monitoring can show when reporting queries slow down.

**Definition of done**
- [ ] The route returns `{ ok: true, data: [...] }` with one row per day in range, zero-filled for silent days.
- [ ] Day bucketing is unit-tested across a daylight-saving boundary.
- [ ] A campaign from another workspace returns 404, not 403, and is covered by a test.
- [ ] Query duration is written to `telemetry` and visible on Monitoring.

## 6. End-to-end test ticket

**Title:** E2E — Campaign stats for a chosen date range

**Preconditions:** A workspace with one campaign, a sandbox mailbox, 20 leads, and seeded sends and replies spread over six weeks so at least one week is empty.

**Flow**
1. Sign in and open the campaign from Campaigns.
2. Note the all-time sent and replied figures.
3. Set the range to the two weeks containing the seeded replies and apply.
4. Set the range to the empty week.
5. Reload the page.

**Assertions**
- [ ] After step 3 the sent and replied figures drop to the seeded fortnight's values and the header names the range.
- [ ] After step 4 the panel reads "Nothing sent in this range" and offers "Show all time".
- [ ] After step 5 the range from step 4 is still selected, restored from the URL.
- [ ] The timezone label matches the browser's timezone.

**Teardown:** Delete the seeded campaign, leads and messages; clear the telemetry rows written by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | A date-range control and range-aware counts above Node performance | Medium | One control, three presets, custom hidden behind "Custom"; default stays All time so the page looks unchanged until asked |
| Reports | The same control replaces the fixed 30-day series | Low | Reuse the identical component; the default view is unchanged |
| Monitoring | A reporting-query duration line in the existing telemetry section | Low | One more row in a list that already exists |

**Verdict:** Fits an existing surface

The campaign detail page already shows per-node performance, so the range control belongs there rather than on a new screen. Defaulting to All time means nobody has to make a decision to see what they see today. No new navigation item.
