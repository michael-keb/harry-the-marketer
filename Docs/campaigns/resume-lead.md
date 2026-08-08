# Resume Campaign Lead

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}/resume` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/resume-lead |
| **Auth** | API key (query param `api_key`) |

Puts a paused lead back into a campaign, either straight away or after a number of days you choose, and tells you the date it will restart.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner, **I want** to restart a paused lead now or in N days, **so that** "circle back next quarter" becomes a date the agent honours rather than a note I have to remember.

**Acceptance criteria**
- [ ] Given a paused lead, when I resume with an empty body, then I get `{ success: true, message: "Lead resumed successfully" }` and the lead is eligible for sending on the next engine tick.
- [ ] Given I resume with `resume_lead_with_delay_days: 7`, when the response returns, then it includes `will_resume_at` as an ISO timestamp seven days out, and the UI shows that date rather than making the user calculate it.
- [ ] Given a lead resumes after a delay, when it resumes, then it continues from the node it was paused at, not from the start of the playbook.
- [ ] Given a `no reply Xd` timer was frozen at pause, when the lead resumes, then the timer restarts with its remaining duration, so no backlog of follow-ups fires at once.
- [ ] Given a draft was held in Needs your OK while the lead was paused, when the lead resumes, then the draft becomes approvable again and is flagged as possibly stale with its age.
- [ ] Given the lead is not paused, when I resume, then the call succeeds without changing anything and writes no duplicate event.
- [ ] Given `resume_lead_with_delay_days` is negative or not a number, when I resume, then I get a validation error and the lead stays paused.
- [ ] Given the lead unsubscribed while paused, when I resume, then the resume is refused, because unsubscribe is always honoured.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, immediate | Pause lead 789 in campaign 123, then POST resume with `{}` | 200 `{ success: true, ... }`; the next tick treats the lead as active |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; the lead stays paused |
| TC-3 | Not found / wrong workspace | Resume a lead id not attached to the campaign | 404; nothing changes |
| TC-4 | Validation failure | POST `{ "resume_lead_with_delay_days": -3 }` | 422 naming the field; the lead stays paused |
| TC-5 | Rate limited | Resume 200 leads in a loop | 429 on some; retries settle and every lead resumes exactly once |
| TC-6 | Empty result set | Filter Leads by paused after resuming the only paused lead | 200 with an empty list and an empty state |
| TC-7 | Delayed resume | POST `{ "resume_lead_with_delay_days": 30 }` | `will_resume_at` is 30 days out; no send occurs before that date, and one occurs after |
| TC-8 | Node continuity | Pause at the second `Send:` node, resume | The next email is the one after that node, not the first email again |
| TC-9 | Frozen timer | Pause with 1 day remaining on a `no reply 3d` edge, resume after a week | The follow-up fires 1 day after the resume |
| TC-10 | Stale held draft | Hold a draft for 30 days, resume, open Needs your OK | The draft is approvable and labelled with its age |
| TC-11 | Unsubscribed while paused | Simulate an unsubscribe, then resume | Refused with an explanation; the lead stays out |
| TC-12 | Idempotency | Resume an already-active lead | Success, no duplicate event, no double send |

## 4. Frontend user story

**As a** campaign owner, **I want** to resume a lead now or on a chosen date, **so that** parking a prospect and picking them back up is a single decision I make once.

**Scope**
- Campaign detail and Leads: the paused badge carries a "Resume" control that offers "Now" or "In N days" with a small day input, defaulting to now.
- Paused rows show the scheduled restart date once a delayed resume is set, with a control to change or cancel it.
- Inbox and the Dashboard Action Center offer the same control, since "not now" replies are read there.
- Loading disables the control inline; failure restores the paused state with an adjacent message. A resume that would restore a very old draft warns before committing.
- Accessibility: the delay input is a labelled number field with a stated unit; the computed restart date is announced in text as it changes; the control collapses into the row overflow menu on narrow screens.

**Definition of done**
- [ ] The restart date is shown as a real date, never only as "in 7 days".
- [ ] Delayed resumes are visible and cancellable before they take effect.
- [ ] A stale held draft is labelled with its age on return.
- [ ] Resuming an unsubscribed lead is impossible from the UI.

## 5. Backend user story

**As a** Harry server, **I want** to clear a lead's pause immediately or at a future date, **so that** the engine picks them back up exactly where they left off.

**Scope**
- Add `POST /api/campaigns/:id/leads/:leadId/resume` to `server/routes.js` accepting `{ delay_days }`, workspace-scoped, paired with pause.
- Data model: clear `paused_at`/`paused_by` on `campaign_leads` or set a `resume_at` when a delay is given; return the computed `will_resume_at`.
- `server/engine.js` treats a row with a future `resume_at` as still paused; on or after that timestamp it becomes eligible, restoring the stored remaining time on any frozen `no reply` timer.
- Enforce the unsubscribe guard before resuming.
- Write an `events` row naming the actor and the restart date, and a `telemetry` row for the call.

**Definition of done**
- [ ] `will_resume_at` matches the delay to the day, in the workspace's timezone.
- [ ] An engine test proves continuation from the paused node, not the start.
- [ ] An engine test proves the frozen timer resumes with its remainder.
- [ ] Resume is idempotent for an already-active lead.

## 6. End-to-end test ticket

**Title:** E2E — resume a paused lead now and on a delay

**Preconditions:** A workspace with a sandbox mailbox, one running campaign with a multi-step playbook, two paused leads, one with a held draft.

**Flow**
1. Sign in and open the campaign detail page.
2. Resume the first lead immediately and run the engine.
3. Resume the second lead with a 7-day delay.
4. Read the paused row for the second lead.
5. Advance simulated time by 7 days and run the engine.
6. Open Inbox → Needs your OK.

**Assertions**
- [ ] The first lead receives its next step, not the first email again.
- [ ] The second lead's row shows an explicit restart date.
- [ ] No email goes to the second lead before that date, and one goes after step 5.
- [ ] The held draft is approvable again and labelled with its age.
- [ ] The Dashboard activity trail records both resumes with the actor's name.

**Teardown:** Delete the campaign and leads; clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail / Leads | Resume control gains a "in N days" option | Low | Defaults to Now; the delay input appears only when chosen |
| Leads | Paused rows show a restart date | Low | One line inside the existing badge area |
| Inbox / Action Center | Same control | Low | Reuses the campaign detail component |

**Verdict:** Fits an existing surface

Resume is the other half of pause and belongs in exactly the same place, so the only new idea is the optional delay. Showing the computed restart date instead of asking the user to hold "seven days from now" in their head is what keeps it a don't-make-me-think control.
