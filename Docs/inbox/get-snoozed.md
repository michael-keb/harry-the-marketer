# Get Snoozed Emails

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/snoozed` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-snoozed |
| **Auth** | API key (query param `api_key`) |

Lists conversations that have been hidden until a chosen date and time, with the moment each one comes back.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member facing a reply that says "ask me again in March", **I want** to snooze the conversation until then, **so that** it leaves my queue now and comes back on its own instead of relying on my memory.

**Acceptance criteria**
- [ ] Given snoozed conversations, when I list them, then each row returns `campaign_lead_map_id`, the `lead`, the `snoozed_until` timestamp and the `email_status`, plus `total_count`.
- [ ] Given a conversation is snoozed, when I open the Replies tab, then it is not listed there; when `snoozed_until` passes, then it reappears automatically as unread with its intent chip intact.
- [ ] Given a prospect replies to a snoozed conversation before the snooze expires, when the engine pulls the reply, then the snooze is cancelled and the conversation comes back immediately — a live reply always beats a snooze.
- [ ] Given `filters` for campaign (max 5), mailbox (max 10), team member, tag, client and category (max 10 each), engagement status or reply-time range, when I filter, then only matching rows return and exceeding a ceiling returns 422 naming the field and its maximum.
- [ ] Given `limit` outside 1–20, when I list, then I get 422 with a field-level message.
- [ ] Given nothing is snoozed, when I open the view, then I get 200 with an empty list and an empty state explaining what snoozing does.
- [ ] Given the lead is mid-playbook, when I snooze the conversation, then the playbook is unaffected — snoozing hides a thread from a human's view and never pauses the engine; pausing a lead is a separate, explicit action.
- [ ] Given I snooze or wake a conversation, when it completes, then the change is written to the activity trail with the actor and the chosen time.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"offset": 0, "limit": 20, "filters": {"campaignId": 12345, "leadCategories": {"categoryIdsIn": [1]}}}` with two snoozed conversations | 200 with both rows carrying `snoozed_until` and `email_status`; `total_count: 2` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again" |
| TC-3 | Not found / wrong workspace | Filter by a `campaignId` from another workspace | 404 or an empty result with no cross-workspace rows |
| TC-4 | Validation failure — limit | POST `limit: 21` | 422 naming `limit` and the 1–20 range |
| TC-5 | Rate limited | Poll the snoozed list aggressively | 429 on the excess; client backs off with jitter and keeps the last good page |
| TC-6 | Empty result set | Open the view with nothing snoozed | 200, empty list, `total_count: 0`; empty state reads "Nothing snoozed — snooze a thread to hide it until a date you choose" |
| TC-7 | Automatic wake | Snooze a conversation for one minute ahead, wait, refresh Replies | It reappears in Replies marked unread and is gone from the snoozed list |
| TC-8 | Reply beats snooze | Snooze for next week, then simulate a prospect reply on the sandbox mailbox and tick the engine | The snooze is cancelled, the conversation is back in Replies immediately, and the activity trail records why it woke early |
| TC-9 | Playbook untouched | Snooze a lead sitting at a `no reply 3d` edge, then let three days elapse in test time | The engine still follows the edge and composes the follow-up draft; snoozing changed only what the human saw |
| TC-10 | Filter ceiling | POST `filters.emailAccountId` with 11 ids | 422 naming the 10-mailbox maximum; the picker refuses an eleventh |
| TC-11 | Wake manually | Wake a snoozed conversation before its time | It returns to Replies straight away and the activity trail records the actor |
| TC-12 | Timezone correctness | Snooze until "tomorrow 9am" from a browser in Australia/Sydney | `snoozed_until` is stored in UTC and wakes at 9am Sydney time, using the timezone Harry already takes from the browser |

## 4. Frontend user story

**As a** team member, **I want** a Snooze action on a thread with sensible presets and a Snoozed view, **so that** hiding something for later takes two clicks and I can always see what I hid.

