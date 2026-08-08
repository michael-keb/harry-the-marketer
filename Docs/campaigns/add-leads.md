# Add Leads to Campaign

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/add-leads |
| **Auth** | API key (query param `api_key`) |

Adds a batch of people to a campaign, with controls for skipping duplicates, unsubscribes and blocked addresses.

## 1. Epic

**Campaign lifecycle and sequence control**

Everything a Harry user does to a campaign once its playbook exists: attach mailboxes and leads, launch and duplicate it, watch which sequence steps earn replies, and retire it. It matters because a Mermaid playbook only becomes outreach when real mailboxes and real people are wired to it, and every step of that wiring has to be reversible and visible in the activity trail.

## 2. User story

**As a** campaign owner, **I want** to attach a batch of leads to a campaign with their details and custom fields, **so that** the playbook starts running for those people without me adding them one at a time.

**Acceptance criteria**
- [ ] Given a batch of lead objects each with at least `email`, and optionally `first_name`, `last_name`, `company_name`, `phone_number`, `website`, `location`, `linkedin_profile` and `company_url`, when I attach them, then every valid lead is created or matched and linked to the campaign, and the response reports `added_count`, `skipped_count` and the created lead ids.
- [ ] Given a batch larger than the 400-lead limit, when I submit it, then it is rejected with a message stating the provided count and the maximum, and the importer splits it into 400-lead batches automatically rather than making me do it.
- [ ] Given a lead whose email already exists in the workspace, when I attach it, then the existing lead record is reused and only the campaign link is added — no duplicate person is created — and it counts toward `skipped_count` as a duplicate.
- [ ] Given a lead who has unsubscribed, when I attach it, then it is skipped by default and the skip reason is shown; the equivalent of `ignore_unsubscribe_list` is deliberately not offered, because Harry always honours an unsubscribe.
- [ ] Given a lead already in another campaign, when I attach it, then it is skipped unless I explicitly tick "allow leads that are already in another campaign" (the `ignore_duplicate_leads_in_other_campaign` behaviour), and the count of such skips is shown before I confirm.
- [ ] Given `custom_fields` on a lead, when it is stored, then up to 200 key-value pairs are kept and are available to the composer as merge data and to the qualification scorer.
- [ ] Given an empty batch or a batch where every row is skipped, when the import finishes, then the result screen says exactly what was skipped and why, and no campaign state changes.
- [ ] Given leads are attached to a running campaign, when the engine next ticks, then each new lead enters at the playbook's Start node and its first email still parks in the approval queue.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST two lead objects with email, names, company and `custom_fields` | 200 with `added_count: 2`, `skipped_count: 0`, and a `lead_ids` array of the two new ids |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401; UI shows a re-authentication prompt and the parsed file is kept so nothing is re-uploaded |
| TC-3 | Campaign not found / wrong workspace | POST to another workspace's campaign id | 404, `{"error": "Resource not found"}`; no leads created anywhere |
| TC-4 | Validation failure — over the batch limit | POST 500 leads in one request | 422 with `provided_count: 500`, `max_allowed: 400`; the importer chunks and retries transparently |
| TC-5 | Rate limited | Import 5,000 leads as 13 back-to-back batches | 429 on some batches; the importer backs off and resumes, final total still 5,000 with no duplicates |
| TC-6 | Empty result set | POST `lead_list: []` | 200 with `added_count: 0`; UI shows "Nothing to import" empty state, campaign untouched |
| TC-7 | Missing required email | One row has no `email` | That row is rejected with a row-level message naming the line number; the other rows still import |
| TC-8 | Malformed email | Row with `email: "john@@company"` | Rejected as invalid at row level, counted in a "could not import" list that is downloadable |
| TC-9 | Unsubscribed lead | Attach an address previously unsubscribed | Skipped with reason "unsubscribed"; no way in the UI to override it |
| TC-10 | Duplicate inside the same batch | Same email twice in one `lead_list` | One lead created, one counted as a duplicate skip |
| TC-11 | Custom fields over the limit | A row with 201 custom fields | 422 with a field-level message on `custom_fields`; the rest of the batch imports |

## 4. Frontend user story

**As a** campaign owner, **I want** to pick or upload leads for a campaign and see exactly what will be imported before I commit, **so that** I never discover after the fact that I emailed someone twice.

