# Pause Campaign Lead

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}/pause` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/pause-lead |
| **Auth** | API key (query param `api_key`) |

Puts one lead's outreach on hold inside a campaign without removing them, so it can be picked up again later.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner, **I want** to pause one lead in a campaign, **so that** a prospect who asked me to "circle back next quarter" stops hearing from the agent while staying in the campaign.

**Acceptance criteria**
- [ ] Given a lead is active in a campaign, when I pause them with the campaign id and lead id, then I get `{ success: true, message: "Lead paused successfully" }` and no further email is composed or sent for them in that campaign.
- [ ] Given the lead is paused, when the engine ticks, then their `no reply Xd` timers do not advance while paused, so resuming does not fire an immediate backlog of follow-ups.
- [ ] Given a draft for that lead is waiting in Needs your OK, when I pause them, then the draft is held rather than deleted, and the queue shows it as paused.
- [ ] Given the lead replies while paused, when the reply arrives, then it is still pulled into the Inbox and classified, but no automatic branch is followed until they are resumed.
- [ ] Given the lead is already paused, when I pause them again, then the call succeeds and no duplicate event is written.
- [ ] Given the lead is not in that campaign, when I pause them, then I get a not-found response and nothing changes.
- [ ] Given a lead is paused, when I look at the campaign, then the pause is visible with who paused it and when, and a one-click resume is present.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Attach lead 789 to campaign 123, run one tick, POST pause | 200 `{ success: true, message: "Lead paused successfully" }`; the lead shows as paused |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; the lead stays active and the button re-enables with an error |
| TC-3 | Not found / wrong workspace | Pause a lead id that is not attached to the campaign | 404; no change |
| TC-4 | Validation failure | POST with a non-numeric lead id | 422 naming the parameter |
| TC-5 | Rate limited | Pause 200 leads in a loop | 429 on some calls; the client backs off and every intended lead ends paused exactly once |
| TC-6 | Empty result set | Pause the only active lead, then list leads in flight | 200 with an empty list; the campaign shows "Nothing in flight" |
| TC-7 | Timer freeze | Pause a lead with a `no reply 3d` edge pending, wait past 3 days of simulated time, resume | The follow-up fires 3 days after the resume, not immediately |
| TC-8 | Reply while paused | Simulate a reply from a paused lead | The reply appears in Inbox with an intent chip; no branch is followed automatically |
| TC-9 | Held draft | Pause a lead with a pending draft, then try to approve it | Approval is blocked with a message explaining the lead is paused |
| TC-10 | Idempotency | Pause twice | Both succeed; one pause event exists |
| TC-11 | Campaign-level pause interaction | Pause the whole campaign, then pause one lead, then resume the campaign | The individually paused lead stays paused |

## 4. Frontend user story

**As a** campaign owner, **I want** a pause control on each lead in a campaign, **so that** honouring "not right now" takes one click instead of a workaround.

**Scope**
- Campaign detail, leads-in-flight list: a "Pause" row action that flips to "Resume", with the paused state shown as a badge on the row.
- Inbox thread view and the Dashboard Action Center: the same pause control, since that is where a "not now" reply is usually read.
- Leads page: the stage strip gains a paused filter so a user can find everyone they have parked.
- Loading disables the control inline; failure reverts the row with an adjacent error. Paused rows show who paused and when, in relative time with an exact timestamp on hover.
- Accessibility: the control is a toggle button with `aria-pressed`, the state change is announced in a live region, and the badge conveys state in text. On mobile the control sits in the row overflow menu.

**Definition of done**
- [ ] Pause and resume are the same control, never two competing buttons.
- [ ] Paused leads are visibly distinct in every list they appear in.
- [ ] A held draft in Needs your OK is labelled as paused rather than silently missing.
- [ ] The paused filter on Leads works from a single click on the stage strip.

## 5. Backend user story

**As a** Harry server, **I want** to hold one lead in one campaign without detaching them, **so that** the engine skips them and their timers stay where they were.

**Scope**
- Add `POST /api/campaigns/:id/leads/:leadId/pause` to `server/routes.js`, workspace-scoped, paired with the resume route.
- Data model: add `paused_at` and `paused_by` to `campaign_leads`; store the remaining time on any pending `no reply Xd` timer so resuming restores it rather than restarting or firing it.
- The engine (`server/engine.js`) must skip paused rows before pacing, composing or classifying-and-branching, while still ingesting replies into `messages`.
- Approval of a held draft must be refused while the lead is paused, with a clear message.
- Write an `events` row naming the actor, and a `telemetry` row for the call.

**Definition of done**
- [ ] Pause is idempotent.
- [ ] An engine test proves no send occurs for a paused lead across multiple ticks.
- [ ] An engine test proves a frozen `no reply` timer resumes with its remaining duration.
- [ ] Replies from paused leads still land in the Inbox.

## 6. End-to-end test ticket

**Title:** E2E — pause one lead mid-campaign

**Preconditions:** A workspace with a sandbox mailbox, one running campaign whose playbook has a `no reply 3d` edge, three attached leads, one with a draft awaiting approval.

**Flow**
1. Sign in, open Inbox → Needs your OK, note the pending draft.
2. Open the campaign and pause the lead who has the draft.
3. Return to Needs your OK and attempt to approve the held draft.
4. Advance simulated time past three days and run the engine.
5. Open Leads and filter by paused.

**Assertions**
- [ ] The lead's row shows a paused badge with the actor's name.
- [ ] Approving the held draft is refused with an explanation.
- [ ] No email is sent to the paused lead after the pause, while the other two leads progress normally.
- [ ] The paused filter on Leads returns exactly that one lead.
- [ ] The Dashboard activity trail records the pause.

**Teardown:** Resume the lead, delete the campaign and leads, clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | Pause/resume toggle per lead row | Low | One toggle, not two buttons; badge only when paused |
| Inbox / Action Center | Same toggle in the thread header | Low | Sits with the existing per-lead decisions |
| Leads | New paused value on the existing stage strip | Low | Reuses the click-to-filter strip already there |

**Verdict:** Fits an existing surface

Harry already parks leads for human decisions in the Action Center, so a manual pause is a variation on a pattern the user knows. The only real design work is making sure a held draft is visibly held rather than quietly gone, because a disappearing draft would undermine trust in the approval queue.
