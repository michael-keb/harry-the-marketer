# Get Archived Emails

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/archived` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-archived |
| **Auth** | API key (query param `api_key`) |

Lists conversations that have been put out of the way, so a finished thread stops cluttering the inbox but can still be found.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member working replies, **I want** to archive a finished conversation and still be able to list archived ones later, **so that** my inbox only shows threads that still need me, without anything being deleted.

**Acceptance criteria**
- [ ] Given archived threads exist, when I list them with `limit` and `offset`, then I get a page of at most 20 records (the documented maximum) plus a `total_count` so the UI can show "showing 20 of 143".
- [ ] Given `sortBy` is `REPLY_TIME_DESC` or `SENT_TIME_DESC`, when I list, then the order matches, and any other value is rejected with a field-level message.
- [ ] Given `filters` with a campaign or mailbox selection, when I list, then only archived threads matching them are returned; the documented ceilings apply — at most 5 campaigns and at most 10 mailboxes per request.
- [ ] Given `fetch_message_history` is false (the default), when I list, then each row carries only the summary fields needed to render the list; when it is true, the full thread history is included.
- [ ] Given no archived threads, when I list, then I get 200 with an empty list and `total_count` 0, and the UI shows an empty state rather than a spinner.
- [ ] Given a thread is archived, when I open the Replies tab, then it is not in that list; when I unarchive it, then it returns with its unread state and intent chip unchanged.
- [ ] Given a lead reaches a terminal playbook outcome (Won, Lost, Unsubscribed), when the engine records it, then that lead's thread is auto-archived and the reason is stated on the archived row.
- [ ] Given a prospect replies to an archived thread, when the engine pulls it in, then the thread is unarchived automatically so a live conversation is never hidden.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"filters": {"campaignId": 12345}, "limit": 20}` | 200 with up to 20 archived threads and `total_count`; each row has lead, campaign, mailbox and last-activity time |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again"; no partial list rendered |
| TC-3 | Not found / wrong workspace | Filter by a campaign id from another workspace | 404 or an empty result with no cross-workspace data; UI states the campaign is unavailable |
| TC-4 | Validation failure — limit out of range | POST `limit: 200` | 422 naming `limit` and stating the 1–20 range; the page size selector offers only valid values |
| TC-5 | Rate limited | Page rapidly through many pages | 429 on the excess; the client backs off with jitter and keeps the current page visible |
| TC-6 | Empty result set | List archived on a fresh workspace | 200, empty list, `total_count` 0; empty state reads "Nothing archived yet" |
| TC-7 | Filter ceiling exceeded | POST `filters.campaignId` with 6 ids | 422 naming the 5-campaign maximum; the filter control stops accepting a sixth selection rather than letting the request fail |
| TC-8 | Sorting | List with `SENT_TIME_DESC`, then `REPLY_TIME_DESC` | Order differs for a thread sent long ago but replied to recently, and matches the selected field |
| TC-9 | Pagination stability | Read page 1, archive another thread, read page 2 | No row is duplicated or skipped across the boundary because paging is keyed on a stable sort key, not offset alone |
| TC-10 | Full history toggle | List with `fetch_message_history: true` | Each row includes its message history; response is measurably larger and the list still renders within budget |
| TC-11 | Auto-unarchive on new reply | Archive a thread, then simulate a prospect reply on the sandbox mailbox and tick the engine | The thread leaves the archived list and reappears in Replies as unread |

## 4. Frontend user story

**As a** team member, **I want** an Archived filter in the Inbox and an Archive action on each thread, **so that** the Replies tab is a working queue rather than a growing pile.

**Scope**
- Inbox: the existing tab strip ("Needs your OK", "Replies") gains a filter control on the Replies tab with "Active" (default) and "Archived", rather than a third tab, so the two-tab shape is preserved.
- Each thread row and the thread header gain an Archive / Unarchive action; archiving from an open thread advances to the next thread so the queue keeps moving.
- Filters for campaign and mailbox apply to the archived view identically to the active one, with the selectors capped at 5 campaigns and 10 mailboxes and the cap explained inline.
- Loading: skeleton rows on first page, an inline spinner on subsequent pages. Empty: "Nothing archived yet." Error: inline banner with a Retry that keeps filters.
- Accessibility: the filter is a real radio group or select with a visible label; Archive is a button with an accessible name including the lead ("Archive thread with Priya Sharma"); the archived state is text, not colour alone. Responsive: filter controls collapse into a single "Filters" sheet under 768px.

