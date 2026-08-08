# Requirements matrix

One row per endpoint spec in this folder. **Generated** — run `npm run matrix`
after changing the specs or the code. The `Status` and `Notes` columns are
yours: they are read back in and preserved on every regeneration, so write in
them freely.

The mechanical columns are derived, not typed:

- **Routes** — how many of the Harry routes the spec's §5 asks for are actually
  registered right now, out of how many it names. `0/0` means the spec names no
  `/api/…` route of its own (usually because it is served by a sibling
  endpoint's route, or the backlog marks it "Invisible — no UI").
A full `Routes` count means the endpoint is *reachable*. It does **not** mean
every acceptance criterion is met — that is what `Status` is for, and it is
deliberately `Not reviewed` until a human has read the spec against the code.

## Totals

| | |
|---|---|
| Endpoint specs (excludes `Research/`) | 210 |
| Acceptance criteria | 4,405 |
| Test cases | 2,342 |
| Harry routes named by specs | 261 |
| …of those, registered | 256 |
| Specs whose named routes are all live | 203 |
| Specs naming no route of their own | 2 |
| …of those routes, called from `web/src` | 252 |
| Specs whose routes are all called by a screen | 199 |
| **Specs with a live route no screen calls** | **5** |

## analytics

Backend `server/parity/analytics.js` · Surface **Reports** · 22 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Get Campaign List](./analytics/campaign-list.md) | `GET /api/v1/analytics/campaign/list` | Fits an existing surface | 1/1 | 1/1 | 19 | 10 | Not reviewed |  |
| [Campaign Performance](./analytics/campaign-performance.md) | `GET /api/v1/analytics/campaign/overall-stats` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Partial | 5/8 criteria; 1/4 DoD. |
| [Campaign Response Stats](./analytics/campaign-response-stats.md) | `GET /api/v1/analytics/campaign/response-stats` | Fits an existing surface | 1/1 | 1/1 | 19 | 10 | Not reviewed |  |
| [Campaign Status Stats](./analytics/campaign-status-stats.md) | `GET /api/v1/analytics/campaign/status-stats` | Fits an existing surface | 1/1 | 1/1 | 19 | 10 | Not reviewed |  |
| [Get Client List](./analytics/client-list.md) | `GET /api/v1/analytics/client/list` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Client Overall Stats](./analytics/client-performance.md) | `GET /api/v1/analytics/client/overall-stats` | Fits an existing surface | 1/1 | 1/1 | 19 | 11 | Fixed — reverify | client_health corrected to positive_replied/unique_lead_count (was the non-bounce share); old figure kept as non_bounce_rate. UI copy corrected to match. |
| [Day-wise Positive Reply Stats](./analytics/day-wise-positive-reply.md) | `GET /api/v1/analytics/day-wise-positive-reply-stats` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Not reviewed |  |
| [Positive Reply Stats by Sent Time](./analytics/day-wise-positive-sent-time.md) | `GET /api/v1/analytics/day-wise-positive-reply-stats-by-sent-time` | Fits an existing surface | 1/1 | 1/1 | 19 | 11 | Not reviewed |  |
| [Day-wise Stats by Sent Time](./analytics/day-wise-sent-time.md) | `GET /api/v1/analytics/day-wise-overall-stats-by-sent-time` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Get Day-wise Overall Stats](./analytics/day-wise-stats.md) | `GET /api/v1/analytics/day-wise-overall-stats` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Partial | 4/7 criteria. |
| [Domain-wise Health Metrics](./analytics/domain-wise-health.md) | `GET /api/v1/analytics/mailbox/domain-wise-health-metrics` | Fits an existing surface | 1/1 | 1/1 | 19 | 11 | Not reviewed |  |
| [Email-ID-wise Health Metrics](./analytics/email-wise-health.md) | `GET /api/v1/analytics/mailbox/name-wise-health-metrics` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Follow-up Reply Rate](./analytics/followup-reply-rate.md) | `GET /api/v1/analytics/campaign/follow-up-reply-rate` | Fits an existing surface | 1/1 | 1/1 | 19 | 11 | Partial | 5/7 criteria; 1/11 TC covered. |
| [Lead Category-wise Response](./analytics/lead-category-response.md) | `GET /api/v1/analytics/lead/category-wise-response` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Lead Statistics](./analytics/lead-stats.md) | `GET /api/v1/analytics/lead/overall-stats` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Lead to Reply Time](./analytics/lead-to-reply-time.md) | `GET /api/v1/analytics/campaign/lead-to-reply-time` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Near-complete | Only spec audited with all §5 DoD met (4/4); 5/7 criteria. |
| [Leads Take for First Reply](./analytics/leads-for-first-reply.md) | `GET /api/v1/analytics/campaign/leads-take-for-first-reply` | Fits an existing surface | 1/1 | 1/1 | 19 | 11 | Not reviewed |  |
| [Mailbox Overall Stats](./analytics/mailbox-health.md) | `GET /api/v1/analytics/mailbox/overall-stats` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Partial | unsubscribed/won/lost are structurally 0 on every mailbox-keyed surface — outcome rows are grouped by mailbox_id, which the query does not select. Also `remaining_today` is a ramp-blind copy of pacing.remainingToday. |
| [Get Month-wise Client Count](./analytics/month-wise-client-count.md) | `GET /api/v1/analytics/client/month-wise-count` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Get Overall Analytics](./analytics/overview.md) | `GET /api/v1/analytics/overall-stats-v2` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Partial | 5/8 criteria; 1/4 DoD. |
| [Provider-wise Performance](./analytics/provider-performance.md) | `GET /api/v1/analytics/mailbox/provider-wise-overall-performance` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Team Board Stats](./analytics/team-board-stats.md) | `GET /api/v1/analytics/team-board/overall-stats` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Partial | Backend fields added. **§4 placement still wrong** — DoD says it must NOT be on Reports; it is a Reports tab. Needs a frontend move to Settings → Team. |

