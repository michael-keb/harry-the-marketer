# SPF Details

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/spf-details` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/spf-details |
| **Auth** | API key (query param `api_key`) |

Reports whether each receiving provider agreed that your server is allowed to send mail for your domain.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner, **I want** to see whether SPF passes at each provider, **so that** I can fix the DNS record before more mail is filtered.

**Acceptance criteria**
- [ ] Given a completed placement test, when I open SPF details, then I get one group per `from_email`, each with a `seed_accounts` array carrying `id`, `email`, `esp` and `spf_verified`.
- [ ] Given every `spf_verified` in a group is `true`, when it renders, then the group reads "SPF verified at Gmail, Outlook" naming the `esp` values rather than showing booleans.
- [ ] Given any `spf_verified` is `false`, when it renders, then the failing seed's `esp` and `email` are named and the group is marked failing, not averaged into a pass rate.
- [ ] Given SPF passes at one provider and fails at another for the same address, when it renders, then both results are shown side by side, because that pattern usually means an alignment problem rather than a missing record.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the report is not available.
- [ ] Given the response is an empty array, when it renders, then the panel says no SPF results are available yet rather than implying a pass.
- [ ] Given an SPF failure appears, when the result is stored, then an incident is written to Monitoring naming the sending address and the provider.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, all verified | Fetch SPF details where every seed has `spf_verified: true` | 200, array of `{from_email, seed_accounts[]}`; `campaigns@example.com` reads "Verified at Gmail, Outlook" |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; nothing rendered as fresh |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Poll the check every second | 429 on the excess; backoff with jitter; a single "Checking again shortly" state |
| TC-6 | Empty result set | Fetch a test whose seeds are undelivered | 200 with `[]`; "No SPF results yet"; never a pass |
| TC-7 | One provider fails | Data where `seed3@yahoo.com` has `spf_verified: false` | The Yahoo seed is named under `support@example.com`; an incident is raised for that address and provider |
| TC-8 | Mixed within one address | One seed true and one false under the same `from_email` | Both are shown; the group is marked failing and a note explains that a partial pass usually indicates alignment rather than a missing record |
| TC-9 | Cross-check with headers | An SPF failure while the reply headers show `spf=pass` | Both are shown with a link to the headers view; neither result is suppressed in favour of the other |
| TC-10 | Upstream unavailable | Provider returns 503 | "SPF check is temporarily unavailable"; last known result kept with a timestamp; retried on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** SPF graded alongside DKIM and reverse DNS, **so that** authentication is one thing to read rather than three.

**Scope**
- Monitoring → Deliverability report detail: SPF is the second row of the shared "Authentication" section, one row per `from_email`, expandable to the per-provider seed results.
- Mailboxes: the mailbox's authentication line names whichever of the three checks is failing rather than listing all three when all pass.
- The section carries one sentence explaining what SPF is and that fixing it means a DNS change, so the next step is obvious to someone who has never edited a DNS record.
- Loading: skeleton rows. Empty: "No SPF results yet." Error: banner keeping the last result visible and timestamped.
- Accessibility: pass and fail are words; the expandable group is a real disclosure with an accessible name; the per-provider results are a description list. Responsive: groups stack under 640px with the sending address as the heading.

**Definition of done**
- [ ] SPF renders through the same component as DKIM and rDNS with no visual divergence.
- [ ] A failure names the provider and the seed address.
- [ ] A partial pass within one address is explained rather than averaged.
- [ ] Loading, empty, failing, partial, error and stale states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** SPF results stored in the shared authentication table, **so that** all three checks are one query and one component.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/spf`, workspace-scoped, returning the grouped array.
- Data model: reuses `deliverability_auth_results` from the DKIM ticket with `check: "spf"` — the same columns (`test_id`, `check`, `from_email`, `seed_id`, `seed_email`, `esp`, `passed`, `checked_at`).
- A single combined route, `GET /api/deliverability/tests/:testId/authentication`, returns all three checks together so the report section renders in one request; the per-check routes remain for targeted refreshes.
- No pagination. Refresh throttled to once per test per five minutes; upstream 429 and 503 back off with jitter and serve the cache.
- Logged: an `events` row when a `from_email` transitions between passing and failing on SPF; `telemetry` records fetch latency and failures for the Monitoring component grade.

**Definition of done**
- [ ] SPF, DKIM and rDNS share one table and one response shape, covered by a test.
- [ ] The combined authentication route returns all three in one query.
- [ ] A pass-to-fail transition writes exactly one incident.
- [ ] Route is workspace-scoped and 404s on another workspace's test.

## 6. End-to-end test ticket

**Title:** E2E — Catch an SPF failure at one provider

**Preconditions:** A workspace with one sandbox mailbox and a completed placement test fixture whose SPF response has `campaigns@example.com` fully verified and `support@example.com` failing at Yahoo, with DKIM and rDNS fixtures passing.

**Flow**
1. Open Monitoring and choose the fixture's deliverability report.
2. Open the "Authentication" section.
3. Expand the failing SPF group.
4. Open Mailboxes.
5. Open the Monitoring incident feed.
6. Inspect the network calls made when the section loaded.

**Assertions**
- [ ] All three checks render in one section with identical layout, SPF alone marked failing.
- [ ] The expanded group names the Yahoo seed by email and ESP.
- [ ] Mailboxes names SPF specifically as the failing check, not "authentication".
- [ ] The incident feed has one entry naming the address and Yahoo.
- [ ] The section loaded via one combined authentication request, not three.

**Teardown:** Delete the fixture test, its cached auth rows and the incident.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | One more row inside the shared "Authentication" section | Low | No new panel; the section collapses to one line when all three checks pass |
| Mailboxes | Authentication line names the failing check | Low | Same line as DKIM and rDNS, more specific wording |
| Monitoring incident feed | SPF failures raise incidents | Low | Reuses the feed; one incident per state change |

**Verdict:** Fits an existing surface

SPF is the second of three checks that answer one question, so the correct outcome is a shared component and a combined request rather than a third panel. The user-facing cost is one row, and on a healthy domain the whole section is one line. No new navigation item.
