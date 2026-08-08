# Positive Reply Stats by Sent Time

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/day-wise-positive-reply-stats-by-sent-time` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/day-wise-positive-sent-time |
| **Auth** | API key (query param `api_key`) |

Credits each positive reply back to the day the email went out, so you can see which sending days actually earned interest.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer choosing when to send, **I want** positive replies credited to the day the email went out, **so that** I can tell which sending days earn interest instead of only knowing when the replies happened to land.

**Acceptance criteria**
- [ ] Given `start_date`, `end_date` and the required `timezone`, when I request the stats, then `data.day_wise_stats` returns `{ date, positive_replied }` bucketed by `sent_time`.
- [ ] Given `timezone` is required on this endpoint, when it is omitted, then the request is rejected with a 422 naming `timezone` and the UI supplies the browser timezone by default so a user never has to type one.
- [ ] Given an email sent on day 1 receives a positive reply on day 6, when the series is drawn, then the count appears on day 1 here and on day 6 in the reply-date series, and the two charts are labelled so the difference is obvious.
- [ ] Given a lead replied positively more than once, when the day value is computed, then it counts once, because `positive_replied` is a distinct-lead count.
- [ ] Given recent sends have not had time to earn replies, when the last few days of the range are drawn, then they are visually marked as "still maturing" so a dip is not read as a failure.
- [ ] Given no positive replies trace back to any send in the range, when the series renders, then a 200 with an empty list produces an empty state naming the range.
- [ ] Given `campaign_ids` or `client_ids` are supplied, when the stats are requested, then only those campaigns contribute.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed sends on 2024-01-15 and 2024-01-16 that later earn 5 and 7 positive replies. Request that range with `timezone=America/New_York` | 200 with two entries, `positive_replied` 5 and 7 keyed to the send dates |
| TC-2 | Missing/invalid API key | Repeat TC-1 with a junk key | 401 `{"message": "Invalid API Key"}`; the chart shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or an empty series; nothing leaks |
| TC-4 | Validation failure | Omit `timezone` | 422 `{"error": "Invalid parameters provided"}` naming `timezone`; the UI never sends this request without one |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous chart marked stale |
| TC-6 | Empty result set | Request a range whose sends earned no positive replies | 200, `day_wise_stats: []`, empty state names the range |
| TC-7 | Cross-axis comparison | Seed one send on day 1 with a positive reply on day 6, request both this endpoint and the reply-date one | This one credits day 1, the other credits day 6; both charts state their axis |
| TC-8 | Repeat replier | One lead replies positively twice to the same send | The send day shows 1 |
| TC-9 | Maturing tail | Request a range ending today with sends made this morning | Today's point is present but flagged as maturing; the tooltip explains why it may still rise |
| TC-10 | Timezone boundary | Request the same range with `timezone=Australia/Sydney` and `America/New_York` | A send near midnight moves between days; the caption names the applied timezone |
| TC-11 | Invalid timezone | Pass `timezone=Mars/Olympus` | 422 naming `timezone`; the UI falls back to the browser timezone and retries once |

## 4. Frontend user story

**As a** marketer, **I want** a "which sending days earn interest" view on Reports, **so that** the sending rhythm can favour the days that actually work.

**Scope**
- Reports page: an axis toggle on the existing 30-day series — "by reply date" (default) or "by send date" — rather than a second chart. Switching the toggle refetches the positive-reply line from this endpoint.
- The chart pairs positive replies by send date with sends per day so the reader sees the ratio, not just the count.
- The last few days are shaded as maturing. Loading shows a skeleton plot, empty shows a message naming the range, error keeps the previous series and marks it stale.
- Accessibility: the toggle is a labelled radio group, the shaded maturing region is described in the chart's text alternative, and the data-table fallback carries both series.

**Definition of done**
- [ ] The axis toggle changes only the positive-reply line, not the whole page range.
- [ ] The browser timezone is sent automatically and shown in the caption.
- [ ] The maturing tail is visible in both the chart and the table fallback.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** positive replies grouped by the send date of the email that earned them, **so that** Reports can answer "when should I send" without the browser joining replies back to sends.

**Scope**
- Add `GET /api/analytics/positive-replies/daily?axis=sent&from=&to=&timezone=&campaign_ids=` to `server/routes.js` — the same route as the reply-date series with an `axis` parameter, so the two views cannot drift apart.
- Data model: none. Join each positive reply back to the message it answers and group on that message's sent timestamp, counting distinct leads.
- `timezone` is required for this axis; reject a missing or unknown IANA zone with a 422 naming the field. Fill missing days with zeros. Cap the window length.
- The existing API limiter applies; results are cached briefly per workspace, range and axis.
- Log a `telemetry` row per call including the axis, so Monitoring shows which view is actually used.

**Definition of done**
- [ ] Both axes are served by one route and one aggregation module.
- [ ] A reply with no traceable originating send is excluded and counted in a telemetry field rather than silently dropped.
- [ ] Distinct-lead counting is unit tested.
- [ ] Cross-workspace campaigns contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — positive replies by sending day

**Preconditions:** A workspace with one campaign on a sandbox mailbox. Sends on Monday and Thursday; simulated positive replies arriving the following Tuesday and Friday respectively.

**Flow**
1. Sign in and open Reports.
2. Set the range to cover both weeks.
3. Read the positive-reply line with the default reply-date axis.
4. Switch the axis toggle to send date.
5. Narrow the range to the sending week only.

**Assertions**
- [ ] On the reply-date axis the peaks sit on Tuesday and Friday.
- [ ] On the send-date axis they move to Monday and Thursday.
- [ ] The caption changes with the toggle and names the timezone.
- [ ] Narrowing to the sending week keeps both peaks on the send-date axis and shows none on the reply-date axis.

**Teardown:** Delete the seeded campaign, leads, messages and classifications.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | The existing 30-day series gains an axis toggle | Low | A two-option toggle on a chart that exists; the default is unchanged |
| Settings → Sending | Could inform the working-days setting | Low | No automatic change to the sending rhythm; the insight is read-only |
| Monitoring | New telemetry rows only | Low | Folds into the existing tick-duration list |

**Verdict:** Fits an existing surface

This is the same metric Harry would already plot from the reply-date endpoint, re-anchored to the send date. Making it a toggle rather than a second chart keeps Reports at one series and keeps the comparison honest, since drawing both at once invites the reader to add numbers that must not be added.
