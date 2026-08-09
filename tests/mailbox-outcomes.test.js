// Won, lost and unsubscribed reading zero on every mailbox — not because there
// were none, but because the row never arrived.
//
// The reporting rollup groups rows by a key the caller picks. For the mailbox
// surfaces that key is `row.mailbox_id`. Sends and replies carry one, because
// they come from `messages`. Outcomes come from `campaign_leads`, and the query
// that fetched them selected campaign, lead, outcome and timestamp — no
// mailbox. So `row.mailbox_id` was `undefined`, the grouping produced no
// bucket, and the row was dropped.
//
// Nothing errored. Every mailbox reported 0 won, 0 lost, 0 unsubscribed, which
// is indistinguishable from a quiet week, which is why it survived so long.
// These tests set up outcomes that are definitely non-zero and insist the
// mailbox figures say so.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-mbout-'))
process.env.AI_MODE = 'off'
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:mo@x.com', 'mo@x.com', 'Owner')").run()
const addMailbox = db.prepare("INSERT INTO mailboxes (user_id, provider, email, status) VALUES (1, 'sandbox', ?, 'connected')")
addMailbox.run('one@sandbox.local')   // id 1
addMailbox.run('two@sandbox.local')   // id 2
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id) VALUES (1, 'C', 'running', 1)").run()

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
  body: JSON.stringify({ email: 'mo@x.com' }),
})
const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
test.after(() => new Promise((r) => server.close(r)))

// A lead emailed from `mailboxId`, finishing on `outcome`.
let seq = 0
function finished(mailboxId, outcome) {
  seq += 1
  const email = `o${seq}@acme.test`
  db.prepare('INSERT INTO leads (user_id, email) VALUES (1, ?)').run(email)
  const leadId = db.prepare('SELECT id FROM leads WHERE email = ?').get(email).id
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status)
     VALUES (1, 1, ?, ?, 'out', 'Hi', 'Body', ?, ?, 'sent')`
  ).run(leadId, mailboxId, email, `mo-${seq}`)
  db.prepare(
    `INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state, outcome, unsubscribed_at, completed_at)
     VALUES (1, ?, 'A', 'finished', ?, ?, ?)`
  ).run(
    leadId, outcome,
    outcome === 'unsubscribed' ? new Date().toISOString() : '',
    outcome === 'unsubscribed' ? '' : new Date().toISOString()
  )
  return leadId
}

// Mailbox 1: two won, one lost, one unsubscribed. Mailbox 2: one won.
finished(1, 'won'); finished(1, 'won'); finished(1, 'lost'); finished(1, 'unsubscribed')
finished(2, 'won')

// The route caps how wide a window it will scan, so this asks for the last
// month rather than the last century — everything seeded above is stamped now.
const health = async () => {
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const res = await fetch(`${base}/api/analytics/mailboxes/health?from=${day(-7)}&to=${day(1)}`, { headers: { cookie } })
  assert.equal(res.status, 200)
  const body = await res.json()
  const rows = body.items || body.data || []
  return new Map(rows.map((r) => [r.mailbox_id, r]))
}

test('a mailbox reports the outcomes it actually produced', async () => {
  const rows = await health()
  const one = rows.get(1)
  assert.ok(one, 'the mailbox is listed')
  assert.equal(one.won, 2, 'two won')
  assert.equal(one.lost, 1, 'one lost')
  assert.equal(one.unsubscribed, 1, 'one unsubscribed')
})

test('outcomes land on the mailbox that sent, not on all of them', async () => {
  // The other half of the bug: a fix that attributed every outcome to every
  // mailbox would also make the zeros go away, and would be just as wrong.
  const rows = await health()
  assert.equal(rows.get(2).won, 1, 'the second mailbox has only its own')
  assert.equal(rows.get(2).lost, 0)
  assert.equal(rows.get(2).unsubscribed, 0)
})

test('the mailbox figures add up to the workspace total', async () => {
  const rows = await health()
  const summed = [...rows.values()].reduce(
    (acc, r) => ({ won: acc.won + r.won, lost: acc.lost + r.lost, unsubscribed: acc.unsubscribed + r.unsubscribed }),
    { won: 0, lost: 0, unsubscribed: 0 }
  )
  assert.equal(summed.won, 3, 'every won outcome is attributed to exactly one mailbox')
  assert.equal(summed.lost, 1)
  assert.equal(summed.unsubscribed, 1)
})

test('a mailbox that has done nothing reads zero rather than vanishing', async () => {
  addMailbox.run('silent@sandbox.local')
  const silent = db.prepare('SELECT id FROM mailboxes WHERE email = ?').get('silent@sandbox.local').id
  const rows = await health()
  const row = rows.get(silent)
  assert.ok(row, 'still listed — absence and zero are different answers')
  assert.equal(row.won, 0)
  assert.equal(row.unsubscribed, 0)
})

test('an outcome reached before anything was sent still finds a mailbox', async () => {
  // Falls back to the campaign's own mailbox rather than being dropped, which
  // is the same silent loss in a rarer shape.
  db.prepare('INSERT INTO leads (user_id, email) VALUES (1, ?)').run('never-emailed@acme.test')
  const leadId = db.prepare('SELECT id FROM leads WHERE email = ?').get('never-emailed@acme.test').id
  db.prepare(
    `INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state, outcome, completed_at)
     VALUES (1, ?, 'A', 'finished', 'lost', ?)`
  ).run(leadId, new Date().toISOString())

  const rows = await health()
  assert.equal(rows.get(1).lost, 2, 'attributed to the campaign mailbox')
})
