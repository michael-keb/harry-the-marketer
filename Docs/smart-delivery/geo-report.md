# Geo-wise Report

| | |
|---|---|
| **Endpoint** | `POST https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/groupwise` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/geo-report |
| **Auth** | API key (query param `api_key`) |

Breaks a deliverability test down by part of the world, so you can see that mail reaching inboxes in North America is landing in spam in Asia Pacific.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation gap.** The request body is documented as an empty object (`{}`); any filtering or grouping arguments this POST accepts are not published, and this endpoint sits behind SmartLead support access. The story is grounded in the documented **200 response** — `overallTotalCount`, `status` and a `result` array of regions — and treats the body as opaque until the provider confirms it.

## 2. User story

**As a** marketer running a campaign into Australian companies, **I want** inbox placement broken down by region, **so that** I know whether my target market specifically is seeing my email.

**Acceptance criteria**
- [ ] Given a completed placement test, when I open the geo report, then I get `overallTotalCount`, `status` and a `result` array where each row has `region`, `inbox_rate`, `spam_rate`, `bounce_rate` and `mailbox_count`.
- [ ] Given `status` is not `completed`, when the view renders, then it says the test is still running and shows partial figures labelled as partial, rather than presenting them as final.
- [ ] Given a region's `inbox_rate` is well below the others, when the view renders, then that region is called out in words ("Asia Pacific is 7 points below North America") rather than leaving the user to compare three decimals.
- [ ] Given `mailbox_count` differs sharply between regions, when rates are shown, then the count is shown beside each rate so a 100% figure from two mailboxes is not read as strong evidence.
- [ ] Given the three rates for a region do not sum to 100, when they render, then each is labelled independently and no total is implied.
- [ ] Given the test id is unknown or another workspace's, when I request it, then the API returns 404 `{"error": "Resource not found"}` and the page says the report is not available.
- [ ] Given `result` is empty, when it renders, then the panel shows an empty state naming `overallTotalCount` and the test status, not a zero-rate chart.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST the groupwise route for a completed test | 200; `status: "completed"`, `overallTotalCount: 780`, three rows with `region`, `inbox_rate`, `spam_rate`, `bounce_rate`, `mailbox_count` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; nothing rendered as fresh |
| TC-3 | Test not found / wrong workspace | POST with another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | POST with a malformed `spamTestId` or a body the provider rejects | 422 `{"error": "Invalid parameters provided"}`; message shown; the rejected body is logged to telemetry so the contract can be corrected |
| TC-5 | Rate limited | Poll the report every second | 429 on the excess; backoff with jitter; one "Updating…" state |
| TC-6 | Empty result set | POST for a test with no delivered seeds | 200 with `result: []`; "No regional results yet" plus the `status` value; no chart drawn |
| TC-7 | Test still running | Response with `status: "running"` and two of three regions present | Figures shown with a "partial — test still running" label; the missing region is listed as pending, not as 0% |
| TC-8 | Low sample region | A region with `mailbox_count: 2` and `inbox_rate: 100` | The count is shown beside the rate and the row is marked "small sample" so the figure is not over-read |
| TC-9 | Poor region | `Asia Pacific` at `inbox_rate: 85.3` against `North America` at `92.5` | The summary sentence names Asia Pacific as the weakest region with the gap in points |
| TC-10 | Upstream unavailable | Provider returns 503 | "Regional breakdown is temporarily unavailable"; last known result kept and timestamped; retried on the next tick |

## 4. Frontend user story

**As a** marketer, **I want** a regional breakdown inside the deliverability report, **so that** I can see where my mail is struggling without exporting anything.

**Scope**
- Monitoring → Deliverability report detail: a "By region" section with one row per `region` showing inbox, spam and bounce rates plus the `mailbox_count`, and a one-sentence summary naming the weakest region.
- Reports: the existing per-campaign rates gain a "Placement by region" link when a campaign has a completed placement test, rather than duplicating the table.
- Loading: skeleton rows. Empty: "No regional results yet." Partial: figures with a "test still running" label. Error: banner keeping the last result visible and timestamped.
- Rates are shown to one decimal, matching the response, with the sample size beside them so precision is never mistaken for confidence.
- Accessibility: the breakdown is a real table with a caption and scoped headers, readable without the bar visualisation; any bars are decorative with the figures as text. Responsive: the table scrolls horizontally inside its own container under 640px, never the page.

**Definition of done**
- [ ] Every region row shows all three rates and the `mailbox_count`.
- [ ] The summary sentence is generated from the data, not hardcoded, and names the actual weakest region.
- [ ] Partial results are unmistakably labelled as partial.
- [ ] Loading, empty, partial, error and small-sample states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that fetches and caches the regional breakdown for a test, **so that** Monitoring and Reports show the same figures.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/regions` (the upstream POST is an implementation detail of the adapter), workspace-scoped.
- Data model: a `deliverability_region_results` table in `server/db.js` (`test_id`, `region`, `inbox_rate`, `spam_rate`, `bounce_rate`, `mailbox_count`, `status`, `overall_total_count`, `fetched_at`), so a completed test's breakdown is durable and comparable between runs.
- No pagination — regions are counted in single digits. Refresh throttled to once per test per five minutes while `status` is not `completed`, and cached permanently once it is; upstream 429 and 503 back off with jitter.
- Because the request body is undocumented, one adapter function owns the POST body; it currently sends `{}` and logs any 422 with the body it sent, so the real contract can be discovered from telemetry rather than guessed.
- Logged: an `events` row when a test's `status` reaches `completed`; `telemetry` records latency, 422 bodies, and any region whose `inbox_rate` falls below the cold-outreach benchmark Monitoring already grades against.

**Definition of done**
- [ ] Route is workspace-scoped and 404s on another workspace's test, covered by a test.
- [ ] A completed breakdown is cached and served without further upstream calls.
- [ ] Rates are stored as numbers, not strings, and rendered without recomputation.
- [ ] 422 responses record the body that caused them.

## 6. End-to-end test ticket

**Title:** E2E — Read inbox placement by region

**Preconditions:** A workspace with a completed placement test fixture returning the documented three-region body (North America 92.5, Europe 88.9, Asia Pacific 85.3) and a campaign linked to it.

**Flow**
1. Open Monitoring and choose the fixture's deliverability report.
2. Open the "By region" section.
3. Read the summary sentence.
4. Open Reports and find the campaign's "Placement by region" link.
5. Follow it back to the report.

**Assertions**
- [ ] Three region rows appear with all three rates and the mailbox counts 300, 280 and 200.
- [ ] The summary names Asia Pacific as the weakest region and states the gap against North America.
- [ ] `overallTotalCount` (780) is shown as the total mailboxes tested.
- [ ] The Reports link lands on this exact section, not the top of the report.
- [ ] Replacing the fixture with `status: "running"` shows the partial label and no final verdict.

**Teardown:** Delete the fixture test and its cached region rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | New "By region" table with a summary sentence | Medium | One table, three-ish rows; the summary carries the meaning so the table can be skipped entirely |
| Reports | One conditional link per campaign | Low | Link only, no duplicated table; appears only when a placement test exists |

**Verdict:** Fits an existing surface

The regional breakdown is another view of a report the user has already opened, so it belongs inside it, and the summary sentence means nobody has to read three decimals to get the point. Reports gets a link rather than a copy of the table, so the same numbers live in one place. No new navigation item.
