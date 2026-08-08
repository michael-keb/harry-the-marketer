# Client Overall Stats

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/client/overall-stats` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/client-performance |
| **Auth** | API key (query param `api_key`) |

Rolls every campaign belonging to a client into one row of results for a date range — sends, opens, replies, positive replies and the rates that go with them.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** consultant reporting to several businesses, **I want** one row of performance per client for a date range, **so that** I can paste a single honest summary into each monthly update instead of adding campaign numbers up by hand.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request client stats, then `data.client_wise_performance` returns one object per client with `client_id`, `client_name`, `total_campaigns_count` and a `campaign_stats` object.
- [ ] Given the `campaign_stats` object, when it is rendered, then it carries `sent`, `opened`, `replied`, `positive_replied`, `unique_lead_count`, `unique_open_count`, `client_health`, `open_rate`, `reply_rate` and `positive_reply_rate`.
- [ ] Given `total_campaigns_count` counts distinct campaigns with sends in the range, when a client's campaign sent nothing in the window, then it is not counted, and the UI caption says "campaigns that sent in this range".
- [ ] Given `client_health` is `positive_replied / unique_lead_count`, when it is displayed, then it is labelled in plain English ("share of contacted leads who replied positively") and never presented as a health score with no definition.
- [ ] Given `unique_lead_count` is zero, when the rates are rendered, then they show `—` rather than `0%`, because every rate divides by a unique count.
- [ ] Given a client has campaigns but no sends in the range, when the stats are requested, then the client appears with zeroed raw counts and dashed rates, so an absent client is never mistaken for a missing one.
- [ ] Given `limit` and `offset` are supplied, when I page through many clients, then ordering is stable and no client appears twice.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed client "Acme Corp" with 10 campaigns, 1000 sent, 500 opened, 80 replied, 40 positive in January. Request that range | 200, one row with `total_campaigns_count: 10` and `campaign_stats.sent: 1000`, rates as strings like `"50%"` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with a junk `api_key` | 401 `{"message": "Invalid API Key"}`; the client table shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `client_ids` for a client in another workspace | 404 `{"error": "Resource not found"}` or an empty list; no client names leak |
| TC-4 | Validation failure | Pass `end_date=2024-01-01&start_date=2024-02-01` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the last good table marked stale |
| TC-6 | Empty result set | Request a range before any campaign existed | 200 with `client_wise_performance: []`; empty state names the range |
| TC-7 | Client with no sends in range | Seed a client whose campaigns all sent outside the range | The client is listed with zeroed counts and dashed rates, not omitted |
| TC-8 | Open tracking off | Seed a client with `unique_open_count: 0` and 12 replies | `reply_rate` falls back to `replied / unique_lead_count`; a footnote explains the fallback |
| TC-9 | Client health definition | Seed 40 positive replies and 900 unique leads | `client_health` reads about `"4.4%"`; the tooltip states the formula |
| TC-10 | Paging | Seed 30 clients, request `limit=10&offset=10` | Rows 11–20 by the documented sort; no overlap with the first page |
| TC-11 | Summing days inflates | Sum seven single-day calls, then call the week directly | Raw `sent` matches, `unique_lead_count` from the sum is higher; the client only ever issues one range call |

## 4. Frontend user story

**As a** consultant, **I want** a per-client summary table at the top of Reports, **so that** a monthly update is a copy-paste rather than an afternoon of arithmetic.

**Scope**
- Reports page: when the workspace has clients, a summary table above the existing per-campaign panel with one row per client — campaigns, sent, opened, replied, positive replied, and the four rates. Clicking a row filters the whole page to that client.
- A "Copy summary" action puts the selected client's row on the clipboard as plain text, so it can go straight into an email.
- Loading shows skeleton rows. Empty shows "No sends between X and Y". Error keeps the previous table and marks it stale.
- Accessibility: a real `<table>` with a caption naming the range and timezone, rate cells carrying their formula in the header `title`, and its own horizontal scroll container on narrow screens.

**Definition of done**
- [ ] The table is absent for workspaces with no clients rather than showing one "Unassigned" row.
- [ ] Every rate shows `—` when its denominator is zero.
- [ ] Clicking a row filters the page and updates the URL.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** one route that aggregates campaigns up to the client level over a window, **so that** the browser never sums campaign rows to build a client summary.

**Scope**
- Add `GET /api/analytics/clients/performance?from=&to=&timezone=&client_ids=&limit=&offset=` to `server/routes.js`, workspace-scoped.
- Data model: depends on the nullable `client_id` on `campaigns` introduced for the client list; no other schema change. Unique counts are computed as `COUNT(DISTINCT lead)` over the whole range, never by summing days.
- Validate the date pair, reject an inverted range with a 422, cap the window length, and default `limit` to 25 with `offset` paging and a stable sort by client name.
- The existing API limiter applies; identical range requests are cached briefly per workspace.
- Log a `telemetry` row per call with the client count, window length and duration.

**Definition of done**
- [ ] Raw counts and rates are returned separately so the client never recomputes a rate from rounded numbers.
- [ ] `client_health`, `open_rate`, `reply_rate` and `positive_reply_rate` follow the documented formulas and return `null` on a zero denominator.
- [ ] Unit tests cover the reply-rate fallback, inclusive boundaries and paging stability.
- [ ] Cross-workspace clients return no rows.

## 6. End-to-end test ticket

**Title:** E2E — per-client performance summary

**Preconditions:** Two clients. Client A has two campaigns with sends and replies inside the test range; client B has one campaign whose only sends fall outside it. Sandbox mailbox, seeded leads and messages.

**Flow**
1. Sign in and open Reports.
2. Set the range to cover client A's activity.
3. Read the client summary table.
4. Click client A's row.
5. Use "Copy summary" and paste into a text field.

**Assertions**
- [ ] Client A's `sent` and `replied` match the seeded messages exactly.
- [ ] Client B appears with zeros and dashed rates rather than being missing.
- [ ] Clicking client A filters the campaign panel below to its two campaigns and updates the URL.
- [ ] The copied text contains the client name, the range and the same numbers shown on screen.

**Teardown:** Delete the seeded clients, campaigns, leads and messages; clear the telemetry rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | Adds a client summary table above the existing campaign panel | Medium | Rendered only when clients exist; four rates plus four counts, no chart |
| Dashboard | None | Low | KPI tiles stay workspace-level |
| Monitoring | New telemetry rows only | Low | Folds into the existing tick-duration list |

**Verdict:** Fits an existing surface

Harry already computes reply, interested and win rates per campaign on Reports; the new part is the roll-up level and the open, bounce and unique-lead denominators behind the rates. Because it only appears for workspaces that have created clients, a solo marketer's Reports page is unchanged, and nobody gets a new navigation item.
