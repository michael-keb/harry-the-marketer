# Get Reminder Emails

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/reminders` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-reminders |
| **Auth** | API key (query param `api_key`) |

Lists conversations that have a reminder set, ordered by when the reminder is due, so overdue nudges surface first.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member who told a prospect "I'll check back next week", **I want** a list of every reminder I have set, oldest due first, **so that** my daily review starts with what I am already late on.

**Acceptance criteria**
- [ ] Given reminders exist, when I list them, then each row returns `campaign_lead_map_id`, the `lead`, the `reminder_time`, the `reminder_message` and `is_overdue`, plus `total_count`.
- [ ] Given `sortBy` of `REMINDER_TIME_ASC`, when I list, then overdue and earliest reminders come first — this is the recommended order for a daily review and is the default in the UI; `REMINDER_TIME_DESC` reverses it and any other value is rejected.
- [ ] Given this endpoint does not support `fetch_message_history`, when the list renders, then it shows only the reminder note and lead summary and opening a row loads the thread separately.
- [ ] Given `filters` for campaign (max 5), mailbox (max 10), team member (max 10), tag (max 10), client (max 10), category (max 10), engagement status or reply-time range, when I filter, then only matching reminders return and exceeding a ceiling returns 422 naming the field and its maximum.
- [ ] Given `limit` outside 1–20, when I list, then I get 422 with a field-level message.
- [ ] Given no reminders, when I open the view, then I get 200 with an empty list and an empty state that explains how to set one.
- [ ] Given a reminder falls due, when the time passes, then `is_overdue` becomes true and the item appears in the Dashboard Action Center alongside leads parked for a human decision.
- [ ] Given I act on a reminder or clear it, when it completes, then it leaves the list and the change is written to the activity trail with the actor.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"sortBy": "REMINDER_TIME_ASC", "limit": 20}` with three reminders set | 200 with `messages[]` ordered earliest first, each carrying `reminder_time`, `reminder_message`, `is_overdue`; `total_count: 3` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again" |
| TC-3 | Not found / wrong workspace | Filter by a `campaignId` from another workspace | 404 or an empty result with no cross-workspace rows |
| TC-4 | Validation failure — limit | POST `limit: 0` | 422 naming `limit` and the 1–20 range |
| TC-5 | Rate limited | Poll the reminder list aggressively | 429 on the excess; client backs off with jitter and keeps the last good page |
| TC-6 | Empty result set | Open the view with no reminders set | 200, empty list, `total_count: 0`; empty state reads "No reminders — set one from any thread" |
| TC-7 | Sort direction | List with `REMINDER_TIME_ASC`, then `REMINDER_TIME_DESC` | The order reverses exactly; the overdue item is first under ASC and last under DESC |
| TC-8 | Overdue flag flips | Set a reminder one minute ahead, wait for it to pass, list again | `is_overdue` changes from false to true with no other change, and the row gains an "Overdue" text label |
| TC-9 | Unsupported parameter | Send `fetch_message_history=true` | The parameter is ignored or rejected explicitly; the response never silently returns partial history the client then tries to render |
| TC-10 | Filter ceiling | POST `filters.campaignId` with 6 ids | 422 naming the 5-campaign maximum; the picker refuses a sixth selection |
| TC-11 | Cleared reminder | Clear a reminder from its thread, then list | It is gone from the list, `total_count` decreases, and the activity trail records who cleared it |

## 4. Frontend user story

**As a** team member, **I want** my reminders listed in the Inbox and surfaced on the Dashboard when they fall due, **so that** setting one is actually worth doing.

**Scope**
- Inbox → Replies: "Reminders" joins the same filter group as owner, important and archived, defaulting to earliest-due-first with the sort control offering "Due soonest" and "Due latest".
- Rows show the lead, the reminder note (`reminder_message`), the due time in the browser's timezone, and an "Overdue" text label where applicable. Because the endpoint carries no message history, each row links to the thread rather than expanding inline.
- Dashboard → Action Center: due and overdue reminders join the existing list of leads parked for a human decision, each linking to its thread.
- Loading: skeleton rows. Empty: "No reminders — set one from any thread" with a pointer to the thread action. Error: inline banner with Retry preserving filters.
- Accessibility: the sort is a labelled select; the overdue state is text and not colour alone; due times render as both relative ("2 days ago") and absolute on hover and in the accessible name. Responsive: the note truncates to one line under 640px with full text in the thread.

