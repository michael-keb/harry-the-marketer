# Mark Lead as Complete

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}/manual-complete` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/mark-lead-complete |
| **Auth** | API key (query param `api_key`) |

Ends one lead's journey through a campaign by hand — no more emails go to them — without labelling them as unsubscribed or as a failure.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner, **I want** to mark one lead as finished with a campaign, **so that** a deal I closed on the phone stops receiving follow-ups without being recorded as an unsubscribe or a loss.

**Acceptance criteria**
- [ ] Given a lead currently mid-playbook, when I mark them complete using the campaign id and their `lead_map_id`, then no further `Send:` node fires for that lead in that campaign.
- [ ] Given the lead is marked complete, when their stage is derived, then it reads as completed by hand and is counted separately from unsubscribed, lost and bounced in Reports.
- [ ] Given the lead is in other campaigns, when I complete them here, then the other campaigns are untouched.
- [ ] Given a draft is already waiting in Needs your OK for that lead in that campaign, when I complete them, then the draft is withdrawn and the withdrawal is recorded, so an approval cannot resurrect it.
- [ ] Given the lead is already complete, when I mark them complete again, then the call succeeds without creating a duplicate event.
- [ ] Given the `lead_map_id` does not belong to the campaign, when I call the endpoint, then I get a not-found response and nothing changes.
- [ ] Given the action succeeds, when I check the activity trail, then it names who completed the lead and when.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Attach lead to campaign 123 with `lead_map_id` 2433664091, run the engine once, then POST manual-complete | 200 `{ success: true, message: "Lead marked as complete" }`; the lead's stage shows completed |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; no state change; the button re-enables with an error toast |
| TC-3 | Not found / wrong workspace | Use a `lead_map_id` from another campaign | 404; the lead's state is unchanged in both campaigns |
| TC-4 | Validation failure | POST with a non-numeric `lead_map_id` | 422 naming the parameter |
| TC-5 | Rate limited | Complete 100 leads in a tight loop | 429 on some calls; the client retries with backoff and no lead is completed twice |
| TC-6 | Empty result set | List remaining active leads for the campaign after completing the only one | 200 with an empty list; the campaign shows "No leads still in flight" |
| TC-7 | Pending draft withdrawn | Leave a draft in Needs your OK, then complete the lead | The draft disappears from the queue and cannot be approved |
| TC-8 | Idempotency | Call manual-complete twice | Both return success; exactly one completion event exists |
| TC-9 | Engine race | Trigger an engine tick and the completion in the same second | Exactly one outcome wins; no email is sent after the completion timestamp |
| TC-10 | Reports separation | Complete two leads by hand | The funnel counts them as completed, not as lost or unsubscribed |

## 4. Frontend user story

**As a** campaign owner, **I want** a "Mark as done" action on a lead inside a campaign, **so that** I can close the loop the moment a deal lands, from wherever I am looking.

**Scope**
- Campaign detail, the leads-in-flight list: a row action "Mark as done" with a short confirmation naming the lead and the campaign.
- Leads page and Inbox thread view: the same action, so the user does not have to navigate back to the campaign to use it.
- Confirmation copy states plainly that this stops emails in this campaign only and does not unsubscribe the lead.
- Loading disables the row action and shows an inline spinner; on failure the row reverts and an error appears next to it, not as a page-level banner. If a draft was pending, the confirmation says so before the user commits.
- Accessibility: the confirmation is a focus-trapped dialog with the destructive action clearly labelled; the resulting stage change is announced in a live region. The action is in an overflow menu on narrow screens.

**Definition of done**
- [ ] The action is reachable from campaign detail, Leads and Inbox.
- [ ] The confirmation explains the difference from unsubscribing.
- [ ] A pending draft is visibly withdrawn from Needs your OK.
- [ ] Stage strip counts on Leads update without a reload.

## 5. Backend user story

**As a** Harry server, **I want** to end a lead's participation in one campaign on request, **so that** the engine skips them permanently and the stage derivation stays honest.

**Scope**
- Add `POST /api/campaigns/:id/leads/:leadId/complete` to `server/routes.js`, workspace-scoped, mirroring the existing per-lead campaign actions.
- Data model: add a completion marker to `campaign_leads` (completed timestamp plus the acting user) — stage stays derived, and this is one more input to the derivation, not a stored stage.
- The engine must treat a completed `campaign_leads` row as terminal at the top of its tick, before any pacing or composing work.
- Withdraw any queued draft for that lead and campaign in the same transaction.
- Write an `events` row naming the actor and the lead, and a `telemetry` row for the call.

**Definition of done**
- [ ] Repeat calls are idempotent.
- [ ] No message is sent for the lead in that campaign after the completion timestamp, verified by an engine test.
- [ ] Other campaigns containing the same lead are unaffected.
- [ ] Reports distinguishes manual completion from unsubscribe and loss.

## 6. End-to-end test ticket

**Title:** E2E — mark a lead as done in one campaign

**Preconditions:** A workspace with a sandbox mailbox, two running campaigns, one lead attached to both, one draft pending approval in campaign A.

**Flow**
1. Sign in and open Inbox → Needs your OK; confirm the draft for the lead is listed.
2. Open campaign A and use "Mark as done" on that lead.
3. Confirm the dialog, which warns about the pending draft.
4. Return to Needs your OK.
5. Run the engine and open campaign B.

**Assertions**
- [ ] The draft is gone from Needs your OK and cannot be approved.
- [ ] The lead's stage in campaign A reads as completed.
- [ ] The lead is still active in campaign B and can still receive email there.
- [ ] The Dashboard activity trail names the user who completed the lead.
- [ ] Reports counts the lead as completed, not unsubscribed.

**Teardown:** Delete both campaigns and the lead; clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | New row action on leads in flight | Low | Lives in the existing overflow menu next to pause and resume |
| Leads | Same action available per campaign membership | Medium | Only shown when the lead is actually in a running campaign |
| Inbox | Same action in the thread header | Low | Placed next to the existing manual reply controls |

**Verdict:** Fits an existing surface

Every place this action belongs already has a per-lead action menu, so it costs one menu item in three menus and no new page. The one piece of new copy that matters is the confirmation that distinguishes "done" from "unsubscribed", because getting that wrong would quietly corrupt the funnel.
