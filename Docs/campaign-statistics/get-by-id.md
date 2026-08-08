# Fetch Campaign Statistics by Campaign ID

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/statistics` |
| **Category** | campaign-statistics |
| **Source** | https://api.smartlead.ai/api-reference/campaign-statistics/get-by-id |
| **Auth** | API key (query param `api_key`) |

Returns one campaign's numbers broken down by step in the sequence, so you can see which follow-up earns the replies and which one loses people.

## 1. Epic

**Per-campaign performance breakdown**

The epic gives a Harry user the numbers behind a single campaign — sent, opened, clicked, replied, unsubscribed, bounced — sliced by playbook step, by lead, by mailbox and by date, without leaving the campaign they are already looking at. It matters because Reports answers "how is outreach going" for the whole workspace, while the decisions that change next week (rewrite this step, rest that mailbox, stop chasing this segment) are made inside one campaign, where Harry today shows only node counts.

## 2. User story

**As a** marketer reviewing a campaign, **I want** sent, opened, clicked, replied, unsubscribed and bounced counts per step of my playbook, **so that** I can rewrite the step that is losing people instead of guessing.

**Acceptance criteria**
- [ ] Given a campaign with a valid playbook, when statistics are fetched, then each row carries `campaign_id`, `sequence_number`, `sent`, `opened`, `clicked`, `replied`, `unsubscribed` and `bounced`, and each `sequence_number` is mapped to the `Send:` node it came from in the Mermaid diagram.
- [ ] Given the campaign has more steps than one page, when `limit` and `offset` are used, then the response echoes `offset` and `limit` and the UI pages without duplicating or dropping a step.
- [ ] Given `limit` is set above 1000, when the request is made, then it is clamped to 1000 rather than failing, and the clamp is invisible to the user.
- [ ] Given `email_sequence_number=3`, when statistics are fetched, then only step 3 is returned, and values outside 1–20 are rejected before the call is made.
- [ ] Given `email_status=bounced`, when statistics are fetched, then only bounced activity is counted, and the filter is shown as a removable chip.
- [ ] Given a campaign that has never sent, when statistics are fetched, then `data` is empty and the panel reads "No steps have sent yet" beside the playbook diagram.
- [ ] Given a step has `sent` of zero, when rates are displayed, then the reply rate reads "—" rather than a division by zero.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a two-step campaign with sends and replies. Call with `limit=100&offset=0` | 200, `data` has two rows with `sequence_number` 1 and 2 and the seeded `sent`/`opened`/`clicked`/`replied`/`unsubscribed`/`bounced` values; `offset: 0`, `limit: 100` echoed |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; UI shows "Reporting is disconnected" once |
| TC-3 | Not found / wrong workspace | Call with a campaign id from another workspace | 404; "Campaign not found", no step names leak |
| TC-4 | Validation failure | Call with `email_sequence_number=0`, then `=21` | 400 naming `email_sequence_number` and its 1–20 bound; the step selector never offers those values |
| TC-5 | Rate limited | Call 30 times in one second | 429; one backoff retry, then the last good rows stay on screen |
| TC-6 | Empty result set | Call on a campaign that has not launched | 200 with `data: []`; "No steps have sent yet" |
| TC-7 | Pagination | Seed 12 steps, call `limit=5` at offsets 0, 5, 10 | Three pages of 5, 5 and 2 rows; no `sequence_number` appears twice |
| TC-8 | Limit clamp | Call with `limit=5000` | 200; at most 1000 rows returned and the response echoes the clamped limit |
| TC-9 | Status filter | Call with `email_status=replied`, then `email_status=unsubscribed` | Counts differ and each matches the seeded totals for that status |
| TC-10 | Sent-time window | Call with `sent_time_start_date=2023-10-16 10:33:02.000Z` and an end date one hour later | Only sends inside that hour are counted |

## 4. Frontend user story

**As a** marketer, **I want** each node of my Mermaid playbook annotated with its own sent, open, click, reply, unsubscribe and bounce numbers, **so that** the diagram itself tells me where the campaign works.

**Scope**
- Campaign detail page, Node performance panel: extend the existing per-node "emails sent / leads here" line with reply, open, click, unsubscribe and bounce rates. A step with a notably worse reply rate than its siblings gets one quiet marker and a "Rewrite this step" link into the playbook editor.
- A step filter and a status filter (opened / clicked / replied / unsubscribed / bounced) sit above the panel as removable chips; both are optional and off by default.
- Loading keeps the diagram rendered and shows skeleton numbers; empty reads "No steps have sent yet"; error keeps the diagram and hides only the numbers.
- Accessibility: the numbers are also rendered as a table beneath the diagram with a proper header row, so the information is not locked inside an SVG. On narrow screens the table is the primary view and the diagram scrolls.

**Definition of done**
- [ ] Every `Send:` node in the playbook resolves to exactly one `sequence_number`, and an unmatched row is shown as "Step no longer in the playbook" rather than dropped.
- [ ] Rates show "—" when `sent` is zero.
- [ ] Filter chips are reflected in the URL.
- [ ] Diagram and table stay in sync in component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** a route returning per-step campaign statistics with paging and filters, **so that** Node performance and the Learning section in Reports share one query.

**Scope**
- Route: `GET /api/campaigns/:id/statistics?offset&limit&email_sequence_number&email_status&sent_time_start_date&sent_time_end_date`, added beside the existing campaign routes in `server/routes.js`.
- Data model: none new. Derived from `messages` joined to the campaign's parsed playbook nodes; the parser in `server/playbook.js` supplies the node-to-step mapping so the numbers follow diagram edits.
- Paging defaults to `offset=0`, `limit=100`, clamps `limit` to 1000, and always echoes both. Rate limiting reuses the reporting bucket and answers 429 with `Retry-After`.
- Telemetry: query duration and row count written to `telemetry`; an unmatched `sequence_number` (a node deleted from the diagram after sending) is written to `events` once per campaign so the drift is visible rather than silent.

**Definition of done**
- [ ] Response shape is `{ ok: true, data: [...], offset, limit }`.
- [ ] Node-to-step mapping is unit-tested against a playbook that was edited after sending.
- [ ] Filters compose (step plus status plus sent-time window) and are covered by tests.
- [ ] Cross-workspace campaign ids return 404.

## 6. End-to-end test ticket

**Title:** E2E — Per-step performance on the campaign page

**Preconditions:** A workspace with a three-step playbook (intro, follow-up, proof point), a sandbox mailbox, 30 leads, seeded sends on all three steps and replies concentrated on step 2, plus one unsubscribe and one bounce.

**Flow**
1. Sign in and open the campaign.
2. Read the Node performance panel.
3. Apply the "replied" status chip.
4. Select step 2 only.
5. Open the table view beneath the diagram.

**Assertions**
- [ ] Each of the three `Send:` nodes shows its own sent count and reply rate.
- [ ] Step 2 shows the highest reply rate, matching the fixture.
- [ ] The unsubscribe and bounce appear against the correct steps.
- [ ] The "replied" chip changes the numbers and is removable in one click.
- [ ] The table beneath the diagram carries the same numbers as the annotations.

**Teardown:** Delete the campaign, leads and messages; clear the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail, Node performance | Existing per-node counts gain rates and two optional filter chips | Medium | Rates render on the node label already there; filters default to off and are chips, not a settings panel |
| Playbook editor | A "Rewrite this step" link arriving with the step preselected | Low | One link, no new screen |
| Reports, Learning section | Reads the same query instead of its own | Low | No visible change; one fewer code path |

**Verdict:** Fits an existing surface

Node performance already exists on the campaign page and already answers "where are my leads"; this makes it also answer "where do they convert". Putting the numbers on the diagram the user drew is the least-thinking place they can live, and the table beneath it keeps the data readable without a new page.
