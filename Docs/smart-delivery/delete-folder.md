# Delete Folder

| | |
|---|---|
| **Endpoint** | `DELETE https://smartdelivery.smartlead.ai/api/v1/spam-test/folder/{folderId}` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/delete-folder |
| **Auth** | API key (query param `api_key`) |

Removes an empty folder that was used to group deliverability tests.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner, **I want** to delete a deliverability-test folder I no longer use, **so that** the folder list stays short without me losing any test results.

**Acceptance criteria**
- [ ] Given an empty folder I own, when I delete it by `folderId`, then the API returns 200 `{"message": "Folder deleted successfully"}` and the folder disappears from the list.
- [ ] Given a folder that still contains tests, when I try to delete it, then deletion is refused with a message naming how many tests are inside and offering to unfile them first — the documented behaviour is that only an empty folder can be deleted.
- [ ] Given I confirm unfiling, when the folder is deleted, then its tests remain and appear under "All tests" — deleting a folder never deletes a test result.
- [ ] Given a `folderId` that does not exist or belongs to another workspace, when I delete it, then the API returns 404 `{"error": "Resource not found"}` and nothing changes.
- [ ] Given a malformed `folderId`, when I delete it, then the API returns 422 `{"error": "Invalid parameters provided"}`.
- [ ] Given the folder was the current filter, when it is deleted, then the list falls back to "All tests" rather than showing an empty view of a folder that no longer exists.
- [ ] Given a folder is deleted, when it completes, then an activity-trail entry records who deleted it and its name.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, empty folder | DELETE an empty folder's `folderId` | 200 `{"message": "Folder deleted successfully"}`; the folder leaves the sidebar without a page reload |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again"; folder still present |
| TC-3 | Not found / wrong workspace | DELETE a `folderId` created in another workspace | 404 `{"error": "Resource not found"}`; UI shows "That folder is not available"; list refreshes |
| TC-4 | Validation failure | DELETE with a `folderId` that is not a valid identifier | 422 `{"error": "Invalid parameters provided"}`; no request retried |
| TC-5 | Rate limited | Delete twenty folders in a burst | 429 on the excess; client backs off with jitter; one "Retrying…" state |
| TC-6 | Empty result set | Delete the last remaining folder | 200; sidebar shows "No folders yet" with the inline create field, and the list falls back to "All tests" |
| TC-7 | Non-empty folder | DELETE a folder containing three tests | Refused with "3 tests are filed here"; the confirm dialog offers "Unfile and delete"; nothing removed on cancel |
| TC-8 | Unfile then delete | Choose "Unfile and delete" on TC-7 | The three tests move to unfiled, then 200 on the delete; all three are still visible under "All tests" |
| TC-9 | Delete while filtered to it | Select the folder, then delete it | The list switches to "All tests" and the URL filter is cleared, no dead filter chip left behind |
| TC-10 | Double delete | Send the same DELETE twice | Second call 404; the UI treats it as already gone and does not surface an error to the user |

## 4. Frontend user story

**As a** mailbox owner, **I want** to delete a folder from the same place I created it, **so that** tidying up never becomes a separate task.

**Scope**
- Monitoring → Deliverability: each folder in the sidebar has a delete action revealed on hover and focus; a confirm dialog states the folder name and, when it is not empty, the number of tests inside plus an "Unfile and delete" choice.
- The confirm dialog spells out that test results are kept, so nobody hesitates over losing data.
- Loading: the row shows a pending state. Error: an inline message on the row keeping the folder visible. After delete: the list falls back to "All tests".
- Accessibility: the delete action is a real button with an accessible name including the folder name (not a bare icon); the confirm dialog traps focus and Escape cancels; the result is announced in a live region. Responsive: on the mobile select layout the delete action moves into the folder detail row.

**Definition of done**
- [ ] Deletion is confirmed, never one-click, and the confirmation names the folder.
- [ ] A non-empty folder cannot be deleted without an explicit unfile choice.
- [ ] After deletion the current filter resets to "All tests" and no stale chip remains.
- [ ] Loading, error, empty-sidebar and already-deleted states are all designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that deletes a deliverability-test folder without touching its tests, **so that** filing is reversible and results are never lost.

**Scope**
- Route in `server/routes.js`: `DELETE /api/deliverability/folders/:folderId`, workspace-scoped like every other destructive route.
- Data model: no new tables. Deleting sets `folder_id` to null on any `deliverability_tests` rows still pointing at it, inside one transaction, and only when the caller passed the explicit unfile flag; otherwise the route refuses with a conflict listing the count.
- No pagination. The standard app rate limiter applies; upstream 429 and 503 back off with jitter, and a repeat delete that returns 404 is treated as success by the client.
- Logged: an `events` row with actor, folder name and how many tests were unfiled; `telemetry` records refused deletions so a confusing empty-only rule can be measured rather than guessed at.

**Definition of done**
- [ ] Route returns 404 for another workspace's folder, covered by a test.
- [ ] Deleting a folder never deletes a test row — asserted by a test that counts tests before and after.
- [ ] Refusal on a non-empty folder returns the count so the UI can name it.
- [ ] Deletion appears in the activity trail with the number of tests unfiled.

## 6. End-to-end test ticket

**Title:** E2E — Delete a deliverability folder without losing its tests

**Preconditions:** A workspace with two folders — one empty, one holding two completed placement tests — and one unfiled test.

**Flow**
1. Open Monitoring → Deliverability.
2. Delete the empty folder and confirm.
3. Select the non-empty folder and attempt to delete it.
4. Choose "Unfile and delete" and confirm.
5. Select "All tests".

**Assertions**
- [ ] The empty folder is removed after one confirmation and the sidebar updates without a reload.
- [ ] The non-empty folder's first confirmation names two tests and offers the unfile choice.
- [ ] After unfiling, both tests are still listed under "All tests", alongside the originally unfiled one — three in total.
- [ ] The view is filtered to "All tests" with no stale folder chip.
- [ ] The activity trail shows both deletions, the second noting two tests unfiled.

**Teardown:** Remove the three test fixtures; no folders remain.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability | Delete action per folder plus a confirm dialog | Low | Action is revealed on hover and focus rather than always visible; the dialog is one sentence and two buttons |
| Activity trail | Folder deleted entries | Low | Reuses the existing trail |

**Verdict:** Fits an existing surface

Delete belongs exactly where the folder is listed, and the only real design work is making the confirmation say plainly that test results survive. Nothing is added to navigation, and a user who never makes a folder never sees any of it.