## campaign-statistics

Backend `server/parity/analytics.js` · Surface **Reports** · 6 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Fetch Campaign Statistics by Date Range](./campaign-statistics/get-by-date-range.md) | `GET /api/v1/campaigns/{id}/analytics-by-date` | Fits an existing surface | 1/1 | 1/1 | 19 | 10 | Partial | 4/7 criteria. |
| [Fetch Campaign Statistics by Campaign ID](./campaign-statistics/get-by-id.md) | `GET /api/v1/campaigns/{id}/statistics` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Partial | campaign_id, unsubscribed, bounds and clamping added. 'write an events row' refused: analytics writes no events by design. |
| [Fetch Campaign Lead Statistics](./campaign-statistics/lead-statistics.md) | `GET /api/v1/campaigns/{id}/leads-statistics` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Partial | 4/7 criteria. |
| [Fetch Campaign Mailbox Statistics](./campaign-statistics/mailbox-statistics.md) | `GET /api/v1/campaigns/{id}/mailbox-statistics` | Fits an existing surface | 1/1 | 1/1 | 19 | 10 | Partial | 5/7 criteria. |
| [Fetch Campaign Top Level Analytics by Date Range](./campaign-statistics/top-level-by-date.md) | `GET /api/v1/campaigns/{id}/top-level-analytics-by-date` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Partial | 3/7 criteria. |
| [Fetch Campaign Top Level Analytics](./campaign-statistics/top-level.md) | `GET /api/v1/campaigns/{id}/analytics` | Fits an existing surface | 1/1 | 1/1 | 19 | 10 | Partial | 3/7 criteria. |

## campaigns

