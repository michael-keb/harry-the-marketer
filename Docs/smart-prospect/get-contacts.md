# Get Contacts API

| | |
|---|---|
| **Endpoint** | `POST https://prospect-api.smartlead.ai/api/v1/search-email-leads/get-contacts` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/get-contacts |
| **Auth** | API key (query param `api_key`) |

Reads back contacts you have already fetched, either everyone from one saved search or a specific list of people, with filters for how good their email address is.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** goal owner reviewing a list I already paid for, **I want** to browse and filter those contacts by how trustworthy their email address is, **so that** only addresses worth sending to become leads attached to a campaign.

**Acceptance criteria**
- [ ] Given a request, when it is built, then it carries **either** `id` (an array of adapt IDs, at most 200) **or** `filter_id` — never both. The documented rule is an exclusive choice, so Harry's route rejects a body containing both with a field-level message.
- [ ] Given `filter_id` is used, when I refine the list, then `limit` (1–1000), `offset` (0 or more), `search`, `verification_status` and `catch_all_status` may accompany it; when `id` is used, those refinements do not apply and the UI hides them.
- [ ] Given `search` is supplied, when the list returns, then it has filtered on `first_name`, `last_name` or `full_name` — not on company or title, so the search box must be labelled "Search by name".
- [ ] Given `verification_status` is supplied, when the list returns, then it accepts only `valid`, `catch_all` or `invalid`, and the UI offers exactly those three.
- [ ] Given `catch_all_status` is supplied, when the list returns, then it accepts only `catch_all_verified`, `catch_all_soft_bounced`, `catch_all_hard_bounced`, `catch_all_unknown` or `catch_all_bounced`, and these are shown in plain English rather than raw values.
- [ ] Given a successful response, when it is read, then `data.list` holds contacts shaped `{ id, firstName, lastName, fullName, title, company: { name, website }, email, verificationStatus, status }`, and `data.pagination` carries `filterId`, `limit`, `offset`, `total` and `hasMore`, with `data.totalCount` alongside.
- [ ] Given `hasMore` is `false`, when the list is paged, then the "load more" control disappears — this endpoint gives an explicit `hasMore`, so the client must use it rather than guessing from the page being full.
- [ ] Given the API key is missing or wrong, when the request runs, then 401 with `{"statusCode": 401, "success": false, "message": "Unauthorized"}` and no rows are shown.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path by filter | POST `{"filter_id": 327105, "limit": 50, "offset": 0}` | 200, `data.list` populated, `data.pagination.hasMore` true when `total` exceeds `limit`, `data.totalCount` present |
| TC-2 | Missing/invalid API key | Same body with no `api_key` | 401, `"error": "User not authenticated"`; one connection banner, no rows |
| TC-3 | Not found / wrong workspace | POST a `filter_id` from another account | Error surfaced as "That saved search is not available"; the user is returned to the search list |
| TC-4 | Validation failure — both keys | POST `{"id": ["abc"], "filter_id": 327105}` | Rejected; the documented rule is exclusive-or, and Harry's route returns a 422 naming both fields |
| TC-5 | Rate limited | Page rapidly through a large list | 429 on the excess; the client backs off with jitter and shows one "Loading…" state, keeping rows already loaded |
| TC-6 | Empty result set | POST a `filter_id` with `search=zzzzz` | 200 with `data.list: []`, `pagination.hasMore` false; "No contacts match that name" with a clear-search action |
| TC-7 | Verification filter | POST `verification_status: "valid"` then `"invalid"` | Each returns only contacts whose `verificationStatus` matches; the counts differ and the summary line states which filter is on |
| TC-8 | Catch-all filter | POST `catch_all_status: "catch_all_hard_bounced"` | Only those contacts return; the UI labels it "catch-all, previously hard bounced" rather than showing the raw value |
| TC-9 | Id list at the ceiling | POST `id` with 200 entries, then 201 | 200 for the first; the second is rejected by Harry's route with a message naming the documented maximum of 200 |
| TC-10 | Limit ceiling | POST `limit: 1001` | Rejected against the documented 1–1000 range before the upstream call |
| TC-11 | `hasMore` respected | Page until `hasMore` is false | "Load more" disappears exactly then; no extra request is made to discover the end |
| TC-12 | Refinements with an id list | Select the "specific people" mode | `limit`, `offset`, `search` and the status filters are hidden, because they are documented only for `filter_id` |
| TC-13 | Upstream 500 | Force a provider 500 | Rows already loaded stay on screen and "Could not load more just now" appears |

## 4. Frontend user story

**As a** goal owner, **I want** to review a fetched contact list with quality filters before anything becomes a lead, **so that** invalid and risky addresses never reach a campaign.

