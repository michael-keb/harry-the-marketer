# Stop Automated Test

| | |
|---|---|
| **Endpoint** | `PUT https://smartdelivery.smartlead.ai/api/v1/spam-test/{spamTestId}/stop` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/stop-automated-test |
| **Auth** | API key (query param `api_key`) |

Stops a recurring deliverability test from running again, while keeping everything it has already measured.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation note.** The page describes the method as PUT and the cURL and Python samples use PUT, but the JavaScript sample uses POST, and all attach an empty body. The story treats PUT as authoritative and keeps the method inside one adapter so a correction is a one-line change.

## 2. User story

**As a** mailbox owner, **I want** to stop a recurring placement test without deleting it, **so that** I keep the history while the seed sends stop eating my daily send allowance.

**Acceptance criteria**
- [ ] Given a running automated test, when I stop it, then the API returns 200 `{"message": "Test stopped successfully"}` and the schedule's status changes to stopped.
- [ ] Given the documented behaviour that stopping preserves results, when the test is stopped, then its run history and every cached report remain readable.
- [ ] Given the test is stopped, when the engine ticks, then no further seed sends are made for it and no daily allowance is consumed.
- [ ] Given a run is in progress when I stop it, then the confirmation says what happens to that run and the resulting state is what the confirmation promised.
- [ ] Given a test that is already stopped or is a one-off manual test, when I try to stop it, then the action is unavailable rather than failing after the fact.
- [ ] Given the `spamTestId` is unknown or another workspace's, when I stop it, then the API returns 404 `{"error": "Resource not found"}` and nothing changes.
- [ ] Given the test is stopped, when it completes, then an activity-trail entry records who stopped it and when, and the recurring-tests list shows it as stopped rather than removing it.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | PUT the stop route for a running automated test | 200 `{"message": "Test stopped successfully"}`; the schedule shows stopped and no next run is stated |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; the test keeps running |
| TC-3 | Test not found / wrong workspace | PUT with another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; nothing changes; the list refreshes |
| TC-4 | Validation failure | PUT with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; no state change |
| TC-5 | Rate limited | Stop twenty schedules in a burst | 429 on the excess; backoff with jitter; one "Retrying…" state |
| TC-6 | Empty result set | Open the recurring-tests list after stopping the only schedule | 200 with the stopped test still listed; the "active schedules" count reads zero with an explicit empty state |
| TC-7 | Already stopped | Stop the same test twice | The action is disabled after the first stop; a forced second call is treated as already stopped and shows no error |
| TC-8 | Manual test | Attempt to stop a `test_type: "manual"` test | The action is not offered; the API is never called |
| TC-9 | Results preserved | Stop a test with 15 completed runs, then open its history | All 15 runs and every cached report section are still readable |
| TC-10 | Mid-run stop | Stop a test while a run is sending seeds | The confirmation states what happens to the in-progress run; the observed outcome matches it; no seed is sent after the stop is recorded |

## 4. Frontend user story

**As a** mailbox owner, **I want** a stop control on a recurring test with a confirmation that says what is kept, **so that** I am not afraid the history goes with it.

**Scope**
- Monitoring → Deliverability → recurring tests: a "Stop" action on each active schedule, with a confirmation naming the test and stating plainly that results and history are kept.
- A stopped schedule remains in the list with a stopped label and its history intact; the list separates active from stopped rather than mixing them.
- Loading: the row shows a pending state. Error: an inline message on the row with the test still shown as running. After stopping: the row moves to stopped without a page reload.
- Delete is deliberately a separate action from stop, so the reversible thing and the destructive thing are never one click apart.
- Accessibility: "Stop" is a real button with an accessible name including the test name; the confirmation traps focus and Escape cancels; the result is announced in a live region. Responsive: the action moves into the row's overflow menu under 640px.

**Definition of done**
- [ ] The confirmation states that history and reports are kept.
- [ ] Stop and delete are visually and physically separate.
- [ ] A stopped schedule remains listed and its history remains reachable.
- [ ] Loading, error, already-stopped and mid-run states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that stops a schedule without touching its data, **so that** stopping is always safe.

**Scope**
- Route in `server/routes.js`: `PUT /api/deliverability/tests/:testId/stop`, workspace-scoped, setting the stored test's status to stopped and clearing its next-run time.
- Data model: no new tables and no deletions — only a status change on `deliverability_tests`, so run history and every cached report table are untouched by design.
- The engine's tick skips stopped schedules; a run already claimed by a tick is allowed to finish or is cancelled according to whatever the confirmation copy promises, and the two are kept in sync by a test.
- The adapter owns the HTTP method, since the documented samples disagree between PUT and POST.
- Rate limiting: standard app limiter; upstream 429 and 503 back off with jitter, and a stop that returns 404 because it is already stopped is treated as success.
- Logged: an `events` row with actor, test and timestamp; `telemetry` records how many schedules are active per workspace so Monitoring can show seed-send load.

**Definition of done**
- [ ] Stopping deletes nothing — asserted by a test counting run rows and cached report rows before and after.
- [ ] The engine makes no seed send for a stopped schedule, covered by a test.
- [ ] Route is workspace-scoped and 404s on another workspace's test.
- [ ] Stop appears in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Stop a recurring placement test and keep its history

**Preconditions:** A workspace with one sandbox mailbox, one active weekly schedule with three completed runs and cached reports, and one completed manual test.

**Flow**
1. Open Monitoring → Deliverability → recurring tests.
2. Choose "Stop" on the weekly schedule and read the confirmation.
3. Confirm.
4. Open the stopped test's run history and one of its report sections.
5. Advance the engine clock past the next scheduled run and let a tick pass.
6. Look for a stop action on the manual test.

**Assertions**
- [ ] The confirmation names the test and states that results and history are kept.
- [ ] After confirming, the schedule shows as stopped, remains in the list, and states no next run.
- [ ] All three runs and the cached report sections are still readable.
- [ ] After the tick, no new run appears and the sandbox mailbox's send count is unchanged.
- [ ] No stop action is offered on the manual test.
- [ ] The activity trail records who stopped the schedule and when.

**Teardown:** Delete the stopped schedule and its runs; reset the sandbox mailbox counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability recurring tests | "Stop" action per active schedule plus a confirmation | Low | One action per row; the confirmation is a sentence and two buttons |
| Recurring tests list | Active and stopped schedules are separated | Low | A grouping change, not a new control |

**Verdict:** Fits an existing surface

Stop lives on the schedule it stops and nowhere else. The one design decision that matters is keeping it clearly apart from delete and saying in the confirmation that nothing is lost, because a user who is unsure will simply leave the test running and quietly burn their send allowance. No new navigation item.
