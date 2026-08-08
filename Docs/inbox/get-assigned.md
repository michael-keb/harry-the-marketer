# Get Assigned to Me

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/assigned-me` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-assigned |
| **Auth** | API key (query param `api_key`) |

Lists only the conversations assigned to the person asking, so each team member has their own working queue instead of the whole workspace's.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member in a shared workspace, **I want** an "Assigned to me" view of the Inbox, **so that** I work my own leads instead of guessing which of the workspace's replies are mine.

**Acceptance criteria**
- [ ] Given threads assigned to me, when I open the view, then I get a page of at most 20 (`limit` must be 1–20) with `total_count`, `offset` and `limit` echoed, each row carrying the lead's `email`, `first_name`, `last_name`, the `campaign` name, the `last_message` subject, snippet and `received_at`, the `email_status`, the `category`, the `assigned_to` name and `is_read`.
- [ ] Given no assignment has been made anywhere in the workspace, when I open the view, then I get 200 with an empty list and an empty state that explains how assignment works, not a blank screen.
- [ ] Given `filters.search` up to 30 characters, when I search, then rows are matched on lead email, name or message content and the 30-character ceiling is enforced with a field-level message.
- [ ] Given `filters.emailStatus` set to one of `Opened`, `Clicked`, `Replied`, `Unsubscribed`, `Bounced`, `Accepted`, `Not Replied`, when I filter, then only matching rows return and any other value is rejected.
- [ ] Given `filters.replyTimeBetween` with two ISO 8601 datetimes, when I filter, then only threads whose reply time falls in that window return; a malformed date returns 422.
- [ ] Given `sortBy` is `REPLY_TIME_DESC` (the default) or `SENT_TIME_DESC`, when I list, then order matches; the default puts the most recent reply first because this is an action queue.
- [ ] Given `fetch_message_history` is false by default, when I render the list, then only summary fields are fetched; the full thread is loaded when a thread is opened.
- [ ] Given a lead is reassigned to someone else, when I refresh, then it leaves my view and appears in theirs, with the change in the activity trail.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"offset": 0, "limit": 20, "filters": {"emailStatus": "Replied"}, "sortBy": "REPLY_TIME_DESC"}` as a member with assigned threads | 200 with `messages[]`, each carrying `lead`, `campaign`, `last_message`, `category`, `assigned_to`, `is_read`; `total_count` present |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401, `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again" |
| TC-3 | Not found / wrong workspace | Filter by `campaignId` from another workspace | 404 or empty result with no cross-workspace rows; UI states the campaign is unavailable |
| TC-4 | Validation failure — limit | POST `limit: 50` | 422, `{"error": "limit must be between 1 and 20"}`; the page-size control offers only valid values |
| TC-5 | Rate limited | Poll the view every second for a minute | 429 on the excess; the client backs off with jitter and keeps the last good page on screen |
| TC-6 | Empty result set | Open the view as a member with nothing assigned | 200, `messages: []`, `total_count: 0`; empty state reads "Nothing assigned to you — assign a thread from Replies" |
| TC-7 | Search ceiling | POST `filters.search` with 31 characters | 422 naming the 30-character maximum; the input stops at 30 with a counter rather than failing |
| TC-8 | Bad date range | POST `replyTimeBetween: ["2025-01-01", "not-a-date"]` | 422 naming `replyTimeBetween` and requiring ISO 8601; the date picker cannot produce this state |
| TC-9 | Reassignment | Assign a thread to member B while member A has the view open, then refresh | The row leaves A's list and appears in B's; `assigned_to.name` reads B |
| TC-10 | Unread emphasis | Have one assigned thread with `is_read: false` | It is visually and textually marked unread and counts toward the "Assigned to me" badge |
| TC-11 | History off by default | List without `fetch_message_history` | No message bodies beyond the last-message snippet are returned; opening a thread issues the detail request |

## 4. Frontend user story

**As a** team member, **I want** an "Assigned to me" filter on the Inbox with a count, **so that** I can start my day on my own queue and still switch to the whole workspace when I want to.

**Scope**
- Inbox → Replies: an owner filter with "All", "Assigned to me" and "Unassigned", plus a small count beside "Assigned to me". Not a new tab — the two-tab shape (Needs your OK / Replies) stays.
- Needs your OK: the same owner filter, so an approver working their own leads is not shown the whole workspace's drafts.
- Rows show the assignee's name (from `assigned_to`) so ownership is visible even in the All view; unread rows are emphasised and counted.
- Filters for status, category, campaign, mailbox and reply-time range are shared with the other Inbox views so a user learns them once.
- Loading: skeleton rows; paging keeps the current page visible. Empty: "Nothing assigned to you" with a one-line explanation of assignment. Error: inline banner with Retry preserving filters.
- Accessibility: the owner filter is a labelled radio group; unread is conveyed by text as well as weight; the count is announced when it changes. Responsive: filters collapse into a Filters sheet under 768px.

**Definition of done**
- [ ] "Assigned to me" filters both Inbox tabs and shows an accurate count.
- [ ] Assignee names render on rows in every owner filter state.
- [ ] Reassignment updates both members' views on next refresh, with no stale row.
- [ ] Loading, empty, error and rate-limited states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** the inbox list route to accept an assignee filter, **so that** one query powers the workspace view and every member's personal view.

**Scope**
- Route in `server/routes.js`: extend the existing inbox list route with `assigneeId=me|<userId>|none`, alongside the shared filters (`search`, `status`, `categoryId`, `campaignId`, `mailboxId`, `repliedBetween`, `sort`, `cursor`, `limit` capped at 20). Workspace-scoped; a member may only pass `me` or a user in their own workspace.
- Data model: an `assigned_user_id` column on the thread grouping (see the assign-team-member endpoint in this category), indexed with (`workspace_id`, `assigned_user_id`, `last_reply_at`) so the personal queue query stays a single index scan.
- Pagination: cursor-based on the chosen sort key, hard cap 20, `total_count` computed separately and cached briefly so a badge does not cost a full count on every poll.
- Rate limiting: the badge count is served by a cheap count-only route with a short cache; clients poll it rather than re-running the full list, and 429s are retried with backoff and jitter.
- Logged: no event per read. `telemetry` records list latency and result size so Monitoring can show when a workspace's inbox query is degrading.

**Definition of done**
- [ ] Assignee filter added to the existing route with no separate endpoint, covered by tests including "a member cannot query another workspace's user".
- [ ] The index exists and a test asserts the query plan does not fall back to a scan on a seeded workspace.
- [ ] The count route and the list route agree, asserted by a test.
- [ ] Sort defaults to most recent reply first.

## 6. End-to-end test ticket

**Title:** E2E — Two team members work their own reply queues

**Preconditions:** A workspace with two members (A the owner, B invited via Settings → Team), a sandbox mailbox, one running campaign, four leads that have replied so four threads exist in Inbox → Replies, none assigned yet.

**Flow**
1. Member A opens Inbox → Replies and sets the owner filter to "Unassigned"; all four threads are listed.
2. A assigns two threads to B and one to themselves.
3. A switches the filter to "Assigned to me".
4. Member B signs in and opens Inbox → Replies with the filter on "Assigned to me".
5. B searches for one of their leads by surname.
6. A reassigns one of B's threads back to themselves; B refreshes.

**Assertions**
- [ ] A's "Assigned to me" shows exactly one thread; the badge count reads 1.
- [ ] B's "Assigned to me" shows exactly two threads, each showing B as assignee.
- [ ] The search returns the matching thread and nothing from the unassigned pool.
- [ ] "Unassigned" now shows exactly one thread for both members.
- [ ] After reassignment B sees one thread and A sees two, and the activity trail records the reassignment with the actor.

**Teardown:** Unassign all threads, delete the campaign and leads, reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Owner filter (All / Assigned to me / Unassigned) with a count | Medium | A filter on the existing tab, not a third tab; default stays All so a solo user sees no change |
| Inbox → Needs your OK | Same owner filter | Low | Identical control in the same position, learned once |
| Inbox rows | Assignee name shown | Low | One line of secondary text on a row that already carries campaign and time |
| Monitoring | Inbox query latency telemetry | Low | Invisible to users; one more line in the existing telemetry view |

**Verdict:** Fits an existing surface

Harry already has team workspaces where members share leads, campaigns and inbox, but it has no notion of who owns a given reply, so a personal queue is genuinely new. It belongs as a filter on the Replies tab rather than a new page, and a single-member workspace — the common case — never sees the control take effect because everything is simply unassigned.
