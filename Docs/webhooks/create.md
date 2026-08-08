# Create Webhook

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/webhook/create` |
| **Category** | webhooks |
| **Source** | https://api.smartlead.ai/api-reference/webhooks/create |
| **Auth** | API key (query param `api_key`) |

Registers a URL that should receive an HTTP POST every time a chosen thing happens — an email sent, opened, clicked, replied to, bounced, or a lead unsubscribing.

## 1. Epic

**Outbound event notifications**

The epic lets a Harry workspace push what it already knows — an email sent, opened, clicked, replied to, bounced, a lead unsubscribed, a campaign's status changed — to any URL the user names, so a CRM, a spreadsheet or a team's own tooling learns about it without anyone copying anything across. It matters because Harry today can only tell one Slack or Teams webhook about four kinds of thing, in a message shaped for humans; everything else it knows stops at the edge of the app.

**Where Harry stands:** Settings holds one incoming-webhook URL for Slack or Teams alerts, and the engine, AI layer and mailer already write a `telemetry` row and an `events` row for the moments that matter. Outbound, per-event, machine-readable webhooks are new build on top of existing signals — not new signals.

## 2. User story

**As a** marketer whose CRM is the source of truth, **I want** Harry to POST an event to my endpoint whenever something happens in a campaign, **so that** my CRM stays current without anyone exporting a CSV.

**Acceptance criteria**
- [ ] Given a `webhook_url` over HTTPS and an `event_type_map` with at least one event set to `true`, when the webhook is created, then a 200 returns `{ok: true, id, webhook_url}` and the endpoint appears in the list as active.
- [ ] Given `association_type` is `campaign`, when the webhook is created, then `email_campaign_id` is required and a 422 `{"error": "..."}` names it if missing; given it is `user`, then it applies to every campaign in the workspace and no campaign id is asked for.
- [ ] Given a `user`-level webhook already exists for an event, when a campaign-level one is created for the same event, then the user-level one takes priority and the UI says so plainly rather than letting the user believe both will fire.
- [ ] Given `event_type_map` contains only the events Harry can genuinely produce, when the create form renders, then only those are offered — `EMAIL_SENT`, `FIRST_EMAIL_SENT`, `EMAIL_OPEN`, `EMAIL_LINK_CLICK`, `EMAIL_REPLY`, `EMAIL_BOUNCE`, `LEAD_UNSUBSCRIBED`, `LEAD_CATEGORY_UPDATED` (Harry's reply intents), `CAMPAIGN_STATUS_CHANGED` and `MANUAL_STEP_REACHED` (a lead parked in the Action Center). `UNTRACKED_REPLIES` is offered only once a catch-all path exists.
- [ ] Given `webhook_url` is missing, is not HTTPS, or resolves to a private or loopback address, when creation is attempted, then a 422 names `webhook_url` and states why, and nothing is registered.
- [ ] Given the webhook is created, when Harry sends its first event, then the POST body carries `event_type` and the documented fields for that event (for a reply: `from_email`, `to_email`, `to_name`, `subject`, `time_replied`, `preview_text`, `campaign_name`, `campaign_id`, `sequence_number`), plus a signature header the receiver can verify.
- [ ] Given a webhook already exists with the same URL and scope, when creation is attempted without `force_create`, then it is refused with a message pointing at the existing one; with `force_create` true it is allowed and both are listed.
- [ ] Given `LEAD_CATEGORY_UPDATED` is enabled, when `category_id_map` names specific categories, then only those reply intents fire the webhook, and an empty map means all of them.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{"name": "Reply Notifications", "webhook_url": "https://example.test/hook", "email_campaign_id": 123, "association_type": "campaign", "event_type_map": {"EMAIL_REPLY": true, "EMAIL_OPEN": true}}` | 200, `{ok: true, id, webhook_url}`; the endpoint is listed as active with two event chips |
| TC-2 | Missing/invalid API key | POST with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the form keeps its input |
| TC-3 | Not found / wrong workspace | POST with `email_campaign_id` from another workspace | 404; nothing registered, no campaign name echoed |
| TC-4 | Validation failure | POST with no `webhook_url` | 422 `{"error": "webhook_url is required"}`; the URL field is marked |
| TC-5 | Rate limited | POST 20 creations in one second | 429 with `Retry-After`; the Create button disables and explains |
| TC-6 | Empty result set | Open the webhooks list before any exist | 200 with an empty list; "No endpoints yet" and one Add button |
| TC-7 | Campaign scope without id | POST `association_type: "campaign"` with no `email_campaign_id` | 422 naming `email_campaign_id`; the form requires a campaign when campaign scope is chosen |
| TC-8 | Private address | POST `webhook_url: "http://localhost:9000/hook"` | 422 naming `webhook_url`, stating HTTPS and public host are required |
| TC-9 | Duplicate without force | Create the same URL and scope twice | Second attempt refused with a pointer to the first; `force_create: true` succeeds and both are listed |
| TC-10 | Scope priority | Create a user-level `EMAIL_REPLY` webhook, then a campaign-level one, then trigger a reply | Only the user-level endpoint receives the POST, and the campaign-level row is shown as overridden |
| TC-11 | First delivery | Create with `EMAIL_REPLY`, simulate a reply on a sandbox mailbox | The receiver gets one POST with `event_type: "EMAIL_REPLY"` and the documented fields, plus a valid signature header |
| TC-12 | Category filter | Enable `LEAD_CATEGORY_UPDATED` with `category_id_map` limited to the "interested" intent, then classify one reply as "question" and one as "interested" | Exactly one POST arrives, for the interested reply |

## 4. Frontend user story