Backend `server/parity/campaigns.js` · Surface **Campaigns** · 42 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Add Email Accounts to Campaign](./campaigns/add-email-accounts.md) | `POST /api/v1/campaigns/{id}/email-accounts` | Fits an existing surface | 3/3 | 3/3 | 19 | 10 | Not reviewed |  |
| [Add Leads to Campaign](./campaigns/add-leads.md) | `POST /api/v1/campaigns/{id}/leads` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Partial | Field aliases, snake_case counts, telemetry added. 'Duplicate counts as skipped' deliberately reported as reusedExistingCount instead. |
| [Get All Leads Activities](./campaigns/all-leads-activities.md) | `GET /api/v1/campaigns/all-leads-activities` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Create Subsequence Campaign](./campaigns/create-subsequence.md) | `POST /api/v1/campaigns/create-subsequence` | Fits an existing surface | 3/3 | 3/3 | 21 | 11 | FAILS | 3/8 criteria; 1/4 DoD. |
| [Create Campaign](./campaigns/create.md) | `POST /api/v1/campaigns/create` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Delete Lead from Campaign](./campaigns/delete-lead.md) | `DELETE /api/v1/campaigns/{id}/leads/{id}` | Fits an existing surface | 1/1 | 1/1 | 22 | 11 | Not reviewed |  |
| [Delete Campaign Webhook](./campaigns/delete-webhook.md) | `DELETE /api/v1/campaigns/{id}/webhooks/{id}` | Fits an existing surface | 3/3 | 3/3 | 20 | 11 | Not reviewed |  |
| [Delete Campaign](./campaigns/delete.md) | `DELETE /api/v1/campaigns/{id}` | Fits an existing surface | 2/2 | 2/2 | 22 | 12 | Not reviewed |  |
| [Duplicate Campaign](./campaigns/duplicate.md) | `POST /api/v1/campaigns/{id}/duplicate` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Complete (backend) | Only spec audited with all §2 criteria met. Frontend weaker. |
| [Export Campaign Leads](./campaigns/export-leads.md) | `GET /api/v1/campaigns/{id}/leads-export` | Fits an existing surface | 1/1 | 1/1 | 22 | 11 | Partial | 6/8 criteria. |
| [Forward Campaign Email](./campaigns/forward-email.md) | `POST /api/v1/campaigns/{id}/forward-email` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Fixed — verified | The forward wrote send_status 'forwarded' while REAL_SEND excluded 'forward', so every forward inflated `sent` and halved the open/click denominators. One vocabulary now, plus a test that fails on any unclassified send_status literal. |
| [Get All Campaigns](./campaigns/get-all.md) | `GET /api/v1/campaigns/` | Fits an existing surface | 1/1 | 1/1 | 23 | 12 | Partial | 5/9 criteria. |
| [Get Campaign Analytics by Date Range](./campaigns/get-analytics-by-date.md) | `GET /api/v1/campaigns/{id}/analytics-by-date` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |
| [Get Campaign Analytics](./campaigns/get-analytics.md) | `GET /api/v1/campaigns/{id}/analytics` | Fits an existing surface | 1/1 | 1/1 | 22 | 11 | Fixed — verified | Both siblings now read server/metrics.js. /top-level-analytics was recomputing open and reply rates with swapped denominators — 33.3%/50% vs 50%/33.3% on the same campaign at the same instant. |
| [Get Campaign by ID](./campaigns/get-by-id.md) | `GET /api/v1/campaigns/{id}` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |
| [Get Campaign Email Accounts](./campaigns/get-email-accounts.md) | `GET /api/v1/campaigns/{campaign_id}/email-accounts` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |
| [Get Lead by ID](./campaigns/get-lead-by-id.md) | `GET /api/v1/leads/{id}` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |
| [Get Lead Message History](./campaigns/get-lead-history.md) | `GET /api/v1/campaigns/{id}/leads/{id}/message-history` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |
| [Get Bulk Lead Message History](./campaigns/get-leads-history-bulk.md) | `POST /api/v1/campaigns/{id}/message-history-for-leads/bbfbdsFGHlBr76ruhjvh6fhHL` | Invisible — no UI | 1/1 | 1/1 | 22 | 11 | Near-complete | 7/8 criteria. Null/absent/empty id lists refused. |
| [Get Campaign Leads](./campaigns/get-leads.md) | `GET /api/v1/campaigns/{id}/leads` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Fixed — reverify | One SQL statement with COUNT(*) OVER(); export streams via .iterate(). Was ~50,001 queries for page one. |
| [Get Campaign Sequences](./campaigns/get-sequences.md) | `GET /api/v1/campaigns/{campaign_id}/sequences` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Partial | 4/8 criteria. |
| [Get Top Level Analytics by Date](./campaigns/get-top-level-analytics.md) | `GET /api/v1/campaigns/{id}/top-level-analytics-by-date` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Get Webhook Summary](./campaigns/get-webhook-summary.md) | `GET /api/v1/campaigns/{id}/webhooks/summary` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Get Campaign Webhooks](./campaigns/get-webhooks.md) | `GET /api/v1/campaigns/{id}/webhooks` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Mark Lead as Complete](./campaigns/mark-lead-complete.md) | `POST /api/v1/campaigns/{id}/leads/{id}/manual-complete` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Pause Campaign Lead](./campaigns/pause-lead.md) | `POST /api/v1/campaigns/{id}/leads/{id}/pause` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Fixed — verified | **Pausing did not stop the engine** — engine.js selected on `state` alone and never read `paused_at`, so a paused lead kept receiving follow-ups. Now skipped, with `resume_at` letting a pause expire on its own. tests/engine-pause.test.js. |
| [Remove Email Accounts from Campaign](./campaigns/remove-email-accounts.md) | `DELETE /api/v1/campaigns/{campaign_id}/email-accounts` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Reply to Campaign Lead](./campaigns/reply-email-thread.md) | `POST /api/v1/campaigns/{id}/reply-email-thread` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | FAILS | 4/8 criteria. cc/bcc validated and echoed but not passed to sendEmail; no attachment or signature handling. |
| [Resume Campaign Lead](./campaigns/resume-lead.md) | `POST /api/v1/campaigns/{id}/leads/{id}/resume` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Fixed — verified | Clearing paused_at/resume_at returns the lead to the engine's selection. Covered by tests/engine-pause.test.js. |
| [Retrigger Campaign Webhooks](./campaigns/retrigger-webhooks.md) | `POST /api/v1/campaigns/{id}/webhooks/retrigger-failed-events` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Complete (backend) | 8/8 criteria, 4/4 DoD — the only spec audited so far that meets everything. |
| [Create/Update Campaign Webhook](./campaigns/save-webhooks.md) | `POST /api/v1/campaigns/{id}/webhooks` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Not reviewed |  |
| [Send Test Email](./campaigns/send-test-email.md) | `POST /api/v1/campaigns/{id}/send-test-email` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Fixed — verified | Test sends and forwards excluded at source via REAL_SEND in server/metrics.js. |
| [Get Campaign Statistics](./campaigns/statistics.md) | `GET /api/v1/campaigns/{campaign_id}/statistics` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Fixed — reverify | Documented parameter names, row fields and rollup implemented; email_status now filters on what happened, not send_status. |
| [Unsubscribe Lead from Campaign](./campaigns/unsubscribe-lead.md) | `POST /api/v1/campaigns/{id}/leads/{id}/unsubscribe` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Not reviewed |  |
| [Update Lead Category in Campaign](./campaigns/update-lead-category.md) | `POST /api/v1/campaigns/{id}/leads/{id}/category` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | FAILS | A human intent correction is reversed by the next tick — the route reports routedTo but never sets node_id, and leaves messages.intent empty so the engine reclassifies. The existing test is titled 'survives as human-set' and never ticks. |
| [Update Lead Email Account](./campaigns/update-lead-email-account.md) | `POST /api/v1/campaigns/update-lead-email-account` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | FAILS | Per-lead mailbox pins and the whole campaign_mailboxes pool have no reader in engine/mailer/gates/pacing — engine.js uses campaign.mailbox_id. Proven: pinned to mailbox 2, sent from mailbox 1. |
| [Update Campaign Lead Details](./campaigns/update-lead.md) | `POST /api/v1/campaigns/{id}/leads/{id}/` | Fits an existing surface | 2/2 | 2/2 | 21 | 12 | Not reviewed |  |
| [Update Campaign Schedule](./campaigns/update-schedule.md) | `POST /api/v1/campaigns/{id}/schedule` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |
| [Update Campaign Sequences](./campaigns/update-sequences.md) | `POST /api/v1/campaigns/{campaign_id}/sequences` | Fits an existing surface | 1/1 | 1/1 | 23 | 12 | Partial | preview mode, delay ceiling, remapping report, telemetry added. Thread-continuation criteria live in mailer/engine. |
| [Update Campaign Settings](./campaigns/update-settings.md) | `POST /api/v1/campaigns/{campaign_id}/settings` | Fits an existing surface | 1/1 | 1/1 | 23 | 14 | Fixed — verified | track_opens/track_clicks now reach the wire — buildHtmlBody takes flags and mailer passes the campaign's real values. Unsubscribe link deliberately not optional. |
| [Update Campaign Status](./campaigns/update-status.md) | `POST /api/v1/campaigns/{id}/status` | Fits an existing surface | 1/1 | 1/1 | 23 | 12 | Fixed — verified | STOPPED now terminal on BOTH routes; the legacy PUT /campaigns/:id 409s. Proven by a test driving the real router through a real session. |
| [Update Campaign Team Member](./campaigns/update-team-member.md) | `POST /api/v1/campaigns/{id}/team-member` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Not reviewed |  |

## clients

