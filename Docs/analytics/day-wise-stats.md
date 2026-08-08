# Get Day-wise Overall Stats

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/day-wise-overall-stats` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/day-wise-stats |
| **Auth** | API key (query param `api_key`) |

Gives a day-by-day count of sends, opens and replies, with each one landing on the day it actually happened.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer, **I want** a daily activity series where each event sits on its own date, **so that** the chart matches what I saw happening — a busy reply day looks busy, even if those emails went out a week earlier.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the stats, then `data.day_wise_stats` returns `{ date, sent, opened, replied, bounced }` per day.
- [ ] Given `bounced` is always `0` on this endpoint, when the series is drawn, then Harry does not plot a bounce line here and instead points to the send-time view for bounce detail.
- [ ] Given `opened` is a raw event count, when a lead opens the same email twice on one day, then the day shows 2, and the tooltip says "opens, not openers".
- [ ] Given every count is additive, when the days are summed for the window, then the total matches the range figure shown elsewhere for the same raw metrics.
- [ ] Given a day with no activity inside the range, when the series renders, then it appears as zero rather than being skipped.
- [ ] Given `timezone` is supplied, when day boundaries are computed, then they use that timezone; without it UTC applies, and the caption states which.
- [ ] Given `campaign_ids` or `client_ids` are supplied, when the stats are requested, then only those campaigns contribute to each day.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 150 sent / 52 opened / 8 replied on 2024-01-15 and 175 / 61 / 11 on 2024-01-16. Request that range | 200, two rows matching those numbers with `bounced: 0` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with a junk key | 401 `{"message": "Invalid API Key"}`; the chart shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or an empty series; nothing leaks |
| TC-4 | Validation failure | Pass `start_date=2024-02-01&end_date=2024-01-01` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous series marked stale |
| TC-6 | Empty result set | Request a range before any activity | 200, `day_wise_stats: []`; empty state names the range |
| TC-7 | Event-date attribution | Send on day 1, reply on day 5, request days 1–5 | `sent` is on day 1 and `replied` on day 5 — the two are on different rows |
| TC-8 | Bounces are always zero | Seed 3 real bounces inside the range | `bounced` still returns `0`; the UI shows no bounce line and links to the send-time view |
| TC-9 | Repeat open | One lead opens the same email twice in a day | `opened` counts 2 for that day |
| TC-10 | Single-day range | Set start equal to end on an active day | That one full day is returned, not an empty list |
| TC-11 | Additivity check | Sum every day's `sent` and compare with the range total from the overview endpoint | The two match, since these are raw counts |

## 4. Frontend user story

**As a** marketer, **I want** the Reports 30-day series to default to the event-date view, **so that** the chart reads like a diary of what happened, which is what people expect the first time they look.

**Scope**
- Reports page: the existing 30-day sent/replies series is fed by this endpoint on its default axis, with the same date range control the rest of the page uses; opens join sends and replies as a third line.
- The bounce line is deliberately absent here, replaced by a one-line note that bounces are shown on the send-date axis.
- Loading shows a skeleton plot. Empty shows a message naming the range. Error keeps the last drawn series and marks it stale.
- Accessibility: a data-table fallback with one row per day, lines separable by marker shape, and the chart in its own horizontal scroll container on narrow screens.

**Definition of done**
- [ ] The caption states the axis ("each event on the day it happened") and the timezone.
- [ ] The opens tooltip says opens rather than openers.
- [ ] No bounce line is drawn on this axis, and the note explaining why is one sentence.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** a daily series where each metric sits on its own event timestamp, **so that** the Dashboard chart and the Reports series read from one aggregate.

**Scope**
- Extend `GET /api/analytics/daily?axis=event&from=&to=&timezone=&campaign_ids=` in `server/routes.js`, the same route that serves the send-time axis, workspace-scoped.
- Data model: none. Count sends by message sent time, opens by tracking-event time, replies by reply time, all from the existing `messages` and tracking tables.
- Unlike SmartLead, Harry can return real bounce counts on this axis; the route returns them under a separate field and the UI still keeps them on the send-date view so the two products' numbers are comparable.
- Fill missing days with zeros. Validate the date pair and reject an inverted range with a 422. Cap the window length. The existing API limiter applies with brief caching.
- Log a `telemetry` row per call with axis, day count and duration.

**Definition of done**
- [ ] Both axes share one aggregation module and one test fixture.
- [ ] Every field on this axis is a raw additive count, asserted by a test that sums days and compares with the range total.
- [ ] Missing days come back as zeros with correct dates.
- [ ] Cross-workspace campaigns contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — daily activity diary on Reports

**Preconditions:** A workspace with one campaign on a sandbox mailbox, sends across five days, opens simulated the day after each send, two replies on the last day, and one quiet day in the middle with no activity.

**Flow**
1. Sign in and open Reports.
2. Set the range to the five days.
3. Read the three lines.
4. Hover the quiet day.
5. Sum the sends shown per day and compare with the Dashboard's total for the same window.

**Assertions**
- [ ] Opens sit one day after their sends.
- [ ] Replies sit on the last day only.
- [ ] The quiet day shows zeros with an unbroken line.
- [ ] The summed sends equal the Dashboard total.
- [ ] No bounce line is drawn, and the note points to the send-date axis.

**Teardown:** Delete the seeded campaign, leads, messages and tracking events.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | The existing 30-day series is fed by this endpoint and gains an opens line | Low | One extra line on a chart that exists, toggleable in the legend |
| Dashboard | The 14-day sent/replies chart reads the same aggregate | Low | Same data source, unchanged appearance |
| Monitoring | New telemetry rows only | Low | Folds into the existing tick-duration list |

**Verdict:** Fits an existing surface

Harry already draws both a 14-day Dashboard chart and a 30-day Reports series over sends and replies, so almost nothing here is new — the value is having one server-side aggregate feed both, plus an opens line and a stated axis. The honest change is a shared data source and a caption, not a new panel.
