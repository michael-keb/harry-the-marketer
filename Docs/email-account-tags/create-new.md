# Create Tag

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/tags` |
| **Category** | email-account-tags |
| **Source** | https://api.smartlead.ai/api-reference/email-account-tags/create-new |
| **Auth** | API key (query param `api_key`) |

Creates a new mailbox tag from a name and an optional colour, and returns the id the rest of the tagging endpoints need.

## 1. Epic

**Mailbox tagging and fleet segmentation**

Labels a Harry user can put on mailboxes — by domain, by client, by purpose, by "do not touch" — so a fleet of twenty mailboxes can be filtered, grouped and reasoned about instead of scrolled. It matters because once a workspace has more mailboxes than fit on a screen, every other mailbox decision starts with finding the right ones.

## 2. User story

**As a** workspace owner, **I want** to create a tag by typing a name, **so that** I can start organising mailboxes without first deciding on a colour or leaving the page I am on.

**Acceptance criteria**
- [ ] Given a name, when I create a tag, then `name` is the only required field and the response returns the generated id (`{"ok": true, "data": {"id": 42, "name": "Primary Senders", "color": "#4CAF50"}}`).
- [ ] Given no colour, when I create a tag, then a default colour is assigned automatically — the docs make `color` optional precisely so a user need not choose one.
- [ ] Given an assigned default, when it is chosen, then it comes from an accessible palette and does not repeat the colour of an existing tag in the workspace while unused colours remain.
- [ ] Given an invalid colour, when I supply one, then the request is rejected with 422 for a format that is not `#RRGGBB`, and the name I typed is preserved in the field.
- [ ] Given a missing name, when I submit, then the documented 422 (`{"error": "\"name\" is required"}`) is shown as a field-level message, never as a page-level banner.
- [ ] Given a name that already exists as a mailbox tag in the workspace, when I create it, then the existing tag is offered instead of creating a lookalike; a lead tag with the same name is irrelevant, because tags carry what they apply to.
- [ ] Given a tag is created from inside a tag picker, when it is created, then it is immediately selected in that picker, so creating and applying is one flow rather than two.
- [ ] Given a creation, when it completes, then the activity trail records who created the tag and its name.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path with colour | POST `{"name": "Primary Senders", "color": "#4CAF50"}` | 200, `{"ok": true, "data": {"id": 42, "name": "Primary Senders", "color": "#4CAF50"}}` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session cookie | 401, `{"message": "Invalid API Key"}`; nothing created |
| TC-3 | Not found / wrong workspace | Create while signed in to workspace A, then read tags in workspace B | The tag exists only in workspace A; workspace B's list does not include it |
| TC-4 | Validation failure — no name | POST `{}` | 422, `{"error": "\"name\" is required"}` under the name field |
| TC-5 | Rate limited | Submit twenty creations in a burst | 429 on the excess; the client backs off with jitter and reports which were created |
| TC-6 | Empty result set | Open the tag picker on a workspace with no tags | "No tags yet — create one" with the create field focused, not a spinner or a blank list |
| TC-7 | Colour omitted | POST `{"name": "Client A"}` | 200 with a default colour assigned from the accessible palette, distinct from existing tags |
| TC-8 | Invalid hex | POST `{"name": "X", "color": "#FFF"}` | 422 on `color` stating the six-character requirement; the name survives the error |
| TC-9 | Duplicate name | Create a tag whose name already exists | The existing tag is returned or offered for selection; no second tag with the same name is created |
| TC-10 | Create from inside the picker | Type a new name in the tag picker's create field while three mailboxes are selected | Tag is created, selected, and assignable in the same interaction |
| TC-11 | Name shared with a lead tag | Create a mailbox tag named the same as an existing lead tag | 200, a separate tag is created; neither appears in the other's picker |
| TC-12 | Whitespace and length | Create with leading and trailing spaces and a 200-character name | Name is trimmed; over-length names are rejected with a field-level message stating the limit |

## 4. Frontend user story

**As a** workspace owner, **I want** to create a tag from wherever I need it, **so that** organising never means stopping to go and set something up first.

