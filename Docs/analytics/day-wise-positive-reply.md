# Day-wise Positive Reply Stats

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/day-wise-positive-reply-stats` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/day-wise-positive-reply |
| **Auth** | API key (query param `api_key`) |

Gives you one number per day: how many leads replied positively that day, counted once each.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer, **I want** a daily line of positive replies over a date range, **so that** I can see whether interest is building or fading rather than staring at one all-time total.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the stats, then `data.day_wise_stats` returns `{ date, positive_replied }` objects, `date` in `YYYY-MM-DD` form.
- [ ] Given a positive reply arrived on a given day, when it is bucketed, then it lands on the date the reply was received, not the date the email was sent, and the chart caption says so.
- [ ] Given a lead replied positively three times, when the day values are computed, then that lead is counted once, because `positive_replied` is a distinct-lead count.
- [ ] Given the daily values are summed for the window, when compared with the overview tile's `positive_replied` for the same window, then the two agree — this is the one day-wise series that is additive against the tile.
- [ ] Given a day inside the range with no positive replies, when the chart renders, then that day is drawn as zero rather than being skipped, so the line has no false gaps.
- [ ] Given a lead is re-categorised from positive to something else, when the same range is requested again, then historical days change, and the panel says categories are mutable.
- [ ] Given `campaign_ids` or `client_ids` are supplied, when the stats are requested, then only those campaigns contribute to each day.
- [ ] Given `timezone` is supplied, when day boundaries are computed, then they use that timezone; otherwise UTC, and the chart states which applied.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 5 positive replies on 2024-01-15 and 7 on 2024-01-16. Request that range | 200 with two entries, `positive_replied` 5 and 7 |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401 `{"message": "Invalid API Key"}`; the chart shows a reconnect banner, not a flat line at zero |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` for another workspace's campaign | 404 `{"error": "Resource not found"}` or an empty series; nothing leaks |
| TC-4 | Validation failure | Pass `start_date=15-01-2024` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous series drawn and marked stale |
| TC-6 | Empty result set | Request a range with no positive replies | 200, `day_wise_stats: []`; the chart shows "No positive replies between X and Y" rather than a zero line |
| TC-7 | Repeat replier | Seed one lead replying positively twice on the same day | The day shows 1, not 2 |
| TC-8 | Reply-date attribution | Seed an email sent on 2024-01-10 whose positive reply arrives on 2024-01-15 | The count lands on 2024-01-15; the by-sent-time endpoint puts it on 2024-01-10 |
| TC-9 | Sums to the tile | Sum every day in the range and compare with the overview tile for the same window | The two are equal |
| TC-10 | Missing days filled | Seed replies only on the first and last day of a 7-day range | The chart renders 7 points, five of them zero, with no gap in the line |
| TC-11 | Re-categorisation | Run TC-1, flip one lead to neutral, re-run | The affected day drops by one and the mutable-category note is visible |

## 4. Frontend user story

**As a** marketer, **I want** positive replies plotted on the Reports 30-day series alongside sends and replies, **so that** I can see whether more sending is actually producing more interest.

**Scope**
- Reports page: the existing 30-day sent/replies series gains a third line for positive replies, using the shared date range so all three lines cover the same window.
- Hovering a day shows all three numbers together plus a link to Inbox filtered to interested replies on that date.
- Loading shows the chart frame with a skeleton plot. Empty shows a message naming the range, not a flat zero line. Error keeps the last drawn series and marks it stale.
- Accessibility: the chart has a data-table fallback with one row per day, lines are distinguishable by marker shape as well as colour, and the chart scrolls inside its own container on narrow screens.

**Definition of done**
- [ ] Days with no data render as zero points, never as gaps.
- [ ] The caption states the axis ("positive replies by the day the reply arrived") and the timezone applied.
- [ ] Hover detail links to the matching Inbox filter.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** a route returning positive replies per day for a window, **so that** the Reports series is one query rather than a per-day loop.

**Scope**
- Add `GET /api/analytics/positive-replies/daily?from=&to=&timezone=&campaign_ids=` to `server/routes.js`, workspace-scoped.
- Data model: none. Group Harry's classified replies where the intent maps to positive (`interested`, plus any workspace edge label mapped to it) by reply date, counting distinct leads.
- Fill missing days server-side so the client never has to reconstruct the axis. Validate the date pair, reject an inverted range with a 422, and cap the window.
- The existing API limiter applies; results are cached briefly per workspace and range.
- Log a `telemetry` row per call with the window length and duration.

**Definition of done**
- [ ] Distinct-lead counting is unit tested against a lead that replies twice on one day and twice across two days.
- [ ] The summed series equals the range total returned by the overview route.
- [ ] Missing days come back as zeros with the correct dates.
- [ ] Cross-workspace campaigns contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — daily positive replies on Reports

**Preconditions:** A workspace with one campaign on a sandbox mailbox, seven days of sends, positive replies simulated on day 2 (one lead, twice) and day 6 (three leads), and one neutral reply on day 4.

**Flow**
1. Sign in and open Reports.
2. Set the range to cover the seven days.
3. Read the positive-reply line.
4. Hover day 2 and follow the link into Inbox.
5. Reclassify one day-6 reply from interested to a neutral intent and return to Reports.

**Assertions**
- [ ] Day 2 shows 1, not 2, despite the repeat reply.
- [ ] Day 4 shows 0 and the line has no gap there.
- [ ] Day 6 shows 3.
- [ ] The Inbox link lands on interested replies for day 2.
- [ ] After reclassification day 6 shows 2 and the sum matches the Dashboard tile.

**Teardown:** Delete the seeded campaign, leads, messages and classifications.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | The existing 30-day series gains one line | Low | One extra line on a chart that already exists, toggleable in the legend |
| Dashboard | None | Low | The tile total already exists; the daily shape belongs on Reports |
| Inbox | Becomes the click-through target from a hovered day | Low | Uses filters Inbox already has |

**Verdict:** Fits an existing surface

Harry already draws a 30-day sent/replies series on Reports and already classifies replies as interested. What this endpoint adds is the day-by-day shape of the interested subset on the reply-date axis, which is one more line on a chart that is already there. No new page, no new navigation.
