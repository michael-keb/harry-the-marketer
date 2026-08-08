# Test Email Content

| | |
|---|---|
| **Endpoint** | `GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report/{spamTestId}/email-content` |
| **Category** | smart-delivery |
| **Source** | https://api.smartlead.ai/api-reference/smart-delivery/test-email-content |
| **Auth** | API key (query param `api_key`) |

Returns the exact email a deliverability test sent — subject, plain text, HTML, and the raw message.

## 1. Epic

**Inbox placement and deliverability assurance**

Harry checks whether the emails it is about to send actually arrive in the inbox — seeding test messages to real mailboxes across providers, reading back where each one landed, and grading the sending domain's authentication and reputation. It matters because a playbook that routes perfectly is worthless if every email lands in spam, and a marketer running one Gmail mailbox has no other way to see that happening.

## 2. User story

**As a** marketer whose test scored badly, **I want** to read the exact email that was sent, **so that** I can judge the wording against the spam filter reasons instead of guessing what went out.

**Acceptance criteria**
- [ ] Given a test id, when I fetch its email content, then I get `spamTest`, `subject`, `text`, `html` and `rawEmailContent`.
- [ ] Given `subject` and `text`, when they render, then they are shown as the default view, because the plain-text version is what most spam analysis actually reads.
- [ ] Given `html`, when it renders, then it is displayed as escaped source or inside a sandboxed frame with scripts and remote loads blocked — never injected into the page.
- [ ] Given `rawEmailContent`, when it renders, then it is behind a disclosure with a copy action, in its own scroll container.
- [ ] Given the spam filter report flagged a content reason, when I open the content view from it, then the same test's email is shown, so the reason and the wording sit side by side.
- [ ] Given links in the body, when the content renders, then they are shown as text and are not clickable, because a tested email's links may point anywhere.
- [ ] Given the test id is unknown or another workspace's, when I fetch it, then the API returns 404 `{"error": "Resource not found"}` and the panel says the content is not available.
- [ ] Given `html` is empty but `text` is present, when it renders, then the text view is shown and the HTML tab is absent rather than empty.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Fetch email content for a completed test | 200; `spamTest`, `subject: "Special Q1 Offer - Limited Time"`, `text`, `html` and `rawEmailContent` all present |
| TC-2 | Missing/invalid API key | Repeat TC-1 with no `api_key` (in Harry: no session cookie) | 401 `{"message": "Invalid API Key"}`; "Your session expired — sign in again"; no content shown |
| TC-3 | Test not found / wrong workspace | Fetch another workspace's `spamTestId` | 404 `{"error": "Resource not found"}`; "That email content is not available"; no subject leaked |
| TC-4 | Validation failure | Fetch with a malformed `spamTestId` | 422 `{"error": "Invalid parameters provided"}`; message shown; no retry loop |
| TC-5 | Rate limited | Open the content view repeatedly | 429 on the excess; backoff with jitter; a single "Loading…" state |
| TC-6 | Empty result set | Fetch content for a test that never sent | 200 with empty fields; "No email content captured for this test"; copy disabled |
| TC-7 | HTML is not executed | Content whose `html` contains a `<script>` tag and a remote image | Nothing executes and no remote request is made; the markup is visible as source or rendered inertly in a sandboxed frame |
| TC-8 | Links inert | The documented body containing `https://example.com/offer` | The URL is visible as text and is not a working link; copy still includes it |
| TC-9 | HTML missing | A response with `text` set and `html` empty | The text view renders; no empty HTML tab is offered |
| TC-10 | Very long raw message | A `rawEmailContent` of tens of thousands of characters | The disclosure scrolls in its own container; the page never scrolls horizontally; copy returns the full value |

## 4. Frontend user story

**As a** marketer, **I want** the tested email readable next to its spam filter reasons, **so that** the fix is obvious without opening the campaign editor first.

