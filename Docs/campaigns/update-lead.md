# Update Campaign Lead Details

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}/` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/update-lead |
| **Auth** | API key (query param `api_key`) |

Corrects a lead's details — name, company, phone, website, location, LinkedIn and any custom fields — while they are part of a campaign.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner who spotted a typo in a prospect's name, **I want** to fix a lead's details mid-campaign, **so that** the next email the agent writes is correct instead of embarrassing.

**Acceptance criteria**
- [ ] Given a lead in a campaign, when I update any of `first_name`, `last_name`, `company_name`, `phone_number`, `website`, `location`, `linkedin_profile` or `company_url`, then the change is saved and reflected on the lead everywhere in the workspace.
- [ ] Given `email` is required on the request, when I change it, then Harry treats it as a new recipient: existing threads keep their old address and the change is flagged for confirmation rather than applied silently.
- [ ] Given `custom_fields` is an object of key-value pairs capped at 200 fields, when I exceed the cap or send a non-object, then I get a validation error naming the field.
- [ ] Given a draft is waiting in Needs your OK for that lead, when I update the details it relies on, then the draft is flagged as out of date with an option to recompose.
- [ ] Given the update changes data the ICP score was based on, when the update saves, then the qualification score is recalculated and the new reasons are shown.
- [ ] Given the email address I set already belongs to another lead in the workspace, when I save, then I get a clear duplicate error and the option to merge instead.
- [ ] Given a required field is emptied, when I save, then the field-level error names it and no partial update is written.
- [ ] Given the lead is not in the campaign, when I update them, then I get a not-found response.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{ email, first_name: "John", last_name: "Doe", company_name: "ACME Corp Updated", custom_fields: { job_title: "CEO", company_size: "50-200" } }` | 200 `{ success: true, message: "Lead updated successfully" }`; the Leads page shows the new values |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; nothing saved; the form keeps the typed values |
| TC-3 | Not found / wrong workspace | Update a lead id not attached to the campaign | 404; nothing saved |
| TC-4 | Validation failure | POST `custom_fields` with 201 keys | 422 naming `custom_fields` and stating the 200-field cap |
| TC-5 | Rate limited | Update 300 leads in a loop | 429 on some; retries settle and every intended update lands once |
| TC-6 | Empty result set | Open the custom fields view on a lead with none | 200 with an empty object; the panel shows "No custom fields" and an add action |
| TC-7 | Email change | Change `email` on a lead with an open thread | Requires confirmation; the old thread keeps its address; future sends use the new one |
| TC-8 | Duplicate email | Set `email` to another lead's address | Rejected with a duplicate error offering a merge |
| TC-9 | Stale draft | Update the company name with a draft pending | The draft is flagged out of date in Needs your OK with a recompose action |
| TC-10 | Score recalculation | Update a job title from "Intern" to "Head of Operations" | The ICP score changes and the new reason mentions the title |
| TC-11 | Partial update atomicity | Send one valid and one invalid field together | Nothing is saved; the error names the invalid field |
| TC-12 | Merge field rendering | Update a first name, then send a test email | The composed email uses the new name |

## 4. Frontend user story

**As a** campaign owner, **I want** to edit a lead in place from wherever I notice the mistake, **so that** fixing a typo does not mean leaving the campaign I am reviewing.

**Scope**
- Leads page: the lead detail panel becomes editable, with fields for name, company, phone, website, location, LinkedIn and company URL, plus a custom-fields key-value editor.
- Campaign detail and Inbox thread view: an "Edit lead" action opening the same panel, so the fix is one click from where the problem was spotted.
- Changing the email address opens a short confirmation explaining what happens to existing threads.
- Loading disables save; validation errors appear against the field; nothing typed is lost on failure. If a draft is pending, a notice above the save button says it will be flagged for recompose.
- Accessibility: a labelled form with grouped sections; custom fields are rows of paired labelled inputs with an accessible remove button per row; errors are tied to fields with `aria-describedby`. On mobile the panel is a full-height sheet with a pinned save.

**Definition of done**
- [ ] The same panel serves Leads, campaign detail and Inbox.
- [ ] Email changes always require confirmation.
- [ ] Custom fields can be added, edited and removed without a page reload.
- [ ] A pending draft is visibly flagged after an update that affects it.

## 5. Backend user story

**As a** Harry server, **I want** one validated update route for lead details, **so that** corrections propagate to composition, scoring and reporting from a single source.

**Scope**
- Add `PATCH /api/leads/:id` to `server/routes.js` (workspace-scoped), plus the campaign-context entry point `POST /api/campaigns/:id/leads/:leadId` that delegates to it.
- Data model: existing `leads` table; custom fields stored as JSON with a 200-key cap enforced server-side and a key-name character allow-list.
- Enforce email uniqueness within the workspace and return a merge affordance rather than a bare conflict.
- On save, mark any queued draft for that lead as stale and enqueue a re-score against the linked goal's ICP.
- Write an `events` row recording which fields changed (names only, not values, for phone and email), and a `telemetry` row for the call.

**Definition of done**
- [ ] Updates are atomic — one invalid field means nothing is written.
- [ ] Custom-field cap and key validation are tested.
- [ ] Email uniqueness is tested, including the merge path.
- [ ] Re-scoring after an update is proven by a test.

## 6. End-to-end test ticket

**Title:** E2E — correct a lead's details mid-campaign

**Preconditions:** A workspace with a sandbox mailbox, one running campaign linked to a goal with an ICP, three leads including one with a misspelled first name and a pending draft, and one lead whose email matches the address to be tested for duplication.

**Flow**
1. Sign in, open Inbox → Needs your OK, note the pending draft's greeting.
2. Open the lead from the campaign and correct the first name and job title.
3. Return to Needs your OK.
4. Recompose the draft and read the greeting.
5. Attempt to change the lead's email to the other lead's address.
6. Open the Leads page and check the qualification score.

**Assertions**
- [ ] The corrected name is visible on the lead in all three surfaces.
- [ ] The pending draft is flagged as out of date after step 2.
- [ ] The recomposed draft greets the lead with the corrected name.
- [ ] Step 5 is rejected with a duplicate error offering a merge.
- [ ] The qualification score and its reasons reflect the new job title.

**Teardown:** Delete the campaign and leads; clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | Detail panel becomes editable, adds a custom-fields editor | Medium | Fields are read-only until an explicit Edit; custom fields are collapsed when empty |
| Campaign detail / Inbox | "Edit lead" opens the same panel | Low | No new UI, just an entry point |
| Inbox Needs your OK | Stale-draft flag with recompose | Low | One line on the affected draft only |

**Verdict:** Fits an existing surface

The Leads page already shows every one of these fields; making the panel editable is the smallest possible change and removes the current workaround of re-importing a CSV. The one genuinely new element is the stale-draft flag, and it earns its place because an approved email built on stale data is exactly the failure the approval queue exists to prevent.
