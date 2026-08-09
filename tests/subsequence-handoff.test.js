// Subsequences that a lead could never reach.
//
// Creating a child campaign worked: it was linked to its parent, the triggers
// were validated and stored, and both campaigns could see the link. Nothing
// moved. There was no code anywhere that read those triggers, so a subsequence
// was a campaign with a `parent_campaign_id` and no way in — three of eight
// acceptance criteria, and the five missing ones were the entire feature.
//
// Every test here runs the engine and then asks which campaign the lead is
// actually in, because "the trigger is stored" was exactly the claim that held
// while the feature did nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-subseq-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { simulateReply } = await import('../server/mailer.js')

const PARENT_PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: cold intro]
  A -- reply: interested --> B[Send: propose a call]
  A -- reply: not now --> N([Lost])
  A -- no reply 3d --> L([Lost])
`
const CHILD_PLAYBOOK = `flowchart TD
  S([Start]) --> C[Send: the warm follow-up written for this]
  C -- reply --> W([Won])
`

db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:s@x.com', 's@x.com', 'Owner', 0)").run()
const user = db.prepare('SELECT * FROM users WHERE id = 1').get()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (1, 'sandbox', 'me@sandbox.local', 'Me')").run()

const addCampaign = db.prepare(
  `INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid, parent_campaign_id, settings)
   VALUES (1, ?, ?, ?, ?, ?, ?)`
)
function campaign(name, { status = 'running', mailbox = 1, mermaid = CHILD_PLAYBOOK, parent = null, triggers = null } = {}) {
  addCampaign.run(name, status, mailbox, mermaid, parent, triggers ? JSON.stringify({ triggers }) : '{}')
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(db.prepare('SELECT MAX(id) id FROM campaigns').get().id)
}

const parent = campaign('Cold outbound', { mermaid: PARENT_PLAYBOOK })
const interestedChild = campaign('Warm — they bit', { parent: parent.id, triggers: ['interested'] })
const quietChild = campaign('Went quiet', { parent: parent.id, triggers: ['lost'] })

let seq = 0
function enrol(campaignId = parent.id) {
  seq += 1
  const email = `s${seq}@acme.test`
  db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (1, ?, ?)').run(email, `S${seq}`)
  const leadId = db.prepare('SELECT id FROM leads WHERE email = ?').get(email).id
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, leadId)
  return leadId
}

const link = (campaignId, leadId) =>
  db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId)
const outCount = (campaignId, leadId) =>
  db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out'").get(campaignId, leadId).n
const eventTypes = (leadId) =>
  db.prepare('SELECT type, detail, campaign_id FROM events WHERE lead_id = ? ORDER BY id').all(leadId)

// ---- the handoff -----------------------------------------------------------

test('a lead matching a trigger leaves the parent and enters the child', async () => {
  const leadId = enrol()
  await tick() // intro goes out, lead parks at A
  simulateReply({ user, campaignLead: link(parent.id, leadId), text: 'This sounds interesting — tell me more.' })
  await tick()

  assert.equal(link(parent.id, leadId).outcome, 'moved', 'the parent link is closed, not deleted')
  const child = link(interestedChild.id, leadId)
  assert.ok(child, 'and the lead is in the child campaign')
  assert.notEqual(child.state, 'finished')
})

test('the handoff names the triggering event on both campaigns', async () => {
  const leadId = enrol()
  await tick()
  simulateReply({ user, campaignLead: link(parent.id, leadId), text: 'Interested, tell me more.' })
  await tick()

  const trail = eventTypes(leadId)
  const out = trail.find((e) => e.type === 'handed_off')
  const into = trail.find((e) => e.type === 'handed_in')
  assert.ok(out, 'the parent records the departure')
  assert.match(out.detail, /"interested"/, 'naming what triggered it')
  assert.match(out.detail, /Warm — they bit/, 'and where they went')
  assert.ok(into, 'the child records the arrival')
  assert.equal(into.campaign_id, interestedChild.id)
})

test('the parent sends nothing further — one person, one playbook', async () => {
  const leadId = enrol()
  await tick()
  const beforeParent = outCount(parent.id, leadId)
  simulateReply({ user, campaignLead: link(parent.id, leadId), text: 'Interested, tell me more.' })
  await tick()
  await tick()
  await tick()

  assert.equal(outCount(parent.id, leadId), beforeParent, 'the parent composed nothing after the handoff')
  assert.ok(outCount(interestedChild.id, leadId) > 0, 'and the child picked the conversation up')
})

test('the child playbook is what actually sends', async () => {
  const leadId = enrol()
  await tick()
  simulateReply({ user, campaignLead: link(parent.id, leadId), text: 'Interested, tell me more.' })
  await tick()
  await tick()

  const sent = db.prepare(
    "SELECT node_id, body FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1"
  ).get(interestedChild.id, leadId)
  assert.ok(sent, 'the child sent something')
  assert.equal(sent.node_id, 'C', 'from the child playbook’s own step')
})

test('an outcome can trigger a handoff too', async () => {
  // Going quiet is the commonest reason to move someone to a different
  // playbook, and it arrives as an outcome rather than as a reply.
  const leadId = enrol()
  await tick()
  // Age the last email past the parent's "no reply 3d" edge.
  db.prepare("UPDATE messages SET created_at = datetime('now', '-9 days') WHERE lead_id = ? AND direction = 'out'").run(leadId)
  db.prepare("UPDATE campaign_leads SET wait_until = '' WHERE campaign_id = ? AND lead_id = ?").run(parent.id, leadId)
  await tick()

  assert.ok(link(quietChild.id, leadId), 'the lead moved to the quiet-lead playbook')
  assert.equal(link(parent.id, leadId).outcome, 'moved')
})

// ---- the guards ------------------------------------------------------------

test('an unsubscribed lead is never handed off', async () => {
  // Unsubscribe outranks every routing rule. Moving someone who has opted out
  // into a fresh playbook is how an opt-out gets lost.
  const leadId = enrol()
  await tick()
  db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(leadId)
  simulateReply({ user, campaignLead: link(parent.id, leadId), text: 'Interested, tell me more.' })
  await tick()
  await tick()

  assert.equal(link(interestedChild.id, leadId), undefined, 'they went nowhere')
  assert.equal(outCount(interestedChild.id, leadId), 0, 'and nothing was sent')
})

test('a child that cannot send parks the lead for a person instead of dropping it', async () => {
  // The lead must end up somewhere a human will look. Neither in the parent
  // nor anywhere else is the outcome the spec rules out.
  const broken = campaign('No mailbox', { parent: parent.id, triggers: ['not now'], mailbox: null })
  const leadId = enrol()
  await tick()
  simulateReply({ user, campaignLead: link(parent.id, leadId), text: 'Not right now, we just renewed. Try me next year.' })
  await tick()

  assert.equal(link(broken.id, leadId), undefined, 'not moved into a campaign that cannot send')
  assert.equal(link(parent.id, leadId).state, 'needs_attention', 'parked for a person')
  const flagged = eventTypes(leadId).find((e) => e.type === 'needs_attention')
  assert.ok(flagged)
  assert.match(flagged.detail, /has no mailbox/, 'and says what is wrong')
})

test('a trigger nobody declared moves nobody', async () => {
  const leadId = enrol()
  await tick()
  simulateReply({ user, campaignLead: link(parent.id, leadId), text: 'What does this integrate with?' })
  await tick()

  for (const c of [interestedChild.id, quietChild.id]) {
    assert.equal(link(c, leadId), undefined, `stayed out of #${c}`)
  }
})

