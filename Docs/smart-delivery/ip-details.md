# IP Details

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/ip-analytics` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/ip-details |
| **Auth** | API key (query param `api_key`) |

Describes each IP address your test emails were sent from — who owns it, where it is, its reverse DNS name, and whether its reputation is good.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner, **I want** to see who owns the IP my mail leaves from and what its reputation is, **so that** I know whether a placement problem is mine to fix or my provider's.

**Acceptance criteria**
- [ ] Given a completed placement test, when I open IP details, then I get one entry per `ip` with `blacklisted`, a plain-English `summary`, a `whois_data` object and `created_at`.
- [ ] Given `whois_data` is present, when it renders, then `isp`, `organization`, `location` and `reverse_dns` are each labelled in plain words ("Sent through Example ISP, United States").
- [ ] Given the provider supplies a `summary` sentence, when it renders, then it is shown verbatim rather than paraphrased, because it is the only human-readable reputation verdict in the payload.
- [ ] Given `blacklisted` is `true` for an IP, when it renders, then the entry is marked and links to the blocklist detail for the same test, rather than restating the listings here.
- [ ] Given `whois_data.reverse_dns` is missing or empty, when it renders, then the field reads "not set" and links to the rDNS report, because a missing reverse DNS record is itself a deliverability problem.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the report is not available.
- [ ] Given the response is an empty array, when it renders, then the panel says no IP information is available yet rather than implying a clean result.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Fetch IP details for a completed test | 200; array of entries each with `ip`, `blacklisted`, `summary`, `whois_data{isp, location, reverse_dns, organization}` and `created_at` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; nothing shown as fresh |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Poll IP details every second | 429 on the excess; backoff with jitter; one "Updating…" state |
| TC-6 | Empty result set | Fetch a test whose seeds are undelivered | 200 with `[]`; "No IP information yet for this test"; no rows drawn |
| TC-7 | Blocklisted IP | An entry with `blacklisted: true` | The entry is flagged and links to that test's blocklist detail; the reputation `summary` is shown unchanged |
| TC-8 | Missing whois fields | An entry where `whois_data.reverse_dns` is null | The row renders; reverse DNS reads "not set" and links to the rDNS report; no other field breaks |
| TC-9 | Two IPs, different ages | Entries with `created_at` 2025-03-01 and 2025-09-01 | Both shown with the first-seen date in the browser's timezone; the newer IP is noted as recently added, since new IPs warm up slowly |
| TC-10 | Upstream unavailable | Provider returns 503 | "IP information is temporarily unavailable"; last known values kept with their timestamp; retried on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** an IP panel in the deliverability report that explains the sending path in plain words, **so that** I can tell my provider exactly what is wrong.

**Scope**
- Monitoring → Deliverability report detail: a "Sending IPs" panel, one card per `ip`, showing the reputation `summary`, the ISP and organisation, the location, the reverse DNS name, and when the IP was first seen.
- Each card links sideways to the blocklist detail and the rDNS report for the same test rather than repeating their content.
- Mailboxes: a mailbox's detail view names the IP its last test sent from, so the two pages tell one story.
- Loading: skeleton cards. Empty: "No IP information yet for this test." Error: banner keeping the last values visible and timestamped.
- Accessibility: each card is a description list with real labels; the reputation summary is a paragraph, not a tooltip; "blocklisted" is stated in text. Responsive: cards stack to one column under 640px and long IP and hostname strings wrap rather than overflowing.

**Definition of done**
- [ ] Every documented `whois_data` field is labelled in plain words.
- [ ] The provider's `summary` sentence is displayed unmodified.
- [ ] Cross-links to blocklist and rDNS exist and no content is duplicated between panels.
- [ ] Loading, empty, blocklisted, missing-field and stale states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that fetches and caches per-IP analytics for a test, **so that** the report and the Mailboxes page describe the same sending path.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/ips`, workspace-scoped, returning the entries with `whois_data` flattened into named fields.
- Data model: a `deliverability_ip_details` table in `server/db.js` (`test_id`, `ip`, `blacklisted`, `summary`, `isp`, `organization`, `location`, `reverse_dns`, `first_seen_at`, `fetched_at`), so a change of sending IP between two tests is visible as a diff rather than lost.
- No pagination — a test uses a handful of IPs. Refresh throttled to once per test per five minutes; upstream 429 and 503 back off with jitter and serve the cache.
- Logged: an `events` row when a mailbox's sending IP changes between tests, because that is the kind of silent change that explains a sudden placement drop; `telemetry` records fetch latency and failures.

**Definition of done**
- [ ] Route is workspace-scoped and 404s on another workspace's test, covered by a test.
- [ ] `whois_data` is stored as named columns, so a missing sub-field cannot crash rendering.
- [ ] An IP change between two tests writes exactly one event.
- [ ] Cached values survive a restart and are served with `fetched_at`.

## 6. End-to-end test ticket

**Title:** E2E — Understand the sending path behind a placement problem

**Preconditions:** A workspace with one sandbox mailbox and a completed placement test fixture returning two IP entries — `192.168.1.100` with an excellent reputation summary and `192.168.1.101` with `blacklisted: true` and no `reverse_dns`.

**Flow**
1. Open Monitoring and choose the fixture's deliverability report.
2. Open the "Sending IPs" panel.
3. Read the card for `192.168.1.101`.
4. Follow its blocklist link, then come back and follow its rDNS link.
5. Open the mailbox detail on Mailboxes.

**Assertions**
- [ ] Both cards show the ISP, organisation, location, reverse DNS and first-seen date.
- [ ] The reputation summary text appears exactly as the provider wrote it.
- [ ] The blocklisted card is marked and its reverse DNS reads "not set" with a link to the rDNS report.
- [ ] Both cross-links land on the matching section for the same test.
- [ ] The mailbox detail names the same IP as the report, with no second fetch.

**Teardown:** Delete the fixture test and its cached IP rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | New "Sending IPs" panel of cards | Medium | Collapsed to one line per IP when reputation is clean; the detail expands only when asked |
| Mailboxes | Mailbox detail names its last known sending IP | Low | One line of text beside existing health information |

**Verdict:** Fits an existing surface

The report is where someone goes when placement looks wrong, and "which machine is this actually sending from" is the next question they ask. Keeping the panel collapsed while everything is clean means the extra depth costs nothing on a good day, and the cross-links stop the same listing being explained in three places. No new navigation item.
