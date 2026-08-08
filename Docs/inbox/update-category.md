# Update Lead Category

| | |
|---|---|
| **Endpoint** | `PATCH https://server.smartlead.ai/api/v1/master-inbox/update-category` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/update-category |
| **Auth** | API key (query param `api_key`) |

Sets or clears the label describing what a lead's reply meant — interested, not interested, meeting request, and so on.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member who disagrees with how a reply was read, **I want** to change its category, **so that** the lead follows the right branch of the playbook instead of the wrong one.

**Acceptance criteria**
- [ ] Given a lead-campaign pairing (`email_lead_map_id`, the `campaign_lead_map_id` from the list endpoints) and a `category_id`, when I update it, then the response confirms success and the new category is visible on the thread and in the list immediately.
- [ ] Given `category_id: null`, when I update, then the category is removed and the lead is treated as uncategorised, which the list filters can select with `leadCategories.unassigned`.
- [ ] Given a `category_id` that is not a number or null, when I submit, then I get 422 with the message that it must be a valid number or null, and nothing changes.
- [ ] Given an `email_lead_map_id` that does not exist or belongs to another workspace, when I submit, then I get 404 with "Lead mapping not found" and nothing changes.
- [ ] Given Harry's categories come from the campaign's own playbook edge labels plus the built-ins (`interested`, `not interested`, `not now`, `question`, `unsubscribe`, `out of office`), when I choose a category, then the picker offers exactly those, not a fixed vendor list, because the diagram defines the branches.
- [ ] Given I change the category, when the change is saved, then the lead is rerouted along the matching edge from its current node, and the UI states which edge will now be followed before I confirm.
- [ ] Given a category with no matching edge, when I set it, then the lead is flagged as needing attention rather than being silently dropped, matching how an unmatched classification is already handled.
- [ ] Given `unsubscribe`, when it is set manually, then it is honoured as a terminal outcome even if no edge exists for it, and no further email is composed for that lead.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | PATCH `{"email_lead_map_id": 2433664091, "category_id": 1}` (interested) | 200, `{"success": true, "message": "Lead category updated successfully"}`; the thread chip changes to Interested |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again" and reverts the optimistic chip change |
| TC-3 | Not found / wrong workspace | PATCH with an id from another workspace | 404, `{"error": "Lead mapping not found"}`; nothing changes |
| TC-4 | Validation failure | PATCH `category_id: "interested"` | 422, `{"error": "category_id must be a valid number or null"}` |
| TC-5 | Rate limited | Recategorise many leads in a burst | 429 on the excess; the client backs off with jitter and reports which succeeded |
| TC-6 | Empty result set | Open the category picker for a campaign whose playbook has no reply edges | The picker shows only the built-in intents with a note that this playbook has no reply branches; no failing request is sent |
| TC-7 | Clear the category | PATCH `category_id: null` | 200; the lead is uncategorised and appears under the unassigned filter |
| TC-8 | Reroute follows the diagram | Change a lead at node A from "question" to "interested" where A has an `interested` edge to B | The lead moves to node B and the next email is composed from B's instruction |
| TC-9 | No matching edge | Set a category the playbook has no edge for | The lead is flagged as needing attention and appears in the Action Center; nothing is silently dropped |
| TC-10 | Unsubscribe honoured | Set the category to `unsubscribe` on a playbook with no unsubscribe edge | The lead is finished as unsubscribed and no further email is composed |
| TC-11 | Approval unaffected | Recategorise a lead with a draft already in Needs your OK | The stale draft is withdrawn or clearly marked as belonging to the previous branch; a user can never approve an email that the new route would not have written |
| TC-12 | Audit | Recategorise twice in a row | Both changes are in the activity trail with the actor, the previous value and the new one |

## 4. Frontend user story

**As a** team member, **I want** the intent chip on a thread to be editable with the resulting route shown, **so that** correcting the classifier is one click and I can see what it will do.

