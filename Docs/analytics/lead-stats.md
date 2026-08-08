# Lead Statistics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/lead/overall-stats` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/lead-stats |
| **Auth** | API key (query param `api_key`) |

Splits the leads contacted in a date range into those hearing from you for the first time and those being followed up, with counts and shares.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer, **I want** to know how much of my sending went to new leads versus follow-ups, **so that** I can tell whether the pipeline is actually growing or I am just chasing the same people harder.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the stats, then `data.lead_stats` returns `count` with `total`, `new` and `follow_up`, and `percentage` with `new` and `follow_up`.
- [ ] Given `count.new` plus `count.follow_up` should equal `count.total`, when they do not, then the discrepancy is logged to telemetry and the UI shows the totals it received rather than silently correcting them.
- [ ] Given `percentage.new` is returned as a bare number such as `60`, when it is rendered, then it shows as `60%` and is never divided by 100 again.
- [ ] Given a lead was contacted for the first time inside the range, when the split is computed, then that lead counts as new even if it later received a follow-up in the same range, and the rule is stated in the panel.
- [ ] Given no leads were contacted in the range, when the stats are requested, then a 200 with zeroed counts produces an empty state naming the range rather than a chart showing 0% / 0%.
- [ ] Given `campaign_ids` is supplied, when the stats are requested, then only those campaigns' contacts are counted.
- [ ] Given the split is shown next to Harry's existing pipeline funnel, when both are read together, then the funnel's "contacted" stage total and `count.total` agree for the same window.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 1000 leads contacted in January, 600 for the first time. Request that range | 200 with `count: {total: 1000, new: 600, follow_up: 400}` and `percentage: {new: 60, follow_up: 40}` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; the panel shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or zeroed counts; nothing leaks |
| TC-4 | Validation failure | Pass `end_date` earlier than `start_date` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous split marked stale |
| TC-6 | Empty result set | Request a range with no sends | 200 with all counts zero; empty state names the range |
| TC-7 | New then followed up in one range | Seed a lead first contacted on day 1 and chased on day 4 inside the range | The lead is counted once, as new; the panel states the rule |
| TC-8 | Percentage rendering | Inspect `percentage.new` of `60` and the tile | Shows `60%`, never `0.6%` or `6000%` |
| TC-9 | Parts equal the total | Assert `new + follow_up == total` across ten seeded ranges | Always equal; any mismatch produces a telemetry warning |
| TC-10 | Agreement with the funnel | Compare `count.total` with the Reports funnel's contacted stage for the same window | The two agree |
| TC-11 | Timezone boundary | Request the same day with `timezone=America/New_York` and none | Boundary contacts move; the caption names the applied timezone |

## 4. Frontend user story

**As a** marketer, **I want** a new-versus-follow-up split above the Reports pipeline funnel, **so that** I can see whether this month's effort is opening doors or knocking on the same ones.

**Scope**
- Reports page: one split bar above the existing pipeline funnel showing new and follow-up counts with their shares for the shared date range.
- Clicking a segment opens Leads filtered to leads first contacted in the range, or to those already in progress, using the existing click-to-filter stage strip.
- Loading shows a skeleton bar. Empty shows "Nothing was sent between X and Y". Error hides the bar without disturbing the funnel below.
- Accessibility: the split is a definition list with both counts and shares in text; the bar itself is decorative; on narrow screens it becomes two stacked lines.

**Definition of done**
- [ ] Counts and shares are both visible without hovering.
- [ ] The panel states that a lead first contacted in the range counts as new even if chased later in it.
- [ ] Clicking a segment lands on the matching Leads filter.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** a new-versus-follow-up split for contacted leads in a window, **so that** Reports can show effort mix without the browser scanning message history.

**Scope**
- Add `GET /api/analytics/leads/contact-mix?from=&to=&timezone=&campaign_ids=` to `server/routes.js`, workspace-scoped, returning `{ total, new, follow_up, new_share, follow_up_share }`.
- Data model: none. A lead is "new" in the range when its earliest message in that campaign falls inside the range; anything else counted is a follow-up. Reuse the derived stage logic that already powers the Leads page rather than storing a flag.
- Validate the date pair, cap the window, and return shares as numbers with `null` when `total` is zero.
- The existing API limiter applies with brief caching per workspace and range.
- Log a `telemetry` row per call, and an extra warning row if `new + follow_up` ever differs from `total`.

**Definition of done**
- [ ] The new-versus-follow-up rule is unit tested on a lead contacted before the range and chased inside it.
- [ ] `total` matches the funnel's contacted count for the same window, asserted by a test.
- [ ] Zero-contact ranges return zeros and null shares.
- [ ] Cross-workspace campaigns contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — new versus follow-up effort mix

**Preconditions:** A workspace with one campaign on a sandbox mailbox. Five leads first contacted inside the test week; three leads first contacted the previous week and chased inside it; one lead contacted and chased within the test week.

**Flow**
1. Sign in and open Reports.
2. Set the range to the test week.
3. Read the split bar.
4. Click the follow-up segment.
5. Widen the range to include the previous week.

**Assertions**
- [ ] The split shows six new (including the contacted-and-chased lead, counted once) and three follow-up.
- [ ] The shares are shown as whole numbers summing to 100%.
- [ ] The follow-up segment opens Leads filtered to leads already in progress.
- [ ] Widening the range moves the three previous-week leads into new.
- [ ] The total matches the funnel's contacted stage for each range.

**Teardown:** Delete the seeded campaign, leads and messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | Adds one split bar above the existing funnel | Low | Two numbers and two shares on a single line, no chart library needed |
| Leads | Becomes the click-through target | Low | Uses the click-to-filter stage strip that already exists |
| Dashboard | None | Low | The KPI tiles already carry contacted counts |

**Verdict:** Fits an existing surface

Harry's Leads page already derives every prospect's stage — not contacted, contacted, replied and so on — so it knows which leads are new, but Reports never expresses the effort mix as a share. One split bar above the funnel is the whole change, and it reuses the derived stages rather than storing anything.
