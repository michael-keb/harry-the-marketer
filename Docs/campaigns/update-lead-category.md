# Update Lead Category in Campaign

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}/category` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/update-lead-category |
| **Auth** | API key (query param `api_key`) |

Labels a lead inside a campaign — interested, not interested, and so on — and can pause them at the same time.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner reading the Inbox, **I want** to set a lead's intent by hand and optionally pause them in the same action, **so that** when the classifier gets a reply wrong I can correct it and stop the wrong follow-up in one step.

**Acceptance criteria**
- [ ] Given a lead in a campaign, when I set `category_id` to a valid intent, then I get `{ success: true, message: "Lead category updated" }` and the new intent replaces the classifier's guess on that lead.
- [ ] Given `category_id` is `null`, when I send it, then the category is removed and the lead reverts to the classifier's own reading.
- [ ] Given `pause_lead` is true, when I categorize, then the lead is paused in the same operation and the pause is attributed to the categorization.
- [ ] Given `pause_lead` defaults to false, when I omit it, then the lead keeps moving through the playbook.
- [ ] Given the new intent matches an edge label in the playbook, when the engine next ticks, then the lead follows that edge, so correcting the intent actually reroutes them.
- [ ] Given the new intent matches no edge, when the engine next ticks, then the lead is flagged as needing attention rather than being silently dropped.
- [ ] Given I set the intent to unsubscribe, when it saves, then the unsubscribe is honoured immediately regardless of the playbook.
- [ ] Given `category_id` is not a known category, when I send it, then I get a validation error listing the accepted values.
- [ ] Given the change succeeds, when I check the activity trail, then it records the old intent, the new intent and who set it.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{ "category_id": 1, "pause_lead": false }` for a lead classified "question" | 200 `{ success: true, message: "Lead category updated" }`; the lead shows the new intent chip |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; the intent is unchanged |
| TC-3 | Not found / wrong workspace | Categorize a lead not in the campaign | 404; no change |
| TC-4 | Validation failure | POST `{ "category_id": 9999 }` | 422 listing the accepted categories |
| TC-5 | Rate limited | Recategorize many leads in a loop | 429 on some; retries settle and each lead ends with the intended category |
| TC-6 | Empty result set | Filter the Inbox by an intent no lead has | 200 with an empty list and an empty state |
| TC-7 | Categorize and pause | POST `{ "category_id": 1, "pause_lead": true }` | The lead is both categorized and paused; the pause reason names the categorization |
| TC-8 | Reroute on correction | Set the intent to one that matches a playbook edge, run the engine | The lead advances along that edge, not the one the classifier picked |
| TC-9 | No matching edge | Set an intent with no edge, run the engine | The lead is flagged as needing attention and appears in the Action Center |
| TC-10 | Clear category | POST `{ "category_id": null }` | The manual override is removed and the classifier's reading is shown again |
| TC-11 | Unsubscribe intent | Set the intent to unsubscribe | The lead is unsubscribed workspace-wide and no further email is sent |
| TC-12 | Audit | Recategorize twice | Both changes appear in the activity trail with old and new values |

## 4. Frontend user story

**As a** campaign owner, **I want** the intent chip on a reply to be editable with an optional "and pause", **so that** correcting the agent is as fast as reading the reply.

**Scope**
- Inbox thread view: the existing intent chip becomes a picker listing the built-in intents (`interested`, `not interested`, `not now`, `question`, `unsubscribe`, `out of office`) plus any edge labels from the campaign's playbook, so the choices are the ones the diagram can actually route on.
- The picker includes a "pause this lead too" checkbox, unchecked by default, and shows what the lead will do next for the chosen intent before the user commits.
- Campaign detail and the Dashboard Action Center: the same picker on each lead row.
- The existing "reclassify and reroute" behaviour is preserved: choosing an intent both records it and reroutes.
- Loading disables the picker; failure restores the previous chip with an inline message.
- Accessibility: a labelled listbox with the current value announced, the pause checkbox as a real checkbox, and the "what happens next" preview as text rather than an icon. On mobile the picker opens as a sheet.

**Definition of done**
- [ ] Choices are the intents the playbook can route on, not a generic list.
- [ ] The consequence of the chosen intent is shown before committing.
- [ ] Pausing alongside categorizing is one action, not two.
- [ ] Choosing unsubscribe warns that it applies workspace-wide.

## 5. Backend user story

**As a** Harry server, **I want** a manual intent override that feeds the same routing logic as the classifier, **so that** a human correction changes what actually happens next.

**Scope**
- Add `POST /api/campaigns/:id/leads/:leadId/intent` to `server/routes.js` accepting `{ intent, pause }`, workspace-scoped.
- Data model: store the manual intent and its actor on the relevant `messages` row or on `campaign_leads`, marked as human-set so the classifier does not overwrite it on a later tick.
- Validate the intent against the built-ins plus the campaign's playbook edge labels parsed by `server/playbook.js`.
- Routing runs through the existing edge-following code in `server/engine.js`; an intent with no matching edge sets the needs-attention flag; unsubscribe short-circuits to the unsubscribe handler.
- When `pause` is true, apply the pause in the same transaction with the categorization recorded as the reason.
- Write an `events` row with old and new intent and the actor, and a `telemetry` row for the call.

**Definition of done**
- [ ] A manual intent survives subsequent engine ticks and is not overwritten.
- [ ] Rerouting on a corrected intent is proven by an engine test.
- [ ] Unsubscribe intent is honoured with or without an edge.
- [ ] Categorize-and-pause is atomic.

## 6. End-to-end test ticket

**Title:** E2E — correct a misread reply and stop the wrong follow-up

**Preconditions:** A workspace with a sandbox mailbox, one running campaign whose playbook has `reply: interested` and `reply: question` edges, one lead who has replied and been classified as "question".

**Flow**
1. Sign in, open Inbox, and open the lead's thread.
2. Read the intent chip and the preview of what happens next.
3. Change the intent to "interested" without pausing.
4. Run the engine.
5. On a second lead, change the intent and check "pause this lead too".
6. Open the Dashboard activity trail.

**Assertions**
- [ ] The picker offers exactly the built-in intents plus the playbook's edge labels.
- [ ] After step 4 the first lead follows the interested branch, not the question branch.
- [ ] The second lead is both recategorized and paused, and no email is sent to them.
- [ ] The activity trail shows both changes with old and new intent and the actor's name.
- [ ] Clearing the category on the first lead restores the classifier's original reading.

**Teardown:** Delete the campaign and leads; clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox thread | Intent chip becomes an editable picker with a pause option | Medium | Looks identical until clicked; the checkbox is the only addition inside the picker |
| Campaign detail / Action Center | Same picker per lead row | Low | Reuses the Inbox component |
| Dashboard activity trail | Intent changes recorded | Low | Existing event rendering, no new filter |

**Verdict:** Fits an existing surface

Harry already shows intent chips and already supports reclassify-and-reroute, so this makes an existing control do the pause in the same step instead of forcing two actions. Showing what the lead will do next before the user commits is what turns a label into a decision they can trust.
