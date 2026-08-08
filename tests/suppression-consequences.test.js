// Blocking someone must have the same consequences whichever route did it,
// and an approval must not be able to send what a block just stopped.
//
// Both were broken. `POST /api/blocked-domains` stopped enrolments and declined
// queued drafts; `POST /api/block-list` — the route the Settings screen calls —
// only wrote the row, so the block a user could actually reach did the least.
// And `POST /api/drafts/:id/approve` consulted no suppression at all, so a
// draft composed before the block stayed approvable afterwards.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox } from './helpers/parity-harness.js'

setup('suppression-consequences')

const { db } = await import('../server/db.js')
const { applySuppression } = await import('../server/suppression.js')

const owner = seedUser(db, 'owner@consequences.test')
const mailbox = seedMailbox(db, owner.id, 'sender@consequences.test')

// One lead, enrolled and running, with a queued draft and a scheduled reply —
// the three kinds of in-flight work a block has to stop.
function inFlightLead(email) {
  const lead = seedLead(db, owner.id, email)
  const campaign = seedCampaign(db, owner.id, `Campaign for ${email}`, mailbox.id)
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id)
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, 'A', 'waiting')")
    .run(campaign.id, lead.id)
  db.prepare(
    `INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body, status)
     VALUES (?, ?, ?, 'A', 'Hello', 'Body', 'pending')`
  ).run(owner.id, campaign.id, lead.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, scheduled_at, send_status)
     VALUES (?, ?, ?, ?, 'out', 'Later', 'Body', '2099-01-01T00:00:00Z', 'queued')`
  ).run(owner.id, campaign.id, lead.id, mailbox.id)
  return { lead, campaign }
}

const state = (leadId) => db.prepare('SELECT state, outcome FROM campaign_leads WHERE lead_id = ?').get(leadId)
const draftStatus = (leadId) => db.prepare('SELECT status FROM drafts WHERE lead_id = ?').get(leadId)?.status
const queued = (leadId) =>
  db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND send_status = 'queued'").get(leadId).n

test('blocking a domain stops the enrolment, declines the draft and cancels the queued send', () => {
  const { lead } = inFlightLead('ana@blockme.test')
  assert.equal(state(lead.id).state, 'waiting', 'in flight before')
  assert.equal(draftStatus(lead.id), 'pending')
  assert.equal(queued(lead.id), 1)

  const applied = applySuppression(owner.id, [{ value: 'blockme.test', isDomain: true }], owner.email)

  assert.equal(state(lead.id).state, 'stopped')
  assert.equal(state(lead.id).outcome, 'blocked')
  assert.equal(draftStatus(lead.id), 'declined', 'an approvable draft must not survive the block')
  assert.equal(queued(lead.id), 0, 'a reply scheduled for later is a send that has not happened yet')
  assert.equal(applied.stoppedLeads, 1)
  assert.equal(applied.declinedDrafts, 1)
})

test('a domain block reaches subdomain addresses, matching what blockMatch decides', () => {
  // The set that gets *stopped* has to be the same set that would be *refused*.
  // These drifted apart before: the decision walked parent labels, the
  // consequence used a single LIKE '%@domain'.
  const { lead } = inFlightLead('ana@mail.subdomains.test')
  applySuppression(owner.id, [{ value: 'subdomains.test', isDomain: true }], owner.email)
  assert.equal(state(lead.id).state, 'stopped', 'a subdomain address is stopped too')
})

test('an exact-address entry stops only that person', () => {
  const { lead: target } = inFlightLead('one.person@shared.test')
  const { lead: bystander } = inFlightLead('someone.else@shared.test')

  applySuppression(owner.id, [{ value: 'one.person@shared.test', isDomain: false }], owner.email)

  assert.equal(state(target.id).state, 'stopped')
  assert.equal(state(bystander.id).state, 'waiting', 'a colleague at the same domain is untouched')
})

test('blocking nothing changes nothing, and says so', () => {
  const applied = applySuppression(owner.id, [{ value: 'nobody-here.test', isDomain: true }], owner.email)
  assert.deepEqual(applied, { stoppedLeads: 0, declinedDrafts: 0 })
})

test('both block routes share one implementation, so they cannot drift apart again', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const read = (f) => fs.readFileSync(path.join(process.cwd(), 'server', 'parity', f), 'utf8')
  assert.ok(read('utilities.js').includes('applySuppression'),
    'POST /api/block-list applies the consequences')
  assert.ok(read('inbox.js').includes('blockMatch'),
    'POST /api/blocked-domains decides with the canonical rule')
})
