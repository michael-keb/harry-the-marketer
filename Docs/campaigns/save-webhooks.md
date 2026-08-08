# Create/Update Campaign Webhook

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{id}/webhooks` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/save-webhooks |
| **Auth** | API key (query param `api_key`) |

Adds a new outbound notification hook to a campaign, or edits an existing one, by naming it, giving it a URL, and choosing which events should fire it.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** workspace owner, **I want** to point a campaign's events at my CRM or a Slack channel, **so that** the rest of my team hears about a reply without living inside Harry.

**Acceptance criteria**
- [ ] Given I post a hook with `id: null`, a `name`, a `webhook_url` and `event_types`, then a new hook is created and the response returns it with a server-assigned `id`.
- [ ] Given I post the same body with an existing `id`, then that hook is updated in place and no duplicate is created.
- [ ] Given `event_types` may include `LEAD_REPLIED`, `LEAD_OPENED`, `LEAD_CLICKED`, `LEAD_BOUNCED` and `LEAD_UNSUBSCRIBED`, when I choose them, then they are offered in plain English and stored as those exact values.
- [ ] Given `name`, `webhook_url` or `event_types` is missing or empty, when I save, then I get a field-level validation error and nothing is stored.
- [ ] Given the URL is not HTTPS, or resolves to a private or loopback address, when I save, then it is rejected with a stated reason.
- [ ] Given a hook is saved, when I choose to test it, then a sample payload is delivered and the result is shown before I rely on it.
- [ ] Given a hook fires, when delivery fails, then the failure is recorded and never blocks or delays an email send.
- [ ] Given the campaign belongs to another workspace, when I save a hook on it, then I get a not-found response.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path, create | POST `{ id: null, name: "CRM Integration", webhook_url: "https://crm.example.com/webhook", event_types: ["LEAD_REPLIED","LEAD_OPENED"] }` | 200 with `data.id` assigned and the fields echoed back |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401; nothing stored |
| TC-3 | Not found / wrong workspace | Save a hook on another workspace's campaign | 404 |
| TC-4 | Validation failure | POST with `event_types: []` | 422 naming `event_types` |
| TC-5 | Rate limited | Save the same hook repeatedly | 429; the form retries once and no duplicate hook is created |
| TC-6 | Empty result set | List hooks on a campaign before creating any | 200 with an empty list and an empty state |
| TC-7 | Update in place | Create a hook, then POST the same body with its `id` and a new name | The hook's name changes; the hook count stays at one |
| TC-8 | Unsafe URL | POST a `webhook_url` of `http://localhost:9000/hook` | Rejected with a message about HTTPS and private addresses |
| TC-9 | Test delivery | Save a hook, then use "Send test" | The stub receives one sample payload; the result is shown in the UI |
| TC-10 | Delivery failure does not block sends | Point the hook at a failing stub, run the engine | Emails still send; the failure is recorded on Monitoring |
| TC-11 | Unknown event type | POST `event_types: ["LEAD_TELEPORTED"]` | Rejected with the list of accepted values |
| TC-12 | Secret in URL | Save a hook whose URL contains a token | The URL is stored encrypted at rest and never written to the activity trail in full |

## 4. Frontend user story

**As a** workspace owner, **I want** a small form to add or edit a campaign integration, **so that** wiring up a CRM takes a URL and two checkboxes rather than a support ticket.

**Scope**
- Campaign detail, Integrations section: an "Add integration" action opening a form with name, URL, and a checkbox list of events described in plain English ("When a lead replies", "When a lead unsubscribes"). Editing reuses the same form pre-filled.
- A "Send test" button inside the form, enabled once the URL is valid, showing the delivery result inline.
- Settings: the existing Slack/Teams field stays; a sentence explains the difference between the workspace alert and a per-campaign integration.
- Loading disables save; validation errors appear against the offending field, not as a banner. Errors preserve everything typed.
- Accessibility: checkboxes are in a labelled fieldset with a legend; the URL field states its requirements before the user fails; test results are announced in a live region. The form is single-column on all widths.

**Definition of done**
- [ ] Creating and editing use one form with one save action.
- [ ] Event names are shown in English with the raw code available.
- [ ] "Send test" works before the hook is relied on.
- [ ] URL validation happens before the request and again on the server.

## 5. Backend user story

**As a** Harry server, **I want** to create or update a campaign hook in one route, **so that** the UI does not need to know whether it is inserting or editing.

**Scope**
- Add `POST /api/campaigns/:id/webhooks` to `server/routes.js` accepting `{ id, name, url, event_types }`, upserting on `id`, workspace-scoped.
- Data model: the `campaign_webhooks` table in `server/db.js` (`id`, `campaign_id`, `name`, `url`, `event_types` JSON, `is_active`, timestamps); store the URL encrypted at rest.
- Validate the URL scheme and reject private, loopback and link-local targets to prevent server-side request forgery; validate every event type against an allow-list.
- Delivery is asynchronous with bounded retries, exactly like the existing Slack/Teams sender: failures are telemetry, never a blocked send.
- Write an `events` row naming the actor and hook name only, and a `telemetry` row per delivery attempt with outcome and latency.

**Definition of done**
- [ ] Upsert semantics tested for both create and update.
- [ ] SSRF guard tested against loopback, private ranges and redirects.
- [ ] A failing hook cannot delay or block an email send, proven by an engine test.
- [ ] Hook URLs never appear in `events` or in logs.

## 6. End-to-end test ticket

**Title:** E2E — wire a campaign to an external system

**Preconditions:** A workspace with one campaign, a local stub receiver, and a sandbox mailbox with at least one lead ready to reply.

**Flow**
1. Sign in, open the campaign detail page, expand Integrations.
2. Add an integration named "CRM Integration" pointing at the stub, selecting reply and unsubscribe events.
3. Use "Send test" and read the result.
4. Simulate a reply from the lead and run the engine.
5. Edit the integration to remove the unsubscribe event and save.
6. Point the stub at a failing URL, simulate another reply, and run the engine.

**Assertions**
- [ ] The test delivery reaches the stub and the result is shown inline.
- [ ] The reply in step 4 produces exactly one delivery with the lead and campaign identified.
- [ ] After step 5 the integration list shows one hook, not two, with one event.
- [ ] In step 6 the email still sends and the failure appears on Monitoring.
- [ ] The activity trail names the hook but contains no URL.

**Teardown:** Delete the integration and the campaign; prune the telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | Add/edit form inside the collapsed Integrations section | Medium | One form for create and edit; hidden until the section is expanded |
| Settings | One explanatory sentence beside the workspace webhook | Low | Text only, no new field |
| Monitoring | Failures land on the existing Notifications card | Low | No new panel |

**Verdict:** Fits an existing surface

Integrations already have a home on the campaign detail page, and this is the form that fills it. The design cost is kept down by making create and edit the same form and by hiding the whole thing behind a collapsed section that most users will never open.
