// The standing rule: nothing sends without your OK.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-approvals-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { openDraft, pendingDrafts, pendingCount } = await import('../server/drafts.js')

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro to {{firstName}}]
  A -- reply: interested --> B[Send: propose a call]
  A -- no reply 3d --> L([Lost])
`

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:a@x.com', 'a@x.com', 'Approver')").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email) VALUES (1, 'sandbox', 'me@sandbox.local')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Gated', 'running', 1, ?)").run(PLAYBOOK)
db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'lee@example.com', 'Lee')").run()
db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, 1)').run()

const cl = () => db.prepare('SELECT * FROM campaign_leads WHERE id = 1').get()
const sent = () => db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out'").get().n

test('approval is on by default, so the first tick writes but does not send', async () => {
  await tick()
  assert.equal(sent(), 0, 'nothing left the building')
  const draft = openDraft(1, 1)
  assert.ok(draft, 'the email is waiting for a human')
  assert.equal(draft.status, 'pending')
  assert.equal(draft.node_id, 'A')
  assert.match(draft.body, /Lee/, 'it is a real, personalised email — not a placeholder')
  assert.equal(cl().state, 'active')
})

test('waiting on a human does not re-write the email every tick', async () => {
  await tick()
  await tick()
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts').get().n, 1)
  assert.equal(sent(), 0)
})

test('the queue carries enough context to decide without opening anything else', () => {
  const [item] = pendingDrafts(1)
  assert.equal(item.lead_email, 'lee@example.com')
  assert.equal(item.campaign_name, 'Gated')
  assert.equal(item.campaign_status, 'running')
  assert.equal(pendingCount(1), 1)
})

test('approving sends exactly what was approved, edits included', async () => {
  db.prepare("UPDATE drafts SET status = 'approved', subject = 'My subject', body = 'My words.' WHERE id = 1").run()
  await tick()
  assert.equal(sent(), 1)
  const msg = db.prepare("SELECT * FROM messages WHERE direction = 'out'").get()
  assert.equal(msg.subject, 'My subject')
  assert.equal(msg.body, 'My words.')
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = 1').get().status, 'sent')
  assert.equal(cl().state, 'waiting', 'the lead carries on through the playbook')
  assert.equal(pendingCount(1), 0)
})

test('turning the gate off flushes a waiting draft rather than stranding it', async () => {
  db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'kit@example.com', 'Kit')").run()
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, 2)').run()
  await tick()
  assert.equal(openDraft(1, 2).status, 'pending')

  db.prepare('UPDATE users SET require_approval = 0 WHERE id = 1').run()
  await tick()
  const msg = db.prepare("SELECT * FROM messages WHERE direction = 'out' AND lead_id = 2").get()
  assert.ok(msg, 'the email that was already written is the one that went')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts WHERE lead_id = 2').get().n, 1, 'no second email was composed')
  assert.equal(pendingCount(1), 0, 'nothing left stranded in the queue')
})

test('an email queued for a step the lead has left is dropped, not sent', async () => {
  db.prepare('UPDATE users SET require_approval = 1 WHERE id = 1').run()
  db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'ravi@example.com', 'Ravi')").run()
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, 3)').run()
  await tick()
  const queued = openDraft(1, 3)
  assert.equal(queued.node_id, 'A')

  // The lead is rerouted to B while the email written for A is still queued.
  db.prepare("UPDATE campaign_leads SET node_id = 'B', state = 'active' WHERE campaign_id = 1 AND lead_id = 3").run()
  await tick()
  const replacement = openDraft(1, 3)
  assert.ok(replacement, 'a fresh email is written for the step the lead is actually on')
  assert.equal(replacement.node_id, 'B')
  assert.notEqual(replacement.body, queued.body, 'it is a different email, not the old one relabelled')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND lead_id = 3").get().n, 0)
  const dropped = db.prepare("SELECT * FROM events WHERE type = 'draft_stale' AND lead_id = 3").get()
  assert.ok(dropped, 'and the trail explains where the first one went')
  db.prepare("UPDATE drafts SET status = 'declined' WHERE id = ?").run(replacement.id)
  db.prepare('UPDATE users SET require_approval = 0 WHERE id = 1').run()
})

test('with the gate off a new lead sends without a draft at all', async () => {
  db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'sam@example.com', 'Sam')").run()
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, 4)').run()
  await tick()
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND lead_id = 4").get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts WHERE lead_id = 4').get().n, 0)
})
