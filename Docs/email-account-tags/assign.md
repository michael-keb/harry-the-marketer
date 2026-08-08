# Assign Tags to Email Accounts

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/email-accounts/tag-mapping` |
| **Category** | email-account-tags |
| **Source** | https://api.smartlead.ai/api-reference/email-account-tags/assign |
| **Auth** | API key (query param `api_key`) |

Attaches one or more existing tags to up to twenty-five mailboxes in a single request.

## 1. Epic

**Mailbox tagging and fleet segmentation**

Labels a Harry user can put on mailboxes — by domain, by client, by purpose, by "do not touch" — so a fleet of twenty mailboxes can be filtered, grouped and reasoned about instead of scrolled. It matters because once a workspace has more mailboxes than fit on a screen, every other mailbox decision starts with finding the right ones.

## 2. User story

**As a** workspace owner running mailboxes across several domains, **I want** to tag a batch of mailboxes in one action, **so that** I can label a whole domain's worth without clicking twenty rows.

**Acceptance criteria**
- [ ] Given mailboxes and tags I own, when I assign, then the mapping is created for every pairing in one request and the response confirms (`{"ok": true, "message": "Tags assigned successfully"}`).
- [ ] Given the documented batch bounds, when I assign, then `email_account_ids` must hold between 1 and 25 ids and `tag_ids` at least 1; anything outside returns 422 with a field-level message naming the offending array.
- [ ] Given a mailbox that already carries one of the tags, when I assign again, then the operation is idempotent — no duplicate mapping row, still a success response.
- [ ] Given any id in either array belongs to another workspace, when I assign, then the whole request fails and nothing is written — a partial assignment across a batch of twenty-five is worse than none.
- [ ] Given more than 25 mailboxes are selected in the UI, when I assign, then the client splits the work into batches of 25 and reports a single combined outcome, rather than surfacing the API's limit to the user.
- [ ] Given tags are assigned, when I return to the Mailboxes list, then the new tag chips appear on every affected row and the tag filter immediately matches them.
- [ ] Given an assignment, when it completes, then the activity trail records who tagged which mailboxes with which tags.
- [ ] Given tags are only labels, when they are assigned, then nothing about sending changes — no limit, no warm-up, no campaign attachment moves.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"email_account_ids": [101, 102, 103], "tag_ids": [1, 2]}` | 200, `{"ok": true, "message": "Tags assigned successfully"}`; all three mailboxes show both tag chips |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session cookie | 401, `{"message": "Invalid API Key"}`; no mapping written |
| TC-3 | Not found / wrong workspace | Include a mailbox id from another workspace | 404 or the documented 400; nothing written for any id in the batch |
| TC-4 | Validation failure — batch too large | POST 26 mailbox ids | 422 with a field-level message on `email_account_ids` naming the 25 limit |
| TC-5 | Rate limited | Assign in a burst across 200 mailboxes | 429 on the excess; the client backs off with jitter between batches and shows one progress state |
| TC-6 | Empty result set | POST `{"email_account_ids": [], "tag_ids": [1]}` | 422 with "Pick at least one mailbox"; the picker stays open showing its empty selection |
| TC-7 | No tags supplied | POST with `tag_ids: []` | 422 with a field-level message on `tag_ids` |
| TC-8 | Duplicate assignment | Run TC-1 twice | Second call 200; still exactly two tags per mailbox, no duplicate rows |
| TC-9 | Unknown tag id | Include a tag id that does not exist | Whole batch rejected with a message naming the tag id; nothing written |
| TC-10 | Over-25 selection in the UI | Select 60 mailboxes and assign one tag | Client sends three batches; the user sees one "Tagging 60 mailboxes…" state and one result, never the batch mechanics |
| TC-11 | Partial failure mid-batch | Force the second of three batches to fail | The user is told exactly how many succeeded and which failed, with a retry for the failed batch only |
| TC-12 | Sending unaffected | Assign tags to a mailbox mid-campaign | No change to daily limit, warm-up stage, campaign attachment or queued approvals |

## 4. Frontend user story

**As a** workspace owner, **I want** to select several mailboxes and tag them together, **so that** organising a big fleet takes one action rather than twenty.

