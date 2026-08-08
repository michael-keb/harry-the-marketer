# Create Tag

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/email-accounts/tag-manager` |
| **Category** | lead-tags |
| **Source** | https://api.smartlead.ai/api-reference/lead-tags/create |
| **Auth** | API key (query param `api_key`) |

Creates a named, coloured label — or updates one that already exists — for use on both leads and mailboxes.

## 1. Epic

**Lead labels across campaigns**

Gives every lead a small set of named, coloured labels the user defines — "VIP", "Enterprise", "Met at a conference" — that cut across campaigns and stages, can be applied in bulk, and can be filtered on anywhere leads are listed. It matters because Harry's stage strip answers "where is this person in the funnel" but nothing answers "why do I care about this person", which is the question that decides who gets chased first.

## 2. User story

**As a** campaign owner, **I want** to define a label with a name and a colour, **so that** I can mark leads with the distinctions that matter to my business rather than the ones the product guessed.

**Acceptance criteria**
- [ ] Given a `name` such as "VIP" and a `color` such as `#FF5733`, when I create the label, then a 200 returns `data.id`, `data.name` and `data.color`, and the label is immediately selectable in every label picker.
- [ ] Given the source endpoint requires `id` in the body and treats an existing id as an update, when Harry implements it, then create and update are two separate routes — the client never has to invent an id, and an accidental id collision cannot silently overwrite an existing label.
- [ ] Given a `color` that is not a valid hex code, when I submit, then a 422 names `color` and states the expected format; the picker only offers valid values in the first place.
- [ ] Given a `name` that is empty, whitespace-only, or already used in my workspace, when I submit, then a 422 or a friendly conflict message is returned and no second label with that name is created.
- [ ] Given the source API creates tags at account level for both email accounts and leads, when Harry stores a label, then it records which surfaces it applies to, so a mailbox label does not clutter the lead picker and the other way round.
- [ ] Given a label is created, when I look at it, then it shows a count of how many leads carry it, starting at zero with an empty state that offers "Apply to selected leads".
- [ ] Given I pick a colour with poor contrast, when the chip renders, then the text colour is chosen automatically so the label is always readable, and the name is always shown alongside the colour.
- [ ] Given a label is created, when I look at the activity trail, then one entry records the actor, the name and the colour.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"name":"VIP","color":"#FF5733"}` | 200 with `data: {id, name: "VIP", color: "#FF5733"}`; label appears in every picker |
| TC-2 | Missing/invalid API key | Repeat TC-1 unauthenticated | 401, `{"message":"Invalid API Key"}`; the typed name and colour are preserved |
| TC-3 | Not found / wrong workspace | Update a label id owned by another workspace | 404; that label is unchanged and its name is not leaked |
| TC-4 | Validation failure — bad colour | POST `{"name":"VIP","color":"red"}` | 422 with a field-level message on `color` naming the hex format |
| TC-5 | Rate limited | Create 40 labels in quick succession | 429 on the excess; the client backs off and retries, no duplicate labels |
| TC-6 | Empty result set | Open the label picker in a workspace with no labels | 200 with an empty list; "No labels yet — create one" with an inline create field |
| TC-7 | Duplicate name | POST `{"name":"VIP","color":"#4CAF50"}` when "VIP" exists | Refused with a message naming the existing label and offering to open it |
| TC-8 | Missing name | POST `{"color":"#FF5733"}` | 400 for the malformed body; message states `name` is required |
| TC-9 | Contrast handling | Create a label with `#FFFF00` | 200; the chip renders with dark text and passes a 4.5:1 contrast check |
| TC-10 | Surface scoping | Create a lead label, then open the Mailboxes page | The lead label is not offered as a mailbox label unless it was created for both |
| TC-11 | Update path | PUT an existing label's name and colour | 200; every chip already applied to leads reflects the new name and colour without re-tagging anything |

## 4. Frontend user story

**As a** campaign owner, **I want** to create a label from inside the picker I am already using, **so that** I never have to leave what I am doing to go and define one first.

