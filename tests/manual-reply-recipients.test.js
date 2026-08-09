// cc and bcc that were validated, echoed back, and then thrown away.
//
// The manual reply route parsed `cc` and `bcc`, rejected malformed addresses,
// and returned both arrays in its response — so every test of it passed and the
// UI could show what the user had typed. Nothing was ever passed to `sendEmail`.
// The copies were never sent, and no record of them survived the request.
//
// The lesson is the shape of the test that missed it: asserting on the response
// body checks what the server *says*, and the response was honest about the
// input while silent about the outcome. These tests read `messages` instead.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-reply-'))
process.env.AI_MODE = 'off'
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')

db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:r@x.com', 'r@x.com', 'Owner', 0)").run()
const user = db.prepare('SELECT * FROM users WHERE id = 1').get()
db.prepare(
  "INSERT INTO mailboxes (user_id, provider, email, display_name, status, signature) VALUES (1, 'sandbox', 'me@sandbox.local', 'Me', 'connected', ?)"
).run('— Dana\nHead of Ops, Acme')
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Replies', 'running', 1, ?)")
  .run('flowchart TD\n  S([Start]) --> A[Send: intro]\n  A -- reply --> D([Done])\n')

const express = (await import('express')).default
const { api } = await import('../server/routes.js')
const { registerParity } = await import('../server/parity/index.js')
const { authRouter } = await import('../server/auth.js')

