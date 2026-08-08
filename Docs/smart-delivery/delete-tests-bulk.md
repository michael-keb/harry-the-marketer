# Delete Tests in Bulk

| | |
|---|---|
| **Endpoint** | `POST https://smartdelivery.smartlead.ai/api/v1/spam-test/delete` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/delete-tests-bulk |
| **Auth** | API key (query param `api_key`) |

Deletes several deliverability tests in one request instead of removing them one at a time.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation gap.** The published page shows the request body as an empty object (`{}`) and documents only `api_key`; the page title and description are the only evidence that the body carries a list of test ids. The success shape is documented — `{"message": "Tests deleted successfully"}` — and there is no documented per-id result, so the story below treats the call as all-or-nothing and says so rather than inventing a partial-failure payload.

## 2. User story

**As a** mailbox owner with months of test history, **I want** to select several placement tests and delete them together, **so that** clearing out old runs takes one action rather than twenty.

**Acceptance criteria**
- [ ] Given several tests I own, when I delete them in bulk, then the API returns 200 `{"message": "Tests deleted successfully"}` and all selected tests disappear from the list.
- [ ] Given the response carries no per-id detail, when the call succeeds, then the client re-fetches the list and reports the actual count removed rather than claiming the count it asked for.
- [ ] Given one selected test id belongs to another workspace, when I delete, then the API returns 404 `{"error": "Resource not found"}` and the UI states that nothing was deleted rather than guessing which ids survived.
- [ ] Given an empty selection, when I press delete, then the action is disabled and no request is sent.
- [ ] Given a malformed body, when I submit, then the API returns 422 `{"error": "Invalid parameters provided"}` and the selection is preserved so nothing has to be re-picked.
- [ ] Given a test is currently running, when I include it, then the UI warns that a running test will be stopped and its partial report lost, and requires explicit confirmation.
- [ ] Given a bulk delete completes, when it finishes, then a single activity-trail entry records the actor and the number of tests removed, not one entry per test.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Select three completed tests and delete | 200 `{"message": "Tests deleted successfully"}`; the list re-fetches and shows three fewer rows |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again"; selection preserved, nothing deleted |
| TC-3 | Not found / wrong workspace | Include one id owned by another workspace | 404 `{"error": "Resource not found"}`; UI says "Nothing was deleted" and re-fetches so the true state is shown |
| TC-4 | Validation failure | Send the id list as a string rather than an array | 422 `{"error": "Invalid parameters provided"}`; field-level message; selection preserved |
| TC-5 | Rate limited | Fire ten bulk deletes back to back | 429 on the excess; client backs off with jitter; one "Retrying…" state |
| TC-6 | Empty result set | Delete every test in the workspace | 200; the list shows "No placement tests yet" with the run-a-test action, and any folder counts drop to zero |
| TC-7 | Empty selection | Press delete with nothing selected | Button is disabled; no request is made |
| TC-8 | Running test included | Select one active test alongside two finished ones | Confirmation names the running test and warns its report will be lost; on confirm, all three go and the schedule (if any) stops |
| TC-9 | Large selection | Select 500 tests | Client batches into capped chunks, shows one progress state, and reports the total removed after a final re-fetch |
| TC-10 | Repeat delete | Send the same bulk delete twice | Second call 404 or 200 with nothing removed; the UI treats it as already gone and shows no error |

## 4. Frontend user story

**As a** mailbox owner, **I want** multi-select and a bulk delete on the deliverability tests list, **so that** housekeeping is quick and obviously reversible-looking before it commits.

**Scope**
- Monitoring → Deliverability: row checkboxes with a select-all-on-page control, plus a toolbar that appears only when something is selected, showing "3 selected" and a Delete action.
- Confirm dialog names the count, calls out any running tests in the selection, and states that reports are removed with the test.
- Loading: toolbar shows a pending state and rows dim. Empty: "No placement tests yet". Error: banner above the list with the selection kept intact.
- Accessibility: checkboxes are real inputs with accessible names including the test name; the selection toolbar is announced in a live region; the dialog traps focus and Escape cancels. Responsive: the toolbar docks to the bottom of the viewport under 640px.

**Definition of done**
- [ ] The selection toolbar exists only while a selection exists — no permanently visible bulk bar.
- [ ] Confirmation names the count and flags running tests specifically.
- [ ] After the call the list is re-fetched and the reported count comes from the re-fetch, not from the request.
- [ ] Loading, empty, error and partial-failure-unknown states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that deletes a set of deliverability tests atomically, **so that** the client never has to guess which ones survived.

**Scope**
- Route in `server/routes.js`: `POST /api/deliverability/tests/delete` taking `{ testIds: [] }`, workspace-scoped like every destructive route.
- Data model: no new tables. Deletes the `deliverability_tests` rows and their cached report rows (blacklist, DKIM, SPF, rDNS, provider and sender breakdowns) in one transaction, so no orphan report data is left behind.
- Validation up front: every id must exist in the caller's workspace, else 404 and nothing is deleted. Ids are capped per request; the client chunks beyond the cap.
- Rate limiting: standard app limiter, plus a server-side chunk size so one enormous request cannot lock the table. Upstream 429 and 503 back off with jitter.
- Logged: one `events` row per bulk call with actor and count; `telemetry` records deletions of running tests separately, so an accidental-destruction pattern would be visible in Monitoring.

**Definition of done**
- [ ] Cross-workspace ids cause a 404 with zero rows deleted, covered by a test.
- [ ] Deleting a test removes every cached report row for it — asserted by a test counting the child tables.
- [ ] Deleting a running automated test also stops its schedule.
- [ ] One activity-trail entry per bulk call, with the count.

## 6. End-to-end test ticket

**Title:** E2E — Clear out old placement tests in one action

**Preconditions:** A workspace with five completed placement tests (two filed in a folder) and one running automated test.

**Flow**
1. Open Monitoring → Deliverability.
2. Select the three unfiled completed tests and delete them, confirming.
3. Select the folder, select its two tests plus the running one, and delete.
4. Read the confirmation carefully, confirm.
5. Return to "All tests".

**Assertions**
- [ ] The selection toolbar appears only after the first checkbox and reports "3 selected".
- [ ] After the first delete, the list shows three fewer rows and the folder count is unchanged.
- [ ] The second confirmation explicitly names the running test and warns its report will be lost.
- [ ] After the second delete, "All tests" is empty with the empty state shown, and the automated schedule no longer appears in the recurring-tests section.
- [ ] The activity trail contains exactly two entries, with counts of three and three.

**Teardown:** None needed — the workspace is left clean by the test itself.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability | Row checkboxes and a conditional selection toolbar | Medium | Toolbar appears only with a selection; checkboxes sit in the existing row, no new column header text |
| Confirm dialog | New destructive confirmation | Low | One sentence plus the running-test warning; two buttons |
| Activity trail | One entry per bulk delete | Low | Reuses the existing trail; count rather than a row per test |

**Verdict:** Fits an existing surface

Bulk delete is a list behaviour and belongs on the list, which is why the only lasting addition is a checkbox per row. The toolbar is invisible until it is relevant, so the default reading experience of the Deliverability list is unchanged. No new navigation item and no separate management screen.
