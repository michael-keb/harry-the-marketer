# Get Email Account Tags

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/email-accounts/tag-list` |
| **Category** | email-account-tags |
| **Source** | https://api.smartlead.ai/api-reference/email-account-tags/get-all |
| **Auth** | API key (query param `api_key`) |

Given a list of email addresses, returns the mailbox id and the tags carried by each one.

## 1. Epic

**Mailbox tagging and fleet segmentation**

Labels a Harry user can put on mailboxes — by domain, by client, by purpose, by "do not touch" — so a fleet of twenty mailboxes can be filtered, grouped and reasoned about instead of scrolled. It matters because once a workspace has more mailboxes than fit on a screen, every other mailbox decision starts with finding the right ones.

## 2. User story

**As a** workspace owner holding a list of sending addresses from a spreadsheet, **I want** to look up what each of them is tagged with by address rather than by id, **so that** I can reconcile my own records against Harry without knowing internal ids.

**Acceptance criteria**
- [ ] Given a list of addresses, when I look them up, then each match returns `email_account_id`, `from_email` and a `tags` array whose entries carry `id`, `name` and `color`.
- [ ] Given at least one address is required, when I send an empty `email_ids` array, then the request is rejected with a 422 field-level message rather than returning every mailbox.
- [ ] Given an address that is not a mailbox in my workspace, when I look it up, then it is simply absent from the results — the response shape is a list of matches, so unmatched addresses must be reported to the user as "not found here" rather than silently dropped.
- [ ] Given a mailbox with no tags, when it is returned, then its `tags` array is empty rather than the row being omitted, so the caller can tell "untagged" from "unknown".
- [ ] Given addresses differing only in case or surrounding whitespace, when I look them up, then matching is case-insensitive and trimmed, because the addresses come from spreadsheets.
- [ ] Given the returned tags, when they are rendered, then only mailbox tags appear — tags in Harry carry an `applies_to` discriminator, so a lead tag of the same name is never returned here.
- [ ] Given no session, when I look up, then the response is 401 `{"message": "Invalid API Key"}` and no result list is rendered.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"email_ids": ["sender@company.com", "outreach@company.com"]}` where both exist and one is tagged | 200, `{"ok": true, "data": [{"email_account_id": 101, "from_email": "sender@company.com", "tags": [{"id": 1, "name": "Primary Senders", "color": "#4CAF50"}]}, …]}` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no session cookie | 401, `{"message": "Invalid API Key"}`; nothing rendered |
| TC-3 | Not found / wrong workspace | Look up an address that is a mailbox in another workspace | Absent from `data`; the UI lists it under "Not found in this workspace", never confirming it exists elsewhere |
| TC-4 | Validation failure | POST `{"email_ids": []}` | 422 with a field-level message stating at least one address is required |
| TC-5 | Rate limited | Look up on every keystroke of a paste-in box | 429 on the excess; the client debounces and backs off with jitter, keeping the last good result |
| TC-6 | Empty result set | Look up three addresses, none of which exist | 200 with an empty `data`; the UI says none of the three were found and lists them |
| TC-7 | Untagged mailbox | Look up an existing mailbox with no tags | Row present with `tags: []`; UI shows "No tags" on that row, distinct from "not found" |
| TC-8 | Case and whitespace | Look up `" Sender@Company.com "` | Matches `sender@company.com`; the response echoes the stored address, not the typed one |
| TC-9 | Duplicate addresses in the request | Send the same address twice | Returned once; the client does not render a duplicate row |
| TC-10 | Large batch | Send 500 addresses | Either handled or rejected with a stated per-request cap; the client chunks and shows one combined result, never a raw limit error |
| TC-11 | Lead tags excluded | Give a lead the same tag name as a mailbox tag, then look up the mailbox | Only the mailbox tag is returned, proving the `applies_to` discriminator holds |

## 4. Frontend user story

**As a** workspace owner reconciling a spreadsheet, **I want** to paste a column of addresses and see what each is tagged with, **so that** I can spot the mailboxes I forgot to label.

