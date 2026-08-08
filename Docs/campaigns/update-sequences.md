# Update Campaign Sequences

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{campaign_id}/sequences` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/update-sequences |
| **Auth** | API key (query param `api_key`) |

Writes the steps of a campaign's email sequence — their order, subject, body and the wait before each one — creating new steps or editing existing ones in a single save.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner, **I want** to change the steps of a campaign — their order, their instructions and the wait between them — in one save, **so that** a playbook that is not working can be rewritten without rebuilding the campaign.

**Acceptance criteria**
- [ ] Given I submit the whole set of steps, when I save, then new steps (`id: null`) are created and existing ones (`id` present) are updated in one operation, and the response returns each step with its assigned id and resolved position.
- [ ] Given each step carries a position, an instruction body and a delay in days, when I save, then positions must be a contiguous sequence starting at 1 with no duplicates, or I get a field-level error.
- [ ] Given a delay must be between 0 and 365 days, when I submit a value outside that range, then I get a 422 `{ "error": "Invalid parameters provided" }` naming the step.
- [ ] Given the campaign is running, when I try to change its steps, then the save is refused with a message telling me to pause first, and the running campaign is unaffected.
- [ ] Given Harry's playbook is a Mermaid diagram, when I save steps, then the diagram is regenerated or validated to match, and an invalid diagram blocks the save exactly as it blocks launch today.
- [ ] Given a follow-up step has no subject, when it sends, then it continues the previous thread with a `Re:` subject rather than starting a new conversation.
- [ ] Given bodies may contain `{{first_name}}`, `{{company_name}}`, `{{website}}`, `{{location}}`, `{{linkedin_profile}}` and any custom field, when I save, then unknown variables are flagged before the save completes, not at send time.
- [ ] Given leads are mid-sequence when the steps change, when the campaign resumes, then each lead's position is remapped explicitly and the remapping is shown before I confirm.
- [ ] Given a step is removed, when leads were sitting at it, then I am told how many and where they will go instead.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, create | POST two steps with `id: null`, positions 1 and 2, delays 0 and 3 | 200 `{ ok: true, data: [...] }` with ids assigned and the second step's subject resolved to `Re: <first subject>` |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401 `{ "message": "Invalid API Key" }`; nothing saved |
| TC-3 | Not found / wrong workspace | Save steps on another workspace's campaign | 404 `{ "error": "Resource not found" }` |
| TC-4 | Validation failure | Submit a step with `delay_in_days: 400` | 422 `{ "error": "Invalid parameters provided" }` naming the step and the 0-365 range |
| TC-5 | Rate limited | Save repeatedly in a tight loop | 429; the editor retries once and the final saved set is the last one submitted |
| TC-6 | Empty result set | Load the editor on a campaign with no steps yet | 200 with an empty set; the editor shows the starter diagram and a "Generate with AI" prompt |
| TC-7 | Active campaign refused | Save steps while the campaign is running | Refused with a message telling the user to pause; the running campaign is untouched |
| TC-8 | Duplicate positions | Submit two steps both at position 2 | Rejected naming the duplicate; nothing saved |
| TC-9 | Unknown variable | Include `{{industry}}` where no such custom field exists | Flagged before save with the option to add the field or fix the text |
| TC-10 | Mid-sequence remapping | Pause a campaign with leads at step 2, delete step 2, save | The confirmation states how many leads move and where; after resuming they are at the stated step |
| TC-11 | Invalid diagram | Save a step set that produces an unreachable node | Save blocked with the same validation message the launch check uses |
| TC-12 | Thread continuity | Save a follow-up with no subject, send both steps | The follow-up arrives in the same thread with a `Re:` subject |

## 4. Frontend user story

**As a** campaign owner, **I want** to edit the whole playbook and save it once, **so that** restructuring a campaign feels like editing a document rather than patching a database.

**Scope**
- Campaign detail, playbook editor: the existing Mermaid text editor with live render stays the primary surface; saving validates server-side and blocks on failure, as it already does before launch.
- A step list beside the diagram shows each `Send:` node with its wait, so a user who thinks in steps rather than diagrams has a way in; editing either view updates the other.
- Saving a running campaign shows the pause-first message with a "Pause and edit" action that does both.
- Removing or reordering steps shows a pre-save summary of how many leads are affected and where they will land.
- Loading disables save; validation errors are anchored to the offending line in the editor and the offending row in the step list; nothing typed is lost.
- Accessibility: the editor is a labelled text area with an error summary that links to lines; the step list is a real list with headings; variable warnings are text. On mobile the diagram and the editor stack, with the diagram collapsible.

**Definition of done**
- [ ] One save writes the entire set of steps.
- [ ] Editing a running campaign is refused with a one-click way to pause.
- [ ] Lead remapping is shown before the save is committed.
- [ ] Unknown merge variables are flagged before saving, not at send time.

## 5. Backend user story

**As a** Harry server, **I want** to accept a whole step set and reconcile it against the stored playbook atomically, **so that** partial saves can never leave a campaign in a state the engine cannot execute.

**Scope**
- Add `PUT /api/campaigns/:id/sequence` to `server/routes.js` accepting the full ordered step set, workspace-scoped.
- Data model: the playbook remains the Mermaid source on `campaigns`; steps are parsed and validated by `server/playbook.js`, which stays the single source of truth. Persist lead positions in `campaign_leads` and remap them in the same transaction.
- Refuse the write when the campaign status is running, returning the pause-first message.
- Validate positions for contiguity and uniqueness, delays within 0-365, and every merge variable against the workspace's lead fields and custom fields.
- Regenerate or validate the diagram so a saved step set always parses; reject anything the engine could not execute, reusing the launch-time validator.
- Write an `events` row summarising what changed and how many leads were remapped, and a `telemetry` row for the call.

**Definition of done**
- [ ] Save is all-or-nothing, proven by a test with one bad step.
- [ ] A running campaign cannot be edited, proven by a test.
- [ ] Lead remapping is deterministic and covered by an engine test.
- [ ] Every saved step set passes the same validator as launch.

## 6. End-to-end test ticket

**Title:** E2E — restructure a campaign's steps

**Preconditions:** A workspace with a sandbox mailbox, one running campaign with a three-step playbook, six leads distributed across steps 1, 2 and 3, and one custom field defined on leads.

**Flow**
1. Sign in and open the campaign's playbook editor.
2. Attempt to save an edit while the campaign is running.
3. Use "Pause and edit", then delete step 2 and change step 3's wait from 4 days to 6.
4. Read the pre-save summary of affected leads and confirm.
5. Add a merge variable that does not exist and attempt to save.
6. Fix it, save, resume the campaign, and run the engine.

**Assertions**
- [ ] Step 2 is refused with the pause-first message and the campaign keeps running.
- [ ] The pre-save summary names how many leads move and where.
- [ ] The unknown variable is flagged before saving with a way to fix it.
- [ ] After resuming, leads formerly at step 2 are at the step named in the summary.
- [ ] The follow-up email arrives in the existing thread with a `Re:` subject.
- [ ] The activity trail records the change with the remapped lead count.

**Teardown:** Delete the campaign and leads; clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign playbook editor | Adds a step list view beside the diagram, plus a pre-save remapping summary | High | The diagram stays primary and the step list is collapsible; the summary only appears when steps are removed or reordered |
| Campaign detail | "Pause and edit" action | Low | Replaces a dead end with a single action |
| Dashboard activity trail | Records step changes | Low | Existing event rendering |

**Verdict:** Fits an existing surface

The playbook editor is the heart of the product and already validates before launch, so this extends its save path rather than introducing a surface. The step list is the one addition that risks bloat, and it earns its place only because it is the honest answer for a user who does not want to read a diagram — which is why it is collapsible and never the default view.
