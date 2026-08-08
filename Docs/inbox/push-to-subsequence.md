# Push Lead to Subsequence

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/push-to-subsequence` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/push-to-subsequence |
| **Auth** | API key (query param `api_key`) |

Moves one lead out of the campaign it is in and into a different follow-up sequence, optionally after a delay and optionally stopping if they answer the original campaign.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member reading a reply that clearly belongs somewhere else, **I want** to move the lead into a different playbook from the thread, **so that** "they asked about pricing" becomes the pricing playbook instead of a note I will forget.

**Acceptance criteria**
- [ ] Given a lead-campaign pairing (`email_lead_map_id`) and a target sequence (`sub_sequence_id`), when I push the lead, then the response confirms the `parent_campaign_id`, the `sub_sequence_id`, the computed `will_start_at` and the `stop_on_parent_reply` setting.
- [ ] Given `sub_sequence_delay_time` in seconds (default 0, minimum 0), when I set it, then the target sequence does not begin until that delay has elapsed and `will_start_at` reflects it; a negative value is rejected with a field-level message.
- [ ] Given `stop_lead_on_parent_campaign_reply: true`, when the lead later replies to the original campaign, then the target sequence stops for that lead and the reason is recorded.
- [ ] Given the target playbook is invalid or has no attached mailbox, when I push, then the push is refused with the same validation Harry already applies at campaign launch, and the lead stays where it is.
- [ ] Given the lead is already in the target campaign, when I push, then the request is refused with a clear message rather than creating a duplicate pairing.
- [ ] Given the push succeeds, when the target sequence reaches its first `Send:` node, then the composed email still parks in Needs your OK — moving a lead never bypasses the standing rule.
- [ ] Given the lead has unsubscribed, bounced, or reached a terminal outcome, when I push, then the push is refused and the reason is stated.
- [ ] Given the push completes, when it is recorded, then the activity trail names the actor, the source campaign, the target campaign, the delay and the stop-on-parent-reply setting, and the lead's thread shows the move inline.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path with delay | POST `{"email_lead_map_id": 2433664091, "sub_sequence_id": 789, "sub_sequence_delay_time": 172800, "stop_lead_on_parent_campaign_reply": true}` | 200, `success: true`, `data.will_start_at` two days ahead, `data.stop_on_parent_reply: true` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; the lead is not moved |
| TC-3 | Not found / wrong workspace | POST with a `sub_sequence_id` from another workspace | 404; nothing changes; UI shows "That campaign is not available" |
| TC-4 | Validation failure — negative delay | POST `sub_sequence_delay_time: -60` | 422 naming the field and the zero minimum |
| TC-5 | Rate limited | Push many leads in a burst | 429 on the excess; the client backs off with jitter and reports which leads moved |
| TC-6 | Empty result set | Open the target picker in a workspace with only one campaign | The picker shows an empty state ("No other campaign to move this lead into") with a link to create one; no failing request is sent |
| TC-7 | Immediate start | POST with `sub_sequence_delay_time: 0` | `will_start_at` is now; the target playbook's first `Send:` composes a draft on the next engine tick |
| TC-8 | Approval still required | Let the target sequence compose its first email | The email appears in Needs your OK and nothing is sent until approved |
| TC-9 | Stop on parent reply | Push with `stop_on_parent_reply: true`, then simulate a reply to the original campaign | The target sequence stops for that lead, the reason is in the activity trail, and no further target-sequence email is composed |
| TC-10 | Duplicate push | Push a lead into a campaign it is already in | Refused with a clear message; no duplicate pairing is created |
| TC-11 | Invalid target playbook | Push into a campaign whose Mermaid playbook fails validation | Refused with the existing playbook validation message; the lead stays in its original campaign |
| TC-12 | Unsubscribed lead | Push a lead who has unsubscribed | Refused with "This lead has unsubscribed"; unsubscribe is honoured regardless of routing |
| TC-13 | Delay honours the sending rhythm | Push with a delay that lands outside working hours | The first email is scheduled at the next allowed slot, not at the raw delay expiry |

## 4. Frontend user story

**As a** team member, **I want** a "Move to another playbook" action on a thread with a preview of what happens, **so that** rerouting a lead is a considered choice rather than a surprise.

**Scope**
- Inbox → Replies thread view: "Move to another playbook" in the thread's overflow menu, beside the existing reclassify-and-reroute action, with the difference stated in one line each — reclassify changes which edge the lead follows inside this playbook, moving sends them into a different playbook entirely.
- The dialog offers a campaign picker (valid playbooks only, invalid ones shown disabled with the reason), a delay in plain units ("start immediately", "in 1 day", "in 3 days", custom), and a checkbox for "Stop if they reply to the current campaign", each with one line of help.
- Before confirming, the dialog states the consequence in words: which playbook they leave, which they join, when the first email would be composed, and that it will still need approval.
- Loading: the confirm button shows a pending state. Empty: no valid target campaigns, with a link to Campaigns. Error: inline banner keeping the chosen options.
- Accessibility: the dialog is a labelled modal with focus trap; the delay control is a real select with a text summary of the resolved date; disabled targets state their reason in text, not by styling alone. Responsive: the dialog becomes full-screen under 640px.

**Definition of done**
- [ ] Move is reachable from the thread and clearly distinguished from reclassify-and-reroute.
- [ ] The confirmation states the source, the target, the start time and that approval is still required.
- [ ] Invalid targets are visible but disabled with a stated reason.
- [ ] Loading, empty, refused and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that moves a lead's active pairing to another campaign with a delay and a stop condition, **so that** rerouting is a first-class, logged operation rather than a delete and re-add.

**Scope**
- Route in `server/routes.js`: `POST /api/leads/:leadId/move` taking `{ fromCampaignId, toCampaignId, startAfterSeconds, stopOnSourceReply }`. Workspace-scoped, 404 for any campaign outside the workspace.
- Data model: the lead's `campaign_leads` row for the target campaign is created with a `start_after` timestamp and a `stop_on_source_reply` flag plus `moved_from_campaign_id`; the source pairing is closed with a "moved" reason rather than deleted, so history and Reports attribution survive.
- Validation before write, reusing existing rules: the target playbook must pass `server/playbook.js` validation, the target campaign must have a mailbox attached, and the lead must not be unsubscribed, bounced or terminal. All checks run in one transaction so a refused move changes nothing.
- `server/engine.js` skips the new pairing until `start_after` has passed, then walks the target playbook from its Start node; `server/pacing.js` still decides the actual send minute, so a delay that expires at 2am does not produce a 2am email. When `stop_on_source_reply` is set, an inbound reply on the source campaign closes the target pairing with a recorded reason.
- Logged: an `events` row for the move with actor, source, target, delay and stop flag; `telemetry` counts moves per campaign pair so Reports' learning section can show which playbook people keep rerouting out of.

**Definition of done**
- [ ] Move route exists with full validation, covered by tests including cross-workspace 404 and invalid-playbook refusal.
- [ ] A test asserts the source pairing is closed, not deleted, and Reports attribution is unaffected.
- [ ] An engine test asserts the delay is honoured and the first email still requires approval.
- [ ] A test asserts stop-on-source-reply closes the target pairing when a source reply arrives.

## 6. End-to-end test ticket

**Title:** E2E — Reroute a pricing question into the pricing playbook

**Preconditions:** A workspace with a sandbox mailbox, two campaigns with valid playbooks (an outreach campaign and a "pricing discussion" campaign, both with the mailbox attached), one lead in the outreach campaign who has replied asking about pricing, approvals on.

**Flow**
1. Open Inbox → Replies and open the lead's thread.
2. Choose "Move to another playbook", pick the pricing campaign, set the delay to one day, and tick "Stop if they reply to the current campaign".
3. Read the consequence summary and confirm.
4. Check the lead's record on the Leads page and the thread timeline.
5. Advance test time one day and tick the engine.
6. Open Inbox → Needs your OK.

**Assertions**
- [ ] The confirmation named both campaigns, the resolved start time and stated that approval is still required.
- [ ] The lead's record shows the outreach pairing closed with reason "moved" and an open pairing on the pricing campaign; the thread timeline shows the move inline.
- [ ] Before the delay elapsed, no pricing-campaign email was composed.
- [ ] After the delay, the pricing playbook's first email appears in Needs your OK and nothing was sent.
- [ ] Simulating a reply to the outreach campaign closes the pricing pairing with the reason recorded, and the activity trail names the actor for the move.

**Teardown:** Delete both campaigns and the lead; reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies thread | "Move to another playbook" in the overflow menu with a confirmation dialog | Medium | Sits beside reclassify-and-reroute with one line distinguishing them; the dialog is the only new surface and it is transient |
| Leads → lead detail | Closed and open pairings shown with a "moved" reason | Low | Extends the existing campaign list on the lead record by one line of text |
| Campaigns → campaign detail | Node performance unaffected; moved leads are attributed to where they were | Low | Nothing added; the closed-not-deleted rule is what keeps this true |
| Reports → Learning | Moves per campaign pair available as a signal | Low | Feeds the existing learning section rather than adding a chart |

**Verdict:** Fits an existing surface

Harry can already reroute a lead inside a playbook by reclassifying a reply, but there is no way to move a lead into a different playbook without deleting and re-adding them, which loses the history. The action belongs in the thread overflow menu next to reclassify, and the important design constraint is that a moved lead's first email still parks in Needs your OK — a routing change must never become a sending shortcut.
