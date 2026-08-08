# Fetch Campaign Top Level Analytics by Date Range

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/top-level-analytics-by-date` |
| **Category** | campaign-statistics |
| **Source** | https://api.smartlead.ai/api-reference/campaign-statistics/top-level-by-date |
| **Auth** | API key (query param `api_key`) |

Returns the same headline numbers for one campaign, but only for the days between a start and end date you supply.

## 1. Epic

**Per-campaign performance breakdown**

The epic gives a Harry user the numbers behind a single campaign — sent, opened, clicked, replied, unsubscribed, bounced — sliced by playbook step, by lead, by mailbox and by date, without leaving the campaign they are already looking at. It matters because Reports answers "how is outreach going" for the whole workspace, while the decisions that change next week (rewrite this step, rest that mailbox, stop chasing this segment) are made inside one campaign, where Harry today shows only node counts.

## 2. User story

**As a** marketer reporting on a campaign, **I want** its headline numbers for one month at a time, **so that** I can say what the campaign did in March without subtracting February by hand.

**Acceptance criteria**
- [ ] Given `start_date` and `end_date` are both supplied in `YYYY-MM-DD`, when the numbers are fetched, then only that window is counted and the panel header names the window in the user's own date format.
- [ ] Given either date is missing, when the request is attempted, then it is blocked client-side with "Pick both a start and an end date" — this endpoint requires both, unlike the mailbox breakdown which falls back to all time.
- [ ] Given the range covers days before the campaign launched, when the numbers are fetched, then those days count as zero rather than causing an error.
- [ ] Given a range with no activity, when the response returns an empty `data`, then the panel reads "Nothing happened in this range" with a one-click "Show all time".
- [ ] Given the user picks a preset such as "This month" or "Last month", when it is applied, then the dates are computed in the browser's timezone and shown so the user can see exactly what was asked for.
- [ ] Given the API key is missing or invalid, when the numbers are fetched, then a 401 `{"message": "Invalid API Key"}` shows one "Reporting is disconnected" chip and the all-time tiles above stay visible.
- [ ] Given the same range is requested twice in a session, when it is applied again, then the cached result is reused and no second request is made.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign with activity through January. Call with `start_date=2024-01-01&end_date=2024-01-31` | 200, `ok: true`, headline counts equal the January fixture totals |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; one chip on the panel, all-time tiles unaffected |
| TC-3 | Not found / wrong workspace | Call with a campaign id from another workspace | 404; "Campaign not found", no counts leak |
| TC-4 | Validation failure | Call without `end_date` | 400 naming `end_date` as required; the Apply button stays disabled until both dates are set |
| TC-5 | Rate limited | Change the range 30 times in one second | 429 avoided by debouncing to one request per 400ms; if it still occurs, one backoff retry and the previous figures remain |
| TC-6 | Empty result set | Call for a week before the campaign launched | 200 with an empty `data`; "Nothing happened in this range" and "Show all time" |
| TC-7 | Reversed range | Call with `start_date` after `end_date` | Blocked client-side with "End date must be on or after the start date"; if it reaches the server, 400, and the previous figures stay |
| TC-8 | Single-day range | Call with the same date for start and end | 200 covering exactly that day; the header reads the single date, not a range |
| TC-9 | Cross-check | Compare a range covering the campaign's whole life against the unfiltered analytics endpoint | The two agree exactly |
| TC-10 | Cache reuse | Apply "Last 30 days", switch to "All time", switch back | The second application of "Last 30 days" issues no network request and renders instantly |

## 4. Frontend user story

**As a** marketer, **I want** the campaign's headline numbers to follow the date range I picked, **so that** a monthly report is one screenshot rather than a spreadsheet exercise.

**Scope**
- Campaign detail page: a "This range" row beneath the all-time header tiles, driven by the same range control used by the per-day chart, so there is exactly one date control on the page.
- The all-time tiles stay put and stay all-time; the ranged figures are visually secondary and labelled with the range, so the two can never be confused.
- Loading dims the ranged row only; empty reads "Nothing happened in this range"; error keeps the all-time tiles and marks only the ranged row.
- A "Copy summary" action puts a plain-text one-liner ("1 Mar – 31 Mar: 412 sent, 38 replies, 9 interested, 2 won") on the clipboard for pasting into a status update.
- Accessibility: the ranged row is a labelled group whose caption includes the dates, so a screen reader hears the window before the numbers. On narrow screens it stacks under the tiles.

**Definition of done**
- [ ] One date control governs both this row and the per-day chart.
- [ ] The all-time and ranged figures are never presented in the same visual weight.
- [ ] The copied summary matches what is on screen exactly.
- [ ] Empty, error and single-day states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** a ranged headline route that shares its aggregation with the unranged one, **so that** "all time" and "the whole campaign's range" can never disagree.

**Scope**
- Route: `GET /api/campaigns/:id/top-level-analytics-by-date?start_date&end_date`, beside the other campaign routes in `server/routes.js`, with both dates required and validated as `YYYY-MM-DD`.
- Data model: none new. The same aggregation function as `/analytics` with an added date predicate, so the two are one code path with one test suite.
- Range is capped at 400 days; a reversed range returns 400; results are cached per campaign and range key and invalidated on the campaign's next message or outcome. Reporting rate limit with `Retry-After` on 429.
- Telemetry: range length, cache hit or miss and query duration to `telemetry`.

**Definition of done**
- [ ] A range covering the campaign's whole life returns figures identical to `/analytics`, asserted by a test.
- [ ] Both dates required; missing either returns 400 naming the field.
- [ ] Cache invalidation on new activity is tested.
- [ ] Duration and cache behaviour are visible on Monitoring.

## 6. End-to-end test ticket

**Title:** E2E — Ranged headline numbers for a campaign

**Preconditions:** A campaign with seeded activity across three calendar months, including one month with no activity at all, and a sandbox mailbox.

**Flow**
1. Sign in and open the campaign.
2. Note the all-time tiles.
3. Apply the "Last month" preset.
4. Apply the empty month.
5. Use "Copy summary" and paste it into the campaign's notes field.
6. Set the range to cover the campaign's whole life.

**Assertions**
- [ ] The all-time tiles do not change when a range is applied.
- [ ] The ranged row matches the seeded totals for the chosen month.
- [ ] The empty month shows "Nothing happened in this range" with a working "Show all time".
- [ ] The pasted summary matches the figures on screen, dates included.
- [ ] The whole-life range equals the all-time tiles exactly.

**Teardown:** Delete the campaign, leads and messages; clear the run's telemetry and the notes edit.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | A secondary "This range" row under the existing header tiles | Low | Same numbers, lighter weight, driven by the one date control already added for the per-day chart |
| Campaign detail | A "Copy summary" action | Low | One text button inside the row, no menu, no export dialog |

**Verdict:** Fits an existing surface

This shares its control and its aggregation with the ranged per-day statistics, so it costs one row rather than one screen. Keeping the all-time tiles unchanged above it means the page answers "how is it going overall" and "what did it do in March" without the user having to remember which mode they are in.
