# Get Campaign Analytics by Date Range

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/analytics-by-date` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-analytics-by-date |
| **Auth** | API key (query param `api_key`) |

Returns a campaign's numbers for a chosen window of time rather than for all time.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner who has changed the playbook, **I want** a campaign's numbers for a date range, **so that** I can see whether last week was better than the week before instead of watching a lifetime average absorb the difference.

**Acceptance criteria**
- [ ] Given a start and end date in ISO 8601 (the source API's required `start_date` and `end_date`), when I request analytics, then I get the campaign's totals and rates for that window, and the window itself is echoed back so the numbers can never be read out of context.
- [ ] Given a window, when totals are computed, then an event counts toward it by when the event happened, not by when the email was sent — a reply in March to a February email belongs to March's reply count, and the UI states this rule.
- [ ] Given a missing or malformed date, when I request analytics, then I get a field-level validation error naming the parameter and the expected format, and no partial figures.
- [ ] Given an end date before the start date, when I request analytics, then the request is rejected rather than silently returning zeros.
- [ ] Given a window with no activity, when I request analytics, then I get zeros with an explicit "no activity in this period" flag, so an empty period is distinguishable from a broken query.
- [ ] Given a window shorter than the campaign's sending rhythm can fill, when rates are shown, then a small-sample caution is shown alongside them, because a 100% reply rate on two emails is not a result.
- [ ] Given two windows, when I compare them, then the same computation is used for both, so a difference is a real difference and not a methodology change.
- [ ] Given open tracking is off for the campaign, when I request any window, then open rate returns as unavailable with a reason rather than as zero.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET with `start_date=2025-01-01T00:00:00Z` and `end_date=2025-01-31T23:59:59Z` | 200 echoing both dates with `total_sent`, `open_rate`, `click_rate`, `reply_rate` for January only |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401; no figures returned or cached |
| TC-3 | Not found / wrong workspace | Request a window for another workspace's campaign | 404; no figures |
| TC-4 | Validation failure | Omit `end_date`, then send `start_date=01/01/2025` | 422 in both cases with a field-level message naming the parameter and requiring ISO 8601 |
| TC-5 | Rate limited | Request twelve monthly windows in a tight loop | 429 on the excess; the client batches or backs off and the chart fills progressively rather than failing |
| TC-6 | Empty result set | Request a window before the campaign existed | 200 with zero totals and an explicit "no activity in this period" flag; UI shows an empty chart with that message |
| TC-7 | Inverted range | `start_date` after `end_date` | 422 with a message naming the problem; no figures |
| TC-8 | Boundary inclusion | Place one send at exactly the start timestamp and one at exactly the end timestamp | Both are counted; the boundary rule is stated in the response and the UI |
| TC-9 | Event-time attribution | Send in week 1, reply arrives in week 2; request week 2 | The reply counts in week 2 and the send does not |
| TC-10 | Timezone handling | Request "today" from a browser in Sydney | The window is built from the browser's timezone and converted to UTC; the returned window shows the exact UTC bounds used |
| TC-11 | Small sample | Request a window containing two sends and one reply | Rates returned, accompanied by a small-sample caution |
| TC-12 | Consistency with all-time | Request a window covering the campaign's entire life | Figures match the all-time analytics endpoint exactly |

## 4. Frontend user story

**As a** campaign owner, **I want** a date range control on the campaign's metrics, **so that** I can see whether a change I made to the playbook actually moved anything.

**Scope**
- Campaigns → campaign detail: the metrics strip gains a range control (Last 7 days / Last 30 days / This month / Custom) and, when a range is active, a comparison against the immediately preceding equal-length window ("Reply rate 9.0%, up from 7.2% in the previous 30 days").
- Reports: the existing 30-day series gains the same control so both surfaces answer the same question the same way.
- Change markers: when the playbook was edited inside the window, the chart marks the date, because that is usually the cause of the change being examined.
- Loading: skeleton tiles; empty: "No activity in this period" with the range named; error: previous figures retained and greyed with a retry.
- Accessibility: the range control is a labelled group of buttons plus a date-pair input with real labels; the comparison is stated in text, never as an arrow glyph alone. Responsive: the control collapses into a select under 640px.

**Definition of done**
- [ ] The range control drives both the metrics strip and the chart from one selection.
- [ ] The comparison window is always the immediately preceding equal-length window, and it says so.
- [ ] Empty and small-sample periods are labelled as such.
- [ ] The chosen range is reflected in the URL so a view can be shared.

## 5. Backend user story

**As a** Harry API, **I want** a windowed analytics route, **so that** any surface asking for a period gets the same figures computed the same way.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns/:id/analytics?from=&to=`, workspace-scoped, returning the echoed window, totals, rates, denominators, a `noActivity` flag and a `smallSample` flag. Omitting the window returns all-time, so this and the all-time endpoint are one route.
- Data model: no new table. Aggregates are computed over `messages` and reply classifications filtered by event timestamp, using the index added for the activity feed on `(workspace_id, created_at desc)`.
- Dates are parsed strictly as ISO 8601, rejected when malformed or inverted, and boundaries are inclusive at both ends; the response states the exact UTC bounds used so a client in any timezone can reconcile.
- Standard rate limiting, with a short cache keyed on campaign, window and last message id. A comparison window is computed server-side in the same request to avoid a second round trip.
- Logged: nothing to `events`. `telemetry` records window size and computation duration so Monitoring can catch expensive ranges.

**Definition of done**
- [ ] One route serves both all-time and windowed figures with identical arithmetic.
- [ ] Strict date parsing, inversion rejection and inclusive boundaries are covered by tests.
- [ ] Event-time attribution is covered by a test where a reply and its send fall in different windows.
- [ ] A test asserts a whole-life window equals the all-time result.

## 6. End-to-end test ticket

**Title:** E2E — Prove a playbook change improved the reply rate

**Preconditions:** A workspace with a sandbox mailbox and one campaign with two weeks of fixture history: week 1 has 50 sends and 2 replies, week 2 has 50 sends and 6 replies, with a playbook edit recorded at the start of week 2.

**Flow**
1. Open Campaigns → campaign detail.
2. Set the range to the last 7 days.
3. Read the metrics strip and the comparison line.
4. Switch to a custom range covering week 1 only.
5. Switch to a range covering both weeks.
6. Open Reports and set the same range.

**Assertions**
- [ ] Week 2 shows 6 replies with a comparison against week 1's 2 replies, naming the previous window.
- [ ] The week 1 range shows 2 replies and no comparison beyond the preceding week.
- [ ] The two-week range's totals equal the sum of the two single-week ranges.
- [ ] The chart marks the playbook edit at the start of week 2.
- [ ] Reports shows the same figures for the same range.
- [ ] A range before the campaign existed shows "No activity in this period", not an error.

**Teardown:** Delete the campaign and its fixture messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | Range control and a comparison line on the metrics strip | Medium | Four presets and one custom option; the default (all time) matches today's behaviour so nobody has to choose |
| Reports | The same range control | Low | Replaces the fixed 30-day window with the same component |
| Campaign detail chart | Playbook-edit markers | Low | Thin marks on an existing chart, labelled on hover and listed in text below |

**Verdict:** Fits an existing surface

This is the all-time analytics endpoint with a window, so it belongs on the same strip rather than anywhere new. The one addition worth the space is the comparison against the previous equal window, because "9% reply rate" only becomes a decision when you know what it was before.
