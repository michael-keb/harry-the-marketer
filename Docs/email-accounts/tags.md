# Get All Tags

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/email-accounts/tags` |
| **Category** | email-accounts |
| **Source** | https://api.smartlead.ai/api-reference/email-accounts/tags |
| **Auth** | API key (query param `api_key`) |

Returns the workspace's master list of mailbox tags — id, name and colour — regardless of which mailboxes they are attached to.

## 1. Epic

**Mailbox fleet management and sender health**

Everything a Harry user does to the mailboxes that actually send: connecting them, deciding how much each may send a day, warming a new one up, pausing a sick one, and seeing plainly why a mailbox is failing. It matters because cold outreach lives or dies on sender reputation — the best playbook in the world still bounces if the mailbox behind it is cold, capped or disconnected.

## 2. User story

**As a** workspace owner, **I want** one canonical list of the tags I have created for mailboxes, **so that** every place that offers tags — the filter strip, the tag picker, the mailbox row — offers exactly the same set with the same colours.

**Acceptance criteria**
- [ ] Given tags exist, when I fetch the list, then I receive an array of objects each with `id`, `name` and `color` as a hex code (for example `{"id": 10, "name": "Winners", "color": "#B1FCCF"}`).
- [ ] Given a tag that has been created but attached to no mailbox, when I fetch the list, then it is still returned — this endpoint is the master list, independent of assignment.
- [ ] Given no session, when I fetch the list, then the response is the documented 401 shape `{"ok": false, "message": "User authentication required."}` rather than an empty array, so the UI does not mistake "signed out" for "no tags".
- [ ] Given a workspace with no tags, when I fetch the list, then the response is an empty array and the tag picker shows "No tags yet — create one" rather than a spinner.
- [ ] Given a colour stored against a tag, when it is rendered anywhere in Harry, then the name is always shown as text alongside the colour, so a colour-blind user loses nothing.
- [ ] Given the server fails, when the list cannot be built, then the documented 500 (`{"error": "Failed to fetch email account tags."}`) is surfaced as a retryable inline message, never as a silently empty tag list.
- [ ] Given the list is used in several places at once, when a page loads, then it is fetched once and shared, not requested per component.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | GET the tag list on a workspace with three tags | 200, an array of three objects with `id`, `name`, `color`; colours are valid hex |
| TC-2 | Missing/invalid API key | GET with no session cookie | 401, `{"ok": false, "message": "User authentication required."}`; UI redirects to sign-in and does not render an empty picker |
| TC-3 | Not found / wrong workspace | Sign in to a workspace that owns none of another workspace's tags | 200 with only this workspace's tags; no leakage of names from elsewhere |
| TC-4 | Validation failure | Pass an unexpected query parameter | 200 with the parameter ignored, or 422 with a field-level message — never a 500 |
| TC-5 | Rate limited | Request the list on every keystroke in a tag picker | 429 on the excess; the client debounces and caches, showing the last good list |
| TC-6 | Empty result set | GET on a workspace with no tags | 200, `[]`; picker shows "No tags yet — create one" with the create action |
| TC-7 | Server error | Force the documented 500 | `{"error": "Failed to fetch email account tags."}` shown as "Could not load tags — retry", with the rest of the page still usable |
| TC-8 | Unattached tag included | Create a tag, attach it to nothing, refetch | The tag is present in the list |
| TC-9 | Colour contrast | Render every returned colour as a chip | The tag name remains readable against every colour, verified against contrast thresholds |
| TC-10 | Long tag name | A tag named with 60 characters | The chip truncates with an ellipsis and exposes the full name to assistive technology and on hover |

## 4. Frontend user story

**As a** workspace owner, **I want** the same tag list everywhere tags appear, **so that** I never wonder why a tag I created is missing from a picker.

**Scope**
- Mailboxes page: the tag filter in the filter strip and the tag picker in a mailbox row both read this one list.
- Mailbox detail sheet: the tag section reads the same list for its "add a tag" control.
- The list is fetched once per session and cached, invalidated when a tag is created, renamed or deleted.
- States: skeleton chips while loading; "No tags yet" empty state with a create action; a retryable inline error that leaves the rest of the page working.
- Accessibility: every chip shows its name as text; colour is decoration only; the picker is a listbox with keyboard selection and type-ahead. Responsive: chips wrap rather than scroll horizontally.

**Definition of done**
- [ ] One fetch serves every tag control on a page.
- [ ] Empty, loading and error states each have a designed appearance.
- [ ] Tag names are never colour-only, verified with colour simulation.
- [ ] Cache invalidation on create, rename and delete is covered by a test.

## 5. Backend user story

**As a** Harry API, **I want** a workspace-scoped tag list route, **so that** every tag control reads one source and colours cannot drift between screens.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `GET /api/tags?appliesTo=mailbox`, returning `[{ id, name, color }]` ordered by name.
- Data model: one `tags` table in `server/db.js` (`id`, `workspace_id`, `applies_to`, `name`, `color`, `created_at`), **shared with lead tags** and discriminated by `applies_to` (`mailbox` | `lead`), with a unique constraint on `(workspace_id, applies_to, name)`. The `appliesTo` filter is mandatory on this route so mailbox labels and lead labels can never appear in each other's pickers. The mailbox-to-tag join is described in the email-account-tags epic; this route reads only the tag table.
- No pagination — a workspace has a handful of tags, not thousands; the response is small enough to cache client-side for the session.
- The standard app rate limiter applies. A failure returns the documented error shape rather than an empty array, so the client can tell "none" from "broken".
- Logged: nothing per read. `telemetry` records failures only, so a broken tag list shows up in Monitoring rather than as a silently empty picker.

**Definition of done**
- [ ] Cross-workspace isolation covered by a test.
- [ ] A test asserts a lead tag never appears in a mailbox tag response, and the reverse.
- [ ] Unique constraint on `(workspace_id, applies_to, name)` prevents two tags that look identical.
- [ ] A failure path returns the error shape, covered by a test asserting the client does not render an empty state.
- [ ] Colour is validated as a hex code on write so this read never returns something unrenderable.

## 6. End-to-end test ticket

**Title:** E2E — One tag list behind every tag control

**Preconditions:** A workspace with three mailboxes and three tags, one of which is attached to no mailbox.

**Flow**
1. Open Mailboxes and note the tags offered in the filter strip.
2. Open a mailbox row's tag picker and compare the offered set.
3. Open the mailbox detail sheet and compare again.
4. Create a new tag from the picker.
5. Reload the page.

**Assertions**
- [ ] All three controls offer exactly the same three tags with the same colours, including the unattached one.
- [ ] The newly created tag appears in all three controls without a page reload.
- [ ] After reload the set is unchanged, proving the cache and the server agree.
- [ ] With the network forced to fail, the controls show a retry message rather than an empty tag list.

**Teardown:** Delete the created tag; leave the three original tags in place.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Tag chips on rows and a tag filter | Low | Chips sit inside the row already added by the mailbox list work; the filter joins an existing strip |
| Mailbox detail sheet | Tag section | Low | One section in a sheet that already exists |
| Everywhere else | None | — | Tags are a mailbox concept only; they do not appear on Leads, Campaigns or Inbox |

**Verdict:** Invisible — no UI

This endpoint on its own draws nothing. It is the data behind tag controls that the assignment and creation stories introduce, and its only visible contribution is that those controls agree with one another. Building it separately is worth it precisely because the alternative — each control fetching its own list — is how colours and names start to disagree.
