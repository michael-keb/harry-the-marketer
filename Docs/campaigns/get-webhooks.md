# Get Campaign Webhooks

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/campaigns/{id}/webhooks` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/get-webhooks |
| **Auth** | API key (query param `api_key`) |

Lists every outbound notification hook attached to a campaign, with its name, target URL, which events it fires on, and whether it is switched on.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** workspace owner, **I want** to see every place a campaign sends events to, **so that** I know exactly what leaves Harry and can switch off a hook I no longer trust.

**Acceptance criteria**
- [ ] Given a campaign with hooks configured, when I list them, then each entry returns `id`, `name`, `webhook_url`, `event_types` and `is_active`.
- [ ] Given a hook is inactive, when the list is shown, then `is_active: false` is displayed as an explicit "Off" state, not by omission.
- [ ] Given a campaign has no hooks, when I list them, then I get a 200 with `success: true` and an empty `data` array, and the UI shows an empty state rather than an error.
- [ ] Given `event_types` contains values such as `LEAD_REPLIED` and `LEAD_OPENED`, when they are shown, then they are rendered in plain English ("When a lead replies"), with the raw value available on hover.
- [ ] Given a hook URL contains a secret path segment, when the list is shown, then the URL is truncated in the middle by default with a reveal action, and it is never written to the activity trail in full.
- [ ] Given the campaign belongs to another workspace, when I list its hooks, then I get a not-found response.
- [ ] Given the list is long, when it is rendered, then it is ordered by name and paginated or scrolled without collapsing the page layout.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed one hook named "CRM Integration" on `LEAD_REPLIED` and `LEAD_OPENED`. List hooks | 200, `data` has one entry with matching `name`, `webhook_url`, `event_types`, `is_active: true` |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; the panel says the list could not be loaded, and shows nothing stale |
| TC-3 | Not found / wrong workspace | List hooks for a campaign in another workspace | 404 |
| TC-4 | Validation failure | Request with a non-numeric campaign id | 422 naming the id parameter |
| TC-5 | Rate limited | Request the list 40 times in 10 seconds | 429; the panel retries once after a delay |
| TC-6 | Empty result set | List hooks for a campaign that has none | 200, `data: []`, empty state reads "No integrations on this campaign" |
| TC-7 | Inactive hook | Seed a hook with `is_active: false` | Entry appears with a visible "Off" badge |
| TC-8 | Unknown event type | Seed a hook with an event value Harry does not map to plain English | The raw value is shown verbatim rather than hidden or crashing the row |
| TC-9 | URL redaction | Seed a hook whose URL contains a long token | The list truncates the middle; the activity trail records only the hook name and id |
| TC-10 | Many hooks | Seed 50 hooks | 200; the panel scrolls within a fixed height and the page does not jump |

## 4. Frontend user story

**As a** workspace owner, **I want** an integrations list on the campaign detail page, **so that** I can audit and disable outbound hooks without asking an engineer.

**Scope**
- Campaign detail page: an "Integrations" section, collapsed by default, listing each hook's name, redacted URL, translated event list and an on/off badge.
- Settings: the workspace-level Slack/Teams webhook stays where it is; this section covers per-campaign hooks only and links to Settings for the workspace one.
- Loading shows two skeleton rows. Empty shows "No integrations on this campaign" with a single "Add integration" action. Errors show a retry, never a silent blank.
- Accessibility: the section is a disclosure with a proper button and `aria-expanded`; each row is a list item with the on/off state in text. URLs use a `title` and a copy action rather than horizontal scroll on mobile.

**Definition of done**
- [ ] Every hook's active state is readable without hovering or expanding.
- [ ] Raw event codes are translated but recoverable.
- [ ] Full URLs are never rendered in the activity trail or logs.
- [ ] Empty, error and long-list states have component tests.

## 5. Backend user story

**As a** Harry server, **I want** a route that lists a campaign's outbound hooks, **so that** the UI can audit integrations without reading configuration tables directly.

**Scope**
- Add `GET /api/campaigns/:id/webhooks` to `server/routes.js`, workspace-scoped, returning `{ success, data: [...] }` to match the shape the UI already expects from list routes.
- Data model: a `campaign_webhooks` table (`id`, `campaign_id`, `name`, `url`, `event_types` JSON, `is_active`, timestamps) added to `server/db.js` alongside `campaigns` and `events`.
- No pagination needed at expected volumes, but cap the response and return a documented ceiling if a workspace exceeds it.
- Redact the URL for logging: write hook id and name to `events`, never the URL.
- Log a `telemetry` row for read latency.

**Definition of done**
- [ ] Route returns the documented field set including `is_active`.
- [ ] Empty campaigns return `data: []` with a 200.
- [ ] Cross-workspace reads return 404.
- [ ] Tests cover the empty case and the redaction rule.

## 6. End-to-end test ticket

**Title:** E2E — audit a campaign's outbound integrations

**Preconditions:** A workspace with one campaign and two seeded hooks, one active and one inactive, one of them with a token in its URL.

**Flow**
1. Sign in and open the campaign detail page.
2. Expand the Integrations section.
3. Read both rows.
4. Reveal the redacted URL on the token-bearing hook.
5. Open the activity trail on the Dashboard.

**Assertions**
- [ ] Both hooks are listed with names and translated event descriptions.
- [ ] The inactive hook shows an "Off" badge in text.
- [ ] The URL is truncated until revealed.
- [ ] The activity trail contains no full URL for either hook.
- [ ] Collapsing the section persists across a reload.

**Teardown:** Delete both hooks and the campaign; clear the events and telemetry created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | New collapsed "Integrations" section | Medium | Collapsed by default and shows a one-line summary when closed |
| Settings | A link out to per-campaign integrations | Low | One sentence next to the existing workspace webhook field |
| Dashboard activity trail | Hook events recorded by name only | Low | No new filter; reuses existing event rendering |

**Verdict:** Fits an existing surface

Campaign detail is already where a campaign's configuration lives, and integrations are configuration. Keeping the section collapsed means the majority of users, who have no per-campaign hooks, see one extra line and nothing more.
