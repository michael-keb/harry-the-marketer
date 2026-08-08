# Get Lead Categories

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/leads/fetch-categories` |
| **Category** | leads |
| **Source** | https://api.smartlead.ai/api-reference/leads/categories |
| **Auth** | API key (query param `api_key`) |

Lists the labels you can put on a lead — the built-in ones and any you have created yourself — each carrying a positive, negative or neutral sentiment.

## 1. Epic

**The prospect record and its lifecycle**

Everything Harry holds about a person — their details and custom fields, which campaigns they sit in, what has been sent to them, and whether they are running, paused, unsubscribed or gone — plus every way that record is created, read, corrected and retired. It matters because the composer, the qualification scorer and the derived progress stage all read this one record, so a stale or wrong lead means a wrong email.

## 2. User story

**As a** campaign owner, **I want** a list of the labels I can apply to a lead, each marked positive, negative or neutral, **so that** I can group people by what I have decided about them rather than only by what the engine derived.

**Acceptance criteria**
- [ ] Given the workspace, when I ask for categories, then I get an array of objects each with an id, a name, a sentiment of `positive`, `negative` or `neutral`, and a created-at timestamp.
- [ ] Given a fresh workspace, when I ask for categories, then Harry's built-in set is returned — matching the reply intents the classifier already knows (`interested`, `not interested`, `not now`, `question`, `unsubscribe`, `out of office`) — so the list is never empty.
- [ ] Given built-in and workspace-created categories, when the list is returned, then it is ordered with the built-ins first and clearly distinguishes which ones the workspace can rename or delete.
- [ ] Given a category is in use on leads, when I try to delete it, then the deletion is refused with a count of the leads still carrying it and an option to reassign them.
- [ ] Given a category's sentiment, when Reports groups leads, then positive categories roll into the interested-and-beyond side of the funnel and negative ones into lost, without changing the derived stage itself.
- [ ] Given the API key is missing or wrong, when the list is requested, then a 401 is returned and the filter control shows a sign-in prompt rather than an empty dropdown.
- [ ] Given a category name that already exists in the workspace, when I create it, then it is refused with a message naming the existing category.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Request categories in a workspace with three built-ins and one custom | 200 with four objects, each carrying id, name, sentiment and created-at, built-ins first by id |
| TC-2 | Missing/invalid API key | Request with no session | 401; the category filter shows a sign-in prompt, not "no categories" |
| TC-3 | Wrong workspace | Request another workspace's custom category by id | 404; the custom category does not appear in this workspace's list |
| TC-4 | Validation failure | Create a category with an empty name | 422 with a field-level message on the name; the list is unchanged |
| TC-5 | Rate limited | Request the list on every keystroke of a filter box | 429 after the burst; the client debounces and caches the list rather than refetching |
| TC-6 | Empty result set | Request in a workspace with the built-ins removed by migration | 200 with an empty array; the filter control hides itself rather than showing an empty dropdown |
| TC-7 | Sentiment filter | Filter the returned list to `positive` | Only positive categories are returned, matching the sentiment field exactly |
| TC-8 | Duplicate name | Create a category named "Interested" when a built-in of that name exists | Refused with a message pointing at the existing one |
| TC-9 | Delete a category in use | Delete a category applied to 12 leads | Refused with the count and a reassign option; no lead loses its label silently |
| TC-10 | Long name | Create a 300-character category name | Rejected with a length limit stated in the message; the chip layout never has to truncate mid-word |

## 4. Frontend user story

**As a** campaign owner, **I want** to label a lead with my own judgement and filter the Leads page by that label, **so that** my read on a person survives beyond the reply that produced it.

**Scope**
- Leads: the existing click-to-filter stage strip gains a second, quieter filter for categories; the stage strip stays primary because stage is derived and cannot drift.
- Leads → lead detail and Inbox → thread: a category picker, showing the sentiment as a small text label rather than colour alone.
- Settings: a short list where custom categories are added, renamed and removed, sitting beside the existing business-context settings rather than as a new section.
- Loading: the picker shows its last known list while refreshing. Empty: "No categories yet" with an inline "Add one". Error: the picker is disabled with the reason in text.
- Accessibility: sentiment is announced as text ("Interested — positive"); the picker is a native select on mobile. Responsive: the category filter collapses into the existing filter menu under 640px.

**Definition of done**
- [ ] Category and stage are visibly different things, and nothing implies a category changes the derived stage.
- [ ] The category list is fetched once per session and cached, not on every filter interaction.
- [ ] Built-in categories cannot be deleted, only hidden.
- [ ] A lead's category appears everywhere the lead does: Leads row, lead detail, Inbox thread header.

## 5. Backend user story

**As a** Harry API, **I want** a workspace-scoped category list with sentiment, **so that** the UI and Reports read the same vocabulary and nothing hardcodes label names.

**Scope**
- Routes in `server/routes.js`: `GET /api/lead-categories`, plus `POST`, `PATCH` and `DELETE` for workspace-created ones, all workspace-scoped like the existing lead handlers.
- Data model: a new `lead_categories` table in `server/db.js` (id, workspace, name, sentiment, is_builtin, created_at) and a nullable `category_id` on `leads`. Built-ins are seeded per workspace from the classifier's known intents so the vocabulary matches what the engine produces.
- Deletion is refused while leads reference the category; the API returns the reference count so the UI can offer a reassign.
- No pagination — the list is small and cached client-side for the session. Standard rate limiting applies.
- Logged: `events` rows for create, rename and delete (they are workspace configuration changes); no telemetry on the read.

**Definition of done**
- [ ] Sentiment is constrained to `positive`, `negative` or `neutral` at the database level.
- [ ] Built-in categories exist in every new workspace and cannot be deleted.
- [ ] Name uniqueness is enforced per workspace, case-insensitively.
- [ ] Reports reads sentiment from this table rather than matching on names.

## 6. End-to-end test ticket

**Title:** E2E — Create a category, label a lead, and filter by it

**Preconditions:** A workspace with ten leads at mixed stages and the built-in categories seeded.

**Flow**
1. Settings → Lead categories → add "Follow up later" with neutral sentiment.
2. Leads → open a lead → set its category to "Follow up later".
3. Return to Leads and filter by that category.
4. Open Reports and read the funnel.
5. Settings → try to delete "Follow up later".

**Assertions**
- [ ] The new category appears in the picker immediately, without a reload.
- [ ] Filtering by it returns exactly the one labelled lead.
- [ ] The lead's derived stage is unchanged by the labelling.
- [ ] Reports groups the neutral category outside the positive and negative buckets.
- [ ] Deleting is refused with "1 lead still uses this", and offers to reassign.

**Teardown:** Reassign the lead to no category and delete "Follow up later".

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Leads | Secondary category filter beside the stage strip | Medium | Collapsed into the existing filter menu; the derived stage strip stays the primary way to slice the list |
| Leads → lead detail | Category picker | Low | One control in the existing header block |
| Inbox → thread | Category picker in the thread header | Low | Same component as the lead detail |
| Settings | Short category management list | Low | A list with add and rename, not a new page |
| Reports | Sentiment grouping in the funnel | Low | Uses an existing chart, adds no new report |

**Verdict:** Fits an existing surface

Harry already derives a stage from real evidence and filters the Leads page by it; a category is the human's own opinion sitting alongside that, which is a different thing and must not be confused with it. Keeping the category filter secondary and the picker inline avoids teaching users a second, competing pipeline.
