# Remove Tag from Lead

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/crm/leads/tags/{id}` |
| **Category** | lead-tags |
| **Source** | https://api.smartlead.ai/api-reference/lead-tags/remove-from-lead |
| **Auth** | API key (query param `api_key`) |

Takes one label off one person, using the id of the link between them rather than the id of the label itself.

## 1. Epic

**Lead labels across campaigns**

Gives every lead a small set of named, coloured labels the user defines — "VIP", "Enterprise", "Met at a conference" — that cut across campaigns and stages, can be applied in bulk, and can be filtered on anywhere leads are listed. It matters because Harry's stage strip answers "where is this person in the funnel" but nothing answers "why do I care about this person", which is the question that decides who gets chased first.

## 2. User story

**As a** campaign owner, **I want** to take a label off a lead in one click, **so that** a mark that is no longer true stops misleading me and my teammates.

**Acceptance criteria**
- [ ] Given a `tagMappingId` such as 789 taken from the lead's label list, when I remove it, then a 200 returns `{ "ok": true, "message": "Tag removed from lead successfully" }` and the chip disappears from the lead.
- [ ] Given the path parameter is the mapping id and not the tag id, when the UI calls it, then it passes the `tag_mapping_id` from the lead's label response; passing the tag id must be caught in review and covered by a test, because both are plausible-looking numbers.
- [ ] Given the label is removed from one lead, when I check other leads carrying the same label, then they are unaffected and the label itself still exists in the picker.
- [ ] Given a mapping id that does not exist or belongs to another workspace's lead, when I remove it, then a 404 is returned and nothing is removed anywhere.
- [ ] Given I remove the same mapping twice, when the second call runs, then it returns 404 and the UI treats it as already-removed rather than showing an error.
- [ ] Given I am filtering the Leads table by that label, when I remove it from a lead, then that row leaves the filtered view with a brief undo affordance rather than vanishing without explanation.
- [ ] Given the removal succeeds, when I look at the activity trail, then one entry records who removed which label from which lead.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `DELETE /crm/leads/tags/789` where 789 is a valid mapping | 200, `{"ok":true,"message":"Tag removed from lead successfully"}`; chip gone from that lead |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; the chip stays and the optimistic removal is reverted |
| TC-3 | Not found / wrong workspace | Delete a mapping belonging to another workspace's lead | 404; that lead keeps its label and no name is leaked |
| TC-4 | Validation failure | `DELETE /crm/leads/tags/abc` | 422 stating the id must be a number |
| TC-5 | Rate limited | Remove labels from 100 leads in rapid succession | 429 on the excess; the client backs off and retries, every intended chip ends up removed |
| TC-6 | Empty result set | Remove the lead's only label, then view the detail | 200; no chip row rendered at all, not an empty box |
| TC-7 | Tag id passed instead of mapping id | `DELETE /crm/leads/tags/1` where 1 is a tag id, not a mapping id | 404 rather than a silent wrong deletion; a regression test asserts this specific confusion |
| TC-8 | Repeat removal | Run TC-1 twice | Second call returns 404 and the UI shows no red error |
| TC-9 | Label survives | Remove the last mapping for a label | 200; the label still exists in the picker with a count of 0 |
| TC-10 | Other leads unaffected | Remove "VIP" from one of 8 leads carrying it | The other 7 keep it and the label filter now returns 7 |
| TC-11 | Removal while filtered | With the label filter active, remove it from a visible row | The row leaves the filtered view with an undo affordance for a few seconds |

## 4. Frontend user story

**As a** campaign owner, **I want** each chip to carry its own remove control, **so that** correcting a label is a single click where I see the mistake.

**Scope**
- Leads page → lead detail: each chip in the labels row has a small remove control, wired to that chip's `tag_mapping_id` rather than its tag id.
- Leads table bulk action bar: unticking a label in the three-state picker removes it from every selected lead that had it, issuing one removal per mapping and reporting the total.
- States: optimistic chip removal with revert and an inline message if the call fails; a 404 is treated as already-removed with a quiet note; when the removal changes which rows match an active label filter, an undo affordance appears for a few seconds before the row leaves.
- Removal is not gated behind a confirmation dialog — it is one label on one lead and trivially reapplied — but the undo affordance covers the mis-click.
- Accessibility: the remove control has an explicit accessible name ("Remove label VIP from Priya Sharma"), is keyboard reachable, and the outcome is announced via `aria-live="polite"`. Responsive: the control stays at least 44px of touch target under 640px.

**Definition of done**
- [ ] Every removal call uses the mapping id, never the tag id.
- [ ] A failed removal visibly restores the chip.
- [ ] Removing a label never deletes the label itself.
- [ ] Mis-clicks are recoverable by undo rather than prevented by a dialog.

## 5. Backend user story

**As a** Harry API, **I want** a route that deletes one lead-to-label mapping and nothing else, **so that** unlabelling is trivially safe and cannot cascade into deleting a label a whole workspace uses.

**Scope**
- Route in `server/routes.js`: `DELETE /api/leads/tags/:mappingId`, workspace-scoped from the session, plus a bulk sibling `DELETE /api/leads/tags` taking `{ leadIds, tagIds }` so the three-state picker can strip a label from many leads in one transaction.
- Data model: deletes one `lead_tags` row by primary key after verifying its `lead_id` belongs to the caller's workspace. The `tags` and `leads` tables are never written to by this route — enforced by a test, not just convention.
- The route deliberately keys on the mapping id rather than the pair `(leadId, tagId)`, matching the source API's `tag_mapping_id`, and the parameter is named `mappingId` in code so the confusion with `tagId` is visible at every call site.
- No pagination. Standard rate limiting; the client retries 429 with backoff. A missing row returns 404 rather than 500 or a silent 200.
- Logged: an `events` row (actor, lead id, label id and name) — one row per bulk call rather than one per lead; `telemetry` records removal volume, which alongside the tagging volume shows whether a label is churning and probably badly named.

**Definition of done**
- [ ] Removing a mapping provably leaves the `tags` row and every other lead's mapping intact.
- [ ] Cross-workspace mapping ids return 404 with an empty body.
- [ ] The parameter is named `mappingId` throughout, and a test asserts that passing a tag id yields 404.
- [ ] Tests cover the single and bulk paths, the repeat-removal 404, and the label-survives case.

## 6. End-to-end test ticket

**Title:** E2E — Remove a label from a lead without disturbing the label or other leads

**Preconditions:** A workspace with labels "VIP" and "Enterprise", 8 leads carrying "VIP", one of which also carries "Enterprise"; the Leads table filtered by "VIP".

**Flow**
1. Open Leads with the "VIP" filter active.
2. Open the lead carrying both labels.
3. Remove "VIP" from its chip.
4. Return to the filtered table.
5. Tick 4 of the remaining rows and untick "VIP" in the bulk picker.
6. Open Settings → Labels.

**Assertions**
- [ ] The chip disappears immediately and the lead still shows "Enterprise".
- [ ] The filtered table drops from 8 rows to 7, with an undo affordance shown briefly.
- [ ] After the bulk removal the filter returns 3 rows.
- [ ] The "VIP" label still exists in Settings with a count of 3.
- [ ] Re-issuing the same removal returns 404 and shows no red error.
- [ ] The activity trail shows one entry for the single removal and one for the bulk removal.

**Teardown:** Reapply "VIP" to the five leads it was removed from.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → lead detail | A remove control on each chip | Low | Part of the chip itself; nothing new appears on the page |
| Leads bulk action bar | Unticking in the three-state picker removes in bulk | Low | The picker already exists for adding; removal is the same control in reverse |
| Leads table | Undo affordance when a removal changes the active filter | Medium | A single transient bar, not a dialog, and only shown when a row would otherwise vanish unexplained |

**Verdict:** Fits an existing surface

Removing a label is part of the chip, so it adds nothing to the page beyond a control that only exists where a chip already does. The one place care is needed is removing a label while filtering by it — the row disappearing is correct but disorienting, which is why a brief undo bar is worth more here than a confirmation dialog would be.
