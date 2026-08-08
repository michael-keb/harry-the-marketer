# Update Email Account Tag

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/email-accounts/tag-manager` |
| **Category** | email-account-tags |
| **Source** | https://api.smartlead.ai/api-reference/email-account-tags/create |
| **Auth** | API key (query param `api_key`) |

Renames an existing mailbox tag or changes its colour, leaving every mailbox it is attached to exactly as it was.

## 1. Epic

**Mailbox tagging and fleet segmentation**

Labels a Harry user can put on mailboxes — by domain, by client, by purpose, by "do not touch" — so a fleet of twenty mailboxes can be filtered, grouped and reasoned about instead of scrolled. It matters because once a workspace has more mailboxes than fit on a screen, every other mailbox decision starts with finding the right ones.

## 2. User story

**As a** workspace owner whose labelling scheme has drifted, **I want** to rename a tag and change its colour without touching the mailboxes carrying it, **so that** I can tidy up my labels without re-tagging a fleet.

**Acceptance criteria**
- [ ] Given a tag I own, when I post `id`, `name` and `color` — all three required by this endpoint — then the tag updates and the response returns the updated object (`{"ok": true, "data": {"id": 1, "name": "Primary Senders", "color": "#4CAF50"}}`).
- [ ] Given the colour format rule, when I send anything that is not a six-character hex with a `#` prefix, then the request is rejected with a 422 field-level message on `color`.
- [ ] Given the tag is attached to mailboxes, when I rename it, then every mailbox keeps the tag — the mapping is by id, not by name — and the new name appears everywhere on the next read.
- [ ] Given another mailbox tag in the workspace already uses the new name, when I save, then the request is rejected with a field-level message, so two mailbox tags can never look identical; a lead tag of the same name is not a clash, because tags are discriminated by what they apply to.
- [ ] Given a tag id from another workspace, when I update it, then the request fails and nothing changes, without confirming that the id exists.
- [ ] Given this endpoint requires an `id`, when a user means to create a tag, then the UI routes them to the create path instead — the docs are explicit that creation is a different endpoint.
- [ ] Given a rename, when it completes, then the activity trail records the old and new name so a teammate who filtered by the old label can work out what happened.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"id": 1, "name": "Primary Senders", "color": "#4CAF50"}` | 200, `{"ok": true, "data": {"id": 1, "name": "Primary Senders", "color": "#4CAF50"}}`; chips update everywhere on the next read |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session cookie | 401, `{"message": "Invalid API Key"}`; tag unchanged |
| TC-3 | Not found / wrong workspace | POST with a tag id from another workspace | 400 or 404 per the documented error shape; nothing changes and existence is not confirmed |
| TC-4 | Validation failure — colour | POST `{"id": 1, "name": "X", "color": "green"}` | 422 with a field-level message on `color` stating the `#RRGGBB` requirement |
| TC-5 | Rate limited | Save on every keystroke while renaming | 429 on the excess; the client debounces to one save and shows one "Saving…" state |
| TC-6 | Empty result set | POST with `name: ""` | 422 with a field-level message; the previous name is preserved and shown in the field |
| TC-7 | Duplicate name | Rename a tag to another existing tag's name | 422 naming the clash; the rename is refused rather than silently creating a lookalike |
| TC-8 | Mappings preserved | Rename a tag attached to five mailboxes, then re-read those mailboxes | All five still carry the tag, now under the new name |
| TC-9 | Missing required field | POST without `color` | 422 — all three fields are required by this endpoint, unlike the mailbox update endpoint's partial semantics |
| TC-10 | Contrast after a colour change | Set a very light colour | Accepted, but the chip's label switches to a dark foreground so the name stays readable |
| TC-11 | Concurrent edit | Two teammates rename the same tag at once | The second save is told the tag changed and is offered the current value rather than silently overwriting |
| TC-12 | Same name as a lead tag | Rename a mailbox tag to the name of an existing lead tag | 200 — no clash, because the unique constraint is per `applies_to`; neither tag appears in the other's picker |
| TC-13 | Lead tag id through the mailbox panel | PUT a tag id whose `applies_to` is `lead` | Rejected; a lead label cannot be edited from the mailbox tag panel |

## 4. Frontend user story

**As a** workspace owner, **I want** to edit a tag in place and see the change ripple through the list, **so that** tidying labels is a ten-second job.