test('a lead is not enrolled in the same child twice', async () => {
  const leadId = enrol()
  await tick()
  simulateReply({ user, campaignLead: link(parent.id, leadId), text: 'Interested, tell me more.' })
  await tick()
  await tick()
  await tick()

  const rows = db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .get(interestedChild.id, leadId).n
  assert.equal(rows, 1)
})

test('approvals still apply in the child — a handoff is not permission to send', async () => {
  // The standing rule does not get an exception because the lead arrived by
  // machinery rather than by hand.
  // Approvals go on *after* the parent's opening email, so there is a real
  // thread to reply into. Switching them on first would park the parent's first
  // email as a draft and there would be nothing to reply to.
  const leadId = enrol()
  await tick()
  simulateReply({ user, campaignLead: link(parent.id, leadId), text: 'Interested, tell me more.' })
  db.prepare('UPDATE users SET require_approval = 1 WHERE id = 1').run()
  await tick()
  await tick()

  assert.ok(link(interestedChild.id, leadId), 'the lead did move')
  assert.equal(outCount(interestedChild.id, leadId), 0, 'but nothing left a mailbox')
  const draft = db.prepare("SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'")
    .get(interestedChild.id, leadId)
  assert.ok(draft, 'it is waiting in Needs your OK')
  db.prepare('UPDATE users SET require_approval = 0 WHERE id = 1').run()
})
