# Get Scheduled Emails

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/scheduled` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-scheduled |
| **Auth** | API key (query param `api_key`) |

Lists emails that are queued to go out later, ordered by when they are due to send.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** campaign owner, **I want** to see everything that is queued to send and when, **so that** I can check the next few hours of outreach before it happens rather than after.

**Acceptance criteria**
- [ ] Given queued emails exist, when I list them, then each row returns `campaign_lead_map_id`, the `scheduled_time` and an `email_status` of `Scheduled`, plus `total_count`.
- [ ] Given `sortBy` of `SCHEDULED_TIME_ASC`, when I list, then the next email to go is first — the default for this view; `SCHEDULED_TIME_DESC` reverses it and any other value is rejected with a field-level message.
- [ ] Given `filters` for campaign (max 5) and mailbox (max 10) plus the standard inbox filters, when I filter, then only matching queued emails return and exceeding a ceiling returns 422 naming the field and its maximum.
- [ ] Given `fetch_message_history` is false by default, when I render the list, then only summary fields are fetched; the composed body is loaded when a row is opened for review.
- [ ] Given `limit` outside 1–20, when I list, then I get 422 with a field-level message.
- [ ] Given the queue is empty, when I open the view, then I get 200 with an empty list and an empty state that says why — no campaign running, everything already sent, or everything still waiting for approval.
- [ ] Given the standing rule that nothing sends without an OK, when a queued email is shown, then it is an already-approved email waiting for its slot, and the view distinguishes it from a draft in Needs your OK that has no scheduled time at all.
- [ ] Given a queued email, when I cancel it before its slot, then it does not send, the lead stops at that node, and the cancellation is written to the activity trail with the actor.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"sortBy": "SCHEDULED_TIME_ASC", "limit": 20}` with five approved emails queued | 200 with `messages[]` ordered soonest first, each carrying `scheduled_time` and `email_status: "Scheduled"`; `total_count: 5` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again" |
| TC-3 | Not found / wrong workspace | Filter by a `campaignId` from another workspace | 404 or an empty result with no cross-workspace rows |
| TC-4 | Validation failure — limit | POST `limit: 25` | 422 naming `limit` and the 1–20 range |
| TC-5 | Rate limited | Poll the queue every second | 429 on the excess; client backs off with jitter and keeps the last good page; the countdown keeps ticking locally |
| TC-6 | Empty result set | Open the view with no campaign running | 200, empty list, `total_count: 0`; empty state states the reason and links to Campaigns |
| TC-7 | Sort direction | List with `SCHEDULED_TIME_ASC`, then `SCHEDULED_TIME_DESC` | The order reverses exactly |
| TC-8 | Time honours the sending rhythm | Approve six emails on one mailbox with a 50/day limit and working hours 9–5 | Scheduled times are spread with the randomised gap, all inside working hours, and none earlier than the mailbox's next allowed slot |
| TC-9 | Deterministic scheduling | Reset and re-approve the same six emails with the same mailbox, day and count | The same scheduled times are produced, because the jitter is a hash rather than `Math.random` |
| TC-10 | Sandbox mailbox | Queue emails on a sandbox mailbox | They schedule immediately with no gap and no working-hours wait, but the daily limit still applies |
| TC-11 | Cancel before send | Cancel a queued email, then let the engine tick past its slot | No message is sent, the lead does not advance, and the activity trail records the cancellation with the actor |
| TC-12 | Campaign holding | Put the campaign into holding while emails are queued | The rows show the holding reason rather than a countdown, matching what the campaign page already states |

## 4. Frontend user story

**As a** campaign owner, **I want** a queue view showing what goes out next and when, **so that** "Approved — goes to Priya around 2:40pm" is a list I can scan, not a single line I happened to notice.

**Scope**
- Inbox: "Scheduled" joins the same filter group as reminders, important and archived on the Replies tab, sorted soonest-first by default, with rows showing the lead, campaign, sending mailbox and the send time in the browser's timezone with a relative countdown.
- Each row opens the approved email in read-only form with a Cancel action, so a change of mind before the slot is possible without hunting for the lead.
- Campaign detail already states why a campaign is holding and when the next email goes; that panel links into this filtered view rather than duplicating the list.
- Loading: skeleton rows. Empty: a stated reason ("Nothing queued — six drafts are waiting for your OK") with a direct action. Error: inline banner with Retry preserving filters.
- Accessibility: countdowns are rendered as text with an absolute time in the accessible name; the sort is a labelled select; Cancel is a button whose accessible name includes the lead. Responsive: the countdown column collapses under the lead name below 640px.

