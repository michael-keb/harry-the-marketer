# Get Overall Analytics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/overall-stats-v2` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/overview |
| **Auth** | API key (query param `api_key`) |

Gives the whole account's headline numbers for a date range in one call — sent, opened, replied, bounced, positive replies, and the rates that go with them.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer, **I want** one call that returns the whole workspace's headline numbers for a date range, **so that** the Dashboard tiles and the top of Reports always agree with each other.

**Acceptance criteria**
- [ ] Given `start_date` and `end_date`, when I request the stats, then `data.overall_stats` returns `sent`, `opened`, `replied`, `bounced`, `unique_lead_count`, `unique_open_count`, `positive_replied`, `open_rate`, `reply_rate`, `positive_reply_rate` and `bounce_rate`.
- [ ] Given several counts arrive as strings (`"345805"`) while `positive_replied` arrives as a number, when they are parsed, then every count is coerced to a number once at the boundary and never compared as text.
- [ ] Given rates arrive as percentage strings (`"0.58%"`), when they are rendered, then the `%` is stripped once and the value is never divided by 100 again.
- [ ] Given `bounce_rate` is `bounced / unique_lead_count`, when it is displayed, then the label says "per lead contacted", and the deliverability figure `bounced / sent` is offered separately since both raw counts are present.
- [ ] Given open tracking is off and `unique_open_count` is `0`, when `reply_rate` falls back to `replied / unique_lead_count`, then the tile carries a footnote rather than showing a suspiciously high rate with no explanation.
- [ ] Given `positive_replied` is attributed to the date the reply arrived while the counts are scoped by send date, when both are shown on one tile row, then the different axis is stated in one sentence.
- [ ] Given the range has no activity, when the stats are requested, then all counts are zero, rates are `—` rather than `0%`, and the empty state names the range.
- [ ] Given `unique_lead_count` and `unique_open_count` are not additive, when a user compares two adjacent ranges, then the UI never adds them, and the caption warns that day totals cannot be summed.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a workspace with 345805 sent, 1732 replied, 2015 bounced, 280 positive in January. Request that range | 200 with `overall_stats` carrying those figures and rate strings such as `"0.58%"` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; tiles show a reconnect banner instead of zeros |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or zeroed stats; nothing leaks |
| TC-4 | Validation failure | Pass `start_date=2024-01-31&end_date=2024-01-01` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the last good tiles marked stale |
| TC-6 | Empty result set | Request a range before any sending | 200 with zeros; rates render `—` and the empty state names the range |
| TC-7 | String counts | Inspect `sent: "345805"` | Parsed to a number once; a test asserts no string comparison reaches the UI |
| TC-8 | Open tracking off | Seed `opened: "0"` and `unique_open_count: "0"` with 1732 replies | `open_rate` shows `0.00%` with the "no opens recorded" footnote and `reply_rate` uses the documented fallback |
| TC-9 | Bounce rate meaning | Compare `bounce_rate` with `bounced / sent` for the same fixture | The two differ; both are shown with distinct labels |
| TC-10 | Non-additive uniques | Sum seven single-day calls and compare with the week called directly | Raw counts match, `unique_lead_count` from the sum is higher; the UI only ever issues the range call |
| TC-11 | Timezone | Request the same range with `timezone=America/New_York` and without | Boundary sends move; the tile caption names the applied timezone |
| TC-12 | Response envelope | Inspect the top-level body | It carries `success` and `message`, not the `ok` used elsewhere; the client handles both shapes |

## 4. Frontend user story

**As a** marketer, **I want** the Dashboard KPI tiles and the top of Reports fed by one range-aware call, **so that** two pages never show different versions of the same week.

**Scope**
- Dashboard: the existing KPI tiles read this aggregate, gaining bounced and positive replies alongside sent and replied, and carrying the range in a caption.
- Reports page: the same numbers appear as the header row above the funnel, sharing the page's date-range control.
- Loading shows skeleton tiles, not a page spinner. Empty shows zeros with `—` rates and a message naming the range. Error keeps the last values visible and marks them stale.
- Accessibility: tiles are definition-list entries so label and value are read together, footnotes are text, and tiles stack two-up under 640px.

**Definition of done**
- [ ] One request fills both the Dashboard tiles and the Reports header.
- [ ] Rates render to two decimal places with `%` and never show `NaN`.
- [ ] The tracking-off footnote appears exactly when `unique_open_count` is zero and replies are not.
- [ ] The caption states the range, timezone and that daily totals cannot be summed.

## 5. Backend user story

**As a** Harry server, **I want** one workspace-level aggregate for an explicit window, **so that** every headline number in the product comes from a single query.

**Scope**
- Add `GET /api/analytics/overview?from=&to=&timezone=&campaign_ids=` to `server/routes.js`, workspace-scoped, returning numbers (not strings) for every count and `null`-able numeric rates.
- Data model: none. Derive from `messages` and tracking events; compute `unique_lead_count` and `unique_open_count` as `COUNT(DISTINCT lead)` over the whole range, never by summing days.
- Scope raw counts by send time and `positive_replied` by reply time, and label the axis of each field in the response metadata so the client cannot mix them up.
- Validate the date pair, reject an inverted range with a 422, cap the window; the existing API limiter applies with brief caching per workspace and range.
- Log a `telemetry` row per call with the window length and duration; this route is the one most likely to get slow, so it is worth watching on Monitoring.

**Definition of done**
- [ ] Every rate follows the documented formula, including the reply-rate fallback, and returns `null` on a zero denominator.
- [ ] Unique counts are proven non-additive by a test that sums days and asserts the difference.
- [ ] Both `bounce_rate` (per lead) and a deliverability bounce share (per email) are returned.
- [ ] Cross-workspace data never appears.

## 6. End-to-end test ticket

**Title:** E2E — workspace headline numbers across Dashboard and Reports

**Preconditions:** A workspace with two campaigns on sandbox mailboxes, a week of sends, several replies including two classified interested, one bounce, and one lead emailed on two different days.

**Flow**
1. Sign in and read the Dashboard KPI tiles.
2. Open Reports and compare the header row for the same range.
3. Narrow the range to a single day inside the week on both pages.
4. Turn off open tracking in Settings and reload.
5. Request a range before any activity.

**Assertions**
- [ ] Dashboard and Reports show identical numbers for the same range.
- [ ] The lead emailed twice is counted once in the week's unique lead count and once in each single-day view.
- [ ] With tracking off, the open rate reads 0.00% with the footnote and the reply rate uses the fallback.
- [ ] The pre-activity range shows zeros with `—` rates and the empty message.
- [ ] Monitoring records one telemetry entry per range change.

**Teardown:** Delete the seeded campaigns, leads, messages and tracking events; clear the telemetry rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Dashboard | Existing KPI tiles gain a range and two more numbers | Low | Same tile row; bounced and positive replies replace nothing, they complete the picture |
| Reports | The header row above the funnel reads the same aggregate | Low | Removes duplicated computation rather than adding a panel |
| Monitoring | New telemetry rows only | Low | Folds into the existing tick-duration list |

**Verdict:** Fits an existing surface

Harry already shows KPI tiles on the Dashboard and rates on Reports, so most of these numbers exist somewhere in the product already. The real gain is that one server-side aggregate feeds both surfaces with a stated date range, stated axes and honest empty states, which is what stops two pages disagreeing about the same week.
