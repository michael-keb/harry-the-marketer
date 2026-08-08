# Domain Blacklist

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/domain-blacklist` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/domain-blacklist |
| **Auth** | API key (query param `api_key`) |

Tells you whether the domain you send from has been blocklisted, as seen from each of the test inboxes.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner, **I want** to know whether my sending domain is blocklisted, **so that** I stop sending and get it delisted instead of quietly burning the domain for months.

**Acceptance criteria**
- [ ] Given a completed placement test, when I open the domain blocklist check, then I get one group per `from_email`, each with a `seed_accounts` array carrying `id`, `email`, `esp` and `domain_blacklisted`.
- [ ] Given every `domain_blacklisted` in a group is `false`, when it renders, then the group reads "Not blocklisted, checked at Gmail, Outlook" naming the `esp` values.
- [ ] Given any `domain_blacklisted` is `true`, when it renders, then that sending address is marked blocklisted, the observing provider is named, and the result is not averaged into a percentage.
- [ ] Given several sending addresses share one domain, when the view renders, then they are rolled up to the domain as well as listed per address, because a blocklisting affects the whole domain.
- [ ] Given the test id does not exist or is another workspace's, when I request it, then the API returns 404 `{"error": "Resource not found"}` and the page says the report is not available.
- [ ] Given the response is an empty array, when it renders, then the panel says no results are available yet rather than implying the domain is clean.
- [ ] Given a domain comes back blocklisted, when the result is stored, then an incident is written to Monitoring and every campaign sending from that domain shows a warning on its detail page.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, clean | Fetch for a test where all three seeds return `domain_blacklisted: false` | 200, array of `{from_email, seed_accounts[]}`; panel reads "Not blocklisted" for both sending addresses |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; no cached result shown as fresh |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; field-level message; no retry |
| TC-5 | Rate limited | Poll the check every second for a minute | 429 on the excess; backoff with jitter; one "Checking again shortly" state |
| TC-6 | Empty result set | Fetch a test whose seeds are undelivered | 200 with `[]`; "No domain blocklist results yet"; never a clean verdict |
| TC-7 | Domain listed at one provider | Data where `seed2@outlook.com` returns `domain_blacklisted: true` | `campaigns@example.com` is marked blocklisted as seen from Outlook; an incident is raised; the campaign detail warning appears |
| TC-8 | Same domain, two addresses | `campaigns@example.com` and `support@example.com` both on `example.com`, one listed | The domain rollup reads blocklisted; both addresses are shown, with the listing attributed to the address that observed it |
| TC-9 | Mixed providers disagree | One `esp` reports listed, another reports not | Both observations are shown side by side rather than one overriding the other; the summary treats any listing as a listing |
| TC-10 | Upstream unavailable | Provider returns 503 | "Domain blocklist check is temporarily unavailable"; last known result kept with its timestamp; retried on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** the domain blocklist result shown next to the IP blocklist result, **so that** I can tell in one glance whether the problem is my domain or the network I send from.

**Scope**
- Monitoring → Deliverability report detail: the "Blocklist check" panel gains a Domain tab or sub-section beside the existing IP rows, sharing the same layout.
- Campaigns → campaign detail: a warning line when the campaign's sending domain is currently listed, with a link to the report.
- Mailboxes: the existing blocklist indicator distinguishes "IP listed" from "Domain listed" instead of collapsing both to one word.
- Loading: skeleton rows. Empty: "No domain blocklist results yet." Error: banner keeping the last known result visible and timestamped.
- Accessibility: listed and clear are words, not colour; the domain rollup is a heading with the per-address results beneath it as a list; providers are named in text. Responsive: stacks to cards under 640px keyed by sending address.

**Definition of done**
- [ ] Domain and IP results share one panel and one visual language.
- [ ] A listing is attributed to the address and provider that observed it, never to "the workspace".
- [ ] The campaign warning appears only while a listing is current and disappears when it clears.
- [ ] Loading, empty, listed, error and stale states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that fetches and caches the domain blocklist result, **so that** the report, the campaign warning and the incident feed read the same answer.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/domain-blacklist`, workspace-scoped, returning the grouped shape unchanged.
- Data model: a `deliverability_domain_blacklist` table in `server/db.js` (`test_id`, `from_email`, `domain`, `seed_id`, `seed_email`, `esp`, `blacklisted`, `checked_at`), with the domain derived from `from_email` server-side so the rollup is not recomputed in two places.
- No pagination. Refresh throttled to once per test per five minutes; upstream 429 and 503 back off with jitter and never surface raw upstream errors.
- Logged: an `events` row when a domain first appears listed or first clears; `telemetry` records fetch latency and failure reasons for the Monitoring component grade.

**Definition of done**
- [ ] Route is workspace-scoped and 404s on another workspace's test, covered by a test.
- [ ] The domain rollup is computed once, server-side, and matches the per-address rows.
- [ ] A listing raises exactly one incident per state change.
- [ ] The campaign-detail warning is derived from the same stored rows, not a second fetch.

## 6. End-to-end test ticket

**Title:** E2E — See a blocklisted sending domain and its effect on campaigns

**Preconditions:** A workspace with one sandbox mailbox on `example.com`, one launched campaign using it, and a completed placement test fixture whose domain-blacklist response marks one Outlook seed `domain_blacklisted: true`.

**Flow**
1. Open Monitoring and choose the fixture's deliverability report.
2. Open the "Blocklist check" panel and switch to Domain.
3. Read the rollup for `example.com`.
4. Open the campaign detail page.
5. Open the Monitoring incident feed.

**Assertions**
- [ ] The Domain view names `example.com` as listed, attributing the observation to the Outlook seed.
- [ ] Both sending addresses on the domain are listed under the rollup.
- [ ] Campaign detail shows a warning naming the domain and linking back to the report.
- [ ] The incident feed shows one entry, timestamped.
- [ ] Replacing the fixture with a clean response and refreshing clears both the warning and the panel state.

**Teardown:** Delete the fixture test, its cached rows and the incident; the campaign warning must clear automatically.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | Domain results inside the existing "Blocklist check" panel | Low | Shares the panel and layout with the IP check; no second panel |
| Campaigns → campaign detail | Warning line while the domain is listed | Medium | Appears only while a listing is current, one line, links away rather than explaining in place |
| Mailboxes | Indicator distinguishes IP from domain listing | Low | Same indicator, more precise wording |

**Verdict:** Fits an existing surface

Domain and IP blocklisting answer the same worry and belong in the same panel, which stops the report growing a panel per check. The only thing that reaches a busier page is a conditional one-line warning on campaign detail, and that is exactly the moment a user needs to know. No new navigation item.
