# Get Campaign Analytics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/analytics` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-analytics |
| **Auth** | API key (query param `api_key`) |

Returns one campaign's headline numbers: how many emails went out and how many were opened, clicked, replied to, bounced or unsubscribed.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** the headline numbers for a campaign in one place, **so that** I can tell whether it is working without reading every thread.

**Acceptance criteria**
- [ ] Given a campaign with activity, when I request its analytics, then I get the totals and the rates together — sent, opened, clicked, replied, plus open, click, reply, bounce and unsubscribe rates, mirroring the source API's `total_sent`, `total_opened`, `total_clicked`, `total_replied`, `open_rate`, `click_rate`, `reply_rate`, `bounce_rate`, `unsubscribe_rate`.
- [ ] Given rates are percentages, when they are computed, then the denominator is stated on screen (opens and clicks over delivered, replies over delivered, unsubscribes over delivered) so two people reading the same number reach the same conclusion.
- [ ] Given open tracking is disabled for the campaign, when I view analytics, then the open rate is shown as unavailable with the reason, never as 0% — a zero that means "not measured" is worse than no number.
- [ ] Given a brand-new campaign with nothing sent, when I view analytics, then every metric reads as "no data yet" with the campaign's readiness state, not as zeros implying failure.
- [ ] Given Harry grades against cold-outreach benchmarks on Monitoring, when a rate is shown, then it carries the same benchmark grading so "8.5% reply rate" is accompanied by whether that is good.
- [ ] Given a campaign is running, when I reload, then the numbers reflect activity up to the last engine tick, and the page states when they were last computed.
- [ ] Given a campaign in another workspace, when I request its analytics, then I get a 404 and no numbers.
- [ ] Given replies were reclassified by a human, when analytics are computed, then the reply count follows the corrected classification rather than the agent's first guess.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET analytics for a campaign with 1000 sent, 450 opened, 120 clicked, 85 replied | 200 with those totals and `open_rate: 45.0`, `click_rate: 12.0`, `reply_rate: 8.5`, plus bounce and unsubscribe rates |
| TC-2 | Missing/invalid API key | GET unauthenticated | 401; UI sends the user to sign-in and shows no stale numbers |
| TC-3 | Not found / wrong workspace | GET analytics for another workspace's campaign | 404; no numbers returned |
| TC-4 | Validation failure | GET with a non-numeric campaign id | 422 with a field-level message on the campaign id |
| TC-5 | Rate limited | Poll analytics every second | 429 on the excess; UI keeps the last figures with a "last updated" timestamp |
| TC-6 | Empty result set | GET analytics for a campaign that has sent nothing | 200 with zero totals; UI shows "No data yet" and what the campaign is waiting for |
| TC-7 | Tracking disabled | GET analytics for a campaign with open tracking off | Open rate returned as unavailable with a reason, not 0%; reply rate still computed normally |
| TC-8 | Rate arithmetic | Campaign with 100 sent, 3 bounced, 20 opened | Open rate is computed over 97 delivered, and the UI names the denominator |
| TC-9 | Reclassified reply | Reclassify one reply from "out of office" to "interested" in Inbox | Reply total unchanged, interested count increases, and the change is visible after the next computation |
| TC-10 | Duplicate opens | One recipient opens the same email six times | Counted once for open rate; the raw open events remain visible on the message |
| TC-11 | Consistency with Reports | Compare campaign analytics with the same campaign's row in Reports | The two agree exactly, since both read the same computation |

## 4. Frontend user story

**As a** campaign owner, **I want** a short, honest summary strip at the top of the campaign page, **so that** the first thing I see tells me whether this campaign deserves more of my time.

