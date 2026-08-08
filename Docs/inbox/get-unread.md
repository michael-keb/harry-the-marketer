# Get Unread Replies

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/unread-replies` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-unread |
| **Auth** | API key (query param `api_key`) |

Lists the replies nobody has read yet, newest first, with how long each has been waiting.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member starting the day, **I want** the unread replies in one list with how long each has waited, **so that** I answer people in the order that keeps them warm rather than the order I happen to click.

**Acceptance criteria**
- [ ] Given unread replies exist, when I list them, then each row returns the `lead` (`email`, `first_name`, `last_name`, `company`), the `campaign`, the `email_account`, the `last_message` (`subject`, `body`, `received_at`, `sent_from`, `sent_to`), the `email_status`, the `category`, the `assigned_to` member, `is_read: false`, `is_important` and `reply_age_hours` — plus `total_count`, `offset` and `limit`.
- [ ] Given `reply_age_hours`, when a row renders, then the wait is shown in words ("waiting 2.5 hours") and rows past a stated threshold are marked as overdue in text.
- [ ] Given `sortBy` of `REPLY_TIME_DESC` (default) or `SENT_TIME_DESC`, when I list, then the order matches.
- [ ] Given the documented ceilings — 5 campaigns, 10 mailboxes, 10 members, 10 tags, 10 clients, 10 categories, 30-character search, `limit` 1–20 — when I exceed one, then I get 422 with `field`, `provided_count` and `max_allowed`.
- [ ] Given everything is read, when I open the view, then I get 200 with an empty list and an empty state that says so plainly rather than showing a spinner.
- [ ] Given I open a thread, when the fetch completes, then that conversation is marked read for the whole workspace and the unread count drops by one everywhere it is shown.
- [ ] Given a teammate reads a thread, when I refresh, then it is read for me too — read state is shared because the workspace shares the inbox.
- [ ] Given a conversation is snoozed or archived, when I list unread, then it is excluded, so the unread count only counts work that is actually in front of someone.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"filters": {"emailStatus": "Replied"}, "sortBy": "REPLY_TIME_DESC", "limit": 20}` with three unread replies | 200 with three rows, each `is_read: false` and carrying `reply_age_hours`; `total_count: 3` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; the badge does not reset to zero on error |
| TC-3 | Not found / wrong workspace | Filter by a `campaignId` from another workspace | 404 or an empty result with no cross-workspace rows |
| TC-4 | Validation failure — campaign ceiling | POST `filters.campaignId` with 7 ids | 422, `{"error": "campaignId array cannot exceed 5 items", "field": "filters.campaignId", "provided_count": 7, "max_allowed": 5}` |
| TC-5 | Rate limited | Poll the unread count every second | 429 on the excess; the badge keeps its last known value and the client backs off with jitter rather than flashing zero |
| TC-6 | Empty result set | Open the view with everything read | 200, empty list, `total_count: 0`; empty state reads "All caught up" |
| TC-7 | Read on open | Open an unread thread, then re-list | The row is gone from unread and the badge decreased by exactly one |
| TC-8 | Shared read state | Member A opens a thread; member B refreshes | B sees it as read; the workspace has one unread count, not one per person |
| TC-9 | Age accuracy | Simulate a reply received 2.5 hours ago | `reply_age_hours` is 2.5 and the row reads "waiting 2.5 hours"; past the overdue threshold the row says so in text |
| TC-10 | Snoozed and archived excluded | Snooze one unread thread and archive another | Both leave the unread list and the count drops by two |
| TC-11 | History off by default | List without `fetch_message_history` | Only `last_message` is returned; opening a thread issues the detail request |
| TC-12 | Badge matches list | Compare the badge with `total_count` after several reads and a new reply | They agree at every step, because both derive from the same query |

## 4. Frontend user story

**As a** team member, **I want** an unread count on the Inbox and a one-click unread filter, **so that** "what still needs me" is answerable at a glance from anywhere in the app.

**Scope**
- App shell: the Inbox navigation item carries an unread count badge, alongside the count already implied by Needs your OK, with the two clearly distinguished — one is drafts awaiting approval, the other is replies awaiting a read.
- Inbox → Replies: "Unread" joins the same filter group as important, snoozed and archived, and rows show the waiting time in words with an overdue label past the threshold.
- Opening a thread marks it read for the workspace; a "Mark unread" action in the thread header allows putting it back for someone else to handle.
- Loading: skeleton rows; the badge shows its last known value rather than zero while loading. Empty: "All caught up." Error: inline banner with Retry; the badge is never reset by a failed poll.
- Accessibility: the badge has an accessible name stating what it counts ("4 unread replies"); unread is conveyed in text as well as weight; waiting times give an absolute timestamp in the accessible name. Responsive: the badge collapses to a dot with the count in the accessible name under 640px.

