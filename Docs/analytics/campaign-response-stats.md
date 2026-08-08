# Campaign Response Stats

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/campaign/response-stats` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/campaign-response-stats |
| **Auth** | API key (query param `api_key`) |

Splits each campaign's replies into positive, neutral and negative, counted on the day the reply arrived.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer, **I want** each campaign's replies broken into positive, neutral and negative for a date range, **so that** I can tell a campaign that gets lots of polite brush-offs from one that gets fewer replies but better ones.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request response stats, then `data.campaign_wise_response_stats` returns one object per campaign with `campaign_id`, `campaign_name`, `positive_reply`, `neutral_reply` and `negative_reply`.
- [ ] Given a reply arrived inside the range for an email sent before it, when the stats are computed, then that reply is counted — this endpoint is anchored to reply date, not send date, and the UI caption says so.
- [ ] Given a lead replied twice and is categorised positive, when the stats are computed, then `positive_reply` counts two, because these are response events and not distinct leads.
- [ ] Given the same window is shown on the Dashboard tile, when the two positive numbers differ, then Harry shows the difference as expected and links to the definition instead of reconciling them silently.
- [ ] Given a campaign has replies that carry no sentiment category, when the stats are rendered, then those replies appear in an "uncategorised" bucket rather than being folded into neutral.
- [ ] Given no replies landed in the range, when I request the stats, then I get a 200 with an empty list and an empty state naming the range.
- [ ] Given a lead is re-categorised after the fact, when the same range is requested again, then the historical numbers change, and the panel carries a note that categories are mutable.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign with 25 positive, 10 neutral and 5 negative replies in January. Call with that range | 200, one row with `positive_reply: 25`, `neutral_reply: 10`, `negative_reply: 5` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with a junk `api_key` | 401 `{"message": "Invalid API Key"}`; panel shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` belonging to another workspace | 404 `{"error": "Resource not found"}` or an empty list; no names leak |
| TC-4 | Validation failure | Omit `end_date` | 422 `{"error": "Invalid parameters provided"}` naming `end_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the last good breakdown on screen marked stale |
| TC-6 | Empty result set | Request a range with no replies at all | 200, `campaign_wise_response_stats: []`, empty state reads "No replies between X and Y" |
| TC-7 | Double reply from one lead | Seed one positive lead who replied twice inside the range | `positive_reply` is 2 while the overview tile's `positive_replied` for the same window is 1; both are displayed with their own labels |
| TC-8 | Reply-date vs send-date | Seed an email sent on the day before `start_date` whose reply lands inside the range | The reply is counted here but not by the send-time endpoints; the caption says "replies received between X and Y" |
| TC-9 | Re-categorisation | Run TC-1, flip one lead from positive to negative, re-run | `positive_reply` drops by one and `negative_reply` rises by one; the panel note about mutable categories is visible |
| TC-10 | Timezone boundary | Request one day with `timezone=America/New_York` and again with none | A reply near midnight moves between days; the caption states the applied timezone |

## 4. Frontend user story

**As a** marketer, **I want** the reply-intent breakdown on Reports to be per campaign and date-ranged, **so that** I can see which playbook is attracting the right kind of answer.

**Scope**
- Reports page: the existing reply-intent breakdown becomes groupable by campaign, rendered as a stacked bar per campaign with segments for positive, neutral, negative and uncategorised.
- Clicking a segment deep-links to Inbox filtered to that campaign and intent, so the numbers stay one click from the actual replies.
- Loading shows a skeleton bar row. Empty shows "No replies between X and Y". Error keeps the previous chart and marks it stale.
- Accessibility: the chart has a table fallback with the same numbers, segment colours are distinguishable without colour alone (labelled directly), and the layout stacks vertically under 640px.

**Definition of done**
- [ ] Every segment shows both the count and the share of the campaign's replies.
- [ ] The panel states that counts are reply events, not unique leads, and that they are attributed to the reply date.
- [ ] Clicking through to Inbox lands on the matching filter.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** a route that groups replies by campaign and sentiment over a window, **so that** the reply-intent panel reads one aggregate rather than every message row.

**Scope**
- Add `GET /api/analytics/campaigns/response-stats?from=&to=&timezone=&campaign_ids=` to `server/routes.js`, workspace-scoped.
- Data model: none new. Map Harry's classified intents onto the three sentiment buckets in one shared module so Reports, Inbox chips and this route never disagree; `interested` maps to positive, `not interested` and `unsubscribe` to negative, `question`, `not now` and `out of office` to neutral, and anything unmatched to uncategorised.
- Filter and group on reply time, not send time. Validate the date pair and reject an inverted range with a 422.
- Rate limiting uses the existing API limiter; results are cached briefly per workspace and range.
- Log a `telemetry` row per call with range, campaign count and duration.

**Definition of done**
- [ ] The intent-to-sentiment map lives in one place and is unit tested against every built-in intent.
- [ ] Counts are reply events, documented in the route's response as `counting: "reply_events"`.
- [ ] Uncategorised replies are returned in their own field, never silently merged.
- [ ] Cross-workspace requests return no rows.

## 6. End-to-end test ticket

**Title:** E2E — reply sentiment by campaign

**Preconditions:** Two campaigns on a sandbox mailbox. Campaign A: 3 interested, 2 not interested, 1 question. Campaign B: 1 interested, 4 out of office. One lead in A replies twice, both interested.

**Flow**
1. Sign in and open Reports.
2. Set the range to cover all seeded replies.
3. Read the stacked bars for A and B.
4. Click the positive segment on A.
5. Narrow the range to exclude the double replier's second message.

**Assertions**
- [ ] A's positive count includes both replies from the double replier (4, not 3).
- [ ] B is mostly neutral, showing that reply volume alone would have ranked it wrongly.
- [ ] Clicking the positive segment opens Inbox filtered to campaign A with interested replies.
- [ ] Narrowing the range lowers A's positive count by exactly one.

**Teardown:** Delete the seeded campaigns, leads, messages and classifications.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | The existing reply-intent breakdown gains a per-campaign grouping and a date range | Low | Same panel, one grouping toggle; workspace-wide stays the default view |
| Inbox | Becomes the click-through target for a chart segment | Low | Uses the intent filters Inbox already has, no new controls |
| Dashboard | None | Low | Tiles stay at workspace level |

**Verdict:** Fits an existing surface

Harry already classifies every reply by intent and already draws a reply-intent breakdown on Reports. What is new is grouping it by campaign over a chosen window and being explicit that the count is reply events rather than distinct leads. That is a grouping toggle and a footnote on a panel that exists, not a new surface.
