# Export Campaign Leads

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/leads-export` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/export |
| **Auth** | API key (query param `api_key`) |

Downloads every lead in a campaign as a CSV, with their contact details, status, label and engagement counts.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** to download a campaign's leads as a spreadsheet, **so that** I can hand the list to someone who does not use Harry, or take it with me.

**Extra weight for Harry:** the export is also the data-portability answer the privacy policy promises, so it has to be complete and honest, not a convenience feature.

**Acceptance criteria**
- [ ] Given a campaign with leads, when I export, then I get a CSV whose columns cover contact details (first name, last name, email, phone, company name, website, location, LinkedIn profile, company URL), custom fields as JSON, when they were added, and the campaign's own identifiers.
- [ ] Given engagement data, when the CSV is produced, then it carries the last sequence step sent, open count, click count and reply count per lead, matching what Reports shows for the same campaign.
- [ ] Given a lead has unsubscribed, when the CSV is produced, then an unsubscribed column says so, so the list cannot be reused elsewhere without that fact travelling with it.
- [ ] Given Harry derives the prospect stage rather than storing it, when the CSV is produced, then the derived stage (not contacted → contacted → replied → interested → agreed → won / lost / unsubscribed / bounced) is a column alongside the raw counts.
- [ ] Given the download starts, when it arrives, then the file is named after the campaign and dated, the content type is CSV, and it opens cleanly in a spreadsheet with a UTF-8 byte order mark so accented names are not mangled.
- [ ] Given a campaign with no leads, when I export, then I get a CSV containing only the header row and the UI says the campaign has no leads yet.
- [ ] Given a large campaign, when I export, then the response streams rather than buffering, and the UI shows progress instead of appearing to hang.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Export a campaign with 50 leads | 200, content type `text/csv`, a filename in the content disposition, 51 lines including the header |
| TC-2 | Missing/invalid API key | Request the export with no session | 401; the browser does not download a file containing an error page |
| TC-3 | Campaign not found / wrong workspace | Export another workspace's campaign id | 404 with a campaign-not-found error; no file is produced |
| TC-4 | Validation failure | Export with a non-numeric campaign id | 422 naming the id parameter |
| TC-5 | Rate limited | Trigger five exports of a large campaign at once | 429 after the first few; the UI queues them and says so rather than failing silently |
| TC-6 | Empty result set | Export a campaign with no leads attached | 200 with a header-only CSV; the UI says "No leads in this campaign yet" before offering the download |
| TC-7 | Custom fields round trip | Export a campaign whose leads carry two custom fields, then re-import the file | The custom fields column parses as JSON and the re-import maps both fields back |
| TC-8 | Commas and quotes in values | A lead with a company name containing a comma and a quotation mark | The field is correctly quoted and escaped; a spreadsheet opens it in one cell |
| TC-9 | Non-Latin names | A lead named in Arabic script | The name survives the round trip unchanged when opened in Excel and in Sheets |
| TC-10 | Unsubscribed lead | Export a campaign containing an unsubscribed lead | The unsubscribed column reads true for that row and the derived stage column reads "unsubscribed" |
| TC-11 | Large campaign | Export 20,000 leads | The response streams, memory stays flat, and the file is complete with 20,001 lines |

## 4. Frontend user story

**As a** campaign owner, **I want** an export button where I already look at the leads, **so that** getting my data out is one click and never a support request.

**Scope**
- Campaigns → campaign detail: an "Export CSV" action beside the attached leads list.
- Leads: the same export for the current filter, so exporting "everyone at stage interested" works without going campaign by campaign.
- Loading: a progress line for exports over a few thousand rows, driven by streamed bytes. Empty: the download is still offered but the empty state is shown first. Error: the failure is shown in the page, never as a downloaded file containing an error.
- The existing Google Sheet sync stays the live option; the CSV is the one-off, offline one. The two are described in one sentence each so the user does not have to guess which to use.
- Accessibility: the export control is a real button, not a bare link, and progress is announced via `aria-live="polite"`. Responsive: the action collapses into the existing overflow menu under 640px.

**Definition of done**
- [ ] Export is reachable from both Campaigns detail and Leads, and the Leads one respects the active filter.
- [ ] Filenames include the campaign name and the date.
- [ ] Errors never arrive as a downloaded file.
- [ ] The relationship to the Google Sheet sync is explained in one line where both appear.

## 5. Backend user story

**As a** Harry API, **I want** a streaming CSV export route, **so that** even a large campaign exports without holding the whole list in memory.

**Scope**
- Routes in `server/routes.js`: `GET /api/campaigns/:id/leads-export` and `GET /api/leads/export` (taking the same filter parameters the Leads page uses), both workspace-scoped.
- Data model: none new. Rows are read from `leads` and `campaign_leads`; open, click and reply counts come from the existing tracking data; the derived stage is computed by the same function the Leads page uses so the two can never disagree.
- Streaming: rows are written as they are read, with a UTF-8 byte order mark, RFC 4180 quoting, and `Content-Disposition` carrying the generated filename. No pagination — the stream is the pagination.
- Standard rate limiting, with exports counted more heavily than reads; the client queues rather than retrying blindly.
- Logged: an `events` row per export (actor, campaign, row count) because exporting personal data is an act worth recording; `telemetry` records duration and row count for Monitoring.

**Definition of done**
- [ ] Memory stays flat while exporting 20,000 rows, covered by a test.
- [ ] The derived stage column is produced by the shared stage function, not a copy.
- [ ] Quoting is verified against values containing commas, quotes and newlines.
- [ ] Every export leaves an activity trail entry naming the actor.

## 6. End-to-end test ticket

**Title:** E2E — Export a campaign's leads and re-import the file

**Preconditions:** A workspace with a campaign of 200 leads at mixed stages, including one unsubscribed lead, one lead with a comma in the company name, and leads carrying two custom fields.

**Flow**
1. Campaigns → campaign detail → Export CSV.
2. Open the file in a spreadsheet.
3. Return to Harry, go to Leads, filter to stage "interested", export again.
4. Create a second campaign and import the first file with the CSV importer.
5. Open the Dashboard activity trail.

**Assertions**
- [ ] The first file has 201 lines and the filename carries the campaign name and today's date.
- [ ] The comma-containing company name occupies a single cell.
- [ ] The unsubscribed lead's row reads true in the unsubscribed column and "unsubscribed" in the stage column.
- [ ] The second export contains only leads at stage "interested", matching the count shown on the filter strip.
- [ ] Re-importing skips the unsubscribed lead and maps both custom fields.
- [ ] The activity trail shows two export entries with row counts.

**Teardown:** Delete the second campaign and the imported leads; remove the downloaded files.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | "Export CSV" action | Low | One button in the existing lead-list header |
| Leads | Export respecting the current filter | Low | Reuses the filter already on screen; no export dialog |
| Settings | One line explaining CSV export versus Google Sheet sync | Low | A sentence beside the existing sync button |
| Dashboard activity trail | Export entries | Low | One line per export |

**Verdict:** Fits an existing surface

Harry already pushes every prospect and their stage into a Google Sheet, so the live view is covered; the gap is the offline, one-off file that data-portability promises require. It is a button on two pages that already list leads, with no dialog and no new navigation.
