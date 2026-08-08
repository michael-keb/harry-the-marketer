# Send Test Email

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/send-test-email` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/send-test-email |
| **Auth** | API key (query param `api_key`) |

Sends one step of a campaign to yourself, filled in with a real lead's details, so you can read what a prospect would actually receive before anyone does.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner about to launch, **I want** to send one step of the playbook to my own inbox using a real lead's data, **so that** I see the personalization, the footer and the formatting exactly as a prospect would, before it is too late.

**Acceptance criteria**
- [ ] Given a campaign with a valid playbook, when I send a test with `leadId` and the step to test, then the email is composed with that lead's real data and delivered to the address I chose.
- [ ] Given I supply `customEmailAddress`, when the test is sent, then it goes to that address and never to the lead, and the lead's thread and stage are unchanged.
- [ ] Given I omit `customEmailAddress`, when I attempt the test, then the UI requires an explicit recipient rather than defaulting to the lead's address, because Harry's rule is that nothing reaches a prospect without an OK.
- [ ] Given I supply `selectedEmailAccountId`, when the test is sent, then it goes from that mailbox; given I omit it, then a mailbox from the campaign's pool is used and named in the result.
- [ ] Given the step number does not exist in the playbook, when I send a test, then I get a validation error listing the available steps.
- [ ] Given a test is sent, when I look at the campaign's numbers, then the test is excluded from sent counts, open rate and reply rate.
- [ ] Given the test email is delivered, when I read it, then it carries the same signature, opt-out line and tracking treatment as a real send, clearly marked as a test in the subject prefix only.
- [ ] Given the workspace has no mailbox attached to the campaign, when I send a test, then I get a clear error telling me to attach one.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{ leadId: 789, sequenceNumber: 1, customEmailAddress: "test@mycompany.com" }` | 200 `{ success: true, message: "Test email sent successfully" }`; the test address receives one email with the lead's merge data resolved |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; nothing sent |
| TC-3 | Not found / wrong workspace | Use a `leadId` from another workspace | 404; nothing sent |
| TC-4 | Validation failure | POST `{ leadId: 789, sequenceNumber: 99 }` | 422 naming `sequenceNumber` and listing the valid steps |
| TC-5 | Rate limited | Send 20 tests in a minute | 429 after the limit; the UI states the limit and when it resets |
| TC-6 | Empty result set | Send a test on a campaign with no leads attached | 422 stating a lead is needed for personalization, with a link to attach leads |
| TC-7 | Lead untouched | Send a test using lead 789, then open that lead | The lead's stage, thread and node position are unchanged |
| TC-8 | Excluded from stats | Note the campaign's sent count, send three tests, re-read it | The count is unchanged |
| TC-9 | Specific mailbox | Send with `selectedEmailAccountId` set | The email arrives from that mailbox and the result names it |
| TC-10 | No mailbox attached | Detach all mailboxes, send a test | Clear error telling the user to attach a mailbox |
| TC-11 | Quota interaction | Send tests near a mailbox's daily limit | Tests count against the mailbox quota and say so, so testing cannot silently exhaust a day's sending |
| TC-12 | Unresolved merge field | Use a lead missing a first name | The test shows the fallback the real send would use, not an empty gap or a raw placeholder |

## 4. Frontend user story

**As a** campaign owner, **I want** a "Send me a test" control in the playbook editor, **so that** I can check a `Send:` node reads well before I launch.

**Scope**
- Campaign detail, playbook editor: a "Send me a test" action beside the existing "Generate with AI" and validate controls, opening a small panel that asks which `Send:` node, which lead to personalize from, which mailbox, and which address to send to — pre-filled with the signed-in user's own email.
- Node performance view inside the campaign: the same action available per node, so testing a specific step is one click from where the node is being read.
- Loading disables the send action and shows progress; success confirms the address and mailbox used; failure states the reason inline and keeps the panel open.
- Empty case: with no leads attached, the panel explains that personalization needs a lead and links to attach leads.
- Accessibility: the panel is a labelled form; the node picker lists nodes by their `Send:` instruction text, not by internal ids; results are announced in a live region. On mobile the panel is a full-height sheet.

**Definition of done**
- [ ] The recipient is always explicit and defaults to the signed-in user.
- [ ] Nodes are chosen by their human-readable instruction.
- [ ] Success names both the recipient and the sending mailbox.
- [ ] Tests are visibly excluded from campaign statistics.

## 5. Backend user story

**As a** Harry server, **I want** to compose and deliver a single playbook step as a test without touching campaign state, **so that** users can preview real output safely.

**Scope**
- Add `POST /api/campaigns/:id/test-send` to `server/routes.js` accepting `{ node_id, lead_id, mailbox_id, to_email }`, workspace-scoped.
- Compose through `server/ai.js` with the same briefing, lead data and research profile a real send would use, then deliver through `server/mailer.js` so the footer, opt-out line and headers are identical.
- Data model: none new. Write the test to `messages` flagged as a test, or not at all — either way it must be excluded from every count in Reports and from stage derivation.
- Guard the recipient: reject any address that belongs to a lead in the workspace unless the user explicitly confirms, so a test cannot become an unapproved prospect contact.
- Count the test against the mailbox's daily quota and rate-limit test sends per user per hour.
- Write an `events` row naming the actor, node and recipient, and a `telemetry` row for compose and send latency.

**Definition of done**
- [ ] Test sends never alter a lead's stage, thread or node position.
- [ ] Test sends are excluded from Reports, proven by a test.
- [ ] Sending to a real lead's address requires explicit confirmation.
- [ ] The composed body is identical to what a real send would produce for that lead and node.

## 6. End-to-end test ticket

**Title:** E2E — preview a playbook step before launch

**Preconditions:** A workspace with a sandbox mailbox, one draft campaign with a valid multi-node playbook, three attached leads including one missing a first name, and the signed-in user's address available for delivery.

**Flow**
1. Sign in and open the campaign's playbook editor.
2. Open "Send me a test", pick the first `Send:` node and a lead, and send to the pre-filled own address.
3. Read the delivered email in the sandbox mailbox view.
4. Repeat with the lead missing a first name.
5. Attempt a test with a lead's own address as the recipient.
6. Open Reports.

**Assertions**
- [ ] The delivered test resolves the lead's real details and includes the opt-out line and signature.
- [ ] The chosen lead's stage and thread are unchanged after step 2.
- [ ] Step 4 shows the fallback wording rather than an empty gap or a raw placeholder.
- [ ] Step 5 requires explicit confirmation before proceeding.
- [ ] Reports shows no additional sent messages for the campaign.

**Teardown:** Delete the campaign and leads; remove the test messages and the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign playbook editor | New "Send me a test" action and panel | Medium | Sits with the existing generate and validate actions; the panel opens pre-filled so the common case is one click |
| Node performance view | Same action per node | Low | Reuses the panel; no new UI of its own |
| Reports | Tests excluded from every figure | Low | Invisible by design; no toggle to explain |

**Verdict:** Fits an existing surface

The playbook editor is already where a user checks their work before launching, and this is the last check they cannot currently do. Pre-filling the recipient with their own address is what keeps it a one-click action rather than a form, and it also protects the standing rule that a prospect never receives anything unapproved.