Backend `server/parity/clients.js` · Surface **Settings** · 4 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Manage Client API Keys](./clients/api-keys.md) | `POST /api/v1/client/api-key` | Fits an existing surface | 4/4 | 4/4 | 21 | 12 | Known gap — documented | Keys mint/hash/revoke correctly but authenticate nothing — resolveClientApiKey has no production caller. Declared in README. |
| [Create Client](./clients/create.md) | `POST /api/v1/client/save` | New surface needed | 1/1 | 1/1 | 20 | 11 | Known gap — documented | password rejection verified. Permissions and allowances are recorded but enforced nowhere. Declared in README. |
| [Get All Clients](./clients/get-all.md) | `GET /api/v1/client/` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Update Client](./clients/update.md) | `POST /api/v1/client/save` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |

## email-account-tags

Backend `server/parity/tags.js` · Surface **Mailboxes** · 5 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Assign Tags to Email Accounts](./email-account-tags/assign.md) | `POST /api/v1/email-accounts/tag-mapping` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |
| [Create Tag](./email-account-tags/create-new.md) | `POST /api/v1/tags` | Fits an existing surface | 2/2 | 2/2 | 22 | 12 | Not reviewed |  |
| [Update Email Account Tag](./email-account-tags/create.md) | `POST /api/v1/email-accounts/tag-manager` | Fits an existing surface | 2/2 | 2/2 | 21 | 13 | Not reviewed |  |
| [Get Email Account Tags](./email-account-tags/get-all.md) | `POST /api/v1/email-accounts/tag-list` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Remove Tags from Email Accounts](./email-account-tags/remove.md) | `DELETE /api/v1/email-accounts/tag-mapping` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |

## email-accounts

Backend `server/parity/mailboxes.js` · Surface **Mailboxes** · 11 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Add OAuth Email Account](./email-accounts/add-oauth.md) | `POST /api/v1/email-accounts/save-oauth` | Fits an existing surface | 0/0 | 0/0 | 19 | 10 | Not reviewed |  |
| [Add SMTP Email Account](./email-accounts/add-smtp.md) | `POST /api/v1/email-accounts/save` | Fits an existing surface | 2/2 | 2/2 | 20 | 11 | Known gap — documented | Validated 501 stub; credentials discarded, never stored. Now declared in README under 'Known gaps' rather than left as an undocumented surprise. |
| [Delete Email Account](./email-accounts/delete.md) | `DELETE /api/v1/email-accounts/{id}` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Get All Email Accounts](./email-accounts/get-all.md) | `GET /api/v1/email-accounts/` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Not reviewed |  |
| [Get Email Account by ID](./email-accounts/get-by-id.md) | `GET /api/v1/email-accounts/{id}/` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Suspend Email Account](./email-accounts/suspend.md) | `PUT /api/v1/email-accounts/suspend/{id}` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Get All Tags](./email-accounts/tags.md) | `GET /api/v1/email-accounts/tags` | Invisible — no UI | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Unsuspend Email Account](./email-accounts/unsuspend.md) | `DELETE /api/v1/email-accounts/unsuspend/{id}` | Fits an existing surface | 1/1 | 1/1 | 20 | 12 | Not reviewed |  |
| [Update Email Account](./email-accounts/update.md) | `POST /api/v1/email-accounts/{id}` | Fits an existing surface | 1/1 | 1/1 | 22 | 13 | Not reviewed |  |
| [Update Warmup Settings](./email-accounts/warmup-settings.md) | `POST /api/v1/email-accounts/{id}/warmup` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Not reviewed |  |
| [Get Warmup Statistics](./email-accounts/warmup-stats.md) | `GET /api/v1/email-accounts/{id}/warmup-stats` | Fits an existing surface | 1/1 | 1/1 | 20 | 12 | Fixed — verified | warmup_stats now has a production writer (upkeep rollup, upserted, workspace timezone). `guidance.healthy` is null with `verdict: 'not_enough_data'` when there is no evidence, instead of asserting `true` from zero rows. |

## inbox

