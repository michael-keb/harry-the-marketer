# Update Fetched Lead API

| | |
|---|---|
| **Endpoint** | `PUT https://prospect-api.smartlead.ai/api/v1/search-email-leads/search-filters/fetched-searches/{id}` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/update-fetched-lead |
| **Auth** | API key (query param `api_key`) |

Renames a fetched prospect list so it is easier to recognise later.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner with several fetched lists, **I want** to rename one, **so that** "Director in United States" becomes "Q3 ANZ ops leaders" and I can tell my lists apart at a glance.

**Acceptance criteria**
- [ ] Given a fetched list, when I rename it, then the request is a `PUT` to `/search-filters/fetched-searches/{id}` with a JSON body carrying `search_string`, which is required and 1–255 characters.
- [ ] Given `id` must match `^[1-9][0-9]*$`, when a zero or non-numeric id is supplied, then Harry rejects it before calling — note this pattern excludes zero, unlike the review endpoint's `^[0-9]+$`.
- [ ] Given only `search_string` is documented, when a rename is sent, then nothing else is included in the body; the filters of a fetched list cannot be edited through this endpoint and the UI must not suggest they can.
- [ ] Given a successful rename, when the response arrives, then it is only `{"success": true, "message": "Fetched lead updated successfully"}` — no id, no updated record — so Harry updates its own copy optimistically and re-lists to confirm.
- [ ] Given the documented **403 Forbidden**, when a user renames a list they do not own, then that is surfaced distinctly from a 404: "You do not have permission to rename this list" rather than "not found". This endpoint documents 403 while the update-saved-search endpoint does not, so the two error maps differ.
- [ ] Given the documented 404, when the id does not exist, then Harry shows "That fetched list is no longer available" and refreshes the history.
- [ ] Given a name is blank or longer than 255 characters, when the user tries to save, then Harry blocks it with a field-level message and does not call.
- [ ] Given a 401, when the request runs, then Harry shows one "Prospect search is not connected" message and the entered name is preserved.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | PUT `/fetched-searches/327107` with `{"search_string": "Directors and VPs in United States"}` | 200, `message` reads "Fetched lead updated successfully"; the history row shows the new name |
| TC-2 | Missing/invalid API key | Same call with no `api_key` | 401, `"error": "User not authenticated"`; the entered name is preserved for a retry |
| TC-3 | Not found / wrong workspace | PUT an id that does not exist | 404; "That fetched list is no longer available"; history refreshes |
| TC-4 | Validation failure — blank name | PUT `{"search_string": ""}` | 400; Harry blocks it first with a field-level message, since the minimum length is 1 |
| TC-5 | Rate limited | Rename several lists in a burst | 429 on the excess; Harry retries once with backoff and the optimistic name reverts if it ultimately fails |
| TC-6 | Empty result set | Rename a fetched list whose contacts are all gone | The rename still succeeds — a name is metadata, independent of contents |
| TC-7 | Forbidden versus not found | PUT a list belonging to a teammate's account | 403 is surfaced as a permission message, provably distinct from the 404 wording |
| TC-8 | Length ceiling | PUT a 256-character name | Blocked client-side with the 255-character limit stated and a live character counter |
| TC-9 | Id pattern excludes zero | PUT `/fetched-searches/0` | Rejected against `^[1-9][0-9]*$` before any call |
| TC-10 | Optimistic update reverted | Force a 500 after the UI has shown the new name | The row reverts to the old name with an explanation, not a silent rollback |
| TC-11 | Filters unchanged | Rename, then reopen the list | `filter_details` and the fetch metrics are untouched; only the name moved |
| TC-12 | Concurrent rename | Rename the same list from two sessions | Last write wins at the provider; Harry re-lists after each rename so both sessions converge on the stored name |

## 4. Frontend user story

**As a** goal owner, **I want** to rename a fetched list inline in the history, **so that** tidying up my lists takes a second and never opens a form.

