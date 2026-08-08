# Get Provider IDs

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/seed/providers` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/provider-ids |
| **Auth** | API key (query param `api_key`) |

Lists the groups of test inboxes available in each region — Gmail, Outlook, Yahoo and so on — with the identifier you need when setting up a test.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner setting up a placement test, **I want** to choose which providers and region my mail is tested against, **so that** I test against the inboxes my actual prospects use.

**Acceptance criteria**
- [ ] Given the provider list is fetched, when it renders, then I see `region_name` and, under it, each group's `group_name` and `provider_count`.
- [ ] Given a group is selected, when the test is created, then the group's `group_id` (for example `gmail_na`) is what is sent as the test's `provider_id`, and the id is never typed by hand.
- [ ] Given `provider_count` differs between groups, when the picker renders, then the count is shown beside each group ("Gmail — 150 test inboxes"), so the user can judge the strength of the sample before choosing.
- [ ] Given the documented response returns a single region object, when more than one region is available, then the picker handles both an object and an array without breaking, since the docs show only the North America shape.
- [ ] Given the list cannot be fetched, when the test form renders, then the provider field is disabled with a message rather than falling back to a hardcoded guess at an id.
- [ ] Given no groups are returned, when the picker renders, then it says no test inboxes are available and blocks test creation, because a test with no seeds proves nothing.
- [ ] Given the list is fetched, when it is used, then it is cached for the session rather than re-fetched every time the form opens.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET the seed providers route | 200; `region_id: "na-1"`, `region_name: "North America"`, three groups with `group_id` `gmail_na` / `outlook_na` / `yahoo_na` and counts 150 / 120 / 130 |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; the provider field is disabled with "Sign in again to load test inboxes" |
| TC-3 | Not found / wrong workspace | GET while scoped to a workspace without deliverability access | 404 `{"error": "Resource not found"}`; the field explains that deliverability testing is not enabled for this workspace |
| TC-4 | Validation failure | GET with an unsupported parameter appended | 422 `{"error": "Invalid parameters provided"}`; the parameter is dropped, logged to telemetry, and the plain request retried once |
| TC-5 | Rate limited | Open and close the test form repeatedly | 429 avoided entirely by the session cache; on a real 429, backoff with jitter and the cached list is used |
| TC-6 | Empty result set | Response with `groups: []` | The picker says no test inboxes are available and the "Run a test" action is disabled with the reason stated |
| TC-7 | Multiple regions | Response returned as an array of region objects | Both regions render as grouped options; the selected `group_id` still maps correctly |
| TC-8 | Unknown group name | A group whose `group_name` is unfamiliar | Rendered as-is; no attempt is made to map it to a friendly label that could be wrong |
| TC-9 | Id never typed | Inspect the create-test request after choosing "Gmail" in North America | The body carries `provider_id: "gmail_na"` taken from the fetched list, not a constructed string |
| TC-10 | Upstream unavailable | Provider returns 503 | Cached list used if present; otherwise the field is disabled with "Test inboxes are temporarily unavailable" and the form cannot be submitted |

## 4. Frontend user story

**As a** mailbox owner, **I want** the provider picker in the placement-test form to speak in provider and region names, **so that** I never see or copy an identifier.

**Scope**
- Monitoring → Deliverability: the create-test form's provider field is a grouped select — region as the group label, providers as options, each with its inbox count as secondary text.
- The field defaults to the largest group in the first region so a user who does not care can simply continue.
- Loading: the field shows a loading state and the submit button stays disabled. Empty: the field explains no test inboxes are available. Error: field disabled with a plain message and a retry.
- Ids are never rendered. The chosen provider is echoed back in the created test's detail as "Gmail, North America".
- Accessibility: a real `select` with `optgroup` labels, a visible field label, and counts included in each option's text so they are announced. Responsive: full-width field on small screens with no truncation of provider names.

**Definition of done**
- [ ] The picker shows region, provider and inbox count and never an id.
- [ ] The form cannot be submitted while the provider list is unavailable.
- [ ] The list is fetched once per session and reused by every entry point into the form.
- [ ] Loading, empty, error and multi-region states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route serving the available seed provider groups, **so that** the client never constructs a provider id itself.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/providers`, workspace-scoped, normalising the response to a list of `{ regionId, regionName, groups: [{ groupId, groupName, providerCount }] }` whether the upstream returns one object or an array.
- Data model: none needed for correctness; a short-lived server cache keyed by workspace, since the list changes rarely and the create form is opened often.
- Validation on create: any `provider_id` submitted to the create-test routes must exist in the currently fetched list, else 422 — so a stale client cannot schedule a test against a group that no longer exists.
- Rate limiting: the server cache means one upstream call per workspace per cache window; upstream 429 and 503 back off with jitter and serve the cache; when there is no cache, the create routes refuse rather than guess.
- Logged: nothing to `events`; `telemetry` records fetch failures and any create attempt rejected for an unknown provider id, which is the signal that the cache window is too long.

**Definition of done**
- [ ] Both the object and array response shapes normalise to one internal structure, covered by tests.
- [ ] A create request with an unknown `provider_id` returns 422 and no test is created.
- [ ] The cache is per workspace and expires, and a cache miss during an outage refuses rather than guesses.
- [ ] No provider id ever reaches the client except as an opaque value inside the option list.

## 6. End-to-end test ticket

**Title:** E2E — Choose the inboxes a placement test runs against

**Preconditions:** A workspace with one sandbox mailbox, one campaign, and a stubbed provider returning the documented North America body with three groups.

**Flow**
1. Open Monitoring → Deliverability and choose "Run a test".
2. Open the provider field.
3. Choose "Outlook".
4. Create the test and open its detail.
5. Stub the provider list to return `groups: []` and reopen the form.

**Assertions**
- [ ] The field groups the three providers under "North America" and shows the counts 150, 120 and 130.
- [ ] No identifier such as `outlook_na` is visible anywhere in the interface.
- [ ] The created test's detail reads "Outlook, North America".
- [ ] Inspecting the create request shows `provider_id: "outlook_na"` taken from the fetched list.
- [ ] With an empty list, the form states that no test inboxes are available and the submit button is disabled.

**Teardown:** Delete the created test; restore the provider stub.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability create-test form | One grouped select field | Low | A single field inside a form that already exists; defaulted so it can be ignored |

**Verdict:** Invisible — no UI

There is no screen for this endpoint; it exists purely so a field elsewhere can be populated with names rather than identifiers. The only visible consequence is that the create-test form has a provider option and the created test says "Gmail, North America" instead of showing a code, which is the whole point.