**Scope**
- Inbox → Replies thread view: the existing intent chip becomes a picker offering the campaign playbook's reply edge labels plus the built-in intents, with "Clear" to unassign.
- Before applying, a one-line statement names the edge that will be followed ("Goes to: propose a 20-minute call") or warns that no edge matches and the lead will be flagged for attention.
- The list rows show the chip and allow the same change from the row's overflow menu for fast triage without opening each thread.
- Loading: optimistic chip update with revert on failure. Empty: a playbook with no reply edges shows only built-ins with an explanatory line. Error: inline banner naming what failed.
- Accessibility: the picker is a labelled combobox; the resulting-edge statement is in the accessible description so it is read before selection is confirmed; the chip's text carries the category name, never colour alone. Responsive: the picker becomes a bottom sheet under 640px.

**Definition of done**
- [ ] The chip is editable from the thread and from a list row, offering the playbook's own edge labels.
- [ ] The resulting route is stated before the change is applied.
- [ ] A category with no matching edge flags the lead rather than doing nothing.
- [ ] Loading, revert, no-edge and unsubscribe states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that sets a reply's intent and reroutes the lead accordingly, **so that** a human correction and an AI classification take exactly the same path through the engine.

**Scope**
- Route in `server/routes.js`: `PATCH /api/campaign-leads/:id/intent` taking `{ intent | null }`. Workspace-scoped, 404 outside the workspace with the documented "not found" wording.
- Data model: the intent already lives on the lead's message/pairing record; this adds `intent_set_by` and `intent_set_at` so a human correction is distinguishable from a classification in Reports and in the learning section.
- Rerouting reuses the engine's own edge-following code in `server/engine.js` rather than a parallel implementation, so a manual change and a classifier result can never behave differently. `unsubscribe` is honoured terminally regardless of the diagram, as it already is.
- Any draft composed under the previous branch is withdrawn or marked stale so it cannot be approved after the route has changed; this is the one place where a routing change must reach into the approval queue.
- Validation: the intent must be one of the campaign playbook's reply edge labels or a built-in; anything else is 422. Standard rate limiter; 429 retried with backoff and jitter.
- Logged: an `events` row per change with actor, previous intent, new intent and the resulting node; `telemetry` counts human corrections per campaign so Reports' learning section can show where the classifier is weakest.

**Definition of done**
- [ ] Route exists and reuses the engine's edge-following code, asserted by a test comparing a manual change with a classified one.
- [ ] A test asserts a stale draft cannot be approved after a reroute.
- [ ] A test asserts manual `unsubscribe` finishes the lead even with no edge.
- [ ] Human corrections are counted separately from classifications in telemetry.

## 6. End-to-end test ticket

**Title:** E2E — Correct a misread reply and watch the playbook take the right branch

**Preconditions:** A workspace with a sandbox mailbox, a running campaign whose playbook has `interested` and `question` edges from the first send node, one lead whose reply was classified as "question", a draft already composed for the question branch and waiting in Needs your OK, approvals on.

**Flow**
1. Open Inbox → Replies and open the lead's thread.
2. Open the intent chip picker and select "interested"; read the statement of which edge will be followed.
3. Confirm the change.
4. Open Inbox → Needs your OK.
5. Tick the engine.
6. Open Dashboard → activity trail.

**Assertions**
- [ ] The picker offered exactly the playbook's reply edge labels plus the built-in intents.
- [ ] The statement named the destination node before the change was applied.
- [ ] The stale question-branch draft is withdrawn or marked stale and cannot be approved.
- [ ] After the tick, a new draft for the interested branch appears in Needs your OK, unsent.
- [ ] The activity trail records the correction with the actor, the previous intent and the new one.

**Teardown:** Delete the campaign and lead; reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies thread | The existing intent chip becomes editable, with a stated destination | Low | Same chip in the same place; it gains a picker rather than a new control |
| Inbox rows | Recategorise available from the row overflow menu | Low | One item in a menu that already exists |
| Inbox → Needs your OK | Stale drafts are withdrawn when a route changes | Medium | The withdrawal is explained on the row so a disappearing draft is never a mystery |
| Reports → Learning | Human corrections counted separately | Low | Extends the existing learning section; no new chart |

**Verdict:** Fits an existing surface

Harry already has reclassify-and-reroute in the Inbox thread view, so this capability largely exists — the additions are naming the destination node before the change is applied, distinguishing a human correction from a classification in Reports, and handling the stale draft that the current flow leaves behind. That last one is the real bug this ticket closes: today a route change can leave an approvable email that belongs to the branch you just abandoned.