**Scope**
- Leads → "Find prospects" → History: an inline rename on each row — click the name, edit in place, Enter to save, Escape to cancel — with a live character counter approaching 255.
- The name updates optimistically and reverts with an explanation if the call fails. A 403 shows a permission message distinct from a 404's "no longer available".
- The row's filters and metrics are visibly read-only during rename, so nobody expects editing the name to change what the list contains.
- Harry's own record of the fetch is renamed at the same time, so the name shown against leads created from that fetch stays consistent.
- State: saving shows a small inline spinner on the row only; errors appear inline on the row rather than as a page banner.
- Accessibility: the inline editor is a labelled text input with the current name as its value, Escape cancels, the character counter is announced near the limit, and success and failure are announced in a live region. Responsive: on narrow screens the row expands to give the input full width.

**Definition of done**
- [ ] Inline rename works with keyboard only, including cancel.
- [ ] Optimistic update reverts visibly with an explanation on failure.
- [ ] 403 and 404 produce different, accurate messages.
- [ ] The 255-character limit is enforced with a counter before the call.
- [ ] Loading, error, permission-denied and reverted states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a rename route that validates the id and length and keeps Harry's own record in step, **so that** a list's name means the same thing in both systems.

**Scope**
- Route in `server/routes.js`: `PUT /api/prospects/fetches/:id/name` taking `{ name }`, validating `id` against `^[1-9][0-9]*$` and `name` at 1–255 characters before any upstream call, and confirming the workspace owns the fetch record.
- Error map: 403 maps to a permission error and 404 to a not-found error, kept distinct because this endpoint documents both — a note records that the sibling update-saved-search endpoint documents only 404, so the two maps must not be shared blindly.
- After a successful rename, the local `prospect_fetches` row's name is updated in the same transaction as the response is accepted, and the fetch-history cache is invalidated so the next read is correct.
- Because the response returns no updated record, the route re-lists fetched searches on the next read rather than trusting its own optimistic value indefinitely.
- Data model: `prospect_fetches` gains a `name` column; no new table.
- Rate limiting and retry: 429 and 5xx retried once with backoff; 403 and 404 never retried.
- Logged: an `events` row per rename with the old and new names and who made the change, so a renamed list can still be traced to the leads it produced; `telemetry` per upstream call with latency and status.

**Definition of done**
- [ ] Route added, workspace-scoped, id and length validated before any upstream call.
- [ ] 403 and 404 map to distinct client errors, covered by tests.
- [ ] The local name and the fetch-history cache stay consistent after a rename.
- [ ] Old and new names appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Rename a fetched prospect list

**Preconditions:** A stubbed provider implementing the rename and the fetched-searches listing, one fetched list that produced 12 Harry leads, and stub modes for 403, 404 and 500.

**Flow**
1. Open Leads → "Find prospects" → History.
2. Click the list's name and rename it inline.
3. Confirm the new name appears immediately and persists after a refresh.
4. Open the leads created by that fetch and check the source label.
5. Attempt a 256-character name.
6. Repeat the rename against the 403, 404 and 500 stub modes.

**Assertions**
- [ ] The rename saves with Enter and cancels with Escape, keyboard only.
- [ ] The new name survives a page refresh, proving the provider and the local record agree.
- [ ] Leads created by that fetch show the new source name.
- [ ] The 256-character attempt is blocked before any request, with a counter shown.
- [ ] The 403 run shows a permission message; the 404 run shows "no longer available" and refreshes history; the two messages differ.
- [ ] The 500 run reverts the optimistic name with an explanation on the row.
- [ ] The activity trail records the old and new names.

**Teardown:** Restore the original name; clear the fetch-history cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects → History | Inline rename on each row | Low | No new control appears until the name is clicked; there is no edit dialog and no extra button |
| Leads list | Source label follows the new name | Low | One label already exists; only its text changes |
| Dashboard activity trail | An entry per rename | Low | Existing trail |

**Verdict:** Fits an existing surface

Renaming is housekeeping on a row that already exists, so it belongs in that row and nowhere else. The only judgement call is keeping the 403 and 404 messages distinct, because "you cannot do that" and "it is gone" send a user to two very different next steps.
