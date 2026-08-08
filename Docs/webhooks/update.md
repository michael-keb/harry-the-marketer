# Update Webhook

| | |
|---|---|
| **Endpoint** | `PUT https://server.smartlead.ai/api/v1/webhook/update/{id}` |
| **Category** | webhooks |
| **Source** | https://api.smartlead.ai/api-reference/webhooks/update |
| **Auth** | API key (query param `api_key`) |

Changes an existing endpoint — its name, its URL, which events it hears about, or which reply intents it filters on.

## 1. Epic

**Outbound event notifications**

The epic lets a Harry workspace push what it already knows — an email sent, opened, clicked, replied to, bounced, a lead unsubscribed, a campaign's status changed — to any URL the user names, so a CRM, a spreadsheet or a team's own tooling learns about it without anyone copying anything across. It matters because Harry today can only tell one Slack or Teams webhook about four kinds of thing, in a message shaped for humans; everything else it knows stops at the edge of the app.

**Where Harry stands:** Settings holds one incoming-webhook URL for Slack or Teams alerts, and the engine, AI layer and mailer already write a `telemetry` row and an `events` row for the moments that matter. Outbound, per-event, machine-readable webhooks are new build on top of existing signals — not new signals.

## 2. User story

**As a** marketer whose receiving service has moved, **I want** to change an endpoint's URL and event selection in place, **so that** my integration keeps its history instead of being deleted and rebuilt.

**Acceptance criteria**
- [ ] Given a webhook id and a body containing any of `name`, `webhook_url`, `event_types` or `categories`, when it is saved, then a 200 returns `{ok: true, id, message}` and `updated_at` moves.
- [ ] Given only one field is sent, when it is saved, then the others keep their values — a partial update must never blank an unsent field.
- [ ] Given `event_types` is supplied as an array, when it is saved, then it replaces the previous selection wholesale, and the UI states that plainly before saving so nobody expects it to add to what is there.
- [ ] Given `webhook_url` is changed, when it is saved, then the endpoint's signing secret is kept, the change is written to the activity trail with who made it, and the next event goes to the new URL only.
- [ ] Given `webhook_url` is changed to a non-HTTPS, private or unreachable-by-policy address, when it is saved, then a 400 or 422 names `webhook_url` and the old URL stays in force.
- [ ] Given every event is unticked, when it is saved, then the save is allowed but the row is shown as "Listening for nothing" with a one-click way to pause it properly instead.
- [ ] Given the endpoint was auto-paused after repeated failures, when its URL is corrected and saved, then it resumes automatically and the resume is recorded.
- [ ] Given `categories` is emptied, when it is saved, then reply-intent filtering is switched off and all intents fire, matching the "empty means all" rule the read view shows.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | `PUT /webhook/update/12345` with `{"name": "My Updated Webhook", "webhook_url": "https://example.test/hook", "event_types": ["EMAIL_SENT","EMAIL_REPLIED","EMAIL_BOUNCED"], "categories": []}` | 200 `{ok: true, id: 12345, message: "Webhook saved successfully"}`; the row shows the new name and three event chips |
| TC-2 | Missing/invalid API key | PUT with no key, then a junk key | 401 `{"message": "Invalid API Key"}`; the dialog keeps its input |
| TC-3 | Not found / wrong workspace | PUT an id from another workspace, then a non-existent id | 404 both times with the same body; nothing changed |
| TC-4 | Validation failure | PUT `event_types: ["EMAIL_TELEPATHY"]` | 422 naming the unknown event and listing the valid ones; the UI never offers it |
| TC-5 | Rate limited | PUT 20 times in one second | 429 with `Retry-After`; Save disables briefly and the last saved state is kept |
| TC-6 | Empty result set | PUT `event_types: []` | 200; the row reads "Listening for nothing" with a Pause suggestion, and no events are delivered |
| TC-7 | Partial update | PUT with `name` only | 200; the URL, event selection and categories are unchanged when read back |
| TC-8 | Replace not merge | Endpoint listens for four events; PUT `event_types` with one | Exactly one event remains subscribed, and the confirmation said so before saving |
| TC-9 | Bad URL | PUT `webhook_url: "http://10.0.0.5/hook"` | 400 or 422 naming `webhook_url`; the previous URL still receives the next event |
| TC-10 | Secret preserved | Change the URL, then verify a delivery's signature with the secret captured before the change | The signature still verifies; the secret did not rotate |
| TC-11 | Resume after fix | Force auto-pause, correct the URL, save, then trigger an event | The endpoint is active again and the event is delivered; the resume is in the activity trail |
| TC-12 | Concurrent edits | Two members save different event selections at nearly the same moment | Last write wins deterministically, and the losing member is told the endpoint changed rather than seeing stale state |

