# Get Custom View Emails

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/master-inbox/views` |
| **Category** | inbox |
| **Source** | https://api.smartlead.ai/api-reference/inbox/get-views |
| **Auth** | API key (query param `api_key`) |

Runs a saved combination of inbox filters, so a segment you look at every day is one click instead of six.

## 1. Epic

**Unified reply inbox and lead triage**

One place where every reply, every draft awaiting a human, and every decision about a lead lives — read it, answer it, reroute it, park it, hand it to a colleague, or stop it. It matters because Harry's standing rule is that nothing sends without the user's OK, and the Inbox is where that OK is given and where the consequences of a reply are acted on.

## 2. User story

**As a** team member who checks the same slice of the Inbox every morning, **I want** to save a filter combination and give it a name, **so that** "interested replies on the Q1 campaign assigned to me" is one click rather than six controls set from memory.

**Acceptance criteria**
- [ ] Given a saved view, when I run it, then it applies its stored `filters` and `sortBy` and returns the same shape as the main replies list, paginated with `limit` 1–20 and `offset`.
- [ ] Given views accept single values for `campaignId`, `emailAccountId`, `campaignTeamMemberId`, `campaignTagId` and `campaignClientId` — unlike the multi-value replies endpoint — when I save a view, then the UI offers a single choice for each and states why.
- [ ] Given `filters.subSequenceId`, unique to views, when I filter by it, then only leads currently in that branch of the playbook return — in Harry this is a playbook node or sub-flow, so the filter is "leads sitting at node X".
- [ ] Given `filters.leadCategories` with `categoryIdsIn` or `categoryIdsNotIn` (max 10 each), `unassigned` or `isAssigned`, when I save a view, then those choices persist and are re-applied exactly on each run.
- [ ] Given a saved view's underlying campaign or mailbox is deleted, when I run it, then the view reports which filter no longer resolves and offers to edit it, rather than silently returning everything.
- [ ] Given a saved view, when a teammate opens the Inbox, then they see the same workspace views, because the workspace shares its inbox.
- [ ] Given no saved views, when I open the Inbox, then no view control is shown at all and the Inbox looks exactly as it does today.
- [ ] Given I create, rename or delete a view, when it completes, then the change is written to the activity trail with the actor.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"offset": 0, "limit": 20, "filters": {"emailStatus": "Replied", "campaignId": 12345, "leadCategories": {"categoryIdsIn": [1]}, "subSequenceId": 789}, "sortBy": "REPLY_TIME_DESC"}` | 200 with rows matching every filter, sorted newest reply first, plus `total_count` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401; UI shows "Your session expired — sign in again" |
| TC-3 | Not found / wrong workspace | Run a view whose `campaignId` belongs to another workspace | 404 or an empty result with no cross-workspace rows; the view is flagged as needing repair |
| TC-4 | Validation failure — limit | POST `limit: 40` | 422 naming `limit` and the 1–20 range |
| TC-5 | Rate limited | Switch between views rapidly | 429 on the excess; client backs off with jitter and keeps the current results visible |
| TC-6 | Empty result set | Run a view whose combination matches nothing today | 200, empty list, `total_count: 0`; empty state names the view and offers "Edit filters" and "Clear view" |
| TC-7 | Single-value enforcement | Try to save a view with two campaign ids | Rejected with a field-level message; the picker allows only one campaign for views and explains the difference from the ad-hoc filter bar |
| TC-8 | Category exclusion | Save a view with `categoryIdsNotIn: [3, 4]` (not interested, do not contact) | Those categories never appear in the results |
| TC-9 | Broken filter repair | Delete the campaign a saved view points at, then run it | The view states which filter no longer resolves and offers to edit; it does not fall back to unfiltered results |
| TC-10 | Playbook-node filter | Save a view filtered to leads sitting at one playbook node, then advance one lead past that node | The advanced lead leaves the view on the next run without the view being edited |
| TC-11 | Shared views | Member A saves a view; member B opens the Inbox | B sees the same view in the list with A named as its author |
| TC-12 | No views, no control | Open the Inbox on a workspace with zero saved views | No view selector renders; the Inbox is unchanged from today |

## 4. Frontend user story

**As a** team member, **I want** to save the filter combination I am looking at and name it, **so that** my daily slices of the Inbox are named things I pick, not settings I rebuild.

