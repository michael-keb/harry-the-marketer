# Fetch Campaign Mailbox Statistics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/mailbox-statistics` |
| **Category** | campaign-statistics |
| **Source** | https://api.smartlead.ai/api-reference/campaign-statistics/mailbox-statistics |
| **Auth** | API key (query param `api_key`) |

Returns how each sending mailbox performed inside one campaign, so you can tell whether a poor result is the writing or the inbox it went from.

## 1. Epic

**Per-campaign performance breakdown**

The epic gives a Harry user the numbers behind a single campaign — sent, opened, clicked, replied, unsubscribed, bounced — sliced by playbook step, by lead, by mailbox and by date, without leaving the campaign they are already looking at. It matters because Reports answers "how is outreach going" for the whole workspace, while the decisions that change next week (rewrite this step, rest that mailbox, stop chasing this segment) are made inside one campaign, where Harry today shows only node counts.

## 2. User story

**As a** marketer whose campaign is underperforming, **I want** the numbers split by the mailbox that sent them, **so that** I can tell a deliverability problem from a copy problem before I rewrite anything.

**Acceptance criteria**
- [ ] Given a campaign sending from several mailboxes, when mailbox statistics are fetched, then one row is returned per mailbox with its sent, open, click, reply, unsubscribe and bounce figures.
- [ ] Given `limit` is not supplied, when statistics are fetched, then the documented default paging applies, `limit` is kept within its 1–20 bound, and `offset` defaults to 0.
- [ ] Given both `start_date` and `end_date` are supplied in `YYYY-MM-DD`, when statistics are fetched, then only that window is counted; given only one of them is supplied, then the full campaign length is used and the UI says "All time" rather than silently half-applying a filter.
- [ ] Given `time_zone` is not supplied, when statistics are fetched, then UTC is used, and the timezone actually applied is displayed beside the figures.
- [ ] Given one mailbox has a bounce rate well above the others, when the panel renders, then that row is marked and a "Rest this mailbox" action is offered that pauses it for the campaign.
- [ ] Given the campaign has one mailbox only, when the panel renders, then it shows a single row and no comparison language, not an empty comparison chart.
- [ ] Given the API key is missing or invalid, when statistics are fetched, then a 401 `{"message": "Invalid API Key"}` is surfaced once and the rest of the campaign page still renders.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign sending from three mailboxes with differing results. Call with `limit=10&offset=0` | 200, `ok: true`, three rows whose per-mailbox counts match the fixture |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; one banner, page still usable |
| TC-3 | Not found / wrong workspace | Call with a campaign id from another workspace | 404; "Campaign not found", no mailbox addresses leak |
| TC-4 | Validation failure | Call with `limit=25` | 400 naming `limit` and its 1–20 bound; the page requests at most 20 and never surfaces the error to the user |
| TC-5 | Rate limited | Call 30 times in one second | 429; one backoff retry, previous rows stay on screen |
| TC-6 | Empty result set | Call on a campaign that has not sent from any mailbox yet | 200 with `data: []`; "No mailbox has sent for this campaign yet" |
| TC-7 | Half a date range | Call with `start_date` only | Full campaign length is returned and the UI label reads "All time", not the partial range |
| TC-8 | Timezone | Call with `time_zone=America/Los_Angeles` and again with the default | Both 200; boundary-day figures differ and the applied timezone is labelled |
| TC-9 | Pagination | Seed 24 mailboxes, call `limit=20` at offsets 0 and 20 | 20 rows then 4; no mailbox appears twice |
| TC-10 | Disconnected mailbox | Revoke a mailbox's Gmail token, then fetch | The mailbox still appears with its historical numbers and a "Reconnect" marker; its figures are not zeroed |

## 4. Frontend user story

**As a** marketer, **I want** a mailbox breakdown on the campaign page, **so that** I can rest a struggling inbox instead of rewriting a campaign that was fine.

