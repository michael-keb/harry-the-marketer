# Campaign Performance

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/campaign/overall-stats` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/campaign-performance |
| **Auth** | API key (query param `api_key`) |

Returns one row per campaign for a date range you choose — emails sent, opened, replied and bounced, plus the open, reply, bounce and positive-reply rates for each.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer, **I want** every campaign's sent, opened, replied, bounced and rate figures for a date range side by side, **so that** I can rank campaigns on the same window instead of comparing all-time numbers from campaigns that started months apart.

**Acceptance criteria**
- [ ] Given `start_date` and `end_date` in `YYYY-MM-DD` form, when I request the stats, then `data.campaign_wise_performance` returns one object per campaign with `id`, `campaign_name`, `sent`, `opened`, `replied`, `bounced`, `positive_replied`, `unique_lead_count`, `unique_open_count`, `open_rate`, `reply_rate`, `bounce_rate` and `positive_reply_rate`.
- [ ] Given the range is scoped by send time, when a reply arrives after `end_date` to an email sent inside it, then that reply is still counted against the campaign, and the UI caption says the window is "emails sent between X and Y".
- [ ] Given `start_date` equals `end_date`, when I request the stats, then I get that one full day (00:00:00–23:59:59), not an empty result.
- [ ] Given a `timezone` such as `America/New_York` is supplied, when day boundaries are computed, then they use that timezone; with no `timezone` they use UTC, and the UI states which applied.
- [ ] Given `unique_lead_count` is zero for a campaign, when the rates are rendered, then they show as "—" rather than `0%` or `NaN`, because `open_rate` divides by `unique_lead_count`.
- [ ] Given `positive_replied` here is attributed differently from the overview tile, when both numbers appear in Harry, then the campaign table links to the definition and never claims the two must agree.
- [ ] Given `campaign_ids` or `client_ids` are supplied as comma-separated strings, when I request the stats, then only those campaigns are returned.
- [ ] Given more campaigns exist than `limit`, when I page with `offset`, then rows are stable across pages and no campaign is returned twice.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign with 500 sent, 250 opened, 45 replied, 8 bounced in January. Call with `start_date=2024-01-01&end_date=2024-01-31` | 200, one row with `sent: 500`, `opened: 250`, `replied: 45`, `bounced: 8`, and rate strings such as `"50%"` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with `api_key` removed | 401 `{"message": "Invalid API Key"}`; the campaign table shows a reconnect banner, not zeros |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` for a campaign in another workspace | 404 `{"error": "Resource not found"}` or an empty list; no name or count leaks |
| TC-4 | Validation failure | Pass `start_date=2024-13-45` | 422 `{"error": "Invalid parameters provided"}`; the message names `start_date` |
| TC-5 | Rate limited | Fire the request 30 times in a second | 429; the client backs off and retries once, keeping the last good table on screen and marked stale |
| TC-6 | Empty result set | Request a range before the first send | 200 with `campaign_wise_performance: []`; the table shows "No campaigns sent anything in this range" |
| TC-7 | Single-day range | Set `start_date` and `end_date` to the same day that has 20 sends | 200 with `sent: 20` — the day is inclusive at both ends |
| TC-8 | Rates are strings | Inspect `open_rate` in the happy-path body | Value is a string like `"50%"`; the client strips the `%` before charting and never divides by 100 twice |
| TC-9 | Open tracking off | Seed a campaign with `unique_open_count: 0` but 12 replies | `reply_rate` falls back to `replied / unique_lead_count`; the UI footnote says open tracking was not recorded |
| TC-10 | Summing days inflates | Call each of 7 days separately and sum, then call the 7-day range once | Raw `sent` matches; `unique_lead_count` from the sum is higher — the client always issues one range call, proven by a network assertion |
| TC-11 | Timezone shift | Call the same day with `timezone=America/New_York` and with none | Counts differ at the boundary; both responses render with the applied timezone shown in the caption |