**Definition of done**
- [ ] Archived threads are reachable from the Replies tab without adding a navigation item.
- [ ] Archive and Unarchive both work from the list and the thread header and update without a reload.
- [ ] Paging shows "showing X of Y" from `total_count` and never duplicates a row.
- [ ] Loading, empty, error and filter-cap states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** an archived flag on threads and a filtered, paginated list route, **so that** the Inbox can hide finished conversations without losing them.

**Scope**
- Route in `server/routes.js`: `GET /api/inbox/threads?state=archived&campaignId=&mailboxId=&sort=&cursor=&limit=`, plus `PATCH /api/inbox/threads/:id` taking `{ archived: true|false }`. Both workspace-scoped, 404 outside the workspace.
- Data model: an `archived_at` and `archived_by` column on the thread grouping used by the Inbox (the `messages` thread key or a `threads` table if one is introduced), plus an index on (`workspace_id`, `archived_at`) so the list query stays cheap.
- Pagination: cursor-based on (sort key, thread id) with a hard cap of 20 per page mirroring the source API, and `total_count` returned separately so the UI can show progress. Standard app rate limiter; the client retries 429 with backoff and jitter.
- Automatic behaviour: `server/engine.js` archives a thread when the lead reaches a terminal node (Won / Lost / Unsubscribed) and unarchives it when a new inbound reply is pulled from Gmail, so a live conversation can never sit hidden.
- Logged: an `events` row per manual archive and unarchive with actor and reason; automatic archives are logged with the terminal outcome as the reason. `telemetry` counts archived-thread volume so Monitoring can spot a workspace drowning in unarchived threads.

**Definition of done**
- [ ] Archive flag, index, list route and toggle route exist, covered by tests including cross-workspace 404.
- [ ] Terminal-outcome auto-archive and inbound-reply auto-unarchive are each covered by an engine test.
- [ ] Cursor paging is asserted stable when rows are archived mid-page.
- [ ] Manual archives appear in the activity trail with the actor.

## 6. End-to-end test ticket

**Title:** E2E — Keep the reply queue clean with archive and automatic unarchive

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, three leads that have replied so three threads exist in Inbox → Replies, and one lead already at a Won terminal node.

**Flow**
1. Open Inbox → Replies and confirm three active threads.
2. Archive the first thread from its row.
3. Switch the filter to Archived and confirm it is listed, then check that the Won lead's thread is also there with the reason "Won".
4. Switch back to Active and confirm two threads remain.
5. Simulate a prospect reply on the archived thread from the sandbox mailbox and tick the engine.
6. Return to Active.

**Assertions**
- [ ] The archived thread disappeared from Active immediately and appeared under Archived.
- [ ] The Won lead's thread was archived without anyone touching it, with "Won" shown as the reason.
- [ ] After the simulated reply the thread is back in Active, marked unread, and no longer in Archived.
- [ ] The counter reads "showing 2 of 2" on Active and matches the archived count on Archived.
- [ ] The activity trail records the manual archive with the actor, and the automatic archive with the outcome.

**Teardown:** Unarchive everything, delete the campaign and leads, reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Active / Archived filter and an Archive action per thread | Medium | A filter on the existing tab rather than a third tab; the default is Active so today's view is unchanged |
| Inbox thread header | Archive / Unarchive button | Low | One button in the header row that already holds reclassify |
| Dashboard activity trail | Archive entries appear | Low | One more event type in a mixed feed |
| Monitoring | Archived-thread volume counter | Low | One line in the existing telemetry list |

**Verdict:** Fits an existing surface

Harry's Inbox shows every reply across campaigns with no way to retire one, which is fine at ten threads and unusable at a thousand, so archiving is a real gap. Adding it as a filter on the Replies tab rather than a third tab keeps the "Needs your OK / Replies" shape the product is built around, and auto-archiving on terminal outcomes means most users never touch the control at all.