## 4. Frontend user story

**As a** marketer, **I want** the same dialog I used to add an endpoint to edit it, **so that** changing an integration costs no new learning.

**Scope**
- Settings → Notifications: an Edit action on each endpoint row opening the create dialog prefilled, with a title change and one extra line above the event checklist reading "Saving replaces the current selection".
- Changing the URL shows a small confirmation naming the old and new hosts, because a mistyped host means silently losing events.
- "Send a test event" is available in the edit dialog too, so the new URL can be proven before saving.
- Loading disables Save; field errors land on their fields; an unticked-everything save is allowed but prompts "Pause this endpoint instead?".
- Accessibility: the dialog traps focus and restores it to the row's Edit button, the replace-not-merge note is associated with the fieldset, and the URL confirmation is a labelled dialog rather than a browser confirm.

**Definition of done**
- [ ] Create and edit are one component with one set of tests.
- [ ] The replace-not-merge behaviour is stated before the user can save.
- [ ] The test-event button works against the unsaved URL.
- [ ] Partial saves never blank an untouched field, covered by a component test.

## 5. Backend user story

**As a** Harry engineer, **I want** a partial-update route that preserves the secret and revalidates the URL, **so that** editing an endpoint cannot quietly break signature verification or point Harry at an internal address.

**Scope**
- Route: `PATCH /api/webhooks/:id` in `server/routes.js`, workspace-scoped, accepting `name`, `url`, `event_type_map` and `category_id_map`. The upstream `PUT .../update/{id}` shape with an `event_types` array is accepted and normalised to Harry's map internally, so both shapes work for anyone porting an integration.
- Data model: none new. Updates the `webhooks` row and bumps `updated_at`; the `secret` column is never touched by this route — rotation is its own explicit action.
- URL revalidation on every save: HTTPS only, public address only, resolved at save time and again at delivery time. Auto-paused endpoints resume when a save changes the URL or the event selection.
- Rate limited on the settings bucket. Logged to `events`: which fields changed, old and new URL host, and who changed them. Nothing secret is logged. Update latency to `telemetry`.

**Definition of done**
- [ ] Partial update merges; a test sends one field and asserts the rest unchanged.
- [ ] The secret is provably unchanged across a URL edit.
- [ ] Both the array and map event shapes normalise to the same stored value.
- [ ] Auto-paused endpoints resume on a corrective save, covered by a test.

## 6. End-to-end test ticket

**Title:** E2E — Edit an endpoint

**Preconditions:** A workspace with one campaign, a sandbox mailbox, a registered endpoint listening for four events, a local receiver on URL A and a second receiver on URL B, and a captured copy of the endpoint's signing secret.

**Flow**
1. Sign in and open Settings → Notifications, then Edit the endpoint.
2. Rename it and reduce the event selection to "Lead replied" only, reading the replace note, and save.
3. Simulate a reply and an email send.
4. Edit again, point the URL at receiver B, confirm the host change, use "Send a test event", and save.
5. Simulate another reply.
6. Open the activity trail.

**Assertions**
- [ ] After step 2 the row shows one event chip, not four.
- [ ] After step 3 receiver A gets one POST for the reply and none for the send.
- [ ] The test event in step 4 reaches receiver B and shows its status code inline.
- [ ] After step 5 receiver B gets the reply and receiver A gets nothing.
- [ ] The signature on receiver B's POST verifies with the secret captured before the URL change.
- [ ] The activity trail records the rename, the event-selection change and the URL change with the old and new hosts.

**Teardown:** Delete the endpoint, campaign and messages; clear delivery rows and the trail entries created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Settings → Notifications | An Edit action reusing the add dialog | Low | Same dialog, one extra note; nothing new to learn |
| Settings → Notifications | A host-change confirmation | Low | One small dialog, shown only when the host actually changes |
| Activity trail | Endpoint change entries | Low | Same row format as every other trail entry |

**Verdict:** Fits an existing surface

Editing rides entirely on the dialog the create story builds. The only additions worth their space are the "saving replaces the selection" note and the host-change confirmation, both of which exist to stop the quiet failure where a user believes events are flowing and they are not.
