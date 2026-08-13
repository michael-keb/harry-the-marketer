// SMSFlow SMS — provider send, env auto-account, per-workspace allowlist,
// and the token-authenticated inbound webhook.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, mount } from './helpers/parity-harness.js'

setup('channels-smsflow')

const { db } = await import('../server/db.js')
const { env: envLive } = await import('../server/env.js')
const { sealSecret } = await import('../server/secrets.js')
const { smsflowWebhookToken, SMSFLOW_SID } = await import('../server/channels/smsflow.js')
const {
  sendSms, ensureEnvSmsAccount, smsAllowedForWorkspace,
} = await import('../server/channels/send.js')
const { smsflowRouter } = await import('../server/channels/webhook.js')
const { register: registerChannels } = await import('../server/parity/channels.js')

const owner = seedUser(db, 'smsflow-owner@example.com')
db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
const mailbox = seedMailbox(db, owner.id, 'smsflow-mail@example.com')
const api = await mount(registerChannels, owner)
test.after(() => api.close())

// ---- fetch mock ---------------------------------------------------------------
// SMSFlow calls go to api.smsflow.com.au; tests must never touch the network.
const realFetch = global.fetch
const sent = []
function mockSmsflowFetch({ status = 'queued', messageId } = {}) {
  global.fetch = async (url, opts) => {
    if (!String(url).includes('api.smsflow.com.au')) return realFetch(url, opts)
    sent.push({ url: String(url), body: JSON.parse(opts.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        meta: { timezone: 'UTC' },
        data: [{
          status,
          message_id: messageId || `SF-${sent.length}`,
          attributes: { to: JSON.parse(opts.body).to, body: JSON.parse(opts.body).body },
        }],
      }),
    }
  }
}
test.afterEach(() => { global.fetch = realFetch })

function addSmsflowAccount(wsId, phone = '+61422754149') {
  const info = db.prepare(
    `INSERT INTO channel_accounts
       (workspace_id, channel, provider, display_name, phone_number, account_sid, auth_token, status, daily_limit)
     VALUES (?, 'sms', 'smsflow', 'SMSFlow', ?, ?, ?, 'connected', 50)`
  ).run(wsId, phone, SMSFLOW_SID, sealSecret('test-api-key'))
  return db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(info.lastInsertRowid)
}

function optedInLead(email, phone) {
  const lead = seedLead(db, owner.id, email)
  db.prepare(
    `UPDATE leads SET phone = ?, sms_opt_in_at = datetime('now'), sms_opt_in_source = 'test' WHERE id = ?`
  ).run(phone, lead.id)
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
}

test('sendSms via smsflow provider posts to SMSFlow and records the message', async () => {
  mockSmsflowFetch()
  const account = addSmsflowAccount(owner.id)
  const lead = optedInLead('sf-send@acme.test', '+61400000111')
  const campaign = seedCampaign(db, owner.id, 'SMSFlow campaign', mailbox.id)
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id)

  const result = await sendSms({
    account, user: owner, campaign, lead, nodeId: 'B', body: 'Quick nudge — free for a chat?',
  })
  assert.match(result.providerMessageId, /^SF-/)
  const call = sent.at(-1)
  assert.equal(call.url, 'https://api.smsflow.com.au/v2/sms/send')
  assert.equal(call.body.to, '+61400000111')
  assert.equal(call.body.from, '+61422754149')
  assert.equal(call.body.body, 'Quick nudge — free for a chat?')
  assert.match(call.body.callback_url, /\/api\/hooks\/smsflow\/sms\?token=/)
  const msg = db.prepare('SELECT * FROM messages WHERE provider_message_id = ?').get(result.providerMessageId)
  assert.equal(msg.channel, 'sms')
  assert.equal(msg.channel_account_id, account.id)
})

test('SMSFLOW_* env auto-creates a workspace SMS account and wins over Twilio', () => {
  envLive.SMSFLOW_API_KEY = 'env-api-key'
  envLive.SMSFLOW_FROM_NUMBER = '+61422000111'
  envLive.TWILIO_ACCOUNT_SID = 'ACenvtest000000000000000000000002'
  envLive.TWILIO_AUTH_TOKEN = 'env-token'
  envLive.TWILIO_FROM_NUMBER = '+61400000222'
  try {
    const account = ensureEnvSmsAccount(owner.id)
    assert.ok(account)
    assert.equal(account.provider, 'smsflow')
    assert.equal(account.phone_number, '+61422000111')
    assert.equal(account.account_sid, SMSFLOW_SID)
    const again = ensureEnvSmsAccount(owner.id)
    assert.equal(again.id, account.id)
  } finally {
    envLive.SMSFLOW_API_KEY = ''
    envLive.SMSFLOW_FROM_NUMBER = ''
    envLive.TWILIO_ACCOUNT_SID = ''
    envLive.TWILIO_AUTH_TOKEN = ''
    envLive.TWILIO_FROM_NUMBER = ''
  }
})

