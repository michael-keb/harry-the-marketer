# IP Blacklist Count

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/blacklist` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/ip-blacklist-count |
| **Auth** | API key (query param `api_key`) |

Returns a single number — how many blocklists your sending IPs appear on — for a quick yes-or-no health check.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

> **Documentation note.** This page documents the same path as "IP Blacklist Check" (`/report/{spamTestId}/blacklist`) but a different 200 body — a summary object `{"total_blacklist": 0}` rather than the per-seed array. The docs do not publish the parameter that selects between them. Treat this as the summary read of the same resource and implement both from one adapter, deriving the count locally if a single upstream call proves to return only the array.

## 2. User story

**As a** mailbox owner glancing at Monitoring, **I want** a single blocklist count per test, **so that** I can tell in one second whether anything needs my attention before I open the detail.

**Acceptance criteria**
- [ ] Given a completed placement test, when I fetch the count, then the response returns `total_blacklist` as a number.
- [ ] Given `total_blacklist` is `0`, when it renders, then the summary reads "No blocklist listings" in words, not a bare zero.
- [ ] Given `total_blacklist` is `1` or more, when it renders, then it reads "1 blocklist listing" or "3 blocklist listings" and links straight to the detailed per-IP breakdown.
- [ ] Given the count is derived rather than fetched, when the detail array is already cached, then no extra request is made and the two views can never disagree.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the summary shows "not available" rather than zero.
- [ ] Given the count is not yet available, when it renders, then it shows a pending state, because zero and "not checked yet" must never look the same.
- [ ] Given the count rises above zero, when it is stored, then an incident is raised once in Monitoring and the affected mailboxes are flagged.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, clean | Fetch the count for a test with no listings | 200 `{"total_blacklist": 0}`; the summary line reads "No blocklist listings" |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; the summary shows nothing rather than zero |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; summary reads "Not available"; the row links nowhere |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; summary shows "Not available"; no retry loop |
| TC-5 | Rate limited | Render a list of 50 tests, each fetching its own count | 429 on the excess; the client fetches counts in one batched call per page and backs off with jitter |
| TC-6 | Empty result set | Fetch for a test whose seeds are undelivered | Pending state ("Checking…"), never "No listings" |
| TC-7 | Listings present | Response `{"total_blacklist": 3}` | Summary reads "3 blocklist listings" and links to the per-IP detail showing which IPs and which lists |
| TC-8 | Count agrees with detail | Fetch both the count and the per-seed array for the same test | The number shown equals the number of rows in the array with `total_blacklist` above zero; a mismatch fails the test |
| TC-9 | Count goes clean again | A test that previously returned 1 now returns 0 | The flag clears, the incident is marked resolved, and the mailbox indicator returns to clear |
| TC-10 | Upstream unavailable | Provider returns 503 | Last known count shown with its timestamp and a "not up to date" note; retried on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** the blocklist count on each row of the deliverability tests list, **so that** I do not have to open every report to find the one with a problem.

**Scope**
- Monitoring → Deliverability: each test row carries a blocklist column reading "Clear" or "2 listings", linking to that test's blocklist detail.
- Monitoring index: the deliverability component summary states how many tests currently show listings, consistent with how the existing component checks read.
- Loading: the cell shows a pending state distinct from "Clear". Empty: "Checking…". Error: the cell reads "Not available" and is not clickable.
- Accessibility: the count is text with a full accessible name ("2 blocklist listings, open detail"), not a bare number or a coloured dot; the pending state is announced once, not on every poll. Responsive: the column collapses into the row's secondary line under 640px.

**Definition of done**
- [ ] Zero, pending and unavailable are three visually distinct states.
- [ ] The count and the detail view are rendered from one cached record.
- [ ] Counts for a page of tests are fetched in one batched call, not one per row.
- [ ] Loading, clear, listed, unavailable and stale states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** the blocklist count served from the same cached record as the detail, **so that** a summary and a detail can never disagree.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/blacklist?summary=1` returning `{ totalBlacklist }`, plus a batched `GET /api/deliverability/tests/blacklist-summary?testIds=…` for the list view.
- Data model: reuses `deliverability_blacklist` from the IP Blacklist Check ticket; the count is derived with one grouped query over that table rather than stored as a second source of truth.
- One adapter owns the upstream call; if the provider only returns the array, the count is computed locally, so no behaviour depends on an undocumented parameter.
- Rate limiting: the batched route caps the number of ids per call and the client chunks beyond it; upstream 429 and 503 back off with jitter and serve the cache.
- Logged: an `events` row when a test's count crosses zero in either direction; `telemetry` records how often the summary is served from cache versus upstream, so the polling cost is visible.

**Definition of done**
- [ ] Count and detail are provably derived from the same rows, asserted by a test.
- [ ] The batched route answers a page of 50 test ids in one query.
- [ ] Crossing zero raises or resolves exactly one incident.
- [ ] A missing or pending record returns a distinct state, never `0`.

## 6. End-to-end test ticket

**Title:** E2E — Spot the one failing test in a list of deliverability runs

**Preconditions:** A workspace with five completed placement tests, four returning `total_blacklist: 0` and one returning `3`, plus one test still running with no blocklist result yet.

**Flow**
1. Open Monitoring → Deliverability.
2. Scan the blocklist column.
3. Open the failing test's blocklist detail from its row.
4. Return to Monitoring's index.
5. Update the fixture so the failing test returns `0` and refresh.

**Assertions**
- [ ] Four rows read "Clear", one reads "3 blocklist listings", and the running test reads "Checking…" — three distinct states.
- [ ] Following the failing row lands on the per-IP detail, which lists exactly three listings.
- [ ] The Monitoring index deliverability component states that one test has listings.
- [ ] After the fixture update, the row reads "Clear", the index component reports none, and the incident is resolved rather than duplicated.
- [ ] Loading the list makes one batched summary call, not six.

**Teardown:** Delete the six test fixtures, their cached blocklist rows and the incident.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability list | One blocklist column per row | Low | Text only, and it is the column people came to read; collapses into the secondary line on small screens |
| Monitoring index | Deliverability component states how many tests have listings | Low | Reuses the existing component-check row rather than adding a tile |

**Verdict:** Fits an existing surface

This is a summary of data the detail view already holds, so it should cost one column and one sentence, not a dashboard. Its whole value is letting someone skip the report entirely on a good day, which is why "clear", "checking" and "not available" have to look different. No new navigation item.
