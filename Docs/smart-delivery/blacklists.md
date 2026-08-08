# IP Blacklist Check

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/blacklist` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/blacklists |
| **Auth** | API key (query param `api_key`) |

Tells you whether the IP addresses your emails were sent from appear on any of the well-known blocklists that mail providers consult.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner, **I want** to see whether the IP my mail leaves from is listed on blocklists such as Spamhaus or Barracuda, **so that** I can stop a campaign and fix the listing before it burns the domain.

**Acceptance criteria**
- [ ] Given a completed placement test, when I open its blacklist check, then I get one row per seed delivery with `ip`, `rdns`, `domain`, `to_email`, `blacklist_type_value`, `total_blacklist` and a plain-English `details` string.
- [ ] Given a row where `total_blacklist` is `0`, when it renders, then it reads as clear ("Not listed on Spamhaus") and is visually quieter than a listed row.
- [ ] Given a row where `total_blacklist` is `1` or more, when it renders, then the listing name from `blacklist_type_value` and the `details` text are shown together, plus the IP that is listed.
- [ ] Given several seed rows share one `ip`, when the view renders, then they are grouped by IP so a single listed IP is reported once, not once per seed mailbox.
- [ ] Given the test id does not exist or belongs to another workspace, when I request it, then the API returns 404 `{"error": "Resource not found"}` and the page says the report is not available rather than showing an empty table.
- [ ] Given the response is an empty array, when it renders, then the empty state says the check has not produced results yet and offers to re-run, rather than implying a clean result.
- [ ] Given any IP comes back listed, when the check completes, then an incident is written to the Monitoring incident feed naming the IP and the blocklist.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, all clean | Run the check for a test id whose seeds all returned `total_blacklist: 0` | 200, JSON array of row objects; every row shows `details` like "IP not listed on Spamhaus"; page header reads "No listings found" |
| TC-2 | Missing/invalid API key | Call the endpoint with `api_key` omitted (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again" and no cached result is displayed as fresh |
| TC-3 | Test id not found / wrong workspace | Request a `spamTestId` created by another workspace | 404 `{"error": "Resource not found"}`; UI shows "That deliverability report is not available" and returns to Monitoring |
| TC-4 | Validation failure | Request with a `spamTestId` that is not a valid identifier (e.g. `report//blacklist`) | 422 `{"error": "Invalid parameters provided"}`; field-level message on the test id, no request retried |
| TC-5 | Rate limited | Poll the blacklist check every second for a minute | 429 on the excess; client backs off with jitter, the panel shows one "Checking again shortly" state, not a stack of errors |
| TC-6 | Empty result set | Request a test whose seeds have not been delivered yet | 200 with `[]`; the panel shows "No blacklist results yet" plus the test's status, never a green "all clear" |
| TC-7 | One IP listed on one blocklist | Seed data with a row `{"ip": "192.168.1.101", "blacklist_type_value": "barracuda", "total_blacklist": 1}` | That IP is flagged; `details` ("IP listed on Barracuda Block List") is shown verbatim; an incident row appears in Monitoring |
| TC-8 | Same IP across several seed mailboxes | Two rows with the same `ip` but different `to_email` (`seed1@gmail.com`, `seed3@yahoo.com`) | The IP is reported once with both recipient domains listed under it |
| TC-9 | Missing rDNS | A row where `rdns` is null or empty | Row still renders; the rDNS cell reads "not set" and links to the rDNS report rather than breaking the table |
| TC-10 | Upstream unavailable | Provider returns 503 | Harry surfaces "Blacklist check is temporarily unavailable", keeps the last known result labelled with its timestamp, and retries on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** a blacklist panel inside the deliverability report, **so that** I can see at a glance whether my sending IP is blocked anywhere.

