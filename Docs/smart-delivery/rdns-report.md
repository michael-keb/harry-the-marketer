# rDNS Report

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/rdns-details` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/rdns-report |
| **Auth** | API key (query param `api_key`) |

Reports whether the sending IP has a valid reverse DNS name, which receiving servers check to decide whether a sender looks legitimate.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation note.** The published examples are inconsistent: the cURL and Python samples use GET while the JavaScript sample uses POST, and all three attach an empty body. This is a read, so the story treats it as a GET and keeps the method inside one adapter function so a correction does not ripple.

## 2. User story

**As a** mailbox owner, **I want** to know whether my sending IP has valid reverse DNS at each receiving provider, **so that** I can get it fixed before it costs me placement.

**Acceptance criteria**
- [ ] Given a completed placement test, when I open the rDNS report, then I get one group per `from_email`, each with a `seed_accounts` array carrying `id`, `email`, `esp` and `rdns_verified`.
- [ ] Given every `rdns_verified` in a group is `true`, when it renders, then the group reads "Reverse DNS verified at Gmail, Outlook" naming the `esp` values.
- [ ] Given any `rdns_verified` is `false`, when it renders, then the failing seed's `esp` and `email` are named and the group is marked as failing, not averaged into a rate.
- [ ] Given the rDNS check and the IP details panel disagree — one reports a `reverse_dns` hostname and the other reports unverified — when they render, then both are shown with an explanation that a name existing and a name matching are different things.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the report is not available.
- [ ] Given the response is an empty array, when it renders, then the panel says no rDNS results are available yet rather than implying a pass.
- [ ] Given an rDNS failure appears, when the result is stored, then an incident is written to Monitoring naming the sending address and the provider that failed the check.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, all verified | Fetch rDNS details where every seed has `rdns_verified: true` | 200, array of `{from_email, seed_accounts[]}`; `campaigns@example.com` reads "Verified at Gmail, Outlook" |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; nothing rendered as fresh |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Poll the report every second | 429 on the excess; backoff with jitter; a single "Checking again shortly" state |
| TC-6 | Empty result set | Fetch a test whose seeds are undelivered | 200 with `[]`; "No reverse DNS results yet"; never a pass |
| TC-7 | One provider fails | Data where `seed3@yahoo.com` has `rdns_verified: false` | The Yahoo seed is named under `support@example.com`; an incident is raised for that address and provider |
| TC-8 | Method mismatch | Call the adapter when the provider only accepts POST | The adapter retries with the alternate method once, logs the working method to telemetry, and the UI never sees the difference |
| TC-9 | Contradicts IP details | IP details reports `reverse_dns: "mail2.example.com"` while rDNS reports unverified | Both are shown with a one-sentence explanation; neither result is suppressed |
| TC-10 | Upstream unavailable | Provider returns 503 | "Reverse DNS check is temporarily unavailable"; last known result kept with a timestamp; retried on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** reverse DNS shown alongside DKIM and SPF, **so that** the three things that make me look legitimate are graded in one place.

**Scope**
- Monitoring → Deliverability report detail: rDNS is the third row of the shared "Authentication" section, one row per `from_email`, expandable to the per-provider seed results.
- Mailboxes: the mailbox's authentication line covers DKIM, SPF and rDNS together, naming whichever is failing rather than listing all three when all three pass.
- The section carries one sentence explaining what reverse DNS is and who fixes it, since it is usually the hosting provider rather than the user.
- Loading: skeleton rows. Empty: "No reverse DNS results yet." Error: banner keeping the last result visible and timestamped.
- Accessibility: pass and fail are words; the expandable group is a real disclosure with an accessible name; the per-provider list is a description list. Responsive: groups stack under 640px with the sending address as the heading.

**Definition of done**
- [ ] rDNS reuses the same component as DKIM and SPF with no visual divergence.
- [ ] A failure names the provider and the seed address.
- [ ] The explanatory sentence says who typically fixes it, so the next action is obvious.
- [ ] Loading, empty, failing, contradictory, error and stale states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** rDNS results fetched and cached in the same shape as DKIM and SPF, **so that** one component can render all three checks.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/rdns`, workspace-scoped, returning the grouped array.
- Data model: reuses the `deliverability_auth_results` table from the DKIM ticket with `check: "rdns"`, so adding a fourth authentication check later needs no migration.
- The adapter owns the HTTP method. Because the documented samples disagree, it tries the documented GET, falls back once to POST on a 405, and records which worked in telemetry.
- No pagination. Refresh throttled to once per test per five minutes; upstream 429 and 503 back off with jitter and serve the cache.
- Logged: an `events` row when a `from_email` transitions between passing and failing; `telemetry` records fetch latency, the working HTTP method, and failures for the Monitoring component grade.

**Definition of done**
- [ ] Route is workspace-scoped and 404s on another workspace's test, covered by a test.
- [ ] rDNS rows are stored in the shared auth table and render through the same component as DKIM.
- [ ] The method fallback happens at most once per fetch and is recorded.
- [ ] A pass-to-fail transition writes exactly one incident.

## 6. End-to-end test ticket

**Title:** E2E — Catch a missing reverse DNS record

**Preconditions:** A workspace with one sandbox mailbox and a completed placement test fixture whose rDNS response has `campaigns@example.com` fully verified and `support@example.com` failing at Yahoo, plus an IP details fixture that still reports a hostname for the same IP.

**Flow**
1. Open Monitoring and choose the fixture's deliverability report.
2. Open the "Authentication" section and find the rDNS row.
3. Expand the `support@example.com` group.
4. Open the "Sending IPs" panel and compare.
5. Open Mailboxes and the Monitoring incident feed.

**Assertions**
- [ ] rDNS renders in the same layout as DKIM and SPF, with two groups and one failing.
- [ ] The expanded group names the Yahoo seed by email and ESP.
- [ ] The contradiction between the reported hostname and the unverified result is explained in one sentence rather than hidden.
- [ ] Mailboxes shows an authentication line naming reverse DNS as the failing check.
- [ ] The incident feed has one entry naming the address and Yahoo.

**Teardown:** Delete the fixture test, its cached auth rows and the incident.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | One more row inside the shared "Authentication" section | Low | No new panel; the section collapses to one line when all three checks pass |
| Mailboxes | Authentication line names the failing check | Low | Same line as DKIM and SPF, more specific wording |
| Monitoring incident feed | rDNS failures raise incidents | Low | Reuses the feed; one incident per state change |

**Verdict:** Fits an existing surface

rDNS is the third of three answers to the same question, so it costs one row in a section that already exists. The only genuinely new work is the sentence explaining that reverse DNS is usually the hosting provider's job, which is what turns a red flag into something the user can actually act on. No new navigation item.