**Scope**
- Monitoring → Deliverability test detail: a "Tested email" section showing the subject and a text/HTML/raw switch, defaulting to text.
- The spam filter section links directly here, and this section links onward to the campaign's `Send:` node so the edit happens in the playbook rather than in a copy of the email.
- HTML is rendered inside a sandboxed frame with scripts, forms and remote loads blocked, or as escaped source — the choice is made once and applied consistently.
- Loading: skeleton block. Empty: "No email content captured for this test" with copy disabled. Error: message with a retry, the section staying open.
- Accessibility: the switch is a real tab list with keyboard support; the subject is a heading; the raw disclosure has an accessible name; copy announces success in a live region. Responsive: full width under 640px with the raw block in its own scroll container.

**Definition of done**
- [ ] Text is the default view and HTML is never injected into the page's own document.
- [ ] Links in the body are inert everywhere they appear.
- [ ] The section links both from the spam filter reasons and onward to the `Send:` node.
- [ ] Loading, empty, HTML-missing, long-raw and error states are designed and checked in light and dark.

## 5. Backend user story

**As a** Harry API, **I want** a route serving a test's email content with a strict rendering contract, **so that** untrusted markup never reaches the app's own document.

**Scope**
- Route in `server/routes.js`: `GET /api/deliverability/tests/:testId/content`, workspace-scoped, returning `subject`, `text`, `html` and `raw` unchanged, plus a flag stating that `html` is untrusted.
- Data model: none. Content is fetched on demand and not stored, because it duplicates what the campaign playbook already holds and storing it would keep a second copy of message bodies.
- The response is served with headers that keep it out of the app's own CSP scope, and the client is required to render `html` only inside a sandboxed frame — the contract is documented on the route and covered by a test.
- Rate limiting: per-user limit on content fetches, since each is an upstream call; upstream 429 and 503 back off with jitter and surface a retry.
- Logged: no `events` row and no message body in telemetry — only the fact of a fetch, its latency and its status code.

**Definition of done**
- [ ] No message body is written to any log, telemetry event or database row, asserted by a test.
- [ ] A response containing a `<script>` tag cannot execute in the app, asserted by a test.
- [ ] Route is workspace-scoped and 404s on another workspace's test without leaking the subject.
- [ ] Content is not cached beyond the request.

## 6. End-to-end test ticket

**Title:** E2E — Read the tested email beside the reason it was filtered

**Preconditions:** A workspace with one campaign whose first `Send:` node produced the tested email, a completed test fixture returning the documented content including a `<script>` tag and a remote image in `html`, and a spam filter fixture with a content-related reason.

**Flow**
1. Open Monitoring → Deliverability and choose the fixture report.
2. Open the "Spam filters" section and follow the content reason.
3. Read the subject and text.
4. Switch to HTML, then open the raw disclosure and copy it.
5. Follow the link to the campaign's `Send:` node.

**Assertions**
- [ ] The content section opens on the text view with the documented subject as its heading.
- [ ] The HTML view executes no script and issues no remote image request, verified in the network log.
- [ ] The URL in the body is visible as text and is not clickable.
- [ ] The copied raw content matches `rawEmailContent` exactly.
- [ ] The link opens the campaign editor with the `Send:` node in view.
- [ ] No message body appears in any telemetry event recorded during the flow.

**Teardown:** Delete the fixture test; no content is stored.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Monitoring → Deliverability test detail | "Tested email" section with a text/HTML/raw switch | Medium | Defaults to text and is collapsed unless arrived at from a spam filter reason; the raw view is behind a disclosure |
| Campaigns → campaign editor | Reached by a link from here | Low | No new control; the existing `Send:` node is the destination |

**Verdict:** Fits an existing surface

Content only matters next to the reason a filter objected, which is why this section is one link away from the spam filter reasons and collapsed the rest of the time. The real work here is not layout but the rendering contract: an email body is untrusted input, and the report must never become a way to run it. No new navigation item.