Backend `server/parity/inbox.js` · Surface **Inbox** · 25 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Block Email Domains](./inbox/block-domains.md) | `POST /api/v1/master-inbox/block-domains` | Fits an existing surface | 3/3 | 3/3 | 20 | 11 | Fixed — verified | Both block routes now call applySuppression() — enrolments stopped, drafts declined, queued sends cancelled, identically. Draft approval and approve-all also refuse suppressed recipients. |
| [Create Lead Note](./inbox/create-note.md) | `POST /api/v1/master-inbox/create-note` | Fits an existing surface | 3/3 | 3/3 | 21 | 10 | Not reviewed |  |
| [Create Lead Task](./inbox/create-task.md) | `POST /api/v1/master-inbox/create-task` | Fits an existing surface | 3/4 | 4/4 | 21 | 11 | Divergent | Spec names `DELETE /api/tasks/:id`; implemented as `PATCH` to `status:'cancelled'` so the trail survives. **Unreviewed: is a hard delete actually wanted?** |
| [Forward Email](./inbox/forward.md) | `POST /api/v1/campaigns/{id}/forward-email` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Fixed — verified | Suppression enforced in gmailSend, the real transport chokepoint; BCC recipients now actually sent. Covered by tests/suppression-chokepoint.test.js. |
| [Get Archived Emails](./inbox/get-archived.md) | `POST /api/v1/master-inbox/archived` | Fits an existing surface | 2/2 | 2/2 | 21 | 11 | Not reviewed |  |
| [Get Assigned to Me](./inbox/get-assigned.md) | `POST /api/v1/master-inbox/assigned-me` | Fits an existing surface | 0/0 | 0/0 | 21 | 11 | Not reviewed |  |
| [Get Inbox Item by ID](./inbox/get-by-id.md) | `GET /api/v1/master-inbox/{id}` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Get Important Emails](./inbox/get-important.md) | `POST /api/v1/master-inbox/important` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | FAILS | importance_score / importance_reasons exist nowhere in the codebase; 3 of 4 DoD items unimplementable as specified. |
| [Get Inbox Replies](./inbox/get-messages.md) | `POST /api/v1/master-inbox/inbox-replies` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Fixed — verified | Reply-time filters compared SQLite's 'YYYY-MM-DD HH:MM:SS' against an ISO string; now datetime()-normalised on both sides. |
| [Get Reminder Emails](./inbox/get-reminders.md) | `POST /api/v1/master-inbox/reminders` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Not reviewed |  |
| [Get Scheduled Emails](./inbox/get-scheduled.md) | `POST /api/v1/master-inbox/scheduled` | Fits an existing surface | 2/2 | 2/2 | 21 | 12 | Not reviewed |  |
| [Get Sent Emails](./inbox/get-sent.md) | `POST /api/v1/master-inbox/sent` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |
| [Get Snoozed Emails](./inbox/get-snoozed.md) | `POST /api/v1/master-inbox/snoozed` | Fits an existing surface | 2/2 | 2/2 | 21 | 12 | Not reviewed |  |
| [Get Unread Replies](./inbox/get-unread.md) | `POST /api/v1/master-inbox/unread-replies` | Fits an existing surface | 3/3 | 3/3 | 21 | 12 | Not reviewed |  |
| [Get Untracked Replies](./inbox/get-untracked.md) | `GET /api/v1/master-inbox/untracked-replies` | Fits an existing surface | 3/3 | 3/3 | 21 | 12 | Not reviewed |  |
| [Get Custom View Emails](./inbox/get-views.md) | `POST /api/v1/master-inbox/views` | Fits an existing surface | 5/5 | 5/5 | 21 | 12 | Not reviewed |  |
| [Change Read Status](./inbox/mark-read.md) | `PATCH /api/v1/master-inbox/change-read-status` | Fits an existing surface | 2/2 | 2/2 | 21 | 12 | Partial | Bulk is all-or-nothing and every result row is hardcoded ok:true; the spec's TC-9 documents partial success and the existing test asserts the opposite. |
| [Push Lead to Subsequence](./inbox/push-to-subsequence.md) | `POST /api/v1/master-inbox/push-to-subsequence` | Fits an existing surface | 1/1 | 0/1 | 21 | 13 | Not reviewed |  |
| [Get Reply Status](./inbox/reply-status.md) | `GET /api/v1/master-inbox/reply-status` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Not reviewed |  |
| [Reply to Email](./inbox/reply.md) | `POST /api/v1/campaigns/{id}/reply-email-thread` | Fits an existing surface | 1/1 | 1/1 | 21 | 13 | Partial | The HTTP 500 on a bounced lead is fixed — one suppressionFor() check covers block list, unsubscribe and bounce, refused as a 422. Still missing: CC/BCC, attachments, signature toggle. |
| [Resume Paused Lead](./inbox/resume-lead.md) | `PATCH /api/v1/master-inbox/resume-lead` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Not reviewed |  |
| [Set Lead Reminder](./inbox/set-reminder.md) | `POST /api/v1/master-inbox/set-reminder` | Fits an existing surface | 4/4 | 4/4 | 21 | 12 | Not reviewed |  |
| [Update Lead Category](./inbox/update-category.md) | `PATCH /api/v1/master-inbox/update-category` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Not reviewed |  |
| [Update Lead Revenue](./inbox/update-revenue.md) | `PATCH /api/v1/master-inbox/update-revenue` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Not reviewed |  |
| [Assign Team Member](./inbox/update-team-member.md) | `POST /api/v1/master-inbox/update-team-member` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Not reviewed |  |

## lead-lists

Backend `server/parity/lists.js` · Surface **Leads** · 9 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Assign Tags to Lead Lists](./lead-lists/assign-tags.md) | `POST /api/v1/lead-list/assign-tags` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Create Lead List](./lead-lists/create.md) | `POST /api/v1/lead-list/` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Delete Lead List](./lead-lists/delete.md) | `DELETE /api/v1/lead-list/{id}` | Fits an existing surface | 1/1 | 1/1 | 21 | 10 | Not reviewed |  |
| [Get All Lead Lists](./lead-lists/get-all.md) | `GET /api/v1/lead-list/` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Get Lead List by ID](./lead-lists/get-by-id.md) | `GET /api/v1/lead-list/{id}` | Fits an existing surface | 1/1 | 1/1 | 19 | 10 | Not reviewed |  |
| [Import Leads to List](./lead-lists/import-leads.md) | `POST /api/v1/lead-list/{id}/import` | Fits an existing surface | 1/1 | 1/1 | 23 | 12 | Not reviewed |  |
| [Move Leads Between Lists](./lead-lists/push-between-lists.md) | `POST /api/v1/leads/leads/push-between-lists` | Fits an existing surface | 1/1 | 1/1 | 22 | 13 | Not reviewed |  |
| [Push Leads to Campaign](./lead-lists/push-to-campaign.md) | `POST /api/v1/leads/push-to-campaign` | Fits an existing surface | 1/1 | 0/1 | 23 | 13 | Not reviewed |  |
| [Update Lead List](./lead-lists/update.md) | `PUT /api/v1/lead-list/{id}` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |

## lead-notes

Backend `server/parity/notes.js` · Surface **Leads** · 2 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Create Lead Note](./lead-notes/create.md) | `POST /api/v1/master-inbox/create-note` | New surface needed | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Get Lead Notes](./lead-notes/get-all.md) | `GET /api/v1/crm/leads/notes/{id}` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |

## lead-tags

