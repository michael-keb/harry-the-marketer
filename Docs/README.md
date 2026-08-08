# SmartLead API — capability backlog

Generated from `data/smartlead_api_docs.md` (229 pages scraped from api.smartlead.ai).
One file per endpoint, each carrying eight artefacts: an epic, a user story, test
cases, a frontend story, a backend story, an end-to-end test ticket, and an honest
assessment of the impact on the UI.

**210 endpoints across 17 categories.** Of the 229 pages, 13 are guides
(Rate Limits, Error Handling, Best Practices, FAQ and similar) and 6 are introduction
pages that reuse a sample call — neither is an endpoint, so both are excluded. Every
page under smart-delivery, smart-prospect and smart-senders omits the `**Endpoint:**`
line entirely; those method-and-path pairs were recovered from the cURL samples, without
which 61 endpoints would have been silently dropped.

## What these are, and what they are not

These are backlog items for building the equivalent capability **in Harry the Marketer**
— not a guide to integrating with SmartLead. Every story names Harry's real pages, and
section 7 is written against Harry's standing rule that a new feature should not cost a
new thing to think about.

That rule survived 210 endpoints: **203 fit an existing surface**,
**4 need no UI at all**, and only **3 argue for a new surface**.
No file anywhere proposes a new navigation item.

### The three that need a new surface

| Endpoint | Why |
|---|---|
| [clients/create](clients/create.md) | Harry's Team model deliberately shares one workspace; agency clients need a real scope |
| [lead-notes/create](lead-notes/create.md) | Harry has nowhere for a human to write context — the research profile is the agent's, the activity trail is a log |
| [smart-prospect/search-contacts](smart-prospect/search-contacts.md) | A two-pane search-and-preview inside Leads has no existing equivalent |

### The four that need no UI

- [campaigns/get-leads-history-bulk](campaigns/get-leads-history-bulk.md) — Get Bulk Lead Message History
- [email-accounts/tags](email-accounts/tags.md) — Get All Tags
- [smart-delivery/provider-ids](smart-delivery/provider-ids.md) — Get Provider IDs
- [utilities/send-single-email](utilities/send-single-email.md) — Send Single Email

## Read this before scoping anything

The source documentation is uneven, and the files say so where it matters. The gaps
worth knowing up front:

- **`campaigns/forward-email` documents no request fields at all.** The page says the
  body is "likely similar to reply-email-thread", ships an empty `{}` sample, and
  carries its own warning to verify against the controller. Do not build against it
  without checking the real API.
- **Six smart-delivery endpoints publish their request body as `{}`** — create
  automated and manual tests, bulk delete, list tests, geo and provider reports. Each
  isolates its request contract in one adapter so a correction is a single-file change.
- **`campaigns/update-status` contradicts itself**: the body spec says send `START`,
  every code sample sends `ACTIVE`. Documented as `START`/`PAUSED`/`STOPPED`, with
  `ACTIVE` written up as a 422 case.
- **Three smart-delivery endpoints disagree with themselves on HTTP method** across
  their own cURL, Python and JavaScript samples.
- **`campaigns/update-settings` names fields in prose that its own schema lacks.** The
  schema is documented; the prose-only fields are ignored.
- **`smart-prospect/fetch-contacts` returns HTTP 200 with `success: false`** on a
  credit failure — the central test case for that endpoint.

## Deliberate divergences from the source API

Applied consistently, and stated in every affected file:

- **Suppression is unconditional.** SmartLead's `ignore_unsubscribe_list` and
  `ignore_global_block_list` import settings are not offered.
- **Nothing sends without the user's OK.** Forwards and manual replies pass through the
  same confirmation. `utilities/send-single-email` is specified as one shared internal
  function rather than a compose screen, because a compose screen is the obvious way
  around the rule.
- **Unbounded requests are rejected.** `campaigns/get-all` pages server-side rather than
  returning everything; `get-leads-history-bulk` refuses a null id list meaning "all".
- **One `tags` table**, keyed `(workspace_id, applies_to, name)` and shared by lead tags
  and mailbox tags, split into `POST /api/tags` and `PUT /api/tags/:id` rather than
  SmartLead's single silently-upserting `tag-manager`.
- **No credential handling.** `clients/create` rejects the source's `password` field —
  sign-in stays with Auth0. smart-senders never has Harry touch card details, and passes
  mailbox credentials through once without storing, logging or auto-entering them.
- **A campaign is never created implicitly.** `lead-lists/push-to-campaign` drops the
  source's `campaignName` behaviour: a Harry campaign cannot launch without a valid
  playbook and a mailbox, so a campaign conjured from a string would be a broken one.

## Where to start

`smart-delivery/list-tests` and `smart-delivery/test-details` are load-bearing: every
other file in that 28-endpoint category renders inside the section and page those two
define, so the whole category costs one new Monitoring section rather than 28 surfaces.

## Categories

