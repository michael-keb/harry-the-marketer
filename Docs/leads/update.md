# Update Lead

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads/{id}` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/update |
| **Auth** | API key (query param `api_key`) |

Changes a person's contact details and custom fields, everywhere at once — the change is not scoped to the campaign it was made from.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** to correct a person's details and add custom fields, with it clear that the change applies everywhere, **so that** a typo in a first name is fixed once rather than campaign by campaign.

**Acceptance criteria**
- [ ] Given a lead, when I edit them, then I can change first name, last name, phone number, company name, website, location, LinkedIn profile, company URL and custom fields.
- [ ] Given the edit is saved, when it applies, then it applies to the person record across every campaign they are in, and the form says so before I save, not after.
- [ ] Given custom fields, when I save, then new keys are merged with the existing ones rather than replacing the whole object, and the 200-key limit is enforced with a field-level message.
- [ ] Given I change the email address, when I save, then it is checked against the workspace for a clash and against the suppression list, and changing it to an unsubscribed address is refused.
- [ ] Given the lead has emails already drafted and waiting in Needs your OK, when I change details the composer used, then the affected drafts are flagged as stale so I re-read them before approving rather than sending an email with the old name in it.
- [ ] Given the lead has a research profile, when I change the company name or website, then the profile is marked as needing a refresh rather than being silently kept or silently deleted.
- [ ] Given the edit succeeds, when I read the activity trail, then one entry names the actor and which fields changed, without printing the personal data itself into the log.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Change the company name and add a `department` custom field | 200 with an ok result; the change is visible on the lead detail and in every campaign the person is in |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session | 401; the form keeps the typed values and shows a sign-in prompt |
| TC-3 | Campaign or lead not found / wrong workspace | Save against another workspace's lead id | 404 with an invalid-request error; nothing is written |
| TC-4 | Validation failure — missing email | Save with the email field cleared | 422 with "email is required" against the email field; the source API requires email on every update even when unchanged, and Harry surfaces that as the field never being clearable |
| TC-5 | Rate limited | Save a bulk field edit across 200 leads | 429 on some calls; the bulk edit backs off and completes with a per-lead result |
| TC-6 | Empty result set | Save with no fields changed | 200 with no change recorded and no activity trail entry |
| TC-7 | Custom fields merge | Save one new custom field on a lead that already has two | All three exist afterwards; the existing two are untouched |
| TC-8 | Custom fields over the limit | Save a 201st custom field | 422 with a field-level message naming the 200-key limit |
| TC-9 | Email clash | Change an address to one another lead in the workspace already has | Refused with a message naming the existing lead and offering to merge instead |
| TC-10 | Email changed to a suppressed address | Change an address to one that has unsubscribed | Refused; the suppression outranks the edit and the message says so |
| TC-11 | Stale draft | Change a first name while a draft waits in Needs your OK | The draft is flagged as stale in the queue and requires re-reading before approval |
| TC-12 | Research profile invalidation | Change the company website | The research profile shows "needs refresh" with the existing content still readable |

## 4. Frontend user story

**As a** campaign owner, **I want** to edit a person inline where I am already looking at them, with the scope of the change stated, **so that** I never wonder whether the fix reached the other campaigns.

**Scope**
- Leads → lead detail: an edit form covering the contact fields and a key-value editor for custom fields, with one line stating that changes apply to this person in every campaign.
- Leads: inline editing of the most-corrected fields (first name, company) straight from the row, since typos are usually spotted in the list.
- Inbox → thread: an edit affordance on the lead header for the same reason — the correction is usually prompted by reading their reply.
- Loading: optimistic save with rollback and the reason on failure. Empty: the custom fields editor shows "No custom fields" with an add row. Error: field-level messages against the offending inputs.
- Accessibility: every input has a visible label, the custom fields editor is a real table with add and remove buttons that name the key they act on, and the stale-draft warning is announced. Responsive: the form is single-column under 640px.

**Definition of done**
- [ ] The "applies everywhere" scope is stated before saving, not in a toast afterwards.
- [ ] Custom fields merge rather than replace, and the editor shows the current count against the 200 limit.
- [ ] Drafts affected by the edit are flagged as stale in Needs your OK.
- [ ] The research profile is marked for refresh, never silently discarded, when company details change.

## 5. Backend user story

**As a** Harry API, **I want** a lead update route that validates against the workspace and invalidates what the edit affects, **so that** a correction never leaves a half-updated draft or a research profile describing a different company.

**Scope**
- Route in `server/routes.js`: `POST /api/leads/:id` taking the contact fields and `customFields`, workspace-scoped. A campaign-scoped alias `POST /api/campaigns/:campaignId/leads/:leadId` mirrors the source API's shape but writes the same person record and records the campaign as the context in the trail.
- Data model: updates `leads` in `server/db.js`; custom fields are merged into the stored JSON, capped at 200 keys. Email changes revalidate the case-insensitive workspace uniqueness index and the suppression list.
- Side effects in the same transaction: pending `drafts` for this lead are marked stale; the research profile row is marked as needing a refresh when company name, website or company URL changes.
- No pagination. Standard rate limiting; the bulk edit client retries 429 with backoff and reports per-lead results.
- Logged: an `events` row naming the actor and the changed field names only, not the values, so the trail is useful without becoming a second copy of personal data. `telemetry` records how often edits invalidate a draft, which is a signal that data quality at import is poor.

**Definition of done**
- [ ] Custom fields merge, verified by a test with pre-existing keys.
- [ ] Email uniqueness and suppression are enforced on change, covered by tests.
- [ ] Stale-draft and profile-refresh flags are set in the same transaction as the update.
- [ ] The activity trail records field names, never field values.

## 6. End-to-end test ticket

**Title:** E2E — Correct a lead's details and confirm the drafts and profile react

**Preconditions:** A workspace with one sandbox mailbox, two campaigns containing the same lead, a draft for that lead waiting in Needs your OK, a research profile on the lead, and a second lead whose address will be used for the clash test.

**Flow**
1. Leads → open the lead → edit the first name (fixing a typo) and the company website.
2. Add a custom field `department`.
3. Open Inbox → Needs your OK.
4. Open the lead's research profile.
5. Open the second campaign and check the lead's details there.
6. Try to change the lead's email to the second lead's address.
7. Open the Dashboard activity trail.

**Assertions**
- [ ] The corrected name shows in both campaigns without a further edit.
- [ ] The existing custom fields survive and `department` is added alongside them.
- [ ] The waiting draft is flagged as stale and the old name is visible in it, so the reason for re-reading is obvious.
- [ ] The research profile reads "needs refresh" and its previous content is still readable.
- [ ] The email change is refused with a message naming the second lead and offering to merge.
- [ ] The activity trail lists the changed field names and not their values.

**Teardown:** Delete both campaigns and both leads; discard the stale draft.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → lead detail | Edit form plus custom fields editor | Medium | One form on a page that already shows these fields read-only; the custom fields editor is collapsed when empty |
| Leads | Inline edit for name and company from the row | Low | Only appears on hover or focus of the cell |
| Inbox → Needs your OK | Stale badge on affected drafts | Low | A badge on an existing card, no new panel |
| Leads → research profile | "Needs refresh" state | Low | Reuses the refresh control that already exists on the profile |

**Verdict:** Fits an existing surface

Harry's Leads page already has CRUD, so editing exists; what this backlog item really buys is the consequences of an edit — the scope statement, the stale-draft flag, and the research-profile refresh — which are the parts that today would let a corrected name go out in an already-composed email. None of that needs a new page.
