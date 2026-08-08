# Mailbox Count

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/mailboxes-count` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/mailbox-count |
| **Auth** | API key (query param `api_key`) |

Gives the headline totals for a deliverability test: how many test emails reached the inbox, the spam folder, a tab, or failed outright.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner, **I want** one line telling me how many test emails reached the inbox, **so that** I get the answer without reading a report.

**Acceptance criteria**
- [ ] Given a test with results, when I fetch the counts, then I get `inbox_count`, `spam_count`, `tab_count`, `failed_count` and `total_email_count`.
- [ ] Given the counts, when they render, then the headline is a percentage derived from `inbox_count / total_email_count` with the raw counts beside it ("264 of 300 reached the inbox — 88%").
- [ ] Given `tab_count` is above zero, when it renders, then tabbed mail is shown as its own state and never folded into the inbox figure, because a Promotions tab is not an inbox.
- [ ] Given `failed_count` is above zero, when it renders, then failures are called out separately from spam, since a bounce and a spam placement need different fixes.
- [ ] Given the four counts do not sum to `total_email_count`, when they render, then the difference is shown as "not yet delivered" rather than silently hidden.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the summary shows "not available", not zeroes.
- [ ] Given `total_email_count` is `0`, when it renders, then no percentage is calculated and the panel says results are still pending.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Fetch counts for a completed test | 200 `{"inbox_count": 264, "spam_count": 12, "tab_count": 24, "failed_count": 0, "total_email_count": 300}`; headline reads "264 of 300 reached the inbox — 88%" |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; no figures rendered |
| TC-3 | Test not found / wrong workspace | Fetch scoped to another workspace's test | 404 `{"error": "Resource not found"}`; "Not available"; no zero figures displayed |
| TC-4 | Validation failure | Fetch with a malformed test scope | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Poll the counts every second | 429 on the excess; backoff with jitter; a single "Updating…" state |
| TC-6 | Empty result set | Fetch before any seed is delivered | `total_email_count: 0`; no percentage; panel reads "Results pending" |
| TC-7 | Divide by zero | `total_email_count: 0` with non-zero `inbox_count` (inconsistent upstream) | No percentage computed; the raw counts are shown with a note that the figures are inconsistent; nothing throws |
| TC-8 | Tabs matter | `tab_count: 24` | Tabbed mail is its own figure; the inbox percentage excludes it and the difference is explained in one sentence |
| TC-9 | Failures present | `failed_count: 5` | Failures are shown separately from spam and link to the sender-account report to see which mailbox failed |
| TC-10 | Upstream unavailable | Provider returns 503 | Last known counts shown with their timestamp and a "not up to date" note; retried on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** the headline placement figures at the top of a deliverability report, **so that** the first thing I read is the answer.

**Scope**
- Monitoring → Deliverability report detail: a summary strip at the top with inbox, tabs, spam, failed and total, plus one sentence stating the inbox percentage.
- Monitoring index: the deliverability component check reports the most recent test's inbox percentage, consistent with the existing success-factor grading against cold-outreach benchmarks.
- Loading: skeleton figures. Pending: "Results pending" with no percentage. Error: last known figures with a staleness note. Not available: an explicit message, never zeroes.
- Accessibility: the strip is a description list with real labels, readable in order without relying on layout; percentages are accompanied by their raw counts so nothing depends on a bar. Responsive: the strip wraps to two rows under 640px rather than shrinking the type.

**Definition of done**
- [ ] Inbox, tabs, spam and failed are four distinct figures, never merged.
- [ ] The percentage is computed only when `total_email_count` is above zero.
- [ ] Any shortfall between the parts and the total is shown as "not yet delivered".
- [ ] Loading, pending, complete, stale and unavailable states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route serving the headline placement counts for a test, **so that** the report header and the Monitoring component grade read one number.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/counts`, workspace-scoped, returning `inboxCount`, `spamCount`, `tabCount`, `failedCount`, `totalEmailCount` and a derived `inboxRate` computed server-side so it is not calculated in two places.
- Data model: a `deliverability_counts` table in `server/db.js` (`test_id`, the five counts, `fetched_at`), keeping a row per fetch so a trend across scheduled runs can be drawn later without a new integration.
- No pagination. Refresh throttled to once per test per five minutes while the test is active, cached permanently once complete; upstream 429 and 503 back off with jitter and serve the cache.
- Logged: an `events` row when a completed test's inbox rate falls below the benchmark Monitoring already grades against; `telemetry` records fetch latency and failures.

**Definition of done**
- [ ] `inboxRate` is computed once, server-side, and is null when `totalEmailCount` is zero.
- [ ] Route is workspace-scoped and 404s on another workspace's test, covered by a test.
- [ ] One row is stored per fetch so history is preserved for later trend work.
- [ ] A below-benchmark completed test writes exactly one event.

## 6. End-to-end test ticket

**Title:** E2E — Read the headline result of a placement test

**Preconditions:** A workspace with one completed placement test fixture returning the documented counts (264 / 12 / 24 / 0 / 300) and one running test with `total_email_count: 0`.

**Flow**
1. Open Monitoring → Deliverability and choose the completed test.
2. Read the summary strip.
3. Return to the list and open the running test.
4. Return to the Monitoring index.

**Assertions**
- [ ] The completed test's strip shows 264 inbox, 24 tabs, 12 spam, 0 failed, 300 total, and the sentence states 88%.
- [ ] Tabs are visibly separate from inbox and the sentence explains why they are not counted as inbox.
- [ ] The running test shows "Results pending" and no percentage anywhere.
- [ ] The Monitoring index deliverability component reports the completed test's inbox rate.
- [ ] Reloading serves cached figures with their timestamp and makes no second upstream call.

**Teardown:** Delete both test fixtures and their cached count rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | Summary strip of five figures plus a sentence | Low | It is the top-line answer the report exists for; the sentence means the figures can be skipped |
| Monitoring index | Component check reports the latest inbox rate | Low | Reuses the existing component-check row and benchmark grading |

**Verdict:** Fits an existing surface

This is the number the whole category is for, so it belongs at the top of the report rather than anywhere new. Keeping tabs, spam and failures visibly separate is the only real design decision, because collapsing them is how deliverability tools end up flattering the user. No new navigation item.
