# Create Folder

| | |
|---|---|
| **Endpoint** | `POST https://smartdelivery.smartlead.ai/api/v1/spam-test/folder` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/create-folder |
| **Auth** | API key (query param `api_key`) |

Creates a named folder used to group deliverability tests so a long list of runs stays readable.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner running tests for several domains, **I want** to create a named folder for deliverability tests, **so that** last quarter's runs do not bury this week's.

**Acceptance criteria**
- [ ] Given a folder name, when I create a folder with `{"folderName": "My Folder"}`, then the response returns `id`, `name`, `user_id`, `client_id`, `created_at` and `updated_at`, and the folder appears in the folder list immediately.
- [ ] Given an empty or whitespace-only name, when I submit, then the request is blocked with a field-level message and no folder is created.
- [ ] Given a name that duplicates an existing folder in my workspace, when I submit, then I am warned before creation rather than ending up with two identical folders.
- [ ] Given a malformed body, when I submit, then the API returns 422 `{"error": "Invalid parameters provided"}` and my typed name is preserved in the form.
- [ ] Given the folder is created, when I open the deliverability tests list, then I can file existing tests into it and the count of tests per folder is shown.
- [ ] Given my session has expired, when I submit, then the API returns 401 `{"message": "Invalid API Key"}` and nothing is created.
- [ ] Given a folder is created, when it is saved, then an activity-trail entry records who created it and its name.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"folderName": "Q3 domains"}` | 200; body has `id`, `name: "Q3 domains"`, `user_id`, `client_id`, `created_at`, `updated_at`; the folder appears in the list without a reload |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; UI shows "Your session expired — sign in again"; no folder created |
| TC-3 | Not found / wrong workspace | POST while impersonating a workspace the user is not a member of | 404 `{"error": "Resource not found"}`; nothing created |
| TC-4 | Validation failure — empty name | POST `{"folderName": ""}` | 422 `{"error": "Invalid parameters provided"}`; field-level message "Give the folder a name"; typed value preserved |
| TC-5 | Rate limited | Create fifty folders in a burst | 429 on the excess; client backs off with jitter; one "Retrying…" state shown |
| TC-6 | Empty result set | Open the folder picker in a workspace with no folders | 200 with an empty list; picker shows "No folders yet — create one" instead of a blank dropdown |
| TC-7 | Duplicate name | Create "Q3 domains" twice | Second attempt warns "A folder with that name already exists"; creation proceeds only on confirmation |
| TC-8 | Very long name | POST a 500-character `folderName` | 422 with a length message; the input shows a character counter once the limit is near |
| TC-9 | Name with markup | POST `{"folderName": "<script>alert(1)</script>"}` | Stored and rendered as literal text; no markup executes anywhere the name is shown |
| TC-10 | Whitespace trimming | POST `{"folderName": "  Q3 domains  "}` | Stored trimmed; a subsequent duplicate check matches the untrimmed variant |

## 4. Frontend user story

**As a** mailbox owner, **I want** to create and pick folders where deliverability tests are listed, **so that** organising runs never sends me to a separate admin screen.

**Scope**
- Monitoring → Deliverability: the tests list gains a folder sidebar (or a folder select under 900px) with "All tests" first and a "New folder" action at the bottom.
- The new-folder control is an inline single-field form, not a modal — one field, one button, Escape cancels.
- Loading: the sidebar shows skeleton rows. Empty: "No folders yet" with the inline create form already visible. Error: message under the field with the typed name preserved.
- Accessibility: the field has a visible label; the created folder is announced via a live region; the sidebar is a labelled navigation list with keyboard selection. Responsive: sidebar becomes a select above the list under 900px.

**Definition of done**
- [ ] A folder can be created in one field without opening a dialog.
- [ ] The new folder is selected immediately after creation and the list filters to it.
- [ ] Duplicate names are caught before the request and confirmed, not silently allowed.
- [ ] Loading, empty, error and duplicate states are all designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route to create deliverability-test folders scoped to the workspace, **so that** test runs can be grouped without leaking across workspaces.

**Scope**
- Route in `server/routes.js`: `POST /api/deliverability/folders` taking `{ name }`, following the existing workspace-scoped write pattern.
- Data model: a `deliverability_folders` table in `server/db.js` (`id`, `name`, `workspace_id`, `created_at`, `updated_at`) mirroring the documented response fields, with `user_id`/`client_id` mapped onto Harry's workspace owner and workspace id; plus a nullable `folder_id` column on `deliverability_tests`.
- Validation: name trimmed, non-empty, length-capped; case-insensitive uniqueness check inside the workspace returning a 409-style conflict the UI turns into a confirmation.
- No pagination needed — folders are counted in tens. The standard app rate limiter applies; upstream 429 and 503 back off with jitter.
- Logged: an `events` row on create with actor and folder name; `telemetry` records upstream failures so Monitoring can grade the deliverability service.

**Definition of done**
- [ ] Route is workspace-scoped and a folder created in one workspace is invisible in another, covered by a test.
- [ ] Name validation and trimming are enforced server-side, not only in the form.
- [ ] Response returns the full stored record so the client needs no follow-up fetch.
- [ ] Create appears in the activity trail.

## 6. End-to-end test ticket

**Title:** E2E — Group deliverability tests into a folder

**Preconditions:** A workspace with three completed placement test fixtures and no folders.

**Flow**
1. Open Monitoring → Deliverability.
2. Use "New folder", type "Q3 domains", and save.
3. Select two of the three tests and file them into the new folder.
4. Select the folder in the sidebar.
5. Select "All tests".

**Assertions**
- [ ] The folder appears in the sidebar immediately with a count of two.
- [ ] Selecting the folder shows exactly the two filed tests.
- [ ] "All tests" still shows all three.
- [ ] Creating a second folder called "q3 domains" prompts a duplicate confirmation.
- [ ] The activity trail records the folder creation with the actor's name.

**Teardown:** Delete the folder (leaving its tests unfiled) and remove the test fixtures.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability | Folder sidebar plus an inline create field | Low | Hidden entirely until a workspace has more than a handful of tests; "All tests" remains the default view |
| Activity trail | Folder created entries | Low | Reuses the existing trail |

**Verdict:** Fits an existing surface

Folders are filing, not a feature, so they belong beside the list they organise and nowhere else. The sidebar only earns its space once there are enough tests to scroll, and until then the create control is a single line at the bottom of the list. No new navigation item and no new page.
