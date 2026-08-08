# Delete Lead List

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/lead-list/{id}` |
| **Category** | lead-lists |
| **Source** | https://api.smartlead.ai/api-reference/lead-lists/delete |
| **Auth** | API key (query param `api_key`) |

Removes a saved group of leads by its id, leaving the people themselves alone.

## 1. Epic

**Reusable lead segments**

Lets a Harry user keep a named, reusable group of prospects — "Australian SaaS running Jira", "Warm from the October webinar" — that outlives any one campaign and can be researched, scored, renamed and pushed at a campaign whenever it is needed. It matters because Harry's Leads page is one flat table today: every new campaign starts by re-finding the same people by hand, and there is nowhere to record that a particular set of thirty is the set worth chasing.

## 2. User story

**As a** campaign owner, **I want** to delete a segment I no longer use, **so that** my segment list stays short enough to scan without losing any of the people in it.

**Acceptance criteria**
- [ ] Given a segment id I own, when I delete it, then a 200 returns `{ "ok": true, "message": "Lead list deleted successfully" }` and the segment disappears from the segments panel.
- [ ] Given the segment held 1,250 leads, when it is deleted, then all 1,250 leads still exist on the Leads page with their stages, research profiles and campaign links untouched — only the grouping is gone.
- [ ] Given the segment is referenced by a running campaign that was populated from it, when I delete it, then the campaign and its attached leads are unaffected, and the confirmation says so explicitly.
- [ ] Given a segment id that does not exist or belongs to another workspace, when I delete it, then a 404 is returned and no segment anywhere is removed.
- [ ] Given I click delete, when the confirmation appears, then it names the segment and its lead count, and states in one line that the leads themselves are kept.
- [ ] Given the delete succeeds, when I look at the activity trail, then one entry records the actor, the segment name and the lead count it held at the time.
- [ ] Given I delete the segment currently selected as a filter on the Leads page, when the call returns, then the filter clears back to all leads rather than leaving an empty table with a stale chip.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `DELETE /lead-list/500` for a segment holding 3 leads | 200, `{"ok":true,"message":"Lead list deleted successfully"}`; segment gone, 3 leads still on the Leads page |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; segment untouched |
| TC-3 | Not found / wrong workspace | Delete a segment id owned by another workspace | 404; that workspace's segment still exists and its name is not leaked in the error |
| TC-4 | Validation failure | `DELETE /lead-list/abc` | 422 with a message that the id must be a number |
| TC-5 | Rate limited | Delete 25 segments in rapid succession | 429 on the excess; the client backs off and retries, every intended segment ends up deleted exactly once |
| TC-6 | Empty result set | Delete the last remaining segment | 200; the segments panel shows "No segments yet" rather than an empty box |
| TC-7 | Repeat delete | Call TC-1 twice | Second call returns 404 and the UI treats it as already-deleted, not as an error worth alarming the user |
| TC-8 | Segment used by a live campaign | Delete a segment whose leads were pushed to a running campaign | 200; the campaign keeps its leads, is still running, and the confirmation warned this would happen |
| TC-9 | Segment carrying labels | Delete a segment with two labels assigned | 200; the label-to-segment rows are removed but the labels themselves survive for other segments |
| TC-10 | Concurrent delete | Two team members delete the same segment at once | One gets 200, the other 404; neither sees a server error and both end on the same view |

## 4. Frontend user story

**As a** campaign owner, **I want** deleting a segment to make it obvious that my leads are safe, **so that** I never avoid tidying up out of fear of losing people.

**Scope**
- Leads page → Segments panel: a per-segment overflow menu with Rename and Delete, matching the row-menu pattern used elsewhere in the product.
- Confirmation dialog names the segment, shows its current lead count, and carries one plain sentence: "The N leads in this segment stay on your Leads page." Destructive action styling on the confirm button.
- States: pending disables the confirm button; success removes the row and clears the segment filter if it was active; a 404 is treated as success with a quiet "already removed" note; other errors keep the dialog open with the server message.
- Accessibility: the confirmation is a modal with focus trapped, the destructive button is reachable by keyboard and not identified by colour alone, and the outcome is announced via `aria-live`. Responsive: the dialog becomes a bottom sheet under 640px.

**Definition of done**
- [ ] The confirmation always states the lead count and that leads are kept.
- [ ] Deleting the active filter segment resets the Leads table to all leads.
- [ ] A repeat delete never shows a red error.
- [ ] No undo is promised that the backend cannot honour.

## 5. Backend user story

**As a** Harry API, **I want** a route that deletes a segment and its membership rows without touching leads, **so that** grouping is always safe to undo by re-creating rather than a data-loss risk.

**Scope**
- Route in `server/routes.js`: `DELETE /api/lead-lists/:id`, workspace-scoped from the session, returning 404 for any id outside the caller's workspace.
- Data model: deletes the `lead_lists` row and cascades to `lead_list_leads` and `lead_list_tags` only. The `leads` table is never written to by this route — enforced by a test, not just by convention.
- No pagination. Standard app rate limiting applies; the client retries 429 with backoff. Deleting an id already gone returns 404 rather than 500.
- Logged: an `events` row with actor, segment id, segment name and the membership count at the moment of deletion, so the trail can answer "what was in it" after the fact; `telemetry` records delete counts.

**Definition of done**
- [ ] Deleting a segment provably leaves every lead row unchanged.
- [ ] Label assignments on that segment are cleaned up, and the labels themselves survive.
- [ ] Cross-workspace ids return 404 with no name in the body.
- [ ] Tests cover the cascade, the leads-untouched guarantee, and the concurrent-delete race.

## 6. End-to-end test ticket

**Title:** E2E — Delete a segment without losing its leads

**Preconditions:** A workspace with one segment holding 12 leads, two of which are in a running campaign; the segment carries one label.

**Flow**
1. Open Leads → Segments and select the segment so it filters the table.
2. Open its overflow menu and choose Delete.
3. Read the confirmation.
4. Confirm.
5. Open Campaigns → the running campaign.

**Assertions**
- [ ] The confirmation states 12 leads and says they will be kept.
- [ ] After deleting, the Leads table shows all leads with no stale filter chip.
- [ ] All 12 leads still exist, with unchanged stages.
- [ ] The running campaign still has its two leads and is still running.
- [ ] The label still exists and can still be assigned to another segment.
- [ ] The activity trail records the deletion with the count of 12.

**Teardown:** Re-create the segment and re-add the 12 leads if later tests depend on it.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Segments panel | Overflow menu with Delete | Low | Same row-menu pattern used elsewhere; nothing new appears until the menu is opened |
| Confirmation dialog | One-sentence reassurance about leads being kept | Low | One sentence, not a warning panel |
| Dashboard activity trail | Deletion entry with membership count | Low | One line per deletion |

**Verdict:** Fits an existing surface

Deleting is the smallest possible addition to a panel that has to exist anyway, and it needs no page of its own. The only real design decision is the wording of the confirmation: because "delete list" reads like "delete these people", the dialog has to say the opposite plainly, or users will simply never clean up.
