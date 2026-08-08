# Schedule History

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/schedule-history` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/schedule-history |
| **Auth** | API key (query param `api_key`) |

Lists every past run of a recurring deliverability test with its results, so you can see whether placement is getting better or worse.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner with a weekly test running, **I want** the history of every run, **so that** I can see a slow decline before it becomes a dead domain.

**Acceptance criteria**
- [ ] Given a recurring test, when I open its history, then I get one entry per run with `spam_test_id`, `test_run_no`, `status`, `inbox_count`, `tab_count`, `spam_count`, `reply_hour_interval_start`, `reply_hour_interval_end` and `adjusted_total_email_count`.
- [ ] Given the entries, when they render, then they are ordered by `test_run_no` descending so the most recent run (15) is first.
- [ ] Given `inbox_count` and `adjusted_total_email_count`, when a run renders, then an inbox rate is derived per run (184 of 200 is 92%) and shown beside the raw counts.
- [ ] Given several completed runs, when the history renders, then the trend across runs is stated in one sentence ("down 1.5 points across the last two runs") rather than left to the reader.
- [ ] Given `reply_hour_interval_start` and `reply_hour_interval_end`, when a run renders, then the measurement window is shown in plain words ("measured over 24 hours"), because a rate measured over 1 hour is not comparable to one measured over 24.
- [ ] Given a run whose `status` is not `completed`, when it renders, then its figures are labelled partial and excluded from the trend sentence.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the history is not available.
- [ ] Given the test is manual and has one run, when the history renders, then it shows that single run without a trend sentence.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Fetch history for an automated test | 200; two entries, run 15 (184 / 12 / 4 of 200) and run 14 (181 / 14 / 5 of 200), both completed, both with a 0–24 hour window |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; no history rendered |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That test history is not available" |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Poll the history every second | 429 on the excess; backoff with jitter; a single "Updating…" state |
| TC-6 | Empty result set | Fetch history for a schedule that has not run yet | 200 with `[]`; "No runs yet — first run is due Sunday 10:00" using the schedule's start time |
| TC-7 | Ordering | Render runs 14 and 15 | Run 15 appears first |
| TC-8 | Trend sentence | The documented data (92.0% then 92.0% at run 15 versus 90.5% at run 14) | The sentence states the direction and the size of the change in points, computed from the derived rates |
| TC-9 | Differing measurement windows | Two runs where one has `reply_hour_interval_end: 1` and the other 24 | Both windows are shown and the trend sentence is suppressed with a note that the runs are not comparable |
| TC-10 | Partial run | A run with `status: "running"` | Its figures are labelled partial, excluded from the trend, and it is not counted as a decline |

## 4. Frontend user story

**As a** mailbox owner, **I want** a run history under each recurring test, **so that** the story of a domain's health is one screen rather than a memory exercise.

**Scope**
- Monitoring → Deliverability → test detail: a "Run history" section listing each run with its number, date, status, inbox rate, the three counts, the total and the measurement window, plus a one-sentence trend summary above it.
- A simple line of inbox rate by run number sits above the table, reusing the chart style the Reports 30-day series already uses, so nothing new is invented visually.
- Loading: skeleton rows. Empty: "No runs yet" with the next scheduled run named. Error: last known history with a staleness note.
- Accessibility: the chart is decorative and every value is present in the table; the table has a caption and scoped headers; the trend sentence precedes both. Responsive: the table scrolls in its own container under 640px and the chart drops out entirely on the narrowest widths.

**Definition of done**
- [ ] Runs are listed newest first with a derived inbox rate per run.
- [ ] The trend sentence is generated from completed runs only and is suppressed when windows differ.
- [ ] The measurement window is visible on every run.
- [ ] Loading, empty, partial-run, incomparable-window and stale states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route serving a test's run history with derived rates, **so that** the trend is computed once rather than in the browser.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/history`, workspace-scoped, returning runs with `runNo`, `status`, `inboxCount`, `tabCount`, `spamCount`, `adjustedTotalEmailCount`, `replyWindowStartHour`, `replyWindowEndHour` and a derived `inboxRate`.
- Data model: a `deliverability_test_runs` table in `server/db.js` keyed on (`test_id`, `test_run_no`) so a re-fetch updates rather than duplicates, with the counts and window stored as returned.
- Pagination: runs accumulate weekly and a long-lived schedule will exceed a screen, so the route pages by `test_run_no` descending with a default page size, and the trend is computed over the most recent completed runs only.
- Rate limiting: refresh throttled per test; upstream 429 and 503 back off with jitter and serve stored rows with a staleness marker.
- Logged: an `events` row when a completed run's inbox rate drops more than a set number of points against the previous run — that is the alert the whole feature exists for; `telemetry` records fetch latency and failures.

**Definition of done**
- [ ] Re-fetching does not duplicate runs, asserted by a unique constraint and a test.
- [ ] `inboxRate` is computed server-side and is null when `adjustedTotalEmailCount` is zero.
- [ ] The trend excludes non-completed runs and runs with a different measurement window.
- [ ] A material drop writes exactly one event, not one per poll.

## 6. End-to-end test ticket

**Title:** E2E — Notice a slow decline in inbox placement

**Preconditions:** A workspace with one recurring test fixture that has runs 14 and 15 as documented, plus a third fixture run at 82% to create a visible decline, and one schedule that has never run.

**Flow**
1. Open Monitoring → Deliverability and choose the recurring test.
2. Open "Run history".
3. Read the trend sentence and the chart.
4. Add the declining run to the fixture and refresh.
5. Open the never-run schedule.
6. Check the Monitoring incident feed.

**Assertions**
- [ ] Runs are listed newest first with derived rates beside the raw counts and the 24-hour window shown.
- [ ] The trend sentence states the direction and size of the change in points.
- [ ] After the declining run is added, the sentence reflects the drop and the chart shows it.
- [ ] The never-run schedule shows "No runs yet" and names the next scheduled run.
- [ ] The incident feed contains exactly one drop entry, not one per refresh.

**Teardown:** Delete both test fixtures, their run rows and the incident.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability test detail | "Run history" table plus a small trend chart | Medium | Only appears for tests with more than one run; the chart reuses the Reports series style and drops out on narrow screens |
| Monitoring incident feed | Material placement drops raise incidents | Low | Reuses the feed; one incident per drop |

**Verdict:** Fits an existing surface

A single test result is a snapshot; the history is what actually tells you whether the domain is healthy, so it belongs on the test it describes rather than anywhere new. Keeping the chart optional and the conclusion in a sentence means the section is useful at a glance and still exact when someone needs the numbers. No new navigation item.
