# Add Tags to Lead

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/crm/leads/tags` |
| **Category** | lead-tags |
| **Source** | https://api.smartlead.ai/api-reference/lead-tags/add-to-lead |
| **Auth** | API key (query param `api_key`) |

Puts one or more labels on a single person, so they can be found later by something other than their campaign or stage.

## 1. Epic

**Lead labels across campaigns**

Gives every lead a small set of named, coloured labels the user defines — "VIP", "Enterprise", "Met at a conference" — that cut across campaigns and stages, can be applied in bulk, and can be filtered on anywhere leads are listed. It matters because Harry's stage strip answers "where is this person in the funnel" but nothing answers "why do I care about this person", which is the question that decides who gets chased first.

## 2. User story

**As a** campaign owner, **I want** to put labels on a lead, **so that** I can find that person again by what makes them important rather than by remembering which campaign they were in.

**Acceptance criteria**
- [ ] Given a `leadId` and `tagIds` of one or more existing labels, when I add them, then a 200 returns `{ "ok": true, "message": "Tags added to lead successfully" }` and the labels appear on the lead immediately.
- [ ] Given a label already on that lead, when I add it again, then the call still returns 200 and the label appears exactly once — repeating is safe and produces no second mapping row.
- [ ] Given `tagIds` containing an id that does not exist or belongs to another workspace, when I submit, then a 404 identifies the rejected id and none of the labels in the request are applied.
- [ ] Given a `leadId` from another workspace, when I submit, then a 404 is returned and no label is applied; the lead's name is not leaked in the error.
- [ ] Given `tagIds` is empty or missing, when I submit, then a 422 names `tagIds` as required.
- [ ] Given labels are added, when the composer next writes an email for that lead, then the labels are visible to the user on the lead but do not silently change what the agent writes — labelling is organisation, not instruction.
- [ ] Given labels are added, when I look at the lead's activity trail, then one entry records who added which labels and when.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"leadId":123,"tagIds":[1,2,3]}` | 200, `{"ok":true,"message":"Tags added to lead successfully"}`; three labels on lead 123 |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; no label applied, the picker keeps its selection |
| TC-3 | Lead not found / wrong workspace | POST with another workspace's `leadId` | 404; nothing written, no lead details in the body |
| TC-4 | Validation failure | POST `{"leadId":123,"tagIds":[]}` | 422 with a field-level message naming `tagIds` |
| TC-5 | Rate limited | Tag 200 leads one after another | 429 on the excess; the client backs off and retries, every intended lead ends up tagged once |
| TC-6 | Empty result set | Filter the Leads table by a label no lead carries | 200 with an empty list; "No leads carry this label yet" empty state |
| TC-7 | Repeat add | Run TC-1 twice | 200 both times; the lead shows three labels, not six |
| TC-8 | Unknown tag id | POST `{"leadId":123,"tagIds":[1,999999]}` | 404 naming 999999; label 1 is not applied either — the call is all-or-nothing |
| TC-9 | Bulk tagging from the table | Tick 50 rows and apply two labels | All 50 leads carry both labels; one activity entry summarises the bulk action |
| TC-10 | Unsubscribed lead | Add a label to an unsubscribed lead | 200; the label applies but the lead is still excluded from every send, and the UI says so |
| TC-11 | Concurrent add | Two team members add the same label to the same lead at once | Both return 200; the lead carries the label once |

## 4. Frontend user story

**As a** campaign owner, **I want** to add labels from the lead detail and from a multi-row selection, **so that** tagging one person and tagging fifty feel like the same action.