**Scope**
- Mailboxes page: a "Look up by address" option in the page overflow menu, opening a panel with a paste box (one address per line or comma-separated) and a results table of address, mailbox status and tag chips.
- Results separate cleanly into three groups: found and tagged, found and untagged, and not found in this workspace — the three questions a reconciliation actually asks.
- From the results, a user can select the untagged rows and tag them in place, reusing the bulk tag picker rather than sending them back to the list.
- States: idle (paste box focused), looking up (progress across chunks as one figure), results, and error with the pasted text preserved.
- Accessibility: the paste box is a labelled textarea; the results table has real header cells and the group each row belongs to is text, not colour; chips show names. Responsive: the results table scrolls inside its own container under 640px so the page never scrolls sideways.

**Definition of done**
- [ ] Found-untagged and not-found are visibly distinct groups.
- [ ] Any per-request cap is handled by chunking, never surfaced to the user.
- [ ] Untagged results can be tagged without leaving the panel.
- [ ] Idle, looking-up, results and error states are designed and verified in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** an address-keyed tag lookup, **so that** external records can be reconciled without exposing internal mailbox ids.

**Scope**
- Route in `server/routes.js` following the existing workspace-scoped pattern: `POST /api/tags/lookup` taking `{ appliesTo: "mailbox", emails: [] }` and returning `[{ mailboxId, fromEmail, tags: [] }]`. It is a POST because the input is a list, not because it writes anything.
- Data model: reads the `mailbox_tag_map` join against the single `tags` table, **shared with lead tags** and discriminated by `applies_to` (`mailbox` | `lead`); the query filters on `applies_to = 'mailbox'` so a lead label can never be returned for a mailbox.
- Addresses are normalised — trimmed and lower-cased — before matching, and the response echoes the stored address so the caller sees canonical values.
- A per-request cap on the address list is enforced with a field-level 422; the client chunks. The standard app rate limiter applies and the client backs off on 429 between chunks.
- Logged: nothing per read; `telemetry` records lookup latency and batch size so an oversized paste shows up in Monitoring rather than as a slow page.

**Definition of done**
- [ ] Cross-workspace addresses are absent from results with no existence leak, covered by a test.
- [ ] Case and whitespace normalisation is covered by a test.
- [ ] A test asserts lead tags never appear in a mailbox lookup.
- [ ] Untagged mailboxes return an empty array rather than being omitted, covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — Reconcile a spreadsheet of sending addresses

**Preconditions:** A workspace with eight mailboxes, three tagged; a fourth address that belongs to another workspace; a fifth that exists nowhere; one lead carrying a lead tag whose name matches a mailbox tag.

**Flow**
1. Open Mailboxes and choose "Look up by address".
2. Paste ten addresses, including the foreign one, the non-existent one, and some with odd casing and trailing spaces.
3. Run the lookup.
4. Read the three result groups.
5. Select the untagged rows and apply a tag from inside the panel.
6. Close the panel and check the list.

**Assertions**
- [ ] Odd casing and whitespace still match, and the results show the stored address.
- [ ] The foreign address and the non-existent one both appear under "not found", with no hint that one exists elsewhere.
- [ ] Untagged mailboxes appear as a distinct group, not mixed in with not-found.
- [ ] The lead tag with the matching name does not appear anywhere in the results.
- [ ] Tagging from inside the panel is reflected on the Mailboxes list without a reload.

**Teardown:** Remove the tag applied during the test.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | "Look up by address" panel with a paste box and a results table | Medium | Behind the page's overflow menu, opened only for reconciliation; it reuses the bulk tag picker rather than inventing controls |
| Mailboxes | None to the default view | Low | The list is untouched when the panel is closed |
| Everywhere else | None | — | The lookup is a mailbox-page tool, not a global search |

**Verdict:** Fits an existing surface

This is a reconciliation tool, not a daily one, so it belongs behind an overflow menu on the page that owns mailboxes. Its value is the three-way split — tagged, untagged, not here — which is exactly the answer someone comparing a spreadsheet needs and which no existing screen gives. No navigation item is added.
