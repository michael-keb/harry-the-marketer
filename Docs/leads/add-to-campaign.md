# Add Leads to Campaign

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/add-to-campaign |
| **Auth** | API key (query param `api_key`) |

Attaches up to 400 people to a campaign in one call, checking each against duplicates, unsubscribes and block lists before it lands.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** to attach a batch of people to a campaign and be told what will be skipped before anything is written, **so that** the playbook starts running for the right people and nobody is emailed who should not be.

**Acceptance criteria**
- [ ] Given a list of leads each with at least `email`, and optionally `first_name`, `last_name`, `phone_number`, `company_name`, `website`, `location`, `linkedin_profile` and `company_url`, when I attach them, then each is created or matched to an existing person and linked to the campaign.
- [ ] Given the batch exceeds 400, when I submit it, then Harry splits it into 400-lead batches itself and shows batch progress rather than asking me to re-cut the file.
- [ ] Given a lead already exists in the workspace by email, when I attach it, then the existing record is reused and only the campaign link is added, so the person's research profile and history survive.
- [ ] Given `custom_fields` on a lead, when it is stored, then up to 200 key-value pairs are kept and are available to the composer as merge data and to the qualification scorer.
- [ ] Given the result, when it renders, then it reports how many were added, how many were skipped, and the reason for each skip (already in this campaign, already in another campaign, unsubscribed, bounced, invalid address).
- [ ] Given a lead has unsubscribed, when I attach it, then it is skipped and there is no setting anywhere in Harry that overrides this — the source API's `ignore_unsubscribe_list` and `ignore_global_block_list` are deliberately not offered.
- [ ] Given leads are attached to a running campaign, when the engine next ticks, then each new lead enters at the playbook's Start node and its first email still parks in Needs your OK.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Attach two leads with names, company and a `job_title` custom field | 200 reporting 2 added, 0 skipped, and an empty skipped list |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the parsed file is kept so nothing has to be re-uploaded after signing in |
| TC-3 | Campaign not found / wrong workspace | Attach to another workspace's campaign id | 404; no lead is created in either workspace |
| TC-4 | Validation failure — bad email | One row has `email: "john@invalid"` | 422 naming the offending address; the other rows still import and the bad row is listed as "could not import" |
| TC-5 | Rate limited | Import 5,000 leads as 13 back-to-back batches | 429 on some batches; the importer backs off and resumes, final count is 5,000 with no duplicates |
| TC-6 | Empty result set | Submit an empty list | 200 with 0 added; "Nothing to import" empty state, campaign untouched |
| TC-7 | Over the batch limit | Submit 500 leads in one call | Rejected with the provided count and the 400 maximum; the client chunks and retries transparently |
| TC-8 | Unsubscribed address | Attach an address previously unsubscribed | Skipped with reason "unsubscribed"; no toggle exists in the UI to force it in |
| TC-9 | Duplicate inside one batch | Same email twice in the list | One lead created, one counted as a duplicate skip |
| TC-10 | Custom fields over the limit | A row with 201 custom fields | 422 with a field-level message on the custom fields; the rest of the batch imports |
| TC-11 | Missing email | A row with names but no email | Row rejected with its line number; other rows import |

## 4. Frontend user story

**As a** campaign owner, **I want** to pick or upload the people for a campaign and see exactly what will happen before I commit, **so that** I never find out afterwards that I emailed the wrong list.

**Scope**
- Campaigns → campaign detail: an "Attach leads" action with two paths — multi-select from the existing Leads page (with its stage filter strip) or the existing CSV importer with column mapping.
- A pre-import summary: counts to be added and skipped, broken out by reason, with "already in another campaign" as the only togglable rule.
- Loading: batch progress ("Batch 3 of 13 — 1,200 of 5,000") because imports chunk at 400. Empty: "No leads selected". Error: a downloadable list of rows that failed, one reason per row.
- Custom fields from the CSV land on the lead and are shown on the lead detail, so the user can see what the composer will have to work with.
- Accessibility: the mapping table is a real table with header associations; progress announces via `aria-live="polite"`; every skip reason is text, never colour alone. Responsive: the summary stacks under 640px.

**Definition of done**
- [ ] Both paths end at the same summary screen.
- [ ] Skips are always shown with a reason and a count.
- [ ] The 400-per-batch chunking is invisible apart from the progress line.
- [ ] No UI path can attach an unsubscribed or hard-bounced address.

## 5. Backend user story

**As a** Harry API, **I want** a transactional bulk-attach route with suppression checks, **so that** large imports are fast, safe to retry, and cannot break an unsubscribe.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns/:id/leads` taking `{ leads: [], settings: { allowLeadsInOtherCampaigns } }`, workspace-scoped like the neighbouring handlers.
- Data model: reuses `leads` and `campaign_leads` in `server/db.js`. Upsert on `(workspace, lower(email))`; unique constraint on `(campaign_id, lead_id)` makes the call idempotent. Custom fields stored as JSON, capped at 200 keys.
- Suppression runs before insert: unsubscribed, hard-bounced, already in this campaign, already in another campaign (the last one bypassable). Each skip returns a machine-readable reason so the UI can group them.
- Batch cap of 400 enforced server-side, the whole batch in one SQLite transaction. Standard app rate limiting; the client retries 429 with backoff.
- Logged: an `events` row per import (actor, campaign, added, skipped by reason); `telemetry` records batch size and duration so Monitoring can show import throughput.

**Definition of done**
- [ ] Running the same batch twice produces the same counts and no new rows.
- [ ] Unsubscribed and hard-bounced addresses are refused regardless of request settings.
- [ ] The response carries added count, skipped count, per-reason breakdown and the created lead ids.
- [ ] Tests cover the 400 cap, mid-batch invalid rows, and cross-workspace 404.

## 6. End-to-end test ticket

**Title:** E2E — Attach a lead list to a campaign and watch the playbook pick it up

**Preconditions:** A workspace with one sandbox mailbox, a campaign with a valid playbook, and a CSV of 420 rows containing 5 duplicates, 2 malformed addresses and 1 previously unsubscribed address.

**Flow**
1. Campaigns → campaign detail → Attach leads → Upload CSV.
2. Map the columns, including two custom fields (job title, industry).
3. Read the pre-import summary.
4. Confirm and watch batch progress.
5. Launch the campaign and let the engine tick.
6. Open Inbox → Needs your OK.

**Assertions**
- [ ] The summary predicts 412 imports and 8 skips, broken out by reason, before anything is written.
- [ ] After import, Leads shows 412 new people at stage "not contacted", each carrying the two custom fields.
- [ ] The unsubscribed address appears nowhere in the campaign.
- [ ] Drafts appear in Needs your OK; nothing has sent.
- [ ] Re-running the identical import adds zero leads and reports 420 duplicate skips.

**Teardown:** Delete the imported leads and the campaign; clear the uploaded file from temporary storage.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | "Attach leads" flow with pre-import summary | Medium | Reuses the existing CSV importer; the summary is one panel, not a wizard |
| Leads | Multi-select plus "Add to campaign" | Low | Selection controls appear only once a row is ticked |
| Leads → lead detail | Custom fields list | Low | Simple key-value list, hidden when empty |
| Dashboard activity trail | One entry per import | Low | Summarised per import, never per lead |

**Verdict:** Fits an existing surface

Harry already imports CSVs with column mapping and dedupe on the Leads page; this is the same flow reached from a campaign and ending in a campaign link. The genuinely new part is the pre-import summary, and it earns its place by preventing the one mistake that cannot be undone.
