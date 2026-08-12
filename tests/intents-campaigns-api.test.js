// Cedar Pike + Coral Heron campaign API intents — channel on steps, channel
// freeze after launch, cohort launch blockers, email_subject settings.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, mount } from './helpers/parity-harness.js'

setup('intents-campaigns-api')

const { db } = await import('../server/db.js')

// Parallel schema agent may not have landed yet — ensure the columns/tables
// this suite exercises exist before any campaign route runs.
function ensureIntentSchema() {
  for (const stmt of [
    "ALTER TABLE campaigns ADD COLUMN email_subject TEXT DEFAULT ''",
    "ALTER TABLE campaigns ADD COLUMN defaults_snapshot TEXT DEFAULT '{}'",
    'ALTER TABLE campaigns ADD COLUMN launched_at TEXT',
  ]) {
    try { db.exec(stmt) } catch { /* already present */ }
  }
  db.exec(`
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
  try { db.exec("ALTER TABLE campaign_channel_changes ADD COLUMN changed_by TEXT DEFAULT ''") } catch { /* present */ }
}
ensureIntentSchema()

const { register } = await import('../server/parity/campaigns.js')
const { snapshotDefaults } = await import('../server/send-rules.js')

const owner = seedUser(db, 'intents-owner@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

function stampDefaults(campaignId) {
  const snap = typeof snapshotDefaults === 'function'
    ? JSON.stringify(snapshotDefaults(owner) ?? {})
    : JSON.stringify({
      replyHandling: {
        email: { noReplySwitchTo: 'sms', timeoutMs: 2 * 86400e3 },
        sms: { noReplySwitchTo: 'email', timeoutMs: 2 * 86400e3 },
      },
    })
  db.prepare('UPDATE campaigns SET defaults_snapshot = ? WHERE id = ?').run(snap, campaignId)
}

const EMAIL_PLAYBOOK = `flowchart TD
    S([Start]) --> A[Send: short intro]
    A -- reply: interested --> W([Won: call booked])
    A -- no reply 3d --> L([Lost: no response])
`

const SMS_PLAYBOOK = `flowchart TD
    S([Start]) --> A[Send sms: short intro]
    A -- reply: interested --> W([Won: call booked])
    A -- no reply 3d --> L([Lost: no response])
`

const SMS_CHANNEL_SWAPPED = `flowchart TD
    S([Start]) --> A[Send sms: short intro]
    A -- reply: interested --> W([Won: call booked])
    A -- no reply 3d --> L([Lost: no response])
`

function readyEmailCampaign(name) {
  const mailbox = seedMailbox(db, owner.id, `${name}@example.com`)
  const campaign = seedCampaign(db, owner.id, name, mailbox.id)
  db.prepare('UPDATE campaigns SET mermaid = ? WHERE id = ?').run(EMAIL_PLAYBOOK, campaign.id)
  stampDefaults(campaign.id)
  db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(campaign.id, mailbox.id)
  const lead = seedLead(db, owner.id, `${name}-lead@acme.test`)
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, ?, ?)')
    .run(campaign.id, lead.id, 'A', 'waiting')
  return { campaign: db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id), mailbox, lead }
}

function readySmsCampaignMissingPhone(name) {
  const campaign = seedCampaign(db, owner.id, name)
  db.prepare("UPDATE campaigns SET mermaid = ?, channel_mode = 'sms' WHERE id = ?")
    .run(SMS_PLAYBOOK, campaign.id)
  stampDefaults(campaign.id)
  const sms = db.prepare(
    `INSERT INTO channel_accounts
       (workspace_id, channel, provider, display_name, phone_number, status, daily_limit)
     VALUES (?, 'sms', 'sandbox', 'Sandbox SMS', ?, 'connected', 50)`
  ).run(owner.id, `+61400${String(Date.now()).slice(-6)}`)
  db.prepare(
    'INSERT INTO campaign_channel_accounts (campaign_id, channel_account_id) VALUES (?, ?)'
  ).run(campaign.id, sms.lastInsertRowid)
  // Lead has email (seed default) but no phone — cohort fitness must block START.
  const lead = seedLead(db, owner.id, `${name}-lead@acme.test`)
  db.prepare("UPDATE leads SET phone = '' WHERE id = ?").run(lead.id)
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, ?, ?)')
    .run(campaign.id, lead.id, 'A', 'waiting')
  return { campaign: db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id), lead }
}

// -------------------------------------------------------------- steps/channel

test('GET steps includes channel on each node', async () => {
  const { campaign } = readyEmailCampaign('steps-channel')
  const res = await client.get(`/api/campaigns/${campaign.id}/steps`)
  assert.equal(res.status, 200)
  const send = res.body.steps.find((s) => s.nodeId === 'A')
  assert.ok(send)
  assert.equal(send.type, 'send')
  assert.equal(send.channel, 'email')
  const start = res.body.steps.find((s) => s.nodeId === 'S')
  assert.equal(start.channel, null)
})

// --------------------------------------------------------- channel freeze ----

test('cannot change send-node channel after launch (START → PAUSED → edit)', async () => {
  const { campaign } = readyEmailCampaign('channel-freeze')

  const started = await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  assert.equal(started.status, 200)
  assert.equal(started.body.campaign.status, 'running')
  const row = db.prepare('SELECT launched_at FROM campaigns WHERE id = ?').get(campaign.id)
  assert.ok(row.launched_at, 'launched_at stamped on START')

  const paused = await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'PAUSED' })
  assert.equal(paused.status, 200)
  assert.equal(paused.body.campaign.status, 'paused')

  const refused = await client.put(`/api/campaigns/${campaign.id}/sequence`, {
    mermaid: SMS_CHANNEL_SWAPPED,
  })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'channel_immutable')
  assert.match(refused.body.message, /Duplicate/i)
})

test('draft never-launched campaigns may change channels and audit the change', async () => {
  const { campaign } = readyEmailCampaign('channel-draft')
  const saved = await client.put(`/api/campaigns/${campaign.id}/sequence`, {
    mermaid: SMS_CHANNEL_SWAPPED,
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)

  const audits = db.prepare(
    `SELECT * FROM campaign_channel_changes WHERE campaign_id = ? AND node_id = 'A'`
  ).all(campaign.id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].from_channel, 'email')
  assert.equal(audits[0].to_channel, 'sms')
  assert.equal(audits[0].changed_by, owner.email)

  const events = db.prepare(
    "SELECT detail FROM events WHERE campaign_id = ? AND type = 'campaign_channel_change'"
  ).all(campaign.id)
  assert.ok(events.some((e) => /email -> sms/.test(e.detail)))
})

// ------------------------------------------------------- launch blockers ----

test('START blocked when SMS step but lead is missing a phone', async () => {
  const { campaign } = readySmsCampaignMissingPhone('sms-no-phone')
  const blocked = await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  assert.equal(blocked.status, 422)
  assert.equal(blocked.body.error, 'validation_failed')
  const cohort = (blocked.body.blockers || []).find((b) => b.field === 'cohort')
  assert.ok(cohort, 'expected cohort blocker')
  assert.match(cohort.message, /1 attached lead/)
  assert.match(cohort.message, /phone/i)
})

// --------------------------------------------------------- email subject ----

test('email_subject saves on settings PUT and reads back', async () => {
  const { campaign } = readyEmailCampaign('subject-save')
  const saved = await client.put(`/api/campaigns/${campaign.id}/settings`, {
    email_subject: '  Quick question for {{company}}  ',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.email_subject, 'Quick question for {{company}}')
  assert.equal(saved.body.campaign.emailSubject, 'Quick question for {{company}}')

  const detail = await client.get(`/api/campaigns/${campaign.id}/detail`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.emailSubject, 'Quick question for {{company}}')
  assert.equal(detail.body.settings.email_subject, 'Quick question for {{company}}')

  const col = db.prepare('SELECT email_subject FROM campaigns WHERE id = ?').get(campaign.id)
  assert.equal(col.email_subject, 'Quick question for {{company}}')
})

test('empty email_subject is allowed (compose-time fallback)', async () => {
  const { campaign } = readyEmailCampaign('subject-empty')
  await client.put(`/api/campaigns/${campaign.id}/settings`, {
    email_subject: 'Temporary subject',
  })
  const cleared = await client.put(`/api/campaigns/${campaign.id}/settings`, {
    email_subject: '   ',
  })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.settings.email_subject, '')
  assert.equal(cleared.body.campaign.emailSubject, '')
})

test('email_subject rejects line breaks and overlong values', async () => {
  const { campaign } = readyEmailCampaign('subject-invalid')
  const breaks = await client.put(`/api/campaigns/${campaign.id}/settings`, {
    email_subject: 'Hello\nWorld',
  })
  assert.equal(breaks.status, 422)
  assert.equal(breaks.body.field, 'email_subject')

  const long = await client.put(`/api/campaigns/${campaign.id}/settings`, {
    email_subject: 'x'.repeat(201),
  })
  assert.equal(long.status, 422)
  assert.equal(long.body.field, 'email_subject')
})