**Scope**
- Mailboxes page: a "Manage tags" item in the page's overflow menu opening a small tag list — each row showing the tag chip, its name, and how many mailboxes carry it — with inline rename and a colour swatch picker.
- The colour picker offers a fixed palette of accessible swatches first, with a free hex field behind "Custom", so most users never type a hex code.
- States: saving per row, saved, field-level error keeping the entered value, and a conflict state when a teammate edited the same tag.
- Renaming shows the mailbox count so the user knows the blast radius before committing.
- Accessibility: chips always show the name as text; swatches carry accessible names, not just colour; the manage-tags panel is a labelled dialog with focus trap and Escape. Responsive: the panel becomes a full-screen sheet under 640px.

**Definition of done**
- [ ] Rename and recolour both save inline without a separate form page.
- [ ] The palette-first picker means a hex code is optional, never required.
- [ ] Chip label contrast is maintained automatically for any chosen colour.
- [ ] Saving, saved, error and conflict states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a tag update route that touches only the tag row, **so that** renaming can never disturb the mailbox mappings.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `PUT /api/tags/:id` taking `name` and `color`, both required as the API contract specifies. Note that SmartLead uses one endpoint — `POST /email-accounts/tag-manager` with a required body `id` — for both mailbox and lead tags, silently updating on collision; Harry splits that into `POST /api/tags` to create and `PUT /api/tags/:id` to update, so a create can never become a silent overwrite.
- Data model: updates the single `tags` table introduced by the tag-list story, **shared with lead tags** and discriminated by `applies_to` (`mailbox` | `lead`). The `mailbox_tag_map` join is untouched, which is precisely why renaming is safe. No migration.
- Validation: name is trimmed, non-empty and unique per `(workspace_id, applies_to, name)` (the existing unique constraint does the enforcing), so a mailbox tag and a lead tag may share a name without clashing; colour must match `^#[0-9A-Fa-f]{6}$`. `applies_to` is immutable — a mailbox tag can never be converted into a lead tag by an update.
- Concurrency: the row carries an `updated_at` that the client sends back, so a stale write is answered with a conflict rather than overwriting a teammate's change.
- Standard rate limiter; the client debounces. No retry logic — a single-row write either lands or reports.
- Logged: an `events` row with actor, tag id, old and new name and colour, so a renamed label can be traced.

**Definition of done**
- [ ] Renaming leaves every mapping intact, covered by a test.
- [ ] Unique name per workspace and `applies_to` is enforced by the database, not only the route.
- [ ] `applies_to` cannot be changed by an update, and a lead tag's id cannot be updated through the mailbox tag panel, both covered by tests.
- [ ] Colour validation is covered by a test including rejected formats.
- [ ] Cross-workspace updates fail without confirming existence, covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — Rename a tag without losing its mailboxes

**Preconditions:** A workspace with fifteen mailboxes, three tags, one tag attached to five mailboxes, and a second teammate signed in on another session.

**Flow**
1. Open Mailboxes, open "Manage tags", and note the mailbox count beside each tag.
2. Rename the five-mailbox tag and pick a new swatch.
3. Close the panel and check the chips on the list.
4. Filter by the renamed tag.
5. Have the teammate rename the same tag from their session, then save an older value from the first session.

**Assertions**
- [ ] The renamed tag still shows a count of five and those same five mailboxes carry it.
- [ ] Chips on the list show the new name and colour without a page reload.
- [ ] The tag filter matches the same five mailboxes as before the rename.
- [ ] The stale save is refused with a conflict message offering the current value.
- [ ] The activity trail shows both the old and new name.

**Teardown:** Restore the tag's original name and colour.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | "Manage tags" panel with inline rename and a swatch picker | Medium | Behind an overflow menu, opened rarely; the panel holds only tags, counts and two controls per row |
| Mailboxes | Chips reflect renames immediately | Low | Chips already exist |
| Settings | None | — | Tags are mailbox metadata; putting them in Settings would separate them from the only page that uses them |

**Verdict:** Fits an existing surface

Tag management belongs beside the mailboxes it labels, and an overflow-menu panel keeps it out of the way of the daily job. Editing rather than deleting-and-recreating is the whole point — it preserves the mappings — so the panel earns its place by making a destructive workaround unnecessary. No navigation item is added.
