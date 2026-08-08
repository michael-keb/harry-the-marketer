// Suppression is unconditional (Docs/README.md).
//
// The parity routes guard every entry point — import, push, manual reply — but
// those are doors, and a door only helps if you walk through it. A lead already
// attached to a running campaign when its domain is blocked, or added by some
// future route nobody has written yet, reaches the engine directly. So the
// guarantee has to hold at dispatch, in server/mailer.js, which is the one line
// every send passes through. These tests exercise that line through the real
// engine tick rather than by calling the checker directly.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-suppress-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { sendEmail } = await import('../server/mailer.js')

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- reply --> W([Won])
  A -- no reply 3d --> L([Lost])
`

// require_approval off: this file is about the send path, not the approval gate.
db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:s@x.com', 's@x.com', 'S', 0)").run()
const user = db.prepare('SELECT * FROM users WHERE id = 1').get()
db.prepare("INSERT INTO mailboxes (user_id, provider, email) VALUES (1, 'sandbox', 'sender@sandbox.local')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'S', 'running', 1, ?)").run(PLAYBOOK)

const addLead = db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (1, ?, ?)')
addLead.run('fine@allowed.test', 'Fine')          // 1 — should be emailed
addLead.run('ana@mail.blocked.test', 'Ana')       // 2 — subdomain of a blocked domain
addLead.run('quit@allowed.test', 'Quit')          // 3 — unsubscribed
addLead.run('bounced@allowed.test', 'Bounce')     // 4 — hard bounced

db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE email = 'quit@allowed.test'").run()
db.prepare("UPDATE leads SET status = 'bounced' WHERE email = 'bounced@allowed.test'").run()
db.prepare("INSERT INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (1, 'blocked.test', 1, 'manual')").run()

const attach = db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, ?)')
for (const id of [1, 2, 3, 4]) attach.run(id)

const sent = (leadId) => db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'out'").get(leadId).n
const row = (leadId) => db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = 1 AND lead_id = ?').get(leadId)

test('the engine emails a permitted lead and refuses every suppressed one', async () => {
  await tick()
  await tick()

  assert.equal(sent(1), 1, 'the permitted lead is emailed')
  assert.equal(sent(2), 0, 'a subdomain of a blocked domain is never emailed')
  assert.equal(sent(3), 0, 'an unsubscribed lead is never emailed')
  assert.equal(sent(4), 0, 'a hard-bounced lead is never emailed')
})

test('a refusal is terminal, not retried on the next tick', async () => {
  const before = row(2)
  assert.equal(before.state, 'finished', 'the lead is finished rather than left active')
  assert.equal(before.outcome, 'stopped')

  // Twenty more seconds of engine time must not produce a send or churn the row.
  await tick()
  assert.equal(sent(2), 0)
  assert.equal(row(2).updated_at, before.updated_at, 'the row is not touched again')
})

test('an unsubscribed lead finishes as unsubscribed, not as a generic stop', () => {
  assert.equal(row(3).outcome, 'unsubscribed')
})

test('the refusal is on the record with its reason', () => {
  // Only the blocked-domain lead reaches the send path. An unsubscribed or
  // bounced lead is stopped earlier, by the engine's own `leads.status` check —
  // which is why the two guards are not redundant: that one catches a lead
  // whose own record says no, and this one catches a lead whose record is fine
  // but whose domain went onto the never-contact list after they were attached.
  const events = db.prepare("SELECT * FROM events WHERE type = 'suppressed' ORDER BY id").all()
  assert.equal(events.length, 1)
  assert.match(events[0].detail, /never-contact list \(blocked\.test\)/)

  const stoppedEarlier = db.prepare(
    "SELECT lead_id, detail FROM events WHERE type = 'finished' AND detail LIKE '%not active%'"
  ).all().map((e) => e.lead_id)
  assert.deepEqual(stoppedEarlier.sort(), [3, 4], 'unsubscribed and bounced never reach the send path at all')
})

test('sendEmail itself refuses, so no future caller can route around it', async () => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = 1').get()
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = 1').get()
  const lead = db.prepare("SELECT * FROM leads WHERE email = 'ana@mail.blocked.test'").get()

  await assert.rejects(
    () => sendEmail({ mailbox, user, campaign, lead, nodeId: 'A', subject: 'Hi', body: 'Hello' }),
    (err) => err.suppressed === true && err.reason === 'blocked'
  )
  assert.equal(sent(lead.id), 0)
})

test('blocking a domain after a campaign is running still stops the next send', async () => {
  addLead.run('later@newlyblocked.test', 'Later')
  const later = db.prepare("SELECT * FROM leads WHERE email = 'later@newlyblocked.test'").get()
  attach.run(later.id)

  // Blocked only now — after the lead was attached and the campaign started.
  db.prepare("INSERT INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (1, 'newlyblocked.test', 1, 'manual')").run()

  await tick()
  await tick()
  assert.equal(sent(later.id), 0, 'a block applied later is honoured by the running campaign')
  assert.equal(row(later.id).state, 'finished')
})
