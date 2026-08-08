# Get Spam Test Details

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/{spamTestId}` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/test-details |
| **Auth** | API key (query param `api_key`) |

Fetches a single deliverability test's setup — what it was called, which campaign and step it tested, which providers it used, and where it is filed.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner opening a report, **I want** to see exactly how the test was set up, **so that** I can trust what the result is telling me and reproduce it.

**Acceptance criteria**
- [ ] Given a test id, when I fetch its details, then I get `id`, `test_name`, `test_type`, `description`, `folder_id`, `link_checker`, `test_with_sl_account`, `campaign_id`, `sequence_mapping_id`, `provider_id`, `created_at` and `updated_at`.
- [ ] Given `campaign_id` and `sequence_mapping_id`, when the header renders, then the campaign name and the `Send:` node's label are shown and linked, not the raw identifiers.
- [ ] Given `provider_id` (for example `gmail_na`), when it renders, then it is resolved through the provider list to "Gmail, North America"; if it cannot be resolved, the raw value is shown with a note rather than being hidden.
- [ ] Given `folder_id`, when it renders, then the folder name is shown as a link to that folder's filtered list.
- [ ] Given `link_checker` and `test_with_sl_account`, when they render, then each is described in words ("Links checked", "Sent from your own mailbox") rather than as a labelled boolean.
- [ ] Given `client_id` and `user_id` are workspace-internal, when the response is served to the browser, then they are not included.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the page shows "That test is not available" with a link back to the list.
- [ ] Given the referenced campaign has since been deleted, when the header renders, then it says the campaign no longer exists rather than showing a broken link.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET `test_67890abcdef` | 200; all documented fields present, `test_type: "manual"`, `provider_id: "gmail_na"`, `folder_id: "folder_12345"` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; redirected to sign in with the test link preserved as the return path |
| TC-3 | Test not found / wrong workspace | GET another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That test is not available" with a link to the list; no test name revealed |
| TC-4 | Validation failure | GET with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; the same not-available state |
| TC-5 | Rate limited | Reload the test page rapidly | 429 on the excess; backoff with jitter; the cached record is rendered meanwhile |
| TC-6 | Empty result set | GET a test whose optional fields are all null (`description`, `folder_id`, `campaign_id`) | 200; the header renders with those rows omitted rather than showing empty labels or the word "null" |
| TC-7 | Unresolvable provider | `provider_id` not present in the current provider list | The raw value is shown with "provider group no longer listed", and nothing crashes |
| TC-8 | Deleted campaign | `campaign_id` referencing a deleted campaign | The header says the campaign no longer exists; the rest of the report still renders |
| TC-9 | Internal ids not leaked | Inspect the API response served to the browser | `client_id` and `user_id` are absent |
| TC-10 | Upstream unavailable | Provider returns 503 | The cached record is rendered with a "not up to date" note; retried on the next load; report sections still open |

## 4. Frontend user story

**As a** mailbox owner, **I want** the test's setup summarised at the top of its report, **so that** I never have to remember what I asked for.

**Scope**
- Monitoring → Deliverability → test detail: a header with the test name, type, description, the linked campaign and `Send:` node, the resolved provider group, the folder, and the two option lines; created and last-updated dates as secondary text.
- Every report section on the page — counts, by region, by provider, by mailbox, authentication, spam filters, run history — sits beneath this one header, so the page has a single identity.
- Loading: skeleton header; report sections load independently so a slow section does not block the header. Not found: a named error state with a link back. Stale: header rendered with a quiet note.
- Nulls are omitted rather than labelled, and no raw identifier is shown when a name is available.
- Accessibility: the test name is the view's main heading; the setup is a description list with real labels; links carry the destination in their accessible name. Responsive: the header stacks to one column under 640px.

**Definition of done**
- [ ] Campaign, step, provider and folder all render as names with working links.
- [ ] Optional nulls are omitted, never rendered as empty or as "null".
- [ ] A deleted campaign or an unresolvable provider degrades gracefully with an explanation.
- [ ] Loading, not-found, stale and partial-reference states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route returning one test's setup with its references resolved, **so that** the client renders names without a fan-out of extra calls.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId`, workspace-scoped, returning the stored record with `campaignName`, `sequenceStepLabel`, `providerLabel` and `folderName` resolved server-side, and without `client_id` or `user_id`.
- Data model: reuses `deliverability_tests`; resolution reads the campaigns table, the playbook's node labels via `server/playbook.js`, the cached provider list, and `deliverability_folders`. Each resolution is allowed to fail independently and returns null with a reason.
- No pagination. Refresh throttled per test; upstream 429 and 503 back off with jitter and the stored record is served with a staleness marker.
- Logged: no `events` for a read; `telemetry` records unresolvable references, since a rise means tests are outliving the campaigns they describe and the copy needs to handle it better.

**Definition of done**
- [ ] References are resolved in one request; the client makes no follow-up calls to name a campaign, step, provider or folder.
- [ ] A deleted campaign yields a null name with a reason, not a 500.
- [ ] `client_id` and `user_id` never leave the server, asserted by a test.
- [ ] Route is workspace-scoped and 404s on another workspace's test without revealing its name.

## 6. End-to-end test ticket

**Title:** E2E — Read how a placement test was set up

**Preconditions:** A workspace with one campaign containing a labelled `Send:` node, one folder, a completed test fixture referencing all of them with `provider_id: "gmail_na"`, and a second fixture whose campaign has been deleted and whose `description` and `folder_id` are null.

**Flow**
1. Open Monitoring → Deliverability and choose the first fixture.
2. Read the header.
3. Follow the campaign link, then the folder link.
4. Return and open the second fixture.
5. Sign in as another workspace and open the first fixture's URL.

**Assertions**
- [ ] The header shows the test name, "Manual", the description, the campaign name, the `Send:` node label, "Gmail, North America", the folder name, and both option lines in words.
- [ ] The campaign link opens the campaign and the folder link opens the folder's filtered list.
- [ ] The second fixture omits the description and folder rows entirely and says the campaign no longer exists, while its report sections still render.
- [ ] The other workspace sees "That test is not available" and the test's name appears nowhere in the response or the page.
- [ ] No `client_id` or `user_id` appears in any response during the flow.

**Teardown:** Delete both fixtures and the folder; restore the deleted campaign fixture if other tests rely on it.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability test detail | The report header carrying the test's setup | Low | It is the page's identity; every other section in this category renders beneath it, so it is built once |

**Verdict:** Fits an existing surface

Every other ticket in the category renders inside the page this endpoint titles, so the header is shared infrastructure rather than a feature of its own. Resolving identifiers into names server-side is what keeps the page honest: a user should read "Gmail, North America" and their campaign's name, never `gmail_na` and `camp_345678`. No new navigation item.
