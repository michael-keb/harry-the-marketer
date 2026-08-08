# Update Lead List

| | |
|---|---|
| **Endpoint** | `PUT https://server.smartlead.ai/api/v1/lead-list/{id}` |
| **Category** | lead-lists |
| **Source** | https://api.smartlead.ai/api-reference/lead-lists/update |
| **Auth** | API key (query param `api_key`) |

Renames an existing saved lead group; nothing else about the group changes.

## 1. Epic

**Reusable lead segments**

Lets a Harry user keep a named, reusable group of prospects — "Australian SaaS running Jira", "Warm from the October webinar" — that outlives any one campaign and can be researched, scored, renamed and pushed at a campaign whenever it is needed. It matters because Harry's Leads page is one flat table today: every new campaign starts by re-finding the same people by hand, and there is nowhere to record that a particular set of thirty is the set worth chasing.

## 2. User story

**As a** campaign owner, **I want** to rename a segment in place, **so that** a group whose purpose has drifted can be relabelled without rebuilding it.

**Acceptance criteria**
- [ ] Given a segment id I own and a new `listName`, when I rename it, then a 200 returns `data.id` and `data.name` with the new value, and every place the old name appeared updates without a reload.
- [ ] Given the rename succeeds, when I check the segment, then its membership, labels, import history and `created_at` are unchanged and only `updated_at` moves.
- [ ] Given an empty or whitespace-only `listName`, when I submit, then a 422 names `listName` and the old name remains.
- [ ] Given a name already used by another segment in my workspace, when I submit, then I am told the name is taken and offered the existing segment, rather than ending up with two indistinguishable groups.
- [ ] Given the id does not exist or belongs to another workspace, when I submit, then a 404 is returned and nothing is renamed.
- [ ] Given I rename a segment that is currently filtering the Leads page, when the call returns, then the header and the filter chip both show the new name immediately.
- [ ] Given a rename happens, when I look at the activity trail, then one entry records both the old and the new name, so a shared workspace can see what changed.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `PUT /lead-list/500` with `{"listName":"Q1 2025 Enterprise Prospects - Updated"}` | 200 with `data: {id: 500, name: "Q1 2025 Enterprise Prospects - Updated"}` |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; the old name stays and the typed value is preserved |
| TC-3 | Not found / wrong workspace | Rename another workspace's segment id | 404; that segment's name is unchanged and not leaked in the error |
| TC-4 | Validation failure — empty name | PUT `{"listName":""}` | 422 with a field-level message on `listName`; the inline editor stays open |
| TC-5 | Rate limited | Fire 40 renames in quick succession | 429 on the excess; the client backs off and the final name matches the last intent |
| TC-6 | Empty result set | Rename the only segment, then filter segments by the old name | 200 with `data: []`; "No segments match this search" with a Clear button |
| TC-7 | Duplicate name | Rename 500 to a name already held by 501 | Refused with a message naming the existing segment and a link to open it |
| TC-8 | Whitespace trimming | PUT `{"listName":"  Warm leads  "}` | 200 and the stored name is "Warm leads" |
| TC-9 | Membership untouched | Rename a segment holding 1,250 leads, then refetch | `lead_count` is still 1,250 and the same lead ids are members |
| TC-10 | No-op rename | PUT the current name unchanged | 200 and no activity-trail entry, because nothing actually changed |
| TC-11 | Concurrent rename | Two team members rename the same segment at once | Last write wins, both see the final name after refresh, neither gets a server error |

## 4. Frontend user story

**As a** campaign owner, **I want** to rename a segment where I see it, **so that** correcting a name costs one click and one keystroke.

**Scope**
- Leads page → Segments panel: "Rename" in the per-segment overflow menu turns the name into an inline text input with Enter to save and Escape to cancel — no dialog for a single field.
- The same rename is available from the Leads page header when a segment is selected, since that is where the name is most visible.
- States: optimistic update with a revert if the call fails; a duplicate-name error renders inline beneath the input with a link to the conflicting segment; pending state disables Enter rather than showing a spinner over the whole panel.
- The new name propagates to the header, the filter chip, the campaign Attach-leads picker and any open dialog referencing it.
- Accessibility: the inline input receives focus on activation, is labelled "Segment name", and the result is announced via `aria-live="polite"`; Escape restores the previous value. Responsive: unchanged, the input takes the row width.

**Definition of done**
- [ ] Renaming never opens a modal.
- [ ] A failed rename visibly reverts to the old name.
- [ ] Duplicate names are caught inline with a link to the conflict.
- [ ] Every visible instance of the name updates without a reload.

## 5. Backend user story

**As a** Harry API, **I want** a route that renames a segment and nothing else, **so that** the operation is trivially safe and its blast radius is one column.

**Scope**
- Route in `server/routes.js`: `PUT /api/lead-lists/:id` taking `{ name }`, workspace-scoped, returning the updated `{ id, name, updatedAt }`.
- Data model: updates `lead_lists.name` and `updated_at` only. The unique index on `(workspace_id, lower(trim(name)))` enforces the duplicate rule at the database level; the violation is translated into a friendly response carrying the conflicting segment's id.
- Names are trimmed and length-capped server-side. A rename to the identical name is accepted as a no-op and does not bump `updated_at` or write an event.
- No pagination. Standard app rate limiting applies; the client retries 429 with backoff. Cross-workspace ids return 404 with an empty body.
- Logged: an `events` row with actor, segment id, old name and new name; `telemetry` records rename latency only.

**Definition of done**
- [ ] The route provably touches no table other than `lead_lists`.
- [ ] Duplicate names are impossible, case- and whitespace-insensitively.
- [ ] A no-op rename writes nothing.
- [ ] Tests cover the duplicate path, trimming, the no-op case and workspace isolation.

## 6. End-to-end test ticket

**Title:** E2E — Rename a segment and see the name follow it everywhere

**Preconditions:** A workspace with two segments, "Q1 2025 Enterprise Prospects" (1,250 leads, one label, one recorded import) and "SMB Tech Companies"; a campaign that was populated from the first.

**Flow**
1. Open Leads and select the first segment so it filters the table.
2. Rename it inline to "Q1 2025 Enterprise Prospects - Updated".
3. Check the header, the filter chip and the Segments panel.
4. Open Campaigns → the campaign → Attach leads → from a segment.
5. Attempt to rename it to "SMB Tech Companies".

**Assertions**
- [ ] The new name appears in all three places with no reload.
- [ ] Lead count stays at 1,250, the label is still attached, and the last-import line is unchanged.
- [ ] The segment picker in the campaign shows the new name.
- [ ] The duplicate attempt is refused inline with a link to "SMB Tech Companies".
- [ ] The activity trail has one entry showing the old and new names.

**Teardown:** Rename the segment back to its original name.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Segments panel | "Rename" in the existing overflow menu, editing in place | Low | One menu item, no dialog for one field |
| Leads header | The selected segment's name is editable in place | Low | Looks like static text until activated |
| Dashboard activity trail | Rename entry with old and new names | Low | One line per rename, and none for a no-op |

**Verdict:** Fits an existing surface

Renaming is the smallest write in this category and should look like it: inline editing on a name the user is already reading, with no modal in sight. The only decision worth stating is that a duplicate name is refused rather than allowed with a warning, because two segments with the same name make every later picker a guess.
