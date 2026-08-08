# Get Email Account by ID

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/email-accounts/{id}/` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/get-by-id |
| **Auth** | API key (query param `api_key`) |

Returns everything known about one mailbox: its settings, connection health, full warm-up detail, and optionally the campaigns using it.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner, **I want** a single page per mailbox showing its settings, health and warm-up detail together with the campaigns depending on it, **so that** I can judge whether to change it before I change it.

**Acceptance criteria**
- [ ] Given a mailbox I own, when I open its detail, then I see the same fields as the list plus the extended warm-up object: `status` (`ACTIVE`, `INACTIVE`, `PAUSED`), `warmup_min_count`, `warmup_max_count`, `reply_rate`, `total_sent_count`, `total_spam_count`, `warmup_reputation` (0-100), `is_warmup_blocked` and `blocked_reason`.
- [ ] Given the mailbox is used by campaigns, when I request the equivalent of `fetch_campaigns=true`, then the campaigns using it are named and linked — the point of this call before an edit or a delete.
- [ ] Given a mailbox id from another workspace, when I request it, then the response is 404 `{"error": "Email account not found"}` and the id is not confirmed to exist.
- [ ] Given today's sending, when the detail renders, then `daily_sent_count` is shown against `message_per_day` so remaining allowance is arithmetic the user does not have to do.
- [ ] Given warm-up is blocked, when the detail renders, then `blocked_reason` is displayed verbatim and the page says what sending is still allowed.
- [ ] Given the response is serialised, when it leaves the server, then no password, app password or token is included — SmartLead returns a decoded plaintext password on this endpoint and Harry must never do that.
- [ ] Given a spam rate worth worrying about, when `total_spam_count` is non-trivial against `total_sent_count`, then the page states the ratio in plain words rather than leaving the user to compare two numbers.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET a mailbox with warm-up running | 200 with `from_email`, `is_smtp_success: true`, `daily_sent_count: 25`, `message_per_day: 50` and a `warmup_details` object including `warmup_reputation: 95` |
| TC-2 | Missing/invalid API key | GET with no session cookie | 401, `{"message": "Invalid API Key"}`; redirect to sign-in |
| TC-3 | Not found / wrong workspace | GET an id owned by another workspace | 404, `{"error": "Email account not found"}`; UI shows "That mailbox is not available" and returns to Mailboxes |
| TC-4 | Validation failure | GET with a non-numeric id | 422 with a field-level message; no lookup performed |
| TC-5 | Rate limited | Poll the detail every 200ms | 429 on the excess; client backs off with jitter and keeps the last good detail on screen |
| TC-6 | Empty result set | GET with `fetch_campaigns=true` on a mailbox attached to nothing | 200 with an empty campaign list and a "Not used by any campaign yet" empty state, not a blank panel |
| TC-7 | Warm-up never started | GET a sandbox mailbox | 200 with `warmup_details` null or `INACTIVE`; the panel says warm-up does not apply to sandbox mailboxes rather than showing zeros |
| TC-8 | Warm-up blocked | GET a mailbox with `is_warmup_blocked: true` and a `blocked_reason` | Reason shown verbatim; the page still states the campaign-sending allowance |
| TC-9 | Secrets excluded | Inspect the full response body | No `password`, `imap_password`, access token or refresh token in any form |
| TC-10 | Deleted mailbox | GET an id that was soft-deleted | 404, treated by the UI as "already removed" rather than an error banner |
| TC-11 | Campaign opt-in | GET with and without `fetch_campaigns` | Campaign ids present only in the second; the panel loads lazily so the first render is not blocked |

## 4. Frontend user story

**As a** workspace owner, **I want** a mailbox detail view that answers "is this mailbox healthy and who depends on it", **so that** I can act without opening three other pages.

**Scope**
- Mailboxes page: clicking a row opens a detail panel (a side sheet, not a new route) with three sections — Sending (address, display name, provider, daily limit, used today, remaining), Health (send and read status with the specific failure text when broken), and Warm-up (stage, min and max per day, reputation, spam count, blocked reason).
- A "Used by" section lists the campaigns depending on this mailbox, loaded on demand, each linking to its campaign detail page.
- States: skeleton per section; empty for "no campaigns yet"; error banner per section so a failed campaign fetch does not blank the health section.
- Warm-up numbers are explained in words next to the figures: "Sending 18 a day, rising to 50 by 14 March".
- Accessibility: the side sheet is a labelled dialog with focus trap and Escape; all health and warm-up state is text; reputation is a number with a label, not a bare colour bar. Responsive: the side sheet becomes a full-screen sheet under 768px.

**Definition of done**
- [ ] All three sections render from one request, with campaigns as a second, optional request.
- [ ] Every warm-up figure has a plain-English sentence beside it.
- [ ] A blocked warm-up shows its reason without the user having to hover anything.
- [ ] Verified in light and dark and at 375px.

## 5. Backend user story

**As a** Harry API, **I want** a single mailbox detail route, **so that** the UI and Monitoring both read one consistent picture of a mailbox.

**Scope**
- Route in `server/routes.js` mirroring the existing workspace-scoped pattern: `GET /api/mailboxes/:id` with an optional `withCampaigns` flag, returning 404 for anything outside the caller's workspace.
- Data model: no new table. Warm-up figures are derived from the ramp in `server/pacing.js` (start of 10 a day climbing to the mailbox limit over a fortnight) plus counts from `messages`; there is no external warm-up pool, so `warmup_reputation` and `total_spam_count` map to Harry's own bounce and complaint telemetry rather than to a third-party warm-up network.
- Serialisation excludes secrets at the query level. The `fetch_campaigns` equivalent joins the campaign-mailbox link only when asked.
- No pagination. The standard app rate limiter applies; the client backs off on 429.
- Logged: nothing per read; `telemetry` records the mailbox's last successful send and last failure so the health section has evidence rather than a boolean.

**Definition of done**
- [ ] Cross-workspace requests return 404 with no existence leak, covered by a test.
- [ ] A test asserts the response contains no secret in any encoding.
- [ ] Warm-up figures are computed, not stored, so they cannot drift from what the pacing code actually does.
- [ ] Campaign join happens only under the flag, verified by a query-count test.

## 6. End-to-end test ticket

**Title:** E2E — Inspect a mailbox before changing it

**Preconditions:** A workspace with one Gmail mailbox connected six days ago (mid-ramp), attached to two campaigns, with 25 emails sent today against a 50/day limit and one recorded bounce.

**Flow**
1. Open Mailboxes and click the mailbox row.
2. Read the Sending section.
3. Read the Health section.
4. Expand "Used by".
5. Follow one campaign link, return, and close the sheet.
6. Revoke the mailbox's token externally, reopen the sheet.

**Assertions**
- [ ] Sending shows 25 of 50 used today and the remaining allowance without the user calculating it.
- [ ] Warm-up shows the current daily figure, the ceiling, and the date it reaches the full limit, in a sentence.
- [ ] "Used by" lists both campaigns and links to them; a mailbox attached to none shows the empty state instead.
- [ ] After revocation the Health section names the specific failure and offers Reconnect.
- [ ] No secret appears anywhere in the sheet or in the network response.

**Teardown:** Restore the mailbox's tokens, reset the day's send counter.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | New per-mailbox detail side sheet | Medium | A sheet rather than a route, so the list stays the destination and nothing new appears in navigation |
| Mailboxes | Row becomes clickable | Low | The affordance already reads as a list row |
| Campaign detail | Links back from the mailbox's "Used by" | Low | Existing pages, reciprocal links only |
| Monitoring | Per-mailbox delivery telemetry links into the sheet | Low | Existing section gains a link, not a panel |

**Verdict:** Fits an existing surface

Harry's Mailboxes page shows health today but has nowhere to put detail, so the detail sheet is the missing half of a surface that already exists. The genuinely new content is the warm-up breakdown and the "Used by" list; both are read-only and only appear when the user asks for one mailbox. No navigation item is added.
