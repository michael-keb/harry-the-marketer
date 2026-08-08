# Create Lead Task

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/create-task` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/create-task |
| **Auth** | API key (query param `api_key`) |

Creates a named to-do against a lead, with an optional description, a priority and a due date, so a promised follow-up is not forgotten.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member working replies, **I want** to create a task on a lead with a title, priority and due date, **so that** the human step a reply asks for ("send the pricing sheet", "call them Thursday") is tracked rather than remembered.

**Acceptance criteria**
- [ ] Given a lead-campaign pairing (`email_lead_map_id`) and a task `name`, when I create a task, then it is stored and the response returns the new `task_id` alongside the `name`, `priority` and `due_date`.
- [ ] Given no explicit priority, when I create a task, then it defaults to `MEDIUM`; `LOW` and `HIGH` are the only other accepted values and anything else is rejected with a field-level message.
- [ ] Given a `due_date` in ISO 8601, when I create the task, then it is stored in UTC and displayed in the viewer's browser timezone, matching how Harry already takes the timezone from the browser.
- [ ] Given a missing `name`, when I submit, then the request is rejected with a field-level message and nothing is stored.
- [ ] Given a lead-campaign pairing from another workspace, when I create a task, then the request returns 404 and nothing is stored.
- [ ] Given an open task, when I mark it done, then it is recorded as complete with who completed it and when, and it leaves the open list without being deleted.
- [ ] Given a task whose due date has passed and which is still open, when I open Dashboard, then it appears in the Action Center as an overdue item alongside the leads already parked for a human decision.
- [ ] Given any task created, completed or deleted, when it completes, then an entry is written to the activity trail naming the actor.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path with all fields | POST `{"email_lead_map_id": 2433664091, "name": "Schedule demo call", "description": "Lead interested in enterprise plan", "priority": "HIGH", "due_date": "2025-01-25T14:00:00Z"}` | 200, `success: true`, `data.task_id` present, fields echoed back unchanged |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; the typed task is preserved |
| TC-3 | Not found / wrong workspace | POST with an `email_lead_map_id` from another workspace | 404; UI shows "That lead is not available"; nothing stored |
| TC-4 | Validation failure — missing name | POST without `name` | 422 with a field-level message on `name`; Save stays disabled in the UI |
| TC-5 | Rate limited | Create tasks in a tight burst | 429 on the excess; client backs off and retries once; no duplicate task created |
| TC-6 | Empty result set | Open the tasks list for a lead with none | 200 with an empty list; empty state reads "No tasks — add one if this needs a human step" |
| TC-7 | Invalid priority | POST `priority: "URGENT"` | 422 naming `priority` and listing `LOW`, `MEDIUM`, `HIGH` |
| TC-8 | Defaults applied | POST with only `email_lead_map_id` and `name` | 200 with `priority: "MEDIUM"` and `due_date` null; the UI shows "No due date" rather than a blank |
| TC-9 | Malformed due date | POST `due_date: "next Tuesday"` | 422 naming `due_date` and stating ISO 8601 is required |
| TC-10 | Due date in the past | POST a due date an hour ago | 200 (allowed) but the task renders as Overdue immediately and appears in the Action Center |
| TC-11 | Complete then reopen | Mark the task done, then reopen it | Both transitions are recorded with actor and timestamp; the task is never silently duplicated |

## 4. Frontend user story

**As a** team member, **I want** tasks visible where the work already happens — on the thread, on the lead, and in the Dashboard Action Center — **so that** I never need a separate tracker for outreach follow-ups.

**Scope**
- Inbox → Replies thread view: an "Add task" action beside Notes, opening a small form with title, optional description, priority (Low / Medium / High) and an optional due date. Open tasks for that lead are listed above the form with a checkbox to complete.
- Leads → lead detail: the same task list, aggregated across the lead's campaigns.
- Dashboard → Action Center: overdue and due-today tasks join the existing list of leads parked for a human decision, each linking straight back to the thread.
- Loading: skeleton rows. Empty: "No tasks." Error: inline banner with the typed form preserved.
- Accessibility: the form fields are labelled; priority is a real select with text labels, never colour alone; overdue state is announced as text ("Overdue by 2 days"), and the due-date input accepts typed dates as well as the picker. Responsive: the form stacks to one column under 640px.

**Definition of done**
- [ ] A task created from a thread appears immediately on the thread, the lead record and the Action Center when due.
- [ ] Completing a task removes it from the open list and Action Center but keeps it in history.
- [ ] Due dates render in the browser's timezone with no manual timezone setting.
- [ ] Loading, empty, validation-error and overdue states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** tasks stored against the lead-campaign pairing with priority, due date and completion state, **so that** the Action Center can show human work alongside agent work.

**Scope**
- Routes in `server/routes.js`: `POST /api/leads/:leadId/tasks` taking `{ campaignId, name, description, priority, dueAt }`, `GET /api/tasks?status=open&due=overdue`, `PATCH /api/tasks/:id` (complete / reopen / edit), `DELETE /api/tasks/:id`.
- Data model: a `lead_tasks` table in `server/db.js` (`workspace_id`, `lead_id`, `campaign_id`, `name`, `description`, `priority` constrained to LOW/MEDIUM/HIGH, `due_at` stored UTC, `status`, `created_by`, `completed_by`, `completed_at`), indexed on (`workspace_id`, `status`, `due_at`).
- Validation: `name` required and trimmed; `priority` defaults to MEDIUM and is rejected if outside the enum; `due_at` parsed as ISO 8601 and rejected otherwise; lead and campaign must be in the caller's workspace or 404.
- Pagination: the list route is cursor-paginated and sorted by due date then priority; the standard app rate limiter applies.
- Notifications: the existing Slack/Teams webhook gains an optional daily "tasks due today" ping, following the same pattern as the reply and approval pings — failures are telemetry, never a blocked send.
- Logged: an `events` row per create, complete, reopen and delete with actor; `telemetry` counts overdue tasks so Monitoring can show a backlog trend.

**Definition of done**
- [ ] Table, enum constraint, index and routes exist, covered by tests including cross-workspace 404.
- [ ] Overdue selection is computed from `due_at` in UTC and verified by a test crossing a timezone boundary.
- [ ] Action Center reads the same query the tasks list uses, so the two can never disagree.
- [ ] Create, complete and delete all appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Turn a reply into a tracked follow-up task

**Preconditions:** A workspace with two members, one sandbox mailbox, a running campaign, one lead that has replied asking for pricing so a thread exists in Inbox → Replies.

**Flow**
1. Open Inbox → Replies and select the lead's thread.
2. Choose "Add task", title it "Send pricing sheet", set priority High and a due date one hour in the past, and save.
3. Open Dashboard and look at the Action Center.
4. Open Leads → the same lead and confirm the task is listed.
5. Return to the thread and tick the task complete.
6. Reload the Dashboard.

**Assertions**
- [ ] The task appears on the thread with priority High and an "Overdue" text label.
- [ ] The Action Center lists the task as overdue with a link back to the thread.
- [ ] The lead record shows the same task with the campaign labelled.
- [ ] After completion the task leaves the Action Center and the open list but is still visible in the lead's history with the completer's name.
- [ ] The activity trail contains a task-created and a task-completed entry with the right actors.

**Teardown:** Delete the task, lead and campaign; reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies thread | "Add task" action and an open-task list | Medium | Shares the Notes panel as a two-tab strip rather than adding a second panel; hidden entirely when there are no tasks and none is being added |
| Leads → lead detail | Task list added | Low | Same card treatment as notes, directly beneath them |
| Dashboard → Action Center | Overdue tasks join the existing list | Low | The Action Center already exists for "things a human must do"; tasks are the same idea, so no new section |
| Settings → alerts | Optional "tasks due today" ping | Low | One more checkbox in the existing webhook section |

**Verdict:** Fits an existing surface

Harry already surfaces agent-generated human decisions in the Dashboard Action Center, but has no way to record a follow-up a person decided on themselves, so the capability is new. Putting tasks into the Action Center rather than building a to-do page keeps a single answer to "what needs me today" and adds no navigation item.
