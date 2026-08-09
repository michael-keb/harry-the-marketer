// Schema for the SmartLead-parity backlog (Docs/README.md — 210 endpoints).
//
// Every table here is workspace-scoped by `workspace_id`, which holds the same
// value the rest of the codebase calls `user_id`: the id of the workspace owner
// resolved by `resolveWorkspace`. The older tables predate the distinction and
// still say `user_id`; new tables say what they mean.
//
// Imported for its side effects by server/db.js, after the core schema exists,
// so foreign keys into users/leads/campaigns/mailboxes resolve.

export function applyParitySchema(db) {
  db.exec(`
-- ---------------------------------------------------------------- tags -----
-- One table for every kind of label, keyed (workspace, applies_to, name),
-- rather than SmartLead's separate silently-upserting tag managers. A lead
-- label and a mailbox label may share a name without colliding.
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applies_to TEXT NOT NULL CHECK (applies_to IN ('lead','mailbox','lead_list')),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, applies_to, name)
);

CREATE TABLE IF NOT EXISTS lead_tags (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lead_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_tags_tag ON lead_tags(tag_id);

CREATE TABLE IF NOT EXISTS mailbox_tag_map (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mailbox_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_tags_tag ON mailbox_tag_map(tag_id);

-- ------------------------------------------------- notes, tasks, reminders --
-- Harry had nowhere for a human to write context: the research profile is the
-- agent's and the activity trail is a log. These three are that place.
CREATE TABLE IF NOT EXISTS lead_notes (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  author_email TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id, id);

CREATE TABLE IF NOT EXISTS lead_tasks (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  due_at TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  assigned_email TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  completed_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_tasks_open ON lead_tasks(workspace_id, status, due_at);

CREATE TABLE IF NOT EXISTS lead_reminders (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL DEFAULT '',
  reminder_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','cleared')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_reminders_due ON lead_reminders(workspace_id, status, reminder_at);

-- --------------------------------------------------------- lead segments ----
CREATE TABLE IF NOT EXISTS lead_lists (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_lead_lists_ws ON lead_lists(workspace_id, deleted_at);

CREATE TABLE IF NOT EXISTS lead_list_leads (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (list_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_list_leads_lead ON lead_list_leads(lead_id);

CREATE TABLE IF NOT EXISTS lead_list_tags (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (list_id, tag_id)
);

CREATE TABLE IF NOT EXISTS lead_list_imports (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  filename TEXT NOT NULL DEFAULT '',
  requested INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('running','done','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reply categories. Harry's classifier works on free-form intents drawn from
-- playbook edge labels; these are the named buckets a human triages into.
CREATE TABLE IF NOT EXISTS lead_categories (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, name)
);

-- ------------------------------------------------------ agency clients -----
-- The first of the three surfaces the backlog says Harry genuinely lacks:
-- the Team model deliberately shares one workspace, so agency clients need a
-- real scope of their own. No password field — sign-in stays with Auth0.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT DEFAULT '',
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS client_api_keys (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  key_name TEXT NOT NULL DEFAULT '',
  key_prefix TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'read',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_used_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_client_keys ON client_api_keys(client_id, status);

-- ----------------------------------------------------------- webhooks ------
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE, -- null = workspace-wide
  name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '',
  event_types TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhooks_ws ON webhooks(workspace_id, is_active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  delivered_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(webhook_id, id);

-- -------------------------------------------------------- inbox surfaces ---
CREATE TABLE IF NOT EXISTS inbox_views (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  is_shared INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, name)
);

-- A reply that arrived in a connected mailbox but matches no lead. Never
-- silently dropped: a human attaches it to a lead or dismisses it.
CREATE TABLE IF NOT EXISTS unmatched_messages (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
  from_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','attached','dismissed')),
  attached_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  resolved_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_unmatched ON unmatched_messages(workspace_id, status, id);

-- Suppression. Harry's is unconditional: there is no per-import override.
CREATE TABLE IF NOT EXISTS blocked_domains (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value TEXT NOT NULL,                 -- lowercased domain or full address
  is_domain INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, value)
);

-- ------------------------------------------------- campaign multi-mailbox --
CREATE TABLE IF NOT EXISTS campaign_mailboxes (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campaign_id, mailbox_id)
);

-- ----------------------------------------------- messaging channel accounts --
-- SMS / WhatsApp / Telegram senders. Distinct from email mailboxes — OAuth
-- mail stays on mailboxes; CPaaS credentials and DIDs live here.
CREATE TABLE IF NOT EXISTS channel_accounts (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('sms','whatsapp','telegram')),
  provider TEXT NOT NULL DEFAULT 'twilio',
  display_name TEXT NOT NULL DEFAULT '',
  phone_number TEXT NOT NULL DEFAULT '',       -- E.164 From number
  messaging_service_sid TEXT NOT NULL DEFAULT '',
  account_sid TEXT NOT NULL DEFAULT '',
  auth_token TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected',
  daily_limit INTEGER NOT NULL DEFAULT 50,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_today_date TEXT DEFAULT '',
  last_error TEXT DEFAULT '',
  last_sync_at TEXT DEFAULT '',
  is_suspended INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_accounts_ws
  ON channel_accounts(workspace_id, channel, status);

CREATE TABLE IF NOT EXISTS campaign_channel_accounts (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  channel_account_id INTEGER NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campaign_id, channel_account_id)
);

-- ------------------------------------------------------- warmup history ----
CREATE TABLE IF NOT EXISTS warmup_stats (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                   -- YYYY-MM-DD
  sent INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  spam INTEGER NOT NULL DEFAULT 0,
  inbox INTEGER NOT NULL DEFAULT 0,
  reply_rate REAL NOT NULL DEFAULT 0,
  UNIQUE (mailbox_id, day)
);

-- --------------------------------------------------------- deliverability --
-- Inbox-placement testing. Rows are local and authoritative for the UI; an
-- env-gated provider reconciles them (server/parity/providers.js). With no
-- provider configured every surface still renders and says so honestly.
CREATE TABLE IF NOT EXISTS deliverability_folders (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT DEFAULT '',
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS deliverability_tests (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES deliverability_folders(id) ON DELETE SET NULL,
  provider_test_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'manual' CHECK (type IN ('manual','automated')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','active','completed','stopped','error')),
  schedule_start_time TEXT NOT NULL DEFAULT '',
  test_end_date TEXT NOT NULL DEFAULT '',
  every_days INTEGER NOT NULL DEFAULT 0,
  current_run_no INTEGER NOT NULL DEFAULT 0,
  all_email_sent_without_time_gap INTEGER NOT NULL DEFAULT 0,
  min_time_btwn_emails INTEGER NOT NULL DEFAULT 0,
  min_time_unit TEXT NOT NULL DEFAULT 'minutes',
  is_warmup INTEGER NOT NULL DEFAULT 0,
  test_with_sl_account INTEGER NOT NULL DEFAULT 0,
  link_checker INTEGER NOT NULL DEFAULT 0,
  spam_filters TEXT NOT NULL DEFAULT '[]',
  mailbox_ids TEXT NOT NULL DEFAULT '[]',
  tag_ids TEXT NOT NULL DEFAULT '[]',
  blocklist_count INTEGER NOT NULL DEFAULT 0,
  stale_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_deliv_tests ON deliverability_tests(workspace_id, deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS deliverability_test_runs (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES deliverability_tests(id) ON DELETE CASCADE,
  run_no INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT DEFAULT '',
  metrics TEXT NOT NULL DEFAULT '{}',
  UNIQUE (test_id, run_no)
);

CREATE TABLE IF NOT EXISTS deliverability_test_senders (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES deliverability_tests(id) ON DELETE CASCADE,
  run_no INTEGER NOT NULL DEFAULT 1,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  sender_email TEXT NOT NULL DEFAULT '',
  seed_email TEXT NOT NULL DEFAULT '',
  seed_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  send_status TEXT NOT NULL DEFAULT 'pending',
  placement TEXT NOT NULL DEFAULT '',   -- inbox | spam | promotions | missing
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deliv_senders ON deliverability_test_senders(test_id, run_no);

CREATE TABLE IF NOT EXISTS deliverability_blacklist (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES deliverability_tests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'ip' CHECK (kind IN ('ip','domain')),
  value TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  listed INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deliv_blacklist ON deliverability_blacklist(test_id, kind);

-- Report payloads the UI renders but never filters server-side: dkim, spf,
-- rdns, ip-analytics, spam-filter details, email content, reply headers,
-- schedule history, mailbox counts/summary, provider- and geo-wise rollups.
-- One cache row per (test, run, kind, key) rather than eleven near-identical
-- tables — the shapes come from the provider and are rendered whole.
CREATE TABLE IF NOT EXISTS deliverability_reports (
  id INTEGER PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES deliverability_tests(id) ON DELETE CASCADE,
  run_no INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',        -- replyId, providerId, region, ...
  payload TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (test_id, run_no, kind, ref)
);

-- ------------------------------------------------------------- prospects ---
CREATE TABLE IF NOT EXISTS prospect_searches (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  filters TEXT NOT NULL DEFAULT '{}',
  provider_filter_id TEXT NOT NULL DEFAULT '',
  total_count INTEGER NOT NULL DEFAULT 0,
  is_saved INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  last_reviewed_at TEXT DEFAULT '',
  last_review TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prospect_searches ON prospect_searches(workspace_id, is_saved, id);

CREATE TABLE IF NOT EXISTS prospect_fetches (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  search_id INTEGER REFERENCES prospect_searches(id) ON DELETE SET NULL,
  provider_filter_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  requested INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','failed','insufficient_credits')),
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prospect_contacts (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fetch_id INTEGER REFERENCES prospect_fetches(id) ON DELETE CASCADE,
  provider_contact_id TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  email_verification_status TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  linkedin TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  raw TEXT NOT NULL DEFAULT '{}',
  imported_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prospect_contacts ON prospect_contacts(fetch_id, id);

CREATE TABLE IF NOT EXISTS prospect_credits (
  workspace_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_credits INTEGER NOT NULL DEFAULT 0,
  lead_credits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Filter vocabularies (countries, industries, job titles, …) are provider
-- reference data. Cached per query so typing in a filter box is not a call.
CREATE TABLE IF NOT EXISTS prospect_filter_cache (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, query)
);

CREATE TABLE IF NOT EXISTS email_find_jobs (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  requested INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '[]',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------------- senders ---
-- Sending-infrastructure procurement. Harry never touches card details: the
-- supplier's own checkout holds the instrument and Harry stores a reference.
CREATE TABLE IF NOT EXISTS sender_vendors (
  id INTEGER PRIMARY KEY,
  provider_vendor_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  payload TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sender_domains (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'purchased',
  order_ref TEXT NOT NULL DEFAULT '',
  forwarding_domain TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sender_orders (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id TEXT NOT NULL DEFAULT '',
  order_ref TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','placed','failed','cancelled')),
  forwarding_domain TEXT NOT NULL DEFAULT '',
  domains TEXT NOT NULL DEFAULT '[]',
  mailboxes TEXT NOT NULL DEFAULT '[]',
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS sender_billing_details (
  workspace_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted TEXT NOT NULL DEFAULT '',   -- AES-256-GCM, never logged
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

  // Column additions to tables that already existed. SQLite has no
  // ADD COLUMN IF NOT EXISTS, so each is attempted and the duplicate ignored —
  // the same pattern server/db.js already uses.
  for (const stmt of [
    // --- messages: the inbox states SmartLead exposes as separate endpoints.
    "ALTER TABLE messages ADD COLUMN archived_at TEXT DEFAULT ''",
    "ALTER TABLE messages ADD COLUMN archived_by TEXT DEFAULT ''",
    "ALTER TABLE messages ADD COLUMN snoozed_until TEXT DEFAULT ''",
    "ALTER TABLE messages ADD COLUMN snoozed_by TEXT DEFAULT ''",
    'ALTER TABLE messages ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE messages ADD COLUMN important_by TEXT DEFAULT ''",
    "ALTER TABLE messages ADD COLUMN read_by TEXT DEFAULT ''",
    "ALTER TABLE messages ADD COLUMN read_at TEXT DEFAULT ''",
    "ALTER TABLE messages ADD COLUMN forwarded_at TEXT DEFAULT ''",
    "ALTER TABLE messages ADD COLUMN forwarded_to TEXT DEFAULT ''",
    'ALTER TABLE messages ADD COLUMN manual_reply INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE messages ADD COLUMN scheduled_at TEXT DEFAULT ''",
    "ALTER TABLE messages ADD COLUMN send_status TEXT DEFAULT ''",
    'ALTER TABLE messages ADD COLUMN sequence_number INTEGER NOT NULL DEFAULT 0',
    // Who else received this. Comma-separated, matching `to_email`'s shape.
    // The thread view has to be able to show that a reply went to three people,
    // not one — a copied recipient is part of what was said.
    "ALTER TABLE messages ADD COLUMN cc_emails TEXT DEFAULT ''",
    "ALTER TABLE messages ADD COLUMN bcc_emails TEXT DEFAULT ''",
    // Why a reply is worth reading first. The reasons are a JSON array of
    // plain-language strings and are the point of the pair — the spec forbids
    // showing a bare number, so a score without its reasons is unusable by
    // design rather than merely unhelpful.
    'ALTER TABLE messages ADD COLUMN importance_score INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE messages ADD COLUMN importance_reasons TEXT DEFAULT ''",
    // Multi-channel: email (default), sms, whatsapp, telegram. Channel account
    // is null for email (mailbox_id owns those); SMS/WA/TG use channel_account_id.
    "ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'",
    'ALTER TABLE messages ADD COLUMN channel_account_id INTEGER',
    'CREATE INDEX IF NOT EXISTS idx_messages_states ON messages(user_id, archived_at, snoozed_until, is_important)',
    'CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(user_id, channel, id)',

    // --- campaign_leads: triage state that belongs to the lead-in-campaign.
    "ALTER TABLE campaign_leads ADD COLUMN assigned_email TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN assigned_at TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN assigned_by TEXT DEFAULT ''",
    'ALTER TABLE campaign_leads ADD COLUMN revenue_amount REAL NOT NULL DEFAULT 0',
    "ALTER TABLE campaign_leads ADD COLUMN revenue_currency TEXT DEFAULT 'USD'",
    "ALTER TABLE campaign_leads ADD COLUMN revenue_updated_at TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN revenue_updated_by TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN paused_at TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN paused_by TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN resume_at TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN intent_set_by TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN intent_set_at TEXT DEFAULT ''",
    'ALTER TABLE campaign_leads ADD COLUMN category_id INTEGER',
    "ALTER TABLE campaign_leads ADD COLUMN unsubscribed_at TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN unsubscribed_by TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN unsubscribed_source TEXT DEFAULT ''",
    'ALTER TABLE campaign_leads ADD COLUMN moved_from_campaign_id INTEGER',
    // "Stop if they reply to the current campaign", per lead.
    //
    // `campaigns.stop_on_source_reply` already existed and was the wrong shape:
    // one lead's move set it for every other lead in that subsequence. A move is
    // a decision about one person, so the flag belongs on their pairing.
    //
    // The watermark is the last message id on the source thread at the instant
    // of the move, and it is what makes "a reply on the old thread" mean a reply
    // that arrives *after* the move. Without it the reply that prompted the move
    // — the one the triager was reading when they pressed the button — would
    // stop the subsequence it had just created. A message id rather than a
    // timestamp because `datetime('now')` is only accurate to the second, and a
    // move and a reply inside the same second must still be ordered correctly.
    'ALTER TABLE campaign_leads ADD COLUMN stop_on_source_reply INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE campaign_leads ADD COLUMN moved_after_message_id INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE campaign_leads ADD COLUMN mailbox_id INTEGER',
    "ALTER TABLE campaign_leads ADD COLUMN last_reply_at TEXT DEFAULT ''",
    "ALTER TABLE campaign_leads ADD COLUMN completed_at TEXT DEFAULT ''",

    // --- leads: global suppression and provenance.
    "ALTER TABLE leads ADD COLUMN unsubscribed_at TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN unsubscribed_source TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN phone TEXT DEFAULT ''",
    // SMS consent — no send without opt-in (Docs/messaging-channels-plan.md).
    "ALTER TABLE leads ADD COLUMN sms_opt_in_at TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN sms_opt_in_source TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN sms_opt_out_at TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN website TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN linkedin TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN location TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN custom_fields TEXT DEFAULT '{}'",
    "ALTER TABLE leads ADD COLUMN email_source TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN email_verification_status TEXT DEFAULT ''",
    'ALTER TABLE leads ADD COLUMN client_id INTEGER',

    // --- campaigns: settings, schedule, ownership, hierarchy.
    'ALTER TABLE campaigns ADD COLUMN client_id INTEGER',
    'ALTER TABLE campaigns ADD COLUMN parent_campaign_id INTEGER',
    "ALTER TABLE campaigns ADD COLUMN owner_email TEXT DEFAULT ''",
    "ALTER TABLE campaigns ADD COLUMN status_reason TEXT DEFAULT ''",
    "ALTER TABLE campaigns ADD COLUMN status_at TEXT DEFAULT ''",
    "ALTER TABLE campaigns ADD COLUMN deleted_at TEXT DEFAULT ''",
    "ALTER TABLE campaigns ADD COLUMN schedule TEXT DEFAULT '{}'",
    "ALTER TABLE campaigns ADD COLUMN settings TEXT DEFAULT '{}'",
    'ALTER TABLE campaigns ADD COLUMN track_opens INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN track_clicks INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN stop_on_reply INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN stop_on_source_reply INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE campaigns ADD COLUMN tracking_domain TEXT DEFAULT ''",
    "ALTER TABLE campaigns ADD COLUMN reply_to TEXT DEFAULT ''",

    // --- mailboxes: warmup, suspension, per-client scope.
    'ALTER TABLE mailboxes ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE mailboxes ADD COLUMN suspended_at TEXT DEFAULT ''",
    "ALTER TABLE mailboxes ADD COLUMN suspended_reason TEXT DEFAULT ''",
    'ALTER TABLE mailboxes ADD COLUMN warmup_enabled INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE mailboxes ADD COLUMN warmup_daily_count INTEGER NOT NULL DEFAULT 20',
    'ALTER TABLE mailboxes ADD COLUMN warmup_ramp_enabled INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE mailboxes ADD COLUMN warmup_ramp_step INTEGER NOT NULL DEFAULT 2',
    'ALTER TABLE mailboxes ADD COLUMN warmup_target_reply_rate INTEGER NOT NULL DEFAULT 30',
    'ALTER TABLE mailboxes ADD COLUMN warmup_auto_adjust INTEGER NOT NULL DEFAULT 1',
    "ALTER TABLE mailboxes ADD COLUMN signature TEXT DEFAULT ''",
    'ALTER TABLE mailboxes ADD COLUMN client_id INTEGER',
    "ALTER TABLE mailboxes ADD COLUMN tracking_domain TEXT DEFAULT ''",
    'ALTER TABLE mailboxes ADD COLUMN message_per_day INTEGER NOT NULL DEFAULT 0',
    // Soft delete (Docs/email-accounts/delete.md AC 4). `messages.mailbox_id`
    // is ON DELETE SET NULL, so a hard delete kept the send and threw away the
    // address it came from — history that Inbox and Reports cannot label. The
    // row stays, marked; every read path filters on this the way the campaigns
    // list already filters `campaigns.deleted_at`.
    // NULL, not '', and deliberately unlike `campaigns.deleted_at`: the filter
    // `deleted_at IS NULL` has to appear in ~40 single-quoted SQL strings
    // across the server, and `COALESCE(deleted_at, '') = ''` cannot be written
    // in one without escaping every quote. A predicate that is awkward to type
    // is a predicate somebody leaves out.
    'ALTER TABLE mailboxes ADD COLUMN deleted_at TEXT',
    'ALTER TABLE mailboxes ADD COLUMN deleted_reason TEXT',

    // A task's urgency. Added after the first build of this schema, so it needs
    // the ALTER as well as the CREATE above for databases that already exist.
    "ALTER TABLE lead_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'",

    // --- users: workspace-level parity settings.
    "ALTER TABLE users ADD COLUMN prospect_provider_key TEXT DEFAULT ''",
  ]) {
    try { db.exec(stmt) } catch { /* column or index already exists */ }
  }

  // Active mailboxes must have deleted_at IS NULL — older rows used '' before
  // the soft-delete column landed, which hid every mailbox from the fleet list.
  db.exec("UPDATE mailboxes SET deleted_at = NULL WHERE deleted_at = ''")

  migrateOutlookProvider(db)
}

function defaultClause(dflt) {
  if (dflt == null) return ''
  const s = String(dflt)
  // PRAGMA returns `datetime('now')` bare — SQLite requires `DEFAULT (expr)` for calls.
  if (s.includes('(') && !s.startsWith('(')) return ` DEFAULT (${s})`
  return ` DEFAULT ${s}`
}

function migrateOutlookProvider(db) {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mailboxes'").get()?.sql || ''
  if (ddl.includes("'outlook'")) return
  const cols = db.prepare('PRAGMA table_info(mailboxes)').all()
  if (!cols.length) return
  const colNames = cols.map((c) => c.name).join(', ')
  const colDefs = cols.map((c) => {
    if (c.name === 'provider') return "provider TEXT NOT NULL CHECK (provider IN ('gmail','outlook','sandbox'))"
    let def = `${c.name} ${c.type || 'TEXT'}`
    if (c.pk) def += ' PRIMARY KEY'
    else if (c.notnull) def += ' NOT NULL'
    def += defaultClause(c.dflt_value != null && !c.pk ? c.dflt_value : null)
    return def
  })
  db.exec('DROP TABLE IF EXISTS mailboxes_outlook_mig')
  db.pragma('foreign_keys = OFF')
  try {
    db.exec(`CREATE TABLE mailboxes_outlook_mig (${colDefs.join(', ')}, UNIQUE (user_id, provider, email))`)
    db.exec(`INSERT INTO mailboxes_outlook_mig (${colNames}) SELECT ${colNames} FROM mailboxes`)
    db.exec('DROP TABLE mailboxes')
    db.exec('ALTER TABLE mailboxes_outlook_mig RENAME TO mailboxes')
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

// Bringing a removed mailbox back.
//
// The soft delete keeps the row, and `UNIQUE (user_id, provider, email)` keeps
// it in the way: reconnecting the same address cannot insert a second one. So
// the reconnect paths revive this one instead — clearing the mark, the
// suspension and the warm-up reason together, because a row that is un-deleted
// but still suspended would be a mailbox that exists and cannot send, which is
// no better than the state it came from.
//
// Docs/email-accounts/delete.md TC-11 asks that warm-up start from the
// beginning rather than resume the removed mailbox's ramp, so the ramp counter
// and the day's send count are reset with it. The `?` is the display name.
export const REVIVE_MAILBOX_SQL = `
  UPDATE mailboxes
     SET deleted_at = NULL, deleted_reason = NULL,
         is_suspended = 0, suspended_at = '', suspended_reason = '',
         status = 'connected', last_error = '', next_send_at = 0,
         warmup_daily_count = 20, warmup_auto_adjust = 1,
         sent_today = 0, sent_today_date = '',
         display_name = ?
   WHERE id = ?`
