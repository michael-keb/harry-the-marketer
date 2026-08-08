# Mailbox Summary

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/mailboxes-summary` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/mailbox-summary |
| **Auth** | API key (query param `api_key`) |

Scores each sending mailbox on where its test emails landed, so you can see which mailbox is dragging the others down.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner running several Gmail accounts, **I want** a placement score per mailbox, **so that** I can pull the weakest one out of rotation instead of pausing everything.

**Acceptance criteria**
- [ ] Given a test with results, when I fetch the mailbox summary, then I get one entry per mailbox with `id`, `from_email`, `esp`, `total_email_count`, `inbox_count`, `tab_count`, `spam_count`, `failed_count` and `placement_score`.
- [ ] Given entries, when they render, then they are ordered by `placement_score` ascending so the worst mailbox is the first thing read.
- [ ] Given one `from_email` appears with several `esp` values, when the view renders, then the address is grouped with a row per receiving provider, because the same mailbox can score 91 at Gmail and 88 at Outlook.
- [ ] Given a mailbox scores below the benchmark Monitoring already grades against, when the result is stored, then that mailbox is flagged on the Mailboxes page with the score and the test date.
- [ ] Given `failed_count` is above zero for a mailbox, when it renders, then failures are shown separately from `spam_count`, since they mean different things.
- [ ] Given the request is for a test I do not own, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the report is not available.
- [ ] Given the response is an empty array, when it renders, then the panel says no per-mailbox results are available yet, never a table of zeroes.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Fetch the mailbox summary for a completed test | 200; three entries — `mb_001` Gmail 91.0, `mb_002` Outlook 88.0, `mb_003` Yahoo 85.0 — each with all nine documented fields |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; no figures rendered |
| TC-3 | Test not found / wrong workspace | Fetch scoped to another workspace's test | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | Fetch with a malformed test scope | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Poll the summary every second | 429 on the excess; backoff with jitter; a single "Updating…" state |
| TC-6 | Empty result set | Fetch before any seed is delivered | 200 with `[]`; "No per-mailbox results yet"; no table drawn |
| TC-7 | Ordering | Render the three documented entries | Yahoo (85.0) is listed first, then Outlook (88.0), then Gmail (91.0) |
| TC-8 | Same address, two providers | `campaigns@example.com` appears as both `mb_001` Gmail and `mb_002` Outlook | The address is one group with two provider rows; no single averaged score replaces them |
| TC-9 | Score below benchmark | A mailbox with `placement_score: 62.0` | The mailbox is flagged on Mailboxes with the score and the test date, and an event is recorded once |
| TC-10 | Failures present | An entry with `failed_count: 4` | Failures are a separate figure from `spam_count`, and the row links to the sender-account report for that mailbox |

## 4. Frontend user story

**As a** mailbox owner, **I want** per-mailbox placement scores on both the report and the Mailboxes page, **so that** I act on the mailbox rather than the abstraction.

**Scope**
- Monitoring → Deliverability report detail: a "By mailbox" table with sending address, receiving provider, the four counts and the placement score, sorted worst first.
- Mailboxes: each mailbox row shows its most recent placement score with the test date, linking to the report; a mailbox below benchmark carries a plain-text warning.
- Campaigns → campaign detail: the "Sending from" area notes when an attached mailbox is below benchmark, so the warning reaches the moment of launch.
- Loading: skeleton rows. Empty: "No per-mailbox results yet." Error: last known scores with a staleness note.
- Accessibility: a real table with caption and scoped headers; the score is a number with a stated scale, and its verdict is a word, not a colour; grouping by address uses row headers rather than indentation alone. Responsive: collapses to cards keyed by address under 640px.

**Definition of done**
- [ ] Worst-first ordering is the default and is stated, so nobody assumes alphabetical.
- [ ] The same score appears on the report, on Mailboxes and on campaign detail from one cached record.
- [ ] Below-benchmark warnings clear automatically when a later test scores above it.
- [ ] Loading, empty, flagged, stale and unavailable states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route serving per-mailbox placement scores, **so that** Mailboxes, campaign detail and the report cannot disagree about which mailbox is weak.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/mailboxes`, workspace-scoped, returning entries with the documented fields plus Harry's own mailbox id where the `from_email` matches a connected mailbox.
- Data model: a `deliverability_mailbox_results` table in `server/db.js` (`test_id`, `provider_mailbox_id`, `mailbox_id`, `from_email`, `esp`, `total_email_count`, `inbox_count`, `tab_count`, `spam_count`, `failed_count`, `placement_score`, `fetched_at`), so scores accumulate per mailbox across scheduled runs.
- Matching `from_email` to a connected mailbox is done server-side and is allowed to fail — an unmatched address still renders in the report, it just does not flag a mailbox.
- No pagination — a test covers a handful of mailboxes. Refresh throttled per test; upstream 429 and 503 back off with jitter and serve the cache.
- Logged: an `events` row when a mailbox first crosses below or back above the benchmark; `telemetry` records fetch latency, failures, and the distribution of scores so Monitoring can grade deliverability as a component.

**Definition of done**
- [ ] Route is workspace-scoped and 404s on another workspace's test, covered by a test.
- [ ] An unmatched `from_email` renders without flagging anything and without an error.
- [ ] Crossing the benchmark in either direction writes exactly one event.
- [ ] Scores shown on Mailboxes and in the report come from the same stored row.

## 6. End-to-end test ticket

**Title:** E2E — Find and retire the weakest sending mailbox

**Preconditions:** A workspace with two sandbox mailboxes matching `campaigns@example.com` and `support@example.com`, one launched campaign using both, and a completed placement test fixture returning the documented three entries (91.0, 88.0, 85.0) with one further entry at 62.0 for `support@example.com`.

**Flow**
1. Open Monitoring → Deliverability and choose the fixture report.
2. Open the "By mailbox" table.
3. Note the order and the flagged mailbox.
4. Open Mailboxes.
5. Open the campaign detail page.
6. Detach the flagged mailbox from the campaign.

**Assertions**
- [ ] The table is sorted worst first, with the 62.0 row at the top.
- [ ] `campaigns@example.com` appears once as a group with a Gmail row and an Outlook row, not as an averaged single score.
- [ ] Mailboxes shows the 62.0 score with the test date and a plain-text warning.
- [ ] Campaign detail warns that an attached mailbox is below benchmark before the user launches anything.
- [ ] After detaching, the campaign warning clears while the Mailboxes warning remains.

**Teardown:** Delete the fixture test and its cached mailbox rows; reattach the mailbox to leave the campaign as found.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | "By mailbox" table sorted worst first | Low | The report's second most important table after the headline counts |
| Mailboxes | Score plus a conditional warning per mailbox | Medium | One line of text with the existing health state; the warning appears only below benchmark and clears itself |
| Campaigns → campaign detail | Conditional note in "Sending from" | Low | One line, only while a below-benchmark mailbox is attached |

**Verdict:** Fits an existing surface

Placement scores only matter where the mailbox is, which is why the same number appears on Mailboxes and on campaign detail rather than living only in a report nobody opens. Everything conditional disappears when scores are healthy, so a well-behaved workspace sees one extra line and nothing else. No new navigation item.
