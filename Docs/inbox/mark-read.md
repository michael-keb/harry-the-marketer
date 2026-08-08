# Change Read Status

| | |
|---|---|
| **Endpoint** | `PATCH https://server.smartlead.ai/api/v1/master-inbox/change-read-status` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/mark-read |
| **Auth** | API key (query param `api_key`) |

Marks one conversation read or unread, so a thread can be cleared from the queue or deliberately put back into it.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member triaging replies, **I want** to mark a conversation read or unread explicitly, **so that** the queue reflects what I have actually dealt with rather than what I happened to click on.

**Acceptance criteria**
- [ ] Given a conversation id (`email_lead_map_id`, the `campaign_lead_map_id` from the list endpoints) and a boolean `read_status`, when I send the change, then the response confirms with `is_read` and an `updated_at` timestamp.
- [ ] Given `read_status: true`, when applied, then the conversation leaves the unread list and the unread badge decreases by one; given `false`, then it returns to the unread list and the badge increases.
- [ ] Given a non-boolean `read_status`, when I send it, then I get 422 with the message that `read_status` must be a boolean and nothing changes.
- [ ] Given a conversation id from another workspace, when I send the change, then I get 404 and nothing changes.
- [ ] Given the same value is sent twice, when the second call lands, then it succeeds without changing anything — the operation is idempotent.
- [ ] Given several conversations selected in the list, when I mark them all read, then each is changed and a failure on one is reported per row rather than failing the whole batch silently.
- [ ] Given the deprecated pattern of a separate mark-unread call, when Harry implements this, then a single route takes the target state as a parameter rather than two routes with opposite meanings.
- [ ] Given a read-state change, when it completes, then it is recorded with the actor so a teammate can see who cleared a thread.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, mark read | PATCH `{"email_lead_map_id": 2433664091, "read_status": true}` | 200, `success: true`, `data.is_read: true`, `data.updated_at` present |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again" and reverts the optimistic row change |
| TC-3 | Not found / wrong workspace | PATCH with an id from another workspace | 404; nothing changes; UI shows "That conversation is not available" |
| TC-4 | Validation failure | PATCH `{"email_lead_map_id": 2433664091, "read_status": "yes"}` | 422, `{"error": "read_status must be a boolean value"}` |
| TC-5 | Rate limited | Mark 100 conversations read in a burst | 429 on the excess; the client backs off with jitter and retries the remainder; the badge settles at the correct number |
| TC-6 | Empty result set | Press "Mark all read" with nothing unread | The action is disabled with an explanatory title; no request is sent |
| TC-7 | Idempotence | Mark a read conversation read again | 200 with `is_read: true`; `updated_at` may change but no other effect and no duplicate event |
| TC-8 | Mark unread | PATCH `read_status: false` on a read conversation | 200, `is_read: false`; the conversation returns to the unread list and the badge increases |
| TC-9 | Batch with one failure | Select five conversations, one of which was just deleted, and mark all read | Four succeed, the deleted one reports 404 on its own row, and the UI states "4 of 5 marked read" |
| TC-10 | Missing required field | PATCH with `read_status` only | 422 naming `email_lead_map_id` |
| TC-11 | Shared state | Member A marks a thread read; member B refreshes | B sees it as read — read state is per workspace, matching the shared inbox |
| TC-12 | Race with a new reply | Mark a thread read at the same moment a new reply arrives on the engine tick | The new reply wins: the thread ends up unread, because an unseen message must never be hidden |

## 4. Frontend user story

**As a** team member, **I want** read and unread to be one control I can use on a row, in a thread, or across a selection, **so that** the unread count is something I control rather than something that happens to me.