Backend `server/parity/tags.js` · Surface **Leads** · 4 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Add Tags to Lead](./lead-tags/add-to-lead.md) | `POST /api/v1/crm/leads/tags` | Fits an existing surface | 2/2 | 2/2 | 21 | 11 | Not reviewed |  |
| [Create Tag](./lead-tags/create.md) | `POST /api/v1/email-accounts/tag-manager` | Fits an existing surface | 2/2 | 2/2 | 22 | 11 | Not reviewed |  |
| [Get Lead Tags](./lead-tags/get-all.md) | `GET /api/v1/crm/leads/tags` | Fits an existing surface | 2/2 | 2/2 | 21 | 11 | Not reviewed |  |
| [Remove Tag from Lead](./lead-tags/remove-from-lead.md) | `DELETE /api/v1/crm/leads/tags/{id}` | Fits an existing surface | 1/2 | 2/2 | 21 | 11 | Divergent | `DELETE /api/leads/tags` would be shadowed by routes.js's `DELETE /leads/:id`; moved to `/api/leads/tags/bulk`. Deliberate, commented at the route. |

## lead-tasks

Backend `server/parity/notes.js` · Surface **Leads / Dashboard** · 2 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Create Lead Task](./lead-tasks/create.md) | `POST /api/v1/master-inbox/create-task` | Fits an existing surface | 1/1 | 1/1 | 20 | 12 | Not reviewed |  |
| [Get Lead Tasks](./lead-tasks/get-all.md) | `GET /api/v1/crm/leads/tasks/{id}` | Fits an existing surface | 2/2 | 2/2 | 21 | 11 | Not reviewed |  |

## leads

Backend `server/parity/leads.js` · Surface **Leads** · 11 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Get All Leads Activities](./leads/activities.md) | `GET /api/v1/campaigns/all-leads-activities` | Fits an existing surface | 2/2 | 1/2 | 20 | 10 | Not reviewed |  |
| [Add Leads to Campaign](./leads/add-to-campaign.md) | `POST /api/v1/campaigns/{id}/leads` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Get Lead Categories](./leads/categories.md) | `GET /api/v1/leads/fetch-categories` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Delete Lead from Campaign](./leads/delete.md) | `DELETE /api/v1/campaigns/{id}/leads/{id}` | Fits an existing surface | 2/2 | 2/2 | 20 | 11 | Not reviewed |  |
| [Export Campaign Leads](./leads/export.md) | `GET /api/v1/campaigns/{id}/leads-export` | Fits an existing surface | 1/2 | 1/2 | 21 | 11 | Divergent | Registered as `GET /api/campaigns/:id/leads/export` (campaigns module owns it). Same capability, different path. |
| [Get Campaign Leads](./leads/get-by-campaign.md) | `GET /api/v1/campaigns/{id}/leads` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Get Lead by Email](./leads/get-by-email.md) | `GET /api/v1/leads/` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Pause Lead](./leads/pause.md) | `POST /api/v1/campaigns/{id}/leads/{id}/pause` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Not reviewed |  |
| [Resume Lead](./leads/resume.md) | `POST /api/v1/campaigns/{id}/leads/{id}/resume` | Fits an existing surface | 1/1 | 1/1 | 20 | 12 | Not reviewed |  |
| [Unsubscribe Lead Globally](./leads/unsubscribe.md) | `POST /api/v1/leads/{id}/unsubscribe` | Fits an existing surface | 1/1 | 1/1 | 21 | 12 | Partial | Transport-level suppression and the unified predicate are in. Still open: the footer unsubscribe (tracking.js) writes leads.status only — no unsubscribed_at, so Reports counts 0 — and leaves the draft pending. Four unsubscribe writers, three sets of consequences. |
| [Update Lead](./leads/update.md) | `POST /api/v1/campaigns/{id}/leads/{id}` | Fits an existing surface | 1/2 | 2/2 | 21 | 12 | Divergent | Spec names `POST /api/leads/:id`; implemented as `PATCH` — partial update, and `POST /leads` already creates. |

## smart-delivery