## 4. Frontend user story

**As a** marketer, **I want** the Reports per-campaign table to cover a date range I choose, **so that** "which campaign is working" is answered for this month rather than for all time.

**Scope**
- Reports page: the existing per-campaign rates panel (reply / interested / win / unsubscribe) gains sent, opened, bounced and the unique counts, plus the shared date-range control already used elsewhere on the page.
- Sorting by any column; the default sort is reply rate descending. Rate cells show the raw numerator and denominator on hover ("45 replies from 230 opens").
- Loading shows skeleton rows in the table body only. Empty shows a one-line message naming the range. Error keeps the previous table visible and marks it stale.
- Accessibility: a real `<table>` with a caption naming the range and timezone, sortable headers exposed with `aria-sort`, and horizontal scroll inside its own container on narrow screens rather than the page scrolling sideways.

**Definition of done**
- [ ] One request fills the whole table; changing the range refetches once.
- [ ] Rates render to one decimal place with `%`, and `—` when the denominator is zero.
- [ ] A footnote explains that positive replies here are attributed to send date and may differ from the Dashboard tile.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** one route that returns per-campaign counts and rates for an explicit window, **so that** the browser never aggregates `messages` rows to build the Reports table.

**Scope**
- Add `GET /api/analytics/campaigns/performance?from=&to=&timezone=&campaign_ids=&limit=&offset=` to `server/routes.js`, workspace-scoped like every campaign route.
- Data model: none. Derive from `messages`, `campaign_leads` and tracking events. Compute unique counts with `COUNT(DISTINCT lead)` over the whole range — never by summing days.
- Validate both dates as `YYYY-MM-DD`, reject an inverted range with a 422 naming the field, and cap the range length. Default `limit` to 50 with `offset` paging.
- Rate limiting follows the existing API limiter; identical range requests are served from a short-lived in-process cache.
- Log a `telemetry` row per call with the window length, campaign count and duration so slow ranges show up on Monitoring.

**Definition of done**
- [ ] Response returns raw counts and rates separately so the client never recomputes a rate from rounded values.
- [ ] Rates return `null` when the denominator is zero, and the client renders `—`.
- [ ] Unit tests cover inclusive boundaries, the reply-rate fallback when opens are zero, and cross-workspace isolation.
- [ ] A 90-day, 50-campaign window returns inside the standard latency budget.

## 6. End-to-end test ticket

**Title:** E2E — compare campaigns over a chosen window

**Preconditions:** A workspace with three campaigns on a sandbox mailbox: one with sends and replies in week 1, one with sends and replies in week 2, one with no activity at all.

**Flow**
1. Sign in and open Reports.
2. Set the range to week 1.
3. Sort by reply rate.
4. Set the range to week 2.
5. Set the range to a month before any activity.

**Assertions**
- [ ] In week 1 only the first campaign has non-zero sends; the second shows zeros or is absent per the agreed rule.
- [ ] Sorting by reply rate puts the campaign with the higher rate first, and the hover detail matches the seeded replies.
- [ ] In week 2 the ordering flips.
- [ ] The pre-activity range shows the empty state with the range echoed.
- [ ] Monitoring records one telemetry entry per range change.

**Teardown:** Delete the seeded campaigns, leads and messages; clear the telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | The existing per-campaign rates panel gains columns and a date range | Medium | Keep the default four columns visible; sent, opened, bounced and unique counts sit behind a "More columns" toggle |
| Dashboard | None | Low | The KPI tiles stay workspace-level; the campaign detail is one click away on Reports |
| Monitoring | New telemetry rows only | Low | Folds into the existing tick-duration list, no new panel |

**Verdict:** Fits an existing surface

Harry already computes per-campaign reply, interested, win and unsubscribe rates on Reports. What is genuinely new here is the date range and the delivery-side numbers — opens, bounces and the unique lead and open counts that the rates divide by. Those belong in the table Harry already draws, so this is columns and a range control, not a new page.
