# Find Emails API

| | |
|---|---|
| **Endpoint** | `POST https://prospect-api.smartlead.ai/api/v1/search-email-leads/search-contacts/find-emails` |
| **Category** | smart-prospect |
| **Source** | https://api.smartlead.ai/api-reference/smart-prospect/find-emails |
| **Auth** | API key (query param `api_key`) |

Given up to ten people's first name, last name and company website, works out their work email address and says whether it looks valid.

## 1. Epic

**Prospect discovery and contact enrichment**

Harry finds new people who match a goal's ideal customer profile and fills in the contact details needed to email them, so a user never has to leave the app to buy a list. It matters because Harry already qualifies, researches and writes to a lead — the one missing piece is where that lead came from in the first place.

## 2. User story

**As a** campaign owner with a list of names and companies but no email addresses, **I want** Harry to find the missing addresses, **so that** leads imported from a conference list or a CRM export can actually be contacted.

**Acceptance criteria**
- [ ] Given a request, when it is built, then `contacts` is a non-empty array of **at most 10** items and each item carries `firstName`, `lastName` and `companyDomain` — all three are documented as required, so a lead missing any of them is not eligible and Harry says which field is missing.
- [ ] Given more than ten leads are selected, when the job runs, then Harry splits them into batches of ten and reports progress; it never sends an eleventh contact in one request.
- [ ] Given a successful response, when it is read, then `data` is an array of `{ firstName, lastName, companyDomain, email_id, status, verification_status }` — note the address field is `email_id`, not `email`, unlike the fetch-contacts and get-contacts payloads.
- [ ] Given a contact was not found, when the row is read, then `status` is `"Not Found"`, `email_id` is an empty string and `verification_status` is `null` — Harry must show "not found" rather than writing an empty address onto the lead.
- [ ] Given a contact was found, when the row is read, then `status` is `"Found"` and `verification_status` carries a value such as `"Valid"`, which is stored on the lead and shown before anyone approves an email to that address.
- [ ] Given the account is out of credit, when the request runs, then the documented **402 Payment Required** is returned and Harry shows "You are out of email-finding credits" with no partial writes.
- [ ] Given the API key is missing or wrong, when the request runs, then 401 is returned in this endpoint's own shape — `{"success": false, "message": "User not authenticated", "data": null}`, which differs from the `statusCode`-carrying 401 used elsewhere in this category, so the error parser must handle both.
- [ ] Given any address is found, when it is written to a lead, then the write is a fill-in — an address the user already entered is never overwritten without being shown the difference.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"contacts": [{"firstName": "John", "lastName": "Doe", "companyDomain": "example.com"}]}` | 200, `data[0].status` is `"Found"`, `email_id` is a real address, `verification_status` is `"Valid"` |
| TC-2 | Missing/invalid API key | Same body with no `api_key` | 401 in this endpoint's shape `{"success": false, "message": "User not authenticated", "data": null}`; parser handles it and shows one connection banner |
| TC-3 | Not found / wrong workspace | Run against leads belonging to another workspace | Route returns 404 before any provider call; nothing is sent upstream |
| TC-4 | Validation failure — missing field | POST a contact with no `companyDomain` | 400; Harry blocks it client-side, marks the lead "cannot look up — no company website" and excludes it from the batch |
| TC-5 | Rate limited | Submit 40 leads at once | Batches of 10 are issued serially; on 429 the job backs off with jitter and resumes, showing "Waiting…" not an error |
| TC-6 | Empty result set | Submit a contact the provider cannot resolve | 200 with `status: "Not Found"`, `email_id: ""`, `verification_status: null`; the lead keeps no address and is shown in a "not found" group |
| TC-7 | Over the batch limit | POST 11 contacts in one request | 400 from the provider; Harry's own route rejects it first with a message naming the documented maximum of 10 |
| TC-8 | Out of credit | Force the provider to return 402 | "You are out of email-finding credits"; no lead is modified and the job stops rather than continuing through the remaining batches |
| TC-9 | Mixed batch | Submit 10 where 6 are found and 4 are not | The summary states 6 found, 4 not found; only the 6 write an address |
| TC-10 | Overwrite protection | Look up a lead that already has a manually entered address | Harry shows both addresses and asks which to keep; nothing is overwritten silently |
| TC-11 | Verification status carried through | Find an address whose `verification_status` is not `"Valid"` | The lead shows the status beside the address, and the approval card in Inbox → Needs your OK shows it too |
| TC-12 | Upstream 500 mid-job | Force a 500 on the third batch | The first two batches' results are kept, the job reports where it stopped, and "Resume" continues from that batch |

## 4. Frontend user story

**As a** campaign owner, **I want** a "Find missing emails" action on the Leads page, **so that** leads without an address stop being dead weight in my list.

**Scope**
- Leads: a bulk action on selected rows, plus a single-lead action on lead detail. The action is disabled with an explanation for leads lacking a first name, last name or company website, because all three are required by the API.
- A progress panel while the job runs: "batch 3 of 7", with the count found and not found so far. Because batches are ten at a time, progress is real, not a spinner.
- A result summary grouping leads into found, not found, and skipped (missing fields), each with a count and a way to act on the whole group.
- Address confirmation: every found address renders with its `verification_status` beside it. A lead that already has an address shows old and new side by side with an explicit choice.
- Error states: 402 shows a credit message and stops the job; 401 shows the connection banner; a mid-job failure keeps completed batches and offers "Resume".
- Accessibility: progress announced in a live region; groups are labelled lists with counts as text; the old-versus-new comparison is a labelled pair, not colour-coded. Responsive: the progress panel is a sticky footer bar under 640px.

**Definition of done**
- [ ] Bulk and single-lead lookups both work, batched to ten per request.
- [ ] Leads missing any required field are visibly skipped with the reason, never silently.
- [ ] `verification_status` is shown wherever a found address is shown, including the approval card.
- [ ] Existing addresses are never overwritten without a shown comparison.
- [ ] Progress, empty, error, out-of-credit and resume states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a batching email-finder route that respects the ten-contact ceiling and writes results safely, **so that** a long list is processed reliably without corrupting lead data.

**Scope**
- Route in `server/routes.js`: `POST /api/leads/find-emails` taking `{ leadIds: [] }`, resolving each lead's first name, last name and company domain, rejecting ineligible leads with a per-lead reason, then issuing batches of at most 10 to the provider.
- Long jobs run as a server-side job with a status endpoint (`GET /api/leads/find-emails/:jobId`), so a browser refresh does not lose progress.
- Response mapping: `email_id` maps to Harry's lead email field, `status` and `verification_status` are stored alongside it. `status: "Not Found"` with an empty `email_id` must never be written as an address — an explicit branch with a test.
- Error parsing: this endpoint's 401 body differs from the rest of the category, so the shared provider error parser handles both `{ statusCode, success, message, error }` and `{ success, message, data }`. A 402 is mapped to a distinct "out of credit" error that halts the job.
- Data model: `leads` gains `email_verification_status` and `email_source` columns in `server/db.js`, so the Inbox approval card can show where an address came from and how confident the provider was.
- Rate limiting and retry: batches serialised per workspace; 429 and 5xx retried with bounded exponential backoff and jitter; 402 never retried.
- Logged: an `events` row per job naming who ran it, how many leads were looked up, and how many addresses were found; `telemetry` per batch with latency, status and the found/not-found split so Monitoring can chart the hit rate.

**Definition of done**
- [ ] Batching at ten enforced server-side, covered by a test with 25 leads.
- [ ] "Not Found" rows provably never write an address.
- [ ] Both documented 401 shapes and the 402 are parsed and mapped correctly, covered by tests.
- [ ] Job survives a browser refresh and can be resumed after an upstream failure.
- [ ] Verification status is stored and surfaced on the lead and in the approval card.

## 6. End-to-end test ticket

**Title:** E2E — Find missing email addresses for imported leads

**Preconditions:** A stubbed provider serving the documented find-emails payload, a workspace with 25 leads — 20 complete, 3 missing a company website, 2 already holding a manually entered address — and a stub mode that returns 402 on demand.

**Flow**
1. Import the leads via the existing CSV import.
2. On Leads, select all and choose "Find missing emails".
3. Watch the progress panel through the batches.
4. Review the found / not found / skipped groups.
5. Resolve the two conflicting addresses.
6. Re-run with the stub set to 402.

**Assertions**
- [ ] Exactly three batches are issued for 20 eligible leads (10, 10, then the remainder after skips), visible in progress.
- [ ] The three leads missing a company website appear under "skipped" with that reason and were never sent upstream.
- [ ] Leads returned as "Not Found" keep no address and are listed in their own group.
- [ ] Each found address shows its verification status on the lead row and on the Inbox approval card for that lead.
- [ ] The two conflicting leads present old and new addresses and change only after an explicit choice.
- [ ] The 402 run shows "out of email-finding credits", modifies no lead, and stops rather than continuing.
- [ ] The activity trail has one entry for the job with the counts.

**Teardown:** Delete the imported leads; clear the job records.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | A bulk "Find missing emails" action, a progress panel and a result grouping | Medium | Joins the existing bulk-action menu rather than adding a toolbar; the progress panel is transient and the grouping collapses to one summary line once reviewed |
| Lead detail | Verification status beside the address, plus a single-lead lookup | Low | One line of text and one menu item |
| Inbox → Needs your OK | Verification status shown on the approval card | Low | One line; it is exactly the moment a human should see that an address is unverified |
| Monitoring | Email-find hit rate and provider latency | Low | Rows in existing telemetry tables |

**Verdict:** Fits an existing surface

Harry already imports leads and already asks a human to approve every send, so finding a missing address is a step between those two rather than a new place in the product. Putting the verification status on the approval card is the honest move: the person pressing send is the one who should know the address was guessed.
