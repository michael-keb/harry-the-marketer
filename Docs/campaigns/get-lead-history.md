# Get Lead Message History

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}/message-history` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-lead-history |
| **Auth** | API key (query param `api_key`) |

Returns the full back-and-forth with one person in one campaign, in order, marking what went out and what came in.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** person about to approve a follow-up, **I want** the whole conversation with this lead in front of me, **so that** the next email reads as a continuation rather than a repeat.

**Acceptance criteria**
- [ ] Given a campaign and a lead, when I fetch their history, then I get every message in order with its id, subject, direction and timestamps — mirroring the source API's `messages` array with `id`, `subject`, `direction` (`outbound` / `inbound`), `sent_at`, `received_at` and `opened_at`.
- [ ] Given the agent composes from the thread, when the composer runs, then it reads this same history, so what it writes is grounded in what was actually said.
- [ ] Given I only want what is new, when I pass a "since" timestamp (the source API's `event_time_gt`), then only messages after that moment are returned, which lets the Inbox poll cheaply.
- [ ] Given emails may be HTML, when I request the plain-text form (the `show_plain_text_response` behaviour), then each message includes a readable plain-text body alongside its HTML.
- [ ] Given every outgoing email carries tracking, when an outbound message is returned, then its open and click events are attached to that message, and are absent rather than zero when tracking is off for the campaign.
- [ ] Given each inbound message was classified, when it is returned, then its classified intent and the playbook edge it caused the engine to follow come with it, so the routing is explainable.
- [ ] Given a lead with no messages yet, when I fetch their history, then I get an empty list and the thread view shows the pending draft or the reason nothing has been sent.
- [ ] Given a campaign or lead in another workspace, when I fetch the history, then I get a 404 and no message content is disclosed.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET history for campaign 123 / lead 789 with one send and one reply | 200 with two messages: one `direction: "outbound"` with `sent_at` and `opened_at`, one `direction: "inbound"` with `received_at`, in chronological order |
| TC-2 | Missing/invalid API key | GET unauthenticated | 401; no message content returned |
| TC-3 | Not found / wrong workspace | GET with a campaign or lead id from another workspace | 404; nothing disclosed |
| TC-4 | Validation failure | GET with `event_time_gt=last week` | 422 naming the parameter and requiring ISO 8601 |
| TC-5 | Rate limited | Poll the thread every second | 429 on the excess; the client falls back to the standard poll interval using the since-timestamp |
| TC-6 | Empty result set | GET history for a lead who has not been emailed yet | 200 with an empty `messages` array; the thread view shows the pending draft or the campaign's holding reason |
| TC-7 | Incremental fetch | Fetch, note the newest timestamp, send another email, fetch with that timestamp | Only the new message is returned; the client appends without re-rendering the thread |
| TC-8 | Plain text | Request the plain-text form on an HTML email | A readable plain-text body is present and free of markup and tracking artefacts |
| TC-9 | Tracking off | GET history for a campaign with open tracking disabled | Outbound messages carry no open events at all, rather than open counts of zero |
| TC-10 | Classification and routing | GET history after a reply classified as "interested" | The inbound message carries the intent and names the playbook edge the engine followed |
| TC-11 | Reclassification | Reclassify that reply and refetch | The message shows the corrected intent, the new edge, and that a human made the change |
| TC-12 | Long thread | GET history for a lead with 200 messages | The response pages with the most recent first by default; ordering is stable and no message is repeated across pages |

## 4. Frontend user story

**As a** person working the Inbox, **I want** the thread view to show the whole conversation with routing explained, **so that** I can see not just what was said but why the agent did what it did next.

**Scope**
- Inbox → thread view: chronological messages with direction, subject, timestamps, and per-message open and click indicators; each inbound message shows its classified intent as a chip and the playbook edge it triggered.
- Reclassify-and-reroute stays where it is, acting on the message in the thread; the resulting edge change is shown inline so the consequence is visible before it is confirmed.
- Leads → lead detail: the same timeline component, filtered to that campaign, with a campaign switcher when the lead is in several.
- Loading: the newest messages render first with older ones paged in on scroll; empty: "No messages yet" plus the reason (draft awaiting approval, or campaign holding); error: the thread keeps what it has and offers a retry.
- Accessibility: each message is an article with an accessible name stating direction, sender and time; intent chips are text; tracking indicators are labelled, not icon-only. Responsive: full-width single column under 768px with the composer pinned.

**Definition of done**
- [ ] Direction, timestamps and tracking events render per message.
- [ ] Every inbound message shows its intent and the edge it caused.
- [ ] Incremental polling appends without a full re-render or a scroll jump.
- [ ] Long threads page smoothly and never duplicate a message.

## 5. Backend user story

**As a** Harry API, **I want** a thread route with incremental fetch, **so that** the Inbox stays live without re-sending an entire conversation every few seconds.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns/:id/leads/:leadId/messages` accepting `since` (ISO 8601), `limit` and `plainText`, workspace-scoped.
- Data model: reads `messages` in `server/db.js` joined to tracking events and reply classifications, ordered by timestamp with id as a stable tiebreaker. No new table; the classified intent and the edge followed are already recorded by `server/engine.js`.
- Plain-text bodies are derived once and stored alongside the HTML at send time, not regenerated per request. Tracking events are omitted entirely for campaigns with that tracking disabled, so the client cannot mistake absence for zero.
- Paging is by `since` for live updates and by cursor for history; both use the same stable ordering. Standard rate limiting; the Inbox uses the `since` form so polling stays cheap.
- Logged: nothing to `events` for a read. `telemetry` records thread query duration and page sizes.

**Definition of done**
- [ ] `since` returns strictly newer messages with no gap or duplicate, covered by a test.
- [ ] Intent and followed edge accompany every inbound message.
- [ ] Tracking events are absent, not zeroed, when tracking is off.
- [ ] A 200-message thread pages within the query-time budget.

## 6. End-to-end test ticket

**Title:** E2E — Read a whole conversation and see why the agent routed it

**Preconditions:** A workspace with a sandbox mailbox, a campaign whose playbook has `reply: interested` and `reply: question` edges, one lead with two sent emails, one open, one click and one reply, approvals on.

**Flow**
1. Open Inbox and select the lead's thread.
2. Read the messages in order and check the tracking indicators.
3. Read the intent chip on the reply and the edge it triggered.
4. Reclassify the reply from "question" to "interested" and confirm.
5. Let the engine tick, then reopen the thread.
6. Open the same lead on the Leads page.

**Assertions**
- [ ] Both outbound messages show their send times, and the opened one shows its open time.
- [ ] The reply shows its intent and names the edge the engine followed.
- [ ] After reclassification, the thread shows the corrected intent, the new edge, and that a human changed it.
- [ ] The next email produced after rerouting waits in Needs your OK rather than sending.
- [ ] The lead detail timeline shows the identical sequence.
- [ ] Polling the thread while idle adds nothing and does not scroll the view.

**Teardown:** Delete the campaign and its sandbox messages; keep the lead.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → thread view | Per-message tracking indicators and the edge each reply triggered | Medium | Two short lines per message; the edge label reuses the wording from the user's own diagram |
| Leads → lead detail | Shared timeline component | Low | Same component, filtered by campaign |
| Campaign detail | Node performance already shows where leads sit | Low | Unchanged; the thread simply explains one lead's path through it |

**Verdict:** Fits an existing surface

The Inbox thread view is exactly this endpoint made visible, so nothing new is needed. The one addition that earns its space is naming the playbook edge each reply triggered, because that is what turns "the agent sent this" into "the agent sent this because my diagram said to".