**Scope**
- Mailboxes page: a create field at the bottom of every tag picker — in the bulk-selection bar and in the mailbox detail sheet — plus a "New tag" action in the "Manage tags" panel.
- Typing a name that matches an existing tag surfaces that tag rather than offering to create a duplicate.
- Colour is optional and defaults automatically; the swatch picker is available but never blocks creation.
- States: creating (field disabled with progress), created (tag appears and is selected), duplicate (existing tag offered), error (field-level message with the typed name kept).
- Accessibility: the create field is a labelled input with type-ahead results announced; the newly created tag's selection is announced; palette swatches carry accessible names. Responsive: the picker is a full-width sheet under 640px so the field is not cramped.

**Definition of done**
- [ ] A tag can be created and applied in one interaction without leaving the page.
- [ ] Colour is never required to complete creation.
- [ ] Duplicate names are surfaced, not created.
- [ ] Creating, created, duplicate and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a tag creation route that assigns a sensible default colour, **so that** the UI can offer one-field creation.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `POST /api/tags` taking `{ appliesTo: "mailbox", name, color? }` and returning the created row. SmartLead funnels both creation and update through one endpoint that silently upserts on a body `id`; Harry keeps `POST /api/tags` for creation and `PUT /api/tags/:id` for updates, so creating can never overwrite an existing label by accident.
- Data model: inserts into the single `tags` table from the tag-list story (`id`, `workspace_id`, `applies_to`, `name`, `color`, `created_at`), **shared with lead tags** and discriminated by `applies_to` (`mailbox` | `lead`), with the unique constraint on `(workspace_id, applies_to, name)` doing the duplicate prevention. A mailbox tag and a lead tag may therefore share a name without either appearing in the other's picker.
- Default colour is picked deterministically from a fixed accessible palette by hashing the tag name against the workspace's already-used colours, so the same name always yields the same colour and the choice is reproducible in tests — the same discipline `server/pacing.js` uses instead of `Math.random`.
- Validation: name trimmed, non-empty, length-capped; colour must match `^#[0-9A-Fa-f]{6}$` when supplied.
- Standard rate limiter; a duplicate returns the existing row rather than erroring, so a double-submit is harmless.
- Logged: an `events` row with actor and tag name; no telemetry needed — this is a rare, cheap operation.

**Definition of done**
- [ ] One-field creation works, covered by a test asserting a colour is always present on the returned row.
- [ ] Default colour selection is deterministic and covered by a test.
- [ ] Duplicate creation returns the existing tag rather than a second row, covered by a test.
- [ ] `appliesTo` is required on creation and defaults to nothing, so a tag can never be created without knowing what it labels.
- [ ] Cross-workspace isolation covered by a test, as is isolation between mailbox and lead tags of the same name.

## 6. End-to-end test ticket

**Title:** E2E — Create a tag while tagging mailboxes

**Preconditions:** A workspace with ten mailboxes and no tags.

**Flow**
1. Open Mailboxes and select four mailboxes.
2. Open "Add tags" and see the empty state.
3. Type a new tag name and create it without choosing a colour.
4. Apply it to the selection.
5. Create a second tag with the same name.
6. Open "Manage tags".

**Assertions**
- [ ] The empty state invites creation rather than showing an empty list.
- [ ] The tag is created with an automatic colour, selected, and applied to all four mailboxes in one flow.
- [ ] The second attempt at the same name offers the existing tag instead of creating a duplicate.
- [ ] "Manage tags" lists one tag with a count of four.
- [ ] The activity trail records the creation with the actor and name.

**Teardown:** Remove the tag from the four mailboxes and delete it.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Create field inside existing tag pickers | Low | One input at the bottom of a list the picker already renders |
| Mailboxes | "New tag" in the Manage tags panel | Low | A second door to the same action, in the panel that already exists |
| Everywhere else | None | — | Tags are a mailbox concept and must not spread to Leads or Campaigns |

**Verdict:** Fits an existing surface

Creation is a single text field inside pickers that the assignment story already introduces, so it adds no new place to go. Making colour optional is what keeps it a one-field job — a colour picker in the way of creating a label would be exactly the kind of thinking Harry tries to remove. No navigation item is added.
