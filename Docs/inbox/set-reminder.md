# Set Lead Reminder

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/set-reminder` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/set-reminder |
| **Auth** | API key (query param `api_key`) |

Sets a dated note against one message in a lead's thread, so a person is nudged to come back to it at the right time.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member who has just answered a prospect, **I want** to set a dated reminder against that exact message with a note, **so that** if they go quiet I am nudged with the context already attached.

**Acceptance criteria**
- [ ] Given a lead-campaign pairing (`email_lead_map_id`), a specific message (`email_stats_id`), a `message` note and an ISO 8601 `reminder_time`, when I set the reminder, then the response returns the new `reminder_id` with the time and note echoed back.
- [ ] Given a missing note or a missing time, when I submit, then I get 422 with a field-level message and nothing is stored.
- [ ] Given a malformed or past `reminder_time`, when I submit, then a malformed value is rejected with 422 and a past value is accepted but shown as overdue immediately, never silently ignored.
- [ ] Given several reminders on one lead, when I set another, then all coexist — multiple reminders per lead are supported and each is listed separately.
- [ ] Given a reminder exists, when I edit its note or time or cancel it before it triggers, then the change takes effect and is recorded with the actor.
- [ ] Given a reminder falls due, when the time passes, then it appears in the reminders view and the Dashboard Action Center, and the configured Slack or Teams webhook can ping — a failed ping is telemetry and never blocks anything.
- [ ] Given a lead-campaign pairing from another workspace, when I set a reminder, then I get 404 and nothing is stored.
- [ ] Given a reminder is set, when it is stored, then the time is held in UTC and displayed in the browser's timezone, matching how Harry already takes the timezone from the browser.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"email_lead_map_id": 2433664091, "email_stats_id": "abc-def-123", "message": "Follow up on pricing question", "reminder_time": "2025-01-27T14:00:00Z"}` | 200, `success: true`, `data.reminder_id` present, time and note echoed |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; the typed note is preserved |
| TC-3 | Not found / wrong workspace | POST with an `email_lead_map_id` from another workspace | 404; nothing stored |
| TC-4 | Validation failure — missing note | POST without `message` | 422 naming `message`; Save stays disabled in the UI |
| TC-5 | Rate limited | Set reminders in a tight burst | 429 on the excess; the client backs off and retries once; no duplicate reminder is created |
| TC-6 | Empty result set | Open the reminders list for a lead with none | 200 with an empty list; empty state reads "No reminders on this lead" |
| TC-7 | Malformed time | POST `reminder_time: "next Friday"` | 422 naming `reminder_time` and requiring ISO 8601 |
| TC-8 | Past time | POST a time an hour ago | 200; the reminder renders as overdue immediately and appears in the Action Center |
| TC-9 | Multiple reminders | Set two reminders on the same lead for different days | Both exist with distinct `reminder_id`s and both are listed |
| TC-10 | Edit and cancel | Change a reminder's time, then cancel it | Both operations succeed and are recorded in the activity trail with the actor |
| TC-11 | Message anchoring | Set a reminder on a specific message, then open the reminder | It links back to that exact message in the thread, not just the lead |
| TC-12 | Timezone correctness | Set "tomorrow 2pm" from a browser in Australia/Sydney | Stored in UTC, displayed as 2pm Sydney, and due at 2pm Sydney |

## 4. Frontend user story

**As a** team member, **I want** a Remind me control on any message in a thread with presets and a note, **so that** setting a nudge costs a few seconds at the moment I decide.

**Scope**
- Inbox → Replies thread view: "Remind me" on each message and in the thread header, opening a small form with presets ("Tomorrow", "In 3 days", "Next week", "Pick a date and time") and a note field prefilled with a suggestion drawn from the message subject, editable before saving.
- Existing reminders on the lead are listed in the same panel with their notes and due times, each with Edit and Cancel.
- Setting a reminder from a specific message anchors it there, so opening the reminder later returns to the exact message rather than the top of the thread.
- Loading: Save shows a pending state. Empty: "No reminders on this lead." Error: inline banner keeping the typed note and chosen time.
- Accessibility: presets state the resolved date when highlighted, not only after choosing; the note is a labelled input; overdue is text, not colour alone; the due time carries an absolute value in the accessible name. Responsive: the form becomes a bottom sheet under 640px.

