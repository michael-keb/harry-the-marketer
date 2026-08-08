# Get Inbox Replies

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/inbox-replies` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-messages |
| **Auth** | API key (query param `api_key`) |

Lists every reply from every campaign in one filtered, sorted, paginated view — the backbone query the whole Inbox is built on.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member running several campaigns, **I want** one list of every reply that I can filter and sort, **so that** I never have to open each campaign in turn to find out who answered.

**Acceptance criteria**
- [ ] Given replies exist, when I list them, then each row returns `campaign_lead_map_id`, the `lead` (`email`, `first_name`, `last_name`, `company`, `phone`), the `campaign`, the `email_account` that sent (`id`, `email`, `name`), the `last_message` (`subject`, `body`, `received_at`, `sent_from`, `sent_to`), the `email_status`, the `category`, the `assigned_to` member, the per-lead `stats` (`total_sent`, `total_opened`, `total_clicked`, `total_replied`, `last_activity`), and the `is_read`, `is_important` and `is_archived` flags — plus `total_count`, `offset` and `limit`.
- [ ] Given `fetch_message_history` is false (the default), when I render a list, then only `last_message` is fetched; when a thread is opened with it true, the full `message_history` is returned with each entry's `direction`, `sent_at` or `received_at` and `opened_at` where known.
- [ ] Given `filters.emailStatus` accepts a single value or an array from `Opened`, `Clicked`, `Replied`, `Unsubscribed`, `Bounced`, `Accepted`, `Not Replied`, when I filter, then only matching rows return and an unknown value is rejected.
- [ ] Given the documented ceilings — 5 campaigns, 20 mailboxes, 10 team members, 10 tags, 10 clients, 10 categories, 30-character search — when I exceed one, then I get 422 with `field`, `provided_count` and `max_allowed` so the UI can say exactly what to remove.
- [ ] Given `filters.replyTimeBetween` with two ISO 8601 datetimes, when I filter, then only replies inside the window return; a malformed value returns 422.
- [ ] Given `sortBy` of `REPLY_TIME_DESC` (default) or `SENT_TIME_DESC`, when I list, then the order matches and the choice persists for the session.
- [ ] Given no replies at all, when I open the Inbox, then I get 200 with an empty list and an empty state that points at the campaigns still waiting for answers.
- [ ] Given `limit` outside 1–20 or a negative `offset`, when I list, then I get 422 with a field-level message and nothing is returned.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"offset": 0, "limit": 20, "filters": {"emailStatus": "Replied", "campaignId": [12345, 12346], "leadCategories": {"categoryIdsIn": [1]}}, "sortBy": "REPLY_TIME_DESC"}` with `fetch_message_history=false` | 200 with `messages[]`, each carrying lead, campaign, `email_account`, `last_message`, `stats`, `is_read`, `is_important`, `is_archived`; `total_count`, `offset`, `limit` echoed |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401, `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again" |
| TC-3 | Not found / wrong workspace | Filter by a `campaignId` from another workspace | 404 or an empty result with no cross-workspace rows; UI states the campaign is unavailable |
| TC-4 | Validation failure — too many campaigns | POST `filters.campaignId` with 10 ids | 422, `{"error": "campaignId array cannot exceed 5 items", "field": "filters.campaignId", "provided_count": 10, "max_allowed": 5}`; the picker disables a sixth selection and explains why |
| TC-5 | Rate limited | Poll the list every second while paging | 429 on the excess; the client backs off with jitter, keeps the current page on screen, shows one "Retrying…" state |
| TC-6 | Empty result set | Open the Inbox on a workspace whose campaigns have had no replies | 200, `messages: []`, `total_count: 0`; empty state reads "No replies yet" and links to the running campaigns |
| TC-7 | History toggle cost | List with `fetch_message_history=true` for 20 rows, then with false | Both 200; the false response is materially smaller and the list renders within budget — the UI uses false for lists and true only when a thread is opened |
| TC-8 | Multi-value status | POST `emailStatus: ["Replied", "Clicked"]` | 200 containing rows of both statuses only |
| TC-9 | Date window | POST `replyTimeBetween` covering only yesterday | Only replies received yesterday return; today's are excluded |
| TC-10 | Search ceiling | POST `filters.search` with 31 characters | 422 naming the 30-character maximum; the input caps at 30 with a counter |
| TC-11 | Paging stability | Read page 1, have a new reply arrive, read page 2 | No row is duplicated or skipped, because paging is keyed on the sort key plus id rather than offset alone |
| TC-12 | Unread accuracy | Count rows with `is_read: false` and compare with the Inbox badge | The two agree exactly; the badge is derived from the same query |

## 4. Frontend user story

**As a** team member, **I want** the Replies tab to filter, search, sort and page over every reply, **so that** a busy workspace stays workable without opening campaigns one by one.

**Scope**
- Inbox → Replies: the existing list gains a filter bar (campaign, mailbox, intent category, engagement status, assignee, date range), a search box capped at 30 characters with a counter, and a sort control offering "Newest reply" and "Newest sent".
- Rows show the lead's name and company, the campaign, the sending mailbox, the last-message snippet, the relative time, the intent chip Harry already renders, and the unread, important and assignee markers.
- Paging shows "showing X of Y" from `total_count`; the page size is fixed at 20 to match what the API supports rather than offering a choice that cannot be honoured.
- Loading: skeleton rows on first load, an inline spinner when paging, filters staying interactive. Empty: "No replies yet" or, when filters are active, "No replies match these filters" with a Clear filters action. Error: inline banner with Retry, filters preserved.
- Accessibility: filters are labelled controls in a group with an accessible name; the result count is announced when it changes; unread is conveyed in text as well as weight; the list is keyboard-navigable with Enter opening a thread. Responsive: the filter bar collapses into a Filters sheet under 768px, showing the count of active filters.

**Definition of done**
- [ ] Every filter, the search, the sort and paging all work together and are reflected in the URL so a filtered view is shareable.
- [ ] Filter ceilings are enforced in the UI before a request is sent, with the reason stated.
- [ ] The list request never fetches full message history; opening a thread does.
- [ ] Loading, empty, filtered-empty, error and rate-limited states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** one paginated, filterable inbox query that every inbox view is built on, **so that** the workspace view, the personal queue, important, unread and archived are all the same code path with different arguments.

**Scope**
- Route in `server/routes.js`: `GET /api/inbox/threads` accepting `campaignId[]`, `mailboxId[]`, `categoryId[]`, `status[]`, `assigneeId`, `repliedBetween`, `search`, `important`, `unread`, `state=active|archived`, `sort`, `cursor`, `limit` (capped at 20). Workspace-scoped; every id validated as in-workspace or 404.
- Data model: no new tables — the query joins `leads`, `campaigns`, `campaign_leads` and `messages` in `server/db.js`, with the per-lead `stats` (sent, opened, clicked, replied, last activity) read from the existing tracking data rather than recomputed per row. Indexes on (`workspace_id`, `last_reply_at`, `id`) and (`workspace_id`, `campaign_id`, `last_reply_at`) keep it a single index scan.
- Pagination: cursor-based on (sort key, id) so pages stay stable while new replies arrive; `total_count` is computed by a separate cheap count query and cached briefly.
- Search is a bounded prefix/substring match over lead email, name and last-message body, capped at 30 characters to keep it index-friendly, exactly as the source API does.
- Rate limits: the standard app limiter; clients retry 429 with backoff and jitter. Filter ceilings are enforced server-side and return the field, provided count and maximum so the client can render a precise message.
- Logged: no event per read. `telemetry` records query latency, result size and which filters were used so Monitoring can show when the Inbox query is degrading and which filters cost most.

**Definition of done**
- [ ] One route serves all inbox views; a test asserts the personal, important, unread and archived views all hit it.
- [ ] Filter ceilings return the documented field/provided/max shape, covered by tests.
- [ ] Cursor paging is asserted stable when a new reply lands between page reads.
- [ ] Query latency and filter usage appear in Monitoring telemetry.

## 6. End-to-end test ticket

**Title:** E2E — Find one reply among many with filters, search and sort

**Preconditions:** A workspace with two sandbox mailboxes, three running campaigns, twenty-five leads that have replied across them with a mix of intents, one reply from "Sarah Johnson at Startup Inc" received yesterday.

**Flow**
1. Open Inbox → Replies and confirm the first page shows 20 rows with "showing 20 of 25".
2. Page to the second page and back.
3. Filter to two campaigns and the "interested" intent.
4. Set the date range to yesterday only.
5. Search for "Johnson".
6. Switch the sort to "Newest sent".
7. Copy the URL, open it in a new tab.

**Assertions**
- [ ] Paging never repeats or skips a lead, even though a new reply is simulated between steps 1 and 2.
- [ ] Each filter narrows the count and the count is announced; combining them yields only Sarah Johnson's reply.
- [ ] The row shows her company, the campaign, the sending mailbox, the snippet and the intent chip.
- [ ] Changing the sort reorders visibly without losing the filters.
- [ ] The copied URL reopens the identical filtered, sorted view in the new tab.
- [ ] Trying to select a sixth campaign is refused in the UI with a stated reason, and no failing request is sent.

**Teardown:** Delete the campaigns and leads, reset both sandbox mailboxes.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Filter bar, search, sort, paging and a result count added to the existing list | High | Filters live in one collapsible bar with an active-filter count; the default view is unfiltered and looks like today's list |
| Inbox rows | Sending mailbox and per-lead stats added to the row metadata | Medium | One secondary line, truncated, with the detail available in the thread |
| URL | Filter state reflected in the address | Low | Invisible unless shared; makes views shareable |
| Monitoring | Inbox query telemetry | Low | One more line in the existing telemetry list |

**Verdict:** Fits an existing surface

This is the query Harry's Replies tab already runs — it lists every reply across campaigns with intent chips — so the capability exists; what is missing is filtering, search, sorting and paging, which is what turns it from a demo list into something usable at a thousand replies. The risk here is the filter bar becoming the loudest thing on the page, so it stays collapsed by default with only an active-filter count visible, and no navigation item is added.
