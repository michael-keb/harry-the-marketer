# Import Leads to List

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/lead-list/{id}/import` |
| **Category** | lead-lists |
| **Source** | https://api.smartlead.ai/api-reference/lead-lists/import-leads |
| **Auth** | API key (query param `api_key`) |

Loads a batch of people straight into one saved group, remembering which file they came from and reporting how many were new, duplicate or blocked.

## 1. Epic

**Reusable lead segments**

Lets a Harry user keep a named, reusable group of prospects — "Australian SaaS running Jira", "Warm from the October webinar" — that outlives any one campaign and can be researched, scored, renamed and pushed at a campaign whenever it is needed. It matters because Harry's Leads page is one flat table today: every new campaign starts by re-finding the same people by hand, and there is nowhere to record that a particular set of thirty is the set worth chasing.

## 2. User story

**As a** campaign owner, **I want** to upload a CSV directly into a segment and see what happened to every row, **so that** a purchased or exported list becomes a reusable group without touching a campaign yet.

**Acceptance criteria**
- [ ] Given a `leadList` array where each object has at least `email` plus optional `first_name`, `last_name` and `company`, and a `fileName` such as "enterprise-prospects-jan2025.csv", when I import into segment 500, then a 200 returns `total_leads`, `imported`, `duplicates`, `blocked` and `invalid`, and those counts account for every row in the file. (`invalid` is the fifth outcome a row can have — no address, or a malformed one — so a summary of four would not add up whenever a file has a bad row, which is the case the summary exists for.)
- [ ] Given `fileName` is missing, when I submit, then a 422 names `fileName`; it is required because it is what makes an import traceable later.
- [ ] Given a row whose email already exists in the workspace, when I import, then the existing lead is reused and only added to the segment — counted in `duplicates`, never duplicated as a person.
- [ ] Given a row on the blocked-domain list, when I import, then it is counted in `blocked` and excluded; the source API's `csvSettings.ignoreGlobalBlockList` override is deliberately not offered in the UI, because Harry never bypasses a block.
- [ ] Given a previously unsubscribed address, when I import, then it does **not** join the segment at all: it is counted in `blocked`, reported on the row as "unsubscribed — will never be emailed", and no membership row is written. Harry is deliberately stricter than the source API here. A segment is what a campaign gets pointed at, so an opted-out address sitting inside one is a person waiting to be emailed by whoever pushes that segment next — and the check that saves them then is a check that has to hold every time. Keeping them out of the segment is one rule instead of two. The same applies when the lead record no longer exists: the `blocked_domains` entry `unsubscribeLead()` writes outlives the person, so a re-import of a deleted unsubscriber is refused with nothing left to match on (see Docs/leads/delete.md).
- [ ] Given `customFields` mappings in the request, when the leads are stored, then those values are attached to each lead and are available to the composer as merge data and to the qualification scorer.
- [ ] Given an import of 5,000 rows, when it runs, then progress is reported by batch and a failure part way through leaves the already-imported rows in the segment with an accurate summary, not a silent partial state.
- [ ] Given every row is a duplicate, when the import finishes, then a 200 with `imported: 0` shows "Nothing new to add — all N rows are already in this segment" rather than a success banner.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST 2 lead objects with `fileName: "enterprise-prospects-jan2025.csv"` to segment 500 | 200 with `data: {total_leads: 2, imported: 2, duplicates: 0, blocked: 0}` |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; the parsed file is kept so nothing must be re-uploaded |
| TC-3 | Segment not found / wrong workspace | POST to another workspace's segment id | 404; no leads created in either workspace |
| TC-4 | Validation failure — no `fileName` | POST a valid `leadList` with `fileName` omitted | 422 with a field-level message naming `fileName` |
| TC-5 | Rate limited | Import 5,000 rows as chunked batches | 429 on some batches; the importer backs off and resumes, final `imported` total is correct with no duplicates |
| TC-6 | Empty result set | POST `{"leadList":[],"fileName":"empty.csv"}` | 200 with `total_leads: 0`; "Nothing to import" empty state, segment untouched |
| TC-7 | Row without an email | One object has no `email` | That row is rejected with a message naming its line number; the remaining rows still import |
| TC-8 | Malformed email | `{"email":"john@@company"}` | Rejected at row level and listed in a downloadable "could not import" file |
| TC-9 | Blocked domain | Import an address on the blocked-domain list | Counted in `blocked`, excluded from the segment, and no UI path exists to force it in |
| TC-10 | Duplicate within the same file | Same email twice in one `leadList` | One lead created, one counted in `duplicates` |
| TC-11 | Custom fields | Import with `customFields` mapping job title and industry | Both appear on the lead detail and are usable as merge data |
| TC-12 | Re-import of the same file | Run TC-1 twice | Second run reports `imported: 0`, `duplicates: 2`; the segment count does not change |

## 4. Frontend user story

**As a** campaign owner, **I want** the CSV importer I already know, aimed at a segment, **so that** building a reusable group is the same three steps as importing leads today.

**Scope**
- Leads page → the selected segment's empty state and overflow menu both offer "Import a CSV", opening the existing column-mapping importer with the destination segment pre-filled and named in the dialog header.
- A pre-import summary before anything is written: how many will be added, how many are already in this segment, how many are blocked, how many rows are invalid — the same four-way breakdown the response returns.
- The uploaded filename is stored and shown on the segment ("Last import: enterprise-prospects-jan2025.csv, 12 Jan") so a year-old segment can still explain where its people came from.
- States: batch progress ("Batch 3 of 13 — 1,200 of 5,000 rows") with `aria-live="polite"`; a downloadable failed-rows file with a reason per row; empty file handled as "Nothing to import".
- Accessibility: the mapping table is a real table with header associations; progress and results are announced; the failed-rows link is a real link with a filename. Responsive: the summary stacks under 640px.

**Definition of done**
- [ ] The importer is the existing one, not a second implementation.
- [ ] The four-way summary is shown before the user commits.
- [ ] The source filename is visible on the segment afterwards.
- [ ] There is no UI control that bypasses the blocked-domain list.

## 5. Backend user story

**As a** Harry API, **I want** a route that imports rows into a segment transactionally with dedupe and suppression, **so that** large imports are fast, retryable, and never smuggle a blocked or unsubscribed address into a future send.

**Scope**
- Route in `server/routes.js`: `POST /api/lead-lists/:id/import` taking `{ leads, fileName, customFields }`, workspace-scoped, mirroring the existing campaign import handler so the two share validation and parsing code.
- Data model: upsert into `leads` on `(workspace_id, lower(email))` so re-imports update details rather than duplicating people; insert into `lead_list_leads` with a unique constraint on `(list_id, lead_id)` making the call idempotent; store `fileName` and the four counts on a `lead_list_imports` row for the "last import" line.
- Suppression before insert: blocked domains and unsubscribed addresses are checked server-side and cannot be overridden by any request field — the source API's `ignoreGlobalBlockList` is intentionally unsupported.
- Batching: rows are chunked server-side into transactions of 400 to match the existing importer; each chunk is one SQLite transaction, and the response aggregates `totalLeads`, `imported`, `duplicates`, `blocked` and per-row failures. Standard rate limiting; the client retries 429 with backoff.
- Logged: one `events` row per import (actor, segment, filename, four counts); `telemetry` records rows per second and chunk duration so Monitoring can show import throughput.

**Definition of done**
- [ ] Importing the same file twice adds zero new leads and zero new memberships.
- [ ] Blocked and unsubscribed addresses are refused regardless of request body.
- [ ] Per-row failures are returned with line numbers and reasons.
- [ ] Tests cover chunking, mid-batch invalid rows, re-import idempotency and cross-workspace 404.

## 6. End-to-end test ticket

**Title:** E2E — Import a CSV into a segment and reuse it later

**Preconditions:** A workspace with an empty segment "Q1 2025 Enterprise Prospects", a blocked domain configured, and a 420-row CSV containing 5 duplicates, 2 malformed addresses, 1 blocked domain and 1 previously unsubscribed address.

**Flow**
1. Open Leads, select the segment, click Import a CSV.
2. Map the columns including two custom fields (job title, industry).
3. Review the pre-import summary.
4. Confirm and watch batch progress.
5. Download the failed-rows file.
6. Re-run the identical import.

**Assertions**
- [ ] The summary predicts the added, duplicate, blocked and invalid counts before anything is written.
- [ ] After importing, the segment header count matches `imported` exactly.
- [ ] The blocked address is not in the segment and cannot be forced in.
- [ ] The unsubscribed lead is visible but marked as never-to-be-emailed.
- [ ] Every imported lead carries the two custom fields on its detail view.
- [ ] The segment shows "Last import: <filename>" with today's date.
- [ ] The re-run reports 0 imported, 420 duplicates, and the segment count is unchanged.

**Teardown:** Delete the imported leads and clear the uploaded file from temporary storage.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → CSV importer | A destination-segment field, pre-filled when opened from a segment | Low | One extra line in a dialog that already exists; the mapping step is unchanged |
| Leads → Segments panel | "Last import: filename, date" under the segment name | Low | One line of secondary text, hidden when the segment has never been imported into |
| Import summary | Four-way breakdown of added / duplicate / blocked / invalid | Medium | It replaces, rather than adds to, the bare "N imported" message |
| Dashboard activity trail | One entry per import | Low | Summarised per import, not per row |

**Verdict:** Fits an existing surface

Harry already has CSV import with column mapping and dedupe; this is that same flow with a segment as the destination instead of the bare lead table. Keeping the source filename is the small addition that pays off most, because the question a user actually asks about an old segment is "where did these people come from", and today nothing can answer it.
