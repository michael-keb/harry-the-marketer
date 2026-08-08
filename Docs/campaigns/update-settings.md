# Update Campaign Settings

| | |
|---|---|
| **Endpoint** | `POST https://server.smartlead.ai/api/v1/campaigns/{campaign_id}/settings` |
| **Category** | campaigns |
| **Source** | https://api.smartlead.ai/api-reference/campaigns/update-settings |
| **Auth** | API key (query param `api_key`) |

Changes how a campaign behaves — its name, what it tracks, when it stops emailing someone, whether it sends plain text, its unsubscribe wording, and how it handles out-of-office replies.

## 1. Epic

**Campaign lifecycle and sequence control**

The epic gives a Harry user everything needed to run a campaign end to end: draft the playbook, attach leads and a mailbox, launch, watch it, adjust it, and stop it — from the Campaigns page and the campaign detail page, without touching a database or an API client. It matters because a campaign that cannot be inspected, corrected or halted mid-flight is a liability, and Harry's standing rule that nothing sends without the user's OK only holds if the controls around sending are just as immediate.

## 2. User story

**As a** campaign owner targeting a privacy-conscious technical audience, **I want** to turn off tracking, send plain text and control when the agent stops chasing someone, **so that** my outreach matches the audience instead of tripping every filter they run.

**Acceptance criteria**
- [ ] Given I submit settings, when they save, then I get `{ success: true, data: { message: "Settings updated successfully" } }` and the campaign behaves accordingly on the next send.
- [ ] Given `track_settings` accepts `DONT_TRACK_EMAIL_OPEN`, `DONT_TRACK_LINK_CLICK` and `DONT_TRACK_REPLY_TO_AN_EMAIL`, when I include a value, then that tracking is disabled; an empty array `[]` enables all tracking.
- [ ] Given open tracking is off, when Reports renders an open rate for that campaign, then it says tracking is disabled rather than showing 0%.
- [ ] Given click tracking is off, when an email sends, then links are not wrapped, and the unsubscribe link still works because it is not optional.
- [ ] Given `stop_lead_settings` is `OPEN_AN_EMAIL` or `CLICK_ON_A_LINK`, when a lead does that thing, then the sequence stops for them and the reason is shown on the lead.
- [ ] Given `send_as_plain_text` or `force_plain_text` is true, when an email sends, then it carries no HTML, and the plain-text opt-out line is still present.
- [ ] Given `unsubscribe_text` is set, when an email sends, then that wording appears; if it is emptied, the default wording is used, because an email with no opt-out is never sent.
- [ ] Given `follow_up_percentage` is an integer 0-100, when it is outside that range, then I get a 422 `{ "error": "Invalid parameters provided" }` naming the field.
- [ ] Given `out_of_office_detection_settings` with `ignoreOOOasReply`, `autoReactivateOOO`, `reactivateOOOwithDelay` and `autoCategorizeOOO`, when an out-of-office reply arrives, then it is handled per those settings and the behaviour is stated on the lead.
- [ ] Given settings changes affect future sends only, when I save mid-campaign, then leads already in flight are described as continuing under the previous settings until their next step.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | POST `{ name: "My Campaign", track_settings: ["DONT_TRACK_EMAIL_OPEN"], stop_lead_settings: "CLICK_ON_A_LINK", send_as_plain_text: false, follow_up_percentage: 100 }` | 200 `{ success: true, data: { message: "Settings updated successfully" } }` |
| TC-2 | Missing/invalid API key | Repeat TC-1 without `api_key` | 401 `{ "message": "Invalid API Key" }`; nothing saved |
| TC-3 | Not found / wrong workspace | Save settings on another workspace's campaign | 404 `{ "error": "Resource not found" }` |
| TC-4 | Validation failure | POST `follow_up_percentage: 150` | 422 `{ "error": "Invalid parameters provided" }` naming the field |
| TC-5 | Rate limited | Save settings repeatedly | 429; the form retries once and the last submitted state is what persists |
| TC-6 | Empty result set | Open settings on a brand-new campaign | 200 with workspace defaults shown and labelled as defaults |
| TC-7 | Open tracking off | Set `DONT_TRACK_EMAIL_OPEN`, send an email | The message contains no tracking pixel; Reports says open tracking is off for this campaign |
| TC-8 | Click tracking off | Set `DONT_TRACK_LINK_CLICK`, send an email | Links are unwrapped; the unsubscribe link and List-Unsubscribe header are still present and working |
| TC-9 | Plain text | Set `send_as_plain_text: true`, send an email | The message has no HTML part and still carries the plain-text opt-out line |
| TC-10 | Unknown track value | POST `track_settings: ["DONT_TRACK_MOON_PHASE"]` | 422 listing the accepted values |
| TC-11 | Unsubscribe text emptied | POST `unsubscribe_text: ""` | The default wording is used; no email goes out without an opt-out |
| TC-12 | Out-of-office handling | Set `ignoreOOOasReply: true`, `autoReactivateOOO: true`, `reactivateOOOwithDelay: 5`, simulate an out-of-office reply | The lead is not treated as replied, and is followed up 5 days later |
| TC-13 | In-flight leads | Change the stop condition with leads mid-sequence | Leads in flight complete their current step under the old rule; the UI says so |
| TC-14 | Smart follow-up interaction | Turn open tracking off, then check follow-up timing | The timing adjustment ignores "never opened" for this campaign, as the existing rule requires |

