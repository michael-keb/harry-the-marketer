# Get Important Emails

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/important` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-important |
| **Auth** | API key (query param `api_key`) |

Lists the conversations flagged as important — either starred by a person or scored high by the system — so the ones that matter most are together in one view.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member with more replies than time, **I want** to star a conversation and see all starred ones together, **so that** the deal-shaped replies do not get buried under out-of-office notices.

**Acceptance criteria**
- [ ] Given starred conversations, when I list them, then each row returns `is_important: true`, the `lead` (including `title` and `company`), the `campaign`, the `last_message` subject, body snippet and `received_at`, the `email_status`, the `category` and `total_count`.
- [ ] Given the system scores importance, when a reply arrives from a decision-maker title or contains a strong buying signal, then it carries an `importance_score` and the reason for the score is shown in words, never as a bare number.
- [ ] Given I star or unstar a conversation, when I do it from the list or the thread, then the change is immediate and reversible, and appears in the activity trail with the actor.
- [ ] Given `limit` outside 1–20 or `filters.search` beyond 30 characters, when I list, then I get 422 with a field-level message.
- [ ] Given `filters.campaignId` with more than 5 ids or `filters.emailAccountId` with more than 10, when I list, then the documented ceilings are enforced and the UI prevents selecting past them.
- [ ] Given `sortBy` of `REPLY_TIME_DESC` (default) or `SENT_TIME_DESC`, when I list, then the order matches.
- [ ] Given no starred or high-scoring conversations, when I open the view, then I get 200 with an empty list and an empty state that explains how a conversation becomes important.
- [ ] Given a conversation reaches a terminal outcome, when it is archived, then it drops out of the important view even if still starred, so the view stays a working queue.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"offset": 0, "limit": 20, "filters": {"emailStatus": "Replied", "leadCategories": {"categoryIdsIn": [1, 2]}}, "sortBy": "REPLY_TIME_DESC"}` | 200 with `messages[]` each carrying `is_important: true`, `importance_score`, `lead.title`, `lead.company`, `category`; `total_count` present |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again" |
| TC-3 | Not found / wrong workspace | Filter by a `campaignId` from another workspace | 404 or empty result with no cross-workspace rows |
| TC-4 | Validation failure — limit | POST `limit: 100` | 422 naming `limit` and the 1–20 range |
| TC-5 | Rate limited | Poll the view aggressively | 429 on the excess; client backs off with jitter and keeps the last good page |
| TC-6 | Empty result set | Open the view with nothing starred | 200, empty list, `total_count: 0`; empty state reads "Nothing marked important yet — star a reply to pin it here" |
| TC-7 | Star and unstar | Star a conversation, list, unstar, list again | It appears then disappears; both actions are in the activity trail with the actor |
| TC-8 | Category filter ceiling | POST `leadCategories.categoryIdsIn` with 11 ids | 422 naming the 10-item maximum; the picker refuses an eleventh selection |
| TC-9 | Automatic importance | Simulate a reply from a lead whose title matches a decision-maker pattern with "budget approved" in the body | The conversation appears with a stated reason ("Decision-maker title", "Buying signal in reply"), matching how Harry's qualification already gives plain-language reasons |
| TC-10 | No fabricated importance | Simulate a reply from a lead with no title data and neutral wording | It is not marked important and no reason is invented; unknown data lowers confidence rather than raising a score |
| TC-11 | Archived exclusion | Star a conversation, then let its lead reach a Won terminal node | The conversation leaves the important view; the star is preserved if it is unarchived |

## 4. Frontend user story

**As a** team member, **I want** a star on every conversation and an Important filter in the Inbox, **so that** my priority queue is one click away and one click to leave.

**Scope**
- Inbox → Replies: a star control on each row and in the thread header, plus "Important" in the same filter group that holds the owner and archived filters — no new tab.
- Rows in the Important view show the lead's title and company alongside the name, because seniority is the usual reason something is important; the automatic reason is shown as a short text chip beside the star.
- The star and the intent chip are visually distinct so "important" is never confused with "interested" — one is a human's priority, the other is the classifier's reading of the reply.
- Loading: skeleton rows. Empty: "Nothing marked important yet" with a one-line explanation. Error: inline banner with Retry preserving filters.
- Accessibility: the star is a toggle button with an accessible name that states the current state ("Mark thread with Sarah Williams important" / "Remove important mark"); importance reasons are text; the star is not the only indicator — the row also carries the word "Important" in its metadata line. Responsive: title and company truncate with a tooltip and full text available in the thread.