**Scope**
- Campaigns → campaign detail: an "Attach leads" flow with two paths — choose from existing leads on the Leads page (multi-select with the stage filter strip) or upload a CSV using the existing column-mapping importer.
- A pre-import summary panel: how many will be added, how many skipped and why (already in this campaign, already in another campaign, unsubscribed, bounced, invalid address), with the "already in another campaign" rule as the one togglable option.
- Loading: progress by batch ("Batch 3 of 13 — 1,200 of 5,000 leads") since imports chunk at 400. Empty: "No leads selected". Error: a downloadable list of rows that could not be imported, with the reason per row.
- Custom fields from the CSV map into the lead's custom fields and are shown on the lead detail so the user can see what the composer will have to work with.
- Accessibility: the mapping table is a real table with header associations; progress uses `aria-live="polite"`; skip reasons are text. Responsive: the summary panel collapses to a stacked list under 640px.

**Definition of done**
- [ ] Both attach paths (existing leads, CSV upload) reach the same import summary.
- [ ] Skips are always explained by reason and count, never as a bare number.
- [ ] Batching at 400 is invisible to the user apart from the progress indicator.
- [ ] Unsubscribed addresses cannot be imported by any UI path.

## 5. Backend user story

**As a** Harry API, **I want** a route that attaches many leads to a campaign transactionally with duplicate and suppression checks, **so that** large imports are fast, safe to retry, and never violate an unsubscribe.

**Scope**
- Route in `server/routes.js`: `POST /api/campaigns/:id/leads` taking `{ leads: [], settings: { allowLeadsInOtherCampaigns } }`, mirroring the workspace-scoped handlers already there.
- Data model: reuses `leads` and `campaign_leads` in `server/db.js`. Upsert on `(workspace, lower(email))` so a re-import updates details instead of duplicating a person; unique constraint on `(campaign_id, lead_id)` makes the whole call idempotent. Custom fields stored as JSON on the lead, capped at 200 keys.
- Suppression checks run before insert: unsubscribed, hard-bounced, and already-in-another-campaign (the last one bypassable by the setting). Each skip is returned with a machine-readable reason so the UI can group them.
- Batch cap of 400 per request enforced server-side with the same shape as the source API (`provided_count`, `max_allowed`); the whole batch runs in one SQLite transaction. Standard app rate limiting applies; the client retries 429 with backoff.
- Logged: an `events` row summarising each import (actor, campaign, added, skipped by reason); `telemetry` records batch size and duration so Monitoring can show import throughput.

**Definition of done**
- [ ] Import is idempotent — running the same batch twice yields the same lead and link counts.
- [ ] Unsubscribed and hard-bounced addresses are refused regardless of request settings.
- [ ] Response carries `addedCount`, `skippedCount`, per-reason skip counts, and the created lead ids.
- [ ] Tests cover the 400 cap, mid-batch invalid rows, and cross-workspace 404.

## 6. End-to-end test ticket

**Title:** E2E — Import a lead list into a campaign and see the playbook pick them up

**Preconditions:** A workspace with one sandbox mailbox, one campaign with a valid playbook, a CSV of 420 rows containing 5 duplicates, 2 malformed addresses and 1 previously unsubscribed address.

**Flow**
1. Open Campaigns → campaign detail → Attach leads → Upload CSV.
2. Map the columns, including two custom fields (job title, industry).
3. Review the pre-import summary.
4. Confirm the import and watch the batch progress.
5. Launch the campaign and let the engine tick.
6. Open Inbox → Needs your OK.

**Assertions**
- [ ] The summary predicts 412 imports and 8 skips, broken out by reason, before anything is written.
- [ ] After import, the Leads page shows 412 new leads at stage "not contacted", each carrying the two custom fields.
- [ ] The unsubscribed address does not appear in the campaign anywhere.
- [ ] Drafts appear in Needs your OK — none of the 412 sends without an approval.
- [ ] Re-running the identical import adds zero leads and reports 420 duplicate skips.

**Teardown:** Delete the imported leads and the campaign; clear the uploaded file from temporary storage.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaigns → campaign detail | "Attach leads" flow with a pre-import summary | Medium | Reuses the existing CSV importer and its column mapping; the summary is one panel, not a wizard |
| Leads | Multi-select plus "Add to campaign" action | Low | Selection UI only appears once a row is ticked |
| Lead detail | Custom fields section | Low | Rendered as a simple key-value list, hidden when empty |
| Dashboard activity trail | Import summary entries | Low | One line per import, not one per lead |

**Verdict:** Fits an existing surface

Harry already has CSV import with column mapping and dedupe on the Leads page; this is that flow reached from a campaign, ending in a campaign link rather than a bare lead. The only genuinely new element is the pre-import summary, and it earns its place by preventing the one mistake users cannot undo — emailing the wrong people.
