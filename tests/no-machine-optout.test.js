// The machine may read a reply as an unsubscribe; it may never act on it.
//
// Acting means suppression, and the classifier has been wrong about exactly
// this — a quoted footer under "ok thanks" once opted a real lead out. Now a
// classifier-made 'unsubscribe' parks the lead as needs_attention with the
// reading attached, and the opt-out itself only ever comes from the
// recipient's own footer click or a person confirming the reply (setBy).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-no-optout-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { tick, campaignCtx, routeReply } = await import('../server/engine.js')
const { simulateReply } = await import('../server/mailer.js')

// An explicit unsubscribe edge, so the test proves the gate fires even when
// the playbook says exactly where an unsubscribe should go.
const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- reply: interested --> W([Won])
  A -- reply: unsubscribe --> U([Unsubscribed])
  A -- no reply 3d --> L([Lost])
`

db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:m@x.com', 'm@x.com', 'M', 0)").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email) VALUES (1, 'sandbox', 'sender@sandbox.local')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'C', 'running', 1, ?)").run(PLAYBOOK)
db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'lead@example.test', 'Lee')").run()
db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, 1)').run()

const cl = () => db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = 1 AND lead_id = 1').get()
const lead = () => db.prepare('SELECT * FROM leads WHERE id = 1').get()
const blocked = () => db.prepare("SELECT COUNT(*) n FROM blocked_domains WHERE workspace_id = 1 AND lower(trim(value)) = 'lead@example.test'").get().n

test('a classifier-read unsubscribe parks the lead instead of opting them out', async () => {
  await tick() // sends the intro
  assert.equal(cl().state, 'waiting')

  simulateReply({ user: db.prepare('SELECT * FROM users WHERE id = 1').get(), campaignLead: cl(), text: 'Please unsubscribe me from these emails.' })
  await tick() // classifies (heuristic, AI off) and routes

  const row = cl()
  assert.equal(row.state, 'needs_attention')
  assert.equal(row.intent, 'unsubscribe')
  assert.equal(lead().status, 'active')
  assert.equal(String(lead().unsubscribed_at || ''), '')
  assert.equal(blocked(), 0)
  const parked = db.prepare(
    "SELECT COUNT(*) n FROM events WHERE lead_id = 1 AND type = 'needs_attention' AND detail LIKE '%confirm%'"
  ).get().n
  assert.ok(parked >= 1)
})

test('the parked lead is not picked up again by the next tick', async () => {
  await tick()
  assert.equal(cl().state, 'needs_attention')
  assert.equal(lead().status, 'active')
})

test('a person confirming the unsubscribe still opts the lead out', async () => {
  db.prepare("UPDATE campaign_leads SET state = 'waiting' WHERE id = ?").run(cl().id)
  const ctx = campaignCtx(1)
  await routeReply(ctx, cl(), 'unsubscribe', null, { setBy: 'm@x.com' })
  assert.equal(lead().status, 'unsubscribed')
  assert.equal(blocked(), 1)
  assert.equal(cl().outcome, 'unsubscribed')
})
