// A per-lead sender pin that the engine never read.
//
// `campaign_leads.mailbox_id` existed, the route that set it returned success,
// and the lead's row showed the pinned address. Nothing sent from it: the
// engine went straight to `campaign.mailbox_id`, so a lead pinned to mailbox 2
// was emailed from mailbox 1 and the whole feature was a label.
//
// The route-level test that existed asserted the pin was stored. That is the
// mistake worth naming — storing a setting and honouring it are two different
// claims, and only the second one is what the user asked for. Every test below
// runs the engine and reads `messages.mailbox_id`, because that column is the
// only thing that says which address the recipient actually saw.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-pin-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- no reply 3d --> L([Lost])
`

db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:pin@x.com', 'pin@x.com', 'Pin User', 0)").run()
const user = db.prepare('SELECT * FROM users WHERE id = 1').get()

const addMailbox = db.prepare(
  "INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (?, 'sandbox', ?, ?)"
)
// Display names with distinct first words: the template signs off with the
// sender's first name, so "A Colleague" would sign "A" and prove nothing.
addMailbox.run(user.id, 'campaign@sandbox.local', 'Dana Campaign')     // id 1
addMailbox.run(user.id, 'colleague@sandbox.local', 'Priya Colleague')  // id 2
addMailbox.run(user.id, 'unattached@sandbox.local', 'Nobody Pool')     // id 3

db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, 'Pinning', 'running', 1, ?)")
  .run(user.id, PLAYBOOK)

// Mailbox 2 is in the campaign's pool; mailbox 3 deliberately is not.
db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (1, 2)').run()

const addLead = db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (?, ?, ?)')
const attach = db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, mailbox_id) VALUES (1, ?, ?)')

let nextLead = 0
function seedLead(pinnedMailboxId) {
  nextLead += 1
  addLead.run(user.id, `lead${nextLead}@acme.test`, `Lead${nextLead}`)
  const leadId = db.prepare('SELECT id FROM leads WHERE email = ?').get(`lead${nextLead}@acme.test`).id
  attach.run(leadId, pinnedMailboxId)
  return leadId
}

const sentFrom = (leadId) =>
  db.prepare("SELECT mailbox_id FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY id LIMIT 1").get(leadId)?.mailbox_id

const pinOf = (leadId) =>
  db.prepare('SELECT mailbox_id FROM campaign_leads WHERE campaign_id = 1 AND lead_id = ?').get(leadId).mailbox_id

const eventsFor = (leadId) =>
  db.prepare('SELECT type, detail FROM events WHERE lead_id = ? ORDER BY id').all(leadId)

// ---- the defect, stated as a test ------------------------------------------

test('a lead pinned to a mailbox is emailed from that mailbox, not the campaign one', async () => {
  const pinnedLead = seedLead(2)
  const ordinaryLead = seedLead(null)
  await tick()

  assert.equal(sentFrom(pinnedLead), 2, 'the pin decided the sender')
  assert.equal(sentFrom(ordinaryLead), 1, 'and an unpinned lead still uses the campaign mailbox')
})

test('the pinned mailbox carries the sender name, so the copy matches the address', async () => {
  const leadId = seedLead(2)
  await tick()
  const body = db.prepare("SELECT body FROM messages WHERE lead_id = ? AND direction = 'out'").get(leadId).body
  assert.match(body, /Priya/, 'signed by the colleague who is actually sending')
  assert.ok(!/Dana/.test(body), 'and not by the campaign mailbox')
})

// ---- the pin has to survive contact with reality ---------------------------

test('pinning to a mailbox outside the campaign pool never sends from it', async () => {
  // The one outcome the spec rules out outright: a send from an account the
  // campaign was never given. Falling back is correct; sending anyway is not.
  const leadId = seedLead(3)
  await tick()

  assert.equal(sentFrom(leadId), 1, 'fell back to the campaign mailbox')
  assert.notEqual(sentFrom(leadId), 3, 'and never used the unattached account')
  assert.equal(pinOf(leadId), null, 'the dead pin was cleared rather than left to mislead')

  const unpinned = eventsFor(leadId).find((e) => e.type === 'sender_unpinned')
  assert.ok(unpinned, 'and the change is on the activity trail')
  assert.match(unpinned.detail, /no longer attached/)
})

test('a pin to a deleted mailbox is cleared, not obeyed into a crash', async () => {
  addMailbox.run(user.id, 'doomed@sandbox.local', 'Doomed')
  const doomed = db.prepare('SELECT id FROM mailboxes WHERE email = ?').get('doomed@sandbox.local').id
  db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (1, ?)').run(doomed)
  const leadId = seedLead(doomed)
  db.prepare('DELETE FROM mailboxes WHERE id = ?').run(doomed)

  await tick()
  assert.equal(sentFrom(leadId), 1, 'the campaign mailbox took over')
  assert.equal(pinOf(leadId), null)
  assert.ok(eventsFor(leadId).some((e) => e.type === 'sender_unpinned'))
})

test('a pin belonging to another workspace is refused, not honoured', async () => {
  db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:other@x.com', 'other@x.com', 'Other')").run()
  const stranger = db.prepare('SELECT id FROM users WHERE email = ?').get('other@x.com').id
  addMailbox.run(stranger, 'stranger@sandbox.local', 'Stranger')
  const theirs = db.prepare('SELECT id FROM mailboxes WHERE email = ?').get('stranger@sandbox.local').id
  // Attached to the campaign as well, so the only thing standing between this
  // lead and a cross-workspace send is the ownership check itself.
  db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (1, ?)').run(theirs)

  const leadId = seedLead(theirs)
  await tick()
  assert.equal(sentFrom(leadId), 1, 'sent from our own mailbox')
  assert.notEqual(sentFrom(leadId), theirs, 'never from another workspace’s')
})

// ---- pacing follows the mailbox that actually sent -------------------------

test('the sending gap is applied to the pinned mailbox, not the campaign one', async () => {
  // Pacing the wrong row leaves the pinned mailbox free to fire again a second
  // later, which is the failure mode a rate limit exists to prevent.
  db.prepare('UPDATE mailboxes SET next_send_at = 0 WHERE id IN (1, 2)').run()
  const before = db.prepare('SELECT next_send_at FROM mailboxes WHERE id = 1').get().next_send_at

  const leadId = seedLead(2)
  await tick()

  assert.equal(sentFrom(leadId), 2)
  const pinnedGap = db.prepare('SELECT next_send_at FROM mailboxes WHERE id = 2').get().next_send_at
  assert.ok(pinnedGap > Date.now(), 'the mailbox that sent is now holding a gap')
  const campaignGap = db.prepare('SELECT next_send_at FROM mailboxes WHERE id = 1').get().next_send_at
  assert.equal(campaignGap, before, 'and the campaign mailbox was not slowed down for a send it did not make')
})

test('the pinned mailbox counts its own send against its own daily total', async () => {
  const beforePinned = db.prepare('SELECT sent_today FROM mailboxes WHERE id = 2').get().sent_today
  const beforeCampaign = db.prepare('SELECT sent_today FROM mailboxes WHERE id = 1').get().sent_today

  const leadId = seedLead(2)
  db.prepare('UPDATE mailboxes SET next_send_at = 0 WHERE id = 2').run()
  await tick()

  assert.equal(sentFrom(leadId), 2)
  assert.equal(
    db.prepare('SELECT sent_today FROM mailboxes WHERE id = 2').get().sent_today,
    beforePinned + 1,
    'the pinned mailbox wears the send'
  )
  assert.equal(
    db.prepare('SELECT sent_today FROM mailboxes WHERE id = 1').get().sent_today,
    beforeCampaign,
    'and the campaign mailbox does not'
  )
})
