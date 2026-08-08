# Sender Account Report

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/sender-account-wise` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/sender-report |
| **Auth** | API key (query param `api_key`) |

Gives each sending address a running record — how many tests it has been through, its average inbox, spam and bounce rates, and a reputation score.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner, **I want** a reputation record per sending address rather than per test, **so that** I judge a mailbox on its history instead of on one unlucky run.

**Acceptance criteria**
- [ ] Given a test, when I fetch the sender report, then I get one entry per `email` with a `details` object carrying `sender_name`, `tests_count`, `avg_inbox_rate`, `avg_spam_rate`, `avg_bounce_rate`, `reputation_score` and `last_test_date`.
- [ ] Given `tests_count` is present, when the entry renders, then it is shown beside the averages, because an average over 12 tests and one over 1 deserve different confidence.
- [ ] Given `reputation_score` is on an unstated scale (8.7 in the documented example), when it renders, then it is shown with an explicit scale label and never converted to a percentage or a colour alone.
- [ ] Given `last_test_date`, when it renders, then it is shown in the browser's timezone and a record older than the test being viewed is marked stale rather than presented as current.
- [ ] Given `sender_name` differs from the mailbox's display name in Harry, when it renders, then the address is the primary label and the name is secondary, since the address is the identifier the user acts on.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the report is not available.
- [ ] Given the response is an empty array, when it renders, then the panel says no sender history is available yet, never a table of zeroes.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Fetch the sender report for a completed test | 200; two entries — `campaigns@example.com` (12 tests, 92.5 / 5.2 / 2.3, score 8.7) and `support@example.com` (8 tests, 88.1 / 8.5 / 3.4, score 8.2) |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; no figures rendered |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Poll the report every second | 429 on the excess; backoff with jitter; a single "Updating…" state |
| TC-6 | Empty result set | Fetch for a test with no senders | 200 with `[]`; "No sender history yet"; no table drawn |
| TC-7 | Low sample | An entry with `tests_count: 1` | The averages are shown with the count and marked as based on a single test, so a 100% average is not over-read |
| TC-8 | Stale record | `last_test_date` earlier than the test being viewed | The record is marked as not reflecting this test's result, with both dates shown |
| TC-9 | Reputation scale | Render `reputation_score: 8.7` | Shown with an explicit scale (for example "8.7 out of 10") and a text verdict; never a bare number or a colour |
| TC-10 | Upstream unavailable | Provider returns 503 | Last known records shown with their timestamp and a "not up to date" note; retried on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** each sending address's track record on the Mailboxes page, **so that** reputation is where I manage the mailbox, not buried in one report.

**Scope**
- Monitoring → Deliverability report detail: a "By sender" table listing address, sender name, tests count, the three averages, reputation score and last test date; each row expands to the per-reply list that the reply-headers view hangs off.
- Mailboxes: each connected mailbox shows its reputation score with the scale and the number of tests behind it, linking to the latest report.
- Loading: skeleton rows. Empty: "No sender history yet." Error: last known values with a staleness note.
- Accessibility: a real table with caption and scoped headers; the reputation score is text with its scale stated; the expand control is a real disclosure with an accessible name. Responsive: collapses to cards keyed by address under 640px.

**Definition of done**
- [ ] Every documented `details` field is shown, with `tests_count` beside the averages.
- [ ] The reputation score always carries its scale in text.
- [ ] The Mailboxes figure and the report table come from one cached record.
- [ ] Loading, empty, low-sample, stale and error states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** per-sender reputation records fetched and stored, **so that** a mailbox's history survives the deletion of any individual test.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/senders/report`, workspace-scoped, returning entries with the `details` object flattened and Harry's own `mailboxId` attached where the address matches a connected mailbox.
- Data model: a `deliverability_sender_reputation` table in `server/db.js` (`from_email`, `mailbox_id`, `sender_name`, `tests_count`, `avg_inbox_rate`, `avg_spam_rate`, `avg_bounce_rate`, `reputation_score`, `last_test_date`, `fetched_at`) keyed on the address rather than the test, so deleting a test does not erase the mailbox's record.
- No pagination — a workspace has tens of addresses. Refresh throttled per test; upstream 429 and 503 back off with jitter and serve the stored record.
- Logged: an `events` row when a sender's `reputation_score` moves materially between fetches; `telemetry` records the distribution of scores so Monitoring can grade deliverability alongside its existing success factors.

**Definition of done**
- [ ] Records are keyed on the address, and deleting a test leaves them intact, asserted by a test.
- [ ] `mailbox_id` matching is server-side and an unmatched address still stores a record.
- [ ] A material score change writes exactly one event.
- [ ] The Mailboxes route and the report route read the same row.

## 6. End-to-end test ticket

**Title:** E2E — Judge a mailbox on its track record, not one test

**Preconditions:** A workspace with two sandbox mailboxes matching the documented addresses, a completed placement test fixture returning both sender records, and a second older fixture whose `last_test_date` precedes it.

**Flow**
1. Open Monitoring → Deliverability and choose the newer fixture report.
2. Open the "By sender" table.
3. Expand `support@example.com`.
4. Open Mailboxes.
5. Delete the test fixture and return to Mailboxes.
6. Open the older fixture report.

**Assertions**
- [ ] Both senders show their tests count beside the averages, and the reputation score reads with its scale.
- [ ] Expanding a sender reveals its per-reply list with the headers action available.
- [ ] Mailboxes shows the same score and tests count as the report.
- [ ] After the test is deleted, the Mailboxes reputation record is still present.
- [ ] The older report marks its sender records as not reflecting the newer test.

**Teardown:** Delete both fixtures; the reputation rows may remain, since they are keyed on the address by design.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | "By sender" table with expandable rows | Medium | The expansion carries the per-reply detail that would otherwise need its own panel |
| Mailboxes | Reputation score plus tests count per mailbox | Low | One line beside the existing health state; always carries its scale |

**Verdict:** Fits an existing surface

Reputation belongs to the mailbox rather than to any one test, which is why the number surfaces on Mailboxes and the detail stays in the report. Always printing the scale and the sample size is the difference between a number people trust and a number people invent meanings for. No new navigation item.