**Definition of done**
- [ ] Star toggles from both the list row and the thread header, updating without a reload.
- [ ] The Important filter composes with the existing campaign, mailbox, status and date filters.
- [ ] Automatic importance always shows a plain-language reason and never a bare score.
- [ ] Loading, empty, error and filter-ceiling states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** an important flag plus an explainable importance score on conversations, **so that** the priority queue is both user-controlled and helpfully pre-populated.

**Scope**
- Route in `server/routes.js`: extend the inbox list route with `important=true`, and add `PATCH /api/inbox/threads/:id` accepting `{ important: true|false }`. Workspace-scoped, 404 outside the workspace.
- Data model: `is_important`, `important_by`, `importance_score` and `importance_reasons` (JSON array of short strings) on the thread grouping, indexed on (`workspace_id`, `is_important`, `last_reply_at`).
- Scoring: computed in `server/ai.js` at classification time from the lead's title, the reply's wording and the lead's ICP score, reusing the existing qualification convention of reasons with no fabrication — unknown data lowers confidence rather than inflating the score. Without an `ANTHROPIC_API_KEY` the deterministic keyword path still produces a score and reasons, consistent with the rest of the product.
- A manual star always wins over the automatic score and is never overwritten by a later classification.
- Pagination and filter ceilings mirror the other inbox list routes (limit capped at 20, at most 5 campaigns and 10 mailboxes or categories per request); 429 retried by the client with backoff and jitter.
- Logged: an `events` row per star and unstar with actor; `telemetry` records the distribution of automatic scores so Monitoring can show whether scoring is drifting toward marking everything important.

**Definition of done**
- [ ] Flag, score, reasons, index and routes exist, covered by tests including cross-workspace 404.
- [ ] A test asserts a manual star survives a subsequent automatic re-score.
- [ ] A test asserts the no-API-key path still produces a score with reasons.
- [ ] Star and unstar appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Pin the replies that matter and prove the rest stay out of the way

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, five leads that have replied — one from a lead with the title "Head of Operations" whose reply says budget is approved, one out-of-office, three neutral.

**Flow**
1. Open Inbox → Replies and switch the filter to Important.
2. Confirm what is there before any manual starring.
3. Return to the unfiltered list and star one of the neutral replies.
4. Switch back to Important.
5. Open the automatically flagged thread and read the reason.
6. Unstar the neutral reply from the thread header.

**Assertions**
- [ ] Before any starring, the Important view contains only the decision-maker reply, with a stated reason and no invented detail about the out-of-office one.
- [ ] After starring, the neutral reply joins the view and shows no automatic reason, only the manual star.
- [ ] The lead's title and company are visible on the Important rows.
- [ ] Unstarring removes the neutral reply immediately and the count updates.
- [ ] The activity trail records the star and the unstar with the actor; the automatic flag is recorded with its reason, not as a user action.

**Teardown:** Unstar everything, delete the campaign and leads, reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Star per row and an Important filter | Medium | Star sits in the row's existing action slot; the filter joins the same group as owner and archived rather than becoming a tab |
| Inbox thread header | Star toggle | Low | One toggle beside the existing reclassify control |
| Reports | Importance is available as a lens on reply intent | Low | Reuses the existing reply-intent breakdown; no new chart |
| Monitoring | Score distribution telemetry | Low | Invisible to users; one line in the existing telemetry list |

**Verdict:** Fits an existing surface

Harry already classifies every reply by intent and shows it as a chip, so "interested" is covered — what is missing is a human's own priority mark that survives whatever the classifier thinks. Adding a star and one more filter value keeps that within the Replies tab, and the automatic scoring reuses the qualification conventions the product already follows so it does not introduce a second, unexplained way of ranking leads.