**Scope**
- Monitoring → Deliverability report detail: a "Blacklist check" panel listing each IP with its rDNS, the blocklists checked, and a listed/clear state per blocklist.
- Mailboxes: each mailbox row gains a small "Blocklist: clear / 1 listing" indicator sourced from the same data, linking through to the panel.
- Loading: skeleton rows. Empty: "No blacklist results yet for this test." Error: inline banner that keeps the last successful result visible and stamped with its time.
- Accessibility: listed/clear is stated in text, never colour alone; the table has a caption and scoped headers; `details` is the accessible description of each row. Responsive: the table collapses to stacked cards under 640px with IP as the card heading.

**Definition of done**
- [ ] Rows are grouped by `ip` and each blocklist result under it is individually readable.
- [ ] A listing shows the blocklist name and the provider's own `details` sentence without paraphrasing it.
- [ ] The Mailboxes indicator and the panel can never disagree — both read one cached result.
- [ ] Loading, empty, error and stale states are all designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that fetches and caches the blacklist result for a placement test, **so that** the UI and the incident feed read one consistent answer.

**Scope**
- Route in `server/routes.js`, matching the workspace-scoped pattern: `GET /api/deliverability/tests/:testId/blacklist`, returning the normalised row array.
- Data model: a `deliverability_blacklist` table in `server/db.js` (`test_id`, `ip`, `rdns`, `domain`, `to_email`, `blacklist_type_value`, `total_blacklist`, `details`, `checked_at`) so the result survives a page reload and can be diffed between runs.
- The upstream needs no pagination — the array is per-seed and small — but the route caps stored rows per test and dedupes on (`test_id`, `ip`, `blacklist_type_value`).
- Rate limiting: results are cached for the life of the test; refresh is throttled server-side to one call per test per five minutes, with exponential backoff and jitter on 429 and 503.
- Logged: an `events` row when a new listing first appears or clears; `telemetry` records fetch latency and failure reason so Monitoring can show the deliverability check itself as a component.

**Definition of done**
- [ ] Route is workspace-scoped and returns 404 for another workspace's test id, covered by a test.
- [ ] Repeat fetches inside the throttle window serve cache and do not hit upstream.
- [ ] A transition from `total_blacklist: 0` to `1` writes exactly one incident, not one per poll.
- [ ] 429 and 503 responses back off without surfacing raw upstream errors to the user.

## 6. End-to-end test ticket

**Title:** E2E — Spot a blocklisted sending IP before a campaign runs

**Preconditions:** A workspace with one sandbox mailbox, one completed placement test fixture whose blacklist response contains one clean row (`total_blacklist: 0`) and one listed row (`barracuda`, `total_blacklist: 1`), and Monitoring reachable.

**Flow**
1. Open Monitoring and choose the deliverability report for the fixture test.
2. Open the "Blacklist check" panel.
3. Note the flagged IP and follow the link to Mailboxes.
4. Return to Monitoring and open the incident feed.

**Assertions**
- [ ] The panel lists both IPs, one marked clear and one marked listed on Barracuda, with the provider's `details` sentence shown.
- [ ] The Mailboxes row for the affected mailbox shows "1 listing" and links back to the same panel.
- [ ] The incident feed contains one entry naming the IP and the blocklist, timestamped.
- [ ] Reloading the page shows the same result from cache without a second upstream call.

**Teardown:** Delete the fixture test and its cached blacklist rows; clear the generated incident.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring | New "Blacklist check" panel inside a deliverability report | Medium | Lives inside the report detail, not on the Monitoring index; collapsed to one summary line when everything is clear |
| Mailboxes | One extra status indicator per mailbox | Low | Plain text, sits with the existing health state rather than starting a new column group |
| Monitoring incident feed | Listings appear as incidents | Low | Reuses the existing feed; one incident per state change, not per poll |

**Verdict:** Fits an existing surface

Monitoring already exists to show end-to-end health of every hop in the pipeline, and a blocked sending IP is exactly that kind of hop. The panel adds depth inside a report a user has already chosen to open, and the only thing that reaches the top level is a single word on the Mailboxes row — which is where someone worrying about a mailbox already looks. No new navigation item.
