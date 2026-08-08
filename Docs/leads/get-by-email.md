# Get Lead by Email

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/leads/` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/get-by-email |
| **Auth** | API key (query param `api_key`) |

Looks up one person by their email address and returns their details plus every campaign they are enrolled in.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** to type an email address and get everything Harry knows about that person, **so that** when someone asks "are we already talking to this person?" I can answer in seconds.

**Acceptance criteria**
- [ ] Given an email address, when I look it up, then I get the person's id, name, phone, company name, website, location, LinkedIn profile, company URL, custom fields, unsubscribed flag and when they were created.
- [ ] Given the person is in campaigns, when the result renders, then every enrolment is listed with the campaign name, the campaign-lead mapping identifier and the label applied in that campaign.
- [ ] Given no such person exists, when I look up the address, then the result is an explicit "not found" rather than an error, and the UI offers to add them as a new lead.
- [ ] Given an address that differs only by case or surrounding whitespace, when I look it up, then the same person is found, because matching is case-insensitive and trimmed.
- [ ] Given the person has unsubscribed, when the result renders, then the unsubscribed state is the first thing shown, above the campaign list, so nobody starts composing to them.
- [ ] Given no email is supplied, when the lookup runs, then it fails validation naming the email parameter rather than returning everyone.
- [ ] Given the person exists in another workspace, when I look them up, then they are not found here — the lookup never crosses workspace boundaries.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Look up an address enrolled in one campaign | 200 with the full person record and one enrolment carrying the campaign name and the label |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the search box shows a sign-in prompt rather than "not found" |
| TC-3 | Not found / wrong workspace | Look up an address that exists only in another workspace | 200 with an empty result; the UI says not found and offers to add them |
| TC-4 | Validation failure | Look up with no email parameter | 422 with a message that email is required, shown under the search box |
| TC-5 | Rate limited | Type into the search box without debouncing | 429 after the burst; the client debounces to one request per pause and the box never shows a raw error |
| TC-6 | Empty result set | Look up an address never imported | 200 with an empty result and an "Add this person" action prefilled with the address |
| TC-7 | Case and whitespace | Look up ` John@Example.com ` for a stored `john@example.com` | The stored person is returned |
| TC-8 | Multiple enrolments | Look up someone in three campaigns | All three enrolments are listed, each with its own label |
| TC-9 | Unsubscribed person | Look up an unsubscribed address | The unsubscribed state is returned and the UI shows it above everything else |
| TC-10 | Plus-addressing | Look up `john+harry@example.com` when `john@example.com` is stored | Treated as a different address; the result says not found, and the UI notes the near match rather than guessing |
| TC-11 | Malformed address | Look up `not-an-email` | 422 with a format message; no lookup is performed |

## 4. Frontend user story

**As a** campaign owner, **I want** one search box that finds a person by email from anywhere in the product, **so that** checking whether we already know someone is never a five-click job.

**Scope**
- Leads: the existing list gains a search box that accepts an email address (or part of a name) and jumps straight to the lead detail on an exact email match.
- Leads → lead detail: a "Campaigns" block listing every enrolment with its campaign name, the current stage in that campaign, and the label.
- Inbox → thread: the sender's address links to the same lead detail, so a reply from an unknown address is one click from "add this person".
- Loading: the search box shows an inline spinner and keeps the typed value. Empty: "No lead with that address" plus "Add them" prefilled. Error: the reason inline, never a blank result.
- Accessibility: the search box is a labelled combobox with results announced as they arrive; the unsubscribed banner is text and an icon, not colour alone. Responsive: results are a full-width sheet under 640px.

**Definition of done**
- [ ] An exact email match navigates straight to the lead rather than showing a one-row list.
- [ ] The lead detail shows every campaign the person is in, not only the most recent.
- [ ] Not-found always offers to add the person with the address prefilled.
- [ ] Unsubscribed state is visible before any compose or add-to-campaign action.

## 5. Backend user story

**As a** Harry API, **I want** an email lookup that returns the person plus their enrolments in one call, **so that** the lead detail renders without a waterfall of requests.

**Scope**
- Route in `server/routes.js`: `GET /api/leads?email=` returning the person with an enrolments array, workspace-scoped like the existing lead handlers. Not-found returns 200 with an empty result, mirroring the source API, so the client does not treat a normal miss as an error.
- Data model: none new, but a case-insensitive unique index on `(workspace, lower(email))` in `server/db.js` if one is not already present, so lookup is a single index hit and duplicates cannot exist.
- Enrolments come from `campaign_leads` joined to campaigns for the name; the derived stage per enrolment uses the shared stage function.
- No pagination — a person is in few campaigns. Standard rate limiting; the client debounces typing rather than relying on retries.
- Logged: `telemetry` for lookup latency only. No `events` row; looking someone up is not an act on them.

**Definition of done**
- [ ] Lookup is case-insensitive and trims whitespace.
- [ ] One query returns the person and the enrolments; no N+1.
- [ ] Missing or malformed email returns 422 naming the parameter.
- [ ] A person in another workspace is never returned, covered by a two-workspace test.

## 6. End-to-end test ticket

**Title:** E2E — Find a person by email and see every campaign they are in

**Preconditions:** A workspace with three campaigns; one lead enrolled in two of them with a label applied in one; one unsubscribed lead; one address that does not exist in the workspace.

**Flow**
1. Leads → type the enrolled person's email in mixed case with a trailing space.
2. Open the resulting lead detail.
3. Type the unsubscribed person's address.
4. Type the unknown address and use "Add them".
5. Open Inbox and click a sender address in a thread.

**Assertions**
- [ ] The mixed-case, space-padded address finds the person.
- [ ] The lead detail lists both enrolments with campaign names, stages and the label.
- [ ] The unsubscribed person's detail shows the unsubscribed banner above the campaign list, and no compose action is available.
- [ ] "Add them" opens the new-lead form with the address prefilled.
- [ ] The Inbox sender link lands on the matching lead detail.

**Teardown:** Delete the lead created by "Add them"; leave the other fixtures.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | Search box that resolves an exact email to the lead | Low | One input at the top of a list that already exists |
| Leads → lead detail | "Campaigns" block listing every enrolment | Low | A short list, hidden when the person is in none |
| Inbox → thread | Sender address links to the lead | Low | A link on text already on screen |

**Verdict:** Fits an existing surface

Harry's Leads page already lists people and shows a research profile per lead; the missing piece is answering "do we already know this address" without scanning. A search box and a campaigns block on a page that already exists is the whole change, and no new navigation item is needed.
