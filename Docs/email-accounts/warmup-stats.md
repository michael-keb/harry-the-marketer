# Get Warmup Statistics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/email-accounts/{id}/warmup-stats` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/warmup-stats |
| **Auth** | API key (query param `api_key`) |

Returns the last seven days of a mailbox's warm-up performance, day by day: sent, delivered, marked spam, opened and replied, plus a reputation score.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner watching a new mailbox settle in, **I want** a week's daily figures for it, **so that** I can tell whether reputation is building or breaking before it costs me a campaign.

**Acceptance criteria**
- [ ] Given a mailbox with warm-up history, when I fetch its stats, then I get the documented shape: `total_sent`, `spam_count`, `reputation_score`, and a `daily_stats` array whose rows carry `date`, `sent`, `spam`, `delivered`, `opened` and `replied`.
- [ ] Given fewer than seven days of history, when I fetch, then only the days that exist are returned and the UI says how young the mailbox is rather than drawing five empty columns as if something went wrong.
- [ ] Given the documented health thresholds, when the figures are shown, then Harry states them in words — spam should stay under 2% of sent, reputation should climb toward 90-100 — rather than leaving the user to know what good looks like.
- [ ] Given spam is above the threshold or reputation is falling, when the section renders, then it says so plainly and offers the specific next actions the docs name: lower the daily warm-up count, check SPF, DKIM and DMARC, review content.
- [ ] Given a mailbox with warm-up switched off or a sandbox mailbox, when I fetch stats, then the response is an honest empty state saying warm-up is not running, not zeros presented as measurements.
- [ ] Given an id from another workspace, when I fetch, then the response is 404 (`{"message": "Email account not found", "status": "error"}`) and existence is not confirmed.
- [ ] Given the underlying data source fails, when the section renders, then the documented 500 case is surfaced as "Could not load warm-up figures — retry" and the rest of the mailbox detail still works.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET stats for a mailbox warming for two weeks | 200 with `total_sent`, `spam_count`, `reputation_score` and seven `daily_stats` rows each carrying `date`, `sent`, `delivered`, `spam`, `opened`, `replied` |
| TC-2 | Missing/invalid API key | GET with no session cookie | 401, `{"message": "Invalid API Key"}`; redirect to sign-in |
| TC-3 | Not found / wrong workspace | GET an id from another workspace | 404, `{"message": "Email account not found", "status": "error"}` |
| TC-4 | Validation failure | GET with a non-numeric id | 422 with a field-level message; no lookup performed |
| TC-5 | Rate limited | Poll the stats every second | 429 on the excess; client backs off with jitter and keeps the last good figures on screen |
| TC-6 | Empty result set | GET for a mailbox connected an hour ago | 200 with an empty or single-row `daily_stats`; UI says "Not enough history yet — check back tomorrow" |
| TC-7 | Warm-up off | GET for a mailbox with warm-up disabled | Honest empty state saying warm-up is not running, with a link to turn it on; no zeroed chart |
| TC-8 | Sandbox mailbox | GET for a sandbox mailbox | Empty state stating warm-up does not apply to sandbox mailboxes |
| TC-9 | Spam above threshold | Seed a day with `sent: 20, spam: 2` | Section flags 10% spam against the 2% guidance and lists the suggested actions |
| TC-10 | Reputation declining | Seed a falling `reputation_score` across the week | The trend is called out in words, not just plotted |
| TC-11 | Stats source unavailable | Force the documented 500 | Retryable inline message; the Sending and Health sections of the mailbox sheet still render |
| TC-12 | Day boundary | Fetch either side of the workspace's local midnight | Days are bucketed by the user's timezone, taken from the browser as Harry already does, so no day appears twice or goes missing |

## 4. Frontend user story

**As a** workspace owner, **I want** the week's warm-up figures shown as a small trend with a plain verdict, **so that** I do not have to interpret six numbers a day.