**Definition of done**
- [ ] The badge is accurate, shared across the workspace, and never flashes zero on a failed request.
- [ ] Unread filter, waiting time and overdue labelling all work with the shared filter bar.
- [ ] Mark unread restores a thread to the queue and increments the badge.
- [ ] Loading, empty, error and stale-badge states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** an unread filter and a cheap count route sharing one query with the rest of the Inbox, **so that** the badge cannot disagree with the list.

**Scope**
- Route in `server/routes.js`: extend `GET /api/inbox/threads` with `unread=true`, and add `GET /api/inbox/unread-count` returning the same number from the same predicate. `PATCH /api/inbox/threads/:id` accepts `{ read: true|false }`. All workspace-scoped, 404 outside the workspace.
- Data model: `read_at` and `read_by` on the thread grouping, indexed on (`workspace_id`, `read_at`, `last_reply_at`) so both the list and the count are single index scans. Read state is per workspace, not per user, matching how the product already shares leads, campaigns and inbox across a team.
- `reply_age_hours` is computed at read time from `last_reply_at`, never stored, so it cannot drift; the overdue threshold is a constant stated in one place and reused by the UI and any alerting.
- Rate limiting and caching: the count route is cached for a few seconds per workspace and invalidated on read/unread writes so a polling client is cheap; 429s are retried by the client with backoff and jitter.
- Snoozed and archived rows are excluded from both the list and the count by the same predicate, so the three features cannot drift apart.
- Logged: no event per read of the list; marking read or unread writes an `events` row with the actor. `telemetry` records the unread count and the oldest unread age so Monitoring can show a workspace falling behind.

**Definition of done**
- [ ] Unread filter, count route and read toggle exist and share one predicate, asserted by a test that compares them.
- [ ] A test asserts snoozed and archived threads are excluded from both.
- [ ] A test asserts read state is shared across two members of the same workspace.
- [ ] Unread count and oldest unread age appear in Monitoring telemetry.

## 6. End-to-end test ticket

**Title:** E2E — Clear the unread queue as a team without double-handling

**Preconditions:** A workspace with two members, a sandbox mailbox, a running campaign, four leads that have replied — one 3 hours ago, three within the last hour — nothing read, nothing snoozed.

**Flow**
1. Member A signs in and reads the Inbox badge from the navigation.
2. A opens the Replies tab with the Unread filter.
3. A opens the oldest thread, reads it, and returns to the list.
4. A snoozes one of the remaining threads until next week.
5. Member B signs in and opens the Unread filter.
6. B marks the thread A read as unread again.

**Assertions**
- [ ] The badge read 4 before anything was opened and stated what it counted in its accessible name.
- [ ] The oldest thread showed "waiting 3 hours" and sorted first under newest-reply order only if it was in fact the newest — otherwise the waiting time is still shown correctly.
- [ ] After A read it, the badge dropped to 3 for A and showed 3 for B as well.
- [ ] Snoozing dropped the badge to 2 and the snoozed thread appeared in neither the unread list nor the count.
- [ ] After B marked the thread unread, the badge rose to 3 for both members and the activity trail records who did it.

**Teardown:** Wake the snoozed thread, delete the campaign and leads, reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| App navigation | Unread badge on the Inbox item | Medium | One badge; it is clearly distinguished from the approval count by its accessible name and by grouping in the Inbox tabs, and it is suppressed at zero |
| Inbox → Replies | Unread filter value and waiting-time text on rows | Low | Joins the existing filter group; waiting time replaces nothing |
| Inbox thread header | Mark unread action | Low | One item in the existing header menu |
| Monitoring | Unread count and oldest unread age | Low | Two lines in the existing telemetry list |

**Verdict:** Fits an existing surface

Harry's Replies tab already lists every reply, but nothing tracks whether a human has actually looked at one, so "what still needs me" cannot be answered without reading the whole list. Unread state and a badge are the smallest addition that fixes it, and sharing read state across the workspace matches how the product already shares everything else — a per-user unread count would be the confusing choice here.
