import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolated DB + deterministic heuristic classifier (no API calls).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-test-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { simulateReply } = await import('../server/mailer.js')

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro our product to {{firstName}}]
  A -- reply: interested --> B[Send: propose a call]
  A -- reply: unsubscribe --> U([Unsubscribed])
  A -- no reply 3d --> F[Send: follow up]
  B -- reply --> W([Won: call booked])
  B -- no reply 3d --> L([Lost])
  F -- reply: interested --> B
  F -- no reply 3d --> L
`

// Seed: user, sandbox mailbox, campaign, three leads.
// require_approval is off here on purpose: these tests cover the unattended
// machinery (send, branch, time out). The approval gate has its own file.
db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:test@x.com', 'test@x.com', 'Test User', 0)").run()
const user = db.prepare('SELECT * FROM users WHERE id = 1').get()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (1, 'sandbox', 'sender@sandbox.local', 'Sandbox Sender')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Test', 'running', 1, ?)").run(PLAYBOOK)
const addLead = db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, ?, ?)")
addLead.run('alice@example.com', 'Alice')
addLead.run('bob@example.com', 'Bob')
addLead.run('carol@example.com', 'Carol')
const attach = db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, ?)')
attach.run(1); attach.run(2); attach.run(3)

const cl = (leadId) => db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = 1 AND lead_id = ?').get(leadId)
const outCount = (leadId) => db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'out'").get(leadId).n

test('first tick sends the intro email and parks leads waiting at A', async () => {
  await tick()
  for (const leadId of [1, 2, 3]) {
    assert.equal(outCount(leadId), 1, `lead ${leadId} got intro`)
    assert.equal(cl(leadId).state, 'waiting')
    assert.equal(cl(leadId).node_id, 'A')
    assert.ok(cl(leadId).thread_id.startsWith('sbx-thr-'))
  }
  const msg = db.prepare("SELECT * FROM messages WHERE lead_id = 1 AND direction = 'out'").get()
  assert.match(msg.body, /Alice/) // template compose merged the lead name
})

test('interested reply branches to B and sends the proposal', async () => {
  simulateReply({ user, campaignLead: cl(1), text: "This sounds interesting — tell me more, let's talk." })
  await tick()
  assert.equal(cl(1).node_id, 'B')
  assert.equal(cl(1).state, 'waiting')
  assert.equal(cl(1).intent, 'interested')
  assert.equal(outCount(1), 2)
  const inbound = db.prepare("SELECT * FROM messages WHERE lead_id = 1 AND direction = 'in'").get()
  assert.equal(inbound.intent, 'interested')
})

test('catch-all reply edge finishes the lead as won', async () => {
  simulateReply({ user, campaignLead: cl(1), text: 'Great, booked it. See you then!' })
  await tick()
  assert.equal(cl(1).state, 'finished')
  assert.equal(cl(1).outcome, 'won')
})

test('unsubscribe reply parks the lead for a person — the machine never opts out', async () => {
  // The classifier's reading of "unsubscribe" no longer acts on its own: it
  // once misread a quoted footer and opted a real lead out. The lead parks
  // with the reading attached; the opt-out needs a person (or the footer link).
  simulateReply({ user, campaignLead: cl(2), text: 'Please unsubscribe me from this list.' })
  await tick()
  assert.equal(cl(2).state, 'needs_attention')
  assert.equal(cl(2).intent, 'unsubscribe')
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = 2').get().status, 'active')
})

test('no-reply timeout follows the 3d edge to the follow-up', async () => {
  db.prepare("UPDATE messages SET created_at = datetime('now', '-4 days') WHERE lead_id = 3").run()
  await tick()
  assert.equal(cl(3).node_id, 'F')
  assert.equal(cl(3).state, 'waiting')
  assert.equal(outCount(3), 2) // intro + follow-up
})

test('unmatched intent flags the lead for attention', async () => {
  // Lead 3 waits at F, which only has "reply: interested" + timeout edges.
  simulateReply({ user, campaignLead: cl(3), text: 'Not interested, we already have a vendor.' })
  await tick()
  assert.equal(cl(3).state, 'needs_attention')
  assert.equal(cl(3).intent, 'not interested')
})

test('events log records the whole journey', () => {
  const types = db.prepare('SELECT DISTINCT type FROM events').all().map((r) => r.type)
  for (const expected of ['sent', 'reply', 'classified', 'branched', 'finished', 'needs_attention']) {
    assert.ok(types.includes(expected), `event type ${expected} logged`)
  }
})

test('engine respects mailbox daily limit', async () => {
  db.prepare('UPDATE mailboxes SET daily_limit = 0 WHERE id = 1').run()
  db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'dan@example.com', 'Dan')").run()
  const dan = db.prepare("SELECT id FROM leads WHERE email = 'dan@example.com'").get()
  attach.run(dan.id)
  await tick()
  assert.equal(outCount(dan.id), 0)
  assert.equal(cl(dan.id).state, 'active') // parked until quota resets
  db.prepare('UPDATE mailboxes SET daily_limit = 50 WHERE id = 1').run()
  await tick()
  assert.equal(outCount(dan.id), 1)
  assert.equal(cl(dan.id).state, 'waiting')
})