**Scope**
- Inbox → Replies: a read/unread toggle on each row's overflow menu and in the thread header, plus multi-select with a "Mark read" bulk action in a selection toolbar.
- Opening a thread marks it read automatically; the thread header toggle allows putting it straight back to unread for someone else to pick up.
- Changes are optimistic — the row updates immediately and reverts with an inline message if the request fails, so triage stays fast on a slow connection.
- Loading: no spinner for a single toggle; the bulk action shows progress with a count. Empty: bulk actions disabled with a stated reason. Error: inline banner naming how many succeeded.
- Accessibility: the toggle is a button whose accessible name states the resulting action ("Mark thread with John Smith unread"); selection state and counts are announced; the bulk toolbar is reachable by keyboard and traps nothing. Responsive: multi-select uses long-press-free checkboxes that remain usable under 640px.

**Definition of done**
- [ ] Read and unread work from the row, the thread header and a multi-selection.
- [ ] Optimistic updates revert cleanly on failure with a message that names what failed.
- [ ] Bulk results report partial success honestly rather than claiming everything worked.
- [ ] Loading, disabled, partial-failure and revert states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** one route that sets read state to a supplied value, **so that** there is never a pair of opposite routes to keep in step.

**Scope**
- Routes in `server/routes.js`: `PATCH /api/inbox/threads/:id` accepting `{ read: true|false }`, and `PATCH /api/inbox/threads` accepting `{ ids: [], read: true|false }` for the bulk case with a per-id result array. Workspace-scoped, 404 for ids outside the workspace.
- Data model: `read_at` and `read_by` on the thread grouping, already indexed for the unread query. Setting read writes the timestamp and the actor; setting unread clears the timestamp but keeps a history entry.
- The engine takes precedence: when `server/engine.js` records a new inbound message it clears `read_at`, and the write is ordered so a concurrent mark-read cannot hide an unseen reply.
- Bulk writes run in one transaction per chunk with a per-id outcome returned, so a partial failure is reported rather than swallowed; the standard rate limiter applies and clients retry 429 with backoff and jitter.
- Logged: an `events` row per read-state change with actor and target state, coalesced for bulk actions into a single entry naming the count. `telemetry` counts bulk mark-read use so Monitoring can show a workspace clearing rather than reading.

**Definition of done**
- [ ] Single and bulk routes exist with per-id results, covered by tests including cross-workspace 404.
- [ ] A test asserts a concurrent inbound reply leaves the thread unread.
- [ ] A test asserts idempotence for repeated identical calls.
- [ ] Read-state changes appear in the activity trail with the actor.

## 6. End-to-end test ticket

**Title:** E2E — Triage a morning queue with read, unread and bulk clear

**Preconditions:** A workspace with two members, a sandbox mailbox, a running campaign, six leads that have replied, all unread.

**Flow**
1. Member A opens Inbox → Replies with the Unread filter; the badge reads 6.
2. A opens one thread, reads it, and returns to the list.
3. A marks that thread unread again from the row menu.
4. A selects four threads and presses Mark read.
5. Member B signs in and checks the unread badge.
6. Simulate a new reply on one of the threads A marked read and tick the engine.

**Assertions**
- [ ] Opening the thread dropped the badge to 5; marking it unread restored it to 6.
- [ ] The bulk action reported "4 marked read" and the badge fell to 2.
- [ ] B's badge reads 2 as well, confirming shared read state.
- [ ] After the new reply, that thread is unread again and the badge reads 3.
- [ ] The activity trail shows A's individual changes and one coalesced entry for the bulk action.

**Teardown:** Delete the campaign and leads, reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Read/unread toggle per row and a multi-select bulk action | Medium | The toggle lives in the row's existing overflow menu; the selection toolbar only appears once something is selected |
| Inbox thread header | Mark unread action | Low | One item in the header menu that already holds reclassify |
| App navigation | Badge responds to these actions | Low | Badge already exists for unread; this only changes what moves it |
| Dashboard activity trail | Read-state entries, coalesced for bulk | Low | One event type, deliberately summarised so the trail is not flooded |

**Verdict:** Fits an existing surface

Harry's Inbox has no read state at all today, so this is the write half of a genuinely new capability rather than a duplicate. The design decision worth recording is taking the target state as a parameter instead of shipping separate mark-read and mark-unread routes — the source API deprecated exactly that split, and there is no reason to repeat it.
