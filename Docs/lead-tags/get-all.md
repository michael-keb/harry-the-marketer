# Get Lead Tags

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/crm/leads/tags` |
| **Category** | lead-tags |
| **Source** | https://api.smartlead.ai/api-reference/lead-tags/get-all |
| **Auth** | API key (query param `api_key`) |

Returns the labels on one person, or every label available in the account when no person is named.

## 1. Epic

**Lead labels across campaigns**

Gives every lead a small set of named, coloured labels the user defines — "VIP", "Enterprise", "Met at a conference" — that cut across campaigns and stages, can be applied in bulk, and can be filtered on anywhere leads are listed. It matters because Harry's stage strip answers "where is this person in the funnel" but nothing answers "why do I care about this person", which is the question that decides who gets chased first.

## 2. User story

**As a** campaign owner, **I want** to see which labels a lead carries and which labels exist to choose from, **so that** both the chips on a record and the picker I choose from come from the same source of truth.

**Acceptance criteria**
- [ ] Given `leadId=123`, when I fetch, then a 200 returns a `data` array where each item has `id`, `tag_mapping_id`, `name` and `color`, and those are the chips shown on the lead.
- [ ] Given `leadId` is omitted, when I fetch, then every label available in the workspace is returned, which is what fills the picker; the two cases are one route with one optional parameter.
- [ ] Given the response carries `tag_mapping_id` alongside `id`, when I remove a label, then the mapping id is what the removal call uses — the UI must keep both, because they are different numbers for the same chip.
- [ ] Given a lead carries no labels, when I fetch, then a 200 with an empty `data` array renders no chip row at all, rather than an empty box.
- [ ] Given a `leadId` from another workspace, when I fetch, then a 404 is returned and no label names are leaked.
- [ ] Given a non-numeric `leadId`, when I fetch, then a 422 states the parameter must be a number.
- [ ] Given labels are used as a filter on the Leads page, when I select one, then the lead table narrows to leads carrying it and the filter combines with the existing stage strip and search rather than replacing them.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path — one lead | `GET /crm/leads/tags?leadId=123` | 200 with two items carrying `id`, `tag_mapping_id`, `name`, `color` (e.g. `{id:1, tag_mapping_id:789, name:"VIP", color:"#FF5733"}`) |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; the chip row shows a retry, not an empty state |
| TC-3 | Lead not found / wrong workspace | `GET ?leadId=` another workspace's lead | 404 with no label names in the body |
| TC-4 | Validation failure | `GET ?leadId=abc` | 422 stating `leadId` must be a number |
| TC-5 | Rate limited | Open 60 lead details in a minute | 429 on the excess; the client backs off and reuses the cached label list for the picker |
| TC-6 | Empty result set | Fetch a lead carrying no labels | 200 with `data: []`; no chip row rendered on the lead detail |
| TC-7 | All labels | `GET /crm/leads/tags` with no `leadId` | 200 with every workspace label, which is what the picker renders |
| TC-8 | Mapping id distinctness | Compare `id` and `tag_mapping_id` for the same chip | They differ; the UI stores both and passes `tag_mapping_id` to the removal call |
| TC-9 | Colour integrity | Fetch a label created with `#4CAF50` | `color` is returned unchanged and the chip's text contrast is computed from it |
| TC-10 | Freshness after tagging | Add a label, refetch the lead | The new label is present with a `tag_mapping_id` usable for removal straight away |
| TC-11 | Label deleted workspace-wide | Delete a label in Settings, refetch a lead that carried it | The label is absent from both the lead and the picker, with no orphan chip |

## 4. Frontend user story

**As a** campaign owner, **I want** labels to show up on leads and to work as a filter, **so that** the marks I put on people actually help me find them.