**Definition of done**
- [ ] Reminders can be set, edited and cancelled from a message and from the thread header.
- [ ] The resolved date is always stated in words before saving.
- [ ] A due reminder links back to the exact message it was set on.
- [ ] Loading, empty, validation-error and overdue states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** reminders stored against the lead-campaign pairing and anchored to a message, **so that** the reminders view, the Action Center and the alerts all read one record.

**Scope**
- Routes in `server/routes.js`: `POST /api/inbox/threads/:id/reminders` taking `{ messageId, note, remindAt }`, `PATCH /api/reminders/:id`, `DELETE /api/reminders/:id`, `GET /api/reminders`. Workspace-scoped, 404 outside the workspace.
- Data model: a `lead_reminders` table in `server/db.js` (`workspace_id`, `campaign_lead_id`, `message_id`, `note`, `remind_at` stored UTC, `created_by`, `completed_at`), indexed on (`workspace_id`, `remind_at`) to support the due-first list. Multiple rows per lead are allowed by design.
- Overdue is derived at read time from `remind_at` versus now, never stored, so it cannot drift — the same principle Harry already applies to lead stages.
- Notifications: due reminders are included in the existing Slack/Teams webhook payloads, following the pattern already used for replies, approvals, decisions and signed agreements; a webhook failure is written to telemetry and never blocks a send or a tick.
- Validation: note required and trimmed with a stated maximum; `remind_at` parsed as ISO 8601; the message must belong to the named thread. Standard rate limiter; 429 retried by the client.
- Logged: an `events` row per reminder set, edited and cancelled with the actor; `telemetry` counts overdue reminders so Monitoring can show a backlog.

**Definition of done**
- [ ] Table, index and four routes exist, covered by tests including cross-workspace 404.
- [ ] A test asserts overdue is computed at read time across a timezone boundary.
- [ ] A test asserts a webhook failure does not block anything.
- [ ] Reminder set, edit and cancel appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Set a nudge on a specific message and be nudged with its context

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, one lead who has replied and been answered by hand, a Slack webhook configured in Settings pointing at a test receiver, browser timezone Australia/Sydney.

**Flow**
1. Open Inbox → Replies and open the lead's thread.
2. On the outbound answer, choose "Remind me", pick "In 3 days", accept the suggested note, and save.
3. Confirm the reminder is listed in the thread panel with its due time in Sydney time.
4. Advance test time past the due moment.
5. Open the Reminders view and the Dashboard Action Center.
6. Open the reminder, then cancel it.

**Assertions**
- [ ] The resolved date was shown in words before saving and matches Sydney time afterwards.
- [ ] The reminder appears on the lead, in the Reminders view and in the Action Center once due, labelled overdue in text.
- [ ] The test receiver got one webhook payload naming the lead and the note; a forced webhook failure in a repeat run changes nothing else.
- [ ] Opening the reminder returns to the exact message it was set on, not the top of the thread.
- [ ] Cancelling removes it from all three places and the activity trail records the actor.

**Teardown:** Delete the reminder, the campaign and the lead; reset the sandbox mailbox; remove the test webhook.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies thread | "Remind me" per message and a reminders list in the side panel | Medium | Shares the Notes and Tasks panel as one tabbed strip rather than adding a third panel; hidden when empty |
| Dashboard → Action Center | Due reminders join the existing list | Low | The Action Center already answers "what needs me"; reminders are the same question |
| Settings → alerts | Reminders included in the existing webhook pings | Low | One more checkbox in the section that already exists |
| Monitoring | Overdue reminder count | Low | One line in the existing telemetry list |

**Verdict:** Fits an existing surface

Harry has no reminder concept today — the closest thing is the engine's own `no reply Xd` timeout, which nudges the agent rather than the person — so this is a genuine gap for anything a human promised to do. Anchoring reminders to a specific message is what makes them worth setting, and putting them in the same side panel as notes and tasks keeps the thread view from growing a third column.
