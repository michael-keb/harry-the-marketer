# Update Saved Search API

| | |
|---|---|
| **Endpoint** | `PUT https://prospect-api.smartlead.ai/api/v1/search-email-leads/search-filters/save-search/{id}` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/update-saved-search |
| **Auth** | API key (query param `api_key`) |

Renames a saved prospect search.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner whose saved audiences are shared with teammates, **I want** to rename a saved search, **so that** its name says which goal it serves rather than repeating its filters back at me.

**Acceptance criteria**
- [ ] Given a saved search, when I rename it, then the request is a `PUT` to `/search-filters/save-search/{id}` with a JSON body carrying `search_string`, required and 1–255 characters.
- [ ] Given `id` must match `^[1-9][0-9]*$`, when a zero or non-numeric id is supplied, then Harry rejects it before calling.
- [ ] Given only `search_string` is documented in the body, when a rename is sent, then no filter fields are included — **this endpoint cannot change a saved search's criteria despite sharing a path with save-search.** Editing filters means saving a new search, and the UI must say so plainly rather than implying an edit that silently does nothing.
- [ ] Given a successful rename, when the response arrives, then it is only `{"success": true, "message": "Saved search updated successfully"}` — no id and no updated record — so Harry updates optimistically and confirms on the next listing.
- [ ] Given the documented response codes are 200, 400, 401, 404 and 500, when a permission problem occurs, then there is **no documented 403** here, unlike the fetched-lead rename; Harry maps whatever it receives faithfully and does not invent a permission message the API never sends.
- [ ] Given a 404, when the id does not exist or is not the caller's, then Harry shows "That saved search is no longer available" and refreshes the saved list.
- [ ] Given a saved search is linked to a Harry goal, when it is renamed, then the goal's "Refine the audience" panel shows the new name without a reload of that page's data being required later.
- [ ] Given a blank or over-length name, when the user tries to save, then Harry blocks it with a field-level message and does not call.
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message and the entered name is preserved.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | PUT `/save-search/327105` with `{"search_string": "Directors and VPs in United States"}` | 200, `message` reads "Saved search updated successfully"; the saved row shows the new name |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; the entered name is preserved |
| TC-3 | Not found / wrong workspace | PUT an id belonging to another account | 404; "That saved search is no longer available"; the saved list refreshes |
| TC-4 | Validation failure — blank name | PUT `{"search_string": ""}` | 400; Harry blocks it first with a field-level message |
| TC-5 | Rate limited | Rename several saved searches in a burst | 429 on the excess; one retry with backoff, and the optimistic name reverts if it ultimately fails |
| TC-6 | Empty result set | Rename a saved search whose filters now match nobody | The rename succeeds — a name is independent of what the filters match |
| TC-7 | Filters cannot be edited here | Attempt to include `title` in the body | Harry never sends it; a test asserts the outgoing body carries only `search_string` |
| TC-8 | No documented 403 | Compare this error map with the fetched-lead rename's | This map has no permission branch; a shared error map between the two endpoints would be wrong and a test guards it |
| TC-9 | Length ceiling | PUT a 256-character name | Blocked client-side with the 255-character limit stated and a live counter |
| TC-10 | Id pattern excludes zero | PUT `/save-search/0` | Rejected against `^[1-9][0-9]*$` before any call |
| TC-11 | Linked goal follows the name | Rename a saved search linked to a goal, then open the goal | The goal shows the new name without needing a manual refresh |
| TC-12 | Optimistic update reverted | Force a 500 after the UI has shown the new name | The row reverts with a visible explanation |
| TC-13 | Concurrent rename | Rename the same search from two sessions | Last write wins at the provider; both sessions converge after the next listing |

## 4. Frontend user story

**As a** goal owner, **I want** to rename a saved audience in place and be told plainly that its filters cannot be edited here, **so that** I never think I changed a search when I only changed its label.