**Scope**
- Leads → "Find prospects" → History → open a fetched search: a contacts table with columns for name, title, company (name and website from the `company` object), email and verification status.
- Above the table: a "Search by name" box (mapped to `search`, and labelled honestly because that is all it searches), a verification filter with exactly the three documented values, and an "Email risk" filter offering the five catch-all values in plain English.
- Selection and a primary action "Add selected to Leads", with a default selection of verified addresses only and a visible note saying so, since the risky ones are the ones a user should choose deliberately.
- Paging driven by `pagination.hasMore` and `total`; a footer reads "Showing 50 of 100".
- State: loading is skeleton rows; empty is filter-aware ("No contacts match that name" versus "This search has no contacts yet"); error keeps loaded rows.
- Accessibility: a real table with header scopes, filters as labelled selects, verification status as text plus an icon rather than colour alone, and selection count announced in a live region. Responsive: the table becomes stacked cards under 640px with name and status leading.

**Definition of done**
- [ ] The table renders every documented contact field, including the nested company name and website.
- [ ] All three verification values and all five catch-all values are offered and shown in plain English.
- [ ] Paging uses `hasMore` and stops exactly at the end.
- [ ] The default selection is verified-only and the reason is visible.
- [ ] Loading, filtered-empty, unfiltered-empty and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a proxied contacts route that enforces the exclusive choice between `id` and `filter_id`, **so that** an ambiguous request can never reach the provider.

**Scope**
- Route in `server/routes.js`: `POST /api/prospects/contacts` taking `{ filterId? , adaptIds?, limit, offset, search, verificationStatus, catchAllStatus }`, returning `{ items, pagination, totalCount }` with field names normalised for the web app.
- Validation before the upstream call: exactly one of `filterId` and `adaptIds` (422 naming both when both or neither are present), `adaptIds` at most 200, `limit` 1–1000, `offset` at least 0, `verificationStatus` restricted to the three documented values and `catchAllStatus` to the five, each rejected with the allowed list in the message.
- Enrichment before returning: each contact is checked against the workspace `leads` table so the table can mark rows already imported, avoiding duplicate leads.
- Adding to Leads reuses the existing CSV-import dedupe path, carrying `verificationStatus` into the lead's `email_verification_status` column so the Inbox approval card can show it.
- Pagination is passed through; `hasMore` from the provider is returned untouched rather than recomputed.
- Rate limiting and retry: 429 and 5xx retried with bounded exponential backoff and jitter; results cached briefly per `(filterId, filters, limit, offset)` so paging back and forth does not re-call.
- Logged: an `events` row when contacts are added to Leads, naming who, how many and from which search; `telemetry` per upstream call with latency and status. Reading the list alone writes no `events` row.

**Definition of done**
- [ ] Route added, workspace-scoped, provider key server-side only.
- [ ] The exclusive-or rule and every enumerated value are enforced with tests.
- [ ] `alreadyInLeads` marking is computed server-side and covered by a test.
- [ ] Adding to Leads carries verification status through to the lead record.

## 6. End-to-end test ticket

**Title:** E2E — Review fetched contacts and add only the good addresses to Leads

**Preconditions:** A stubbed provider serving the documented get-contacts payload with 100 contacts across all three verification statuses and several catch-all states, one fetched search in history, and a workspace containing one lead that collides with a contact.

**Flow**
1. Open Leads → "Find prospects" → History and open the fetched search.
2. Read the footer count and page once.
3. Filter by verification status "invalid" and note the count.
4. Clear it, then filter by "Email risk" hard-bounced.
5. Clear filters, search a surname.
6. Accept the default verified-only selection and add to Leads.

**Assertions**
- [ ] The footer reads "Showing 50 of 100" and "Load more" disappears exactly when `hasMore` becomes false.
- [ ] Each filter changes the row count and the summary line names the active filter.
- [ ] The name search matches on surname; searching a company name returns nothing, matching the documented behaviour and the field's label.
- [ ] The colliding contact is marked "already in your leads" and updates that lead rather than creating a second one.
- [ ] Created leads carry their verification status, visible on the lead row and on the Inbox approval card.
- [ ] The activity trail records how many contacts were added and from which search.

**Teardown:** Delete the leads created by the test; clear the contacts cache.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → Find prospects → History | A contacts table with name search and two quality filters | Medium | It replaces the "view the leads this created" jump for un-imported contacts; two filters only, both with fixed value lists, so there is no filter builder |
| Leads list | "Already in your leads" markers and imported leads carrying verification status | Low | Reuses the CSV-import arrival path |
| Inbox → Needs your OK | Verification status on the approval card | Low | One line of text at the moment it matters |

**Verdict:** Fits an existing surface

This is the review step between paying for contacts and emailing them, so it sits inside the fetch history where the contacts already live. The two quality filters are worth their space because sending to an invalid address is the fastest way to damage a mailbox's reputation, which Harry's whole sending rhythm exists to protect.