**Scope**
- Inbox → Replies: a Snooze action on each row and in the thread header, offering "Tomorrow morning", "Next week", "In a month" and "Pick a date and time", with the resolved date always stated in words before confirming.
- "Snoozed" joins the same filter group as scheduled, reminders and archived; rows show the lead, the campaign, and when it comes back, plus a Wake now action.
- Snooze and Pause lead are visually and textually separated, with one line of help each, because one hides a thread and the other stops the engine — confusing them would break outreach.
- Loading: skeleton rows. Empty: "Nothing snoozed" with a one-line explanation. Error: inline banner with Retry preserving filters.
- Accessibility: the snooze menu is a labelled menu with keyboard navigation; the resolved date is announced when a preset is highlighted, not only after choosing; wake-time text is absolute as well as relative. Responsive: the preset menu becomes a bottom sheet under 640px.

**Definition of done**
- [ ] Snooze works from the row and the thread header with presets and a custom picker, always confirming the resolved date in words.
- [ ] Snoozed conversations disappear from Replies and reappear at the right local time.
- [ ] Snooze is never confusable with Pause lead — separate labels, separate help text, verified in review.
- [ ] Loading, empty, error and early-wake states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a snooze timestamp on the thread that the inbox query respects, **so that** hiding a conversation is a read-side concern and never touches the engine.

**Scope**
- Route in `server/routes.js`: extend `GET /api/inbox/threads` with `state=snoozed` and add `PATCH /api/inbox/threads/:id` accepting `{ snoozedUntil: <ISO 8601> | null }`. Workspace-scoped, 404 outside the workspace.
- Data model: `snoozed_until` and `snoozed_by` on the thread grouping, indexed on (`workspace_id`, `snoozed_until`). The active Replies query excludes rows whose `snoozed_until` is in the future; no background job is needed because expiry is evaluated at read time and therefore cannot drift.
- Wake-on-reply: `server/engine.js` clears `snoozed_until` when it pulls a new inbound message for that thread, so a live conversation is never hidden.
- Explicit separation: snoozing writes nothing to the lead's playbook state; the pause/resume mechanism stays a separate route so the two cannot be conflated in code either.
- Pagination and ceilings mirror the other inbox views (limit capped at 20, 5 campaigns, 10 mailboxes/members/tags/clients/categories); 429 retried with backoff and jitter by the client.
- Logged: an `events` row per snooze, manual wake and automatic wake, each with actor or cause; `telemetry` records snoozed-thread counts so Monitoring can show a workspace deferring rather than deciding.

**Definition of done**
- [ ] Snooze column, index, list state and toggle route exist, covered by tests including cross-workspace 404.
- [ ] A test asserts expiry is evaluated at read time with no scheduled job.
- [ ] An engine test asserts a snoozed lead still advances through its playbook and that an inbound reply clears the snooze.
- [ ] Snooze and wake appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Defer a "not now" reply and have it come back on time

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, three leads that have replied — one saying "ask me again next quarter" — approvals on, browser timezone set to Australia/Sydney.

**Flow**
1. Open Inbox → Replies and open the "not now" thread.
2. Snooze it with "Pick a date and time", choosing tomorrow 9am, and read the confirmation.
3. Return to Replies and confirm two threads remain.
4. Switch to the Snoozed view.
5. Advance test time past 9am Sydney and refresh Replies.
6. Snooze it again for next week, then simulate a new prospect reply and tick the engine.

**Assertions**
- [ ] The confirmation stated the resolved date in words in Sydney time before the snooze was applied.
- [ ] The thread left Replies immediately and appeared in Snoozed with its wake time.
- [ ] After 9am Sydney it is back in Replies, marked unread, with its intent chip unchanged.
- [ ] The prospect's new reply cancelled the second snooze at once, and the activity trail says it woke because of a reply.
- [ ] Throughout, the lead's playbook position never changed as a result of snoozing.

**Teardown:** Wake everything, delete the campaign and leads, reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Snooze action per row and in the thread header, plus a Snoozed filter value | Medium | Action lives in the row's existing overflow menu; the filter joins the group that already holds archived and important |
| Inbox rows | Wake time shown in the Snoozed view | Low | Replaces the snippet in that view only |
| Dashboard → Action Center | Unchanged — snoozed threads are deliberately not shown | Low | Keeps the Action Center honest about what needs a human now |
| Monitoring | Snoozed-thread count telemetry | Low | One line in the existing telemetry list |

**Verdict:** Fits an existing surface

Harry's Inbox has no way to defer a thread; the only options today are answer it or leave it sitting, which is why "not now" replies accumulate. Snooze is genuinely new, but it belongs beside archive as another way to clear the queue, and keeping it strictly read-side means it can never quietly change what the engine does — the one risk worth guarding against here.
