# Retrigger Campaign Webhooks

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/webhooks/retrigger-failed-events` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/retrigger-webhooks |
| **Auth** | API key (query param `api_key`) |

Re-sends the campaign notifications that failed during a period you choose, and tells you how many it retried.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** workspace owner whose CRM was down for an afternoon, **I want** to replay the campaign notifications that failed in that window, **so that** my other systems catch up without me re-entering anything by hand.

**Acceptance criteria**
- [ ] Given failed notifications exist in the window, when I retrigger with `fromTime` and `toTime` in ISO format with milliseconds, then I get `{ success: true, retriggered_count: N }` where N is the number retried.
- [ ] Given no failures exist in the window, when I retrigger, then I get a 200 with `retriggered_count: 0` and a message saying there was nothing to retry.
- [ ] Given only failed notifications are eligible, when I retrigger, then successful notifications in the same window are not sent a second time.
- [ ] Given a retriggered notification fails again, when the retry completes, then it stays in the failed list and the failure count does not silently reset.
- [ ] Given `fromTime` is after `toTime`, or either is missing or malformed, when I retrigger, then the request is rejected with a field-level message and nothing is sent.
- [ ] Given a retrigger is already running for the campaign, when I trigger another, then the second is refused rather than duplicating deliveries.
- [ ] Given the campaign belongs to another workspace, when I retrigger, then I get a not-found response.
- [ ] Given a retrigger runs, when I check the activity trail, then it names who ran it, the window, and how many were retried.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 5 failed notifications in January. POST with `fromTime=2024-01-01T00:00:00.000Z`, `toTime=2024-01-31T23:59:59.999Z` | 200 `{ success: true, retriggered_count: 5 }`; the stub receives 5 calls |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; the stub receives nothing |
| TC-3 | Not found / wrong workspace | Retrigger another workspace's campaign | 404 |
| TC-4 | Validation failure | POST with `fromTime` after `toTime` | 422 naming `fromTime`; nothing sent |
| TC-5 | Rate limited | Fire retrigger repeatedly | 429; the client backs off and no duplicate deliveries occur |
| TC-6 | Empty result set | Retrigger a window with no failures | 200, `retriggered_count: 0`, UI says "Nothing to retry in this period" |
| TC-7 | Successes untouched | Seed 10 successes and 3 failures, retrigger | Stub receives exactly 3 calls |
| TC-8 | Retry fails again | Point the stub at a URL that always fails, retrigger | The failures remain listed; the count of outstanding failures is unchanged |
| TC-9 | Concurrent retrigger | Fire two retriggers for the same campaign at once | The second is refused; the stub receives each event once |
| TC-10 | Large window | Retrigger a window with thousands of failures | The job runs in the background with visible progress rather than blocking the request |
| TC-11 | Hook removed since | Retrigger events whose target hook was deleted | Those events are skipped and reported as skipped, not counted as retried |

## 4. Frontend user story

**As a** workspace owner, **I want** a "Retry failed notifications" action on the Monitoring notifications card, **so that** recovering from an outage in a downstream system is one click with a clear window.

**Scope**
- Monitoring, Notifications card: a "Retry failed" action, shown only when the failed count is above zero, opening a small dialog with the window pre-filled to the range already selected on the card.
- The dialog states plainly how many failures fall in the window and that successful notifications will not be resent.
- Loading shows progress on the card with a count as the retry runs; completion shows how many were retried and how many failed again. Errors keep the dialog open with the reason.
- Accessibility: the dialog is focus-trapped with a clear primary action; the progress and result are announced in a live region; the date fields are labelled with their expected format and accept a picker.
- Responsive: the dialog fills the width on mobile and the two date fields stack.

**Definition of done**
- [ ] The action is invisible when there is nothing to retry.
- [ ] The dialog states the count before the user commits.
- [ ] The result distinguishes retried, failed again, and skipped.
- [ ] A second retry cannot be started while one is running.

## 5. Backend user story

**As a** Harry server, **I want** to replay failed outbound notifications for a campaign and window, **so that** downstream systems can be reconciled without manual work.

**Scope**
- Add `POST /api/campaigns/:id/notifications/retry` to `server/routes.js` taking `{ from, to }`, workspace-scoped.
- Data model: none new — select failed rows from the same `telemetry`/delivery records the notification sender writes, and mark each attempt.
- Validate the window as ISO 8601 with milliseconds and reject an inversion with a 422; cap the window length.
- Guard concurrency with a per-campaign lock so two retriggers cannot overlap; run large batches in the background with the same rate limiting the live sender uses.
- Skip events whose target hook no longer exists and report them separately from retries.
- Write an `events` row naming the actor, window and outcome counts; log per-attempt latency to `telemetry`.

**Definition of done**
- [ ] Only failed events are selected, proven by a test with mixed outcomes.
- [ ] Concurrency lock is tested.
- [ ] Retries that fail again remain failed and are not double-counted.
- [ ] Sends are never blocked by a retry job.

## 6. End-to-end test ticket

**Title:** E2E — replay failed campaign notifications

**Preconditions:** A workspace with a configured webhook pointing at a local stub, one campaign, and seeded history of 10 successful and 3 failed notification attempts inside a known window.

**Flow**
1. Sign in and open Monitoring.
2. Read the Notifications card and confirm 3 failures.
3. Click "Retry failed" and confirm the pre-filled window.
4. Run the retry and wait for completion.
5. Point the stub at a failing URL, seed two more failures, and retry again.

**Assertions**
- [ ] The stub receives exactly 3 calls in step 4, none for the successful events.
- [ ] The card's failed count drops to zero after step 4.
- [ ] The completion message states 3 retried, 0 failed again.
- [ ] After step 5 the result reports the failures as failed again and the count stays at 2.
- [ ] The activity trail records both retries with the actor and window.

**Teardown:** Remove the webhook, delete the campaign, prune the telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring | Action plus small dialog on the Notifications card | Low | Only rendered when failures exist |
| Dashboard activity trail | Retry events recorded | Low | Reuses existing event rendering, no new filter |
| Campaign detail | No change | Low | The existing failure line already links to Monitoring |

**Verdict:** Fits an existing surface

This is a recovery action for a state that is already reported on Monitoring, so it belongs on that card and nowhere else. It renders only when there is something to fix, which means a healthy workspace never sees it at all.
