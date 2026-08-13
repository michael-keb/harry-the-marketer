// SMS in the unified inbox — an inbound text becomes a thread beside the email
// ones, and a manual reply goes back out through the thread's SMSFlow sender.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { setup, seedUser, seedLead, mount } from './helpers/parity-harness.js'

setup('inbox-sms')

const { db } = await import('../server/db.js')
const { sealSecret } = await import('../server/secrets.js')
const { smsflowWebhookToken, SMSFLOW_SID } = await import('../server/channels/smsflow.js')
const { smsflowRouter } = await import('../server/channels/webhook.js')
const { register: registerInbox } = await import('../server/parity/inbox.js')

const owner = seedUser(db, 'inbox-sms-owner@example.com')
const client = await mount(registerInbox, owner)
test.after(() => client.close())

const SENDER = '+61422777000'
const LEAD_PHONE = '+61400000123'

const accountInfo = db.prepare(
  `INSERT INTO channel_accounts
     (workspace_id, channel, provider, display_name, phone_number, account_sid, auth_token, status, daily_limit)
   VALUES (?, 'sms', 'smsflow', 'SMSFlow', ?, ?, ?, 'connected', 50)`
).run(owner.id, SENDER, SMSFLOW_SID, sealSecret('test-api-key'))
const account = db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(accountInfo.lastInsertRowid)

const lead = seedLead(db, owner.id, 'sms-lead@acme.test')
db.prepare(
  `UPDATE leads SET phone = ?, sms_opt_in_at = datetime('now'), sms_opt_in_source = 'test' WHERE id = ?`
).run(LEAD_PHONE, lead.id)

// ---- fetch mock: intercept SMSFlow, pass everything else through ------------
const realFetch = global.fetch
const sent = []
global.fetch = async (url, opts) => {
  if (!String(url).includes('api.smsflow.com.au')) return realFetch(url, opts)
  sent.push({ url: String(url), body: JSON.parse(opts.body) })
  return {
    ok: true,
    status: 200,
    json: async () => ({
      meta: { timezone: 'UTC' },
      data: [{ status: 'queued', message_id: `SF-INBOX-${sent.length}` }],
    }),
  }
}
test.after(() => { global.fetch = realFetch })

const hookApp = express()
hookApp.use('/api/hooks/smsflow', smsflowRouter)
const hookServer = await new Promise((resolve) => {
  const s = hookApp.listen(0, '127.0.0.1', () => resolve(s))
})
const hookBase = `http://127.0.0.1:${hookServer.address().port}`
test.after(() => new Promise((r) => hookServer.close(r)))

async function inboundSms(body, messageId) {
  const token = smsflowWebhookToken(account)
  const res = await realFetch(`${hookBase}/api/hooks/smsflow/sms?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: LEAD_PHONE, to: SENDER, body, message_id: messageId }),
  })
  return res
}

test('an inbound text shows up as an SMS thread in the unified inbox', async () => {
  const res = await inboundSms('Hey — yes, interested. Call me?', 'IN-HELLO-1')
  assert.equal(res.status, 200)

  const list = await client.get('/api/inbox/threads?state=active')
  assert.equal(list.status, 200)
  const smsRow = list.body.items.find((t) => t.channel === 'sms')
  assert.ok(smsRow, 'the text conversation is listed beside email threads')
  assert.equal(smsRow.lead.email, 'sms-lead@acme.test')
  assert.match(smsRow.last_message.body, /interested/)
  assert.equal(smsRow.is_read, false)

  const detail = await client.get(`/api/inbox/threads/${smsRow.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.channel, 'sms')
  assert.equal(detail.body.smsAccount.phoneNumber, SENDER)
  assert.equal(detail.body.smsAccount.sendable, true)
  assert.equal(detail.body.messages[0].channel, 'sms')
})

test('a manual reply from the inbox goes out through SMSFlow and joins the thread', async () => {
  const list = await client.get('/api/inbox/threads?state=active')
  const smsRow = list.body.items.find((t) => t.channel === 'sms')

  const noConfirm = await client.post(`/api/inbox/threads/${smsRow.id}/reply`, { body: 'On my way' })
  assert.equal(noConfirm.status, 422)

  const badFields = await client.post(`/api/inbox/threads/${smsRow.id}/reply`, {
    body: 'On my way', confirm: true, cc: ['x@y.z'],
  })
  assert.equal(badFields.status, 422)
  assert.equal(badFields.body.field, 'cc')

  const res = await client.post(`/api/inbox/threads/${smsRow.id}/reply`, {
    body: 'Great — calling you at 2pm.', confirm: true,
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.channel, 'sms')

  const call = sent.at(-1)
  assert.equal(call.body.to, LEAD_PHONE)
  assert.equal(call.body.from, SENDER)

  const out = db.prepare('SELECT * FROM messages WHERE id = ?').get(res.body.messageId)
  assert.equal(out.direction, 'out')
  assert.equal(out.channel, 'sms')
  assert.equal(out.manual_reply, 1)
  assert.equal(out.thread_id, smsRow.threadKey)
  assert.equal(out.channel_account_id, account.id)
})

test('after a STOP, the inbox refuses to text them again', async () => {
  const res = await inboundSms('STOP', 'IN-STOP-9')
  assert.equal(res.status, 200)

  const list = await client.get('/api/inbox/threads?state=all')
  const smsRow = list.body.items.find((t) => t.channel === 'sms')
  const reply = await client.post(`/api/inbox/threads/${smsRow.id}/reply`, {
    body: 'One more thing…', confirm: true,
  })
  assert.equal(reply.status, 422)
  assert.match(reply.body.message, /opted out|never-contact/)
})
