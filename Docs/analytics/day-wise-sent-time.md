# Day-wise Stats by Sent Time

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/day-wise-overall-stats-by-sent-time` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/day-wise-sent-time |
| **Auth** | API key (query param `api_key`) |

Puts every number on the day the email went out — so a day's row tells you what that day's sending eventually earned, whenever the opens and replies arrived.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer tuning the sending rhythm, **I want** each day's sends judged by what they eventually earned, **so that** I can compare Tuesday's batch with Thursday's without a reply that arrived late being credited to the wrong day.

**Acceptance criteria**
- [ ] Given `start_date`, `end_date` and the required `timezone`, when I request the stats, then `data.day_wise_stats` returns `{ date, sent, opened, replied, bounced, unsubscribed, unique_lead_reached }` per day.
- [ ] Given every metric is anchored to `sent_time`, when an email sent on day 1 is opened on day 4, then the open is counted on day 1, and the chart caption says "everything credited to the day the email went out".
- [ ] Given `unique_lead_reached` is a distinct count per day, when the daily values are summed, then the UI never presents that sum as a range total; only `sent`, `opened`, `replied`, `bounced` and `unsubscribed` are summed.
- [ ] Given `timezone` is required, when it is omitted, then the request is rejected with a 422 naming `timezone`, and Harry sends the browser timezone automatically so a user never has to choose one.
- [ ] Given a day inside the range had no sends, when the series renders, then that day appears with zeros rather than being dropped, so weekends read as deliberate gaps in sending.
- [ ] Given `campaign_ids` or `client_ids` are supplied, when the stats are requested, then only those campaigns contribute to each day.
- [ ] Given the last days of the range are recent, when they are drawn, then they are flagged as still maturing, because their opens and replies have not arrived yet.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 150 sends on 2024-01-15 and 175 on 2024-01-16 with later opens. Request that range with `timezone=America/New_York` | 200, two rows with `sent` 150 and 175 and non-zero `opened` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; the chart shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` for another workspace | 404 `{"error": "Resource not found"}` or an empty series; nothing leaks |
| TC-4 | Validation failure | Omit `timezone` | 422 `{"error": "Invalid parameters provided"}` naming `timezone` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous series marked stale |
| TC-6 | Empty result set | Request a range with no sends | 200, `day_wise_stats: []`; empty state reads "Nothing was sent between X and Y" |
| TC-7 | Late open credited to send day | Send on day 1, open on day 4, request days 1–4 | Day 1 carries the open; the event-date endpoint puts it on day 4 |
| TC-8 | Unique lead reached | Seed one lead reached on two different days | Each day shows `unique_lead_reached: 1`, and the UI does not sum them into 2 for the range |
| TC-9 | Bounces present | Seed 2 bounces on one day | `bounced: 2` on that day — unlike the event-date endpoint, this one reports bounces |
| TC-10 | Weekend gap | Seed sends Monday to Friday only, request a full week | Saturday and Sunday appear with zeros and the line has no break |
| TC-11 | Timezone boundary | Request the same range with `Australia/Sydney` and `America/New_York` | A send at 11pm moves between days; the caption names the applied timezone |

## 4. Frontend user story

**As a** marketer, **I want** the Reports 30-day series to be readable as "what each sending day earned", **so that** the chart supports a decision about when to send rather than just describing the past.

**Scope**
- Reports page: the existing 30-day sent/replies series gains the send-date axis (shared with the positive-reply toggle) and adds bounces and unsubscribes as thin secondary lines that are off by default.
- A weekday summary strip under the chart averages each day of the week across the range ("Tuesdays: 140 sent, 6.2% replied"), which is the actionable read.
- Loading shows a skeleton plot. Empty shows a message naming the range. Error keeps the previous series and marks it stale. Recent days are shaded as maturing.
- Accessibility: a data-table fallback with one row per day and every field, lines distinguishable by marker as well as colour, and the chart in its own horizontal scroll container on narrow screens.

**Definition of done**
- [ ] The axis and its meaning are stated in the chart caption, not only in a tooltip.
- [ ] `unique_lead_reached` is shown per day and never summed in the UI.
- [ ] The weekday strip is computed from the same response, not a second request.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** a daily series anchored to send time, **so that** Reports can show what a day's sending earned without the browser joining messages to their replies.

**Scope**
- Extend `GET /api/analytics/daily?axis=sent&from=&to=&timezone=&campaign_ids=` in `server/routes.js` — one route with an `axis` parameter serving both this and the event-date view, so the two can never drift.
- Data model: none. Group `messages` by the sending message's date and roll opens, replies, bounces and unsubscribes onto it; compute `unique_lead_reached` as `COUNT(DISTINCT lead)` per day.
- `timezone` is required on this axis; reject a missing or unknown IANA zone with a 422. Fill missing days with zeros. Cap the window length.
- The existing API limiter applies; results are cached briefly per workspace, range, axis and campaign filter.
- Log a `telemetry` row per call with the axis, day count and duration.

**Definition of done**
- [ ] Both axes come from one aggregation module with a shared test fixture.
- [ ] The response marks `unique_lead_reached` as non-additive in its own metadata so no client sums it by accident.
- [ ] Bounces and unsubscribes are populated on this axis.
- [ ] Cross-workspace campaigns contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — daily performance credited to the sending day

**Preconditions:** A workspace with one campaign on a sandbox mailbox. Sends on Monday and Wednesday; simulated opens and replies arriving two days after each send; one bounce on Monday.

**Flow**
1. Sign in and open Reports.
2. Set the range to that week and confirm the timezone in the caption.
3. Read the series on the default event-date axis.
4. Switch the axis to send date.
5. Enable the bounce line.
6. Read the weekday summary strip.

**Assertions**
- [ ] On the event-date axis, opens and replies sit on Wednesday and Friday.
- [ ] On the send-date axis they move to Monday and Wednesday.
- [ ] Monday's bounce appears only on the send-date axis.
- [ ] The weekday strip names Monday and Wednesday with rates matching the chart.
- [ ] Days with no sends show zeros and the line is unbroken.

**Teardown:** Delete the seeded campaign, leads, messages and tracking events.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | The existing 30-day series gains an axis and two optional lines | Medium | Bounces and unsubscribes are off by default; the axis toggle is shared with the positive-reply line |
| Reports | Adds a weekday summary strip | Low | One line of text per weekday under the chart, no second chart |
| Monitoring | New telemetry rows only | Low | Folds into the existing tick-duration list |

**Verdict:** Fits an existing surface

Harry already plots a 30-day sent/replies series on Reports; this changes what a point means rather than adding a chart. The genuinely new numbers are bounces, unsubscribes and unique leads reached per day, and the weekday summary is where the send-date axis actually pays off.
