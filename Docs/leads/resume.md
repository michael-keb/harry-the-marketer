# Resume Lead

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}/resume` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/resume |
| **Auth** | API key (query param `api_key`) |

Restarts a paused person in a campaign, either straight away or after a number of days you choose.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** to restart a paused person and choose how long to wait before the next email, **so that** picking up a conversation again does not mean firing an email the same second.

**Acceptance criteria**
- [ ] Given a paused lead, when I resume them, then their status returns to running and the engine determines the next playbook step automatically from where they stopped.
- [ ] Given I supply a delay in days, when the lead resumes, then the next email is scheduled that many days after their last email rather than immediately.
- [ ] Given I supply no delay, when the lead resumes, then the playbook's own timing applies — the `no reply Xd` edge or `Wait:` node they were sitting on, measured from the resume point.
- [ ] Given the lead has never been emailed, when they resume, then the next step is scheduled as soon as the sending rhythm allows, not instantly, so the pacing rules still hold.
- [ ] Given the lead has reached a terminal node (Won, Lost or Unsubscribed), when I try to resume them, then it is refused with a message saying the playbook is finished for this person, and offering to re-add them to another campaign instead.
- [ ] Given the lead resumes, when the next email is composed, then it still parks in Needs your OK — resuming never bypasses the standing rule that nothing sends without an OK.
- [ ] Given the resume succeeds, when I read the campaign page, then it says when the next email is expected, in the same words the pacing panel already uses.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path — default timing | Resume a paused lead with no delay | 200 with an ok result; the lead reads running and the next send time follows the playbook edge |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the lead stays paused and the button reverts |
| TC-3 | Campaign not found / wrong workspace | Resume using another workspace's campaign id | 404 with a campaign-not-found error; nothing changes |
| TC-4 | Validation failure | Resume with a delay of -1 or 3.5 days | 422 with a field-level message; the delay input refuses non-positive integers |
| TC-5 | Rate limited | Resume 150 leads from a bulk selection | 429 on some calls; the bulk action backs off and completes with the correct final count |
| TC-6 | Empty result set | Bulk resume with nothing selected | 200 with zero changes; the action is disabled in the UI |
| TC-7 | Custom delay | Resume with a three-day delay on a lead last emailed yesterday | The next send is scheduled two days from now (last send plus three days) |
| TC-8 | Terminal node | Resume a lead sitting on a Won terminal node | Refused with a "playbook finished for this person" message and an offer to add them to another campaign |
| TC-9 | Never emailed | Resume a paused lead with no send history | Scheduled at the next slot the sending rhythm allows, not immediately |
| TC-10 | Approval still required | Resume, then let the engine tick | A draft appears in Needs your OK; nothing is sent |
| TC-11 | Resume an unpaused lead | Resume a lead that is already running | No-op returning success; no duplicate schedule and no second activity trail entry |
| TC-12 | Unsubscribed lead | Resume a lead who unsubscribed while paused | Refused; the unsubscribe outranks the resume and the message says so |

## 4. Frontend user story

**As a** campaign owner, **I want** resume to be the same control as pause, with an optional "wait this long first", **so that** the pair reads as one switch rather than two features.

**Scope**
- Leads, Campaigns → campaign detail, Inbox → thread and Dashboard → Action Center: the pause control becomes resume when the lead is paused, with a small "in ... days" option beside it defaulting to the playbook's own timing.
- After resuming, the row shows when the next email is expected, using the same phrasing as the campaign pacing panel ("next email around 2:40pm").
- Loading: optimistic with rollback. Empty: the Action Center empty state already covers it. Error: the reason inline, including the terminal-node and unsubscribed refusals worded in plain English.
- Accessibility: the delay option is a labelled number input with a stated unit, not a bare stepper; the refusal messages are text and are read out. Responsive: the delay option collapses into the confirmation sheet under 640px.

**Definition of done**
- [ ] Pause and resume are one control with two states everywhere they appear.
- [ ] The default is the playbook's own timing, and choosing a delay is optional.
- [ ] Refusals explain themselves in plain English and suggest what to do instead.
- [ ] The expected next-email time is shown after resuming, without a reload.

## 5. Backend user story

**As a** Harry API, **I want** resume to hand the lead back to the engine with a correct next-step time, **so that** restarting is predictable and cannot double-send.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns/:campaignId/leads/:leadId/resume` accepting an optional `delayDays`, workspace-scoped and idempotent.
- Data model: clears `paused_at` and `paused_by` on `campaign_leads` and writes the computed next-step time. No new table.
- Next-step time: last send plus `delayDays` when supplied; otherwise the playbook edge or `Wait:` node measured from now; if there is no send history, the next slot the sending rhythm in `server/pacing.js` allows. The lead's fixed offset still applies, so a bulk resume does not queue everyone to the same minute.
- Refusals: terminal nodes and unsubscribed leads are rejected before any state change, with a machine-readable reason so the UI can word it. Standard rate limiting; 429 retried by the client.
- Logged: an `events` row per resume (actor, lead, campaign, delay chosen, computed next time); `telemetry` records how many leads are resumed at once so Monitoring can catch a bulk resume overwhelming a mailbox.

**Definition of done**
- [ ] The next-step time is computed by the existing pacing code, not a second implementation.
- [ ] Resume is idempotent and cannot produce two schedules, covered by a test.
- [ ] Terminal-node and unsubscribed refusals happen before any write, covered by tests.
- [ ] Bulk resume respects daily mailbox limits, covered by a test that resumes more leads than the day's allowance.

## 6. End-to-end test ticket

**Title:** E2E — Resume a paused lead with a delay and confirm the approval rule still holds

**Preconditions:** A workspace with one sandbox mailbox, a campaign with a Send node and a `no reply 3d` edge, one paused lead last emailed yesterday, one paused lead never emailed, and one lead sitting on a Won terminal node.

**Flow**
1. Leads → resume the previously emailed lead with a three-day delay.
2. Read the expected next-email time on the row.
3. Resume the never-emailed lead with the default timing.
4. Try to resume the Won lead.
5. Advance the sandbox clock two days and let the engine tick.
6. Inbox → Needs your OK.

**Assertions**
- [ ] The first lead's expected time is two days out, not three, because the delay is measured from the last send.
- [ ] The never-emailed lead is scheduled at the next allowed slot rather than instantly.
- [ ] Resuming the Won lead is refused with a plain-English message and an offer to add them to another campaign.
- [ ] After the clock advance, drafts appear in Needs your OK and the sandbox mailbox records no send.
- [ ] Approving one draft sends it and the activity trail shows the approval and the resume separately.

**Teardown:** Delete the campaign and its leads; clear the sandbox mailbox and reset the clock.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | Pause control becomes resume, with an optional delay | Low | One control with two states, not two buttons |
| Campaigns → campaign detail | Same control on the attached-leads table | Low | Identical component |
| Dashboard → Action Center | Resume already exists here; gains the delay option | Low | The option is secondary and hidden behind the control's menu |
| Inbox → thread | Resume in the thread header | Low | Same button as pause |

**Verdict:** Fits an existing surface

The Action Center already offers resume for leads parked awaiting a decision, so the surface exists; what is new is the optional delay and honest refusals for finished or unsubscribed people. Keeping it as one two-state control avoids adding a second concept to a page that already asks the user to make decisions quickly.