Backend `server/parity/deliverability.js` · Surface **Monitoring** · 28 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [IP Blacklist Check](./smart-delivery/blacklists.md) | `GET /api/v1/spam-test/report/{spamTestId}/blacklist` | Fits an existing surface | 1/1 | 1/1 | 19 | 10 | Not reviewed |  |
| [Create Automated Placement Test](./smart-delivery/create-automated-test.md) | `POST /api/v1/spam-test/schedule` | Fits an existing surface | 1/1 | 1/1 | 21 | 10 | Fixed — verified | Runs open on schedule with a claiming UPDATE; due-ness measured from the last run so downtime is caught up once, not replayed per tick. |
| [Create Folder](./smart-delivery/create-folder.md) | `POST /api/v1/spam-test/folder` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Create Manual Placement Test](./smart-delivery/create-manual-test.md) | `POST /api/v1/spam-test/manual` | Fits an existing surface | 1/1 | 1/1 | 21 | 10 | Fixed — verified | Seed sends actually happen, through mailer.sendEmail so suppression/quota/pacing apply. Marked `test` so they move no campaign figure. With no seeds it reports `seedsQueued: 0, awaitingSeeds: true` rather than promising work it will not do. |
| [Delete Folder](./smart-delivery/delete-folder.md) | `DELETE /api/v1/spam-test/folder/{folderId}` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Delete Tests in Bulk](./smart-delivery/delete-tests-bulk.md) | `POST /api/v1/spam-test/delete` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [DKIM Details](./smart-delivery/dkim-details.md) | `GET /api/v1/spam-test/report/{spamTestId}/dkim-details` | Fits an existing surface | 1/1 | 0/1 | 20 | 10 | Not reviewed |  |
| [Domain Blacklist](./smart-delivery/domain-blacklist.md) | `GET /api/v1/spam-test/report/{spamTestId}/domain-blacklist` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Geo-wise Report](./smart-delivery/geo-report.md) | `POST /api/v1/spam-test/report/{spamTestId}/groupwise` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Get Folder by ID](./smart-delivery/get-folder-by-id.md) | `GET /api/v1/spam-test/folder/{folderId}` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Get All Folders](./smart-delivery/get-folders.md) | `GET /api/v1/spam-test/folder` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [IP Blacklist Count](./smart-delivery/ip-blacklist-count.md) | `GET /api/v1/spam-test/report/{spamTestId}/blacklist` | Fits an existing surface | 2/2 | 1/2 | 20 | 10 | Not reviewed |  |
| [IP Details](./smart-delivery/ip-details.md) | `GET /api/v1/spam-test/report/{spamTestId}/ip-analytics` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [List All Tests](./smart-delivery/list-tests.md) | `POST /api/v1/spam-test/report` | Fits an existing surface | 1/1 | 1/1 | 22 | 10 | Not reviewed |  |
| [Mailbox Count](./smart-delivery/mailbox-count.md) | `GET /api/v1/spam-test/report/mailboxes-count` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Mailbox Summary](./smart-delivery/mailbox-summary.md) | `GET /api/v1/spam-test/report/mailboxes-summary` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Get Provider IDs](./smart-delivery/provider-ids.md) | `GET /api/v1/spam-test/seed/providers` | Invisible — no UI | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Provider-wise Report](./smart-delivery/provider-report.md) | `POST /api/v1/spam-test/report/{spamTestId}/providerwise` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [rDNS Report](./smart-delivery/rdns-report.md) | `GET /api/v1/spam-test/report/{spamTestId}/rdns-details` | Fits an existing surface | 1/1 | 0/1 | 20 | 10 | Not reviewed |  |
| [Email Reply Headers](./smart-delivery/reply-headers.md) | `GET /api/v1/spam-test/report/{spamTestId}/sender-account-wise/{replyId}/email-headers` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Schedule History](./smart-delivery/schedule-history.md) | `GET /api/v1/spam-test/report/{spamTestId}/schedule-history` | Fits an existing surface | 1/1 | 1/1 | 21 | 10 | Not reviewed |  |
| [Sender Account List](./smart-delivery/sender-list.md) | `GET /api/v1/spam-test/report/{spamTestId}/sender-accounts` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Sender Account Report](./smart-delivery/sender-report.md) | `GET /api/v1/spam-test/report/{spamTestId}/sender-account-wise` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Spam Filter Report](./smart-delivery/spam-filter-report.md) | `GET /api/v1/spam-test/report/{spamTestId}/spam-filter-details` | Fits an existing surface | 1/1 | 1/1 | 21 | 10 | Not reviewed |  |
| [SPF Details](./smart-delivery/spf-details.md) | `GET /api/v1/spam-test/report/{spamTestId}/spf-details` | Fits an existing surface | 2/2 | 1/2 | 20 | 10 | Not reviewed |  |
| [Stop Automated Test](./smart-delivery/stop-automated-test.md) | `PUT /api/v1/spam-test/{spamTestId}/stop` | Fits an existing surface | 1/1 | 1/1 | 21 | 10 | Partial | Still no `type` guard — a one-off manual test can be 'stopped'. |
| [Get Spam Test Details](./smart-delivery/test-details.md) | `GET /api/v1/spam-test/{spamTestId}` | Fits an existing surface | 1/1 | 1/1 | 21 | 10 | Not reviewed |  |
| [Test Email Content](./smart-delivery/test-email-content.md) | `GET /api/v1/spam-test/report/{spamTestId}/email-content` | Fits an existing surface | 1/1 | 1/1 | 22 | 10 | Not reviewed |  |

## smart-prospect

Backend `server/parity/prospects.js` · Surface **Leads → Find prospects** · 26 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Cities API](./smart-prospect/cities.md) | `GET /api/v1/search-email-leads/cities` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Company API](./smart-prospect/company.md) | `GET /api/v1/search-email-leads/company` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Countries API](./smart-prospect/countries.md) | `GET /api/v1/search-email-leads/countries` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Departments API](./smart-prospect/departments.md) | `GET /api/v1/search-email-leads/departments` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Domain API](./smart-prospect/domain.md) | `GET /api/v1/search-email-leads/domain` | Fits an existing surface | 2/2 | 2/2 | 20 | 10 | Not reviewed |  |
| [Fetch Contacts API](./smart-prospect/fetch-contacts.md) | `POST /api/v1/search-email-leads/fetch-contacts` | Fits an existing surface | 1/1 | 1/1 | 24 | 12 | Verified | Credit failure handled as HTTP 200 + `success:false`, stored as `insufficient_credits`. Covered by tests. |
| [Fetched Searches API](./smart-prospect/fetched-searches.md) | `GET /api/v1/search-email-leads/search-filters/fetched-searches` | Fits an existing surface | 1/1 | 1/1 | 22 | 11 | Not reviewed |  |
| [Find Emails API](./smart-prospect/find-emails.md) | `POST /api/v1/search-email-leads/search-contacts/find-emails` | Fits an existing surface | 2/2 | 2/2 | 25 | 12 | Not reviewed |  |
| [Get Contacts API](./smart-prospect/get-contacts.md) | `POST /api/v1/search-email-leads/get-contacts` | Fits an existing surface | 1/1 | 1/1 | 23 | 13 | Not reviewed |  |
| [Head Counts API](./smart-prospect/head-counts.md) | `GET /api/v1/search-email-leads/head-counts` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Industries API](./smart-prospect/industries.md) | `GET /api/v1/search-email-leads/industries` | Fits an existing surface | 1/1 | 1/1 | 23 | 12 | Not reviewed |  |
| [Job Title API](./smart-prospect/job-title.md) | `GET /api/v1/search-email-leads/job-title` | Fits an existing surface | 2/2 | 2/2 | 22 | 11 | Not reviewed |  |
| [Keywords API](./smart-prospect/keywords.md) | `GET /api/v1/search-email-leads/keywords` | Fits an existing surface | 2/2 | 2/2 | 23 | 11 | Not reviewed |  |
| [Levels API](./smart-prospect/levels.md) | `GET /api/v1/search-email-leads/levels` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Not reviewed |  |
| [Recent Searches API](./smart-prospect/recent-searches.md) | `GET /api/v1/search-email-leads/search-filters/recent-searches` | Fits an existing surface | 1/1 | 1/1 | 23 | 12 | Not reviewed |  |
| [Reply Analytics API](./smart-prospect/reply-analytics.md) | `GET /api/v1/search-email-leads/reply-analytics` | Fits an existing surface | 1/1 | 1/1 | 22 | 11 | Not reviewed |  |
| [Revenue API](./smart-prospect/revenue.md) | `GET /api/v1/search-email-leads/revenue` | Fits an existing surface | 1/1 | 1/1 | 23 | 11 | Not reviewed |  |
| [Review Contacts API](./smart-prospect/review-contacts.md) | `PATCH /api/v1/search-email-leads/review-contacts/{filter_id}` | Fits an existing surface | 1/1 | 1/1 | 26 | 12 | Not reviewed |  |
| [Save Search API](./smart-prospect/save-search.md) | `POST /api/v1/search-email-leads/search-filters/save-search` | Fits an existing surface | 1/1 | 1/1 | 27 | 13 | Not reviewed |  |
| [Saved Searches API](./smart-prospect/saved-searches.md) | `GET /api/v1/search-email-leads/search-filters/saved-searches` | Fits an existing surface | 1/1 | 1/1 | 23 | 12 | Not reviewed |  |
| [Search Analytics API](./smart-prospect/search-analytics.md) | `GET /api/v1/search-email-leads/search-analytics` | Fits an existing surface | 1/1 | 1/1 | 26 | 13 | Not reviewed |  |
| [Search Contacts API](./smart-prospect/search-contacts.md) | `POST /api/v1/search-email-leads/search-contacts` | New surface needed | 1/1 | 1/1 | 30 | 15 | Not reviewed |  |
| [States API](./smart-prospect/states.md) | `GET /api/v1/search-email-leads/states` | Fits an existing surface | 1/1 | 1/1 | 23 | 13 | Not reviewed |  |
| [Sub-Industries API](./smart-prospect/sub-industries.md) | `GET /api/v1/search-email-leads/sub-industries` | Fits an existing surface | 1/1 | 1/1 | 24 | 12 | Not reviewed |  |
| [Update Fetched Lead API](./smart-prospect/update-fetched-lead.md) | `PUT /api/v1/search-email-leads/search-filters/fetched-searches/{id}` | Fits an existing surface | 1/1 | 1/1 | 24 | 12 | Not reviewed |  |
| [Update Saved Search API](./smart-prospect/update-saved-search.md) | `PUT /api/v1/search-email-leads/search-filters/save-search/{id}` | Fits an existing surface | 1/1 | 1/1 | 25 | 13 | Not reviewed |  |