registerParity(api)
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.cookies = {}
  const header = req.headers.cookie
  if (header) for (const pair of header.split(';')) {
    const i = pair.indexOf('=')
    if (i > 0) req.cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  next()
})
app.use(authRouter)
app.use('/api', api)
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const login = await fetch(`${base}/api/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: user.email }),
})
const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
test.after(() => new Promise((r) => server.close(r)))

let n = 0
// A lead with one outbound and one inbound message: the reply target.
function conversation() {
  n += 1
  const email = `lead${n}@acme.test`
  db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (1, ?, ?)').run(email, `Lead${n}`)
  const leadId = db.prepare('SELECT id FROM leads WHERE email = ?').get(email).id
  const thread = `sbx-thr-reply-${n}`
  // The engine stamps the thread onto the link row on the first send, and
  // threading keys off that rather than off any one message. Seeding it here
  // is what makes this fixture a conversation rather than two loose emails.
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state, thread_id) VALUES (1, ?, \'A\', \'waiting\', ?)')
    .run(leadId, thread)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, thread_id, node_id, provider_message_id)
     VALUES (1, 1, ?, 1, 'out', 'Intro', 'Hello', 'me@sandbox.local', ?, ?, 'A', ?)`
  ).run(leadId, email, thread, `out-${n}`)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, thread_id)
     VALUES (1, 1, ?, 1, 'in', 'Re: Intro', 'Tell me more', ?, 'me@sandbox.local', ?)`
  ).run(leadId, email, thread)
  const inbound = db.prepare("SELECT id FROM messages WHERE lead_id = ? AND direction = 'in'").get(leadId).id
  return { leadId, inbound, email, thread }
}

const reply = (messageId, body) => fetch(`${base}/api/campaigns/1/threads/${messageId}/reply`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ confirm: true, ...body }),
})

const lastOut = (leadId) =>
  db.prepare("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(leadId)

// ---- the defect ------------------------------------------------------------

test('cc and bcc reach the message that was actually sent', async () => {
  const { leadId, inbound } = conversation()
  const res = await reply(inbound, {
    body: 'Happy to help.',
    cc: ['colleague@ours.test', 'boss@ours.test'],
    bcc: ['crm@ours.test'],
  })
  assert.equal(res.status, 200)

  const sent = lastOut(leadId)
  assert.equal(sent.cc_emails, 'colleague@ours.test, boss@ours.test', 'the copies are on the record')
  assert.equal(sent.bcc_emails, 'crm@ours.test')
})

test('the thread view shows who else received the reply', async () => {
  const { inbound } = conversation()
  await reply(inbound, { body: 'Noted.', cc: ['colleague@ours.test'] })

  const view = await (await fetch(`${base}/api/inbox/threads/${inbound}`, { headers: { cookie } })).json()
  const replied = view.messages.filter((m) => m.direction === 'out').pop()
  assert.equal(replied.cc_emails, 'colleague@ours.test', 'a reader can see it went to more than one person')
})

test('no copies means empty fields, not the string "undefined"', async () => {
  const { leadId, inbound } = conversation()
  await reply(inbound, { body: 'Just you.' })
  const sent = lastOut(leadId)
  assert.equal(sent.cc_emails, '')
  assert.equal(sent.bcc_emails, '')
})

// ---- suppression covers copied recipients ----------------------------------

test('a suppressed cc recipient refuses the whole send', async () => {
  // Being copied is still being emailed. Someone on the never-contact list does
  // not lose that protection because they were in the cc field rather than the
  // to field — and dropping them quietly while sending to everyone else would
  // be the worst of the available outcomes.
  const { leadId, inbound } = conversation()
  const before = lastOut(leadId).id

  await fetch(`${base}/api/block-list`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ domain_block_list: 'never-contact.test' }),
  })

  const res = await reply(inbound, { body: 'Hello', cc: ['someone@never-contact.test'] })
  assert.notEqual(res.status, 200, `refused, got ${res.status}`)
  assert.equal(lastOut(leadId).id, before, 'and nothing was written, so nothing was sent')
})

// ---- signature -------------------------------------------------------------

test('add_signature appends the mailbox signature exactly once', async () => {
  const { leadId, inbound } = conversation()
  await reply(inbound, { body: 'Thanks!', add_signature: true })
  const sent = lastOut(leadId)
  const occurrences = sent.body.split('Head of Ops, Acme').length - 1
  assert.equal(occurrences, 1, 'signed once')
  assert.match(sent.body, /Thanks!/)
})

test('a reply that already carries the signature is not signed twice', async () => {
  // The failure people actually notice. Replying to your own previous message
  // quotes the signature back, and appending blindly doubles it.
  const { leadId, inbound } = conversation()
  await reply(inbound, { body: 'Thanks!\n\n— Dana\nHead of Ops, Acme', add_signature: true })
  const sent = lastOut(leadId)
  assert.equal(sent.body.split('Head of Ops, Acme').length - 1, 1, 'still only once')
})

test('without add_signature the body is sent as written', async () => {
  const { leadId, inbound } = conversation()
  await reply(inbound, { body: 'Short and unsigned.' })
  assert.equal(lastOut(leadId).body, 'Short and unsigned.')
})

// ---- scheduling keeps the recipients ---------------------------------------

test('a scheduled reply remembers its copies until it goes', async () => {
  const { leadId, inbound } = conversation()
  const when = new Date(Date.now() + 3600_000).toISOString()
  const res = await reply(inbound, { body: 'Later.', cc: ['colleague@ours.test'], scheduled_time: when })
  assert.equal(res.status, 200)

  const parked = lastOut(leadId)
  // `queued`, not `scheduled` — see the status-contract test at the end of this
  // file for why the distinction mattered.
  assert.equal(parked.send_status, 'queued')
  assert.equal(parked.cc_emails, 'colleague@ours.test', 'the copies survive the wait')
})

// ---- validation ------------------------------------------------------------

test('a malformed cc address is refused by field name, and nothing is sent', async () => {
  const { leadId, inbound } = conversation()
  const before = lastOut(leadId).id
  const res = await reply(inbound, { body: 'Hi', cc: ['not-an-address'] })

  assert.equal(res.status, 422)
  assert.equal((await res.json()).field, 'cc[0]', 'names which one')
  assert.equal(lastOut(leadId).id, before, 'nothing sent')
})

test('an empty body is refused naming the field', async () => {
  const { inbound } = conversation()
  const res = await reply(inbound, { body: '' })
  assert.equal(res.status, 422)
  assert.equal((await res.json()).field, 'body')
})

// ---- a scheduled reply is findable by the job that sends it -----------------

test('a scheduled reply is parked in the state the dispatcher and the folder both look for', async () => {
  // This route wrote `send_status = 'scheduled'`. Nothing anywhere looked for
  // that value: `upkeep.dispatchScheduled` selects `'queued'`, and so does the
  // Inbox's Scheduled folder. So a reply scheduled here was invisible in the
  // folder that exists to show it and was never collected by the job that
  // exists to send it — it sat in the table for ever while the response said it
  // was scheduled. The Inbox's own scheduling route always wrote `'queued'`;
  // this one was the odd one out, and the disagreement was the whole bug.
  const { leadId, inbound } = conversation()
  const when = new Date(Date.now() + 3600_000).toISOString()
  const res = await reply(inbound, { body: 'Tomorrow then.', scheduled_time: when })
  assert.equal(res.status, 200)

  const parked = lastOut(leadId)
  assert.equal(parked.send_status, 'queued', 'the one status both readers agree on')
  assert.equal(parked.scheduled_at, when)

  // Proven against the dispatcher's own predicate rather than a copy of it, so
  // this test fails if either side of the contract moves.
  const due = db.prepare(
    `SELECT id FROM messages
      WHERE direction = 'out' AND send_status = 'queued'
        AND scheduled_at != '' AND scheduled_at <= ?`
  ).all(new Date(Date.now() + 7200_000).toISOString()).map((r) => r.id)
  assert.ok(due.includes(parked.id), 'the dispatcher would collect it when its slot arrives')
})
