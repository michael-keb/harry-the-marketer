# Unsubscribe Lead from Campaign

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}/unsubscribe` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/unsubscribe-lead |
| **Auth** | API key (query param `api_key`) |

Marks a lead as unsubscribed so no further emails go to them — not just in this campaign but anywhere in the workspace.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner, **I want** to unsubscribe a lead by hand, **so that** when someone asks me to stop by phone or in a reply the classifier missed, I can honour it immediately and permanently.

**Acceptance criteria**
- [ ] Given an active lead, when I unsubscribe them, then I get `{ success: true, message: "Lead unsubscribed successfully" }` and no further email is composed or sent to them in any campaign in the workspace.
- [ ] Given the lead is unsubscribed, when their stage is derived, then it reads as unsubscribed and is counted in the unsubscribe rate in Reports.
- [ ] Given a draft for the lead is waiting in Needs your OK, when I unsubscribe them, then every draft for them is withdrawn across campaigns and cannot be approved.
- [ ] Given the lead is added to a new campaign later, when the engine reaches them, then they are skipped and the reason is visible on the lead.
- [ ] Given the lead is already unsubscribed, when I unsubscribe again, then the call succeeds without a duplicate event and the original unsubscribe timestamp is preserved.
- [ ] Given the lead is not in the campaign, when I unsubscribe them, then I get a not-found response and nothing changes.
- [ ] Given the action is destructive and effectively permanent, when I trigger it, then I must confirm, and the confirmation states it applies to every campaign.
- [ ] Given the action succeeds, when I check the activity trail, then it names the actor, the time, and that it was manual rather than a recipient click.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Attach lead 789 to campaign 123, POST unsubscribe | 200 `{ success: true, message: "Lead unsubscribed successfully" }`; the lead's stage reads unsubscribed |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; the lead stays subscribed |
| TC-3 | Not found / wrong workspace | Unsubscribe a lead from a campaign they are not in | 404; no change |
| TC-4 | Validation failure | POST with a non-numeric lead id | 422 naming the parameter |
| TC-5 | Rate limited | Unsubscribe many leads in a loop | 429 on some; retries settle and each lead is unsubscribed exactly once |
| TC-6 | Empty result set | List active leads after unsubscribing the only one | 200 with an empty list and an empty state on the campaign |
| TC-7 | Workspace-wide effect | Unsubscribe a lead who is in three campaigns, run the engine | No send in any of the three; all three show the lead as unsubscribed |
| TC-8 | Drafts withdrawn | Leave drafts for that lead in two campaigns, unsubscribe | Both drafts leave Needs your OK and neither can be approved |
| TC-9 | Re-import protection | Re-import the lead by CSV after unsubscribing | The lead is recognised and stays unsubscribed; the import reports it as skipped |
| TC-10 | Idempotency | Unsubscribe twice | Success both times; one event; the original timestamp is unchanged |
| TC-11 | Reply after unsubscribe | Simulate a reply from the unsubscribed lead | The reply is still visible in Inbox but no automatic branch fires and no reply can be sent |
| TC-12 | Reports | Unsubscribe two leads by hand | The unsubscribe rate reflects them and the manual origin is distinguishable from a footer click |

## 4. Frontend user story

**As a** campaign owner, **I want** an unsubscribe action next to each lead with a confirmation that tells me the truth about its scope, **so that** I honour a request instantly and never do it by accident.

**Scope**
- Campaign detail, Leads page, and Inbox thread view: an "Unsubscribe" action in the existing per-lead overflow menu, visually separated from the reversible actions like pause.
- Confirmation dialog states the lead's name and email, that this stops email in every campaign, and that it cannot be undone from the UI.
- Unsubscribed leads keep their row with an explicit badge rather than disappearing, so a user can see what happened.
- Loading disables the action; failure restores the row with an adjacent message. On success the stage strip counts on Leads update without a reload.
- Accessibility: the destructive action is labelled as such, the confirmation is focus-trapped with the safe action focused first, and the resulting state change is announced in a live region. On mobile the action stays in the overflow menu, never as a swipe gesture.

**Definition of done**
- [ ] The confirmation states the workspace-wide scope in plain English.
- [ ] Unsubscribe is visually separated from reversible actions.
- [ ] Unsubscribed leads remain visible with a badge.
- [ ] Withdrawn drafts are visibly removed from Needs your OK.

## 5. Backend user story

**As a** Harry server, **I want** a manual unsubscribe that behaves identically to a recipient-initiated one, **so that** there is exactly one code path deciding who may be emailed.

**Scope**
- Add `POST /api/campaigns/:id/leads/:leadId/unsubscribe` to `server/routes.js`, workspace-scoped, delegating to the same handler the public unsubscribe page uses.
- Data model: set the existing unsubscribe marker on the lead (workspace-level, not per-campaign) and record the origin as manual with the acting user.
- Withdraw all queued drafts for that lead across campaigns in the same transaction.
- `server/engine.js` must check the unsubscribe state before composing, before pacing and before sending; CSV import must respect it on re-import.
- Write an `events` row naming the actor and origin, and a `telemetry` row for the call.

**Definition of done**
- [ ] Manual and footer-click unsubscribes converge on one handler, proven by a test.
- [ ] No send occurs for an unsubscribed lead in any campaign, proven by an engine test.
- [ ] Re-import cannot resurrect an unsubscribed lead.
- [ ] Repeat calls preserve the original timestamp.

## 6. End-to-end test ticket

**Title:** E2E — honour an unsubscribe request made by hand

**Preconditions:** A workspace with a sandbox mailbox, three running campaigns sharing one lead, drafts pending for that lead in two of them, and a CSV file containing that lead.

**Flow**
1. Sign in, open Inbox → Needs your OK, and note both pending drafts.
2. Open the lead from the Leads page and unsubscribe them, reading the confirmation.
3. Return to Needs your OK.
4. Run the engine and check all three campaigns.
5. Import the CSV.
6. Open Reports.

**Assertions**
- [ ] The confirmation names the lead and states the workspace-wide scope.
- [ ] Both drafts are gone from Needs your OK and cannot be approved.
- [ ] No email is sent to the lead by any of the three campaigns.
- [ ] The CSV import reports the lead as skipped and does not resubscribe them.
- [ ] Reports counts the unsubscribe and the activity trail names the actor.

**Teardown:** Delete the campaigns and the lead; clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail / Leads / Inbox | One destructive item in the existing per-lead menu | Low | Separated by a divider, no new button on the row itself |
| Leads stage strip | Unsubscribed count already exists | Low | No change; manual unsubscribes just feed it |
| Reports | Manual origin distinguishable in the unsubscribe rate | Low | A tooltip on the existing figure, not a new chart |

**Verdict:** Fits an existing surface

Harry already derives an unsubscribed stage and already honours unsubscribe without an edge in the playbook, so this adds a way in, not a new concept. The only careful part is the confirmation copy, because a user who thinks they are stopping one campaign and actually stops all of them would rightly lose trust.
