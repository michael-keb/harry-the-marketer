# Assign Tags to Lead Lists

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/lead-list/assign-tags` |
| **Category** | lead-lists |
| **Source** | https://api.smartlead.ai/api-reference/lead-lists/assign-tags |
| **Auth** | API key (query param `api_key`) |

Adds or removes labels on up to ten saved lead lists in a single call, so groups of lists can be organised together.

## 1. Epic

**Reusable lead segments**

Lets a Harry user keep a named, reusable group of prospects — "Australian SaaS running Jira", "Warm from the October webinar" — that outlives any one campaign and can be researched, scored, renamed and pushed at a campaign whenever it is needed. It matters because Harry's Leads page is one flat table today: every new campaign starts by re-finding the same people by hand, and there is nowhere to record that a particular set of thirty is the set worth chasing.

## 2. User story

**As a** campaign owner, **I want** to label several of my saved lead segments at once, **so that** I can group them by source, quarter or region without renaming each one.

**Acceptance criteria**
- [ ] Given `listIds` of one to ten existing segments and `tagIds` of one to ten existing labels, when I assign, then every list-label pair is created and the response is `{ "ok": true, "message": "Tags updated successfully" }`.
- [ ] Given `removeTagIds` alongside `tagIds` in the same request, when I submit, then removals and additions are applied in one transaction — a label in both arrays ends up removed, and the request is never left half-applied.
- [ ] Given a `listIds` array with 11 entries, or an empty array, when I submit, then the request is rejected with a 422 naming `listIds` and stating the 1-10 range; nothing is changed.
- [ ] Given a label that is already on a list, when I assign it again, then the call still returns 200 and the list has that label exactly once — repeating the call is safe.
- [ ] Given a list id or label id that belongs to another workspace or does not exist, when I submit, then a 404 is returned identifying which id was rejected, and no pair in the request is written.
- [ ] Given the assignment succeeds, when I open the segments view, then the labels appear on every affected list immediately, and one activity-trail entry records who changed which lists.
- [ ] Given only `removeTagIds` and no `tagIds`, when I submit, then the request is rejected as invalid, because `tagIds` is required — bulk removal is a separate, explicit action.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"listIds":[500,501],"tagIds":[1,2]}` | 200, `{"ok":true,"message":"Tags updated successfully"}`; both lists show both labels |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no credentials | 401, `{"message":"Invalid API Key"}`; UI shows a re-authentication prompt and keeps the selection |
| TC-3 | Not found / wrong workspace | POST with a `listIds` entry owned by another workspace | 404; no labels written to any list in the batch |
| TC-4 | Validation failure — too many lists | POST `listIds` with 11 ids | 422 with a field-level message on `listIds` citing the 1-10 limit |
| TC-5 | Rate limited | Fire 30 assign calls back to back | 429 on the excess; the client backs off and retries, final label state matches the last intended state |
| TC-6 | Empty result set | Open the segments view filtered by a label nothing carries | 200 with an empty list; "No segments carry this label yet" empty state |
| TC-7 | Add and remove in one call | POST `{"listIds":[500],"tagIds":[1,2],"removeTagIds":[3]}` | 200; list 500 gains labels 1 and 2 and loses 3 in a single write |
| TC-8 | Same id in `tagIds` and `removeTagIds` | POST `{"listIds":[500],"tagIds":[1],"removeTagIds":[1]}` | 200; removal wins, list 500 does not carry label 1, and the UI states which rule applied |
| TC-9 | Idempotency | Run TC-1 twice | Second call returns 200 and creates no duplicate pairs |
| TC-10 | Malformed body | POST `{"listIds":"500","tagIds":[1]}` | 400 for the malformed body; message names `listIds` as needing an array |
| TC-11 | Partial invalid ids | POST `{"listIds":[500,999999],"tagIds":[1]}` where 999999 does not exist | 404 and list 500 is unchanged — the batch is all-or-nothing |

## 4. Frontend user story

**As a** campaign owner, **I want** to select several segments and apply or strip labels in one go, **so that** tidying up my segments takes one action rather than one per list.

