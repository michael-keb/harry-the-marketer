# Get Bulk Lead Message History

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/message-history-for-leads/bbfbdsFGHlBr76ruhjvh6fhHL` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-leads-history-bulk |
| **Auth** | API key (query param `api_key`) |

Fetches the conversation history for many leads in one request instead of asking for each thread separately.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** person working through the approval queue, **I want** the conversations for a screenful of leads fetched in one go, **so that** each draft opens with its history already there instead of loading one request at a time.

**Acceptance criteria**
- [ ] Given a list of lead ids, when I request their history in bulk, then I get a map keyed by lead id, each key holding that lead's messages — the source API's `data` object keyed by lead id, each value an array of messages with at least subject and send time.
- [ ] Given no ids are supplied, when I request bulk history (the source API accepts a null `lead_ids`, meaning all leads), then Harry requires an explicit set or an explicit "all in this filter" choice, because an unbounded fetch of every conversation in a large campaign is a request nobody means to make.
- [ ] Given a "since" timestamp (the `event_time_gt` behaviour), when I request bulk history, then only messages after that moment are returned per lead, which is what makes live polling of a queue affordable.
- [ ] Given a lead in the list has no messages, when the response is built, then their key is present with an empty array — a missing key would be indistinguishable from a lead that failed to load.
- [ ] Given a lead id in the list does not belong to this campaign or workspace, when the request runs, then that id is reported as not available and the rest still return, rather than the whole request failing.
- [ ] Given a bulk request, when the id list exceeds the batch limit, then it is rejected with a stated maximum and the client chunks it automatically.
- [ ] Given the response can be large, when it is returned, then it carries only what a queue or list row needs per message, and full bodies are fetched per thread on demand.
- [ ] Given this endpoint reads many people's conversations at once, when it is called, then the workspace scope is enforced on every id, not just the campaign.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"lead_ids": [789, 790, 791]}` for campaign 123 | 200 with a `data` object keyed by each lead id, each holding that lead's messages with subject and send time |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401; no conversation content returned |
| TC-3 | Not found / wrong workspace | Include a lead id from another workspace in the list | That id is reported as not available; the other ids still return their history |
| TC-4 | Validation failure | POST `{"lead_ids": "789"}` and separately an id list of 5,000 | 422 in both cases — one naming the expected array type, one stating the maximum batch size |
| TC-5 | Rate limited | Fire bulk requests continuously while scrolling a long queue | 429 on the excess; the client coalesces requests per visible page rather than per row |
| TC-6 | Empty result set | POST ids for three leads none of whom have been emailed | 200 with all three keys present holding empty arrays; the queue shows "No messages yet" per row |
| TC-7 | Since filter | Fetch, note the newest timestamp, send one email, fetch again with that timestamp | Only the new message is returned, under its lead's key; other keys are empty |
| TC-8 | Unbounded request | POST with no ids at all | Rejected with a message requiring an explicit set or an explicit all-in-filter choice |
| TC-9 | Mixed valid and invalid ids | Include one deleted lead id among five valid ones | Five histories returned, one id reported as not available; no 500 |
| TC-10 | Large batch performance | Request the maximum allowed ids on a campaign with long threads | Response returns within budget; payload size stays within the agreed cap |
| TC-11 | Consistency with single fetch | Compare one lead's bulk result against the single-thread endpoint | The message list is identical for that lead |

## 4. Frontend user story

**As a** person working the approval queue, **I want** each row and draft to already know its conversation, **so that** moving through twenty approvals feels instant rather than stuttering.

**Scope**
- Inbox → Needs your OK and Inbox → Replies: the list prefetches history for the visible page of leads in one request, so opening a row renders the thread summary immediately and only the full body is fetched on demand.
- Campaigns → campaign detail → leads: the same prefetch drives a "last message" preview column, replacing a column that would otherwise be blank until each row was opened.
- Polling for live updates uses the since-timestamp form for the visible page only, never the whole campaign.
- Loading: rows show a compact skeleton for the preview line only; empty: "No messages yet" per row; error: the row keeps its data and the preview line shows a quiet retry, never blocking the approve action.
- Accessibility: preview text is truncated with the full text available to assistive technology; the live-update region is polite so it never interrupts someone reading a draft. Responsive: the preview column is dropped under 768px, where the card layout already shows the last message.

**Definition of done**
- [ ] The visible page's histories are fetched in one request, not one per row.
- [ ] Opening a draft shows its thread summary with no additional wait.
- [ ] Polling covers only the visible page and uses the since-timestamp form.
- [ ] A failed prefetch degrades to per-row loading and never blocks approving.

## 5. Backend user story

**As a** Harry API, **I want** a batched thread-history route, **so that** list surfaces make one query instead of N and the database is not hammered by a scrolling queue.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns/:id/messages/bulk` taking `{ leadIds: [], since?, summaryOnly? }` and returning `{ data: { [leadId]: [...] }, unavailable: [] }`, workspace-scoped on every id.
- Data model: one indexed query over `messages` in `server/db.js` filtered by campaign and lead id set, grouped in application code. No new table. Summary mode returns id, direction, subject, timestamp and classified intent only; full bodies stay behind the single-thread route.
- Batch size capped (100 ids, matching the campaign-leads page size) and enforced server-side with a stated maximum; unknown or cross-workspace ids are returned in `unavailable` rather than failing the request.
- No unbounded mode: an absent or null id list is rejected, deliberately diverging from the source API's null-means-all behaviour, which does not survive a campaign with thousands of leads.
- Logged: nothing to `events`. `telemetry` records batch size, payload size and duration, so Monitoring can catch a client that starts requesting too much.

**Definition of done**
- [ ] One query serves the whole batch, verified by a query-count test.
- [ ] Every requested id appears either in `data` or in `unavailable`.
- [ ] The batch cap and the rejection of unbounded requests are covered by tests.
- [ ] Bulk and single-thread results agree for the same lead on a shared fixture.

## 6. End-to-end test ticket

**Title:** E2E — Work twenty approvals without waiting between them

**Preconditions:** A workspace with a sandbox mailbox, a campaign with 40 leads of which 20 have drafts waiting and mixed conversation lengths, plus one lead deleted after their draft was created. Approvals on.

**Flow**
1. Open Inbox → Needs your OK.
2. Observe network activity while the first page renders.
3. Open the first draft and read its thread summary.
4. Move through five drafts in sequence, approving three and declining one.
5. Scroll to load the next page.
6. Compare one lead's thread against opening it directly from Leads.

**Assertions**
- [ ] The first page issues one history request, not one per row.
- [ ] Each draft opens with its thread summary already present.
- [ ] The deleted lead's row is reported as unavailable without breaking the page.
- [ ] Scrolling issues exactly one further history request for the new page.
- [ ] The bulk-loaded thread matches the thread opened directly.
- [ ] Approving still parks nothing — the approved emails go through the normal send path and appear in the queue as approved.

**Teardown:** Delete the campaign and its sandbox messages; keep the leads.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Needs your OK / Replies | Prefetched thread summaries; a preview line per row | Low | One line of text per row; the benefit is entirely in speed |
| Campaigns → campaign detail leads | "Last message" preview column | Low | Optional column, dropped on narrow screens |
| Monitoring | Batch size and payload telemetry | Low | Existing telemetry table, no new panel |

**Verdict:** Invisible — no UI

This endpoint adds no controls and no screens; it is a performance shape for surfaces that already exist. The only user-visible effect is that the approval queue stops stuttering, which is the right kind of change — the user should never know why it got faster.