**Scope**
- Leads page → lead detail: a chip row rendered from the per-lead fetch, each chip carrying its removal handle keyed on `tag_mapping_id`.
- Leads page filters: labels join the existing stage filter strip as a second row of chips. Selecting labels narrows the table, combines with stage and with the search box, and every active filter is removable individually plus a single "Clear all".
- The workspace-wide fetch (no `leadId`) is cached once per session and reused by every picker, so opening a lead detail does not refetch the whole label list.
- States: chips render as skeletons while the lead loads; a lead with no labels renders no row; a failed fetch shows an inline retry rather than pretending the lead has none.
- Accessibility: chips are text plus colour, never colour alone; the filter row is a group of toggle buttons with `aria-pressed`; result counts are announced via `aria-live="polite"`. Responsive: the filter chips wrap and collapse into a "Labels" dropdown under 768px so the strip does not become two lines of scrolling.

**Definition of done**
- [ ] The picker and the lead chips are fed by the same route.
- [ ] Label, stage and search filters compose and clear together.
- [ ] A lead with no labels adds no vertical space to the detail view.
- [ ] `tag_mapping_id` is retained client-side wherever a chip can be removed.

## 5. Backend user story

**As a** Harry API, **I want** one read route that serves both a lead's labels and the workspace's label list, **so that** the front end has a single source of truth and one cache to invalidate.

**Scope**
- Route in `server/routes.js`: `GET /api/tags?leadId=` — with `leadId` it joins `lead_tags` to `tags` and returns `{ id, mappingId, name, color }` per row; without it, it returns every `tags` row where `applies_to` includes leads.
- Data model: reads only. `mappingId` is the `lead_tags` row id, which is what `DELETE /api/leads/tags/:mappingId` consumes; exposing it here is what makes removal a single call.
- Label filtering on the Leads page is served by the existing paginated leads route taking a `tagIds` parameter, not by this route, so label filtering inherits the lead table's paging and sorting for free.
- No pagination here — label counts per workspace are bounded in practice and the endpoint is cached client-side per session. Standard rate limiting; the client backs off on 429 and keeps the cached picker list.
- Logged: no `events` row for a read; `telemetry` records the label-list size per workspace so Monitoring can flag a workspace drowning in labels.

**Definition of done**
- [ ] One route covers both the per-lead and the all-labels case.
- [ ] `mappingId` is always present on the per-lead response.
- [ ] Cross-workspace `leadId` returns 404 with an empty body.
- [ ] Tests cover both modes, the empty case, and that a deleted label leaves no orphan mapping.

## 6. End-to-end test ticket

**Title:** E2E — Filter the lead table by label and read chips on a lead

**Preconditions:** A workspace with 60 leads, labels "VIP" (`#FF5733`) and "Enterprise" (`#4CAF50`), 8 leads carrying "VIP", 3 of those also at stage "replied".

**Flow**
1. Open Leads and read the label filter row under the stage strip.
2. Select "VIP".
3. Add the stage filter "replied".
4. Open one of the remaining leads.
5. Clear all filters.

**Assertions**
- [ ] The label filter row lists both labels with names, not colours alone.
- [ ] Selecting "VIP" narrows the table to 8 rows.
- [ ] Adding "replied" narrows it further to 3 — the filters compose rather than replace.
- [ ] The lead detail shows the same chips with the same colours.
- [ ] Clear all restores 60 rows in one click.
- [ ] A lead carrying no labels shows no chip row at all.

**Teardown:** None — this flow is read-only.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | A label filter row beneath the existing stage strip | Medium | Same chip pattern as the stage strip, collapsing into a dropdown under 768px, and hidden entirely when the workspace has no labels |
| Leads → lead detail | A chip row under the lead's name | Low | Renders nothing when the lead has no labels |
| Inbox, Action Center | Read-only chips on thread headers | Low | Display only, no controls |

**Verdict:** Fits an existing surface

Labels are a filter, and Harry already has a filter strip on the Leads page, so this is a second row of the same component rather than anything new. The honest risk is filter stacking — search, stage and now labels on one page — which is why every active filter must appear as one removable chip with a single Clear all, and why the label row disappears completely for workspaces that never create a label.
