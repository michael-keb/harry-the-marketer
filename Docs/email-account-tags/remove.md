# Remove Tags from Email Accounts

| | |
|---|---|
| **Endpoint** | `DELETE https://server.smartlead.ai/api/v1/email-accounts/tag-mapping` |
| **Category** | email-account-tags |
| **Source** | https://api.smartlead.ai/api-reference/email-account-tags/remove |
| **Auth** | API key (query param `api_key`) |

Takes tags off one or more mailboxes without deleting the tags themselves.

## 1. Epic

**Mailbox tagging and fleet segmentation**

Labels a Harry user can put on mailboxes — by domain, by client, by purpose, by "do not touch" — so a fleet of twenty mailboxes can be filtered, grouped and reasoned about instead of scrolled. It matters because once a workspace has more mailboxes than fit on a screen, every other mailbox decision starts with finding the right ones.

## 2. User story

**As a** workspace owner who has finished a client engagement, **I want** to strip a tag off a batch of mailboxes while keeping the tag for future use, **so that** cleaning up does not mean rebuilding my labelling scheme.

**Acceptance criteria**
- [ ] Given mailboxes and tags I own, when I remove, then only the mappings are deleted and the tags survive — the endpoint's stated behaviour is that it does not delete the tags themselves — and the response is `{"ok": true, "message": "Tags removed successfully"}`.
- [ ] Given the documented bounds, when I remove, then `email_account_ids` and `tag_ids` must each hold at least one entry, and an empty array is rejected with a 422 field-level message rather than being treated as "remove everything".
- [ ] Given a mailbox that does not carry the tag, when it is included in the batch, then the request still succeeds — removal is idempotent — and no error is raised for that pairing.
- [ ] Given any id in either array belongs to another workspace, when I remove, then the whole request fails and nothing is deleted.
- [ ] Given a tag whose `applies_to` is `lead`, when it is included, then the request is rejected — lead labels are not mailbox labels, and the shared tag table is discriminated so they cannot cross.
- [ ] Given a tag is left on no mailboxes at all, when the removal completes, then the tag still appears in the master tag list with a count of zero, ready to reuse.
- [ ] Given the tag being removed is the one currently filtering the Mailboxes list, when removal completes, then the list refreshes and says the filter now matches fewer mailboxes, rather than appearing to lose rows.
- [ ] Given a removal, when it completes, then the activity trail records who removed which tags from which mailboxes.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | DELETE with `{"email_account_ids": [101, 102], "tag_ids": [1]}` | 200, `{"ok": true, "message": "Tags removed successfully"}`; the chip disappears from both rows |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session cookie | 401, `{"message": "Invalid API Key"}`; nothing removed |
| TC-3 | Not found / wrong workspace | Include a mailbox id from another workspace | The documented 400; nothing removed for any id in the batch |
| TC-4 | Validation failure | DELETE with `tag_ids: []` | 422 with a field-level message on `tag_ids` stating at least one is required |
| TC-5 | Rate limited | Remove across 200 mailboxes in a burst | 429 on the excess; the client spaces batches, backs off with jitter, and shows one progress state |
| TC-6 | Empty result set | Remove a tag from mailboxes that none of them carry | 200 and idempotent; the UI reports "Nothing to remove" rather than claiming a change |
| TC-7 | Tag survives | After TC-1, open the master tag list | The tag is still listed, now with a lower mailbox count |
| TC-8 | Tag falls to zero | Remove a tag from its last mailbox | Tag remains in the list with a count of zero and is still selectable in pickers |
| TC-9 | Lead tag id supplied | Include a tag whose `applies_to` is `lead` | Rejected with a field-level message; nothing removed |
| TC-10 | Removing while filtered | Filter the list by tag X, select all, remove tag X | The list empties and says the active filter now matches nothing, with a clear-filter action — not the first-run empty state |
| TC-11 | Partial batch failure | Force one of several client-side batches to fail | The user is told how many succeeded and offered a retry for only the failed batch |
| TC-12 | Sending unaffected | Remove tags from a mailbox mid-campaign | No change to daily limit, warm-up, suspension state, campaign attachment or queued approvals |

## 4. Frontend user story

**As a** workspace owner, **I want** removing a tag to feel obviously different from deleting it, **so that** I never hesitate over whether cleaning up will destroy my scheme.