**Scope**
- Leads → "Find prospects" → Saved: an inline rename on each row — click the name, edit in place, Enter to save, Escape to cancel — with a character counter approaching 255.
- Beside the rename, a "Change the filters" action that loads the search into the form and, on save, creates a **new** saved search, with a one-line explanation that filters cannot be edited in place. This is the honest treatment of an API that only renames.
- Renaming updates the row optimistically and reverts with a visible explanation on failure. The error map has no permission branch, because the API documents none.
- Goals → goal detail: the linked saved search's name updates in step, so the two surfaces never disagree.
- State: an inline spinner on the row while saving; errors inline on the row; the filters and dates on the row are visibly read-only during rename.
- Accessibility: labelled inline input, Escape cancels, counter announced near the limit, outcome announced in a live region, the "filters cannot be edited here" note associated with the rename control rather than floating loose. Responsive: the row expands to give the input full width on narrow screens.

**Definition of done**
- [ ] Inline rename works keyboard-only including cancel.
- [ ] The "Change the filters" path is clearly a save-as-new, explained in one line.
- [ ] Optimistic update reverts visibly on failure.
- [ ] The 255-character limit is enforced with a counter before the call.
- [ ] Loading, error and reverted states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a rename route with its own error map and consistent local state, **so that** a saved audience's name is the same in Harry, at the provider, and on the goal it serves.

**Scope**
- Route in `server/routes.js`: `PUT /api/prospects/searches/:id/name` taking `{ name }`, validating `id` against `^[1-9][0-9]*$` and `name` at 1–255 characters, and confirming the workspace owns the local `prospect_searches` row before any upstream call.
- The outgoing body carries only `search_string`; a test asserts no filter field is ever included, since sending one would be silently ignored and would mislead the next reader of the code.
- Error map is defined separately from the fetched-lead rename's, because this endpoint documents no 403; a comment records the difference so the two are not merged later.
- After a successful rename, the local `prospect_searches.name` is updated and the saved-search cache is invalidated, so the goal page and the saved list both read the new name on their next fetch.
- Because the response returns no record, the next listing is the confirmation; an optimistic value is never trusted indefinitely.
- Data model: no migration beyond the `name` column already on `prospect_searches` from the save work.
- Rate limiting and retry: 429 and 5xx retried once with backoff; 404 never retried.
- Logged: an `events` row per rename with old and new names, who changed it and the linked goal; `telemetry` per upstream call with latency and status.

**Definition of done**
- [ ] Route added, workspace-scoped, id and length validated before any upstream call.
- [ ] The outgoing body provably contains only `search_string`.
- [ ] This endpoint's error map is separate from the fetched-lead rename's and has no permission branch.
- [ ] Renaming invalidates the caches feeding both the saved list and the goal page.

## 6. End-to-end test ticket

**Title:** E2E — Rename a saved audience and keep its goal in step

**Preconditions:** A stubbed provider implementing rename and the saved-searches listing, one saved search linked to a goal, and stub modes for 404 and 500.

**Flow**
1. Open Leads → "Find prospects" → Saved.
2. Rename the linked saved search inline.
3. Open the linked goal and check the name in "Refine the audience".
4. Return and use "Change the filters" to alter one filter and save.
5. Attempt a 256-character rename.
6. Repeat the rename against the 404 and 500 stub modes.

**Assertions**
- [ ] The rename saves with Enter and cancels with Escape, keyboard only.
- [ ] The goal page shows the new name without a manual refresh.
- [ ] "Change the filters" creates a second saved search rather than modifying the first, and says so before saving.
- [ ] The 256-character attempt is blocked before any request, with a counter shown.
- [ ] The 404 run shows "no longer available" and refreshes the saved list; no permission message is ever shown, because the API documents none.
- [ ] The 500 run reverts the optimistic name with an explanation.
- [ ] The activity trail records the old and new names and the linked goal.

**Teardown:** Restore the original name; delete the search created by the save-as-new step; clear the saved-search cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects → Saved | Inline rename plus a "Change the filters" save-as-new action | Medium | Rename introduces no visible control until the name is clicked; the save-as-new action is one link with one line of explanation, which is cheaper than letting users discover the limitation by being confused |
| Goals → goal detail | The linked search's name follows the rename | Low | Existing line of text |
| Dashboard activity trail | An entry per rename | Low | Existing trail |

**Verdict:** Fits an existing surface

Renaming belongs on the row it renames. The design work here is not the rename itself but the sentence next to it: the API can change a saved search's name and nothing else, and a user who expects to edit filters in place needs to be told before they try, not after.