## 4. Frontend user story

**As a** campaign owner, **I want** a settings panel on the campaign that speaks English, **so that** I can change how a campaign behaves without decoding constant names.

**Scope**
- Campaign detail: a "Behaviour" panel with grouped, plainly labelled controls — name; tracking (open, click, reply) as three checkboxes; "stop emailing a lead when they..."; plain text toggle; unsubscribe wording; out-of-office handling.
- Out-of-office handling is one group: treat as a reply or not, reactivate automatically, and after how many days.
- Every control carries a one-line consequence in plain English ("Turning this off means Reports cannot show open rates for this campaign").
- Settings page: the workspace-level defaults use the same panel, and campaign settings show which values are inherited.
- Loading disables save; errors anchor to fields; a save while the campaign is running shows a note that in-flight leads finish their current step under the old settings.
- Accessibility: grouped fieldsets with legends, real checkboxes, consequences as `aria-describedby` text rather than tooltips, and the unsubscribe wording field with a live preview. On mobile the panel is a single column with groups collapsible.

**Definition of done**
- [ ] No raw constant name appears in the UI.
- [ ] Every toggle states its consequence before it is flipped.
- [ ] The unsubscribe wording cannot be saved empty in a way that removes the opt-out.
- [ ] Inherited defaults are visibly marked as inherited.

## 5. Backend user story

**As a** Harry server, **I want** validated per-campaign behaviour settings, **so that** the mailer, the engine and Reports all read one record instead of hardcoding policy.

**Scope**
- Add `PUT /api/campaigns/:id/settings` to `server/routes.js`, workspace-scoped, accepting the full settings object with unknown keys rejected.
- Data model: a settings JSON column on `campaigns` in `server/db.js`, with workspace defaults applied at read time rather than copied at creation.
- `server/mailer.js` reads tracking and plain-text flags per campaign when building each message; the unsubscribe footer and List-Unsubscribe header are never conditional.
- `server/engine.js` reads the stop condition and the out-of-office settings; the existing smart follow-up rule already ignores "never opened" unless open tracking has demonstrably worked, and that must stay true when tracking is disabled.
- Validate every enum against an allow-list, `follow_up_percentage` within 0-100, and `reactivateOOOwithDelay` as a positive integer with a ceiling.
- Write an `events` row listing which settings changed with old and new values, and a `telemetry` row for the call.

**Definition of done**
- [ ] Disabling tracking removes the pixel and link wrapping, proven by a mailer test.
- [ ] The opt-out line and header survive every settings combination, proven by a test.
- [ ] Stop conditions are honoured by an engine test.
- [ ] Settings apply to future sends only, with in-flight behaviour documented and tested.

## 6. End-to-end test ticket

**Title:** E2E — configure a campaign for a privacy-conscious audience

**Preconditions:** A workspace with a sandbox mailbox, one running campaign with a multi-step playbook, five leads, and default settings inherited from the workspace.

**Flow**
1. Sign in and open the campaign's Behaviour panel.
2. Turn off open and click tracking, enable plain text, and set the stop condition to "when they click a link".
3. Read the consequence text and save.
4. Run the engine and inspect a sent message.
5. Simulate an out-of-office reply with `ignoreOOOasReply` enabled and a 5-day reactivation.
6. Open Reports.

**Assertions**
- [ ] The sent message has no HTML part, no tracking pixel and no wrapped links.
- [ ] The message still carries the plain-text opt-out line and the List-Unsubscribe header.
- [ ] Reports states that open tracking is off for this campaign rather than showing 0%.
- [ ] The out-of-office lead is not counted as replied and is chased again after 5 days.
- [ ] The activity trail lists each changed setting with its old and new value.

**Teardown:** Restore workspace defaults, delete the campaign and leads, clear the events and telemetry rows created by the run.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Campaign detail | New "Behaviour" panel with several groups | High | Collapsed by default with a one-line summary; groups collapse individually; defaults are inherited so most users never open it |
| Settings | Same panel for workspace defaults | Low | One component reused; no new page |
| Reports | Rates say when tracking is disabled | Low | Replaces a misleading 0% with one honest line |

**Verdict:** Fits an existing surface

This is the largest single addition to the campaign page in the category, and the honest answer is that it belongs there rather than in a new place — settings for a campaign live on the campaign. The bloat is controlled by inheriting from workspace defaults, so an untouched campaign shows a single summary line, and by writing every label as a sentence rather than a constant.