**Scope**
- Every label picker (lead detail, Leads bulk action bar, Segments panel) ends with "Create label", which expands into a name field and a small swatch row of preset colours plus a custom hex field — no separate page, no navigation.
- Settings → a "Labels" section for housekeeping only: rename, recolour, delete, and see how many leads carry each. This is where labels are managed, not where they are made.
- States: the create row is disabled while the name is empty; a duplicate name errors inline with a link to the existing label; on success the new label is created, immediately applied to whatever the picker was opened for, and moved to the top of the list.
- Colours come from a curated palette by default so that a workspace's labels stay visually distinguishable; the custom field is available but secondary.
- Accessibility: swatches are radio buttons with visible names ("Coral", "Green"), not colour-only targets; text colour on the chip is derived to meet 4.5:1; the created label is announced via `aria-live="polite"`. Responsive: the swatch row wraps under 640px.

**Definition of done**
- [ ] A label can be created without leaving the picker.
- [ ] Colours are never the only way to tell two labels apart.
- [ ] Chip text contrast is computed, not hand-picked.
- [ ] Managing labels lives in Settings; creating them lives inline.

## 5. Backend user story

**As a** Harry API, **I want** separate create and update routes for a workspace-scoped label, **so that** the client never has to supply an id and cannot overwrite an existing label by accident.

**Scope**
- Routes in `server/routes.js`: `POST /api/tags` taking `{ name, color, appliesTo }` and `PUT /api/tags/:id` for edits — deliberately splitting the source API's single upsert endpoint, whose required body `id` is a footgun.
- Data model: a `tags` table in `server/db.js` (`id`, `workspace_id`, `name`, `color`, `applies_to`, `created_at`) with a unique index on `(workspace_id, lower(trim(name)))`. `applies_to` records whether the label is for leads, mailboxes, or both, so the same table can back the email-account tag feature without the two cluttering each other's pickers.
- `color` is validated as a hex code server-side and normalised to lowercase six-digit form; `name` is trimmed and length-capped. Duplicate-name violations return a friendly response carrying the existing label's id.
- No pagination on create. Standard app rate limiting; the client retries 429 with backoff.
- Logged: an `events` row (actor, label id, name, colour); `telemetry` records how many labels a workspace has, since an unbounded label count is the first sign the feature is being misused as a CRM.

**Definition of done**
- [ ] Create never requires the client to supply an id.
- [ ] Label names are unique per workspace, case- and whitespace-insensitively.
- [ ] `applies_to` keeps lead labels and mailbox labels out of each other's pickers.
- [ ] Tests cover hex validation, the duplicate-name path, and the update route preserving existing lead mappings.

## 6. End-to-end test ticket

**Title:** E2E — Create a label mid-flow and manage it later

**Preconditions:** A workspace with 30 leads, no labels, and at least one connected mailbox.

**Flow**
1. Open Leads, tick five rows, open the Labels bulk action.
2. Choose Create label, name it "VIP", pick a preset colour, save.
3. Confirm it applied to the five selected leads.
4. Open Mailboxes and check the mailbox label picker.
5. Open Settings → Labels, rename it to "Priority" and change its colour.
6. Return to Leads.

**Assertions**
- [ ] The label is created and applied in one interaction, with no page change.
- [ ] The five leads carry the chip and the label shows a count of 5.
- [ ] The lead label does not appear in the mailbox picker.
- [ ] After the rename, all five chips read "Priority" in the new colour without re-tagging.
- [ ] Attempting to create a second "Priority" is refused inline with a link to the first.
- [ ] Chip text remains readable against the new colour.

**Teardown:** Delete the label from Settings → Labels.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Every label picker | A "Create label" row with name and a swatch palette | Low | It is the last row of a picker that has to exist anyway; no separate creation screen |
| Settings | A "Labels" section for rename, recolour, delete and counts | Low | Settings is already where workspace-level housekeeping lives; it is one more section, not a new page |
| Leads, Inbox, Segments | Chips render wherever a lead does | Medium | Chips are hidden entirely until a workspace creates its first label, so nothing changes for users who never adopt it |

**Verdict:** Fits an existing surface

Creating a label is only ever wanted at the moment of applying one, so it belongs at the bottom of the picker rather than behind a management screen the user must visit first. The one deliberate departure from the source API is splitting its single upsert endpoint into create and update, because an endpoint that requires the caller to supply an id and silently overwrites on collision is exactly the kind of thing that makes a user think.