test('channel-accounts API accepts an smsflow account and shows a tokened webhook', async () => {
  const res = await api.post('/api/channel-accounts', {
    channel: 'sms',
    provider: 'smsflow',
    display_name: 'API SMSFlow',
    phone_number: '+61422754149',
    auth_token: 'an-api-key',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.account.provider, 'smsflow')
  assert.match(res.body.account.webhookUrl, /\/api\/hooks\/smsflow\/sms\?token=[0-9a-f]{32}/)
})

test('two SMSFlow senders that share an API key advertise the same webhook URL', async () => {
  const first = await api.post('/api/channel-accounts', {
    channel: 'sms',
    provider: 'smsflow',
    display_name: 'Shared A',
    phone_number: '+61422754001',
    auth_token: 'shared-api-key',
  })
  const second = await api.post('/api/channel-accounts', {
    channel: 'sms',
    provider: 'smsflow',
    display_name: 'Shared B',
    phone_number: '+61422754002',
    auth_token: 'shared-api-key',
  })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(first.body.account.webhookUrl, second.body.account.webhookUrl)
  const list = await api.get('/api/channel-accounts?channel=sms')
  const listed = (list.body.accounts || []).filter((a) => String(a.displayName || '').startsWith('Shared'))
  assert.equal(listed.length, 2)
  assert.equal(listed[0].webhookUrl, listed[1].webhookUrl)
})

test('smsflow account without an API key is refused', async () => {
  const res = await api.post('/api/channel-accounts', {
    channel: 'sms',
    provider: 'smsflow',
    phone_number: '+61422754149',
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'auth_token')
})

test('SMS allowlist blocks unlisted workspaces from configuring and sending', async () => {
  envLive.SMS_ALLOWED_EMAILS = 'michael@praxis-au.com'
  try {
    assert.equal(smsAllowedForWorkspace(owner.id), false)
    assert.equal(ensureEnvSmsAccount(owner.id), null)

    const create = await api.post('/api/channel-accounts', {
      channel: 'sms', provider: 'sandbox', phone_number: '+61400000900',
    })
    assert.equal(create.status, 403)

    const account = addSmsflowAccount(owner.id, '+61422999888')
    const testSend = await api.post(`/api/channel-accounts/${account.id}/test-send`, {
      to: '+61400000901', confirm: true,
    })
    assert.equal(testSend.status, 403)

    const lead = optedInLead('blocked-ws@acme.test', '+61400000902')
    const campaign = seedCampaign(db, owner.id, 'Blocked SMS campaign', mailbox.id)
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id)
    await assert.rejects(
      sendSms({ account, user: owner, campaign, lead, nodeId: 'A', body: 'hi' }),
      /not enabled for this workspace/
    )

    const allowed = seedUser(db, 'michael@praxis-au.com')
    assert.equal(smsAllowedForWorkspace(allowed.id), true)

    const listing = await api.get('/api/channel-accounts?channel=sms')
    assert.equal(listing.status, 200)
    assert.equal(listing.body.smsAllowed, false)
  } finally {
    envLive.SMS_ALLOWED_EMAILS = ''
  }
})

test('smsflow inbound webhook honours the token and records STOP', async () => {
  mockSmsflowFetch()
  const account = addSmsflowAccount(owner.id, '+61422777666')
  const lead = optedInLead('sf-stop@acme.test', '+61400000777')

  const app = express()
  app.use('/api/hooks/smsflow', smsflowRouter)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (query, body) => fetch(`${base}/api/hooks/smsflow/sms${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  try {
    const params = {
      from: '+61400000777', to: '+61422777666', body: 'STOP', message_id: 'IN-STOP-1',
    }
    const bad = await post('?token=deadbeefdeadbeefdeadbeefdeadbeef', params)
    assert.equal(bad.status, 403)

    const token = smsflowWebhookToken(account)
    const ok = await post(`?token=${token}`, params)
    assert.equal(ok.status, 200)

    const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
    assert.ok(after.sms_opt_out_at)
    assert.equal(after.sms_opt_in_at, '')
    const blocked = db.prepare(
      "SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ? AND is_domain = 0"
    ).get(owner.id, '+61400000777')
    assert.ok(blocked)
    assert.equal(blocked.created_by, 'smsflow')
    const inbound = db.prepare("SELECT * FROM messages WHERE provider_message_id = 'IN-STOP-1'").get()
    assert.ok(inbound)
    assert.equal(inbound.direction, 'in')

    const replay = await post(`?token=${token}`, params)
    assert.equal(replay.status, 200)
    const count = db.prepare("SELECT COUNT(*) n FROM messages WHERE provider_message_id = 'IN-STOP-1'").get().n
    assert.equal(count, 1)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('smsflow status callback updates the outbound send_status', async () => {
  mockSmsflowFetch()
  const account = addSmsflowAccount(owner.id, '+61422777001')
  db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, channel_account_id, channel, direction,
        subject, body, from_email, to_email, provider_message_id, thread_id, send_status)
     VALUES (?, NULL, NULL, ?, 'sms', 'out', '', 'hi', ?, ?, 'OUT-STATUS-1', 'sms:1:+61400000000', 'sent')`
  ).run(owner.id, account.id, account.phone_number, '+61400000000')

  const app = express()
  app.use('/api/hooks/smsflow', smsflowRouter)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const token = smsflowWebhookToken(account)
    const res = await fetch(`${base}/api/hooks/smsflow/sms?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'status',
        message_id: 'OUT-STATUS-1',
        status: 'Sent and confirmed from carrier',
      }),
    })
    assert.equal(res.status, 200)
    const row = db.prepare("SELECT send_status FROM messages WHERE provider_message_id = 'OUT-STATUS-1'").get()
    assert.equal(row.send_status, 'delivered')
  } finally {
    await new Promise((r) => server.close(r))
  }
})
