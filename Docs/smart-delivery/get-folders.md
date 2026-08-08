# Get All Folders

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/folder` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/get-folders |
| **Auth** | API key (query param `api_key`) |

Lists every folder used to group deliverability tests in the workspace.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner with a year of test history, **I want** to see all my deliverability folders in one list, **so that** I can jump straight to the quarter or domain I care about.

**Acceptance criteria**
- [ ] Given folders exist, when I fetch the list, then I get an array of records each with `id`, `name`, `user_id`, `client_id`, `created_at` and `updated_at`.
- [ ] Given the list is returned, when it renders, then folders are ordered most recently updated first, so a folder touched today ("Q1 2026 Tests", `updated_at` 2026-03-15) sits above one last touched at the end of last year ("Q4 2025 Archive").
- [ ] Given a folder is selected, when the list renders, then the current folder is marked as current and the test list is filtered to it.
- [ ] Given no folders exist, when the list renders, then the sidebar shows "No folders yet" with the inline create field, not an empty box.
- [ ] Given the workspace has many folders, when the list renders, then it is scrollable within its own container and searchable by name once past a threshold, without paginating.
- [ ] Given my session has expired, when I fetch the list, then the API returns 401 `{"message": "Invalid API Key"}` and the sidebar shows the signed-out state rather than a stale list.
- [ ] Given a fetch fails, when the sidebar renders, then the last known folder list is shown with a quiet "not up to date" note, because losing the sidebar entirely would strand the user.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET the folder route for a workspace with two folders | 200; array with `folder_001` "Q1 2026 Tests" and `folder_002` "Q4 2025 Archive", each carrying all six documented fields |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; signed-out state; no cached list displayed as current |
| TC-3 | Not found / wrong workspace | GET while scoped to a workspace the user has left | 404 `{"error": "Resource not found"}`; UI returns to the workspace picker |
| TC-4 | Validation failure | GET with an unsupported filter parameter appended | 422 `{"error": "Invalid parameters provided"}`; the offending parameter is dropped and logged to telemetry |
| TC-5 | Rate limited | Reload the Deliverability page repeatedly | 429 on the excess; client backs off with jitter and renders the cached list meanwhile |
| TC-6 | Empty result set | GET in a workspace with no folders | 200 with `[]`; sidebar shows "No folders yet" and the inline create field |
| TC-7 | Ordering | Two folders with `updated_at` 2026-03-15 and 2025-12-31 | The 2026 folder is listed first |
| TC-8 | Many folders | A workspace with 60 folders | The sidebar scrolls in its own container, a name filter appears, and the page itself does not scroll horizontally |
| TC-9 | Cross-workspace isolation | Create a folder in workspace A, list in workspace B | Workspace B's list does not contain it and does not reveal its name |
| TC-10 | Upstream unavailable | Provider returns 503 | Cached list shown with a "not up to date" note; retried on the next load; no error modal |

## 4. Frontend user story

**As a** mailbox owner, **I want** the folder list always present beside my deliverability tests, **so that** switching context is one click and I always know which folder I am in.

**Scope**
- Monitoring → Deliverability: the folder sidebar renders this list with "All tests" pinned first, each folder showing its name and test count; under 900px it becomes a select above the list.
- Each folder row links to its own URL so the current selection survives a reload.
- Loading: three skeleton rows. Empty: "No folders yet" with the inline create field already visible. Stale: the cached list with a quiet note. Error on first ever load: a short message with a retry.
- A name filter appears only once the workspace has more folders than fit comfortably, so a small workspace never sees a search box it does not need.
- Accessibility: the sidebar is a labelled navigation list; the current folder carries `aria-current`; counts are part of each link's accessible name. Responsive: the select layout keeps the same ordering and the same current-selection marker.

**Definition of done**
- [ ] The list renders with counts and orders by most recently updated.
- [ ] The current folder is unambiguous in both the sidebar and the select layout.
- [ ] The filter appears only past the threshold and filters without a server call.
- [ ] Loading, empty, stale, error and many-folders states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that lists the workspace's deliverability folders with test counts, **so that** the sidebar renders in one call.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/folders`, workspace-scoped, returning `id`, `name`, `createdAt`, `updatedAt` and `testCount`, ordered by `updated_at` descending.
- Data model: reuses `deliverability_folders` and the `folder_id` column on `deliverability_tests` from the create-folder ticket; the count is a single grouped query, not one query per folder.
- No pagination — folders are counted in tens, and the client filters by name locally. `user_id` and `client_id` from the upstream shape are mapped to Harry's workspace owner and workspace id and never returned raw.
- Rate limiting: standard app limiter; the response is cached briefly per workspace so a page with several mounted components does not fetch it repeatedly. Upstream 429 and 503 back off with jitter and the cached list is served.
- Logged: nothing to `events` for a read; `telemetry` records latency and failure rate so Monitoring can grade the deliverability service.

**Definition of done**
- [ ] A folder from another workspace never appears, covered by a test.
- [ ] Counts come from one grouped query — asserted by a test that fails on N+1 queries.
- [ ] Ordering is by `updated_at` descending and is stable for equal timestamps.
- [ ] Reads write nothing to the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Navigate deliverability tests by folder

**Preconditions:** A workspace with two folders — "Q1 2026 Tests" holding two completed placement tests and "Q4 2025 Archive" holding one — plus one unfiled test. A second workspace with its own folder.

**Flow**
1. Open Monitoring → Deliverability.
2. Read the sidebar.
3. Select "Q4 2025 Archive", then "All tests".
4. Reload the page while "Q1 2026 Tests" is selected.
5. Sign in to the second workspace and open the same page.

**Assertions**
- [ ] The sidebar lists "All tests", then "Q1 2026 Tests" (2), then "Q4 2025 Archive" (1) — most recently updated first.
- [ ] Selecting a folder filters the list to exactly its tests and marks it as current.
- [ ] "All tests" shows all four tests including the unfiled one.
- [ ] The reload keeps "Q1 2026 Tests" selected.
- [ ] The second workspace's sidebar shows only its own folder and none of the first workspace's names.

**Teardown:** Remove both folders and the four test fixtures.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability | Folder sidebar with counts, plus a conditional name filter | Low | Hidden entirely when a workspace has no folders; "All tests" is the default and always first |

**Verdict:** Fits an existing surface

This is the read half of the folder feature and adds nothing the create ticket did not already introduce — the same sidebar, now populated. It stays honest by disappearing in workspaces that never file anything, which is most of them. No new navigation item and no new page.
