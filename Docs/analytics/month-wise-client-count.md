# Get Month-wise Client Count

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/client/month-wise-count` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/month-wise-client-count |
| **Auth** | API key (query param `api_key`) |

Returns how many clients were active in each month, so you can see whether the book of business is growing or shrinking.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** consultant running outreach for several businesses, **I want** a month-by-month count of active clients, **so that** I can see whether I am gaining or losing accounts without keeping a spreadsheet on the side.

**Acceptance criteria**
- [ ] Given clients exist, when I request the counts, then `data.monthly_stats` returns `{ month, count }` objects with `month` in `YYYY-MM` form.
- [ ] Given "active" needs a definition, when the counts are computed, then a client is active in a month if at least one of its campaigns sent an email that month, and the chart caption states that rule.
- [ ] Given a month in the middle of the series had no active clients, when the chart renders, then that month appears as zero rather than being skipped, so a gap in trading is visible.
- [ ] Given the endpoint takes no date range, when the series is fetched, then Harry bounds it to the last 24 months by default and says so, rather than drawing an ever-growing axis.
- [ ] Given the workspace has no clients, when the counts are requested, then a 200 with an empty list means the panel is not rendered at all, since it is meaningless for a solo marketer.
- [ ] Given `client_ids` is supplied, when the counts are requested, then only those clients contribute, so a single account's continuity can be checked.
- [ ] Given the API key is invalid, when the counts are requested, then a 401 `{"message": "Invalid API Key"}` is surfaced as one banner and the rest of Reports still renders.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 5 clients active in 2024-01 and 7 in 2024-02. Call with a valid key | 200 with two entries, `count` 5 and 7 |
| TC-2 | Missing/invalid API key | Call with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; the panel shows a reconnect message |
| TC-3 | Not found / wrong workspace | Pass `client_ids` from another workspace | 200 with an empty list or 404 `{"error": "Resource not found"}`; nothing leaks |
| TC-4 | Validation failure | Pass `client_ids=2024-01` | 422 `{"error": "Invalid parameters provided"}` naming `client_ids` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous series marked stale |
| TC-6 | Empty result set | Call on a workspace with no clients | 200, `monthly_stats: []`; the panel is not rendered |
| TC-7 | Gap month | Seed activity in January and March but not February | February appears with a count of zero and the line is unbroken |
| TC-8 | Definition of active | Seed a client whose campaigns existed but sent nothing in a month | That month does not count the client, and the caption's rule explains why |
| TC-9 | Window bound | Seed 36 months of history | Only the last 24 months are drawn by default and the caption says so |
| TC-10 | Month format | Inspect `month` values | Always `YYYY-MM`; the chart sorts chronologically, never as strings alphabetically across year boundaries |
| TC-11 | Single client filter | Request with one `client_ids` value | The series shows 1 or 0 per month, showing that client's continuity |

## 4. Frontend user story

**As a** consultant, **I want** a small active-clients-per-month chart on Reports, **so that** the health of the business shows up in the same place as the health of the campaigns.

**Scope**
- Reports page: a compact bar chart at the foot of the page, rendered only when the workspace has clients, using the same client filter as the rest of the page.
- The caption states the definition of active and the 24-month bound; hovering a bar lists the clients active that month.
- Loading shows a skeleton chart. Empty means the panel is absent, not zeroed. Error hides the panel without disturbing the rest of Reports.
- Accessibility: a data-table fallback with month and count, bars labelled directly, and the chart in its own scroll container on narrow screens.

**Definition of done**
- [ ] The panel does not exist for workspaces without clients.
- [ ] Zero months render as zero bars with no gap in the axis.
- [ ] The active definition is visible in the caption, not only in a tooltip.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** a monthly count of clients with sending activity, **so that** the trend comes from real sends rather than from when a client record was created.

**Scope**
- Add `GET /api/analytics/clients/monthly-active?months=24&client_ids=` to `server/routes.js`, workspace-scoped, returning `[{ month, count }]` in chronological order.
- Data model: depends on the nullable `client_id` on `campaigns` introduced for the client list; nothing further.
- Fill empty months with zero server-side and bound the window to the requested number of months, defaulting to 24 and capping at 60.
- The existing API limiter applies; the result is cached in-process for five minutes, since it changes at most daily.
- Log a `telemetry` row per call with the month count and duration.

**Definition of done**
- [ ] Activity is defined by sends, asserted by a test where a client has campaigns but no sends.
- [ ] Months are returned in order with no gaps.
- [ ] An empty workspace returns `[]` rather than 24 zero rows.
- [ ] Cross-workspace clients contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — active clients per month

**Preconditions:** A workspace with three clients. Client A sends in January and March; client B sends in January only; client C has campaigns but has never sent. Sandbox mailbox, seeded messages.

**Flow**
1. Sign in and open Reports on a workspace with no clients; confirm the panel is absent.
2. Create the clients, assign campaigns, and seed the sends.
3. Reload Reports and read the chart.
4. Hover the February bar.
5. Filter to client A only.

**Assertions**
- [ ] The panel appears only once clients exist.
- [ ] January shows 2, February shows 0, March shows 1.
- [ ] Client C never appears in any month.
- [ ] Hovering February shows an empty list rather than a broken tooltip.
- [ ] Filtering to client A shows 1, 0, 1 across the three months.

**Teardown:** Delete the seeded clients, campaigns, leads and messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | Adds a small monthly chart at the foot of the page, only when clients exist | Medium | Invisible for solo workspaces; placed last so it never competes with campaign performance |
| Dashboard | None | Low | A business-health trend is not an operational KPI |
| Goals | None | Low | Goals measure outcomes, not account counts |

**Verdict:** Fits an existing surface

Harry has no client concept today, so this only becomes meaningful once the client label from the client-list backlog item exists — and even then it is a business-health chart rather than an outreach metric. It earns a small panel at the bottom of Reports for the workspaces that use clients and nothing at all for everyone else.