| Category | Epic | Endpoints |
|---|---|---|
| [analytics](#analytics) | Workspace-wide outreach analytics | 22 |
| [campaign-statistics](#campaign-statistics) | Per-campaign performance breakdown | 6 |
| [campaigns](#campaigns) | Campaign lifecycle and sequence control | 42 |
| [clients](#clients) | Agency client workspaces | 4 |
| [email-account-tags](#email-account-tags) | Mailbox tagging and fleet segmentation | 5 |
| [email-accounts](#email-accounts) | Mailbox fleet management and sender health | 11 |
| [inbox](#inbox) | Unified reply inbox and lead triage | 25 |
| [lead-lists](#lead-lists) | Reusable lead segments | 9 |
| [lead-notes](#lead-notes) | Shared context on a prospect | 2 |
| [lead-tags](#lead-tags) | Lead labels across campaigns | 4 |
| [lead-tasks](#lead-tasks) | Human follow-up work on a prospect | 2 |
| [leads](#leads) | The prospect record and its lifecycle | 11 |
| [smart-delivery](#smart-delivery) | Inbox placement and deliverability assurance | 28 |
| [smart-prospect](#smart-prospect) | Prospect discovery and contact enrichment | 26 |
| [smart-senders](#smart-senders) | Sending infrastructure procurement | 7 |
| [utilities](#utilities) | Sending controls outside the playbook | 2 |
| [webhooks](#webhooks) | Outbound event notifications | 4 |

---

## analytics

**Epic:** Workspace-wide outreach analytics · 22 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Get Campaign List](analytics/campaign-list.md) | `GET /api/v1/analytics/campaign/list` | Fits an existing surface |
| [Campaign Performance](analytics/campaign-performance.md) | `GET /api/v1/analytics/campaign/overall-stats` | Fits an existing surface |
| [Campaign Response Stats](analytics/campaign-response-stats.md) | `GET /api/v1/analytics/campaign/response-stats` | Fits an existing surface |
| [Campaign Status Stats](analytics/campaign-status-stats.md) | `GET /api/v1/analytics/campaign/status-stats` | Fits an existing surface |
| [Get Client List](analytics/client-list.md) | `GET /api/v1/analytics/client/list` | Fits an existing surface |
| [Client Overall Stats](analytics/client-performance.md) | `GET /api/v1/analytics/client/overall-stats` | Fits an existing surface |
| [Day-wise Positive Reply Stats](analytics/day-wise-positive-reply.md) | `GET /api/v1/analytics/day-wise-positive-reply-stats` | Fits an existing surface |
| [Positive Reply Stats by Sent Time](analytics/day-wise-positive-sent-time.md) | `GET /api/v1/analytics/day-wise-positive-reply-stats-by-sent-time` | Fits an existing surface |
| [Day-wise Stats by Sent Time](analytics/day-wise-sent-time.md) | `GET /api/v1/analytics/day-wise-overall-stats-by-sent-time` | Fits an existing surface |
| [Get Day-wise Overall Stats](analytics/day-wise-stats.md) | `GET /api/v1/analytics/day-wise-overall-stats` | Fits an existing surface |
| [Domain-wise Health Metrics](analytics/domain-wise-health.md) | `GET /api/v1/analytics/mailbox/domain-wise-health-metrics` | Fits an existing surface |
| [Email-ID-wise Health Metrics](analytics/email-wise-health.md) | `GET /api/v1/analytics/mailbox/name-wise-health-metrics` | Fits an existing surface |
| [Follow-up Reply Rate](analytics/followup-reply-rate.md) | `GET /api/v1/analytics/campaign/follow-up-reply-rate` | Fits an existing surface |
| [Lead Category-wise Response](analytics/lead-category-response.md) | `GET /api/v1/analytics/lead/category-wise-response` | Fits an existing surface |
| [Lead Statistics](analytics/lead-stats.md) | `GET /api/v1/analytics/lead/overall-stats` | Fits an existing surface |
| [Lead to Reply Time](analytics/lead-to-reply-time.md) | `GET /api/v1/analytics/campaign/lead-to-reply-time` | Fits an existing surface |
| [Leads Take for First Reply](analytics/leads-for-first-reply.md) | `GET /api/v1/analytics/campaign/leads-take-for-first-reply` | Fits an existing surface |
| [Mailbox Overall Stats](analytics/mailbox-health.md) | `GET /api/v1/analytics/mailbox/overall-stats` | Fits an existing surface |
| [Get Month-wise Client Count](analytics/month-wise-client-count.md) | `GET /api/v1/analytics/client/month-wise-count` | Fits an existing surface |
| [Get Overall Analytics](analytics/overview.md) | `GET /api/v1/analytics/overall-stats-v2` | Fits an existing surface |
| [Provider-wise Performance](analytics/provider-performance.md) | `GET /api/v1/analytics/mailbox/provider-wise-overall-performance` | Fits an existing surface |
| [Team Board Stats](analytics/team-board-stats.md) | `GET /api/v1/analytics/team-board/overall-stats` | Fits an existing surface |

## campaign-statistics

**Epic:** Per-campaign performance breakdown · 6 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Fetch Campaign Statistics by Date Range](campaign-statistics/get-by-date-range.md) | `GET /api/v1/campaigns/{id}/analytics-by-date` | Fits an existing surface |
| [Fetch Campaign Statistics by Campaign ID](campaign-statistics/get-by-id.md) | `GET /api/v1/campaigns/{id}/statistics` | Fits an existing surface |
| [Fetch Campaign Lead Statistics](campaign-statistics/lead-statistics.md) | `GET /api/v1/campaigns/{id}/leads-statistics` | Fits an existing surface |
| [Fetch Campaign Mailbox Statistics](campaign-statistics/mailbox-statistics.md) | `GET /api/v1/campaigns/{id}/mailbox-statistics` | Fits an existing surface |
| [Fetch Campaign Top Level Analytics by Date Range](campaign-statistics/top-level-by-date.md) | `GET /api/v1/campaigns/{id}/top-level-analytics-by-date` | Fits an existing surface |
| [Fetch Campaign Top Level Analytics](campaign-statistics/top-level.md) | `GET /api/v1/campaigns/{id}/analytics` | Fits an existing surface |

## campaigns

**Epic:** Campaign lifecycle and sequence control · 42 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Add Email Accounts to Campaign](campaigns/add-email-accounts.md) | `POST /api/v1/campaigns/{id}/email-accounts` | Fits an existing surface |
| [Add Leads to Campaign](campaigns/add-leads.md) | `POST /api/v1/campaigns/{id}/leads` | Fits an existing surface |
| [Get All Leads Activities](campaigns/all-leads-activities.md) | `GET /api/v1/campaigns/all-leads-activities` | Fits an existing surface |
| [Create Subsequence Campaign](campaigns/create-subsequence.md) | `POST /api/v1/campaigns/create-subsequence` | Fits an existing surface |
| [Create Campaign](campaigns/create.md) | `POST /api/v1/campaigns/create` | Fits an existing surface |
| [Delete Lead from Campaign](campaigns/delete-lead.md) | `DELETE /api/v1/campaigns/{id}/leads/{id}` | Fits an existing surface |
| [Delete Campaign Webhook](campaigns/delete-webhook.md) | `DELETE /api/v1/campaigns/{id}/webhooks/{id}` | Fits an existing surface |
| [Delete Campaign](campaigns/delete.md) | `DELETE /api/v1/campaigns/{id}` | Fits an existing surface |
| [Duplicate Campaign](campaigns/duplicate.md) | `POST /api/v1/campaigns/{id}/duplicate` | Fits an existing surface |
| [Export Campaign Leads](campaigns/export-leads.md) | `GET /api/v1/campaigns/{id}/leads-export` | Fits an existing surface |
| [Forward Campaign Email](campaigns/forward-email.md) | `POST /api/v1/campaigns/{id}/forward-email` | Fits an existing surface |
| [Get All Campaigns](campaigns/get-all.md) | `GET /api/v1/campaigns/` | Fits an existing surface |
| [Get Campaign Analytics by Date Range](campaigns/get-analytics-by-date.md) | `GET /api/v1/campaigns/{id}/analytics-by-date` | Fits an existing surface |
| [Get Campaign Analytics](campaigns/get-analytics.md) | `GET /api/v1/campaigns/{id}/analytics` | Fits an existing surface |
| [Get Campaign by ID](campaigns/get-by-id.md) | `GET /api/v1/campaigns/{id}` | Fits an existing surface |
| [Get Campaign Email Accounts](campaigns/get-email-accounts.md) | `GET /api/v1/campaigns/{campaign_id}/email-accounts` | Fits an existing surface |
| [Get Lead by ID](campaigns/get-lead-by-id.md) | `GET /api/v1/leads/{id}` | Fits an existing surface |
| [Get Lead Message History](campaigns/get-lead-history.md) | `GET /api/v1/campaigns/{id}/leads/{id}/message-history` | Fits an existing surface |
| [Get Bulk Lead Message History](campaigns/get-leads-history-bulk.md) | `POST /api/v1/campaigns/{id}/message-history-for-leads/bbfbdsFGHlBr76ruhjvh6fhHL` | Invisible — no UI |
| [Get Campaign Leads](campaigns/get-leads.md) | `GET /api/v1/campaigns/{id}/leads` | Fits an existing surface |
| [Get Campaign Sequences](campaigns/get-sequences.md) | `GET /api/v1/campaigns/{campaign_id}/sequences` | Fits an existing surface |
| [Get Top Level Analytics by Date](campaigns/get-top-level-analytics.md) | `GET /api/v1/campaigns/{id}/top-level-analytics-by-date` | Fits an existing surface |
| [Get Webhook Summary](campaigns/get-webhook-summary.md) | `GET /api/v1/campaigns/{id}/webhooks/summary` | Fits an existing surface |
| [Get Campaign Webhooks](campaigns/get-webhooks.md) | `GET /api/v1/campaigns/{id}/webhooks` | Fits an existing surface |
| [Mark Lead as Complete](campaigns/mark-lead-complete.md) | `POST /api/v1/campaigns/{id}/leads/{id}/manual-complete` | Fits an existing surface |
| [Pause Campaign Lead](campaigns/pause-lead.md) | `POST /api/v1/campaigns/{id}/leads/{id}/pause` | Fits an existing surface |
| [Remove Email Accounts from Campaign](campaigns/remove-email-accounts.md) | `DELETE /api/v1/campaigns/{campaign_id}/email-accounts` | Fits an existing surface |
| [Reply to Campaign Lead](campaigns/reply-email-thread.md) | `POST /api/v1/campaigns/{id}/reply-email-thread` | Fits an existing surface |
| [Resume Campaign Lead](campaigns/resume-lead.md) | `POST /api/v1/campaigns/{id}/leads/{id}/resume` | Fits an existing surface |
| [Retrigger Campaign Webhooks](campaigns/retrigger-webhooks.md) | `POST /api/v1/campaigns/{id}/webhooks/retrigger-failed-events` | Fits an existing surface |
| [Create/Update Campaign Webhook](campaigns/save-webhooks.md) | `POST /api/v1/campaigns/{id}/webhooks` | Fits an existing surface |
| [Send Test Email](campaigns/send-test-email.md) | `POST /api/v1/campaigns/{id}/send-test-email` | Fits an existing surface |
| [Get Campaign Statistics](campaigns/statistics.md) | `GET /api/v1/campaigns/{campaign_id}/statistics` | Fits an existing surface |
| [Unsubscribe Lead from Campaign](campaigns/unsubscribe-lead.md) | `POST /api/v1/campaigns/{id}/leads/{id}/unsubscribe` | Fits an existing surface |
| [Update Lead Category in Campaign](campaigns/update-lead-category.md) | `POST /api/v1/campaigns/{id}/leads/{id}/category` | Fits an existing surface |
| [Update Lead Email Account](campaigns/update-lead-email-account.md) | `POST /api/v1/campaigns/update-lead-email-account` | Fits an existing surface |
| [Update Campaign Lead Details](campaigns/update-lead.md) | `POST /api/v1/campaigns/{id}/leads/{id}/` | Fits an existing surface |
| [Update Campaign Schedule](campaigns/update-schedule.md) | `POST /api/v1/campaigns/{id}/schedule` | Fits an existing surface |
| [Update Campaign Sequences](campaigns/update-sequences.md) | `POST /api/v1/campaigns/{campaign_id}/sequences` | Fits an existing surface |
| [Update Campaign Settings](campaigns/update-settings.md) | `POST /api/v1/campaigns/{campaign_id}/settings` | Fits an existing surface |
| [Update Campaign Status](campaigns/update-status.md) | `POST /api/v1/campaigns/{id}/status` | Fits an existing surface |
| [Update Campaign Team Member](campaigns/update-team-member.md) | `POST /api/v1/campaigns/{id}/team-member` | Fits an existing surface |

## clients

**Epic:** Agency client workspaces · 4 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Manage Client API Keys](clients/api-keys.md) | `POST /api/v1/client/api-key` | Fits an existing surface |
| [Create Client](clients/create.md) | `POST /api/v1/client/save` | New surface needed |
| [Get All Clients](clients/get-all.md) | `GET /api/v1/client/` | Fits an existing surface |
| [Update Client](clients/update.md) | `POST /api/v1/client/save` | Fits an existing surface |

## email-account-tags

**Epic:** Mailbox tagging and fleet segmentation · 5 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Assign Tags to Email Accounts](email-account-tags/assign.md) | `POST /api/v1/email-accounts/tag-mapping` | Fits an existing surface |
| [Create Tag](email-account-tags/create-new.md) | `POST /api/v1/tags` | Fits an existing surface |
| [Update Email Account Tag](email-account-tags/create.md) | `POST /api/v1/email-accounts/tag-manager` | Fits an existing surface |
| [Get Email Account Tags](email-account-tags/get-all.md) | `POST /api/v1/email-accounts/tag-list` | Fits an existing surface |
| [Remove Tags from Email Accounts](email-account-tags/remove.md) | `DELETE /api/v1/email-accounts/tag-mapping` | Fits an existing surface |

## email-accounts

**Epic:** Mailbox fleet management and sender health · 11 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Add OAuth Email Account](email-accounts/add-oauth.md) | `POST /api/v1/email-accounts/save-oauth` | Fits an existing surface |
| [Add SMTP Email Account](email-accounts/add-smtp.md) | `POST /api/v1/email-accounts/save` | Fits an existing surface |
| [Delete Email Account](email-accounts/delete.md) | `DELETE /api/v1/email-accounts/{id}` | Fits an existing surface |
| [Get All Email Accounts](email-accounts/get-all.md) | `GET /api/v1/email-accounts/` | Fits an existing surface |
| [Get Email Account by ID](email-accounts/get-by-id.md) | `GET /api/v1/email-accounts/{id}/` | Fits an existing surface |
| [Suspend Email Account](email-accounts/suspend.md) | `PUT /api/v1/email-accounts/suspend/{id}` | Fits an existing surface |
| [Get All Tags](email-accounts/tags.md) | `GET /api/v1/email-accounts/tags` | Invisible — no UI |
| [Unsuspend Email Account](email-accounts/unsuspend.md) | `DELETE /api/v1/email-accounts/unsuspend/{id}` | Fits an existing surface |
| [Update Email Account](email-accounts/update.md) | `POST /api/v1/email-accounts/{id}` | Fits an existing surface |
| [Update Warmup Settings](email-accounts/warmup-settings.md) | `POST /api/v1/email-accounts/{id}/warmup` | Fits an existing surface |
| [Get Warmup Statistics](email-accounts/warmup-stats.md) | `GET /api/v1/email-accounts/{id}/warmup-stats` | Fits an existing surface |

## inbox

**Epic:** Unified reply inbox and lead triage · 25 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Block Email Domains](inbox/block-domains.md) | `POST /api/v1/master-inbox/block-domains` | Fits an existing surface |
| [Create Lead Note](inbox/create-note.md) | `POST /api/v1/master-inbox/create-note` | Fits an existing surface |
| [Create Lead Task](inbox/create-task.md) | `POST /api/v1/master-inbox/create-task` | Fits an existing surface |
| [Forward Email](inbox/forward.md) | `POST /api/v1/campaigns/{id}/forward-email` | Fits an existing surface |
| [Get Archived Emails](inbox/get-archived.md) | `POST /api/v1/master-inbox/archived` | Fits an existing surface |
| [Get Assigned to Me](inbox/get-assigned.md) | `POST /api/v1/master-inbox/assigned-me` | Fits an existing surface |
| [Get Inbox Item by ID](inbox/get-by-id.md) | `GET /api/v1/master-inbox/{id}` | Fits an existing surface |
| [Get Important Emails](inbox/get-important.md) | `POST /api/v1/master-inbox/important` | Fits an existing surface |
| [Get Inbox Replies](inbox/get-messages.md) | `POST /api/v1/master-inbox/inbox-replies` | Fits an existing surface |
| [Get Reminder Emails](inbox/get-reminders.md) | `POST /api/v1/master-inbox/reminders` | Fits an existing surface |
| [Get Scheduled Emails](inbox/get-scheduled.md) | `POST /api/v1/master-inbox/scheduled` | Fits an existing surface |
| [Get Sent Emails](inbox/get-sent.md) | `POST /api/v1/master-inbox/sent` | Fits an existing surface |
| [Get Snoozed Emails](inbox/get-snoozed.md) | `POST /api/v1/master-inbox/snoozed` | Fits an existing surface |
| [Get Unread Replies](inbox/get-unread.md) | `POST /api/v1/master-inbox/unread-replies` | Fits an existing surface |
| [Get Untracked Replies](inbox/get-untracked.md) | `GET /api/v1/master-inbox/untracked-replies` | Fits an existing surface |
| [Get Custom View Emails](inbox/get-views.md) | `POST /api/v1/master-inbox/views` | Fits an existing surface |
| [Change Read Status](inbox/mark-read.md) | `PATCH /api/v1/master-inbox/change-read-status` | Fits an existing surface |
| [Push Lead to Subsequence](inbox/push-to-subsequence.md) | `POST /api/v1/master-inbox/push-to-subsequence` | Fits an existing surface |
| [Get Reply Status](inbox/reply-status.md) | `GET /api/v1/master-inbox/reply-status` | Fits an existing surface |
| [Reply to Email](inbox/reply.md) | `POST /api/v1/campaigns/{id}/reply-email-thread` | Fits an existing surface |
| [Resume Paused Lead](inbox/resume-lead.md) | `PATCH /api/v1/master-inbox/resume-lead` | Fits an existing surface |
| [Set Lead Reminder](inbox/set-reminder.md) | `POST /api/v1/master-inbox/set-reminder` | Fits an existing surface |
| [Update Lead Category](inbox/update-category.md) | `PATCH /api/v1/master-inbox/update-category` | Fits an existing surface |
| [Update Lead Revenue](inbox/update-revenue.md) | `PATCH /api/v1/master-inbox/update-revenue` | Fits an existing surface |
| [Assign Team Member](inbox/update-team-member.md) | `POST /api/v1/master-inbox/update-team-member` | Fits an existing surface |

## lead-lists

**Epic:** Reusable lead segments · 9 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Assign Tags to Lead Lists](lead-lists/assign-tags.md) | `POST /api/v1/lead-list/assign-tags` | Fits an existing surface |
| [Create Lead List](lead-lists/create.md) | `POST /api/v1/lead-list/` | Fits an existing surface |
| [Delete Lead List](lead-lists/delete.md) | `DELETE /api/v1/lead-list/{id}` | Fits an existing surface |
| [Get All Lead Lists](lead-lists/get-all.md) | `GET /api/v1/lead-list/` | Fits an existing surface |
| [Get Lead List by ID](lead-lists/get-by-id.md) | `GET /api/v1/lead-list/{id}` | Fits an existing surface |
| [Import Leads to List](lead-lists/import-leads.md) | `POST /api/v1/lead-list/{id}/import` | Fits an existing surface |
| [Move Leads Between Lists](lead-lists/push-between-lists.md) | `POST /api/v1/leads/leads/push-between-lists` | Fits an existing surface |
| [Push Leads to Campaign](lead-lists/push-to-campaign.md) | `POST /api/v1/leads/push-to-campaign` | Fits an existing surface |
| [Update Lead List](lead-lists/update.md) | `PUT /api/v1/lead-list/{id}` | Fits an existing surface |

## lead-notes

**Epic:** Shared context on a prospect · 2 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Create Lead Note](lead-notes/create.md) | `POST /api/v1/master-inbox/create-note` | New surface needed |
| [Get Lead Notes](lead-notes/get-all.md) | `GET /api/v1/crm/leads/notes/{id}` | Fits an existing surface |

## lead-tags

**Epic:** Lead labels across campaigns · 4 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Add Tags to Lead](lead-tags/add-to-lead.md) | `POST /api/v1/crm/leads/tags` | Fits an existing surface |
| [Create Tag](lead-tags/create.md) | `POST /api/v1/email-accounts/tag-manager` | Fits an existing surface |
| [Get Lead Tags](lead-tags/get-all.md) | `GET /api/v1/crm/leads/tags` | Fits an existing surface |
| [Remove Tag from Lead](lead-tags/remove-from-lead.md) | `DELETE /api/v1/crm/leads/tags/{id}` | Fits an existing surface |

## lead-tasks

**Epic:** Human follow-up work on a prospect · 2 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Create Lead Task](lead-tasks/create.md) | `POST /api/v1/master-inbox/create-task` | Fits an existing surface |
| [Get Lead Tasks](lead-tasks/get-all.md) | `GET /api/v1/crm/leads/tasks/{id}` | Fits an existing surface |

## leads

**Epic:** The prospect record and its lifecycle · 11 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Get All Leads Activities](leads/activities.md) | `GET /api/v1/campaigns/all-leads-activities` | Fits an existing surface |
| [Add Leads to Campaign](leads/add-to-campaign.md) | `POST /api/v1/campaigns/{id}/leads` | Fits an existing surface |
| [Get Lead Categories](leads/categories.md) | `GET /api/v1/leads/fetch-categories` | Fits an existing surface |
| [Delete Lead from Campaign](leads/delete.md) | `DELETE /api/v1/campaigns/{id}/leads/{id}` | Fits an existing surface |
| [Export Campaign Leads](leads/export.md) | `GET /api/v1/campaigns/{id}/leads-export` | Fits an existing surface |
| [Get Campaign Leads](leads/get-by-campaign.md) | `GET /api/v1/campaigns/{id}/leads` | Fits an existing surface |
| [Get Lead by Email](leads/get-by-email.md) | `GET /api/v1/leads/` | Fits an existing surface |
| [Pause Lead](leads/pause.md) | `POST /api/v1/campaigns/{id}/leads/{id}/pause` | Fits an existing surface |
| [Resume Lead](leads/resume.md) | `POST /api/v1/campaigns/{id}/leads/{id}/resume` | Fits an existing surface |
| [Unsubscribe Lead Globally](leads/unsubscribe.md) | `POST /api/v1/leads/{id}/unsubscribe` | Fits an existing surface |
| [Update Lead](leads/update.md) | `POST /api/v1/campaigns/{id}/leads/{id}` | Fits an existing surface |

## smart-delivery

**Epic:** Inbox placement and deliverability assurance · 28 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [IP Blacklist Check](smart-delivery/blacklists.md) | `GET /api/v1/spam-test/report/{spamTestId}/blacklist` | Fits an existing surface |
| [Create Automated Placement Test](smart-delivery/create-automated-test.md) | `POST /api/v1/spam-test/schedule` | Fits an existing surface |
| [Create Folder](smart-delivery/create-folder.md) | `POST /api/v1/spam-test/folder` | Fits an existing surface |
| [Create Manual Placement Test](smart-delivery/create-manual-test.md) | `POST /api/v1/spam-test/manual` | Fits an existing surface |
| [Delete Folder](smart-delivery/delete-folder.md) | `DELETE /api/v1/spam-test/folder/{folderId}` | Fits an existing surface |
| [Delete Tests in Bulk](smart-delivery/delete-tests-bulk.md) | `POST /api/v1/spam-test/delete` | Fits an existing surface |
| [DKIM Details](smart-delivery/dkim-details.md) | `GET /api/v1/spam-test/report/{spamTestId}/dkim-details` | Fits an existing surface |
| [Domain Blacklist](smart-delivery/domain-blacklist.md) | `GET /api/v1/spam-test/report/{spamTestId}/domain-blacklist` | Fits an existing surface |
| [Geo-wise Report](smart-delivery/geo-report.md) | `POST /api/v1/spam-test/report/{spamTestId}/groupwise` | Fits an existing surface |
| [Get Folder by ID](smart-delivery/get-folder-by-id.md) | `GET /api/v1/spam-test/folder/{folderId}` | Fits an existing surface |
| [Get All Folders](smart-delivery/get-folders.md) | `GET /api/v1/spam-test/folder` | Fits an existing surface |
| [IP Blacklist Count](smart-delivery/ip-blacklist-count.md) | `GET /api/v1/spam-test/report/{spamTestId}/blacklist` | Fits an existing surface |
| [IP Details](smart-delivery/ip-details.md) | `GET /api/v1/spam-test/report/{spamTestId}/ip-analytics` | Fits an existing surface |
| [List All Tests](smart-delivery/list-tests.md) | `POST /api/v1/spam-test/report` | Fits an existing surface |
| [Mailbox Count](smart-delivery/mailbox-count.md) | `GET /api/v1/spam-test/report/mailboxes-count` | Fits an existing surface |
| [Mailbox Summary](smart-delivery/mailbox-summary.md) | `GET /api/v1/spam-test/report/mailboxes-summary` | Fits an existing surface |
| [Get Provider IDs](smart-delivery/provider-ids.md) | `GET /api/v1/spam-test/seed/providers` | Invisible — no UI |
| [Provider-wise Report](smart-delivery/provider-report.md) | `POST /api/v1/spam-test/report/{spamTestId}/providerwise` | Fits an existing surface |
| [rDNS Report](smart-delivery/rdns-report.md) | `GET /api/v1/spam-test/report/{spamTestId}/rdns-details` | Fits an existing surface |
| [Email Reply Headers](smart-delivery/reply-headers.md) | `GET /api/v1/spam-test/report/{spamTestId}/sender-account-wise/{replyId}/email-headers` | Fits an existing surface |
| [Schedule History](smart-delivery/schedule-history.md) | `GET /api/v1/spam-test/report/{spamTestId}/schedule-history` | Fits an existing surface |
| [Sender Account List](smart-delivery/sender-list.md) | `GET /api/v1/spam-test/report/{spamTestId}/sender-accounts` | Fits an existing surface |
| [Sender Account Report](smart-delivery/sender-report.md) | `GET /api/v1/spam-test/report/{spamTestId}/sender-account-wise` | Fits an existing surface |
| [Spam Filter Report](smart-delivery/spam-filter-report.md) | `GET /api/v1/spam-test/report/{spamTestId}/spam-filter-details` | Fits an existing surface |
| [SPF Details](smart-delivery/spf-details.md) | `GET /api/v1/spam-test/report/{spamTestId}/spf-details` | Fits an existing surface |
| [Stop Automated Test](smart-delivery/stop-automated-test.md) | `PUT /api/v1/spam-test/{spamTestId}/stop` | Fits an existing surface |
| [Get Spam Test Details](smart-delivery/test-details.md) | `GET /api/v1/spam-test/{spamTestId}` | Fits an existing surface |
| [Test Email Content](smart-delivery/test-email-content.md) | `GET /api/v1/spam-test/report/{spamTestId}/email-content` | Fits an existing surface |

## smart-prospect

**Epic:** Prospect discovery and contact enrichment · 26 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Cities API](smart-prospect/cities.md) | `GET /api/v1/search-email-leads/cities` | Fits an existing surface |
| [Company API](smart-prospect/company.md) | `GET /api/v1/search-email-leads/company` | Fits an existing surface |
| [Countries API](smart-prospect/countries.md) | `GET /api/v1/search-email-leads/countries` | Fits an existing surface |
| [Departments API](smart-prospect/departments.md) | `GET /api/v1/search-email-leads/departments` | Fits an existing surface |
| [Domain API](smart-prospect/domain.md) | `GET /api/v1/search-email-leads/domain` | Fits an existing surface |
| [Fetch Contacts API](smart-prospect/fetch-contacts.md) | `POST /api/v1/search-email-leads/fetch-contacts` | Fits an existing surface |
| [Fetched Searches API](smart-prospect/fetched-searches.md) | `GET /api/v1/search-email-leads/search-filters/fetched-searches` | Fits an existing surface |
| [Find Emails API](smart-prospect/find-emails.md) | `POST /api/v1/search-email-leads/search-contacts/find-emails` | Fits an existing surface |
| [Get Contacts API](smart-prospect/get-contacts.md) | `POST /api/v1/search-email-leads/get-contacts` | Fits an existing surface |
| [Head Counts API](smart-prospect/head-counts.md) | `GET /api/v1/search-email-leads/head-counts` | Fits an existing surface |
| [Industries API](smart-prospect/industries.md) | `GET /api/v1/search-email-leads/industries` | Fits an existing surface |
| [Job Title API](smart-prospect/job-title.md) | `GET /api/v1/search-email-leads/job-title` | Fits an existing surface |
| [Keywords API](smart-prospect/keywords.md) | `GET /api/v1/search-email-leads/keywords` | Fits an existing surface |
| [Levels API](smart-prospect/levels.md) | `GET /api/v1/search-email-leads/levels` | Fits an existing surface |
| [Recent Searches API](smart-prospect/recent-searches.md) | `GET /api/v1/search-email-leads/search-filters/recent-searches` | Fits an existing surface |
| [Reply Analytics API](smart-prospect/reply-analytics.md) | `GET /api/v1/search-email-leads/reply-analytics` | Fits an existing surface |
| [Revenue API](smart-prospect/revenue.md) | `GET /api/v1/search-email-leads/revenue` | Fits an existing surface |
| [Review Contacts API](smart-prospect/review-contacts.md) | `PATCH /api/v1/search-email-leads/review-contacts/{filter_id}` | Fits an existing surface |
| [Save Search API](smart-prospect/save-search.md) | `POST /api/v1/search-email-leads/search-filters/save-search` | Fits an existing surface |
| [Saved Searches API](smart-prospect/saved-searches.md) | `GET /api/v1/search-email-leads/search-filters/saved-searches` | Fits an existing surface |
| [Search Analytics API](smart-prospect/search-analytics.md) | `GET /api/v1/search-email-leads/search-analytics` | Fits an existing surface |
| [Search Contacts API](smart-prospect/search-contacts.md) | `POST /api/v1/search-email-leads/search-contacts` | New surface needed |
| [States API](smart-prospect/states.md) | `GET /api/v1/search-email-leads/states` | Fits an existing surface |
| [Sub-Industries API](smart-prospect/sub-industries.md) | `GET /api/v1/search-email-leads/sub-industries` | Fits an existing surface |
| [Update Fetched Lead API](smart-prospect/update-fetched-lead.md) | `PUT /api/v1/search-email-leads/search-filters/fetched-searches/{id}` | Fits an existing surface |
| [Update Saved Search API](smart-prospect/update-saved-search.md) | `PUT /api/v1/search-email-leads/search-filters/save-search/{id}` | Fits an existing surface |

## smart-senders

**Epic:** Sending infrastructure procurement · 7 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Auto Generate Mailboxes](smart-senders/auto-generate.md) | `POST /api/v1/smart-senders/auto-generate-mailboxes` | Fits an existing surface |
| [Get Purchased Domain List](smart-senders/domain-list.md) | `GET /api/v1/smart-senders/get-domain-list` | Fits an existing surface |
| [Get OTP for Admin Mailbox](smart-senders/get-otp.md) | `GET /api/v1/smart-senders/auth-secret` | Fits an existing surface |
| [Get Vendors](smart-senders/get-vendors.md) | `GET /api/v1/smart-senders/get-vendors` | Fits an existing surface |
| [Get Order Details](smart-senders/order-details.md) | `GET /api/v1/smart-senders/order-details` | Fits an existing surface |
| [Place Order](smart-senders/place-order.md) | `POST /api/v1/smart-senders/place-order` | Fits an existing surface |
| [Search Domain](smart-senders/search-domain.md) | `GET /api/v1/smart-senders/search-domain` | Fits an existing surface |

## utilities

**Epic:** Sending controls outside the playbook · 2 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Domain Block List Management](utilities/domain-block-list.md) | `GET /api/v1/leads/get-domain-block-list` | Fits an existing surface |
| [Send Single Email](utilities/send-single-email.md) | `POST /api/v1/send-email/initiate` | Invisible — no UI |

## webhooks

**Epic:** Outbound event notifications · 4 endpoints

| Endpoint | Method and path | UI impact |
|---|---|---|
| [Create Webhook](webhooks/create.md) | `POST /api/v1/webhook/create` | Fits an existing surface |
| [Delete Campaign Webhook](webhooks/delete.md) | `DELETE /api/v1/webhook/delete` | Fits an existing surface |
| [Get Webhook](webhooks/get.md) | `GET /api/v1/webhook/{webhook_id}` | Fits an existing surface |
| [Update Webhook](webhooks/update.md) | `PUT /api/v1/webhook/update/{id}` | Fits an existing surface |
