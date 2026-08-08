# Get Folder by ID

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/folder/{folderId}` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/get-folder-by-id |
| **Auth** | API key (query param `api_key`) |

Fetches the details of one folder used to group deliverability tests.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner arriving from a shared link, **I want** a folder of deliverability tests to load directly by its id, **so that** a bookmarked or pasted link opens the right filtered list rather than the default view.

**Acceptance criteria**
- [ ] Given a `folderId` I own, when I fetch it, then the response returns `id`, `name`, `user_id`, `client_id`, `created_at` and `updated_at`.
- [ ] Given the folder loads, when the page renders, then the folder `name` is the heading and the test list is filtered to that folder without a second click.
- [ ] Given `updated_at` differs from `created_at`, when the detail renders, then the last-changed date is shown in the browser's timezone alongside the created date.
- [ ] Given a `folderId` that does not exist or belongs to another workspace, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the page shows "That folder is not available" with a link to all tests, not a blank list.
- [ ] Given a malformed `folderId`, when I fetch it, then the API returns 422 `{"error": "Invalid parameters provided"}` and the same not-available state is shown.
- [ ] Given the folder exists but contains no tests, when the page renders, then the folder heading is shown with an empty-list state, so an empty folder is distinguishable from a missing one.
- [ ] Given my session has expired, when I fetch it, then the API returns 401 `{"message": "Invalid API Key"}` and I am sent to sign in with the folder link preserved as the return path.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET an owned `folderId` | 200; body has `id: "folder_001"`, `name: "Q1 2026 Tests"`, `user_id`, `client_id`, `created_at`, `updated_at` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; redirected to sign in; after signing in, the folder page opens |
| TC-3 | Not found / wrong workspace | GET a `folderId` created in another workspace | 404 `{"error": "Resource not found"}`; "That folder is not available" with a link to all tests |
| TC-4 | Validation failure | GET with a `folderId` that is not a valid identifier | 422 `{"error": "Invalid parameters provided"}`; not-available state; no retry loop |
| TC-5 | Rate limited | Reload the folder page rapidly | 429 on the excess; client backs off with jitter and serves the cached folder record meanwhile |
| TC-6 | Empty folder | GET a folder that has no tests filed | 200 with the folder record; the heading renders and the list shows "No tests in this folder yet" |
| TC-7 | Deleted folder | GET a `folderId` deleted a moment ago in another tab | 404; the page falls back to "All tests" and removes the stale entry from the sidebar |
| TC-8 | Renamed folder | Rename the folder elsewhere, then GET it | 200 with the new `name` and a later `updated_at`; the heading and sidebar both update |
| TC-9 | Name with markup | A folder whose `name` is `<b>Q1</b>` | Rendered as literal text everywhere the name appears; no markup executes |
| TC-10 | Upstream unavailable | Provider returns 503 | "Folder details are temporarily unavailable"; the cached name is used for the heading and stamped as cached; retried on the next load |

## 4. Frontend user story

**As a** mailbox owner, **I want** folder pages to be linkable, **so that** I can send a teammate straight to the runs I am talking about.

**Scope**
- Monitoring → Deliverability: selecting a folder puts its id in the URL, so the view is bookmarkable and shareable; loading that URL directly fetches the folder and filters the list.
- The folder heading shows the `name` with the created and last-updated dates as secondary text.
- Loading: heading and list show skeletons. Not found: "That folder is not available" with a link to all tests. Empty: heading plus "No tests in this folder yet". Error: cached name with a stale banner.
- Accessibility: the heading is the page's `h1`-level landmark for that view so screen readers announce the filter change; the sidebar marks the current folder with `aria-current`. Responsive: on the mobile select layout the heading still renders above the list.

**Definition of done**
- [ ] A folder view has its own URL and survives a reload and a back-navigation.
- [ ] A missing folder gives a named error state, never a silently empty list.
- [ ] An empty folder and a missing folder look clearly different.
- [ ] Loading, empty, not-found, stale and expired-session states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route that returns a single deliverability folder scoped to the workspace, **so that** a shared link cannot leak another workspace's folder name.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/folders/:folderId`, workspace-scoped, returning the stored record plus a `testCount` so the UI needs no second call.
- Data model: reuses the `deliverability_folders` table from the create-folder ticket; `user_id` and `client_id` map onto Harry's workspace owner and workspace id, and are never returned raw to the client.
- No pagination. Standard app rate limiter; upstream 429 and 503 back off with jitter and the client falls back to the cached name.
- Logged: no `events` row for a read; `telemetry` records 404 rates on folder reads, because a spike means links are being shared across workspaces and the error copy needs work.

**Definition of done**
- [ ] A folder id from another workspace returns 404 and never reveals the folder's name, covered by a test.
- [ ] `testCount` matches the number of tests the list route returns for the same folder.
- [ ] Reads are not written to the activity trail.
- [ ] Response includes both `created_at` and `updated_at` unchanged.

## 6. End-to-end test ticket

**Title:** E2E — Open a deliverability folder from a shared link

**Preconditions:** Two workspaces. Workspace A has a folder "Q1 2026 Tests" containing two completed placement tests and an empty folder "Spare". Workspace B has neither.

**Flow**
1. In workspace A, open Monitoring → Deliverability and select "Q1 2026 Tests".
2. Copy the URL and reload it in a fresh tab.
3. Navigate to the "Spare" folder.
4. Sign in as workspace B and open the copied URL.
5. Return to workspace A and delete the folder in one tab while the other still shows it, then reload the other tab.

**Assertions**
- [ ] The reloaded URL opens with the folder name as the heading and exactly two tests listed.
- [ ] "Spare" shows the heading plus "No tests in this folder yet" — clearly different from a missing folder.
- [ ] Workspace B sees "That folder is not available" and the folder's name is nowhere in the response or the page.
- [ ] The stale tab falls back to "All tests" after the reload with no dead sidebar entry.
- [ ] The activity trail records no entry for any of these reads.

**Teardown:** Remove both folders and the two test fixtures from workspace A.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability | Folder selection becomes a URL, with a heading and dates | Low | Heading replaces nothing and adds one line; dates are secondary text |
| Error states | A named "folder not available" state | Low | Reuses the app's existing not-found pattern |

**Verdict:** Fits an existing surface

Making a filter addressable is plumbing, not a feature: the visible change is a heading over a list the user already had. It earns its place because a shared link that lands on the wrong view is the kind of small confusion that makes people stop sharing links at all. No new navigation item.