**Scope**
- Mailboxes page: "Remove tags" sits beside "Add tags" in the bulk-selection bar, and each chip on a row and in the mailbox detail sheet carries a small remove control for the single-mailbox case.
- The bulk remove picker lists only tags actually present on the selection, with the count carried by each, so a user cannot ask to remove something that is not there.
- Copy is explicit: "Remove from 4 mailboxes — the tag itself is kept". Deleting a tag entirely lives in the "Manage tags" panel and is worded differently.
- States: removing (progress across batches as one figure), removed (chips disappear immediately), nothing-to-remove, partial failure with a targeted retry.
- Accessibility: chip remove controls have accessible names including both the tag and the mailbox; the selection bar's count is live; removal is announced. Responsive: the selection bar docks to the bottom under 768px.

**Definition of done**
- [ ] Remove-from-mailboxes and delete-the-tag are worded and placed so they cannot be confused.
- [ ] The bulk picker offers only tags present on the selection.
- [ ] Removing while a tag filter is active explains the emptied list rather than looking like data loss.
- [ ] Removing, removed, nothing-to-remove and partial-failure states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a batch mapping-removal route, **so that** unlabelling is cheap and can never take a tag with it.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `DELETE /api/tags/assign` taking `{ appliesTo: "mailbox", mailboxIds: [], tagIds: [] }`, matching the assignment route's shape so the pair is symmetrical.
- Data model: deletes rows from the `mailbox_tag_map` join only. The tag rows live in the single `tags` table, **shared with lead tags** and discriminated by `applies_to` (`mailbox` | `lead`); this route never touches that table, which is what makes "the tag is kept" structurally true rather than a promise. Deleting a tag outright is a separate route on `tags`.
- Every id in both arrays is validated against the caller's workspace and against `applies_to = 'mailbox'` before any write, and the batch runs in one transaction so a bad id removes nothing.
- Removal is idempotent: deleting a mapping that does not exist affects zero rows and still succeeds. The client mirrors the assignment route's 25-per-request batching so the two behave identically.
- Standard rate limiter; the client spaces batches and backs off on 429.
- Logged: one `events` row per batch naming actor, tags and mailboxes, so a chip that vanished can be traced.

**Definition of done**
- [ ] A test asserts the `tags` table is unchanged by any removal.
- [ ] Idempotent removal is covered by a test.
- [ ] A cross-workspace or wrong-`applies_to` id anywhere in the batch rolls the transaction back, covered by a test.
- [ ] Removal writes exactly one activity-trail entry per batch.

## 6. End-to-end test ticket

**Title:** E2E — Strip a tag from a fleet without losing the tag

**Preconditions:** A workspace with twenty sandbox mailboxes, twelve carrying the tag "Client A", one campaign running on two of them, one lead carrying a lead tag also named "Client A".

**Flow**
1. Open Mailboxes and filter by "Client A".
2. Select all twelve and choose "Remove tags".
3. Confirm the picker offers only "Client A" and shows a count of twelve.
4. Remove.
5. Open "Manage tags".
6. Re-apply the tag to three mailboxes and remove it from a single mailbox using the chip control.
7. Open the campaign.

**Assertions**
- [ ] The filtered list empties and explains that the active filter now matches nothing, with a clear-filter action.
- [ ] "Manage tags" still lists "Client A", now with a count of zero.
- [ ] The lead's tag of the same name is untouched.
- [ ] The single-chip removal takes the tag off exactly one mailbox.
- [ ] The campaign's mailbox attachment, limits, warm-up and queued approvals are unchanged.
- [ ] The activity trail shows the bulk removal as one entry and the single removal as another.

**Teardown:** Delete the test tag from "Manage tags"; leave the lead tag in place.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | "Remove tags" in the bulk-selection bar | Low | The bar already exists for adding; this is a second button in it |
| Mailboxes | Remove control on each chip | Low | Appears on hover and focus, standard chip behaviour |
| Mailbox detail sheet | Same chip control | Low | Reuses the sheet's tag section |
| Mailboxes | Explanation when a tag filter empties the list | Low | Reuses the filtered-empty state the list work already defines |

**Verdict:** Fits an existing surface

Removal is the mirror of assignment and lives in the same bar and the same chips, so it costs one button and one small control. The one thing worth designing carefully is the wording, so that taking a label off a mailbox is never mistaken for destroying the label — which is precisely the distinction this endpoint makes. No navigation item is added.
