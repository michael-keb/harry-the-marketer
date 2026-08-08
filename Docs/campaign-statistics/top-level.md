# Fetch Campaign Top Level Analytics

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/analytics` |
| **Category** | campaign-statistics |
| **Source** | https://api.smartlead.ai/api-reference/campaign-statistics/top-level |
| **Auth** | API key (query param `api_key`) |

Returns the headline numbers for one campaign in a single call, with no filters and nothing to configure.

## 1. Epic

**Per-campaign performance breakdown**

The epic gives a Harry user the numbers behind a single campaign — sent, opened, clicked, replied, unsubscribed, bounced — sliced by playbook step, by lead, by mailbox and by date, without leaving the campaign they are already looking at. It matters because Reports answers "how is outreach going" for the whole workspace, while the decisions that change next week (rewrite this step, rest that mailbox, stop chasing this segment) are made inside one campaign, where Harry today shows only node counts.

## 2. User story

**As a** marketer opening a campaign, **I want** its headline numbers at the top of the page in one glance, **so that** I know whether to dig in before I read anything else.

**Acceptance criteria**
- [ ] Given a campaign that has sent, when the campaign detail page loads, then a single call to the campaign's analytics returns `{"ok": true, "data": ...}` and the header tiles render from it without any further request.
- [ ] Given the endpoint takes only `campaign_id` and `api_key`, when the header renders, then no date, step or mailbox control appears on it — the headline is always all-time, and the range control lower on the page does not change it.
- [ ] Given the campaign has never sent, when the page loads, then the tiles read zero with a "Not launched yet" note and a link to the launch checklist, rather than dashes.
- [ ] Given the response arrives after the playbook diagram has rendered, when it lands, then the tiles fill in place without moving the diagram.
- [ ] Given the API key is missing or invalid, when the header loads, then a 401 `{"message": "Invalid API Key"}` shows one "Reporting is disconnected" chip on the header and the campaign remains fully editable and launchable.
- [ ] Given the campaign id does not exist or belongs to another workspace, when the page loads, then a 404 sends the user to the Campaigns list with "Campaign not found", and no partial page is shown.
- [ ] Given the call fails or times out, when the header renders, then the tiles show their last known values with a "as of HH:MM" note rather than blanking.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign with sends, opens and replies. Call `GET /campaigns/{id}/analytics?api_key=...` | 200, `ok: true`, `data` present; header tiles match the fixture totals |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; header shows one "Reporting is disconnected" chip; editing still works |
| TC-3 | Not found / wrong workspace | Call with an id from another workspace, then a non-existent id | 404 both times; user lands on Campaigns with "Campaign not found" |
| TC-4 | Validation failure | Call with a non-numeric campaign id | 400 with a message naming the id; no crash, no infinite retry |
| TC-5 | Rate limited | Open and close the campaign page ten times in a second | 429 handled by one shared in-flight request and a short cache; the header never blanks |
| TC-6 | Empty result set | Call on a never-launched campaign | 200 with an empty `data`; tiles read zero with "Not launched yet" |
| TC-7 | Slow response | Force a 5s response | Diagram renders immediately; tiles show skeletons that do not shift layout when they resolve |
| TC-8 | Stale fallback | Load once, force the second call to fail | Previous values remain with "as of HH:MM"; one retry offered |
| TC-9 | Deleted mid-view | Delete the campaign in another tab, then refresh | 404 handled cleanly with "Campaign not found" and no error overlay |
| TC-10 | Consistency | Compare the header totals with the summed per-step totals from the statistics endpoint | The two agree, or the difference is explained by steps deleted from the playbook and shown as such |

## 4. Frontend user story

**As a** marketer, **I want** four or five headline tiles at the top of the campaign page, **so that** the first thing I see tells me whether this campaign is working.

**Scope**
- Campaign detail page header: tiles for sent, replies, interested and won, matching the KPI tile component the Dashboard already uses so the visual language is identical.
- The tiles are always all-time; the date range that governs the charts below is deliberately not wired to them, and a small "all time" label says so.
- Loading uses fixed-height skeletons so the diagram never jumps; empty shows zeros with "Not launched yet"; error shows the last values with an "as of" note.
- Accessibility: each tile is a labelled figure with the number as text, not an image; the tile row wraps to two columns on narrow screens.

**Definition of done**
- [ ] The header issues exactly one analytics request per campaign view, shared if the page remounts.
- [ ] Tiles reuse the Dashboard KPI component, not a copy.
- [ ] Layout does not shift between skeleton and value.
- [ ] Zero, error and stale states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** one cheap route for a campaign's headline numbers, **so that** opening a campaign is fast and does not run the heavy per-step and per-lead queries.

**Scope**
- Route: `GET /api/campaigns/:id/analytics`, sitting with the other campaign routes in `server/routes.js` behind the existing workspace guard. No query parameters beyond the session — this route deliberately takes no filters.
- Data model: none new. Aggregated from `messages`, `events` and derived lead stages; a short in-process cache keyed on campaign id and last message timestamp keeps repeated opens off the database.
- Rate limiting reuses the reporting bucket with `Retry-After` on 429; a 404 is returned for both a missing campaign and one outside the workspace so existence is not leaked.
- Telemetry: query duration and cache hit or miss to `telemetry`, so Monitoring can show whether campaign pages are opening quickly.

**Definition of done**
- [ ] Response is `{ ok: true, data: {...} }` with the headline counts and derived rates.
- [ ] Cache invalidates on the next send, reply or outcome for that campaign, proved by a test.
- [ ] Missing and cross-workspace ids both return 404.
- [ ] Cache hit rate is visible on Monitoring.

## 6. End-to-end test ticket

**Title:** E2E — Campaign headline numbers

**Preconditions:** Two campaigns in the workspace — one launched with seeded sends, replies, one interested outcome and one won, and one created but never launched.

**Flow**
1. Sign in and open the launched campaign.
2. Read the header tiles.
3. Go back to Campaigns and open the never-launched campaign.
4. Send one email through the sandbox mailbox from the launched campaign, then reopen it.

**Assertions**
- [ ] The launched campaign's tiles match the seeded totals.
- [ ] The never-launched campaign's tiles read zero with "Not launched yet" and a link to the launch checklist.
- [ ] The diagram is fully rendered before the tiles resolve, and nothing moves when they do.
- [ ] After the extra send, the sent tile has increased by one on the next open, proving the cache invalidated.

**Teardown:** Delete both campaigns and their messages; clear the run's telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail header | Four headline tiles above the playbook | Low | Reuses the Dashboard KPI tile exactly; fixed height so nothing shifts |
| Campaigns list | Unchanged | Low | The list already shows status; totals stay one click away |

**Verdict:** Fits an existing surface

This is the cheapest and most-read part of the whole category, and it belongs in the space at the top of the campaign page that currently only carries the campaign's name and status. Reusing the Dashboard tile means there is nothing new to learn, and keeping the tiles filter-free removes the only decision the user would otherwise have to make.
