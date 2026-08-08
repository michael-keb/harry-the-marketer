# Pause Lead

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}/pause` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/pause |
| **Auth** | API key (query param `api_key`) |

Stops all scheduled emails to one person in one campaign, and cancels anything already drafted for them.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** to pause one person mid-playbook without stopping the campaign or deleting them, **so that** I can hold off while something is sorted out and pick up exactly where we left off.

**Acceptance criteria**
- [ ] Given a lead running in a campaign, when I pause them, then their status becomes paused, their next scheduled send time is cleared, and the engine schedules nothing further for them.
- [ ] Given the lead has an email waiting in Needs your OK, when I pause them, then that draft is cancelled and disappears from the approval queue, so an old draft cannot be approved later by mistake.
- [ ] Given the lead has an email already approved and queued for a send slot, when I pause them, then the queued send is stopped before it leaves and the queue line reflects it.
- [ ] Given the lead is paused, when the engine ticks, then it skips them entirely — no timeout edge fires, and `no reply Xd` clocks do not advance while paused.
- [ ] Given a reply arrives from a paused lead, when the engine pulls it, then the reply is still ingested and shown in the Inbox and the lead is flagged for attention, because silence from us is not silence from them.
- [ ] Given the lead is in several campaigns, when I pause them in one, then the other campaigns are unaffected and the UI says so.
- [ ] Given I pause a lead, when I look at the activity trail, then there is one entry naming who paused whom, in which campaign, and when.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Pause a running lead | 200 with an ok result; the lead's status reads paused and its next send time is empty |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the lead stays running and the button reverts |
| TC-3 | Campaign not found / wrong workspace | Pause using another workspace's campaign id | 404 with a campaign-not-found error; nothing changes in either workspace |
| TC-4 | Validation failure | Pause with a non-numeric lead id | 422 naming the id parameter |
| TC-5 | Rate limited | Pause 150 leads from a bulk selection | 429 on some calls; the bulk action backs off and completes, final paused count matches the selection |
| TC-6 | Empty result set | Bulk pause with nothing selected | 200 with zero changes; the action is disabled in the UI so this is unreachable by hand |
| TC-7 | Pause with a draft waiting | Pause a lead whose email sits in Needs your OK | The draft is gone from the queue and cannot be approved |
| TC-8 | Pause an already-paused lead | Pause twice | Second call is a no-op returning success; no duplicate activity trail entry |
| TC-9 | Timeout does not fire while paused | Pause a lead on a `no reply 3d` edge, advance the clock four days | No email is drafted; on resume the timeout is evaluated from the resume point, not retroactively |
| TC-10 | Reply while paused | Simulate a reply from a paused lead | The reply appears in the Inbox and the lead is flagged for attention; no automatic send follows |
| TC-11 | Paused in one campaign only | Pause a lead enrolled in two campaigns | Only the named campaign shows paused; the other continues |

## 4. Frontend user story

**As a** campaign owner, **I want** pause to be a one-click action wherever I see a lead, with an obvious way back, **so that** holding off on someone never means deleting them and re-importing later.

**Scope**
- Leads and Campaigns → campaign detail: a "Pause in this campaign" row action, plus a bulk action on multi-select.
- Inbox → thread: the same action in the thread header, because pausing usually happens right after reading something.
- Dashboard → Action Center: paused leads appear alongside the leads already parked for a human decision, with the existing resume control, so there is one place where held work lives.
- Loading: the row is optimistic with a rollback on failure. Empty: the Action Center's existing empty state covers it. Error: the reason inline on the row.
- Accessibility: pause and resume are the same button with a changing accessible name, and the state is announced; the paused state is a text badge, not colour alone. Responsive: the row action collapses into the overflow menu under 640px.

**Definition of done**
- [ ] Pausing and resuming are reachable from Leads, campaign detail, Inbox thread and the Action Center.
- [ ] A paused lead is visibly paused in every list it appears in.
- [ ] Cancelling the draft is visible in Needs your OK without a reload.
- [ ] Bulk pause reports a per-lead result, not one silent success.

## 5. Backend user story

**As a** Harry API, **I want** pausing to be a single transactional state change the engine respects, **so that** a paused lead cannot be emailed by any path.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns/:campaignId/leads/:leadId/pause`, workspace-scoped, idempotent.
- Data model: a `paused_at` and `paused_by` on `campaign_leads` in `server/db.js` rather than a free-text status, so paused is derivable and cannot drift. Pending `drafts` rows for that campaign and lead are cancelled in the same transaction.
- Engine: `server/engine.js` skips paused campaign-lead rows in its tick, and `no reply Xd` timers are measured from the resume point rather than the original send, so a long pause does not immediately fire a timeout on resume.
- The mailer refuses to send for a paused campaign-lead as a second line of defence, so an approved-then-paused race cannot leak an email.
- Logged: an `events` row per pause (actor, lead, campaign); `telemetry` counts paused leads so Monitoring can show how much of a campaign is being held.

**Definition of done**
- [ ] Pause is idempotent and covered by a test that calls it twice.
- [ ] A paused lead is skipped by the engine and refused by the mailer, both covered by tests.
- [ ] Cancelled drafts cannot be approved, covered by a test.
- [ ] Timeout clocks resume rather than fire retroactively, covered by a clock-advance test.

## 6. End-to-end test ticket

**Title:** E2E — Pause a lead mid-playbook and confirm nothing reaches them

**Preconditions:** A workspace with one sandbox mailbox, a campaign whose playbook has a Send node and a `no reply 3d` edge, and two leads attached, one with a draft waiting for approval.

**Flow**
1. Launch the campaign and let the engine draft the first emails.
2. Inbox → Needs your OK → confirm two drafts are waiting.
3. Leads → pause the lead with the waiting draft.
4. Return to Needs your OK.
5. Advance the sandbox clock four days and let the engine tick.
6. Simulate a reply from the paused lead.
7. Dashboard → Action Center.

**Assertions**
- [ ] After pausing, the draft is gone from Needs your OK and one draft remains.
- [ ] After four days, the unpaused lead has a follow-up drafted and the paused lead has nothing.
- [ ] The sandbox mailbox records no send to the paused lead at any point.
- [ ] The simulated reply appears in the Inbox and flags the paused lead for attention.
- [ ] The paused lead appears in the Action Center with a resume control.
- [ ] The activity trail names who paused the lead and when.

**Teardown:** Resume both leads, delete the campaign and its leads, clear the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | Pause row action and bulk pause | Low | Joins the existing row menu; the paused badge reuses the stage strip's styling |
| Campaigns → campaign detail | Same action on the attached-leads table | Low | Identical component to Leads |
| Inbox → thread | Pause in the thread header | Low | One button beside the existing reply controls |
| Dashboard → Action Center | Paused leads listed with the existing resume control | Low | The Action Center already exists for exactly this kind of held work |

**Verdict:** Fits an existing surface

Harry's Dashboard already has an Action Center listing every lead parked for a human decision, with resume — pausing is the manual way into that same state. The work is mostly engine-side (skip the lead, cancel the draft, hold the timeout clock); the UI cost is one row action reused in four places.
