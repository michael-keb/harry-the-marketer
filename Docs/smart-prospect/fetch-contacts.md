# Fetch Contacts API

| | |
|---|---|
| **Endpoint** | `POST https://prospect-api.smartlead.ai/api/v1/search-email-leads/fetch-contacts` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/fetch-contacts |
| **Auth** | API key (query param `api_key`) |

Spends credits to pull real email addresses for the people a saved search matched, either for a set number of them or for specific individuals you picked.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner who has previewed a prospect search, **I want** to fetch the email addresses for a chosen number of those people, **so that** they become real leads I can attach to a campaign — and I want to know what it cost before I press the button.

**Acceptance criteria**
- [ ] Given a saved search, when I fetch, then the request carries the required `filter_id` plus **either** `id` (an array of adapt IDs) **or** `limit` — the documented rule is that `filter_id` is always required and one of the other two must accompany it.
- [ ] Given I fetch by `limit`, when the value is outside 1–10000 (the docs note some accounts allow up to 30000), then Harry rejects it before calling and explains the range.
- [ ] Given I fetch by `id`, when the request runs, then no limit or credit check is applied by the provider — so Harry must still show the user how many contacts they selected and confirm before sending.
- [ ] Given a credit or limit check fails, when the request runs, then the provider returns **HTTP 200 with `success: false`** and a message — Harry must treat a 200 with `success: false` as a failure and surface the message, never as a successful empty fetch. This is the single most important behaviour in this endpoint.
- [ ] Given a successful fetch, when the response arrives, then `data.list` holds contacts shaped `{ id, firstName, lastName, fullName, title, company: { name, website }, email, status }`, and `data.metrics` reports `totalContacts`, `totalEmails`, `noEmailFound`, `invalidEmails`, `catchAllEmails`, `verifiedEmails` and `completed`.
- [ ] Given the response's `visual_limit` and `visual_offset` (defaults 10 and 0, `visual_limit` capped at 1000), when the results are shown, then paging through them does not re-fetch or re-charge — visual pagination is a view over what was already fetched.
- [ ] Given contacts are fetched, when they are turned into Harry leads, then anyone whose `email` is empty or whose status is not usable is not created as a lead, and the count of skipped contacts is shown.
- [ ] Given the API key is missing or wrong, when the request runs, then 401 with `{"message": "Unauthorized", "error": "User not authenticated"}` and nothing is charged or created.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path by limit | POST `{"filter_id": 327105, "limit": 10, "visual_limit": 10, "visual_offset": 0}` | 200, `success: true`, `data.list` populated, `data.metrics.totalEmails` consistent with the list, `data.total_count` present |
| TC-2 | Missing/invalid API key | Same body with no `api_key` | 401, `"error": "User not authenticated"`; no credits spent, no leads created |
| TC-3 | Not found / wrong workspace | POST with a `filter_id` belonging to another account | Error surfaced as "That saved search is not available"; Harry returns the user to the search list |
| TC-4 | Validation failure — neither id nor limit | POST `{"filter_id": 327105}` alone | 400; Harry blocks this client-side with a field-level message saying to choose a count or pick specific people |
| TC-5 | Rate limited | Fire several large fetches back to back | 429 on the excess; Harry queues fetches one at a time per workspace and shows "Waiting to fetch…" rather than erroring |
| TC-6 | Empty result set | Fetch a filter that matches nobody | 200 with an empty `data.list` and zeroed metrics; the UI shows "This search found nobody to fetch" and no leads are created |
| TC-7 | **200 with `success: false`** | Fetch with a `limit` beyond the account's credit balance | HTTP 200 but `success: false` with a message; Harry shows that message as a failure, spends nothing, creates no leads, and the button returns to its ready state |
| TC-8 | Fetch by explicit ids | POST `{"filter_id": 327105, "id": ["5f22b0c8cff47e0001616f81"]}` | 200; only that contact is returned; no limit check applies, but Harry still showed a confirmation naming the count |
| TC-9 | Limit out of range | POST `limit: 20000` on an account capped at 10000 | Rejected; Harry validates against the account's known cap and explains the range instead of letting the provider fail |
| TC-10 | Contacts with no email | Fetch a batch where `metrics.noEmailFound` is greater than zero | Those rows are shown as "no email found" and excluded from lead creation; the skipped count is stated |
| TC-11 | Visual pagination | Fetch once, then page with `visual_offset: 10` | The next page renders from the same fetch; no second charge and no second confirmation |
| TC-12 | Interrupted fetch | Kill the connection mid-fetch and retry with the same parameters | Harry keys the request so a retry cannot double-charge, and the UI states whether the first attempt completed |

## 4. Frontend user story

**As a** goal owner, **I want** a fetch step that tells me exactly how many contacts I am about to pull and what happened afterwards, **so that** spending credits never feels like a surprise.

