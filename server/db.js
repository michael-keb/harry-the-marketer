import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ROOT } from './env.js'
import { applyParitySchema } from './parity/schema.js'

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const DB_FILE = 'harry-the-marketer.db'
const dbPath = path.join(DATA_DIR, DB_FILE)
const legacyPath = path.join(DATA_DIR, 'leadgen.db')
if (!fs.existsSync(dbPath) && fs.existsSync(legacyPath)) {
  fs.renameSync(legacyPath, dbPath)
  for (const suffix of ['-wal', '-shm']) {
    const from = legacyPath + suffix
    const to = dbPath + suffix
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to)
  }
}

export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  sub TEXT UNIQUE NOT NULL,            -- auth0 sub, or dev:<email>
  email TEXT NOT NULL,
  name TEXT DEFAULT '',
  picture TEXT DEFAULT '',
  business_context TEXT DEFAULT '',    -- who we are / what we sell, used by the AI agent
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gmail','outlook','sandbox')),
  email TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','disconnected')),
  access_token TEXT DEFAULT '',
  refresh_token TEXT DEFAULT '',
  token_expiry INTEGER DEFAULT 0,      -- unix ms
  daily_limit INTEGER NOT NULL DEFAULT 50,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_today_date TEXT DEFAULT '',
  last_error TEXT DEFAULT '',
  last_sync_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, provider, email)
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  company TEXT DEFAULT '',
  title TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','unsubscribed','bounced')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, email)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','paused','archived')),
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  mermaid TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_leads (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  node_id TEXT DEFAULT '',             -- current node in the playbook graph
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','active','waiting','needs_attention','finished','stopped','error')),
  wait_until TEXT DEFAULT '',          -- ISO time for no-reply timeout edges
  thread_id TEXT DEFAULT '',           -- gmail thread id (or sandbox thread id)
  intent TEXT DEFAULT '',              -- last classified reply intent
  outcome TEXT DEFAULT '',             -- won/lost/unsubscribed/completed when finished
  error TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campaign_id, lead_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  from_email TEXT DEFAULT '',
  to_email TEXT DEFAULT '',
  provider_message_id TEXT DEFAULT '', -- gmail message id / sandbox id
  thread_id TEXT DEFAULT '',
  node_id TEXT DEFAULT '',             -- playbook node that produced it (out only)
  intent TEXT DEFAULT '',              -- classified intent (in only)
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, direction, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER,
  lead_id INTEGER,
  type TEXT NOT NULL,                  -- sent, reply, classified, branched, finished, error, ...
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-hop telemetry for the Monitoring page: engine ticks, AI calls, provider
-- sends, inbound syncs. System-wide (not workspace-scoped); self-pruning.
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                  -- tick | ai_call | send | inbound_sync
  op TEXT DEFAULT '',                  -- compose, classify, gmail, sandbox, ...
  ok INTEGER NOT NULL DEFAULT 1,
  ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(kind, id);

-- Revenue goals: an outcome stated in plain English; the AI plans ICP, target,
-- and playbook, wires up a campaign, and progress is measured from real results.
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL DEFAULT 'won',
  target INTEGER NOT NULL DEFAULT 10,
  icp TEXT NOT NULL DEFAULT '{}',
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI qualification: per-goal lead fit scores with human-readable reasons.
CREATE TABLE IF NOT EXISTS lead_scores (
  id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  fit INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (goal_id, lead_id)
);

-- Team: members invited by a workspace owner. A member whose email matches an
-- invite works inside the owner's workspace (shared leads/campaigns/inbox).
-- Enquiries submitted from the public marketing site's contact form. Not
-- workspace-scoped: these arrive before anyone has an account.
CREATE TABLE IF NOT EXISTS site_contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT DEFAULT '',
  topic TEXT NOT NULL DEFAULT 'general',
  message TEXT NOT NULL,
  source_ip TEXT DEFAULT '',
  handled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_site_contacts_created ON site_contacts(created_at);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','manager')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, email)
);