## smart-senders

Backend `server/parity/senders.js` · Surface **Mailboxes** · 7 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Auto Generate Mailboxes](./smart-senders/auto-generate.md) | `POST /api/v1/smart-senders/auto-generate-mailboxes` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Get Purchased Domain List](./smart-senders/domain-list.md) | `GET /api/v1/smart-senders/get-domain-list` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Get OTP for Admin Mailbox](./smart-senders/get-otp.md) | `GET /api/v1/smart-senders/auth-secret` | Fits an existing surface | 1/1 | 1/1 | 22 | 11 | Not reviewed |  |
| [Get Vendors](./smart-senders/get-vendors.md) | `GET /api/v1/smart-senders/get-vendors` | Fits an existing surface | 1/1 | 1/1 | 20 | 10 | Not reviewed |  |
| [Get Order Details](./smart-senders/order-details.md) | `GET /api/v1/smart-senders/order-details` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Not reviewed |  |
| [Place Order](./smart-senders/place-order.md) | `POST /api/v1/smart-senders/place-order` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Partial | Idempotency is DB-enforced and real. Payment guard misses common spellings (credit_card, paypal_email) — nothing leaks, but the stated invariant is false. |
| [Search Domain](./smart-senders/search-domain.md) | `GET /api/v1/smart-senders/search-domain` | Fits an existing surface | 1/1 | 1/1 | 21 | 10 | Not reviewed |  |

## utilities

Backend `server/parity/utilities.js` · Surface **Settings** · 2 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Domain Block List Management](./utilities/domain-block-list.md) | `GET /api/v1/leads/get-domain-block-list` | Fits an existing surface | 3/3 | 3/3 | 22 | 12 | Not reviewed |  |
| [Send Single Email](./utilities/send-single-email.md) | `POST /api/v1/send-email/initiate` | Invisible — no UI | 0/1 | 0/1 | 22 | 12 | Deliberately not shipped | `POST /api/send/one-off` is the compose-screen backdoor Docs/README forbids. Exported as `sendSingleEmail()` for internal callers instead; parks a draft when approvals are on. |

## webhooks

Backend `server/parity/webhooks.js` · Surface **Settings** · 4 endpoints

| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| [Create Webhook](./webhooks/create.md) | `POST /api/v1/webhook/create` | Fits an existing surface | 1/1 | 1/1 | 23 | 12 | Known gap — documented | Delivery, HMAC, SSRF re-check and auto-pause are solid; payloads carry envelope metadata only, not the documented per-event fields. Declared in README. |
| [Delete Campaign Webhook](./webhooks/delete.md) | `DELETE /api/v1/webhook/delete` | Fits an existing surface | 1/1 | 1/1 | 21 | 11 | Not reviewed |  |
| [Get Webhook](./webhooks/get.md) | `GET /api/v1/webhook/{webhook_id}` | Fits an existing surface | 1/1 | 1/1 | 20 | 11 | Not reviewed |  |
| [Update Webhook](./webhooks/update.md) | `PUT /api/v1/webhook/update/{id}` | Fits an existing surface | 1/1 | 1/1 | 22 | 12 | Not reviewed |  |

---

Regenerate with `npm run matrix`. Route data comes from the live Express
router, so a route that stops being registered shows up here as a dropped count
rather than as prose that quietly went out of date.
