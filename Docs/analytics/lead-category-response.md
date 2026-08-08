# Lead Category-wise Response

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/lead/category-wise-response` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/lead-category-response |
| **Auth** | API key (query param `api_key`) |

Breaks all replies in a date range into named categories — Interested, Not Interested, Out of Office and so on — with a count and a share for each.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer, **I want** every reply in a date range grouped by its category with a count and a share, **so that** I can see at a glance whether my replies are mostly interest, mostly refusal, or mostly auto-responders.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the breakdown, then `data.lead_responses_by_category` returns `{ category, total_response, percentage }` objects, for example `"Interested"` with `total_response: 45` and `percentage: "15%"`.
- [ ] Given Harry's categories are the classifier's intents, when the breakdown renders, then it uses Harry's own labels — interested, not interested, not now, question, unsubscribe, out of office — plus any custom edge label the workspace has written into a playbook.
- [ ] Given a reply matched no edge and was flagged as needing attention, when the breakdown renders, then it appears in its own "needs attention" category rather than being dropped or forced into a bucket.
- [ ] Given `percentage` is returned as a string with a `%`, when it is displayed, then it is parsed once and the shares are shown to one decimal place summing to 100% (with rounding handled so the total is never 99.9%).
- [ ] Given no replies arrived in the range, when the breakdown is requested, then a 200 with an empty list produces an empty state naming the range, not a chart of zeros.
- [ ] Given `campaign_ids` is supplied, when the breakdown is requested, then only replies to those campaigns are counted.
- [ ] Given a reply is reclassified in Inbox, when the breakdown is reloaded, then the counts move, because categories are mutable.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 45 interested, 30 not interested and 12 out-of-office replies in January. Request that range | 200 with three entries carrying those counts and percentage strings |
| TC-2 | Missing/invalid API key | Repeat TC-1 with a junk key | 401 `{"message": "Invalid API Key"}`; the panel shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or an empty list; nothing leaks |
| TC-4 | Validation failure | Pass `start_date=2024-01-32` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous breakdown marked stale |
| TC-6 | Empty result set | Request a range with no replies | 200, `lead_responses_by_category: []`; empty state names the range |
| TC-7 | Custom edge label | Seed a playbook with a `reply: send pricing` edge and one matching reply | A "send pricing" category appears alongside the built-ins |
| TC-8 | Needs attention | Seed a reply that matches no edge | It appears in its own category, and clicking it opens the Action Center |
| TC-9 | Percentage parsing | Inspect a `"15%"` value and the rendered share | It shows as 15.0%, never 0.15% or 1500% |
| TC-10 | Rounding | Seed counts that round to 33.3 / 33.3 / 33.3 | The displayed shares total exactly 100% by the documented rounding rule |
| TC-11 | Reclassification | Run TC-1, reclassify one reply in Inbox, re-run | Two categories change by one each and the total is unchanged |

## 4. Frontend user story

**As a** marketer, **I want** the reply-intent breakdown on Reports to carry counts and shares for a chosen range, **so that** it answers "what kind of answers am I getting" rather than just listing chips.

**Scope**
- Reports page: the existing reply-intent breakdown gains a share column and the shared date range, ordered by count descending with any "needs attention" category pinned to the top regardless of size.
- Each category links to Inbox filtered to that intent, and "needs attention" links to the Dashboard Action Center instead.
- Loading shows skeleton rows. Empty shows "No replies between X and Y". Error keeps the previous breakdown and marks it stale.
- Accessibility: a table with category, count and share, so the numbers are readable without the bar; bars are decorative with `aria-hidden`; the layout stacks on narrow screens.

**Definition of done**
- [ ] Shares are computed from the counts client-side only if the server omits them, and never from rounded values.
- [ ] "Needs attention" is always visible when non-zero, even at 1%.
- [ ] Each row links to the matching Inbox or Action Center filter.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** replies grouped by classified intent over a window, **so that** the breakdown comes from one aggregate shared with the Inbox chips.

**Scope**
- Add `GET /api/analytics/replies/by-category?from=&to=&timezone=&campaign_ids=` to `server/routes.js`, workspace-scoped, returning `[{ category, total_response, share }]` with `share` as a number.
- Data model: none. Group classified replies from `messages` by their stored intent; custom edge labels come through as-is, and unmatched replies are grouped under a reserved `needs_attention` key that cannot collide with a user's label.
- Filter and group on reply time. Validate the date pair, cap the window, and return an empty array rather than a zero-filled skeleton.
- The existing API limiter applies with brief caching per workspace, range and campaign filter.
- Log a `telemetry` row per call; the volume of `needs_attention` is included so Monitoring can show classifier drift.

**Definition of done**
- [ ] Category keys are returned raw and labels are formatted only in the UI.
- [ ] Shares sum to 100 within one rounding unit, asserted by a test.
- [ ] The reserved `needs_attention` key cannot be produced by a user-authored edge label.
- [ ] Cross-workspace campaigns contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — reply categories on Reports

**Preconditions:** A workspace with two campaigns on a sandbox mailbox, one playbook carrying a custom `reply: send pricing` edge. Seeded replies: 4 interested, 3 not interested, 2 out of office, 1 send pricing, 1 unmatched.

**Flow**
1. Sign in and open Reports.
2. Set the range to cover the replies.
3. Read the breakdown.
4. Click "interested".
5. Click "needs attention".
6. Reclassify the unmatched reply as interested in Inbox and return.

**Assertions**
- [ ] All five categories appear, including the custom label.
- [ ] Shares total 100% as displayed.
- [ ] "Needs attention" is pinned to the top despite being the smallest.
- [ ] The interested link lands on Inbox filtered to interested; the needs-attention link lands on the Action Center.
- [ ] After reclassification the needs-attention category disappears and interested rises to 5.

**Teardown:** Delete the seeded campaigns, leads, messages and classifications.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | The existing reply-intent breakdown gains shares and a date range | Low | Same panel, one extra column |
| Inbox | Becomes the click-through target per category | Low | Uses the intent filters Inbox already has |
| Dashboard | The Action Center is linked from the needs-attention row | Low | A link, not a new control |

**Verdict:** Fits an existing surface

Harry already classifies every reply against the playbook's edge labels and already draws a reply-intent breakdown on Reports, so the categories themselves are not new. What this adds is the share alongside the count, a chosen date range, and the discipline of showing unmatched replies as their own category instead of losing them.