**Scope**
- Inbox → Replies: once filters are set, a "Save this view" action appears in the filter bar. Saved views render as a compact list at the top of the filter bar; picking one applies its filters and sort and shows the name as the current context with a Clear action.
- Editing a view is editing its filters and pressing Save again; renaming and deleting live in the view's own small menu. Views are workspace-shared and show their author.
- A broken view (its campaign or mailbox gone) renders with a "Needs attention" note and an Edit action, never silently unfiltered results.
- Loading: skeleton rows while a view runs; the view name stays visible so context is never lost. Empty: the view's name plus "No replies match right now" with Edit filters. Error: inline banner with Retry.
- Accessibility: views are a labelled list of buttons with the active one marked by `aria-current`; saving prompts for a name in a labelled modal with focus trap; the active view name is announced on change. Responsive: views collapse into the Filters sheet under 768px with the active name shown on the trigger.

**Definition of done**
- [ ] A view can be saved from the current filters, applied, edited, renamed and deleted.
- [ ] Views are shared across the workspace and show who made them.
- [ ] A view with an unresolvable filter says so rather than returning everything.
- [ ] With zero views, no view UI appears anywhere; verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** saved filter sets stored per workspace and executed through the shared inbox query, **so that** a view is a stored argument list, not a second query engine.

**Scope**
- Routes in `server/routes.js`: `GET /api/inbox/views`, `POST /api/inbox/views` taking `{ name, filters, sort }`, `PATCH /api/inbox/views/:id`, `DELETE /api/inbox/views/:id`. Running a view is the existing `GET /api/inbox/threads` with the stored arguments expanded server-side, so there is exactly one query path.
- Data model: an `inbox_views` table in `server/db.js` (`workspace_id`, `name`, `filters` as validated JSON, `sort`, `created_by`, `created_at`), with a unique constraint on (`workspace_id`, `name`) so two views cannot share a name.
- Validation on save, not only on run: every id in `filters` must resolve inside the workspace, single-value fields must be single, category arrays capped at 10, search capped at 30 characters. A stored filter that later stops resolving is reported as a broken view rather than dropped.
- The playbook-node filter (`subSequenceId` in the source API) maps to Harry's playbook node id, so "leads sitting at this step" reuses the node-performance data the campaign page already computes.
- Pagination, ceilings and 429 handling are inherited from the shared inbox route; no view-specific limits are introduced.
- Logged: an `events` row per view created, edited, renamed or deleted with the actor; `telemetry` records which views are run most so Monitoring can show whether views are actually used before more are built.

**Definition of done**
- [ ] Views table, uniqueness constraint and four routes exist, covered by tests including cross-workspace 404.
- [ ] A test asserts a view executes through the same query path as ad-hoc filters and returns identical rows.
- [ ] A test asserts a view with a deleted campaign is reported broken, never silently unfiltered.
- [ ] View creation and deletion appear in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Save a daily inbox slice and rely on it

**Preconditions:** A workspace with two members, a sandbox mailbox, two running campaigns, twelve leads that have replied with mixed intents, several sitting at different playbook nodes.

**Flow**
1. Member A opens Inbox → Replies and sets filters: campaign Q1, intent interested, assigned to A, sorted by newest reply.
2. A saves the view as "My hot Q1 replies".
3. A clears filters, then re-applies the view from the saved list.
4. Member B signs in and opens the Inbox.
5. A edits the view to exclude the "not interested" category and saves.
6. An administrator deletes campaign Q1; A runs the view again.

**Assertions**
- [ ] Saving asked for a name and the view appeared immediately with A as author.
- [ ] Re-applying the view reproduced the exact same rows and sort as the ad-hoc filters did.
- [ ] B saw the same view in the list and running it returned the same rows.
- [ ] After the edit, "not interested" replies no longer appear and the change is in the activity trail.
- [ ] After the campaign is deleted, the view reports that its campaign filter no longer resolves and offers to edit it, showing no unfiltered results.

**Teardown:** Delete the view, the campaigns and the leads; reset the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Inbox → Replies | Saved views list and a Save this view action in the filter bar | High | Nothing renders until a workspace saves its first view; views live inside the existing filter bar, not as navigation |
| Inbox filter bar | Active view name shown as context with a Clear action | Low | One line of text replacing a row of filter chips, which is a net reduction |
| Dashboard activity trail | View entries appear | Low | One more event type in a mixed feed |
| Monitoring | View usage telemetry | Low | One line in the existing telemetry list, and the honest check on whether this feature earns its place |

**Verdict:** Fits an existing surface

Saved views only make sense once the shared filter bar exists, and their whole value is removing controls from the screen rather than adding them — so the risk is building a second navigation nobody asked for. Keeping the feature invisible until a user saves their first view, and reusing the exact same query path, means it costs nothing for the many workspaces that never need it.
