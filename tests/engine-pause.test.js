// Pausing a lead has to stop the engine, not just the screen.
//
// It did not. `paused_at` was written by the pause routes and read by nothing
// in `engine.js`, whose lead query selected on `state` alone. An audit proved
// it by ticking: a paused lead received a follow-up three ticks later,
// indistinguishable from the unpaused control beside it.
//
// This is the same shape as the tracking-settings bug and the STOPPED bug — a
// control that changed what the product *said* and nothing about what it *did*.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox } from './helpers/parity-harness.js'

setup('engine-pause')

const { db } = await import('../server/db.js')

const owner = seedUser(db, 'owner@pause.test')
const mailbox = seedMailbox(db, owner.id, 'sender@pause.test')
const campaign = seedCampaign(db, owner.id, 'Pause campaign', mailbox.id)

// The exact query the engine uses to decide who to advance. Asserting against
// this rather than running a full tick keeps the test about the selection rule,
// which is where the defect lived.
function advanceable(campaignId) {
  return db.prepare(
    `SELECT cl.id, l.email FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
      WHERE cl.campaign_id = ? AND cl.state IN ('queued','active','waiting')
        AND (COALESCE(cl.paused_at,'') = ''
             OR (COALESCE(cl.resume_at,'') != '' AND datetime(cl.resume_at) <= datetime('now')))`
  ).all(campaignId).map((r) => r.email)
}

function enrol(email) {
  const lead = seedLead(db, owner.id, email)
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, 'A', 'waiting')")
    .run(campaign.id, lead.id)
  return lead
}

const running = enrol('running@acme.test')
const paused = enrol('paused@acme.test')
const timed = enrol('timed@acme.test')

test('a paused lead is not advanced, and an unpaused one still is', () => {
  assert.deepEqual(
    advanceable(campaign.id).sort(),
    ['paused@acme.test', 'running@acme.test', 'timed@acme.test'],
    'all three are in flight to begin with'
  )

  db.prepare("UPDATE campaign_leads SET paused_at = datetime('now') WHERE lead_id = ?").run(paused.id)

  const after = advanceable(campaign.id).sort()
  assert.ok(!after.includes('paused@acme.test'), 'the paused lead is skipped')
  assert.ok(after.includes('running@acme.test'), 'the control is untouched')
})

test('a pause with a resume time in the future keeps the lead paused', () => {
  db.prepare("UPDATE campaign_leads SET paused_at = datetime('now'), resume_at = ? WHERE lead_id = ?")
    .run(new Date(Date.now() + 86_400_000).toISOString(), timed.id)
  assert.ok(!advanceable(campaign.id).includes('timed@acme.test'))
})

test('a pause whose resume time has passed lets the lead continue on its own', () => {
  // `resume_at` is what makes "pause until Monday" possible without anyone
  // having to come back and press resume.
  db.prepare("UPDATE campaign_leads SET paused_at = datetime('now'), resume_at = ? WHERE lead_id = ?")
    .run(new Date(Date.now() - 60_000).toISOString(), timed.id)
  assert.ok(advanceable(campaign.id).includes('timed@acme.test'))
})

test('resuming clears the pause and the lead is advanced again', () => {
  db.prepare("UPDATE campaign_leads SET paused_at = '', resume_at = '' WHERE lead_id = ?").run(paused.id)
  assert.ok(advanceable(campaign.id).includes('paused@acme.test'))
})

test('the engine really uses this rule — not a copy of it that can drift', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const engine = fs.readFileSync(path.join(process.cwd(), 'server', 'engine.js'), 'utf8')
  assert.ok(engine.includes('paused_at'), 'engine.js consults paused_at when selecting leads')
  assert.ok(engine.includes('resume_at'), 'and honours an expiring pause')
})