**Scope**
- Mailboxes page: row checkboxes and a selection bar that appears only when something is selected, offering "Add tags" (and, from the removal story, "Remove tags"). This is the first multi-select on the page, so it follows the pattern the Leads page already uses for bulk actions.
- The tag picker in the selection bar lists every tag from the master tag list, with a "Create tag" option inline so a user never has to leave to make the tag they need.
- States: nothing selected (bar hidden), applying (bar shows progress across batches as one figure), success (chips appear on rows immediately), partial failure (count of successes and a retry for the rest).
- Selection survives the assignment so a user can add a second tag without reselecting.
- Accessibility: checkboxes are real inputs with accessible names including the address; the selection bar is announced when it appears and its count is live; the picker is a keyboard-navigable listbox. Responsive: the selection bar docks to the bottom of the viewport under 768px.

**Definition of done**
- [ ] Multi-select, select-all-on-page and clear-selection all work.
- [ ] The 25-per-request limit is never visible to the user.
- [ ] Partial failure reports exactly what succeeded and offers a targeted retry.
- [ ] Hidden, applying, success and partial-failure states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a batch tag-assignment route, **so that** the UI can label a fleet in a few requests without hand-rolling loops.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `POST /api/tags/assign` taking `{ appliesTo: "mailbox", mailboxIds: [], tagIds: [] }`, capped at 25 mailbox ids per request to match the documented contract.
- Data model: a `mailbox_tag_map` join table in `server/db.js` (`mailbox_id`, `tag_id`, `created_at`) with a unique constraint on the pair so repeat assignment is idempotent. The tag rows live in the single `tags` table, **shared with lead tags** and discriminated by `applies_to` (`mailbox` | `lead`); this route rejects any tag id whose `applies_to` is not `mailbox`, so a lead label can never be stuck on a mailbox.
- Every id in both arrays is validated against the caller's workspace and against the `applies_to` discriminator before any write, and the whole batch runs in one transaction so a bad id leaves nothing assigned.
- Pagination does not apply. The standard app rate limiter applies; the client is responsible for spacing batches and backing off on 429.
- Logged: one `events` row per assignment naming actor, tags and the mailboxes affected — one row per batch, not per pairing, so the trail stays readable.

**Definition of done**
- [ ] Unique constraint makes repeat assignment a no-op, covered by a test.
- [ ] A cross-workspace id anywhere in the batch rolls the whole transaction back, covered by a test.
- [ ] A tag whose `applies_to` is `lead` is rejected for mailbox assignment, covered by a test.
- [ ] The 25-id cap is enforced server-side with a field-level 422.
- [ ] Assignment writes exactly one activity-trail entry per batch.

## 6. End-to-end test ticket

**Title:** E2E — Tag a fleet of mailboxes in one go

**Preconditions:** A workspace with thirty sandbox mailboxes across two domains, three existing tags, one campaign running on two of the mailboxes.

**Flow**
1. Open Mailboxes and use the text filter to narrow to one domain.
2. Select all visible rows.
3. Open "Add tags" and choose two tags, creating a third from inside the picker.
4. Apply.
5. Clear the selection and use the tag filter to check the result.
6. Open the campaign and confirm nothing about its sending changed.

**Assertions**
- [ ] All matching mailboxes show all three chips, with the correct colours.
- [ ] The user sees a single progress state and a single result, with no sign that the work was split into batches.
- [ ] Filtering by the new tag returns exactly the mailboxes that were selected.
- [ ] The campaign's mailbox attachment, daily limits and warm-up stages are unchanged.
- [ ] The activity trail records the assignment with the actor and the tag names.

**Teardown:** Remove the three tags from the mailboxes and delete the tag created during the test.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Row checkboxes and a bulk-action selection bar | Medium | The bar exists only while a selection exists, and copies the Leads page's bulk pattern so nothing new is learned |
| Mailboxes | Tag chips on rows | Low | Chips already introduced by the mailbox list work |
| Mailbox detail sheet | Add-tag control for a single mailbox | Low | One control in an existing section |
| Everywhere else | None | — | Tags are a mailbox-only concept |

**Verdict:** Fits an existing surface

Tagging belongs on the page that lists the things being tagged, and Harry already has a bulk-selection idiom on the Leads page to copy. The genuinely new element is multi-select on Mailboxes, which stays invisible until the user ticks a box. No navigation item is added.
