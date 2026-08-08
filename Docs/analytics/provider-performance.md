# Provider-wise Performance

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/mailbox/provider-wise-overall-performance` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/provider-performance |
| **Auth** | API key (query param `api_key`) |

Compares how mail performs depending on which email service it was sent through — Gmail, Outlook, plain SMTP — overall and broken down by tag.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer, **I want** sending results compared by email provider, **so that** I can tell whether a poor week is my writing or the pipe I am sending down.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the comparison, then `data.email_providers_performance_overview.overall` returns `{ provider, sent, opened, replied }` per provider.
- [ ] Given the same response carries `tag_wise`, when it is rendered, then each `{ tag, provider, sent, opened }` row is grouped under its provider, and Harry maps `tag` onto its own campaign labels rather than inventing a new tagging system.
- [ ] Given Harry sends through Gmail and sandbox only today, when the comparison renders, then it shows those two, sandbox is clearly marked as a test provider, and its numbers are excluded from any judgement.
- [ ] Given only one real provider is connected, when the comparison renders, then the panel is hidden, because a comparison of one is noise.
- [ ] Given a provider sent nothing in the range, when the comparison renders, then it is omitted rather than shown with zeros.
- [ ] Given the response carries counts but no rates, when the panel renders, then open and reply shares are computed from `sent` and labelled as per-email shares, not as the unique-lead rates used elsewhere.
- [ ] Given the API key is invalid, when the comparison is requested, then a 401 `{"message": "Invalid API Key"}` is surfaced as one banner without hiding the mailbox list.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed Gmail sending 500, opened 250, replied 30 in January. Request that range | 200 with one `overall` entry for Gmail carrying those figures |
| TC-2 | Missing/invalid API key | Repeat TC-1 with a junk key | 401 `{"message": "Invalid API Key"}`; the panel shows a reconnect banner |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}` or an empty overview; nothing leaks |
| TC-4 | Validation failure | Pass `end_date` before `start_date` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the previous comparison marked stale |
| TC-6 | Empty result set | Request a range with no sends | 200 with empty `overall` and `tag_wise`; the panel is hidden |
| TC-7 | Single provider | Seed a workspace with Gmail only | The panel is hidden, since there is nothing to compare |
| TC-8 | Sandbox excluded | Seed Gmail and sandbox sending in the same range | Both appear, sandbox is labelled a test provider and carries no benchmark grading |
| TC-9 | Tag grouping | Seed a `cold-outreach` tag with 200 sent, 100 opened on Gmail | The `tag_wise` row groups under Gmail and its sends do not double-count against `overall` |
| TC-10 | Share computation | Compute the open share from 250 of 500 | Shows 50.0% labelled as per email sent, distinct from the unique-lead open rate elsewhere |
| TC-11 | Unknown provider | Force a provider value Harry does not recognise | It renders with its literal name and a telemetry note; nothing crashes |

## 4. Frontend user story

**As a** marketer, **I want** a provider comparison on the Mailboxes page, **so that** a decision to move mailboxes to another provider is based on my own numbers.

**Scope**
- Mailboxes page: a compact comparison table below the mailbox list, one row per provider with sent, opened, replied and the per-email shares for the shared date range; rendered only when more than one real provider has sent.
- An optional grouping by campaign label maps SmartLead's `tag_wise` onto Harry's campaigns, shown as an expandable sub-list under each provider.
- Sandbox rows are labelled and visually separated. Loading shows skeleton rows. Empty hides the panel. Error hides the panel and leaves the mailbox list intact.
- Accessibility: a real table with a caption naming the range, shares in text next to their counts, and its own horizontal scroll container on narrow screens.

**Definition of done**
- [ ] The panel is absent when only one real provider has sent.
- [ ] Sandbox numbers are never included in any comparison verdict.
- [ ] Shares are labelled as per-email, distinct from the unique-lead rates on Reports.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** sending counts grouped by provider and campaign label, **so that** the provider question is answered from Harry's own mailer dispatch data.

**Scope**
- Add `GET /api/analytics/mailboxes/providers?from=&to=&timezone=&campaign_ids=` to `server/routes.js`, workspace-scoped, returning `{ overall: [...], by_campaign: [...] }`.
- Data model: none. Group on the provider already recorded by `server/mailer.js` dispatch (`gmail` or `sandbox`) so a future provider appears automatically when the dispatch table grows.
- Return raw counts plus precomputed per-email shares with `null` when `sent` is zero. Validate the date pair and cap the window.
- The existing API limiter applies with brief caching per workspace and range.
- Log a `telemetry` row when an unrecognised provider value appears, so drift between the mailer and the reporting layer is visible.

**Definition of done**
- [ ] Provider values come from the mailer's dispatch constants, not a duplicated list.
- [ ] Sandbox is flagged in the payload so the UI can exclude it from verdicts.
- [ ] Providers with no sends in the range are omitted.
- [ ] Cross-workspace mailboxes contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — provider comparison on Mailboxes

**Preconditions:** A workspace with one simulated Gmail mailbox and one sandbox mailbox, both sending inside the test week across two campaigns, with opens and replies seeded on the Gmail side only.

**Flow**
1. Sign in and open Mailboxes on a workspace with Gmail only; confirm the panel is hidden.
2. Add the sandbox mailbox and seed its sends.
3. Reload and read the comparison table.
4. Expand the Gmail row's campaign breakdown.
5. Set the range to a week with no sends.

**Assertions**
- [ ] The panel appears only once a second provider has sent.
- [ ] Sandbox is labelled a test provider and carries no benchmark verdict.
- [ ] The campaign breakdown's sends sum to the provider's total.
- [ ] Shares are labelled per email sent.
- [ ] The empty range hides the panel rather than showing zeros.

**Teardown:** Delete the seeded mailboxes, campaigns, leads and messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Mailboxes | Adds a comparison table below the list, only when more than one provider has sent | Medium | Hidden for the common Gmail-only workspace |
| Monitoring | None | Low | Delivery telemetry stays per mailbox, which is the actionable level |
| Reports | None | Low | Provider choice is a mailbox decision, not a campaign one |

**Verdict:** Fits an existing surface

Harry sends through Gmail and sandbox only, so today this comparison would show one real provider and a test one — which is why the panel hides itself until a second real provider exists. It is worth building now because `server/mailer.js` already dispatches by provider, so the grouping is free, but it should stay invisible until it can actually answer a question.
