# Update Campaign Status

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/status` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/update-status |
| **Auth** | API key (query param `api_key`) |

Starts, pauses or permanently stops a campaign, with a validation check before it is allowed to start.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner, **I want** one control that starts, pauses or stops a campaign, **so that** I can halt everything in a second when something looks wrong and restart it just as easily.

**Acceptance criteria**
- [ ] Given the accepted values are `START`, `PAUSED` and `STOPPED`, when I submit one, then the campaign moves to that state and the response returns the campaign with its resulting status.
- [ ] Given `START` triggers validation, when the playbook is invalid, no mailbox is attached, or no leads are attached, then the start is refused and the response names each unmet condition — mirroring the launch check Harry already runs.
- [ ] Given the campaign is paused, when I start it again, then leads resume from where they were, not from the beginning of the playbook.
- [ ] Given `PAUSED` is reversible, when I pause, then no new email is composed or sent, and any draft already approved is held rather than sent.
- [ ] Given `STOPPED` is permanent, when I stop, then I must confirm with an explicit warning that it cannot be undone, and the confirmation offers pause as the reversible alternative.
- [ ] Given the campaign is stopped, when I try to start it, then the request is refused with a message pointing at duplicating the campaign instead.
- [ ] Given an unknown status value, when I submit it, then I get a 422 `{ "error": "Invalid parameters provided" }` listing the accepted values.
- [ ] Given a status change succeeds, when I check the activity trail, then it names the actor, the old status and the new status.
- [ ] Given the campaign is running but outside its sending window, when I look at it, then it says it is holding and when the next email goes, rather than looking broken.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, start | Configure a valid campaign, POST `{ "status": "START" }` | 200 `{ success: true, message: "Campaign status updated successfully", campaign: { id, status } }`; the engine sends on the next tick |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401 `{ "message": "Invalid API Key" }`; the status is unchanged |
| TC-3 | Not found / wrong workspace | Change status on another workspace's campaign | 404 `{ "error": "Resource not found" }` |
| TC-4 | Validation failure | POST `{ "status": "ACTIVE" }` or any unknown value | 422 `{ "error": "Invalid parameters provided" }` listing `START`, `PAUSED`, `STOPPED` |
| TC-5 | Rate limited | Toggle status repeatedly | 429; the control disables briefly and the final state matches the last accepted request |
| TC-6 | Empty result set | Start a campaign with no leads attached | Refused, naming the missing leads, with a link to attach them |
| TC-7 | Start blocked by invalid playbook | Break the diagram, then start | Refused with the same validation message the editor shows |
| TC-8 | Pause holds approved drafts | Approve a draft, pause before the pacing window opens | The approved email does not go; it is held and labelled as held |
| TC-9 | Resume from position | Pause mid-playbook, resume, run the engine | Leads continue at their nodes, not from the start |
| TC-10 | Stop is permanent | Stop, then attempt to start | Refused with a message suggesting duplication; the stop confirmation had warned it was irreversible |
| TC-11 | Concurrent change | Two team members change status simultaneously | One wins, the other sees the current state without an inconsistent result |
| TC-12 | Holding vs stopped | Start a campaign outside its window | Status reads running with a holding message and a next-send time, distinct from paused |

## 4. Frontend user story

**As a** campaign owner, **I want** the campaign's state and its one control in the same place on every campaign surface, **so that** stopping something never means hunting for a button.

**Scope**
- Campaigns list and campaign detail: a status control showing the current state, with Start, Pause and Stop; Stop is visually separated and requires a typed or explicit confirmation.
- Start on an unconfigured campaign shows a checklist of the unmet conditions — valid playbook, mailbox attached, leads attached — each linking to the place it is fixed, instead of a bare error.
- Running campaigns outside their window show the existing holding message with the next send time, so "running" never looks like "doing nothing".
- Loading disables the control and shows the pending state; failure restores the previous state with the reason inline.
- Accessibility: the control is a labelled button group with the current state announced; the stop confirmation is focus-trapped with the safe option focused; state is conveyed in text as well as colour. On mobile the control is pinned to the campaign header.

**Definition of done**
- [ ] The same control appears on the list and the detail page with identical behaviour.
- [ ] A blocked start explains every unmet condition with a link to each fix.
- [ ] Stop always requires explicit confirmation naming its permanence.
- [ ] Holding is visually distinct from paused and from stopped.

## 5. Backend user story

**As a** Harry server, **I want** one guarded state transition route for campaigns, **so that** the engine can trust the status field and never send from a campaign that should be stopped.

**Scope**
- Add `PUT /api/campaigns/:id/status` to `server/routes.js` accepting `{ status }` from an allow-list, workspace-scoped.
- Data model: the existing status column on `campaigns`; record the actor and timestamp of each transition.
- Starting runs the existing launch validation — `server/playbook.js` for the diagram, plus mailbox and lead attachment — and returns every failure at once rather than the first.
- Enforce a transition table: stopped is terminal; pause holds approved-but-unsent drafts rather than discarding them; start from paused restores lead positions.
- `server/engine.js` re-reads status at the top of every tick so a pause takes effect within one tick with no restart.
- Write an `events` row with old and new status and the actor, and a `telemetry` row for the call.

**Definition of done**
- [ ] An engine test proves no send occurs within one tick of a pause.
- [ ] Start returns all unmet conditions in a single response.
- [ ] Stopped campaigns cannot be restarted, proven by a test.
- [ ] Concurrent transitions resolve to a single consistent state.

## 6. End-to-end test ticket

**Title:** E2E — start, pause and stop a campaign

**Preconditions:** A workspace with a sandbox mailbox, one draft campaign with a valid playbook but no leads attached, a set of leads ready to attach, and one approved draft prepared for after launch.

**Flow**
1. Sign in and open the campaign; attempt to start it.
2. Follow the checklist link to attach leads, then start.
3. Run the engine and confirm a send.
4. Approve a draft, then pause the campaign before the next pacing window.
5. Resume and run the engine.
6. Stop the campaign, reading the confirmation, then attempt to start it again.

**Assertions**
- [ ] Step 1 lists the missing leads as the only unmet condition, with a link.
- [ ] After step 2 the campaign reads as running.
- [ ] The approved draft is held during the pause and is not sent.
- [ ] After resuming, leads continue from their nodes and the held draft is the email that goes, not a new one.
- [ ] The stop confirmation states permanence, and the restart attempt is refused with a duplication suggestion.
- [ ] The activity trail shows each transition with the actor and old and new status.

**Teardown:** Delete the campaign and leads; clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns list | Status control per row | Low | One control showing state and action together, not two columns |
| Campaign detail | Same control in the header, plus a blocked-start checklist | Medium | The checklist appears only when a start is refused |
| Dashboard activity trail | Transitions recorded | Low | Existing event rendering |

**Verdict:** Fits an existing surface

Harry already blocks launch until the playbook validates, a mailbox is picked and leads are attached, so this is the control that surfaces that check rather than a new mechanism. The change worth making is turning a refusal into a checklist with links, because "you cannot start yet" without saying why is precisely the kind of thing that makes people think.
