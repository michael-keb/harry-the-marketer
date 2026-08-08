# Get Lead Tasks

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/crm/leads/tasks/{id}` |
| **Category** | lead-tasks |
| **Source** | https://api.smartlead.ai/api-reference/lead-tasks/get-all |
| **Auth** | API key (query param `api_key`) |

Returns every task on one person, each with its name, description, priority, due date and whether it is still pending.

## 1. Epic

**Human follow-up work on a prospect**

The parts of a deal Harry cannot do itself: send the deck, phone them back on Thursday, chase legal on the agreement. It matters because the playbook covers email and the moment a lead says yes the work moves off email, where today it disappears into someone's memory and the campaign quietly stalls.

## 2. User story

**As a** workspace member, **I want** to see every task on a lead with its status, priority and due date, **so that** before I contact someone I know what my colleagues have promised them and what is overdue.

**Acceptance criteria**
- [ ] Given a lead with tasks, when I read them, then each returns its id, the lead it belongs to, its name, description, priority, due date, status and created-at.
- [ ] Given a mix of pending and completed tasks, when they render, then pending come first ordered by due date with overdue at the top, and completed are behind a "show completed" toggle.
- [ ] Given a task with no due date, when it renders, then it sorts after the dated ones rather than being treated as overdue.
- [ ] Given a lead with no tasks, when I open the panel, then an empty state offers to add one rather than showing a blank area.
- [ ] Given a lead in another workspace, when I request its tasks, then nothing is returned — tasks respect the same workspace boundary as leads and notes.
- [ ] Given tasks were created in different campaigns, when they render on the lead detail, then each is labelled with its campaign so a promise made in one campaign is not read as context for another.
- [ ] Given a task's creator has left the workspace, when it renders, then their name still shows and the task is flagged as unowned so it can be picked up rather than lost.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Read the tasks for a lead with one pending high-priority task | 200 with one task carrying id, lead id, name, description, priority, due date, status and created-at |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the panel shows a sign-in prompt, not "no tasks" |
| TC-3 | Not found / wrong workspace | Read tasks for a lead id in another workspace | 404; no task details leak |
| TC-4 | Validation failure | Read tasks with a non-numeric lead id | 422 naming the id parameter |
| TC-5 | Rate limited | Reopen a thread repeatedly, refetching each time | 429 after the burst; the client caches per lead for the session and refetches only after a write |
| TC-6 | Empty result set | Read tasks for a lead that has none | 200 with an empty list; the panel shows "No tasks" with an add control |
| TC-7 | Ordering | Read a lead with an overdue task, a task due next week, a task with no due date and a completed task | Overdue first, then next week, then undated; completed hidden behind the toggle |
| TC-8 | Mixed priorities on the same day | Two tasks due the same day, one high and one low | High sorts first; priority is shown as text, never colour alone |
| TC-9 | Cross-campaign labelling | Read a lead with tasks from two campaigns | Each task is labelled with its campaign; campaign-less tasks are grouped as general |
| TC-10 | Departed creator | Read a task created by a removed workspace member | The name still shows and the task is flagged as unowned |
| TC-11 | Many tasks | Read a lead with 100 tasks | The panel shows the pending ones and pages the completed ones; first render is not delayed by the tail |

## 4. Frontend user story

**As a** workspace member, **I want** a lead's open tasks visible wherever I am about to act on that lead, **so that** I never send an email that contradicts a promise a colleague already made.

**Scope**
- Leads → lead detail: a tasks panel beside notes, pending first, with the campaign label on each.
- Inbox → thread: the open tasks show in the thread header as a short line ("1 overdue task: Send 50-seat pricing"), expanding to the full panel on click.
- Dashboard → Action Center: the same data across all leads, sorted by due date with overdue first, sitting in the existing list of work waiting on a human — this is the primary place tasks are worked, not the lead detail.
- Inbox → Needs your OK: a draft for a lead with an open task carries a marker naming it, so the approver can hold off.
- Loading: skeleton rows; the header line does not shift the layout when it resolves. Empty: "No tasks" with an add control. Error: inline retry that keeps the panel open.
- Accessibility: tasks are a list with status, priority and due date as text; overdue is stated in words; the completed toggle is a real button with a count. Responsive: the panel becomes a tab beside messages under 768px.

**Definition of done**
- [ ] Open tasks are visible in the Inbox thread without a click.
- [ ] The Action Center is the place tasks are worked; the lead panel is for context.
- [ ] Overdue and priority never depend on colour alone.
- [ ] Completed tasks are retained and readable, not deleted.

## 5. Backend user story

**As a** Harry API, **I want** one workspace-scoped task query per lead and one across all leads, **so that** both the lead panel and the Action Center read the same rows the same way.

**Scope**
- Routes in `server/routes.js`: `GET /api/leads/:id/tasks`, and `GET /api/tasks` for the Action Center accepting `status`, `dueBefore` and `assignedTo`, both workspace-scoped.
- Data model: reads the `lead_tasks` table introduced by the create endpoint, joined to users for the creator and assignee names and to campaigns for the label. Completed tasks are kept with a completed-at rather than deleted, so the record of what was promised survives.
- Ordering: pending before completed; within pending, overdue first, then by due date ascending, then by priority, tie-broken by id so paging is stable. Undated tasks sort last, never as overdue.
- Cursor paging for the completed tail; the pending set is small enough to return whole. Standard rate limiting, with the client caching per lead for the session.
- Logged: `telemetry` for open and overdue counts per workspace, so Monitoring can show human follow-up falling behind the pipeline. No `events` row for reads.

**Definition of done**
- [ ] Both routes share one ordering implementation.
- [ ] Undated tasks never appear as overdue, covered by a test.
- [ ] Removing a workspace member leaves their tasks readable and flags them unowned, covered by a test.
- [ ] Cross-workspace lead ids return 404 and leak nothing.

## 6. End-to-end test ticket

**Title:** E2E — See a lead's outstanding tasks before replying to them

**Preconditions:** A workspace with two members, one lead in two campaigns with four tasks (one overdue, one due next week, one undated, one completed), one of them created by a member who is then removed.

**Flow**
1. Sign in as member B and open Inbox → the lead's thread.
2. Read the header line without clicking.
3. Expand the tasks panel and toggle "show completed".
4. Open Dashboard → Action Center.
5. Remove the departed member in Settings → Team and reload.
6. Open Inbox → Needs your OK for a draft on that lead.

**Assertions**
- [ ] The thread header states the overdue task by name without a click.
- [ ] The panel orders overdue, then next week, then undated; the undated one is not marked overdue.
- [ ] "Show completed" reveals the completed task with its completion time, and it was not deleted.
- [ ] The Action Center lists the same pending tasks mixed with the leads parked for a decision, overdue first.
- [ ] The departed member's task still shows their name and is flagged as unowned.
- [ ] The draft carries a marker naming the open task and is still approvable.

**Teardown:** Delete the tasks and the lead; restore the removed member if the fixture is reused.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Dashboard → Action Center | Tasks listed with the leads already parked for a decision | Low | The Action Center exists for exactly this; no second to-do list is created |
| Inbox → thread | One-line open-task summary in the header | Medium | A single line that expands; it does not push the messages down when empty |
| Leads → lead detail | Tasks panel beside notes | Low | Collapsed when empty; same list component as notes |
| Inbox → Needs your OK | Task marker on affected drafts | Low | A badge on an existing card |

**Verdict:** Fits an existing surface

The Action Center already collects every lead waiting on a human, so tasks have a home the moment they exist; adding a standalone Tasks page would split the same work across two screens and invite people to check neither. The one judgement call is the thread-header summary, which earns its line because the cost of not seeing an overdue promise is an email that contradicts it.
