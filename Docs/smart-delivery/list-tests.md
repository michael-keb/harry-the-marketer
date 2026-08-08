# List All Tests

| | |
|---|---|
| **Endpoint** | `POST https://smartdelivery.smartlead.ai/api/v1/spam-test/report` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/list-tests |
| **Auth** | API key (query param `api_key`) |

Lists every deliverability test in the workspace, with its type, status and schedule.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation gap.** The page description promises "filtering by date, type, and status", but the published request body is an empty object (`{}`) and only `api_key` is documented as a parameter — this endpoint is behind SmartLead support access. The story below is grounded in the documented **200 response** fields and treats filters as a client-side capability until the provider publishes the body.

## 2. User story

**As a** mailbox owner, **I want** one list of every deliverability test with its status and schedule, **so that** I can see what is running, what has finished, and what needs looking at.

**Acceptance criteria**
- [ ] Given tests exist, when I fetch the list, then each entry carries `spam_test_id`, `test_name`, `test_type`, `status`, `schedule_start_time`, `test_end_date`, `every_days` and `current_test_run_no`.
- [ ] Given an entry with `test_type: "automated"` and `every_days: 7`, when it renders, then the row reads the cadence in words ("every 7 days, run 8") using `current_test_run_no`.
- [ ] Given an entry with `test_type: "manual"` and `every_days: null`, when it renders, then no cadence is shown and the null is never printed as "null".
- [ ] Given entries with `status` values such as `active` and `completed`, when the list renders, then status is a readable word and the list can be filtered by it without a server call.
- [ ] Given `schedule_start_time` and `test_end_date`, when they render, then both are shown in the browser's timezone, matching how the sending rhythm already reports times.
- [ ] Given no tests exist, when the list renders, then the empty state says so and offers "Run a test", rather than showing an empty table with headers.
- [ ] Given the fetch fails, when the page renders, then the last known list is shown with a quiet "not up to date" note and a retry, because an empty list would read as "you have no tests".
- [ ] Given a test is running, when the list is open, then its row updates without a manual refresh as the engine ticks.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST the report list route for a workspace with two tests | 200; array with `test_001` (automated, active, `every_days: 7`, `current_test_run_no: 8`) and `test_002` (manual, completed, `every_days: null`, run 1) |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; signed-out state; no cached list presented as current |
| TC-3 | Not found / wrong workspace | POST scoped to a workspace the user has left | 404 `{"error": "Resource not found"}`; UI returns to the workspace picker |
| TC-4 | Validation failure | POST a body with a filter the provider rejects | 422 `{"error": "Invalid parameters provided"}`; the client falls back to an empty body plus local filtering and logs the rejected body to telemetry |
| TC-5 | Rate limited | Poll the list every second | 429 on the excess; backoff with jitter; one "Updating…" state |
| TC-6 | Empty result set | Fetch in a workspace with no tests | 200 with `[]`; "No placement tests yet" plus a "Run a test" action |
| TC-7 | Null cadence | Render `test_002` with `every_days: null` | No cadence text; the word "null" appears nowhere |
| TC-8 | Filter by status | Filter the list to `completed` | Only `test_002` remains; the filter is reflected in the URL so it survives a reload |
| TC-9 | Long list | A workspace with 300 tests | The list virtualises or pages client-side, stays responsive, and the page never scrolls horizontally |
| TC-10 | Running test updates | Watch a test whose `status` moves from `active` to `completed` | The row updates in place on the next poll without losing the user's scroll position or selection |

## 4. Frontend user story

**As a** mailbox owner, **I want** the deliverability tests list to be the front door of the Deliverability section, **so that** everything else — reports, folders, bulk actions — hangs off one place.

**Scope**
- Monitoring → Deliverability: a table with test name, type, status, cadence, last run number, start and end dates, and the blocklist summary column; filters for status and type above it; the folder sidebar beside it.
- Rows link to the report detail; a running test shows a live status without the user refreshing.
- Loading: skeleton rows. Empty: "No placement tests yet" with the run-a-test action. Stale: the cached list with a quiet note. Error on first load: a short message with a retry.
- Cadence is expressed in words; raw cron and null values never reach the screen.
- Accessibility: a real table with caption and scoped headers; status is text; the filter controls are labelled and their state announced. Responsive: the table scrolls inside its own container under 640px, or collapses to cards with the test name as the heading — never a horizontally scrolling page.

**Definition of done**
- [ ] Every documented field is either shown or deliberately omitted, with nulls handled.
- [ ] Filters are client-side, reflected in the URL, and survive a reload.
- [ ] A running test updates in place without losing selection or scroll.
- [ ] Loading, empty, stale, error and long-list states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route listing the workspace's deliverability tests, **so that** the list, the folder counts and the bulk actions all read one source.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests` (the upstream POST is hidden inside the adapter), workspace-scoped, returning `id`, `name`, `type`, `status`, `scheduleStartTime`, `testEndDate`, `everyDays`, `currentRunNo`, `folderId` and the cached blocklist count.
- Data model: reuses `deliverability_tests` from the create-test tickets; the list is served from local rows and reconciled with upstream on a throttled schedule, so the page does not depend on an upstream round trip.
- Pagination: server-side paging by `updated_at` with a default page size, plus the folder filter; the client requests one page at a time even though the upstream contract is unpaged, so a workspace with hundreds of tests does not load them all.
- Rate limiting: reconciliation is throttled per workspace; upstream 429 and 503 back off with jitter and the stored rows are served with a staleness marker.
- Logged: no `events` for a read; `telemetry` records reconciliation latency, rejected request bodies, and the count of tests currently `active`, so Monitoring can grade the deliverability service.

**Definition of done**
- [ ] Another workspace's tests never appear, covered by a test.
- [ ] The list is served from local rows and works while the upstream is unavailable.
- [ ] Paging is stable when a new test is created mid-scroll.
- [ ] Blocklist counts on the list come from the same rows as the detail view.

## 6. End-to-end test ticket

**Title:** E2E — Review every deliverability test at a glance

**Preconditions:** A workspace with one active automated test on a 7-day cadence at run 8, one completed manual test, one test filed in a folder, and a stubbed provider returning the documented body.

**Flow**
1. Open Monitoring → Deliverability.
2. Read the table.
3. Filter to status "completed".
4. Reload the page.
5. Clear the filter, select the folder in the sidebar, then return to "All tests".
6. Let the active test complete and watch its row.

**Assertions**
- [ ] The automated test reads "every 7 days, run 8"; the manual test shows no cadence and no "null".
- [ ] Start and end dates are shown in local time.
- [ ] The completed filter leaves only the manual test and is reflected in the URL.
- [ ] The reload keeps the filter applied.
- [ ] The folder selection filters to its one test and "All tests" restores all three.
- [ ] The active test's status changes to completed in place, without the page jumping.

**Teardown:** Delete the three test fixtures and the folder.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring | A Deliverability section with a tests table and two filters | High | It is the anchor every other smart-delivery ticket hangs off, so it must exist once and be reused; it is a section of Monitoring, not a new page, and it collapses to a single summary line when there are no tests |
| Monitoring index | Deliverability appears as one more component check | Low | Reuses the existing component-check list |

**Verdict:** Fits an existing surface

Monitoring already exists to show the health of every hop in the pipeline, and inbox placement is the last hop before a prospect reads anything — so the tests list belongs there rather than in a page of its own. Because every other ticket in this category renders inside this section, building it once keeps the whole capability to a single new place to look. No new navigation item.
