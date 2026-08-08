# Leads Take for First Reply

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/campaign/leads-take-for-first-reply` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/leads-for-first-reply |
| **Auth** | API key (query param `api_key`) |

Returns a single number: on average, how many leads you have to contact before one replies.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer planning a lead list, **I want** to know how many leads it takes to earn one reply, **so that** I can size next month's list from evidence instead of hoping.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the figure, then `data.leads_take_for_first_reply` returns a whole number such as `42`.
- [ ] Given the figure is the inverse of the reply rate, when it is displayed, then it is labelled "leads contacted per reply" and shown next to the reply rate it derives from, so the two are never read as independent facts.
- [ ] Given no replies arrived in the range, when the figure is requested, then it is `null` or zero and the UI shows "no replies yet in this range" rather than infinity or a misleading `0`.
- [ ] Given a goal exists with a target number of meetings, when this figure is known, then the Goals page can state how many leads that target implies, and it says the estimate is based on the selected range.
- [ ] Given `campaign_ids` is supplied, when the figure is requested, then it covers only those campaigns, so a strong playbook is not averaged away by a weak one.
- [ ] Given the sample in the range is small, when fewer than a documented minimum of leads were contacted, then the figure is shown with a "not enough data yet" caveat rather than presented as reliable.
- [ ] Given the API key is invalid, when the figure is requested, then a 401 `{"message": "Invalid API Key"}` is surfaced as one banner without blanking the surrounding panel.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed 420 leads contacted and 10 replies in January. Request that range | 200 with `leads_take_for_first_reply: 42` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with a junk key | 401 `{"message": "Invalid API Key"}`; the tile shows a reconnect message |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}`; no figure is returned |
| TC-4 | Validation failure | Pass `start_date=January 1` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the last known figure marked stale |
| TC-6 | Empty result set | Request a range with contacts but no replies | Null or zero returned; the tile reads "no replies yet in this range" |
| TC-7 | Divide by zero | Seed zero contacts and zero replies | No infinity, no `NaN`; the tile shows `—` |
| TC-8 | Small sample | Seed 12 leads and 1 reply | The figure shows with a "not enough data yet" caveat |
| TC-9 | Consistency with reply rate | Compare the figure with the campaign reply rate for the same window | The figure equals the rounded inverse of the rate, asserted in the test |
| TC-10 | Per-campaign filter | Request all campaigns, then one strong campaign | The single-campaign figure is lower and both are labelled with their scope |
| TC-11 | Goal sizing | Set a goal of 20 meetings with this figure available | The Goals page states the implied lead count and names the range it used |

## 4. Frontend user story

**As a** marketer, **I want** "leads per reply" shown where I plan lists and goals, **so that** the number turns into a decision instead of a curiosity.

**Scope**
- Reports page: one figure beside the existing per-campaign reply rate, labelled in plain English with its range.
- Goals page: the same figure powers a one-line sizing estimate under a goal's target ("about 840 leads at your current rate"), always naming the range it came from.
- Loading shows a skeleton value. Empty and small-sample cases show their caveats in text. Error hides the figure without disturbing the rate beside it.
- Accessibility: figure and label are one definition-list entry so it reads correctly aloud; the caveat is text, not a coloured badge alone.

**Definition of done**
- [ ] The figure never renders as infinity, `NaN` or a bare `0`.
- [ ] The small-sample caveat appears below the documented threshold.
- [ ] The Goals estimate names both the number and the range it was derived from.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** the leads-per-reply figure computed alongside the reply rate, **so that** the two can never disagree.

**Scope**
- Extend the campaign performance route rather than adding a new one: `GET /api/analytics/campaigns/performance` gains `leads_per_reply` per campaign plus a workspace-level figure, workspace-scoped in `server/routes.js`.
- Data model: none. It is `unique_lead_count / replied`, computed from the same aggregate as the reply rate.
- Return `null` when `replied` is zero, and include `sample_size` so the client can apply the small-sample caveat without a second call.
- The existing API limiter and caching apply; no extra request is made for this figure.
- Log nothing extra to `telemetry`; it rides on the performance call's existing entry.

**Definition of done**
- [ ] The figure comes from the same query as the reply rate, asserted by a test that compares them.
- [ ] `null` is returned for a zero denominator, never `Infinity`.
- [ ] `sample_size` is present on every response.
- [ ] Cross-workspace campaigns contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — leads needed per reply, and goal sizing

**Preconditions:** A workspace with one goal targeting 20 meetings, one campaign on a sandbox mailbox, 420 leads contacted and 10 replies inside the test range, plus a second campaign with 5 leads and 1 reply.

**Flow**
1. Sign in and open Reports.
2. Set the range to cover the activity.
3. Read the leads-per-reply figure beside the reply rate.
4. Filter to the second campaign.
5. Open Goals and read the sizing estimate.

**Assertions**
- [ ] The workspace figure reads 42 and matches the inverse of the displayed reply rate.
- [ ] The second campaign shows its figure with the small-sample caveat.
- [ ] The Goals estimate names an implied lead count and the range used.
- [ ] A range with no replies shows "no replies yet in this range" on both pages.

**Teardown:** Delete the seeded goal, campaigns, leads and messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | One extra figure beside the existing reply rate | Low | Derived from a number already on the page; no new request |
| Goals | One sizing sentence under a goal's target | Low | A sentence, not a calculator; the goal page keeps its plain-English shape |
| Dashboard | None | Low | This is a planning number, not a status number |

**Verdict:** Fits an existing surface

This is arithmetic on a rate Harry already computes and shows on Reports, so nothing new is measured. Its value is where it is placed — under a goal's target, where a marketer is actually deciding how many leads to find — and it costs one sentence and no new request.