-- Drafts: the standing rule is that nothing sends without a human OK. The
-- engine composes at a Send node, parks the result here, and only sends once
-- someone approves it. One open draft per lead per node at a time.
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','sent')),
  edited INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT DEFAULT '',
  reviewed_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_open ON drafts(user_id, status, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_one_open
  ON drafts(campaign_id, lead_id) WHERE status IN ('pending','approved');

-- Approved copy for a Send step. The diagram carries the instruction ("what
-- this email should do"); this carries the email itself, once someone has read
-- it, tailored it and signed it off. The live composer writes each lead's
-- version to match it instead of starting from the instruction alone.
CREATE TABLE IF NOT EXISTS node_examples (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campaign_id, node_id)
);

-- Consent: when a prospect says yes, they sign one short agreement so the
-- "yes" is on the record. The token is the public link we email them.
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  terms TEXT NOT NULL DEFAULT '',       -- the exact text they were shown
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','signed','declined')),
  signed_name TEXT DEFAULT '',
  signed_at TEXT DEFAULT '',
  signed_ip TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, lead_id)
);

-- Send controls. One rules document per scope object; a narrower scope may only
-- ever restrict a wider one, so the workspace row is a real ceiling rather than
-- a suggestion (see server/send-rules.js).
CREATE TABLE IF NOT EXISTS send_rules (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('workspace','campaign','mailbox')),
  scope_id INTEGER NOT NULL DEFAULT 0,   -- 0 for the workspace scope
  rules TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, scope, scope_id)
);

-- Who changed which lever, when, and what it was before. The first thing anyone
-- wants when sending stops for a reason nobody remembers setting.
CREATE TABLE IF NOT EXISTS send_rule_changes (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  scope_id INTEGER NOT NULL DEFAULT 0,
  before_rules TEXT NOT NULL DEFAULT '{}',
  after_rules TEXT NOT NULL DEFAULT '{}',
  changed_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_send_rule_changes ON send_rule_changes(workspace_id, created_at);

-- Every stop button, at every scope, in one table: the workspace-wide hold, a
-- paused mailbox, a plan parked for a fortnight, one person left alone, and the
-- automatic holds the bounce brake places. One table means "what is stopping
-- this send?" is one query (server/holds.js).
CREATE TABLE IF NOT EXISTS send_holds (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('workspace','campaign','mailbox','lead')),
  scope_id INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual', -- manual | bounce_brake | complaint_brake | mailbox_health
  created_by TEXT DEFAULT '',
  release_at INTEGER NOT NULL DEFAULT 0, -- unix ms, 0 = until a person lifts it
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, scope, scope_id)
);

-- The touch ledger: who this workspace contacted, when, by which channel,
-- across every plan. The messages table is per-campaign and email-only; the
-- frequency caps ask a wider question than it can answer (server/touches.js).
CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company_domain TEXT DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'email',
  campaign_id INTEGER,
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_touches_person ON touches(workspace_id, lead_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_touches_company ON touches(workspace_id, company_domain, sent_at);
CREATE INDEX IF NOT EXISTS idx_touches_campaign ON touches(workspace_id, campaign_id, sent_at);

-- Per-step randomised send slot. Chosen once per (campaign, lead, node) so a
-- retry or re-tick never re-rolls the clock inside a window.
CREATE TABLE IF NOT EXISTS step_send_slots (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  chosen_at INTEGER NOT NULL,
  window_from TEXT NOT NULL DEFAULT '',
  window_to TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'campaign',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, lead_id, node_id)
);

