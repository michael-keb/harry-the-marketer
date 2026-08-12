// Twilio SMS Phase 0/1 — opt-in gates, sandbox send, STOP webhook, playbook channel.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, mount } from './helpers/parity-harness.js'

setup('channels-sms')

const { db } = await import('../server/db.js')
const { parsePlaybook } = await import('../server/playbook.js')
const { toE164 } = await import('../server/channels/phone.js')
const { smsEligibility, sendSms } = await import('../server/channels/send.js')
const { smsKeyword } = await import('../server/channels/twilio.js')
const { register: registerChannels } = await import('../server/parity/channels.js')
const { tick } = await import('../server/engine.js')

const owner = seedUser(db, 'sms-owner@example.com')
// Opt out of approval so the engine can send SMS in this suite.
db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)

const mailbox = seedMailbox(db, owner.id, 'sms-mail@example.com')
const api = await mount(registerChannels, owner)
test.after(() => api.close())

function addSandboxSms(phone = '+61400000111') {
  const info = db.prepare(
    `INSERT INTO channel_accounts
       (workspace_id, channel, provider, display_name, phone_number, status, daily_limit)
     VALUES (?, 'sms', 'sandbox', 'Sandbox SMS', ?, 'connected', 50)`
  ).run(owner.id, phone)
  return db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(info.lastInsertRowid)
}

