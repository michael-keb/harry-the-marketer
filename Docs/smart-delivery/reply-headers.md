# Email Reply Headers

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/sender-account-wise/{replyId}/email-headers` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/reply-headers |
| **Auth** | API key (query param `api_key`) |

Returns the raw technical headers of one test email as the receiving server saw it, which is the last word when two other checks disagree.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** mailbox owner arguing with a hosting provider, **I want** the raw headers of a specific test email, **so that** I can paste the evidence rather than describe it.

**Acceptance criteria**
- [ ] Given a `spamTestId` and a `replyId`, when I fetch the headers, then I get an object of header names and values including `Return-Path`, `Received`, `Authentication-Results` and the SPF header.
- [ ] Given the payload is a flat object of arbitrary header names, when it renders, then every key present is shown — nothing is filtered to a hardcoded list, because the useful header is often the unexpected one.
- [ ] Given `Authentication-Results` contains `dkim=pass`, `spf=pass` and `dmarc=pass`, when it renders, then those three verdicts are pulled out and shown in plain words above the raw text, with the raw text still available.
- [ ] Given the documented payload contains the misspelled key `Reveived-Spf`, when it renders, then it is displayed exactly as returned and no code depends on the spelling of any key.
- [ ] Given a copy action, when I use it, then the full header block is copied as plain text in one action, since that is the whole point of the view.
- [ ] Given the `replyId` or test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the headers are not available.
- [ ] Given headers contain email addresses and IPs, when they are shown, then they are never placed in a URL, a query string or an analytics event.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Fetch headers for a known `spamTestId` and `replyId` | 200; object containing `Return-Path`, `Received`, `Reveived-Spf` and `Authentication-Results` exactly as returned |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; no headers shown |
| TC-3 | Reply not found / wrong workspace | Fetch with a `replyId` from another workspace's test | 404 `{"error": "Resource not found"}`; "Those headers are not available" |
| TC-4 | Validation failure | Fetch with a malformed `replyId` | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Open headers for twenty replies rapidly | 429 on the excess; backoff with jitter; the panel shows one "Loading…" state per reply, not a stack of errors |
| TC-6 | Empty result set | Fetch headers for a reply that was never delivered | 200 with `{}`; panel reads "No headers captured for this reply"; the copy action is disabled |
| TC-7 | Unexpected header key | A payload containing a header not in the documented example | It renders alongside the others; nothing is dropped and nothing throws |
| TC-8 | Misspelled key | The documented `Reveived-Spf` key | Shown verbatim; the parsed verdicts read from `Authentication-Results`, not from this key |
| TC-9 | Very long header | A `Received` chain thousands of characters long | The block scrolls inside its own container; the page never scrolls horizontally; copy still returns the full value |
| TC-10 | Privacy | Open the headers view and inspect the URL and any telemetry | The `replyId` may appear in the path; no email address, IP or header value appears in any URL or telemetry event |

## 4. Frontend user story

**As a** mailbox owner, **I want** a headers view behind one click from a specific test reply, **so that** the raw detail is available without cluttering the report.

**Scope**
- Monitoring → Deliverability report detail → sender account report: each reply row has a "View headers" action opening a panel with a plain-words verdict line ("DKIM pass, SPF pass, DMARC pass") above the full header block.
- One "Copy all" action copies the raw block as text.
- Loading: skeleton block. Empty: "No headers captured for this reply" with copy disabled. Error: message with a retry, and the panel stays open so the user does not lose their place.
- The raw block is monospaced, selectable, and wrapped in its own scroll container, so nothing forces the page wide.
- Accessibility: the panel is a labelled dialog with focus trap and Escape to close; the copy action announces success in a live region; the verdict line is text before the raw block so a screen-reader user gets the conclusion first. Responsive: full-screen panel under 640px.

**Definition of done**
- [ ] Every returned header key is rendered, in the order returned.
- [ ] The verdict line is parsed from `Authentication-Results` and degrades silently when that header is missing.
- [ ] Copy returns the full raw block including long `Received` chains.
- [ ] Loading, empty, error and very-long-value states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route serving one reply's headers on demand, **so that** raw diagnostic data is fetched only when someone asks for it.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/replies/:replyId/headers`, workspace-scoped, returning the header object unchanged plus a small parsed summary of the DKIM, SPF and DMARC verdicts.
- Data model: none. Headers are fetched on demand and not stored, because they contain routing detail with no ongoing value and storing them would mean retaining more personal data than the feature needs.
- Parsing is defensive: the summary is built from `Authentication-Results` with a regular expression, and any parse failure returns a null summary rather than an error — the raw block is always the source of truth.
- Rate limiting: per-user limit on header fetches, since each is an upstream call; upstream 429 and 503 back off with jitter and surface a retry rather than an error page.
- Logged: no `events` row and no header values in telemetry — only the fact of a fetch, its latency and its status code.

**Definition of done**
- [ ] Route is workspace-scoped and 404s on another workspace's reply, covered by a test.
- [ ] No header value is written to any log, telemetry event or database row, asserted by a test.
- [ ] A malformed `Authentication-Results` yields a null summary and a still-rendered raw block.
- [ ] Fetches are not cached beyond the request.

## 6. End-to-end test ticket

**Title:** E2E — Pull the raw headers behind a placement result

**Preconditions:** A workspace with a completed placement test fixture, one reply whose headers match the documented example, and one reply with no captured headers.

**Flow**
1. Open Monitoring → Deliverability, choose the fixture report, and open the sender account report.
2. Choose "View headers" on the first reply.
3. Read the verdict line, then the raw block.
4. Use "Copy all" and paste into a text field.
5. Close, then open headers on the second reply.

**Assertions**
- [ ] The verdict line reads "DKIM pass, SPF pass, DMARC pass" parsed from `Authentication-Results`.
- [ ] The raw block contains every documented key including the misspelled `Reveived-Spf`, shown verbatim.
- [ ] The pasted text matches the raw block exactly, including the full `Received` line.
- [ ] The second reply shows "No headers captured for this reply" with copy disabled.
- [ ] No email address or IP from the headers appears in the URL or in any telemetry event recorded during the flow.

**Teardown:** Delete the fixture test and its replies; nothing else is stored.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → sender account report | "View headers" action per reply plus a panel | Low | One action per row, opening on demand; nothing raw appears until asked for |

**Verdict:** Fits an existing surface

This is the deepest technical detail in the whole category and it belongs behind a click for exactly that reason — the verdict line means most users never need to read the block, and the people who do need it need it verbatim. It costs one action on a table that already lists replies. No new navigation item.