-- Audit trail when a playbook step's channel is changed after launch.
CREATE TABLE IF NOT EXISTS campaign_channel_changes (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  from_channel TEXT NOT NULL DEFAULT '',
  to_channel TEXT NOT NULL DEFAULT '',
  changed_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// The SmartLead-parity backlog's tables and column additions. Applied after the
// core schema so its foreign keys into users/leads/campaigns/mailboxes resolve,
// and before the column migrations below so both run on every boot.
applyParitySchema(db)

export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function kvGet(key) {
  return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null
}

// Resolve which workspace a user works in: their own, unless their email was
// invited to another owner's team (first invite wins).
export function resolveWorkspace(user) {
  const membership = db.prepare(
    "SELECT * FROM team_members WHERE email = ? ORDER BY id LIMIT 1"
  ).get(user.email)
  if (!membership || membership.owner_id === user.id) {
    return { wsId: user.id, role: 'owner', ownerEmail: user.email }
  }
  if (membership.status === 'invited') {
    // An invite may claim a colleague joining fresh — never someone with a
    // workspace of their own. Without this check, inviting any existing
    // user's address silently moved their next session into the inviter's
    // workspace: their own leads and campaigns vanished and they were
    // operating — and sending — inside a stranger's data. A person who owns
    // anything keeps their workspace; the invite stays pending.
    const ownsData = db.prepare(
      `SELECT EXISTS(SELECT 1 FROM campaigns WHERE user_id = @id)
           OR EXISTS(SELECT 1 FROM leads WHERE user_id = @id)
           OR EXISTS(SELECT 1 FROM mailboxes WHERE user_id = @id) AS owns`
    ).get({ id: user.id }).owns
    if (ownsData) return { wsId: user.id, role: 'owner', ownerEmail: user.email }
    db.prepare("UPDATE team_members SET status = 'active' WHERE id = ?").run(membership.id)
  }
  if (membership.status !== 'active' && membership.status !== 'invited') {
    return { wsId: user.id, role: 'owner', ownerEmail: user.email }
  }
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(membership.owner_id)
  if (!owner) return { wsId: user.id, role: 'owner', ownerEmail: user.email }
  return { wsId: owner.id, role: membership.role, ownerEmail: owner.email }
}

// Column migrations for existing databases (SQLite has no ADD COLUMN IF NOT EXISTS).
for (const stmt of [
  "ALTER TABLE leads ADD COLUMN research TEXT DEFAULT ''",
  "ALTER TABLE leads ADD COLUMN researched_at TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN meeting_link TEXT DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN tracking_token TEXT DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN opened_at TEXT DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN clicked_at TEXT DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_messages_token ON messages(tracking_token)",
  // The standing rule: nothing sends without your OK. On by default, including
  // for workspaces that existed before approvals did.
  'ALTER TABLE users ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 1',
  "ALTER TABLE users ADD COLUMN alert_webhook TEXT DEFAULT ''",  // slack or teams
  "ALTER TABLE users ADD COLUMN profile TEXT DEFAULT ''",        // guided briefing (JSON)
  "ALTER TABLE users ADD COLUMN consent_terms TEXT DEFAULT ''",  // what people agree to
  "ALTER TABLE users ADD COLUMN sheet_id TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN sheet_url TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN sheet_synced_at TEXT DEFAULT ''",
  // Sending rhythm: working hours, working days, and one email at a time per
  // mailbox with a randomised gap. On by default (see server/pacing.js).
  'ALTER TABLE users ADD COLUMN paced INTEGER NOT NULL DEFAULT 1',
  "ALTER TABLE users ADD COLUMN send_from TEXT DEFAULT '08:30'",
  "ALTER TABLE users ADD COLUMN send_to TEXT DEFAULT '17:30'",
  "ALTER TABLE users ADD COLUMN send_days TEXT DEFAULT 'weekdays'",
  "ALTER TABLE users ADD COLUMN send_timezone TEXT DEFAULT ''",
  'ALTER TABLE mailboxes ADD COLUMN next_send_at INTEGER NOT NULL DEFAULT 0',
  // Send controls: the recipient's own clock, so quiet hours can be theirs
  // rather than ours. Blank means unknown, and unknown is never guessed at —
  // it falls back to the sender's window (server/gates.js).
  "ALTER TABLE leads ADD COLUMN timezone TEXT DEFAULT ''",
  // One queued email held back to a chosen time: "send at" and "snooze".
  // 0 means it takes its turn in the normal queue.
  'ALTER TABLE drafts ADD COLUMN send_after INTEGER NOT NULL DEFAULT 0',
  // Billing: plan from Stripe Payment Link checkout webhook.
  "ALTER TABLE users ADD COLUMN plan_id TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN billing_status TEXT DEFAULT 'trial'",
  "ALTER TABLE users ADD COLUMN stripe_customer_id TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN billing_updated_at TEXT DEFAULT ''",
  // Exact-time / window-window send scheduling (server/step-timing.js).
  "ALTER TABLE campaigns ADD COLUMN email_subject TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE campaigns ADD COLUMN defaults_snapshot TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE campaigns ADD COLUMN launched_at TEXT DEFAULT ''",
  // Retry with backoff for TRANSIENT per-lead send failures (server/engine.js).
  // A transient Gmail 5xx/429 or Twilio blip used to strand a lead in state
  // 'error', which the tick never re-selects. These keep the lead selectable and
  // delayed until the backoff has passed; only after MAX_LEAD_RETRIES does a
  // transient failure become the terminal 'error' state.
  'ALTER TABLE campaign_leads ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE campaign_leads ADD COLUMN next_retry_at TEXT DEFAULT ''",
  // Refresh-token classification (server/google.js, server/microsoft.js): a
  // genuine invalid_grant/invalid_client sets status='error' AND this flag so the
  // reconnect banner can tell "revoked, reconnect me" from a transient 5xx that
  // left the mailbox connected and simply retries next tick.
  'ALTER TABLE mailboxes ADD COLUMN needs_reconnect INTEGER NOT NULL DEFAULT 0',
  // Per-mailbox inbound watermark (last-seen internalDate in unix ms, as text).
  // The recent-inbound sweep fetches everything AFTER this and pages through, so
  // a mailbox offline for a week or flooded with mail never skips a reply
  // (server/google.js gmailRecentInbound, server/upkeep.js syncMailboxInbound).
  "ALTER TABLE mailboxes ADD COLUMN inbound_watermark TEXT DEFAULT ''",
  // Session revocation: logout bumps this; cookies carrying an older epoch are
  // rejected even though their HMAC still verifies (server/auth.js).
  'ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0',
  // Purpose guardrail (PURPOSE-GUARDRAIL-PLAN.md). Existing rows migrate to
  // commercial — safe for the operator tier already using the product.
  "ALTER TABLE campaigns ADD COLUMN purpose TEXT NOT NULL DEFAULT 'commercial'",
]) {
  try { db.exec(stmt) } catch { /* column already exists */ }
}

// Monthly AI spend ledger (Docs/AI-SPEND.md). One row per workspace per UTC month.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_spend (
      workspace_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      cents_used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, month)
    )
  `)
} catch { /* already exists */ }

// Inbound dedupe belongs to the database, not to check-then-insert races: the
// per-thread engine sync and the whole-inbox upkeep sweep both pull the same
// Gmail message, and under their overlap a reply could land — and count —
// twice. Existing duplicates are collapsed to the earliest row first, or the
// unique index could never build on a database that already raced.
// Inbound only: outbound rows may carry non-unique ids legitimately (two
// forwards stamped in the same millisecond), and the race this index closes is
// two sync paths pulling the same *inbound* Gmail message.
//
// Scoped by workspace, not global. Two workspaces can each connect the SAME
// Gmail address (an agency and its client, say). A global unique on
// provider_message_id let the FIRST workspace to ingest a message win and made
// every INSERT OR IGNORE from the second a silent no-op — so the second
// workspace lost every reply the first had already seen. Keying the uniqueness
// on (user_id, provider_message_id) — and (workspace_id, provider_message_id)
// for the untracked queue — means a message is deduped within a workspace and
// still delivered to each workspace that holds the mailbox. The pre-index
// collapse and the runtime checks (server/upkeep.js, server/mailer.js) use the
// same composite key.
try {
  db.exec(`
    DROP INDEX IF EXISTS idx_messages_provider_id;
    DROP INDEX IF EXISTS idx_messages_inbound_provider_id;
    DELETE FROM messages WHERE direction = 'in' AND COALESCE(provider_message_id, '') != ''
      AND id NOT IN (
        SELECT MIN(id) FROM messages
        WHERE direction = 'in' AND COALESCE(provider_message_id, '') != ''
        GROUP BY user_id, provider_message_id
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_inbound_ws_provider_id
      ON messages(user_id, provider_message_id) WHERE direction = 'in' AND COALESCE(provider_message_id, '') != '';
    DROP INDEX IF EXISTS idx_unmatched_provider_id;
    DELETE FROM unmatched_messages WHERE COALESCE(provider_message_id, '') != ''
      AND id NOT IN (
        SELECT MIN(id) FROM unmatched_messages
        WHERE COALESCE(provider_message_id, '') != ''
        GROUP BY workspace_id, provider_message_id
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unmatched_ws_provider_id
      ON unmatched_messages(workspace_id, provider_message_id) WHERE COALESCE(provider_message_id, '') != '';
  `)
} catch (err) {
  console.warn('[db] inbound dedupe indexes not created:', String(err.message || err))
}

// One-shot backfill of the touch ledger from everything already sent. Without
// it, the frequency caps ship blind: on the morning this deploys, every person
// mid-sequence looks untouched and gets approached again.
if (!db.prepare('SELECT COUNT(*) n FROM touches').get().n) {
  db.exec(`
    INSERT INTO touches (workspace_id, lead_id, company_domain, channel, campaign_id, sent_at)
    SELECT m.user_id, m.lead_id,
           CASE WHEN lower(substr(m.to_email, instr(m.to_email, '@') + 1)) IN (
             'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com',
             'yahoo.com','yahoo.co.uk','icloud.com','me.com','mac.com','aol.com',
             'proton.me','protonmail.com','gmx.com','mail.com','yandex.com','zoho.com'
           ) THEN '' ELSE lower(substr(m.to_email, instr(m.to_email, '@') + 1)) END,
           'email', m.campaign_id,
           CAST((julianday(m.created_at) - 2440587.5) * 86400000 AS INTEGER)
    FROM messages m
    WHERE m.direction = 'out' AND m.lead_id IS NOT NULL AND instr(m.to_email, '@') > 0
      AND m.lead_id IN (SELECT id FROM leads)
  `)
}

// Persistent session secret (survives restarts so logins persist).
export function sessionSecret() {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('session_secret')
  if (row) return row.value
  const secret = crypto.randomBytes(32).toString('hex')
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('session_secret', secret)
  return secret
}

// Anything that wants to react to a domain event registers here rather than
// being called from each of the forty-odd `logEvent` sites. Outbound webhooks
// use it (wired in server/index.js), which is what makes a new event type
// deliverable the day it is added rather than the day someone remembers to
// call the dispatcher. A subscriber must never throw into the caller: an event
// is a record of something that already happened, and a failed notification
// cannot be allowed to unwind it.
const eventSubscribers = []

export function onEvent(fn) {
  eventSubscribers.push(fn)
}

export function logEvent(userId, { campaignId = null, leadId = null, type, detail = '' }) {
  db.prepare(
    'INSERT INTO events (user_id, campaign_id, lead_id, type, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, campaignId, leadId, type, detail)

  for (const fn of eventSubscribers) {
    try {
      fn({ workspaceId: userId, campaignId, leadId, type, detail })
    } catch (err) {
      console.warn('[events] subscriber failed:', err.message)
    }
  }
}

export function touch(table, id) {
  db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE id = ?`).run(id)
}
