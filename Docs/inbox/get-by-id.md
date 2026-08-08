# Get Inbox Item by ID

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/master-inbox/{id}` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-by-id |
| **Auth** | API key (query param `api_key`) |

Fetches one conversation in full — the lead, the campaign, and every message in the thread — from a single id, so a link can open straight onto it.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member following a Slack alert or a shared link, **I want** one URL to open exactly the conversation it refers to, **so that** I do not have to hunt for it in a filtered list.

**Acceptance criteria**
- [ ] Given the id of a conversation (the `campaign_lead_map_id` returned by every list endpoint in this category), when I fetch it, then I get the `lead` (`email`, `first_name`, `last_name`, `company`), the `campaign` (`id`, `name`), the full `message_history` with each message's `subject`, `direction` (`inbound` / `outbound`) and `sent_at` or `received_at`, the `email_status` and the `category`.
- [ ] Given an id that does not exist, when I fetch it, then I get 404 with an error naming the id, and the UI shows "That conversation is no longer available" with a way back to the Inbox rather than an error page.
- [ ] Given an id belonging to another workspace, when I fetch it, then I get the same 404 — existence is not leaked across workspaces.
- [ ] Given a conversation with only outbound messages and no reply yet, when I fetch it, then `message_history` contains just the outbound entries and the thread renders without pretending a reply exists.
- [ ] Given the thread is opened, when the fetch succeeds, then the conversation is marked read for the viewer and the unread badge updates.
- [ ] Given a Slack or Teams alert about a reply, when a user clicks it, then it deep-links to this conversation and, if they are not signed in, they land back on it after signing in.
- [ ] Given the conversation is open, when a new message arrives on the next engine tick, then the thread appends it in place without losing a half-typed reply in the composer.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `GET /master-inbox/2433664091` for a replied conversation | 200 with `lead.email`, `campaign.name`, a two-entry `message_history` (one outbound, one inbound), `email_status: "Replied"`, `category` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI redirects to sign in and returns to the same conversation afterwards |
| TC-3 | Not found | `GET` an id that has been deleted | 404, `{"error": "Inbox item not found with ID …"}`; UI shows "That conversation is no longer available" with a link to Inbox |
| TC-4 | Wrong workspace | `GET` an id owned by another workspace | 404, identical body to TC-3, no timing or wording difference that reveals existence |
| TC-5 | Validation failure | `GET /master-inbox/not-a-number` | 422 naming the id parameter; no database query is issued |
| TC-6 | Rate limited | Open and reopen the same conversation rapidly | 429 on the excess; the client keeps the already-rendered thread and retries with backoff |
| TC-7 | Empty history | `GET` a conversation whose campaign has not sent yet | 200 with `message_history: []`; the thread shows "No messages yet — the first email is still waiting for your OK" |
| TC-8 | Read state | Open an unread conversation, then re-list the Inbox | The row is no longer unread and the badge count has decreased by one |
| TC-9 | Deep link while signed out | Open the conversation URL in a fresh browser | Redirected to sign in, then landed on the same conversation, not the Inbox root |
| TC-10 | Live append | Keep the thread open, simulate an inbound reply on the sandbox mailbox, tick the engine | The new message appears in the thread and any text typed in the composer is untouched |

## 4. Frontend user story

**As a** team member, **I want** every conversation to have its own URL, **so that** I can share it, bookmark it, and open it from an alert.

**Scope**
- Inbox: the thread view moves to a routed URL (`/app/inbox/threads/:id`) rather than only local component state, so the browser back button, refresh and sharing all behave.
- The thread renders the lead header (name, email, company), the campaign it belongs to, the current intent category and status, and the message list ordered oldest to newest with inbound and outbound clearly distinguished by text, not only alignment.
- Slack and Teams alerts for replies and approvals link to this URL, and the existing Dashboard Action Center rows link to it too.
- Loading: a skeleton thread with the lead header filled from the list row so the page does not appear empty. Not found: a stated message with a link back to Inbox. Error: inline banner with Retry.
- Accessibility: the thread is a labelled region with each message as an article carrying an accessible name ("From John Doe, 20 January"); direction is stated in text; focus moves to the thread heading on navigation. Responsive: on mobile the thread replaces the list rather than sitting beside it, with a back control.

**Definition of done**
- [ ] Every conversation has a stable, shareable URL that survives refresh and back.
- [ ] Alerts and Action Center rows deep-link to it, including through the sign-in redirect.
- [ ] Opening a thread marks it read and updates the unread badge in the same interaction.
- [ ] Loading, not-found, empty-history and live-append states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a single route returning one conversation in full, **so that** the thread view needs one request rather than reassembling from list responses.

**Scope**
- Route in `server/routes.js`: `GET /api/inbox/threads/:id` returning the lead, campaign, ordered messages, current playbook node, intent category, read state and assignee. Workspace-scoped, returning 404 for anything outside the caller's workspace with an identical body to a genuine miss.
- Data model: none new — the response is assembled from `leads`, `campaigns`, `campaign_leads` and `messages` in `server/db.js`, with the conversation id being the `campaign_leads` row id so it is stable for the life of the pairing.
- Read marking happens on a separate `PATCH` rather than as a side effect of the GET, so a prefetch or a bot cannot silently clear a badge.
- No pagination on the message list for a normal thread; if a thread exceeds a stated message count the route returns the most recent 50 with a cursor for older ones. Standard app rate limiter, 429 retried with backoff and jitter by the client.
- Logged: no event per read. `telemetry` records thread-fetch latency and 404 rate so Monitoring can spot broken deep links from alerts.

**Definition of done**
- [ ] Route exists, workspace-scoped, and a test asserts cross-workspace and deleted ids return identical 404 bodies.
- [ ] A GET never mutates read state, asserted by a test.
- [ ] Message ordering and direction are asserted for a mixed inbound/outbound thread.
- [ ] Thread-fetch 404 rate appears in Monitoring telemetry.

## 6. End-to-end test ticket

**Title:** E2E — Open a conversation from an alert link and pick up where the thread left off

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, one lead that has replied, a Slack webhook configured in Settings pointed at a test receiver, approvals on.

**Flow**
1. Simulate the prospect's reply on the sandbox mailbox and tick the engine so an alert fires.
2. Read the URL from the test receiver's payload and open it in a signed-out browser.
3. Sign in when prompted.
4. Read the thread, then type two words into the reply composer without sending.
5. Simulate a second inbound reply and tick the engine again.
6. Press browser back, then forward.

**Assertions**
- [ ] The alert contained a link to the specific conversation, not the Inbox root.
- [ ] After signing in the browser lands on that conversation with the lead header, campaign name and both messages in order.
- [ ] The thread was unread before opening and the Inbox badge decreased by one after.
- [ ] The second reply appended to the open thread and the two typed words are still in the composer.
- [ ] Back returns to the Inbox list and forward returns to the same thread with the composer text preserved or clearly discarded, never half-restored.

**Teardown:** Delete the campaign and lead, reset the sandbox mailbox, remove the test webhook.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies thread | Thread becomes a routed URL rather than local state | Low | Same view, same layout; only the address bar changes |
| Slack / Teams alerts | Links point at the specific conversation | Low | Same message text, a better link |
| Dashboard → Action Center | Rows deep-link into the thread | Low | The rows already link somewhere; the target improves |
| Sign-in | Returns the user to the requested conversation | Low | Existing redirect mechanism, one more stored destination |

**Verdict:** Fits an existing surface

Harry's Inbox already renders a full thread with intent and manual reply, so nothing about the view is new — what is missing is that the thread has no address, which makes alerts and hand-offs land in the wrong place. Routing it adds no visible control and no navigation item, and it is the prerequisite for almost every other endpoint in this category to be linkable.
