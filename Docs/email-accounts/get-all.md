# Get All Email Accounts

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/email-accounts/` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/get-all |
| **Auth** | API key (query param `api_key`) |

Lists every sending mailbox in the workspace, with its connection health, today's send count, warm-up state and tags, and lets you filter that list.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner with a dozen mailboxes, **I want** one list that shows each mailbox's health, today's usage and warm-up progress, and lets me filter to just the broken or unused ones, **so that** I can fix the fleet in a minute instead of clicking through every mailbox.

**Acceptance criteria**
- [ ] Given mailboxes exist, when I open the list, then each row carries the fields the payload defines: `from_name`, `from_email`, `type`, `message_per_day`, `daily_sent_count`, `is_smtp_success`, `is_imap_success`, `campaign_count`, `tags` and `warmup_details`.
- [ ] Given a broken mailbox, when it is listed, then the specific failure text is available (`smtp_failure_error` or `imap_failure_error`) rather than a bare "error" state.
- [ ] Given more mailboxes than fit one page, when I scroll or page, then `offset` and `limit` are used with the documented bounds — `limit` defaults to 100 and must be between 1 and 100, and a value above 100 returns 422 `{"error": "limit must be less than or equal to 100"}`.
- [ ] Given I want only the mailboxes that need attention, when I filter, then `isSmtpSuccess=false`, `emailWarmupStatus=ACTIVE|INACTIVE`, `isWarmupBlocked=true`, `isInUse=false`, `esp=GMAIL|OUTLOOK|SMTP` and a partial `username` match all work and can be combined.
- [ ] Given I need to know where a mailbox is used, when I pass the equivalent of `fetch_campaigns=true`, then each row carries the list of campaign ids using it; without it, only `campaign_count` is returned so the default response stays small.
- [ ] Given a workspace with no mailboxes, when I open the list, then the response is an empty array and the page shows the "Connect your first mailbox" empty state.
- [ ] Given the response is serialised, when it leaves the server, then no password or refresh token is present in any form — SmartLead returns base64-encoded secrets here and Harry must not copy that behaviour.
- [ ] Given a filter returns nothing, when the list renders, then it says which filter emptied it and offers to clear it, rather than showing the first-run empty state.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET the list with `limit=50&offset=0` on a workspace with three mailboxes | 200, an array of three objects each carrying `id`, `from_email`, `daily_sent_count`, `message_per_day`, `is_smtp_success`, `campaign_count`, `tags` |
| TC-2 | Missing/invalid API key | GET with no session cookie | 401, `{"message": "Invalid API Key"}`; page redirects to sign-in, no partial list rendered |
| TC-3 | Not found / wrong workspace | GET while signed in to a workspace that owns none of the mailboxes | 200 with an empty array — never another workspace's mailboxes |
| TC-4 | Validation failure | GET with `limit=500` | 422, `{"error": "limit must be less than or equal to 100"}`; UI clamps and retries once at 100 |
| TC-5 | Rate limited | Poll the list every 200ms for a minute | 429 on the excess; the client backs off with jitter and keeps showing the last good list rather than blanking |
| TC-6 | Empty result set | GET on a workspace with no mailboxes | 200, `[]`; "Connect your first mailbox" empty state with the connect action |
| TC-7 | Filter to broken mailboxes | GET with `isSmtpSuccess=false` | Only mailboxes whose send leg is failing, each with a non-null `smtp_failure_error` shown as readable text |
| TC-8 | Filter to unused mailboxes | GET with `isInUse=false` | Only mailboxes with `campaign_count` 0; useful for spotting mailboxes paid for and idle |
| TC-9 | Campaign ids opt-in | GET twice, with and without `fetch_campaigns=true` | `campaign_ids` present only in the second response; the first is measurably smaller |
| TC-10 | Pagination boundary | GET `offset=100&limit=100` on a workspace with 150 mailboxes | 200 with the last 50; no duplicates against the first page |
| TC-11 | Secrets excluded | Inspect any row of TC-1's response | No `password`, `imap_password`, access token or refresh token in any encoding |
| TC-12 | Warm-up blocked | GET with `isWarmupBlocked=true` on a mailbox with a `blocked_reason` set | Row shows the reason verbatim next to the warm-up stage |

## 4. Frontend user story

**As a** workspace owner, **I want** the Mailboxes page to be a working list rather than a set of cards I have to read one by one, **so that** the one mailbox that needs me is obvious.

**Scope**
- Mailboxes page: rows showing address and display name, provider, health for send and read separately, today's count against the daily limit ("25 of 50 today"), warm-up stage with reputation, campaign count, and tag chips using each tag's own colour.
- A filter strip above the list — Needs attention, Warming up, Unused, By provider — plus a text box that filters on address, matching the API's partial `username` match. Filters are click-to-clear, in the same style as the Leads page's stage strip.
- Paging: load more on scroll with a hard page size of 100, never an unbounded fetch.
- States: skeleton rows while loading; first-run empty state; filtered-empty state that names the active filter; error banner that keeps the last good list visible.
- Accessibility: the list is a real table with header cells; health is words plus icon, never colour alone; tag chips carry their name as text so colour is decorative. Responsive: rows collapse to stacked cards under 768px with the health line first.

**Definition of done**
- [ ] Every field the list renders comes from one request; no per-row follow-up call.
- [ ] Filters combine and are reflected in the URL so a filtered view can be shared with a teammate.
- [ ] Filtered-empty and first-run-empty are visibly different states.
- [ ] Verified in light and dark, and at 375px width.

## 5. Backend user story

**As a** Harry API, **I want** one filtered, paginated mailbox list endpoint, **so that** the Mailboxes page, the campaign mailbox picker and Monitoring all read the same source of truth.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `GET /api/mailboxes` taking `offset`, `limit` (1–100, default 100), `health`, `warmup`, `inUse`, `provider`, `q`, and `withCampaigns`.
- Data model: no new table. `daily_sent_count` is computed from `messages` for the workspace's local day; warm-up stage comes from the ramp already implemented in `server/pacing.js`; tags come from the mailbox-tag join described in the email-account-tags epic.
- Serialisation excludes every secret column at the query level, not by deleting keys afterwards.
- Pagination is offset-based with a hard cap; the list is not rate-limited beyond the app's standard limiter, and the client is expected to back off on 429 rather than the server queueing.
- Logged: nothing per read. `telemetry` records list latency so Monitoring can show when this page starts to drag on large fleets.

**Definition of done**
- [ ] `limit` above 100 returns 422 with a field-level message, covered by a test.
- [ ] A test asserts no secret column can appear in the response, including on the `withCampaigns` path.
- [ ] Cross-workspace isolation is covered by a test asserting an empty array, not a 403.
- [ ] Campaign ids are only joined when asked for, verified by a query-count test.

## 6. End-to-end test ticket

**Title:** E2E — Find and fix the one broken mailbox

**Preconditions:** A workspace with five mailboxes: three healthy Gmail, one sandbox, one whose token has been revoked; two campaigns using three of them; one mailbox tagged "Winners".

**Flow**
1. Open Mailboxes.
2. Read the list and confirm each row shows health, today's usage against the limit, warm-up stage and tags.
3. Click the "Needs attention" filter.
4. Open the broken mailbox and reconnect it.
5. Clear the filter and click "Unused".
6. Narrow the list by typing part of an address.

**Assertions**
- [ ] The unfiltered list shows all five with correct counts, and the campaign count matches the campaigns actually attached.
- [ ] "Needs attention" leaves exactly the revoked mailbox, showing its specific failure text.
- [ ] After reconnecting, the filter empties and says so, naming the active filter rather than showing the first-run empty state.
- [ ] "Unused" shows only mailboxes attached to no campaign.
- [ ] The text filter matches on part of an address, as the API's partial match does.

**Teardown:** Restore the revoked mailbox's tokens, remove the test tag, reset send counters.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Row gains usage-against-limit, warm-up stage, campaign count and tag chips | Medium | The row already shows health and limit; the additions are one line of text and a chip row, and detail stays on the mailbox page |
| Mailboxes | New filter strip | Medium | Copies the Leads page's click-to-filter strip exactly, so it is a pattern the user has already learned |
| Campaign detail | Mailbox picker reads the same endpoint | Low | Removes a second, divergent query rather than adding one |
| Monitoring | Mailbox health section reads the same list | Low | Existing section, one source instead of two |

**Verdict:** Fits an existing surface

Harry's Mailboxes page already exists and already shows connection and health, so this is that page growing up rather than a new destination. The genuinely new parts are filtering and per-mailbox usage against the daily limit; both reuse patterns the Leads page already established, so nothing new has to be learned. No navigation item is added.
