# Get Webhook

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/webhook/{webhook_id}` |
| **Category** | webhooks |
| **Source** | https://api.smartlead.ai/api-reference/webhooks/get |
| **Auth** | API key (query param `api_key`) |

Returns one registered endpoint's settings — its name, URL, which campaign it covers, which events it listens for, and when it was last changed.

## 1. Epic

**Outbound event notifications**

The epic lets a Harry workspace push what it already knows — an email sent, opened, clicked, replied to, bounced, a lead unsubscribed, a campaign's status changed — to any URL the user names, so a CRM, a spreadsheet or a team's own tooling learns about it without anyone copying anything across. It matters because Harry today can only tell one Slack or Teams webhook about four kinds of thing, in a message shaped for humans; everything else it knows stops at the edge of the app.

**Where Harry stands:** Settings holds one incoming-webhook URL for Slack or Teams alerts, and the engine, AI layer and mailer already write a `telemetry` row and an `events` row for the moments that matter. Outbound, per-event, machine-readable webhooks are new build on top of existing signals — not new signals.

## 2. User story

**As a** marketer whose integration has gone quiet, **I want** to open an endpoint and see exactly what it is set to receive, **so that** I can tell a wrong URL from an unticked event without asking anyone.

**Acceptance criteria**
- [ ] Given a webhook id the caller owns, when it is fetched, then a 200 returns `data` with `id`, `email_campaign_id`, `name`, `webhook_url`, `event_type_map`, `category_id_map`, `created_at` and `updated_at`.
- [ ] Given `event_type_map` is `{"EMAIL_SENT": true, "EMAIL_OPEN": true, "EMAIL_LINK_CLICK": true, "EMAIL_REPLY": true}`, when the detail view renders, then those four are shown as ticked in Harry's own words and every other event is shown as unticked, not omitted.
- [ ] Given `category_id_map` is empty, when the detail view renders, then it reads "All reply intents" rather than showing an empty object.
- [ ] Given the webhook id does not exist or belongs to another workspace, when it is fetched, then a 404 `{"error": "Resource not found"}` is returned and the UI says "This endpoint no longer exists" with a link back to the list.
- [ ] Given the endpoint has a secret, when it is fetched, then the secret is never in the response — only a "Reveal signing secret" action that re-authenticates returns it.
- [ ] Given the endpoint has recent deliveries, when the detail view renders, then the last ten attempts are shown with their status code, latency and time, so a failing receiver is visible without leaving Harry.
- [ ] Given the endpoint has been auto-paused after repeated failures, when it is fetched, then its status says paused, gives the reason, and offers a single Resume action.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Create an endpoint, then `GET /webhook/{id}` | 200, `data` carries `id`, `name`, `webhook_url`, `event_type_map` with the four ticked events, `category_id_map`, `created_at`, `updated_at` |
| TC-2 | Missing/invalid API key | Call with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the detail view shows "Your session has expired" |
| TC-3 | Not found / wrong workspace | Call with an id from another workspace, then a non-existent id | 404 `{"error": "Resource not found"}` both times; identical message, no URL leaked |
| TC-4 | Validation failure | Call with a non-numeric id | 422 `{"error": "Invalid parameters provided"}`; the UI treats it as not found |
| TC-5 | Rate limited | Call 30 times in one second | 429; one backoff retry, the previously loaded detail stays on screen |
| TC-6 | Empty result set | Fetch an endpoint whose `event_type_map` has every value false | 200; the detail view shows all events unticked and a warning that nothing will ever be sent |
| TC-7 | Secret never returned | Inspect the full response body | No secret, token or signing key field is present anywhere |
| TC-8 | Campaign scope shown | Fetch an endpoint with `email_campaign_id: 123` | The detail names that campaign and links to it; a workspace-level endpoint reads "All campaigns" |
| TC-9 | Delivery history | Trigger three events, two succeeding and one failing, then fetch | The detail lists three attempts with their status codes and latencies, newest first |
| TC-10 | Paused endpoint | Force repeated 500s until auto-pause, then fetch | Status reads paused with the reason and a Resume action; no events are queued while paused |
| TC-11 | Deleted mid-view | Delete the endpoint in another tab, then refresh the detail | 404 handled cleanly with "This endpoint no longer exists" and a link back |

## 4. Frontend user story

**As a** marketer, **I want** an endpoint detail view showing its settings and its recent deliveries, **so that** debugging an integration does not mean reading server logs.

**Scope**
- Settings → Notifications → an endpoint row opens a detail panel showing name, URL, scope, the full event checklist in its saved state, the reply-intent filter, and a recent deliveries table.
- The deliveries table shows time, event, status code and latency, with a failed row expandable to the response the receiver gave. Nothing lead-identifying is shown beyond what the payload already contained.
- A "Reveal signing secret" action requires re-entering the session (the same re-auth Harry uses for other sensitive actions) and shows the secret once with a copy button.
- Loading shows a skeleton panel; a 404 shows "This endpoint no longer exists" with a link back to the list; error keeps the panel and offers Retry.
- Accessibility: the panel is a labelled region with a heading, the checklist is read-only but still a fieldset with a legend, and the deliveries table has a caption. On narrow screens the panel becomes a full-screen sheet.

**Definition of done**
- [ ] Every event is shown ticked or unticked; none is silently omitted.
- [ ] The all-false state carries an explicit warning.
- [ ] The signing secret is only obtainable through the re-auth action.
- [ ] Loading, 404, error and paused states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** a read route for one endpoint plus its recent deliveries, **so that** support questions about a quiet integration are answerable from the app.

**Scope**
- Route: `GET /api/webhooks/:id` in `server/routes.js`, scoped to the session's workspace, returning the registry row joined to its last ten `webhook_deliveries`.
- Data model: none new beyond the `webhooks` and `webhook_deliveries` tables from the create story.
- The response projects `event_type_map` to a complete map, filling in false for events the row never stored, so the UI never has to know the catalogue. The `secret` column is excluded at the query level, not filtered afterwards.
- 404 for both missing and cross-workspace ids so existence is not leaked. Rate limited on the settings bucket with `Retry-After` on 429.
- Telemetry: query duration only. Nothing is written to `events` for a read.

**Definition of done**
- [ ] The secret column is excluded in the query, proved by a test that asserts on the serialised body.
- [ ] `event_type_map` is always complete in the response.
- [ ] Missing and cross-workspace ids both return 404 with the same body.
- [ ] Delivery history is capped at ten rows and ordered newest first.

## 6. End-to-end test ticket

**Title:** E2E — Inspect an endpoint and its deliveries

**Preconditions:** A workspace with one campaign, a sandbox mailbox, a registered endpoint listening for replies and sends, and a local receiver that can be switched between 200 and 500.

**Flow**
1. Sign in and open Settings → Notifications, then the endpoint.
2. Read the event checklist and the scope.
3. Approve an email so it sends, and simulate a reply.
4. Switch the receiver to 500 and simulate another reply.
5. Refresh the detail panel.
6. Use "Reveal signing secret".

**Assertions**
- [ ] The checklist matches what was ticked at creation, with the unticked events visible as unticked.
- [ ] After step 3 the deliveries table shows two successful attempts with status 200 and a latency.
- [ ] After step 4 a failed attempt appears with 500 and its retry attempts beneath it.
- [ ] The endpoint's status changes to paused if the failures cross the threshold, with a working Resume.
- [ ] Revealing the secret requires re-auth and shows the value once.

**Teardown:** Resume and delete the endpoint, delete the campaign and its messages, clear delivery rows.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings → Notifications | A detail panel per endpoint with settings and deliveries | Low | One panel opened from a row that already exists; nothing new in navigation |
| Monitoring | Unchanged | Low | Aggregate delivery health already arrives from the create story |

**Verdict:** Fits an existing surface

This is the read half of a section the create story already pays for. The one judgement call is showing delivery history in Settings rather than Monitoring: the person debugging an endpoint is the person who set it up, and making them cross the app to find out whether their URL answered would be exactly the thinking this product is meant to remove.
