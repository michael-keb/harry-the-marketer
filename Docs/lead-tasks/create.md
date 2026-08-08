# Create Lead Task

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/create-task` |
| **Category** | lead-tasks |
| **Source** | https://api.smartlead.ai/api-reference/lead-tasks/create |
| **Auth** | API key (query param `api_key`) |

Creates a to-do against one person in one campaign, with a name, an optional description, a priority and a due date.

## 1. Epic

**Human follow-up work on a prospect**

The parts of a deal Harry cannot do itself: send the deck, phone them back on Thursday, chase legal on the agreement. It matters because the playbook covers email and the moment a lead says yes the work moves off email, where today it disappears into someone's memory and the campaign quietly stalls.

## 2. User story

**As a** workspace member, **I want** to create a task against a lead with a due date and a priority, **so that** the off-email work a reply creates is captured the moment I read it rather than after I have forgotten.

**Acceptance criteria**
- [ ] Given a lead in a campaign, when I create a task, then it stores a name, an optional description, a priority of low, medium or high (defaulting to medium) and an optional due date, against that campaign-and-lead pairing.
- [ ] Given no priority is chosen, when the task is saved, then it defaults to medium rather than forcing a choice.
- [ ] Given no name, when I try to save, then it is refused with a field-level message; the description alone is not enough to identify a task in a list.
- [ ] Given a due date in the past, when I save, then it is accepted but flagged as overdue immediately rather than being silently rejected.
- [ ] Given the task is created, when I look at Dashboard → Action Center, then it appears alongside the leads already parked for a human decision, because both are the same thing to the user: work waiting on a person.
- [ ] Given a task exists on a lead, when the agent is about to send the next email to that lead, then nothing is blocked automatically — a task is a human's reminder, not a gate — but the pending task is shown on the draft in Needs your OK so the approver can decide.
- [ ] Given the task is created, when I read the activity trail, then there is one entry naming the actor, the lead and the task name.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Create a task with a name, description, high priority and a due date next week | 200 with the created task carrying its id, the campaign-lead reference, name, description, priority, due date and created-at |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the typed task is preserved in the form |
| TC-3 | Not found / wrong workspace | Create against a campaign-lead pairing from another workspace | 404; no task is created in either workspace |
| TC-4 | Validation failure — no name | Save with only a description | 422 with a field-level message on the name |
| TC-5 | Rate limited | Create tasks for 100 leads from a bulk action | 429 on some calls; the bulk action backs off and completes with a per-lead result |
| TC-6 | Empty result set | Open a lead with no tasks | The tasks panel shows "No tasks" with an add control, not a blank area |
| TC-7 | Invalid priority | Save with a priority outside low, medium and high | 422 naming the allowed values; the UI offers only the three |
| TC-8 | Default priority | Save without choosing a priority | Stored as medium and shown as medium, not as blank |
| TC-9 | Past due date | Save with a due date of yesterday | Accepted and immediately shown as overdue in the Action Center |
| TC-10 | Malformed due date | Save with a non-ISO date string | 422 naming the date format; the date picker prevents this by hand |
| TC-11 | Lead not in that campaign | Create referencing a lead and a campaign it is not attached to | 400 stating the lead is not in that campaign |
| TC-12 | Task on an unsubscribed lead | Create a task for an unsubscribed lead | Allowed — a task may be "phone them to confirm" — but the form shows the unsubscribed state and offers no email action |

## 4. Frontend user story

**As a** workspace member, **I want** to turn something I just read into a task without leaving the thread, **so that** the follow-up gets captured in the five seconds I have.

**Scope**
- Inbox → thread: an "Add task" control beside the existing reply and approval actions, opening a small form with name, optional description, priority and due date.
- Leads → lead detail: the same form in a tasks panel beside the notes panel.
- Dashboard → Action Center: open tasks appear in the existing list of work waiting on a human, sorted by due date with overdue first, alongside the leads parked for a decision.
- Inbox → Needs your OK: a draft for a lead with an open task shows a small marker naming the task, so the approver can hold off if the task should happen first.
- Loading: optimistic with rollback. Empty: "No tasks" with an add control. Error: the typed values survive and the reason shows inline.
- Accessibility: priority is a labelled radio group with text labels, not colour alone; overdue is stated in words; the date picker accepts typed dates. Responsive: the form is a full-width sheet under 640px.

**Definition of done**
- [ ] A task can be created from the Inbox thread in one interaction beyond the click.
- [ ] Tasks appear in the Action Center, not in a separate to-do page.
- [ ] Overdue is visible as text, and priority never relies on colour alone.
- [ ] A pending task is visible on the lead's draft in Needs your OK.

## 5. Backend user story

**As a** Harry API, **I want** tasks stored against a campaign-and-lead pairing with an owner and a due date, **so that** the Action Center can show all human work in one query.

**Scope**
- Route in `server/routes.js`: `POST /api/leads/:leadId/tasks` taking `{ campaignId, name, description, priority, dueDate }`, workspace-scoped like the neighbouring lead handlers.
- Data model: a new `lead_tasks` table in `server/db.js` (id, workspace, lead_id, campaign_id nullable, created_by, assigned_to, name, description, priority, due_at, status, created_at, completed_at), with a foreign key to `campaign_leads` validated on write.
- Priority is constrained to low, medium and high at the database level with medium as the default; due date is stored as UTC and rendered in the browser's timezone, matching how the sending rhythm already takes the timezone from the browser rather than asking.
- A task never blocks the engine. The mailer and engine are untouched; only the approval queue reads tasks, to display a marker.
- Standard rate limiting; the bulk create client retries 429 with backoff and dedupes on an idempotency key.
- Logged: an `events` row per task created (actor, lead, campaign, task name); `telemetry` counts open and overdue tasks so Monitoring can show whether human follow-up is keeping up with the pipeline.

**Definition of done**
- [ ] Priority and status are constrained in the schema, not only in the UI.
- [ ] Due dates round-trip correctly across timezones, covered by a test.
- [ ] Creating a task has no effect on engine scheduling, covered by a test.
- [ ] The Action Center reads tasks and parked leads in one query, not two round trips.

## 6. End-to-end test ticket

**Title:** E2E — Turn a reply into a task and see it surface where the work lives

**Preconditions:** A workspace with two members, one sandbox mailbox, a campaign with a reply-interested edge, and one lead who has replied asking for pricing.

**Flow**
1. Inbox → open the lead's thread → Add task: "Send 50-seat pricing", high priority, due tomorrow.
2. Create a second task due yesterday.
3. Open Dashboard → Action Center.
4. Let the engine compose the next email and open Inbox → Needs your OK.
5. Sign in as the second member and open Leads → the lead → tasks.
6. Open the Dashboard activity trail.

**Assertions**
- [ ] Both tasks appear on the lead immediately, with priority and due date as text.
- [ ] The Action Center lists both, overdue first, mixed in with any leads parked for a decision.
- [ ] The draft in Needs your OK shows a marker naming the open task, and the draft is still approvable — the task does not block it.
- [ ] The second member sees both tasks with the first member's name as creator.
- [ ] The activity trail has one entry per task naming the actor and the task name.

**Teardown:** Delete both tasks, the campaign and the lead; clear the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → thread | "Add task" control and a small form | Medium | One control beside the existing actions; the form is a sheet, not a page |
| Leads → lead detail | Tasks panel beside notes | Low | Collapsed when empty, same list styling as notes |
| Dashboard → Action Center | Tasks join the existing list of human work | Low | No new list — the Action Center already exists for work waiting on a person |
| Inbox → Needs your OK | Marker on drafts for leads with open tasks | Low | A short badge; it informs, it does not block |

**Verdict:** Fits an existing surface

Harry's Dashboard already has an Action Center holding every lead parked for a human decision, which is precisely where a task belongs — adding a separate Tasks page would split human work across two screens. The genuinely new part is the record itself and the marker on a pending draft, and neither needs a navigation item.