test('playbook parses Send sms: with channel sms and default email', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send email: Intro]
    A -- no reply 2d --> B[Send sms: Short nudge]
    B --> W([Won])
  `)
  assert.equal(g.valid, true)
  assert.equal(g.nodes.A.channel, 'email')
  assert.equal(g.nodes.A.instruction, 'Intro')
  assert.equal(g.nodes.B.channel, 'sms')
  assert.equal(g.nodes.B.instruction, 'Short nudge')
})

test('toE164 normalises AU mobiles', () => {
  assert.equal(toE164('0412 345 678'), '+61412345678')
  assert.equal(toE164('+61 412 345 678'), '+61412345678')
})

test('smsKeyword recognises STOP and START', () => {
  assert.equal(smsKeyword('STOP'), 'stop')
  assert.equal(smsKeyword(' stopall '), 'stop')
  assert.equal(smsKeyword('START'), 'start')
  assert.equal(smsKeyword('hello there'), null)
})

test('SMS refuses without opt-in', () => {
  const lead = seedLead(db, owner.id, 'no-opt@acme.test')
  db.prepare("UPDATE leads SET phone = ? WHERE id = ?").run('+61400000999', lead.id)
  const refreshed = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  const check = smsEligibility(owner.id, refreshed)
  assert.equal(check.ok, false)
  assert.equal(check.reason, 'no_opt_in')
})

test('sandbox SMS send records a channel message after opt-in', async () => {
  const account = addSandboxSms('+61400000222')
  const lead = seedLead(db, owner.id, 'opted@acme.test')
  db.prepare(
    `UPDATE leads SET phone = ?, sms_opt_in_at = datetime('now'), sms_opt_in_source = 'test' WHERE id = ?`
  ).run('+61400000333', lead.id)
  const campaign = seedCampaign(db, owner.id, 'SMS campaign', mailbox.id)
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id)
  const leadRow = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)

  const result = await sendSms({
    account,
    user: owner,
    campaign,
    lead: leadRow,
    nodeId: 'B',
    body: 'Quick nudge — free for a chat?',
  })
  assert.ok(result.providerMessageId)
  assert.equal(result.channel, 'sms')
  const msg = db.prepare("SELECT * FROM messages WHERE provider_message_id = ?").get(result.providerMessageId)
  assert.equal(msg.channel, 'sms')
  assert.equal(msg.direction, 'out')
  assert.equal(msg.to_email, '+61400000333')
  assert.equal(msg.channel_account_id, account.id)
})

test('channel-accounts API creates a sandbox SMS account', async () => {
  const res = await api.post('/api/channel-accounts', {
    channel: 'sms',
    provider: 'sandbox',
    display_name: 'API Sandbox',
    phone_number: '+61400000444',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.account.provider, 'sandbox')
  assert.equal(res.body.account.phoneNumber, '+61400000444')
  assert.ok(res.body.account.webhookUrl.includes('/api/hooks/twilio/sms'))
})

test('lead sms-opt-in endpoint records consent', async () => {
  const lead = seedLead(db, owner.id, 'consent@acme.test')
  const res = await api.post(`/api/leads/${lead.id}/sms-opt-in`, {
    phone: '0412 000 555',
    source: 'manual',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.phone, '+61412000555')
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  assert.ok(row.sms_opt_in_at)
  assert.equal(row.phone, '+61412000555')
})

test('TWILIO_* env auto-creates a workspace SMS account', async () => {
  const prev = {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
  }
  process.env.TWILIO_ACCOUNT_SID = 'ACenvtest000000000000000000000001'
  process.env.TWILIO_AUTH_TOKEN = 'env-token-test'
  process.env.TWILIO_FROM_NUMBER = '+61400000999'
  // Re-read env module fields used by ensureEnvSmsAccount
  const { env: envLive } = await import('../server/env.js')
  envLive.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID
  envLive.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN
  envLive.TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER

  const { ensureEnvSmsAccount, smsAccountFor } = await import('../server/channels/send.js')
  const account = ensureEnvSmsAccount(owner.id)
  assert.ok(account)
  assert.equal(account.provider, 'twilio')
  assert.equal(account.phone_number, '+61400000999')
  assert.equal(account.account_sid, 'ACenvtest000000000000000000000001')

  // With no other SMS accounts, smsAccountFor falls through to the env one.
  db.prepare("UPDATE channel_accounts SET deleted_at = datetime('now') WHERE workspace_id = ? AND id != ?")
    .run(owner.id, account.id)
  const campaign = seedCampaign(db, owner.id, 'Env SMS campaign', mailbox.id)
  const via = smsAccountFor(campaign)
  assert.equal(via.id, account.id)

  process.env.TWILIO_ACCOUNT_SID = prev.sid || ''
  process.env.TWILIO_AUTH_TOKEN = prev.token || ''
  process.env.TWILIO_FROM_NUMBER = prev.from || ''
  envLive.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID
  envLive.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN
  envLive.TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER
})

test('engine sends an SMS step when opt-in and sandbox account exist', async () => {
  const account = addSandboxSms('+61400000555')
  const lead = seedLead(db, owner.id, 'engine-sms@acme.test')
  db.prepare(
    `UPDATE leads SET phone = ?, sms_opt_in_at = datetime('now'), sms_opt_in_source = 'test' WHERE id = ?`
  ).run('+61400000666', lead.id)
  const campaign = seedCampaign(db, owner.id, 'Engine SMS', mailbox.id)
  db.prepare(
    `UPDATE campaigns SET status = 'running', mermaid = ? WHERE id = ?`
  ).run(`flowchart TD
  S([Start]) --> A[Send sms: Short hello]
  A --> W([Won])
`, campaign.id)
  db.prepare(
    'INSERT INTO campaign_channel_accounts (campaign_id, channel_account_id) VALUES (?, ?)'
  ).run(campaign.id, account.id)
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, lead.id)
  // A 24/7 window so the test asserts the SMS-send behaviour, not the wall clock:
  // SMS now correctly honours the sending window (a real fix — night-time SMS
  // breaches quiet-hours rules), so without this the run flakes outside 08:30–17:30.
  db.prepare("UPDATE users SET send_from = '00:00', send_to = '23:59', send_days = 'everyday', send_timezone = 'UTC' WHERE id = ?").run(owner.id)

  await tick()

  const out = db.prepare(
    "SELECT * FROM messages WHERE campaign_id = ? AND channel = 'sms' AND direction = 'out'"
  ).get(campaign.id)
  assert.ok(out, 'engine should have sent an SMS')
  assert.equal(out.to_email, '+61400000666')
})
