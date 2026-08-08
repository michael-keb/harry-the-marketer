# Create Lead List

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/lead-list/` |
| **Category** | lead-lists |
| **Source** | https://api.smartlead.ai/api-reference/lead-lists/create |
| **Auth** | API key (query param `api_key`) |

Creates a new named group that leads can be put into and kept in, separately from any campaign.

## 1. Epic

**Reusable lead segments**

Lets a Harry user keep a named, reusable group of prospects — "Australian SaaS running Jira", "Warm from the October webinar" — that outlives any one campaign and can be researched, scored, renamed and pushed at a campaign whenever it is needed. It matters because Harry's Leads page is one flat table today: every new campaign starts by re-finding the same people by hand, and there is nowhere to record that a particular set of thirty is the set worth chasing.

## 2. User story

**As a** campaign owner, **I want** to create a named segment for a group of prospects, **so that** I can gather people once and reuse them across campaigns instead of rebuilding the same selection each time.

**Acceptance criteria**
- [ ] Given a `listName` such as "Q1 2025 Enterprise Prospects", when I create the segment, then a 200 returns `data.id`, `data.name` and `data.created_at`, and the segment appears in the segments view straight away.
- [ ] Given an empty or whitespace-only `listName`, when I submit, then a 422 with a field-level message on `listName` is returned and nothing is created.
- [ ] Given a name that already exists in my workspace, when I submit, then I am told the name is taken and offered the existing segment, rather than ending up with two segments that look identical.
- [ ] Given a name longer than the allowed length, when I submit, then a 422 names `listName` and states the limit; the typed name is preserved in the field.
- [ ] Given a segment is created, when I view it, then it shows a lead count of zero and an empty state that offers the two ways to fill it — add existing leads or import a CSV.
- [ ] Given a segment is created, when I look at the activity trail, then there is one entry naming the actor, the segment name and the time.
- [ ] Given I am a team member rather than the owner, when I create a segment, then it belongs to the shared workspace and every member can see and use it.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"listName":"Q1 2025 Enterprise Prospects"}` | 200 with `data.id`, `data.name` echoing the input, and an ISO `data.created_at` |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; the typed name is kept and a sign-in prompt is shown |
| TC-3 | Not found / wrong workspace | Create while the session's workspace has been removed | 404; no segment created, user returned to sign-in |
| TC-4 | Validation failure — empty name | POST `{"listName":""}` | 422 with a field-level message on `listName`; the create dialog stays open |
| TC-5 | Rate limited | POST 40 creates in quick succession | 429 on the excess; the client backs off and retries, no partial or duplicate segments |
| TC-6 | Empty result set | Open the segments view in a brand-new workspace | 200 with an empty array; "No segments yet — create one to group leads you will reuse" |
| TC-7 | Duplicate name | POST the same `listName` twice | Second call is refused with a message naming the existing segment and a link to open it |
| TC-8 | Name needing trimming | POST `{"listName":"  Warm leads  "}` | 200 and the stored `data.name` is "Warm leads" with surrounding whitespace removed |
| TC-9 | Missing body field | POST `{}` | 400 for the malformed body; message states `listName` is required |
| TC-10 | Unicode and punctuation | POST `{"listName":"Køln — Q1 (tier 1)"}` | 200; the name renders unchanged in the segments view and in filter chips |

## 4. Frontend user story

**As a** campaign owner, **I want** a one-field way to name a new segment from where I am already looking at leads, **so that** grouping people costs me one dialog and no thinking.

**Scope**
- Leads page: a "Segments" panel beside the existing stage filter strip, with a "New segment" button opening a single-field dialog — name, Create, Cancel.
- The same dialog is reachable from the Leads table's bulk action bar as "Add to segment → New segment", so the segment can be created and filled in one move.
- States: submit is disabled while the name is empty; the button shows a pending state during the call; a duplicate-name error renders inline under the field with a link to the existing segment; the freshly created segment is selected and shown with its zero-lead empty state.
- Accessibility: the dialog traps focus, the field has a real `<label>`, errors are tied to the input with `aria-describedby`, and Escape cancels. Responsive: the dialog is a bottom sheet under 640px, and the Segments panel collapses to a dropdown.

**Definition of done**
- [ ] A segment can be created in one dialog with one field.
- [ ] The new segment is visible and selected without a page reload.
- [ ] Duplicate names are caught before a second lookalike segment can exist.
- [ ] No new item is added to the product navigation.

## 5. Backend user story

**As a** Harry API, **I want** a route that creates a workspace-scoped named segment, **so that** the front end has a stable id to attach leads, labels and campaign pushes to.

**Scope**
- Route in `server/routes.js`: `POST /api/lead-lists` taking `{ name }` and returning `{ id, name, createdAt, leadCount: 0 }`, following the workspace-scoped handler pattern already used for campaigns.
- Data model: a new `lead_lists` table in `server/db.js` (`id`, `workspace_id`, `name`, `created_at`, `updated_at`) with a unique index on `(workspace_id, lower(trim(name)))`, plus a `lead_list_leads` join table for membership. Lead count is derived by a join, never stored, so it cannot drift — the same rule the stage tracker already follows.
- Names are trimmed and length-capped server-side; the uniqueness violation is translated into a friendly response carrying the existing segment's id so the UI can link to it.
- No pagination on create. Standard app rate limiting applies; the client retries 429 with backoff.
- Logged: an `events` row (actor, segment id, name); `telemetry` records creation counts so Monitoring can show whether segments are actually being used.

**Definition of done**
- [ ] Segments are workspace-scoped and visible to every team member of that workspace.
- [ ] Name uniqueness is enforced case- and whitespace-insensitively at the database level.
- [ ] Lead count is always derived, never a stored counter.
- [ ] Tests cover creation, the duplicate-name path, and cross-workspace isolation.

## 6. End-to-end test ticket

**Title:** E2E — Create a segment and see it ready to fill

**Preconditions:** A signed-in workspace with at least 20 leads on the Leads page and no existing segments.

**Flow**
1. Open Leads.
2. Click New segment in the Segments panel.
3. Type "Q1 2025 Enterprise Prospects" and create.
4. Read the empty state.
5. Repeat step 2 with the same name.

**Assertions**
- [ ] The segment appears in the panel with a lead count of 0 and no page reload.
- [ ] The empty state offers both "Add existing leads" and "Import a CSV".
- [ ] The second attempt is refused inline with a link that opens the first segment.
- [ ] The activity trail has exactly one creation entry.
- [ ] A second team member signing in sees the same segment.

**Teardown:** Delete the segment.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | A Segments panel beside the existing stage filter strip | Medium | It reuses the filter-strip pattern users already know; selecting a segment filters the same table rather than opening a new view |
| Leads bulk action bar | "Add to segment → New segment" | Low | One extra item in a menu that only appears when rows are ticked |
| Product navigation | None | Low | Segments deliberately live inside Leads — no new nav item |

**Verdict:** Fits an existing surface

Segments are a way of filtering the lead table the user already has, so they belong next to the stage strip on the Leads page rather than behind a new navigation item. The one honest cost is that the Leads page now has two filtering mechanisms side by side — stage, which is derived, and segment, which is chosen — so the panel must label them plainly so nobody has to work out the difference.