**As a** marketer, **I want** to add an endpoint and tick which events it should hear about, **so that** connecting Harry to my own tools is a two-minute job with no documentation.

**Scope**
- Settings → Notifications (the section that already holds the Slack and Teams webhook URL): a second block, "Send events to your own systems", listing endpoints and offering Add.
- The Add dialog asks for a name, a URL, a scope (Everything in this workspace / One campaign) and a checklist of events written in Harry's own words — "Email sent", "First email sent", "Email opened", "Link clicked", "Lead replied", "Email bounced", "Lead unsubscribed", "Reply intent changed", "Campaign status changed", "Lead needs a decision". The Smartlead constants stay on the server.
- A "Send a test event" button posts a sample payload and shows the receiver's status code and response time inline, so nobody has to guess whether the URL works.
- Loading disables Save; 422 messages land on their fields; a scope conflict is shown as an inline note next to the scope control, not a toast.
- Accessibility: the event checklist is a grouped fieldset with a legend, each checkbox labelled in plain language; the dialog traps focus and returns it on close. On narrow screens the checklist becomes a single column.

**Definition of done**
- [ ] Event names in the UI never show the underlying constants.
- [ ] The test-event result is shown inline with status code and latency.
- [ ] A user-level endpoint that overrides a campaign-level one is shown as such on both rows.
- [ ] Empty, error, duplicate and scope-conflict states have component tests.

## 5. Backend user story

**As a** Harry engineer, **I want** an outbound webhook registry and a delivery worker, **so that** every event Harry already records can be published without any page or engine step knowing about HTTP.

**Scope**
- Route: `POST /api/webhooks` in `server/routes.js`, following the settings-route conventions. Body: `name`, `webhook_url`, `association_type` (`user` or `campaign` — Harry has no client model yet, so `client` is rejected with a clear message), `campaign_id`, `event_type_map`, `category_id_map`, `force_create`.
- Data model: new `webhooks` table (`id`, `user_id`, `name`, `url`, `scope`, `campaign_id`, `event_type_map` JSON, `category_id_map` JSON, `secret`, `status`, `created_at`, `updated_at`) and a `webhook_deliveries` table (`id`, `webhook_id`, `event_type`, `payload_hash`, `attempt`, `status_code`, `error`, `delivered_at`) in `server/db.js`.
- Events are sourced from the writes the engine, mailer and AI layer already make: sends and bounces from `server/mailer.js`, opens and clicks from the tracking routes, replies and intents from `server/engine.js`, unsubscribes from the unsubscribe path. No new instrumentation, only a publish call at those points.
- Delivery is asynchronous with a signed `X-Harry-Signature` header (HMAC of the body with the endpoint's secret) and an `X-Harry-Event-Id` for idempotency. Retries follow exponential backoff for 5xx and timeouts, up to a bounded number of attempts; a 4xx is not retried. An endpoint failing continuously is auto-paused and the owner is told.
- `webhook_url` must be HTTPS and resolve to a public address — private, loopback and link-local ranges are refused, checked at delivery time as well as creation time so a DNS change cannot turn an endpoint inward.
- Logged: each attempt to `webhook_deliveries`, aggregate success rate to `telemetry` so Monitoring shows it, and one `events` row when an endpoint is created or auto-paused. Delivery never blocks a send — the standing rule is that a failing integration is telemetry, exactly as the Slack alert already is.

**Definition of done**
- [ ] Publishing is a single call used by every producer, with one test per event type asserting the documented payload shape.
- [ ] Signature verification is documented and covered by a test using a known secret.
- [ ] Private-address URLs are refused at creation and at delivery.
- [ ] A failing endpoint never delays or blocks an email send, proved by a test.
- [ ] Scope priority (user over campaign) is implemented in one place and tested.

## 6. End-to-end test ticket

**Title:** E2E — Register an endpoint and receive events

**Preconditions:** A workspace with one campaign, a sandbox mailbox, five leads, and a local HTTPS receiver that records requests and can be told to return 500 on demand.

**Flow**
1. Sign in and open Settings → Notifications.
2. Add an endpoint pointing at the receiver, scoped to the campaign, with "Lead replied" and "Email sent" ticked.
3. Use "Send a test event".
4. Approve a queued email in the Inbox so it sends.
5. Simulate a reply on the sandbox mailbox.
6. Set the receiver to return 500 and simulate another reply.

**Assertions**
- [ ] The test event arrives and the dialog shows the receiver's status code and latency.
- [ ] After step 4 one POST arrives with `event_type: "EMAIL_SENT"` and the documented send fields.
- [ ] After step 5 one POST arrives with `event_type: "EMAIL_REPLY"`, `to_email` matching the lead, and `campaign_id` matching the campaign.
- [ ] Every POST carries a valid `X-Harry-Signature` and a unique `X-Harry-Event-Id`.
- [ ] After step 6 the delivery is retried with backoff, the send itself is unaffected, and the endpoint row shows its recent failures.
- [ ] Nothing about the failing endpoint appears as an error to the user mid-approval.

**Teardown:** Delete the endpoint, the campaign, its leads and messages; clear delivery rows and telemetry.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings → Notifications | A second block listing endpoints, with Add and a test button | Medium | Sits under the Slack and Teams field that already exists; collapsed to one line reading "No endpoints" until used |
| Monitoring | Webhook delivery success rate in the existing telemetry section | Low | One more row beside delivery telemetry |
| Inbox and Campaigns | No change | Low | Delivery is background work and must never interrupt an approval |

**Verdict:** Fits an existing surface

Settings already has the place where a user pastes a webhook URL, so this is the same idea taken further rather than a new concept. Keeping the event names in plain English and defaulting the block to a single collapsed line means a user who never integrates anything sees almost nothing new.
