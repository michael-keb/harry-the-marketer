# Lead to Reply Time

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/campaign/lead-to-reply-time` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/lead-to-reply-time |
| **Auth** | API key (query param `api_key`) |

Buckets replies by how long they took to arrive after the email went out — within an hour, within six, within a day, and so on.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer setting follow-up timing, **I want** to see how long replies actually take to arrive, **so that** my `no reply 3d` edges are based on evidence rather than a guess.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the distribution, then `data.lead_to_reply_time` returns `{ time_range, count }` buckets such as `"0-1h"`, `"1-6h"` and `"6-24h"`.
- [ ] Given the buckets arrive as strings, when they are rendered, then they are shown in chronological order regardless of the order the API returned them, and never sorted alphabetically.
- [ ] Given a bucket has no replies, when the chart renders, then it is drawn at zero so the shape of the distribution is honest rather than compressed.
- [ ] Given the distribution is shown, when Harry's smart follow-up timing adjusts a `no reply` wait, then the panel says which adjustment the evidence supports and links to the campaign editor, without changing the diagram automatically.
- [ ] Given no replies arrived in the range, when the distribution is requested, then a 200 with an empty list produces an empty state naming the range.
- [ ] Given `campaign_ids` is supplied, when the distribution is requested, then only those campaigns contribute, so playbooks with different waits can be compared.
- [ ] Given the median bucket is derivable from the counts, when the panel renders, then the median reply time is stated in plain English above the chart.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 15 replies within an hour, 25 within six, 18 within a day. Request that range | 200 with three buckets carrying 15, 25 and 18 |
| TC-2 | Missing/invalid API key | Repeat TC-1 with a junk key | 401 `{"message": "Invalid API Key"}`; the panel shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or an empty list; nothing leaks |
| TC-4 | Validation failure | Omit `end_date` | 422 `{"error": "Invalid parameters provided"}` naming `end_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous chart marked stale |
| TC-6 | Empty result set | Request a range with no replies | 200, `lead_to_reply_time: []`; empty state names the range |
| TC-7 | Bucket ordering | Return the buckets in a scrambled order | The chart still renders 0-1h, 1-6h, 6-24h, and any longer buckets, in time order |
| TC-8 | Unknown bucket label | Force a bucket labelled `"7d+"` that Harry has not seen | It renders last with its literal label and a telemetry note; nothing crashes |
| TC-9 | Median statement | Seed a distribution whose median falls in 1-6h | The panel reads "half of replies arrive within 6 hours" |
| TC-10 | Evidence versus playbook | Seed a campaign with a `no reply 3d` edge where 95% of replies arrive inside 24h | The panel suggests a shorter wait and links to the editor without editing the diagram |
| TC-11 | Long tail | Seed one reply after 30 days | It lands in the longest bucket rather than being dropped, and the tail is visible |

## 4. Frontend user story

**As a** marketer, **I want** a reply-timing distribution in the Reports Learning section, **so that** the wait I wrote into a playbook can be checked against what leads actually do.

**Scope**
- Reports page: a small histogram in the existing Learning section, ordered by time bucket, with the median stated in a sentence above it.
- When a campaign is selected, the panel compares the distribution with that playbook's `no reply Xd` edges and names the edge that looks mistimed, linking to the campaign editor at that node.
- Loading shows a skeleton histogram. Empty shows "No replies between X and Y". Error keeps the rest of the Learning section rendered.
- Accessibility: a data-table fallback listing bucket and count, text labels on each bar, and the histogram in its own scroll container on narrow screens.

**Definition of done**
- [ ] Buckets always render in time order, never alphabetically.
- [ ] The median sentence is present whenever there is at least one reply.
- [ ] The playbook comparison never edits a diagram, only links to it.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** the elapsed time between each send and its first reply bucketed over a window, **so that** follow-up timing advice is grounded in this workspace's own data.

**Scope**
- Add `GET /api/analytics/reply-time-distribution?from=&to=&timezone=&campaign_ids=` to `server/routes.js`, workspace-scoped, returning ordered `[{ bucket, from_hours, to_hours, count }]` so the client never parses a label to sort it.
- Data model: none. Compute the difference between a reply's timestamp and the send it answers, from the existing `messages` table; count each lead's first reply only.
- Buckets are fixed at 0-1h, 1-6h, 6-24h, 1-3d, 3-7d and 7d+, returned even when empty. Validate the date pair and cap the window.
- The existing API limiter applies with brief caching per workspace, range and campaign filter.
- Log a `telemetry` row per call; replies with no traceable send are counted in a separate field rather than dropped silently.

**Definition of done**
- [ ] Buckets are returned with numeric bounds and a stable order.
- [ ] Only a lead's first reply is counted, unit tested against a lead that replied three times.
- [ ] Empty buckets come back with zero rather than being omitted.
- [ ] Cross-workspace campaigns contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — reply timing versus playbook waits

**Preconditions:** A workspace with one campaign whose playbook has a `no reply 3d` edge, on a sandbox mailbox. Simulated replies: three within an hour, four within six hours, one after five days.

**Flow**
1. Sign in and open Reports.
2. Set the range to cover the replies.
3. Read the histogram and the median sentence in the Learning section.
4. Follow the link to the campaign editor.
5. Change the edge to `no reply 1d`, save, and return to Reports.

**Assertions**
- [ ] The histogram shows all six buckets, with empty ones at zero.
- [ ] The median sentence names the 1-6h bucket.
- [ ] The panel flags the `no reply 3d` edge as later than the evidence supports.
- [ ] The link opens the editor focused on that edge and no diagram was changed automatically.
- [ ] After the edit, the flag disappears on reload.

**Teardown:** Delete the seeded campaign, leads and messages; restore the original playbook text.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | The Learning section gains one small histogram and a median sentence | Low | One compact chart inside a section built for exactly this kind of advice |
| Campaign editor | Becomes the click-through target for a mistimed edge | Low | Uses node focus the editor already supports; nothing is auto-edited |
| Monitoring | New telemetry rows only | Low | Folds into the existing tick-duration list |

**Verdict:** Fits an existing surface

Harry already adjusts `no reply` waits automatically within a half-to-double bound and writes the reason into the activity trail, but it never shows the user the underlying distribution. This makes that evidence visible in the section that already tells users which steps to lean into — and it stops short of touching the diagram, which stays the author's.
