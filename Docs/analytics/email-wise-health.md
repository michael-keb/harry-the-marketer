# Email-ID-wise Health Metrics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/mailbox/name-wise-health-metrics` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/email-wise-health |
| **Auth** | API key (query param `api_key`) |

Shows how each individual sending address performed over a date range — sent, opened, replied and bounced, one row per mailbox.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer with several connected Gmail accounts, **I want** each address's sends, opens, replies and bounces for a date range, **so that** I can retire or rest a mailbox that has started bouncing instead of dragging the whole workspace down.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the metrics, then `data.email_health_metrics` returns `{ email_account, sent, opened, replied, bounced }` per mailbox.
- [ ] Given `is_bounced` is set to `true`, when the metrics are requested, then only mailboxes with bounces in the range are returned, giving a one-click "show me the problem accounts" filter.
- [ ] Given a mailbox is connected but sent nothing in the range, when the list renders, then it appears with zeros so a mailbox that has quietly stopped sending is visible rather than absent.
- [ ] Given a mailbox is still warming up under Harry's ramp (10 a day rising to its limit), when its row renders, then the ramp state is shown next to the counts so a low `sent` is not read as a fault.
- [ ] Given `limit` and `offset` are supplied, when I page, then ordering is stable and no mailbox appears twice.
- [ ] Given the bounce share for a mailbox crosses the benchmark used on Monitoring, when the row renders, then it is flagged with the same wording, and the mailbox is offered a "rest this mailbox" action.
- [ ] Given no mailboxes exist, when the metrics are requested, then a 200 with an empty list leads to the existing "Connect Gmail" empty state.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed `user@example.com` with 500 sent, 250 opened, 30 replied, 5 bounced in January. Request that range | 200, one row with exactly those values |
| TC-2 | Missing/invalid API key | Repeat TC-1 with a junk key | 401 `{"message": "Invalid API Key"}`; the panel shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or an empty list; no addresses leak |
| TC-4 | Validation failure | Pass `is_bounced=maybe` | 422 `{"error": "Invalid parameters provided"}` naming `is_bounced` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous table marked stale |
| TC-6 | Empty result set | Request a range before any mailbox was connected | 200, `email_health_metrics: []`; the Connect Gmail empty state shows |
| TC-7 | Bounce filter | Seed three mailboxes, one with bounces, request `is_bounced=true` | Only the bouncing mailbox is returned |
| TC-8 | Silent mailbox | Connect a mailbox and send nothing from it in the range | The row appears with zeros and a "no sends in this range" note |
| TC-9 | Warming mailbox | Seed a mailbox on day 3 of its 14-day ramp | The row shows the ramp state and the low `sent` is not flagged |
| TC-10 | Sandbox mailbox | Include a sandbox mailbox in the workspace | It is listed and labelled sandbox so its numbers are never mixed into deliverability judgements |
| TC-11 | Paging | Seed 30 mailboxes, request `limit=10&offset=10` | Rows 11–20 by the documented sort with no overlap |

## 4. Frontend user story

**As a** marketer, **I want** per-mailbox performance on the Mailboxes page for a chosen range, **so that** deciding which account to rest takes one look.

**Scope**
- Mailboxes page: each connected account's row gains sent, opened, replied, bounced and bounce share for the shared date range, plus a "Bouncing only" filter that maps to `is_bounced`.
- Reports page: the existing mailbox load panel links here rather than duplicating the columns.
- Sandbox mailboxes are labelled and excluded from any deliverability flag. Warming mailboxes show their ramp day.
- Loading shows skeleton numbers inside the existing rows. Empty falls through to "Connect Gmail". Error keeps the mailbox list and its actions usable with the numbers hidden.
- Accessibility: a real table with a caption naming the range, flags conveyed in text, and columns collapsing to a stacked summary under 640px.

**Definition of done**
- [ ] Every connected mailbox appears, including ones that sent nothing.
- [ ] The bouncing-only filter is one toggle and is reflected in the URL.
- [ ] Sandbox and warming states are visible next to the counts.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** per-mailbox counts for a window in one query, **so that** the Mailboxes page never derives deliverability in the browser.

**Scope**
- Add `GET /api/analytics/mailboxes/health?from=&to=&timezone=&campaign_ids=&is_bounced=&limit=&offset=` to `server/routes.js`, workspace-scoped.
- Data model: none. Aggregate `messages` and delivery telemetry by mailbox; the ramp state comes from the existing warmup logic rather than being stored twice.
- Left-join from the mailbox list so silent mailboxes are returned with zeros. Validate the date pair and the boolean-ish `is_bounced`. Default `limit` to 50 with stable ordering by address.
- The existing API limiter applies with brief caching per workspace and range.
- Log a `telemetry` row when a mailbox crosses the bounce benchmark so the Monitoring incident feed picks it up.

**Definition of done**
- [ ] Mailboxes with no sends return zeros, not absence.
- [ ] Sandbox mailboxes are tagged in the payload so the UI can exclude them from flags.
- [ ] `is_bounced=true` filters on the range's bounces, not lifetime bounces.
- [ ] Cross-workspace mailboxes are never returned.

## 6. End-to-end test ticket

**Title:** E2E — per-mailbox health and resting a bad account

**Preconditions:** A workspace with three sandbox mailboxes: one healthy with sends and replies, one with a high simulated bounce count, one connected but never used. A week of seeded activity.

**Flow**
1. Sign in and open Mailboxes.
2. Set the range to the seeded week.
3. Read all three rows.
4. Turn on the "Bouncing only" filter.
5. Rest the bouncing mailbox and return with the filter off.

**Assertions**
- [ ] The unused mailbox shows zeros with its "no sends in this range" note, not absence.
- [ ] The bouncing mailbox is flagged with Monitoring's wording; the healthy one is not.
- [ ] The filter leaves exactly one row and is reflected in the URL.
- [ ] After resting, the mailbox is excluded from new sends and the campaign page says why.
- [ ] Monitoring's incident feed carries one entry for the flagged mailbox.

**Teardown:** Delete the seeded mailboxes, campaigns, leads and messages; clear the telemetry rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Existing rows gain range-scoped counts and one filter | Medium | Four numbers plus a share on rows that already exist; no new page |
| Reports | The mailbox load panel links out instead of duplicating columns | Low | Removes a temptation to show the same numbers twice |
| Monitoring | Existing delivery telemetry gains benchmark flags per mailbox | Low | Reuses the grading already on the page |

**Verdict:** Fits an existing surface

Harry already shows mailbox load on Reports and delivery telemetry per mailbox on Monitoring, so the counts themselves are largely known. What is new is putting them on a chosen date range next to the account they belong to, with the bouncing-only filter that turns a report into an action.