**Definition of done**
- [ ] The queue is reachable from the Replies tab filter group, defaulting to soonest first.
- [ ] Each row shows the mailbox and an accurate time in the browser's timezone.
- [ ] Cancel stops the send and updates the list without a reload.
- [ ] Loading, empty-with-reason, holding, error and cancelled states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** to expose the pacing queue as a readable, filterable list, **so that** the schedule the engine has already computed is visible instead of implicit.

**Scope**
- Route in `server/routes.js`: extend `GET /api/inbox/threads` with `state=scheduled` and `sort=scheduled_asc|scheduled_desc`, plus `DELETE /api/scheduled/:id` to cancel. Workspace-scoped, 404 outside the workspace.
- Data model: no new table — the queue is derived from approved drafts plus the next-slot calculation in `server/pacing.js`, with the computed `scheduled_at` persisted on the draft row when it is approved so the list and the engine agree on one time rather than recomputing differently.
- The scheduled time honours the existing rules: one email at a time per mailbox with a randomised gap derived from the day's remaining allowance spread over the hours left and scattered ±50%, only inside working hours and days, warmup ramp for new Gmail mailboxes, and deterministic jitter hashed from mailbox, day and count. Sandbox mailboxes skip the clock and the gap but keep the daily limit.
- Pagination: cursor on (`scheduled_at`, id) with the 20-row cap; `total_count` from a separate cheap count. Standard rate limiter; 429 retried by the client with backoff and jitter.
- Logged: an `events` row per cancellation with actor and reason; `telemetry` records queue depth per mailbox so Monitoring can show a backlog building against a daily limit.

**Definition of done**
- [ ] Scheduled state and both sorts added to the shared inbox route, covered by tests.
- [ ] A test asserts the listed time is exactly the time the engine sends at, for both a Gmail and a sandbox mailbox.
- [ ] A test asserts the jitter is reproducible for the same mailbox, day and count.
- [ ] Cancellation is atomic — a race with the engine's send either cancels or sends, never both.

## 6. End-to-end test ticket

**Title:** E2E — Review and prune the outgoing queue before it sends

**Preconditions:** A workspace with one sandbox mailbox and one Gmail-style mailbox with a 50/day limit and working hours set, one running campaign with six leads, approvals on (the default).

**Flow**
1. Let the engine compose six drafts and open Inbox → Needs your OK.
2. Approve all six.
3. Switch to the Scheduled view.
4. Note the times and the mailbox on each row.
5. Open one row, read the approved email, and cancel it.
6. Let the engine tick past that row's slot.

**Assertions**
- [ ] Six rows appear in soonest-first order with times inside working hours and gaps consistent with the sending rhythm.
- [ ] Each row names the sending mailbox and shows a countdown as well as an absolute time.
- [ ] Opening a row shows exactly the email that was approved, read-only.
- [ ] After cancellation the row disappears, the count drops to five, and no message is sent for that lead when the slot passes.
- [ ] The activity trail records the cancellation with the actor; the other five send at their listed times.

**Teardown:** Cancel the remaining queued emails, delete the campaign and leads, reset both mailboxes' counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Scheduled filter value with its own sort and a Cancel action | Medium | Joins the existing filter group; the list reuses the same row component with the snippet replaced by a countdown |
| Campaign detail | The existing "next email goes at…" line links into the filtered queue | Low | One link on text that already exists |
| Dashboard | Queue depth is already implied by the engine heartbeat; no change needed | Low | Nothing added |
| Monitoring | Queue depth per mailbox telemetry | Low | One line in the existing delivery telemetry list |

**Verdict:** Fits an existing surface

Harry already computes and states a send time — the approval flow says "goes to Priya around 2:40pm" and the campaign page explains holding — so the schedule exists but is only visible one item at a time. Turning it into a filtered view on the Replies tab makes the next few hours reviewable without inventing a new page, and the Cancel action gives the standing rule a matching undo.
