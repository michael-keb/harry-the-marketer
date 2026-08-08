# Export Campaign Leads

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/leads-export` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/export-leads |
| **Auth** | API key (query param `api_key`) |

Downloads every lead in a campaign as a CSV file, with their details and where they have got to.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** to download a campaign's leads as a CSV, **so that** I can hand the list to a colleague, load it into a CRM, or keep a record before I retire the campaign.

**Acceptance criteria**
- [ ] Given a campaign with leads, when I export it, then I get a CSV whose header row includes at least email, first name, last name, company name, phone number, status, category and created date — mirroring the source API's `email,first_name,last_name,company_name,phone_number,status,category,created_at`.
- [ ] Given Harry derives stage rather than storing it, when a row is written, then the status column carries the derived stage (not contacted, contacted, replied, interested, agreed, won, lost, unsubscribed, bounced) and the category column carries the last classified reply intent.
- [ ] Given a campaign with no leads, when I export it, then I get a CSV containing only the header row, and the UI says the export was empty rather than downloading nothing.
- [ ] Given a large campaign, when I export tens of thousands of leads, then the response streams rather than being built in memory, and the UI shows progress until the file lands.
- [ ] Given fields containing commas, quotes or newlines, when they are written, then they are correctly quoted and escaped, and the file opens cleanly in a spreadsheet.
- [ ] Given non-ASCII names, when the file is written, then it is UTF-8 with a byte-order mark so spreadsheets do not mangle accented characters.
- [ ] Given someone exports personal data, when the export completes, then who exported which campaign and how many rows is written to the activity trail.
- [ ] Given I export a campaign in another workspace, when I request it, then I get a 404 and no file.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET the export for a campaign with 2 leads | 200 with `Content-Type: text/csv`, a `Content-Disposition` filename, a header row and 2 data rows matching the documented columns |
| TC-2 | Missing/invalid API key | GET unauthenticated | 401; no file is produced, browser does not start a download |
| TC-3 | Not found / wrong workspace | GET the export for another workspace's campaign | 404; no file |
| TC-4 | Validation failure | GET with a non-numeric campaign id | 422 with a field-level message on the campaign id |
| TC-5 | Rate limited | Request the export repeatedly in a burst | 429 on the excess; UI shows "Export already in progress" rather than starting several downloads |
| TC-6 | Empty result set | Export a campaign with no leads attached | 200 with a header-only CSV; UI states "No leads to export" |
| TC-7 | Escaping | Include a lead whose company is `Smith, Jones "and" Co` and whose notes contain a newline | The CSV opens in a spreadsheet with the value intact in one cell |
| TC-8 | Encoding | Include leads named Zoë and 中村 | Names render correctly when opened in Excel and in Google Sheets |
| TC-9 | Derived status accuracy | Export a campaign where one lead replied, one unsubscribed and one was never contacted | The status column reads replied, unsubscribed and not contacted respectively, matching the Leads page filter strip |
| TC-10 | Large export | Export 50,000 leads | Response streams, memory stays flat, file is complete and row count matches the campaign's lead count |
| TC-11 | Export during a run | Export while the engine is sending | The file is internally consistent — no lead appears twice and none is missing |

## 4. Frontend user story

**As a** campaign owner, **I want** an Export action on the campaign's leads, **so that** getting the list out is one click and I can see what I am about to download.

**Scope**
- Campaigns → campaign detail → leads table: an "Export CSV" action in the table header, which exports what the current filters show and says so ("Export 412 leads matching your filters").
- Leads page: the same action, scoped to the workspace rather than a campaign, reusing the identical component and column set.
- The delete-campaign dialog links to Export, so the recommended "export before you destroy" path is one click from the moment it matters.
- Loading: the button shows progress with a row count for large exports; empty: the action is disabled with "No leads to export"; error: an inline message with retry, no partial file left in the browser.
- Accessibility: the action is a real button with an accessible name including the row count; progress is announced politely; the download is triggered by a user gesture so assistive tech is not surprised. Responsive: the action moves into the table's overflow menu under 640px.

**Definition of done**
- [ ] Export respects the leads table's active filters and says how many rows it will write.
- [ ] The file downloads with a meaningful filename including the campaign name and date.
- [ ] Empty and error states are handled without producing a broken file.
- [ ] The delete dialog offers Export before destruction.

## 5. Backend user story

**As a** Harry API, **I want** a streaming CSV export route, **so that** large campaigns export without exhausting memory and the file is always well-formed.

**Scope**
- Route in `server/routes.js`: `GET /api/campaigns/:id/leads/export` accepting the same filter parameters as the campaign leads listing, workspace-scoped, responding with `text/csv` and a `Content-Disposition` attachment filename.
- Data model: none new. Rows are streamed from `campaign_leads` joined to `leads`, with the stage derived exactly as the Leads page derives it — from messages, outcomes and signed agreements — so the export can never disagree with the screen.
- Streaming: rows are written in batches as they are read, with a stable ordering by lead id so an export taken during a live run cannot duplicate or skip a row. UTF-8 with BOM; RFC 4180 quoting.
- Gzip applies as it does to other dynamic responses. Standard rate limiting, with a per-campaign lock so one user cannot start ten concurrent exports.
- Logged: an `events` row recording actor, campaign, filters and row count, since this is a personal-data export; `telemetry` records duration and row count so Monitoring can spot slow exports.

**Definition of done**
- [ ] Export streams and is memory-flat on a 50,000-lead fixture.
- [ ] Quoting and encoding covered by tests including commas, quotes, newlines and non-ASCII.
- [ ] Derived stage matches the Leads page for the same fixture, asserted by a test.
- [ ] Every export is recorded in the activity trail with a row count.

## 6. End-to-end test ticket

**Title:** E2E — Export a campaign's leads before retiring it

**Preconditions:** A workspace with one campaign, 30 leads across mixed stages including one unsubscribed and one whose company name contains a comma and a quote, one sandbox mailbox, some sent messages and one reply.

**Flow**
1. Open Campaigns → campaign detail → leads.
2. Filter the table to "replied".
3. Press Export CSV and note the stated row count.
4. Clear the filter and export the full list.
5. Open both files in a spreadsheet.
6. Open the campaign's overflow menu, choose Delete, and use the Export link in the dialog.

**Assertions**
- [ ] The filtered export contains exactly the replied leads and its count matches what the button said.
- [ ] The full export contains all 30 leads with the documented columns.
- [ ] The awkward company name lands in one cell, unbroken.
- [ ] The status column matches the stage shown on the Leads page for three spot-checked leads.
- [ ] The activity trail shows three export entries with actor, filters and row counts.
- [ ] The Export link inside the delete dialog produces the same file as step 4.

**Teardown:** Delete the downloaded files and the campaign; keep the leads.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail leads table | "Export CSV" action in the table header | Low | One button, and it inherits the filters already applied |
| Leads | The same action at workspace scope | Low | Shared component, identical behaviour |
| Delete dialog | Export link | Low | One line of text in a dialog that already lists what will be lost |

**Verdict:** Fits an existing surface

Export belongs next to the table it exports, and both tables already exist. Making the button state its row count and honour the current filters is what keeps it "don't make me think" — the file matches what the user is looking at, so there is nothing to configure and nothing to guess.
