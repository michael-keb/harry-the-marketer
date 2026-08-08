# Sender Account List

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/sender-accounts` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/sender-list |
| **Auth** | API key (query param `api_key`) |

Lists the sending addresses that took part in a deliverability test.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner reading a placement report, **I want** to see which of my sending addresses the test actually used, **so that** I know whether the result applies to the mailbox I am worried about.

**Acceptance criteria**
- [ ] Given a test, when I fetch its sender accounts, then I get one entry per address with `id`, `spam_test_id`, `from_email`, `created_at`, `updated_at`, `client_id` and `user_id`.
- [ ] Given each entry, when it renders, then the `from_email` is matched to a connected Harry mailbox where one exists, and shown as an unmatched address where none does.
- [ ] Given an address is unmatched, when it renders, then it is labelled "not connected in Harry" rather than silently omitted, because that is often the mistake being diagnosed.
- [ ] Given `spam_test_id` on each entry, when it renders, then it is used only to verify the entry belongs to the test being viewed; it is never displayed.
- [ ] Given `client_id` and `user_id` are workspace-internal identifiers, when the response is served to the browser, then they are not included.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the report is not available.
- [ ] Given the response is an empty array, when it renders, then the panel says the test used no sender accounts and flags this as a misconfiguration, because a test with no senders cannot have produced a result.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Fetch sender accounts for `test_101` | 200; two entries, `sender_001` `campaigns@example.com` and `sender_002` `support@example.com`, each with created and updated timestamps |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; no addresses rendered |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That deliverability report is not available" |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Poll the list every second | 429 on the excess; backoff with jitter; a single "Updating…" state |
| TC-6 | Empty result set | Fetch for a test created without senders | 200 with `[]`; "This test used no sender accounts" flagged as a configuration problem, not a neutral empty state |
| TC-7 | Unmatched address | An entry whose `from_email` matches no connected mailbox | Shown with "not connected in Harry" and a link to Mailboxes; the row is not hidden |
| TC-8 | Address disconnected after the test | A mailbox connected at test time, since removed | The address renders with a note that the mailbox is no longer connected and the test date, so the result is still interpretable |
| TC-9 | Internal ids not leaked | Inspect the API response served to the browser | `client_id` and `user_id` are absent; `spam_test_id` is not rendered |
| TC-10 | Upstream unavailable | Provider returns 503 | Last known list shown with its timestamp and a "not up to date" note; retried on the next tick |

## 4. Frontend user story

**As a** mailbox owner, **I want** the sending addresses named at the top of a placement report, **so that** I never mistake a result for a mailbox it does not cover.

**Scope**
- Monitoring → Deliverability report detail: a "Sent from" line under the report header listing each `from_email`, each linking to its mailbox on Mailboxes where connected.
- The sender account report (the per-sender breakdown) uses this list as its row set, so the two cannot disagree about which addresses were involved.
- Loading: skeleton chips. Empty: "This test used no sender accounts" styled as a problem. Error: last known list with a staleness note.
- Accessibility: addresses are a list, not a comma-joined string, so each is individually reachable; the "not connected" note is text on the item, not a tooltip. Responsive: the list wraps under 640px without truncating addresses.

**Definition of done**
- [ ] Every returned `from_email` is shown, matched or not.
- [ ] Matched addresses link to the mailbox; unmatched ones say why they do not.
- [ ] The empty case reads as a misconfiguration rather than as "nothing to see".
- [ ] Loading, empty, unmatched, disconnected and stale states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route listing a test's sender accounts mapped onto connected mailboxes, **so that** the report can link addresses to the mailboxes a user recognises.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/senders`, workspace-scoped, returning `senderId`, `fromEmail`, `mailboxId` (null when unmatched), `mailboxConnected` and the timestamps — never `client_id` or `user_id`.
- Data model: a `deliverability_test_senders` table in `server/db.js` (`test_id`, `provider_sender_id`, `from_email`, `mailbox_id`, `created_at`, `updated_at`, `fetched_at`), so a report stays interpretable after a mailbox is disconnected.
- Matching is by exact address against the workspace's mailboxes, done server-side once at fetch time and stored, so a later disconnection does not rewrite history.
- No pagination — a test has a handful of senders. Refresh throttled per test; upstream 429 and 503 back off with jitter and serve the cache.
- Logged: no `events` for a read; `telemetry` records how often a sender address matches no connected mailbox, since a high rate means users are testing addresses Harry does not send from.

**Definition of done**
- [ ] `client_id` and `user_id` never leave the server, asserted by a test on the response shape.
- [ ] Route is workspace-scoped and 404s on another workspace's test.
- [ ] A disconnected mailbox still renders its historical match.
- [ ] The sender-account report and this list are built from the same stored rows.

## 6. End-to-end test ticket

**Title:** E2E — Confirm which mailboxes a placement report covers

**Preconditions:** A workspace with two sandbox mailboxes (`campaigns@example.com` connected, `support@example.com` connected then disconnected mid-test), a completed test fixture returning both senders, and a second fixture returning an empty sender list.

**Flow**
1. Open Monitoring → Deliverability and choose the first fixture report.
2. Read the "Sent from" line.
3. Follow the link on the connected address.
4. Return and read the disconnected address.
5. Open the second fixture report.
6. Inspect the network response for the senders call.

**Assertions**
- [ ] Both addresses appear, one linking to its mailbox and one noting that the mailbox is no longer connected.
- [ ] The per-sender breakdown lists exactly the same two addresses.
- [ ] The second report states that the test used no sender accounts and presents it as a problem.
- [ ] The response contains no `client_id` or `user_id` and does not render `spam_test_id`.
- [ ] Reloading serves the cached list with its timestamp and makes no second upstream call.

**Teardown:** Delete both fixtures and their sender rows; reconnect the sandbox mailbox.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability report | A "Sent from" line under the header | Low | One line of linked addresses; it is context, not a panel |

**Verdict:** Fits an existing surface

Naming the addresses a report covers is a caption, not a feature — but without it a user can read a clean report and believe it applies to a mailbox that was never tested. One line under the header is the whole cost, and the same data quietly becomes the row set for the per-sender breakdown. No new navigation item.