**Scope**
- Leads page → the "Segments" panel: checkbox multi-select on segment rows, with a "Labels" action that appears only once at least one row is ticked, matching how the Leads table already reveals bulk actions.
- The action opens a small popover listing existing labels with three states per label — on all selected, on some, on none — so ticking adds (`tagIds`) and unticking removes (`removeTagIds`) in one submit.
- States: loading disables the popover and shows a spinner on the affected rows; empty shows "No labels yet" with a link to create one; error keeps the popover open with the server message and the selection intact.
- Selection is capped at ten segments, with the cap explained in place ("Up to 10 segments at a time") rather than only failing on submit.
- Accessibility: the popover is a listbox with `aria-multiselectable`, mixed states use `aria-checked="mixed"`, and the result is announced via `aria-live="polite"`. Labels never carry meaning by colour alone — the name is always shown. Responsive: the popover becomes a full-width sheet under 640px.

**Definition of done**
- [ ] Adding and removing in the same interaction produces exactly one request.
- [ ] The ten-segment cap is enforced in the UI before submission.
- [ ] A failed call leaves the previous labels visible, never a half-updated view.
- [ ] Mixed-state labels are distinguishable without colour.

## 5. Backend user story

**As a** Harry API, **I want** one route that applies label additions and removals to a set of segments transactionally, **so that** bulk organisation is atomic and safe to retry.

**Scope**
- Route in `server/routes.js`: `POST /api/lead-lists/assign-tags` taking `{ listIds, tagIds, removeTagIds }`, workspace-scoped from the session like the other handlers there.
- Data model: a `lead_list_tags` join table in `server/db.js` with a unique constraint on `(list_id, tag_id)` so repeat assignment is a no-op; both `list_id` and `tag_id` are validated as belonging to the caller's workspace before any write.
- Validation mirrors the source API: `listIds` and `tagIds` required, each 1-10 entries; `removeTagIds` optional, same range. Removals are applied before additions so an id present in both ends up removed, and the whole set runs in one SQLite transaction.
- Standard app rate limiting applies; the client retries 429 with backoff. No pagination — the request is bounded at ten by ten.
- Logged: one `events` row per call recording actor, the affected list ids, and the labels added and removed; `telemetry` records call duration so Monitoring can see bulk-edit cost.

**Definition of done**
- [ ] All-or-nothing: any invalid id aborts the whole request with nothing written.
- [ ] Repeating an identical request changes nothing and still returns 200.
- [ ] Cross-workspace list or label ids return 404, never a leaked name.
- [ ] Tests cover the 1-10 bounds, the add-and-remove-in-one-call ordering rule, and the collision case.

## 6. End-to-end test ticket

**Title:** E2E — Label several segments at once and filter by the label

**Preconditions:** A workspace with four saved segments and three labels ("Q1", "Enterprise", "Stale"), where two segments already carry "Stale".

**Flow**
1. Open Leads → Segments.
2. Tick three segments, including both that carry "Stale".
3. Open Labels, tick "Q1" and "Enterprise", untick the mixed-state "Stale".
4. Apply.
5. Filter the segment list by "Q1".

**Assertions**
- [ ] All three selected segments show "Q1" and "Enterprise" and none shows "Stale".
- [ ] The fourth, unselected segment is unchanged.
- [ ] The filter by "Q1" returns exactly the three segments.
- [ ] The activity trail shows one entry naming the actor and the three segments, not three entries.
- [ ] Repeating the identical action changes nothing and shows no error.

**Teardown:** Remove the labels from the three segments and delete the "Q1" label.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Segments panel | Multi-select plus a "Labels" bulk action | Low | The action only appears once a row is ticked, exactly as bulk actions already behave on the Leads table |
| Label popover | Three-state checkboxes for mixed selections | Medium | One popover, no wizard; the mixed state is explained in a single line of helper text |
| Dashboard activity trail | One entry per bulk label change | Low | Summarised per call, not per list |

**Verdict:** Fits an existing surface

Labelling segments is bulk editing of something the user is already looking at, so it belongs on the Segments panel of the Leads page rather than anywhere new. No navigation item is added, and the only genuinely novel element is the three-state checkbox, which earns its place because without it a bulk edit would silently strip labels from lists that had them.
