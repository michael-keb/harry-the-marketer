# Domain-wise Health Metrics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/mailbox/domain-wise-health-metrics` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/domain-wise-health |
| **Auth** | API key (query param `api_key`) |

Groups sending results by the domain the mail went out from, so you can see whether a whole domain is getting into trouble rather than one address.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer sending from several addresses on the same domain, **I want** sends, opens, replies and bounces grouped by sending domain, **so that** I can spot a domain-level deliverability problem before every mailbox on it is burned.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the metrics, then `data.domain_health_metrics` returns `{ domain, sent, opened, replied, bounced }` per sending domain.
- [ ] Given a workspace with mailboxes on two domains, when the metrics are requested, then each domain appears once with its mailboxes' counts summed.
- [ ] Given a domain's bounce share exceeds the cold-outreach benchmark already used on Monitoring, when the table renders, then that row is flagged with the same wording Monitoring uses, so one benchmark governs both screens.
- [ ] Given a domain sent nothing in the range, when the metrics are requested, then it is omitted from the response and the UI shows only domains that were used.
- [ ] Given `limit` and `offset` are supplied, when I page through many domains, then ordering is stable and no domain appears twice.
- [ ] Given `campaign_ids` is supplied, when the metrics are requested, then only sends from those campaigns are counted, so a single bad campaign can be isolated from the domain's overall figure.
- [ ] Given no sends at all in the range, when the metrics are requested, then a 200 with an empty list produces an empty state naming the range.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed two mailboxes on `example.com` totalling 1000 sent, 500 opened, 60 replied, 10 bounced in January. Request that range | 200, one row for `example.com` with those figures |
| TC-2 | Missing/invalid API key | Repeat TC-1 with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; the panel shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or an empty list; no domain names leak |
| TC-4 | Validation failure | Pass `end_date` before `start_date` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous table marked stale |
| TC-6 | Empty result set | Request a range with no sends | 200, `domain_health_metrics: []`; empty state names the range |
| TC-7 | Two domains | Seed mailboxes on `example.com` and `outreach.example.net` | Two rows, each summing only its own mailboxes; totals equal the workspace total |
| TC-8 | Bounce threshold | Seed a domain with 40 bounced from 500 sent | The row is flagged using the same benchmark wording as Monitoring's bounce-rate factor |
| TC-9 | Domain used by one campaign only | Request with `campaign_ids` set to that campaign | The domain's counts drop to that campaign's contribution only |
| TC-10 | Paging | Seed 30 domains, request `limit=10&offset=10` | Rows 11–20 by the documented sort with no overlap |
| TC-11 | Zero sends but bounces recorded | Force a fixture with `sent: 0` and `bounced: 3` | The bounce share is shown as `—`, not a division by zero, and a telemetry warning is logged |

## 4. Frontend user story

**As a** marketer, **I want** a domain grouping on the Mailboxes page and in the Monitoring delivery panel, **so that** a failing domain is visible before I have to compare mailboxes by eye.

**Scope**
- Mailboxes page: mailboxes group under their domain with a domain summary row carrying sent, opened, replied, bounced and the bounce share for the selected range.
- Monitoring: the existing per-mailbox delivery telemetry gains a domain roll-up above it, reusing the same benchmark grading already applied to bounce rate.
- Loading shows skeleton summary rows above the existing mailbox rows. Empty shows "No sends between X and Y". Error keeps the ungrouped mailbox list working.
- Accessibility: grouping uses real table row-group semantics with a caption per group, flags are text as well as colour, and groups collapse on narrow screens.

**Definition of done**
- [ ] A domain summary equals the sum of its mailbox rows, verified in a component test.
- [ ] Flagged domains use the same wording and thresholds as Monitoring.
- [ ] The grouping does not break the existing per-mailbox actions.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** sending counts grouped by the mailbox's domain, **so that** deliverability can be judged at the level a mail provider actually judges it.

**Scope**
- Add `GET /api/analytics/mailboxes/domains?from=&to=&timezone=&campaign_ids=&limit=&offset=` to `server/routes.js`, workspace-scoped.
- Data model: none. Derive the domain from the mailbox address at query time — no stored domain column that could drift from the address.
- Return raw counts and let the client compute shares, but include a precomputed `bounce_share` with `null` when `sent` is zero. Validate the date pair, cap the window, default `limit` to 50.
- The existing API limiter applies with brief per-workspace caching.
- Log a `telemetry` row when a domain crosses the bounce benchmark, so the Monitoring incident feed carries it without a second job.

**Definition of done**
- [ ] Domain extraction is unit tested against subdomains and plus-addressing.
- [ ] Sums across domains equal the workspace totals for the same window.
- [ ] Zero-send domains are excluded rather than returned with zeros.
- [ ] Cross-workspace mailboxes contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — domain-level sending health

**Preconditions:** A workspace with three sandbox mailboxes: two on `example.com` (one with a high simulated bounce count) and one on `outreach.example.net`. Sends and replies seeded across a week.

**Flow**
1. Sign in and open Mailboxes.
2. Set the range to the seeded week.
3. Read the two domain summary rows.
4. Expand `example.com` and compare the mailbox rows with the summary.
5. Open Monitoring and read the domain roll-up.

**Assertions**
- [ ] Each domain summary equals the sum of its mailboxes.
- [ ] `example.com` is flagged for bounces and `outreach.example.net` is not.
- [ ] The flag wording matches Monitoring's bounce-rate factor exactly.
- [ ] Monitoring's incident feed carries one entry for the flagged domain.

**Teardown:** Delete the seeded mailboxes, campaigns, leads and messages; clear the telemetry rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Rows group under a domain summary | Medium | Grouping is automatic and invisible when every mailbox shares one domain |
| Monitoring | The delivery telemetry panel gains a domain roll-up | Low | Reuses the existing benchmark grading, no new panel |
| Reports | None | Low | Deliverability lives with the mailboxes, not with campaign performance |

**Verdict:** Fits an existing surface

Harry already grades bounce rate against cold-outreach benchmarks on Monitoring and already shows mailbox load on Reports, but always per mailbox. The genuinely new idea is that a domain is the unit a mail provider punishes, so the roll-up belongs on Mailboxes and Monitoring, and it collapses to nothing for the common single-domain workspace.