**Scope**
- Campaigns → campaign detail: a metrics strip above the playbook showing sent, delivered, open, click, reply, interested, bounce and unsubscribe, each as a count with its rate, and each graded against the cold-outreach benchmarks already used on Monitoring.
- Any metric that cannot be measured (open rate with tracking off) renders as "not tracked" with a one-line reason and a link to the setting that changes it.
- The strip states when it was last computed and offers a refresh; it never silently shows stale figures as live.
- Loading: skeleton tiles keeping the layout stable. Empty: "No emails sent yet" plus the readiness state. Error: the strip keeps its last values, greys them, and shows a retry.
- Accessibility: each tile is a labelled figure with the number, the rate and the benchmark verdict in text; benchmark grading is never colour alone. Responsive: the strip wraps from eight tiles to two columns under 768px, prioritising reply and interested.

**Definition of done**
- [ ] Every tile states its denominator in a tooltip or caption.
- [ ] "Not tracked" is visually distinct from zero and explains itself.
- [ ] Benchmark grading matches Monitoring's, using the same thresholds.
- [ ] The strip's numbers match Reports for the same campaign.

## 5. Backend user story

**As a** Harry API, **I want** one analytics route per campaign computed from stored events, **so that** the number on the campaign page cannot drift from the raw record.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns/:id/analytics`, workspace-scoped, returning totals, rates, denominators and a `computedAt` timestamp.
- Data model: no new table. Everything is derived from `messages` (sent, delivered, bounced, opened, clicked, replied), reply classifications and unsubscribes, exactly as Harry derives lead stage — computed, never stored, so it cannot drift.
- Rates return `null` rather than `0` when the underlying signal is not collected (open tracking off), with a `reason` field the UI renders.
- Opens and clicks are deduplicated per message per recipient for rate purposes; raw events remain queryable for the thread view. Standard rate limiting; a short server-side cache keyed on campaign and last message id keeps repeated loads cheap without serving stale data after new activity.
- Logged: nothing to `events`. `telemetry` records computation duration so Monitoring can flag when the aggregate query slows down.

**Definition of done**
- [ ] Every rate has an explicit denominator in the response.
- [ ] Untracked metrics return null with a reason, covered by a test.
- [ ] Deduplication of repeat opens is covered by a test.
- [ ] A test asserts the campaign endpoint and the Reports aggregate agree on a shared fixture.

## 6. End-to-end test ticket

**Title:** E2E — Read a campaign's headline numbers and trust them

**Preconditions:** A workspace with a sandbox mailbox, a running campaign, 20 leads, approvals on. Fixture activity: 10 approved and sent, 1 hard bounce, 5 opens (one opened six times), 2 clicks, 3 replies of which 1 is out of office, 1 unsubscribe.

**Flow**
1. Open Campaigns → campaign detail and read the metrics strip.
2. Hover or focus each tile to read its denominator.
3. Open Reports and compare the same campaign's row.
4. Reclassify the out-of-office reply as "interested" in Inbox.
5. Refresh the campaign page.
6. Turn open tracking off in the campaign's settings and refresh again.

**Assertions**
- [ ] Sent reads 10, delivered 9, and the open rate is computed over 9, not 10.
- [ ] The recipient who opened six times contributes one open to the rate.
- [ ] Reply rate counts 3 replies; the interested count rises by one after the reclassification.
- [ ] The unsubscribe rate is non-zero and matches one lead.
- [ ] Reports and the campaign page show identical figures at every step.
- [ ] With open tracking off, the open tile reads "not tracked" with a reason, and the reply tile is unaffected.

**Teardown:** Delete the campaign and its sandbox messages; leave the leads.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | Metrics strip above the playbook | Medium | Eight compact tiles, each a number and a verdict; no charts on this page — those stay in Reports |
| Campaigns list | Headline rates on each row | Low | Two values reused from the same computation |
| Reports | Shares the computation | Low | Guarantees the two surfaces cannot disagree |

**Verdict:** Fits an existing surface

Campaign detail is where someone asks "is this working", so the summary belongs there rather than behind a trip to Reports. Keeping it to counts, rates and a benchmark verdict — with charts left to Reports — is what stops the campaign page from turning into a second reporting screen.
