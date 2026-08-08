# DKIM Details

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/dkim-details` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/dkim-details |
| **Auth** | API key (query param `api_key`) |

Reports whether each test email arrived with a valid DKIM signature, which is how receiving mail servers confirm the message really came from your domain.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner, **I want** to see whether my emails pass DKIM at each receiving provider, **so that** I can fix a broken signature before it costs me the inbox at Gmail or Outlook.

**Acceptance criteria**
- [ ] Given a completed placement test, when I open its DKIM details, then I get one group per `from_email`, each with a `seed_accounts` array carrying `id`, `email`, `esp` and `dkim_verified`.
- [ ] Given a group where every `dkim_verified` is `true`, when it renders, then it reads "DKIM verified at Gmail, Outlook" naming the `esp` values rather than showing a raw boolean.
- [ ] Given any `dkim_verified` is `false`, when it renders, then the failing seed's `esp` and `email` are shown and the group is marked as failing, not averaged into a percentage that hides it.
- [ ] Given several `from_email` addresses were tested, when the view renders, then each sending address is graded separately, because DKIM is per-domain and one address can pass while another fails.
- [ ] Given the test id does not exist or is another workspace's, when I request it, then the API returns 404 `{"error": "Resource not found"}` and the page says the report is not available.
- [ ] Given the response is an empty array, when it renders, then the panel says no DKIM results are available yet rather than implying everything passed.
- [ ] Given a DKIM failure appears, when the report is stored, then an incident is written to the Monitoring incident feed naming the sending address and the provider that rejected the signature.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, all verified | Fetch DKIM details for a test where every seed has `dkim_verified: true` | 200, array of `{from_email, seed_accounts[]}`; panel reads "Verified at Gmail, Outlook" for `campaigns@example.com` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again"; no stale result presented as fresh |
| TC-3 | Test not found / wrong workspace | Fetch a `spamTestId` from another workspace | 404 `{"error": "Resource not found"}`; "That deliverability report is not available"; return to Monitoring |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; field-level message; no retry |
| TC-5 | Rate limited | Poll DKIM details every second | 429 on the excess; backoff with jitter; one "Checking again shortly" state |
| TC-6 | Empty result set | Fetch a test whose seeds have not been delivered | 200 with `[]`; panel shows "No DKIM results yet", never a pass |
| TC-7 | One provider fails | Data where `seed3@yahoo.com` has `dkim_verified: false` | The Yahoo seed is listed as failing under `support@example.com`; an incident is raised naming that address and Yahoo |
| TC-8 | Two sending addresses, mixed | `campaigns@example.com` all true, `support@example.com` one false | Two separate groups, one clear and one failing; no combined "67% pass" figure anywhere |
| TC-9 | Unknown ESP label | A seed whose `esp` is missing or unrecognised | The row still renders using the seed `email` domain as the label; nothing breaks |
| TC-10 | Upstream unavailable | Provider returns 503 | "DKIM check is temporarily unavailable"; last known result stays visible with its timestamp; retried on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** a plain-English DKIM section in the deliverability report, **so that** I know whether authentication is my problem without reading DNS records.

**Scope**
- Monitoring → Deliverability report detail: an "Authentication" section with DKIM as one row per `from_email`, expandable to the per-provider seed results.
- Mailboxes: each mailbox shows "DKIM: verified / failing at Yahoo" from the same cached result, linking to the report.
- The section explains in one sentence what DKIM is and what a failure means for the user, so nobody has to leave the page to understand it.
- Loading: skeleton rows. Empty: "No DKIM results yet for this test." Error: inline banner keeping the last result visible and timestamped.
- Accessibility: pass and fail are stated as words, never colour alone; the expandable group is a real disclosure with an accessible name; the per-provider list is a description list. Responsive: groups stack under 640px with the sending address as the heading.

**Definition of done**
- [ ] Each `from_email` is graded independently and a single failure is never averaged away.
- [ ] The per-provider detail names the `esp` and the seed `email`.
- [ ] The Mailboxes indicator and the report section read one cached result and cannot disagree.
- [ ] Loading, empty, failing, error and stale states are all designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that fetches and caches DKIM results per placement test, **so that** the report, the Mailboxes indicator and the incident feed agree.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/dkim`, workspace-scoped, returning the grouped array unchanged in shape.
- Data model: a `deliverability_auth_results` table in `server/db.js` (`test_id`, `check` — dkim/spf/rdns — `from_email`, `seed_id`, `seed_email`, `esp`, `passed`, `checked_at`), shared with the SPF and rDNS tickets so the three authentication checks stay one shape.
- No pagination — the array is per-seed and small. Results are cached for the life of the test and refreshed at most once per five minutes per test; upstream 429 and 503 back off with jitter.
- Logged: an `events` row the first time a `from_email` transitions from passing to failing or back; `telemetry` records fetch latency and failures so Monitoring can grade the deliverability checker as a component.

**Definition of done**
- [ ] Route is workspace-scoped, 404 on another workspace's test, covered by a test.
- [ ] A pass-to-fail transition writes exactly one incident, not one per poll.
- [ ] Grouping by `from_email` is preserved end to end — no flattening that loses which address failed.
- [ ] Cached results survive a server restart and are served with their `checked_at`.

## 6. End-to-end test ticket

**Title:** E2E — Catch a DKIM failure at one provider

**Preconditions:** A workspace with one sandbox mailbox and a completed placement test fixture whose DKIM response contains two groups — `campaigns@example.com` all verified, `support@example.com` with a Yahoo seed at `dkim_verified: false`.

**Flow**
1. Open Monitoring and choose the fixture's deliverability report.
2. Open the "Authentication" section.
3. Expand the `support@example.com` group.
4. Follow the link to Mailboxes.
5. Open the Monitoring incident feed.

**Assertions**
- [ ] Two groups are shown, one clear and one failing, with the failure not hidden behind an aggregate figure.
- [ ] The expanded group names the Yahoo seed by email and ESP.
- [ ] The Mailboxes row for the affected sending address reads "DKIM failing at Yahoo".
- [ ] The incident feed has one entry naming the address and the provider.
- [ ] Reloading serves the cached result with its original timestamp and makes no second upstream call.

**Teardown:** Delete the fixture test, its cached authentication rows and the incident.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | DKIM row inside a shared "Authentication" section | Low | Shares the section with SPF and rDNS rather than getting its own panel; collapsed to one line when everything passes |
| Mailboxes | One authentication status line per mailbox | Low | Sits with the existing health state; text only |
| Monitoring incident feed | DKIM failures raise incidents | Low | Reuses the feed; one incident per state change |

**Verdict:** Fits an existing surface

DKIM, SPF and rDNS are three answers to the same question — is this mail provably from you — so they share one section and one shape, which keeps the report from turning into a wall of acronyms. The user-facing surface is a single line that says pass or fail in words. No new navigation item.