**Scope**
- Leads page → lead detail: a labels row under the lead's name showing existing labels as chips with a "+" that opens a searchable picker of the workspace's labels, plus "Create label" inline.
- Leads table bulk action bar (already shown when rows are ticked): "Labels", opening the same picker with three-state checkboxes so a bulk add does not accidentally strip labels from rows that already have them.
- The same chips render read-only in Inbox thread headers and the Dashboard Action Center, so a labelled lead is recognisable wherever it turns up.
- States: optimistic chip insertion with revert on failure; pending disables the picker item being toggled, not the whole picker; error keeps the picker open with the server message.
- Accessibility: chips carry their name as text, never colour alone; the picker is a searchable listbox with `aria-multiselectable`; additions are announced via `aria-live="polite"`. Responsive: the picker is a bottom sheet under 640px and chips wrap rather than scroll.

**Definition of done**
- [ ] Single-lead and bulk tagging use one picker component and one request shape.
- [ ] Labels are always identifiable without seeing colour.
- [ ] A failed add visibly removes the optimistic chip.
- [ ] Labels appear on the lead everywhere the lead appears.

## 5. Backend user story

**As a** Harry API, **I want** a route that maps labels onto a lead idempotently, **so that** tagging is safe to retry and a bulk action cannot half-apply.

**Scope**
- Route in `server/routes.js`: `POST /api/leads/:id/tags` taking `{ tagIds }`, plus a bulk sibling `POST /api/leads/tags` taking `{ leadIds, tagIds }`, both workspace-scoped from the session.
- Data model: a `lead_tags` join table in `server/db.js` (`id`, `workspace_id`, `lead_id`, `tag_id`, `created_at`) with a unique constraint on `(lead_id, tag_id)`. The row's own `id` is the mapping id the removal route needs, mirroring the source API's `tag_mapping_id`.
- Every `tagId` and `leadId` is verified against the caller's workspace before any write; an unknown id aborts the whole request in one SQLite transaction, so a partial apply is impossible.
- No pagination on this route. Standard app rate limiting; the client backs off on 429 and retries, which is safe because of the unique constraint.
- Logged: an `events` row per call (actor, lead ids, label ids) — one row for a bulk action, not one per lead; `telemetry` records tagging volume so Monitoring can show whether labels are actually used.

**Definition of done**
- [ ] Adding the same label twice creates one row and returns 200.
- [ ] Unknown or cross-workspace ids return 404 with nothing written.
- [ ] The bulk route shares its validation and write path with the single-lead route.
- [ ] Tests cover idempotency, the all-or-nothing rule, and workspace isolation.

## 6. End-to-end test ticket

**Title:** E2E — Label a lead and find them again by that label

**Preconditions:** A workspace with 60 leads across two campaigns, labels "VIP" and "Enterprise" already created, and one lead who has replied.

**Flow**
1. Open Leads → the replying lead's detail.
2. Add "VIP" from the labels row.
3. Go back to the Leads table, tick 20 rows, apply "Enterprise" in bulk.
4. Filter the table by "VIP".
5. Open Inbox and find the replying lead's thread.

**Assertions**
- [ ] The VIP chip appears on the lead detail without a reload.
- [ ] All 20 bulk-tagged leads carry "Enterprise" and the pre-existing "VIP" on the overlapping lead is untouched.
- [ ] Filtering by "VIP" returns exactly the one lead.
- [ ] The Inbox thread header shows the same chips as the lead detail.
- [ ] The activity trail shows one entry for the single add and one for the bulk add.
- [ ] Re-applying "VIP" to the same lead changes nothing and shows no error.

**Teardown:** Remove both labels from the affected leads.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads → lead detail | A labels row with chips and a "+" picker | Low | One row under the name; hidden entirely when the workspace has no labels |
| Leads table bulk action bar | "Labels" with three-state checkboxes | Medium | The bar already exists and only appears when rows are ticked |
| Inbox thread header, Action Center | Read-only chips | Low | Chips only, no controls, and nothing renders when a lead has no labels |

**Verdict:** Fits an existing surface

Labels attach to a record the user is already looking at, so the picker belongs on the lead detail and in the bulk action bar rather than anywhere new. The real risk is visual noise on the Leads table, which is why chips are read-only outside the detail view and the whole row disappears when a workspace has never created a label.