**Scope**
- Leads → "Find prospects" → results view: a "Get email addresses" action with a confirmation dialog stating the count, the source search, and that this uses provider credits. Nothing is fetched until the user confirms — the same shape of consent as Harry's standing "nothing sends without your OK" rule.
- Two fetch modes in one dialog: "the top N matches" (sends `limit`) and "the people I ticked" (sends `id`), with the tick boxes living on the results table.
- After the fetch, a results summary panel renders the provider's own `metrics`: contacts, emails found, no email found, invalid, catch-all, verified. These are shown as plain-English rows, not raw keys.
- A second confirmation converts fetched contacts into Harry leads, showing how many will be created and how many are skipped for having no usable email.
- State: in-flight fetch shows progress and disables the action; a 200 with `success: false` renders as an error panel carrying the provider's message; partial results are kept and viewable.
- Visual pagination over the fetched set uses `visual_limit`/`visual_offset` and is clearly labelled as browsing what was already fetched.
- Accessibility: the confirmation dialog is a labelled modal with focus trap and Escape; counts are text; the metrics panel is a definition list. Responsive: the metrics panel stacks under 640px.

**Definition of done**
- [ ] No fetch happens without an explicit confirmation that names the count.
- [ ] A 200 with `success: false` renders as a failure with the provider's message, verified by test.
- [ ] The metrics panel shows all seven documented metric fields in plain English.
- [ ] Lead creation is a separate, counted step and reports skipped contacts.
- [ ] Loading, empty, partial and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a fetch route that is idempotent, credit-aware and honest about `success: false`, **so that** a retry or a double click can never charge twice or create duplicate leads.

**Scope**
- Route in `server/routes.js`: `POST /api/prospects/searches/:filterId/fetch` taking `{ mode: 'count' | 'selected', count?, adaptIds?, visualLimit?, visualOffset? }` and mapping to the provider's `filter_id` plus `limit` or `id`.
- Request validation before the upstream call: `filter_id` positive, exactly one of `count` or `adaptIds`, `count` within 1–10000 (configurable to 30000 per account), `adaptIds` non-empty, `visualLimit` 1–1000, `visualOffset` at least 0.
- Response handling: a 200 whose body has `success: false` is mapped to an application error carrying the provider's `message`. This is written as an explicit branch with a test, because the naive `res.ok` check is wrong for this endpoint.
- Idempotency: each fetch is keyed by `(workspace, filterId, mode, payload hash)` with a short window, so a retried request returns the first result rather than charging again.
- Data model: a `prospect_fetches` table (`id`, `workspace_id`, `filter_id`, `mode`, `requested`, `metrics_json`, `created_at`) so the fetch and its metrics can be shown later without re-calling; leads created from a fetch carry the fetch id for traceability. Lead creation reuses the existing CSV-import dedupe path so an existing lead is updated, not duplicated.
- Pagination: `visual_limit`/`visual_offset` are passed through for browsing the fetched set; Harry never re-issues a fetch to page.
- Rate limiting and retry: fetches are serialised per workspace; on 429 or 5xx retry with bounded exponential backoff and jitter, but never retry a request that already returned `success: false`.
- Logged: an `events` row per fetch naming who fetched, from which search, how many were requested and how many became leads; `telemetry` per upstream call with latency, status and the returned metrics so Monitoring can chart email-found rates.

**Definition of done**
- [ ] Route added and workspace-scoped; provider key never reaches the browser.
- [ ] The `200 + success: false` branch is covered by a test that asserts no leads are created.
- [ ] Idempotency key prevents a double fetch, covered by a test firing the same request twice.
- [ ] Fetched contacts flow through the existing dedupe path; a re-fetch updates rather than duplicates.
- [ ] Every fetch appears in the activity trail with counts.

## 6. End-to-end test ticket

**Title:** E2E — Fetch email addresses for a saved prospect search and turn them into leads

**Preconditions:** A stubbed provider serving the documented fetch payload, one saved search with a known `filter_id`, a workspace containing one lead that will collide with a fetched contact, and a stub mode that returns `200` with `success: false` on demand.

**Flow**
1. Open Leads → "Find prospects" and load the saved search's results.
2. Click "Get email addresses" and choose "the top 10 matches".
3. Read the confirmation dialog, then confirm.
4. Review the metrics panel.
5. Convert the fetched contacts into leads.
6. Repeat the fetch with the stub set to return `success: false`.

**Assertions**
- [ ] The confirmation names the count and says credits will be used; cancelling fetches nothing.
- [ ] The metrics panel shows emails found, no email found, invalid, catch-all and verified, matching the stub's `metrics`.
- [ ] Contacts without an email are listed but not created as leads, and the skipped count is stated.
- [ ] The colliding contact updates the existing lead instead of creating a second one.
- [ ] The activity trail has one entry naming the fetch, the search and the counts.
- [ ] The `success: false` run shows the provider's message as an error, creates no leads and leaves the button ready to try again.

**Teardown:** Delete leads created by the test fetch; clear the `prospect_fetches` rows for the workspace.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects results | "Get email addresses" action, confirmation dialog and a metrics panel | High | The results view is one table with one primary action; metrics appear only after a fetch and collapse to a single summary line once read |
| Leads list | Fetched contacts arrive as leads with a source marker | Low | Reuses the existing CSV-import arrival path and dedupe, so nothing new is learned |
| Dashboard activity trail | One entry per fetch | Low | Existing trail |
| Monitoring | Email-found rate and provider latency | Low | Extra rows in the existing telemetry tables |

**Verdict:** Fits an existing surface

This is the step where prospecting costs money, so it needs a confirmation and an honest receipt — but both belong on the prospect results view Harry already needs, not on a page of their own. The pattern is the one the product already teaches: the agent prepares, the human approves, then it happens.