**Definition of done**
- [ ] The reminders view is reachable from the Replies tab filter group and defaults to earliest due first.
- [ ] Overdue reminders appear in the Dashboard Action Center and link to the thread.
- [ ] Clearing or acting on a reminder removes it from both places in the same interaction.
- [ ] Loading, empty, error and overdue states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** the inbox list route to filter on reminders and sort by due time, **so that** reminders reuse the one inbox query rather than adding a parallel one.

**Scope**
- Route in `server/routes.js`: extend `GET /api/inbox/threads` with `hasReminder=true` and `sort=reminder_asc|reminder_desc`, alongside the shared filters and the 20-row cap. Workspace-scoped, 404 for ids outside the workspace.
- Data model: `reminder_at`, `reminder_note` and `reminder_by` on the thread grouping (written by the set-reminder endpoint in this category), indexed on (`workspace_id`, `reminder_at`) so the due-first query is a single index scan. `is_overdue` is derived from `reminder_at < now()` at read time, never stored, so it cannot drift — the same principle Harry already applies to lead stages.
- Pagination: cursor on (`reminder_at`, id) with the hard cap of 20; `total_count` from a separate cheap count.
- Notifications: the existing Slack/Teams webhook gains an optional "reminders due today" ping, following the pattern used for replies and approvals — failures are telemetry, never a blocked send.
- Logged: no event per read; setting and clearing a reminder is logged by its own route. `telemetry` records overdue reminder counts so Monitoring can show a growing backlog.

**Definition of done**
- [ ] Reminder filter and both sort directions added to the shared route, covered by tests.
- [ ] `is_overdue` is computed, never stored, asserted by a test that moves the clock.
- [ ] The Action Center reads the same query, so the two can never disagree.
- [ ] Overdue counts appear in Monitoring telemetry.

## 6. End-to-end test ticket

**Title:** E2E — Work a daily reminder list, overdue first

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, three leads that have replied; reminders set on two of them — one due an hour ago with the note "Follow up on pricing question", one due next week.

**Flow**
1. Open Inbox → Replies and switch to the Reminders filter.
2. Confirm the sort defaults to due soonest.
3. Open the overdue reminder's thread from the row.
4. Return to the Dashboard and look at the Action Center.
5. Clear the overdue reminder from the thread.
6. Return to the Reminders view and the Dashboard.

**Assertions**
- [ ] Both reminders are listed with their notes and due times in the browser's timezone; the overdue one is first and labelled "Overdue" in text.
- [ ] The row links to the correct thread; no message history was fetched to render the list.
- [ ] The Action Center lists the overdue reminder with a link to the same thread.
- [ ] After clearing, the reminder is gone from both the Reminders view and the Action Center, and the count drops to one.
- [ ] The activity trail records who cleared it and when.

**Teardown:** Clear the remaining reminder, delete the campaign and leads, reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Reminders filter value and two reminder sort options | Low | Joins the existing filter group; the sort options only appear when the reminders filter is active |
| Inbox rows | Reminder note and due time shown in this view | Low | Replaces the last-message snippet in this view only, so the row does not grow |
| Dashboard → Action Center | Due and overdue reminders join the list | Low | The Action Center already answers "what needs me"; reminders are the same question |
| Settings → alerts | Optional "reminders due today" ping | Low | One more checkbox in the existing webhook section |

**Verdict:** Fits an existing surface

Harry has no reminder concept today, so the capability is new, but the places to put it already exist: a filter on the Replies tab and a row in the Action Center. Deriving overdue at read time rather than storing it matches how the product already derives lead stages, so a reminder can never show as due when it is not.