**Scope**
- Mailbox detail sheet: a Warm-up performance block under the warm-up settings, showing a seven-day sparkline of sent and a second of spam, the reputation score with its direction, and one verdict sentence — "Building well" or "Spam rate is too high" with the actions.
- Reports already has a mailbox-load section; this block links to it rather than duplicating charting, so there is one place for volume and one for reputation.
- States: skeleton block, not-enough-history, warm-up-off, sandbox, and a retryable error that leaves the rest of the sheet usable.
- Numbers are shown as a small table underneath the sparklines for anyone who wants the exact figures, and the table is the accessible representation of the charts.
- Accessibility: sparklines carry a text summary and the table is the source of truth; no meaning is carried by colour alone; the verdict is real text. Responsive: the table scrolls inside its own container under 640px, the sheet never scrolls sideways.

**Definition of done**
- [ ] The verdict sentence is derived from the documented thresholds, not hand-written per case.
- [ ] Not-enough-history, warm-up-off and sandbox are three visibly different states.
- [ ] The charts have an equivalent accessible table.
- [ ] Verified in light and dark and at 375px.

## 5. Backend user story

**As a** Harry API, **I want** a seven-day warm-up rollup per mailbox, **so that** the UI and Monitoring read the same reputation picture from the same telemetry.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `GET /api/mailboxes/:id/warmup-stats`, returning totals plus a day-bucketed array.
- Data model: no new table. Days are aggregated from `messages` and the existing self-pruning `telemetry` table that the mailer already writes; spam and complaint signals come from bounce and complaint telemetry rather than from an external warm-up pool, which Harry does not have.
- The reputation score is computed from delivered, spam and reply figures with the formula documented in code, so it can be explained in support rather than being a mystery number.
- Day buckets use the workspace's timezone, taken from the browser as the rest of the app does. Results are cached for a few minutes since the underlying data changes at engine-tick pace, not per request.
- Standard rate limiter; the client backs off on 429. A failure returns the documented error shape rather than an empty rollup, so "no data" and "broken" stay distinguishable.
- Logged: nothing per read; `telemetry` records rollup latency and any computation failure so Monitoring surfaces a broken rollup rather than a silently flat chart.

**Definition of done**
- [ ] Buckets respect the user's timezone, covered by a test across a midnight boundary.
- [ ] Cross-workspace requests return 404 with no existence leak, covered by a test.
- [ ] The reputation formula is unit-tested against fixed inputs so the number is reproducible.
- [ ] A failure path is distinguishable from an empty result in the response shape.

## 6. End-to-end test ticket

**Title:** E2E — Read a week of warm-up performance

**Preconditions:** A workspace with one mailbox seeded with fourteen days of send, delivery, spam, open and reply telemetry, including one day with a spam spike; one sandbox mailbox; one mailbox with warm-up switched off.

**Flow**
1. Open the seeded mailbox's detail sheet and scroll to Warm-up performance.
2. Read the verdict and the seven-day figures.
3. Open the accessible table and compare against the seeded values.
4. Open the sandbox mailbox's sheet.
5. Open the warm-up-off mailbox's sheet.
6. Force the stats request to fail and reopen the seeded mailbox.

**Assertions**
- [ ] Exactly seven days appear, ending today in the workspace's timezone.
- [ ] The table's figures match the seeded telemetry row for row.
- [ ] The spam-spike day pushes the verdict to a warning that names the 2% guidance and lists the suggested actions.
- [ ] Sandbox and warm-up-off each show their own stated reason, not an empty chart.
- [ ] On failure, the block shows a retry message and the Sending and Health sections still render.

**Teardown:** Remove the seeded telemetry, restore the warm-up setting.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailbox detail sheet | Warm-up performance block: two sparklines, a score, a verdict, a table | Medium | Lives inside a sheet that opens for one mailbox at a time; the verdict does the reading so the charts are optional detail |
| Mailboxes | Row can show the reputation direction | Low | One arrow and a word on an existing row |
| Monitoring | Delivery telemetry gains a reputation series | Low | Existing section, one more series |
| Reports | Linked to, not duplicated | Low | Volume stays in Reports, reputation stays in the mailbox sheet |

**Verdict:** Fits an existing surface

Harry already displays mailbox health and already has a telemetry table behind Monitoring, so this is a new reading of data that exists rather than a new system. The risk is charts for their own sake, so the mitigation is that the verdict sentence carries the meaning and the charts are supporting evidence. No navigation item is added.