**Scope**
- Campaign detail page: a Mailboxes panel showing one row per sending mailbox with sent, reply rate, bounce rate and unsubscribe rate, reusing the mailbox row and health chip already on the Mailboxes page.
- The date range and timezone label are shared with the rest of the campaign page, not a second set of controls.
- Loading dims the previous rows; empty reads "No mailbox has sent for this campaign yet"; error hides the panel body and keeps one retry.
- A high-bounce row gets one quiet marker and a "Rest this mailbox" action that pauses that mailbox for this campaign only, with a confirmation naming the mailbox.
- Accessibility: a real table with a caption, sortable headers reachable by keyboard, and rates given as text as well as colour. On narrow screens the table scrolls horizontally inside its own container.

**Definition of done**
- [ ] Rows link to the Mailboxes page entry for that mailbox.
- [ ] Bounce and unsubscribe rates use the same thresholds Monitoring already grades against, so the two screens never disagree.
- [ ] Resting a mailbox is reflected on the campaign's sending queue immediately.
- [ ] Single-mailbox, empty, loading and error states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** a per-mailbox statistics route scoped to a campaign, **so that** the campaign page and Monitoring's delivery telemetry agree about which inbox is struggling.

**Scope**
- Route: `GET /api/campaigns/:id/mailbox-statistics?offset&limit&start_date&end_date&time_zone`, added beside the other campaign routes in `server/routes.js`. Smartlead's `client_id` and `private_api_key` parameters have no Harry equivalent and are deliberately not modelled — a campaign belongs to a workspace, and the session already establishes that.
- Data model: none new. Derived from `messages` grouped by mailbox id, joined to `mailboxes` for the address, health and daily limit.
- `limit` defaults to 20 and clamps to 20; `offset` defaults to 0; a partial date range falls back to the full campaign length exactly as the upstream contract does, and the response states which window was used so the UI never has to guess.
- Telemetry: query duration to `telemetry`; a mailbox crossing the bounce threshold writes one `events` row so the Monitoring incident feed picks it up without polling.

**Definition of done**
- [ ] Response is `{ ok: true, data: [...] }` with a `range` field naming the window actually applied.
- [ ] Partial-range fallback is unit-tested.
- [ ] A revoked-token mailbox still returns its historical rows.
- [ ] Threshold crossings appear in the Monitoring incident feed.

## 6. End-to-end test ticket

**Title:** E2E — Mailbox breakdown for one campaign

**Preconditions:** A workspace with one campaign, three sandbox mailboxes, 90 leads, seeded sends split evenly, and bounces concentrated on one mailbox so its bounce rate crosses the benchmark used on Monitoring.

**Flow**
1. Sign in and open the campaign.
2. Open the Mailboxes panel.
3. Read the three rows.
4. Use "Rest this mailbox" on the high-bounce row and confirm.
5. Open Monitoring.

**Assertions**
- [ ] Three rows appear, one per mailbox, with sent counts matching the fixture.
- [ ] The high-bounce mailbox is marked and its rate matches Monitoring's delivery telemetry for the same mailbox.
- [ ] After resting, the campaign's queue no longer schedules sends from that mailbox and the campaign page says why.
- [ ] Monitoring's incident feed contains one entry for the threshold crossing, not one per send.

**Teardown:** Un-rest the mailbox, delete the campaign, leads and messages, clear the run's telemetry and events.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | A Mailboxes panel with one row per sending mailbox | Medium | Reuses the Mailboxes page row and health chip; collapsed by default when the campaign uses a single mailbox |
| Mailboxes page | Unchanged | Low | Deep links in, nothing new out |
| Monitoring | Threshold crossings arrive in the existing incident feed | Low | One event per crossing, not per send |

**Verdict:** Fits an existing surface

Harry already grades mailbox health on Mailboxes and Monitoring; the missing piece is seeing that health per campaign, where the decision is made. A collapsible panel on the campaign page adds no navigation and stays out of the way entirely for the common single-mailbox case.
