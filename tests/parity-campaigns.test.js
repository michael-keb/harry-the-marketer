// Parity tests for server/parity/campaigns.js — Docs/campaigns/*.md §5.
//
// The cases the backlog calls out by name get their own test: the
// ACTIVE/START contradiction, the refusal of an unbounded bulk history
// request, an invalid Mermaid diagram carrying the validator's own message,
// a duplicate that copies configuration but no audience, cross-workspace 404s
// on every :id route, and server-side paging on the campaign list.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, seedMessage, mount } from './helpers/parity-harness.js'

setup('campaigns')                 // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/campaigns.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

const VALID_PLAYBOOK = `flowchart TD
    S([Start]) --> A[Send: short intro]
    A -- reply: interested --> W([Won: call booked])
    A -- no reply 3d --> L([Lost: no response])
`

// A campaign that satisfies every launch condition: valid playbook, a
// connected mailbox in the pool, and at least one lead attached.
function readyCampaign(name) {
  const mailbox = seedMailbox(db, owner.id, `${name}@example.com`)
  const campaign = seedCampaign(db, owner.id, name, mailbox.id)
  db.prepare('UPDATE campaigns SET mermaid = ? WHERE id = ?').run(VALID_PLAYBOOK, campaign.id)
  db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(campaign.id, mailbox.id)
  const lead = seedLead(db, owner.id, `${name}-lead@acme.test`)
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, ?, ?)')
    .run(campaign.id, lead.id, 'A', 'waiting')
  return { campaign: db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id), mailbox, lead }
}

// ---------------------------------------------------------------- create ----

test('create names an untitled campaign and never creates one implicitly', async () => {
  const named = await client.post('/api/campaigns/create', { name: '  Q1 outreach  ' })
  assert.equal(named.status, 200)
  assert.equal(named.body.name, 'Q1 outreach')
  assert.equal(named.body.status, 'draft')

  const blank = await client.post('/api/campaigns/create', {})
  assert.equal(blank.body.name, 'Untitled campaign')

  // A cross-workspace goal id creates nothing.
  db.prepare("INSERT INTO goals (user_id, description, name) VALUES (?, 'x', 'Their goal')").run(stranger.id)
  const theirGoal = db.prepare('SELECT id FROM goals WHERE user_id = ?').get(stranger.id)
  const before = db.prepare('SELECT COUNT(*) n FROM campaigns WHERE user_id = ?').get(owner.id).n
  const refused = await client.post('/api/campaigns/create', { name: 'Linked', goalId: theirGoal.id })
  assert.equal(refused.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaigns WHERE user_id = ?').get(owner.id).n, before)
})

test('a double submit within the window returns the campaign already made', async () => {
  const first = await client.post('/api/campaigns/create', { name: 'Double click' })
  const second = await client.post('/api/campaigns/create', { name: 'Double click' })
  assert.equal(second.body.id, first.body.id)
  assert.equal(second.body.deduplicated, true)
})

// --------------------------------------------------------------- get-all ----

test('get-all pages server-side and rejects an unbounded limit', async () => {
  const mine = db.prepare("SELECT COUNT(*) n FROM campaigns WHERE user_id = ? AND status != 'archived'").get(owner.id).n
  const firstPage = await client.get('/api/campaign-list?limit=2')
  assert.equal(firstPage.status, 200)
  assert.equal(firstPage.body.campaigns.length, 2)
  assert.equal(firstPage.body.total, mine)
  assert.equal(firstPage.body.limit, 2)

  const secondPage = await client.get('/api/campaign-list?limit=2&offset=2')
  const firstIds = firstPage.body.campaigns.map((c) => c.id)
  const secondIds = secondPage.body.campaigns.map((c) => c.id)
  assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0)

  const tooMuch = await client.get('/api/campaign-list?limit=5000')
  assert.equal(tooMuch.status, 422)
  assert.equal(tooMuch.body.field, 'limit')

  // Search and status filter, together.
  await client.post('/api/campaigns/create', { name: 'Findable widget campaign' })
  const found = await client.get('/api/campaign-list?q=findable%20widget&status=draft')
  assert.equal(found.body.total, 1)
  assert.equal(found.body.campaigns[0].name, 'Findable widget campaign')
})

test('another workspace never appears in the list', async () => {
  seedCampaign(db, stranger.id, 'Their secret campaign')
  const page = await client.get('/api/campaign-list?limit=200')
  assert.equal(page.body.campaigns.some((c) => c.name === 'Their secret campaign'), false)
})

// -------------------------------------------------------- update-status -----

test('update-status: ACTIVE is a 422 while START succeeds', async () => {
  const { campaign } = readyCampaign('status-check')

  // The source page's samples all send ACTIVE. Harry documents START.
  const active = await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'ACTIVE' })
  assert.equal(active.status, 422)
  assert.equal(active.body.field, 'status')
  assert.match(active.body.message, /START, PAUSED, STOPPED/)
  assert.match(active.body.message, /ACTIVE is not accepted/)
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaign.id).status, 'draft')

  const started = await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  assert.equal(started.status, 200)
  assert.equal(started.body.success, true)
  assert.equal(started.body.campaign.status, 'running')
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaign.id).status, 'running')

  const paused = await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'PAUSED' })
  assert.equal(paused.body.campaign.status, 'paused')

  // The transition is in the activity trail with the actor and both states.
  const trail = db.prepare("SELECT detail FROM events WHERE campaign_id = ? AND type = 'campaign_status' ORDER BY id").all(campaign.id)
  assert.equal(trail.length, 2)
  assert.match(trail[0].detail, /DRAFT -> START by owner@example\.com/)
})

test('update-status: START lists every unmet condition at once, and STOPPED is terminal', async () => {
  const bare = seedCampaign(db, owner.id, 'Nothing configured')
  const blocked = await client.put(`/api/campaigns/${bare.id}/status`, { status: 'START' })
  assert.equal(blocked.status, 422)
  const fields = blocked.body.blockers.map((b) => b.field).sort()
  assert.deepEqual(fields, ['leads', 'mailboxes', 'playbook'])

  const { campaign } = readyCampaign('stop-me')
  await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  const stopped = await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'STOPPED' })
  assert.equal(stopped.body.campaign.state, 'STOPPED')

  const restart = await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  assert.equal(restart.status, 409)
  assert.match(restart.body.message, /Duplicate it/)
})

// ------------------------------------------------------ update-sequences ----

test('update-sequences rejects an invalid diagram with the validator message', async () => {
  const { campaign } = readyCampaign('sequence-edit')
  const broken = 'flowchart TD\n    A[Send: hello] --> B[Send: again]\n'
  const { parsePlaybook } = await import('../server/playbook.js')
  const expected = parsePlaybook(broken).errors[0].message

  const refused = await client.put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: broken })
  assert.equal(refused.status, 422)
  assert.equal(refused.body.field, 'mermaid')
  assert.equal(refused.body.message, expected)
  assert.ok(refused.body.errors.length > 0)
  // Nothing was written.
  assert.equal(db.prepare('SELECT mermaid FROM campaigns WHERE id = ?').get(campaign.id).mermaid, VALID_PLAYBOOK)

  const accepted = await client.put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: VALID_PLAYBOOK })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.ok, true)
})

test('update-sequences refuses a running campaign and remaps orphaned leads', async () => {
  const { campaign, lead } = readyCampaign('sequence-running')
  await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  const running = await client.put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: VALID_PLAYBOOK })
  assert.equal(running.status, 409)
  assert.match(running.body.message, /Pause this campaign/)

  await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'PAUSED' })
  const renamed = VALID_PLAYBOOK.replace(/\bA\b/g, 'Intro')
  const saved = await client.put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: renamed })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.remapped, 1)
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
  assert.equal(cl.state, 'needs_attention')
})

test('get-sequences projects the playbook through the one parser', async () => {
  const { campaign } = readyCampaign('sequence-read')
  const steps = await client.get(`/api/campaigns/${campaign.id}/steps`)
  assert.equal(steps.status, 200)
  assert.equal(steps.body.valid, true)
  assert.equal(steps.body.startId, 'S')
  const send = steps.body.steps.find((s) => s.nodeId === 'A')
  assert.equal(send.type, 'send')
  assert.equal(send.position, 1)
  assert.deepEqual(send.replyIntents, ['interested'])
  assert.equal(send.branches.length, 2)

  // An invalid diagram returns errors and no partial step list.
  const broken = seedCampaign(db, owner.id, 'Broken diagram')
  db.prepare('UPDATE campaigns SET mermaid = ? WHERE id = ?').run('flowchart TD\n  A[Nonsense]\n', broken.id)
  const bad = await client.get(`/api/campaigns/${broken.id}/steps`)
  assert.equal(bad.body.valid, false)
  assert.deepEqual(bad.body.steps, [])
  assert.ok(bad.body.errors.length > 0)
})

// -------------------------------------------------- get-leads-history-bulk --

test('bulk lead history refuses a null or absent id list', async () => {
  const { campaign, lead } = readyCampaign('bulk-history')
  seedMessage(db, owner.id, { campaignId: campaign.id, leadId: lead.id })

  const absent = await client.post(`/api/campaigns/${campaign.id}/messages/bulk`, {})
  assert.equal(absent.status, 422)
  assert.equal(absent.body.field, 'leadIds')
  assert.match(absent.body.message, /unbounded/)

  const nulled = await client.post(`/api/campaigns/${campaign.id}/messages/bulk`, { leadIds: null })
  assert.equal(nulled.status, 422)
  assert.equal(nulled.body.field, 'leadIds')

  const empty = await client.post(`/api/campaigns/${campaign.id}/messages/bulk`, { leadIds: [] })
  assert.equal(empty.status, 422)

  const capped = await client.post(`/api/campaigns/${campaign.id}/messages/bulk`, {
    leadIds: Array.from({ length: 101 }, (_, i) => i + 1),
  })
  assert.equal(capped.status, 422)
  assert.match(capped.body.message, /at most 100 ids/)

  // Every requested id lands in `data` or in `unavailable`.
  const ok = await client.post(`/api/campaigns/${campaign.id}/messages/bulk`, { leadIds: [lead.id, 9999] })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.data[lead.id].length, 1)
  assert.deepEqual(ok.body.unavailable, [9999])
})

// ------------------------------------------------------------- duplicate ----

test('duplicate copies the playbook, settings and mailboxes but not the leads', async () => {
  const { campaign, mailbox } = readyCampaign('duplicate-me')
  await client.put(`/api/campaigns/${campaign.id}/settings`, { track_settings: ['DONT_TRACK_EMAIL_OPEN'] })
  await client.put(`/api/campaigns/${campaign.id}/schedule`, { start_hour: '09:00', end_hour: '16:00', days: [1, 2] })
  await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  seedMessage(db, owner.id, { campaignId: campaign.id })

  const copy = await client.post(`/api/campaigns/${campaign.id}/duplicate`)
  assert.equal(copy.status, 200)
  const copyId = copy.body.id
  const copied = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(copyId)

  assert.equal(copied.mermaid, VALID_PLAYBOOK)              // playbook copied
  assert.equal(copied.status, 'draft')                       // never running
  assert.equal(copied.track_opens, 0)                        // settings copied
  assert.equal(JSON.parse(copied.schedule).start_hour, '09:00')
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE campaign_id = ? AND mailbox_id = ?').get(copyId, mailbox.id).n,
    1                                                        // mailboxes copied
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(copyId).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE campaign_id = ?').get(copyId).n, 0)
})

test('duplicate can carry children, re-pointed at the copy', async () => {
  const { campaign } = readyCampaign('parent-copy')
  const child = await client.post(`/api/campaigns/${campaign.id}/children`, { name: 'Not now branch', triggers: ['not now'] })
  assert.equal(child.status, 200)

  const copy = await client.post(`/api/campaigns/${campaign.id}/duplicate`, { includeChildren: true })
  assert.equal(copy.body.childIds.length, 1)
  const copiedChild = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(copy.body.childIds[0])
  assert.equal(copiedChild.parent_campaign_id, copy.body.id)
  // The original child still points at the original.
  assert.equal(db.prepare('SELECT parent_campaign_id p FROM campaigns WHERE id = ?').get(child.body.id).p, campaign.id)
})

// ------------------------------------------------------------- mailboxes ----

test('mailbox attach is all-or-nothing and detach guards the last one', async () => {
  const { campaign, mailbox } = readyCampaign('mailbox-pool')
  const second = seedMailbox(db, owner.id, 'second@example.com')
  const broken = seedMailbox(db, owner.id, 'broken@example.com')
  db.prepare("UPDATE mailboxes SET status = 'disconnected' WHERE id = ?").run(broken.id)

  const refused = await client.post(`/api/campaigns/${campaign.id}/mailboxes`, { mailboxIds: [second.id, broken.id] })
  assert.equal(refused.status, 422)
  assert.equal(refused.body.field, 'mailboxIds')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE campaign_id = ?').get(campaign.id).n, 1)

  const added = await client.post(`/api/campaigns/${campaign.id}/mailboxes`, { mailboxIds: [second.id] })
  assert.equal(added.body.attached, 1)

  const listed = await client.get(`/api/campaigns/${campaign.id}/mailboxes`)
  assert.equal(listed.body.mailboxes.length, 2)
  assert.equal(listed.body.mailboxes.find((m) => m.id === mailbox.id).isPrimary, true)

  await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  const emptied = await client.del(`/api/campaigns/${campaign.id}/mailboxes`, { mailbox_ids: [mailbox.id, second.id] })
  assert.equal(emptied.status, 409)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE campaign_id = ?').get(campaign.id).n, 2)

  const one = await client.del(`/api/campaigns/${campaign.id}/mailboxes/${mailbox.id}`)
  assert.equal(one.body.removed, 1)
  // The legacy primary follows the pool so the engine keeps working.
  assert.equal(db.prepare('SELECT mailbox_id m FROM campaigns WHERE id = ?').get(campaign.id).m, second.id)
})

// ------------------------------------------------------------- lead work ----

test('add-leads honours suppression, caps the batch and reports skips by reason', async () => {
  const { campaign } = readyCampaign('import-target')
  const gone = seedLead(db, owner.id, 'gone@acme.test')
  db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(gone.id)

  const tooMany = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: Array.from({ length: 401 }, (_, i) => ({ email: `bulk${i}@acme.test` })),
  })
  assert.equal(tooMany.status, 422)
  assert.equal(tooMany.body.max_allowed, 400)

  const imported = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [{ email: 'new@acme.test', first_name: 'New' }, { email: 'gone@acme.test' }],
  })
  assert.equal(imported.body.addedCount, 1)
  assert.equal(imported.body.skippedByReason.unsubscribed, 1)

  // Idempotent: the same batch twice does not duplicate.
  const again = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [{ email: 'new@acme.test' }],
  })
  assert.equal(again.body.addedCount, 0)
  assert.equal(again.body.skippedByReason.already_in_campaign, 1)

  // One events row per bulk action, not one per lead: two imports were
  // applied, and the over-cap batch was refused before it could write.
  const rows = db.prepare("SELECT COUNT(*) n FROM events WHERE campaign_id = ? AND type = 'campaign_leads_imported'").get(campaign.id).n
  assert.equal(rows, 2)
})

test('pause freezes the timer, resume restores its remainder', async () => {
  const { campaign, lead } = readyCampaign('pause-resume')
  const waitUntil = new Date(Date.now() + 3 * 3600e3).toISOString()
  db.prepare('UPDATE campaign_leads SET wait_until = ? WHERE campaign_id = ? AND lead_id = ?').run(waitUntil, campaign.id, lead.id)

  const paused = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/pause`, { reason: 'checking' })
  assert.equal(paused.status, 200)
  const twice = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/pause`)
  assert.equal(twice.body.alreadyPaused, true)

  const later = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/resume`, { delay_days: 5 })
  assert.ok(later.body.will_resume_at)
  const days = (Date.parse(later.body.will_resume_at) - Date.now()) / 86400e3
  assert.ok(days > 4.9 && days < 5.1)

  const now = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/resume`)
  const remaining = (Date.parse(now.body.waitUntil) - Date.now()) / 3600e3
  assert.ok(remaining > 2.9 && remaining < 3.1, `expected ~3h remaining, got ${remaining}`)
  assert.equal(db.prepare('SELECT paused_at p FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).p, '')
})

test('complete and unsubscribe are idempotent and withdraw queued drafts', async () => {
  const { campaign, lead } = readyCampaign('lead-endings')
  db.prepare("INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body) VALUES (?, ?, ?, 'A', 's', 'b')")
    .run(owner.id, campaign.id, lead.id)

  const done = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/complete`)
  assert.equal(done.status, 200)
  assert.equal(db.prepare("SELECT status FROM drafts WHERE campaign_id = ?").get(campaign.id).status, 'declined')
  const repeat = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/complete`)
  assert.equal(repeat.body.alreadyComplete, true)
  assert.equal(repeat.body.completedAt, done.body.completedAt)

  const out = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/unsubscribe`)
  assert.equal(out.status, 200)
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'unsubscribed')
  const outAgain = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/unsubscribe`)
  assert.equal(outAgain.body.alreadyUnsubscribed, true)
  assert.equal(outAgain.body.unsubscribedAt, out.body.unsubscribedAt)

  // An unsubscribed lead cannot be resumed.
  const resume = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/resume`)
  assert.equal(resume.status, 409)
})

test('a manual intent is validated against the playbook and survives as human-set', async () => {
  const { campaign, lead } = readyCampaign('intent-fix')
  const nonsense = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/intent`, { intent: 'moon phase' })
  assert.equal(nonsense.status, 422)
  assert.equal(nonsense.body.field, 'intent')

  const set = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/intent`, { intent: 'interested', pause: true })
  assert.equal(set.body.routedTo, 'W')
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
  assert.equal(cl.intent, 'interested')
  assert.equal(cl.intent_set_by, 'owner@example.com')
  assert.ok(cl.paused_at)
})

test('a lead can be pinned to a mailbox only from the pool unless overridden', async () => {
  const { campaign, lead, mailbox } = readyCampaign('pin-sender')
  const outside = seedMailbox(db, owner.id, 'outside@example.com')

  const refused = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/mailbox`, { mailbox_id: outside.id })
  assert.equal(refused.status, 422)
  const forced = await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/mailbox`, { mailbox_id: outside.id, override: true })
  assert.equal(forced.body.mailboxId, outside.id)

  await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/mailbox`, { mailbox_id: mailbox.id })
  // Detaching the mailbox clears the pin.
  await client.del(`/api/campaigns/${campaign.id}/mailboxes/${mailbox.id}`)
  assert.equal(db.prepare('SELECT mailbox_id m FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).m, null)
})

test('bulk lead removal reports per-id outcomes', async () => {
  const { campaign, lead } = readyCampaign('remove-leads')
  const result = await client.post(`/api/campaigns/${campaign.id}/leads/remove`, { leadIds: [lead.id, 4242] })
  assert.equal(result.status, 200)
  assert.equal(result.body.removed, 1)
  assert.equal(result.body.results.find((r) => r.leadId === 4242).reason, 'not_in_campaign')
  // The person survives the link being cut.
  assert.ok(db.prepare('SELECT id FROM leads WHERE id = ?').get(lead.id))
})

test('campaign leads list pages, filters and exports through the same parser', async () => {
  const { campaign, lead } = readyCampaign('leads-list')
  await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [{ email: 'a@list.test', first_name: 'Ann' }, { email: 'b@list.test', first_name: 'Bob' }],
  })
  const page = await client.get(`/api/campaigns/${campaign.id}/leads?limit=2`)
  assert.equal(page.status, 200)
  assert.equal(page.body.leads.length, 2)
  assert.equal(page.body.total, 3)

  const overLimit = await client.get(`/api/campaigns/${campaign.id}/leads?limit=500`)
  assert.equal(overLimit.status, 422)
  assert.equal(overLimit.body.field, 'limit')

  const searched = await client.get(`/api/campaigns/${campaign.id}/leads?q=ann`)
  assert.equal(searched.body.total, 1)

  const badEngagement = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=vibes`)
  assert.equal(badEngagement.status, 422)

  const csv = await client.get(`/api/campaigns/${campaign.id}/leads/export`)
  assert.equal(csv.status, 200)
  const text = csv.body.raw ?? csv.body
  assert.match(text, /^﻿?lead_id,email/)
  assert.equal(text.trim().split('\r\n').length, 4)
  assert.ok(text.includes(lead.email))
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE campaign_id = ? AND type = 'campaign_leads_exported'").get(campaign.id).n, 1)
})

test('CSV quoting survives commas, quotes and non-ASCII', async () => {
  const { campaign } = readyCampaign('csv-quoting')
  const awkward = seedLead(db, owner.id, 'awkward@acme.test', { company: 'Ünicode, "Inc"', first_name: 'Zoë' })
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, awkward.id)
  const csv = await client.get(`/api/campaigns/${campaign.id}/leads/export`)
  const text = csv.body.raw ?? csv.body
  assert.ok(text.includes('"Ünicode, ""Inc"""'))
  assert.ok(text.includes('Zoë'))
  // The response opens with the BOM; fetch's UTF-8 decoder consumes it, so the
  // assertion is that the header row survives it intact rather than that the
  // byte is visible here.
  assert.match(text, /^lead_id,email/)
})

// -------------------------------------------------------- message history ---

test('lead message history supports since, and omits tracking when it is off', async () => {
  const { campaign, lead } = readyCampaign('thread-read')
  seedMessage(db, owner.id, { campaignId: campaign.id, leadId: lead.id, direction: 'out', subject: 'Hello' })
  seedMessage(db, owner.id, { campaignId: campaign.id, leadId: lead.id, direction: 'in', intent: 'interested' })

  const all = await client.get(`/api/campaigns/${campaign.id}/leads/${lead.id}/messages`)
  assert.equal(all.body.messages.length, 2)
  const inbound = all.body.messages.find((m) => m.direction === 'in')
  assert.equal(inbound.intent, 'interested')
  assert.equal(inbound.followedEdge.to, 'W')
  assert.equal(all.body.messages[0].openedAt, null)   // tracking on, nothing opened

  await client.put(`/api/campaigns/${campaign.id}/settings`, { track_settings: ['DONT_TRACK_EMAIL_OPEN', 'DONT_TRACK_LINK_CLICK'] })
  const untracked = await client.get(`/api/campaigns/${campaign.id}/leads/${lead.id}/messages`)
  const outbound = untracked.body.messages.find((m) => m.direction === 'out')
  // Absent, not zeroed.
  assert.equal('openedAt' in outbound, false)
  assert.equal(untracked.body.tracking.opens, false)

  const since = new Date(Date.now() + 60e3).toISOString()
  const none = await client.get(`/api/campaigns/${campaign.id}/leads/${lead.id}/messages?since=${encodeURIComponent(since)}`)
  assert.equal(none.body.messages.length, 0)

  const badDate = await client.get(`/api/campaigns/${campaign.id}/leads/${lead.id}/messages?since=yesterday`)
  assert.equal(badDate.status, 422)
  assert.equal(badDate.body.field, 'since')
})

// ------------------------------------------------- settings, schedule, owner

test('update-settings implements the schema and rejects everything else', async () => {
  const { campaign } = readyCampaign('settings-check')

  const unknown = await client.put(`/api/campaigns/${campaign.id}/settings`, { ignore_unsubscribe_list: true })
  assert.equal(unknown.status, 422)
  assert.equal(unknown.body.field, 'ignore_unsubscribe_list')

  const outOfRange = await client.put(`/api/campaigns/${campaign.id}/settings`, { follow_up_percentage: 150 })
  assert.equal(outOfRange.status, 422)
  assert.equal(outOfRange.body.field, 'follow_up_percentage')

  const badTrack = await client.put(`/api/campaigns/${campaign.id}/settings`, { track_settings: ['DONT_TRACK_MOON_PHASE'] })
  assert.equal(badTrack.status, 422)
  assert.match(badTrack.body.message, /DONT_TRACK_EMAIL_OPEN/)

  const saved = await client.put(`/api/campaigns/${campaign.id}/settings`, {
    name: 'Renamed campaign',
    track_settings: ['DONT_TRACK_EMAIL_OPEN'],
    stop_lead_settings: 'CLICK_ON_A_LINK',
    send_as_plain_text: true,
    unsubscribe_text: '',
    follow_up_percentage: 80,
    out_of_office_detection_settings: { ignoreOOOasReply: true, reactivateOOOwithDelay: 5 },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.success, true)
  assert.equal(saved.body.settings.track_opens, false)
  assert.equal(saved.body.settings.track_clicks, true)
  assert.equal(saved.body.settings.out_of_office_detection_settings.reactivateOOOwithDelay, 5)
  assert.equal(db.prepare('SELECT name FROM campaigns WHERE id = ?').get(campaign.id).name, 'Renamed campaign')
})

test('update-schedule validates the timezone, days, hours and gap', async () => {
  const { campaign } = readyCampaign('schedule-check')
  const badZone = await client.put(`/api/campaigns/${campaign.id}/schedule`, { timezone: 'Mars/Olympus' })
  assert.equal(badZone.status, 422)
  assert.equal(badZone.body.field, 'timezone')

  const noDays = await client.put(`/api/campaigns/${campaign.id}/schedule`, { days: [] })
  assert.equal(noDays.status, 422)

  const inverted = await client.put(`/api/campaigns/${campaign.id}/schedule`, { start_hour: '17:00', end_hour: '09:00' })
  assert.equal(inverted.status, 422)
  assert.equal(inverted.body.field, 'end_hour')

  const ok = await client.put(`/api/campaigns/${campaign.id}/schedule`, {
    timezone: 'Europe/London', days: [1, 3, 5], start_hour: '09:00', end_hour: '17:00', min_gap_minutes: 12,
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body.schedule.days, [1, 3, 5])

  // Workspace defaults are applied at read time, not copied at creation.
  const fresh = seedCampaign(db, owner.id, 'Default schedule')
  const detail = await client.get(`/api/campaigns/${fresh.id}/detail`)
  assert.equal(detail.body.schedule.start_hour, '08:30')
  assert.equal(detail.body.schedule.isDefault, true)
})

test('campaign owner must be a joined member, and clearing it is allowed', async () => {
  const { campaign } = readyCampaign('owner-check')
  const notMember = await client.put(`/api/campaigns/${campaign.id}/owner`, { user_id: stranger.id })
  assert.equal(notMember.status, 404)

  db.prepare("INSERT INTO team_members (owner_id, email, role, status) VALUES (?, ?, 'member', 'invited')")
    .run(owner.id, stranger.email)
  const invited = await client.put(`/api/campaigns/${campaign.id}/owner`, { user_id: stranger.id })
  assert.equal(invited.status, 422)
  assert.match(invited.body.message, /has not signed in/)

  db.prepare("UPDATE team_members SET status = 'active' WHERE owner_id = ? AND email = ?").run(owner.id, stranger.email)
  const assigned = await client.put(`/api/campaigns/${campaign.id}/owner`, { user_id: stranger.id })
  assert.equal(assigned.body.ownerEmail, stranger.email)

  const cleared = await client.put(`/api/campaigns/${campaign.id}/owner`, { user_id: null })
  assert.equal(cleared.body.ownerEmail, '')
})

// ------------------------------------------------------------- analytics ----

test('analytics rates carry denominators, and go null with a reason when untracked', async () => {
  const { campaign, lead } = readyCampaign('analytics')
  seedMessage(db, owner.id, { campaignId: campaign.id, leadId: lead.id, direction: 'out' })
  seedMessage(db, owner.id, { campaignId: campaign.id, leadId: lead.id, direction: 'in' })

  const all = await client.get(`/api/campaigns/${campaign.id}/playbook-analytics`)
  assert.equal(all.body.totals.sent, 1)
  assert.equal(all.body.rates.reply.value, 100)
  assert.equal(all.body.rates.reply.denominator, 1)
  assert.equal(all.body.window.allTime, true)

  await client.put(`/api/campaigns/${campaign.id}/settings`, { track_settings: ['DONT_TRACK_EMAIL_OPEN'] })
  const untracked = await client.get(`/api/campaigns/${campaign.id}/playbook-analytics`)
  assert.equal(untracked.body.rates.open.value, null)
  assert.match(untracked.body.rates.open.reason, /tracking is off/)

  // Strict windows: inversion names the field, one half alone is refused.
  const inverted = await client.get(`/api/campaigns/${campaign.id}/playbook-analytics?from=2026-02-01&to=2026-01-01`)
  assert.equal(inverted.status, 422)
  assert.equal(inverted.body.field, 'to')
  const halfWindow = await client.get(`/api/campaigns/${campaign.id}/playbook-analytics?from=2026-01-01`)
  assert.equal(halfWindow.status, 422)
  const tooWide = await client.get(`/api/campaigns/${campaign.id}/playbook-analytics?from=2020-01-01&to=2026-01-01`)
  assert.equal(tooWide.status, 422)

  // A whole-life window equals the all-time result.
  const wide = await client.get(`/api/campaigns/${campaign.id}/playbook-analytics?from=2020-01-01&to=2020-12-31`)
  assert.equal(wide.body.totals.sent, 0)
  assert.equal(wide.body.noActivity, true)

  const top = await client.get(`/api/campaigns/${campaign.id}/top-level-analytics`)
  assert.equal(top.body.total_sent, 1)
  assert.equal(top.body.reply_rate, 100)
  assert.equal(typeof top.body.open_rate, 'number')     // zeros, never nulls
})

test('statistics validate step and status, and page deterministically', async () => {
  const { campaign, lead } = readyCampaign('statistics')
  for (let i = 0; i < 3; i++) {
    seedMessage(db, owner.id, { campaignId: campaign.id, leadId: lead.id, direction: 'out', subject: `Mail ${i}` })
  }
  db.prepare("UPDATE messages SET node_id = 'A' WHERE campaign_id = ?").run(campaign.id)

  const badStep = await client.get(`/api/campaigns/${campaign.id}/step-statistics?step=ZZ`)
  assert.equal(badStep.status, 422)
  assert.equal(badStep.body.field, 'step')

  const badStatus = await client.get(`/api/campaigns/${campaign.id}/step-statistics?status=vibes`)
  assert.equal(badStatus.status, 422)

  const first = await client.get(`/api/campaigns/${campaign.id}/step-statistics?limit=2&step=A`)
  assert.equal(first.body.rows.length, 2)
  assert.equal(first.body.total, 3)
  assert.equal(first.body.rollup.sent, 3)
  const second = await client.get(`/api/campaigns/${campaign.id}/step-statistics?limit=2&offset=2&step=A`)
  assert.equal(second.body.rows.length, 1)
  assert.equal(first.body.rows.some((r) => r.messageId === second.body.rows[0].messageId), false)
})

// --------------------------------------------------------------- sending ----

test('nothing sends without the user\'s OK — test-send, forward and reply all confirm', async () => {
  const { campaign, lead, mailbox } = readyCampaign('sending-rules')
  const message = seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: lead.id, mailboxId: mailbox.id, direction: 'in',
  })

  for (const [url, body] of [
    [`/api/campaigns/${campaign.id}/test-send`, { node_id: 'A', to_email: 'me@example.com' }],
    [`/api/campaigns/${campaign.id}/messages/${message.id}/forward`, { to: ['colleague@example.com'] }],
    [`/api/campaigns/${campaign.id}/threads/${message.id}/reply`, { body: 'Thanks!' }],
  ]) {
    const refused = await client.post(url, body)
    assert.equal(refused.status, 422, url)
    assert.equal(refused.body.field, 'confirm', url)
  }
  // Nothing was written by any of the three.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out'").get(campaign.id).n, 0)
})

test('a test send is recorded, excluded from reports and never touches the lead', async () => {
  const { campaign, lead } = readyCampaign('test-send')
  const before = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ?').get(campaign.id)

  const sent = await client.post(`/api/campaigns/${campaign.id}/test-send`, {
    node_id: 'A', to_email: 'reviewer@example.com', confirm: true,
  })
  assert.equal(sent.status, 200)
  assert.equal(sent.body.excludedFromReports, true)
  assert.ok(sent.body.body.length > 0)

  const analytics = await client.get(`/api/campaigns/${campaign.id}/playbook-analytics`)
  assert.equal(analytics.body.totals.sent, 0)

  const after = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ?').get(campaign.id)
  assert.equal(after.node_id, before.node_id)
  assert.equal(after.state, before.state)

  // A real lead's address needs a second, explicit confirmation.
  const risky = await client.post(`/api/campaigns/${campaign.id}/test-send`, {
    node_id: 'A', to_email: lead.email, confirm: true,
  })
  assert.equal(risky.status, 422)
  assert.equal(risky.body.field, 'to_email')

  const notASendStep = await client.post(`/api/campaigns/${campaign.id}/test-send`, {
    node_id: 'W', to_email: 'reviewer@example.com', confirm: true,
  })
  assert.equal(notASendStep.status, 422)
})

test('forward carries no tracking, refuses the lead, and leaves the playbook alone', async () => {
  const { campaign, lead, mailbox } = readyCampaign('forward-rules')
  const message = seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: lead.id, mailboxId: mailbox.id, direction: 'in', subject: 'Interested',
  })
  const before = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ?').get(campaign.id)

  const empty = await client.post(`/api/campaigns/${campaign.id}/messages/${message.id}/forward`, { to: [], confirm: true })
  assert.equal(empty.status, 422)
  assert.equal(empty.body.field, 'to')

  const malformed = await client.post(`/api/campaigns/${campaign.id}/messages/${message.id}/forward`, { to: ['sam@@example'], confirm: true })
  assert.equal(malformed.status, 422)
  assert.equal(malformed.body.field, 'to[0]')

  const toLead = await client.post(`/api/campaigns/${campaign.id}/messages/${message.id}/forward`, { to: [lead.email], confirm: true })
  assert.equal(toLead.status, 422)
  assert.match(toLead.body.message, /use reply, not forward/)

  const done = await client.post(`/api/campaigns/${campaign.id}/messages/${message.id}/forward`, {
    to: ['sam@ourcompany.com'], note: 'Can you take this one?', confirm: true,
  })
  assert.equal(done.status, 200)
  assert.equal(done.body.success, true)
  assert.equal(done.body.playbookUnchanged, true)

  const row = db.prepare("SELECT * FROM messages WHERE campaign_id = ? AND send_status = 'forwarded'").get(campaign.id)
  assert.equal(row.forwarded_to, 'sam@ourcompany.com')
  assert.equal(row.tracking_token, '')                      // no pixel, no wrapped links
  assert.ok(row.body.includes('Forwarded message'))
  assert.ok(row.body.includes('Can you take this one?'))

  const after = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ?').get(campaign.id)
  assert.equal(after.node_id, before.node_id)
  assert.equal(after.wait_until, before.wait_until)
  // It still counts against the mailbox's allowance.
  assert.equal(db.prepare('SELECT sent_today s FROM mailboxes WHERE id = ?').get(mailbox.id).s, 1)
})

test('a manual reply is refused for an unsubscribed lead and can be scheduled', async () => {
  const { campaign, lead, mailbox } = readyCampaign('manual-reply')
  const message = seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: lead.id, mailboxId: mailbox.id, direction: 'in',
  })
  const when = new Date(Date.now() + 3600e3).toISOString()
  const scheduled = await client.post(`/api/campaigns/${campaign.id}/threads/${message.id}/reply`, {
    body: 'Happy to chat.', scheduled_time: when, confirm: true,
  })
  assert.equal(scheduled.status, 200)
  assert.equal(scheduled.body.scheduled, true)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND send_status = 'scheduled'").get(campaign.id).n, 1)

  const now = await client.post(`/api/campaigns/${campaign.id}/threads/${message.id}/reply`, { body: 'Sending now.', confirm: true })
  assert.equal(now.status, 200)
  assert.equal(now.body.sent, true)

  await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/unsubscribe`)
  const refused = await client.post(`/api/campaigns/${campaign.id}/threads/${message.id}/reply`, { body: 'One more?', confirm: true })
  assert.equal(refused.status, 409)
})

// --------------------------------------------------------- activity feed ----

test('the activity feed pages, filters and never leaks another workspace', async () => {
  const { campaign } = readyCampaign('activity-feed')
  await client.put(`/api/campaigns/${campaign.id}/settings`, { follow_up_percentage: 50 })

  const feed = await client.get('/api/activity?limit=5')
  assert.equal(feed.status, 200)
  assert.ok(feed.body.activities.length <= 5)
  assert.ok(feed.body.total > 0)

  const filtered = await client.get(`/api/activity?type=campaign_settings&campaignId=${campaign.id}`)
  assert.equal(filtered.body.total, 1)

  const unbounded = await client.get('/api/activity?limit=99999')
  assert.equal(unbounded.status, 422)
  assert.equal(unbounded.body.field, 'limit')

  const badWindow = await client.get('/api/activity?from=2026-02-01&to=2026-01-01')
  assert.equal(badWindow.status, 422)

  db.prepare("INSERT INTO events (user_id, type, detail) VALUES (?, 'secret', 'not yours')").run(stranger.id)
  const mine = await client.get('/api/activity?type=secret')
  assert.equal(mine.body.total, 0)
})

// ------------------------------------------------------- archive / delete ---

test('archive is reversible; a hard delete refuses a running campaign and cascades', async () => {
  const { campaign, lead } = readyCampaign('delete-me')
  seedMessage(db, owner.id, { campaignId: campaign.id, leadId: lead.id })

  const archived = await client.patch(`/api/campaigns/${campaign.id}`, { status: 'archived' })
  assert.equal(archived.status, 200)
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaign.id).status, 'archived')
  await client.patch(`/api/campaigns/${campaign.id}`, { status: 'draft' })
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaign.id).status, 'draft')

  const badStatus = await client.patch(`/api/campaigns/${campaign.id}`, { status: 'running' })
  assert.equal(badStatus.status, 422)

  await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  const refused = await client.del(`/api/campaigns/${campaign.id}/permanent`)
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'CAMPAIGN_ACTIVE')

  await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'PAUSED' })
  const gone = await client.del(`/api/campaigns/${campaign.id}/permanent`)
  assert.equal(gone.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaigns WHERE id = ?').get(campaign.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE campaign_id = ?').get(campaign.id).n, 0)
  // The person and the trail outlive the campaign.
  assert.ok(db.prepare('SELECT id FROM leads WHERE id = ?').get(lead.id))
  const trail = db.prepare("SELECT detail FROM events WHERE campaign_id = ? AND type = 'campaign_deleted'").get(campaign.id)
  assert.match(trail.detail, /destroyed 1 links/)
})

// ------------------------------------------------------ subsequences --------

test('subsequences link and unlink without deleting the child', async () => {
  const { campaign } = readyCampaign('subsequence')
  const bad = await client.post(`/api/campaigns/${campaign.id}/children`, { name: 'No triggers', triggers: ['a', 'a'] })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'triggers')

  const child = await client.post(`/api/campaigns/${campaign.id}/children`, { name: 'Nurture', triggers: ['not now'] })
  assert.equal(child.body.parentCampaignId, campaign.id)

  const listed = await client.get(`/api/campaigns/${campaign.id}/children`)
  assert.equal(listed.body.total, 1)
  assert.deepEqual(listed.body.children[0].triggers, ['not now'])

  const unlinked = await client.del(`/api/campaigns/${campaign.id}/children/${child.body.id}`)
  assert.equal(unlinked.status, 200)
  assert.ok(db.prepare('SELECT id FROM campaigns WHERE id = ?').get(child.body.id))
  assert.equal(db.prepare('SELECT parent_campaign_id p FROM campaigns WHERE id = ?').get(child.body.id).p, null)
})

// ------------------------------------------------------------ isolation -----

test('every :id route returns an indistinguishable 404 across workspaces', async () => {
  const theirMailbox = seedMailbox(db, stranger.id, 'theirs@example.com')
  const theirs = seedCampaign(db, stranger.id, 'Their private campaign', theirMailbox.id)
  db.prepare('UPDATE campaigns SET mermaid = ? WHERE id = ?').run(VALID_PLAYBOOK, theirs.id)
  const theirLead = seedLead(db, stranger.id, 'their-lead@acme.test')
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(theirs.id, theirLead.id)
  const theirMessage = seedMessage(db, stranger.id, {
    campaignId: theirs.id, leadId: theirLead.id, mailboxId: theirMailbox.id,
  })
  const id = theirs.id
  const leadId = theirLead.id

  const gets = [
    `/api/campaigns/${id}/detail`,
    `/api/campaigns/${id}/steps`,
    `/api/campaigns/${id}/mailboxes`,
    `/api/campaigns/${id}/children`,
    `/api/campaigns/${id}/leads`,
    `/api/campaigns/${id}/leads/export`,
    `/api/campaigns/${id}/leads/${leadId}`,
    `/api/campaigns/${id}/leads/${leadId}/messages`,
    `/api/campaigns/${id}/playbook-analytics`,
    `/api/campaigns/${id}/top-level-analytics`,
    `/api/campaigns/${id}/step-statistics`,
  ]
  for (const url of gets) {
    const res = await client.get(url)
    assert.equal(res.status, 404, url)
    assert.equal(res.body.message, 'No such campaign', url)
    assert.equal(JSON.stringify(res.body).includes('Their private campaign'), false, url)
  }

  const posts = [
    [`/api/campaigns/${id}/duplicate`, {}],
    [`/api/campaigns/${id}/children`, { name: 'x' }],
    [`/api/campaigns/${id}/mailboxes`, { mailboxIds: [1] }],
    [`/api/campaigns/${id}/leads/import`, { leads: [{ email: 'x@y.test' }] }],
    [`/api/campaigns/${id}/leads/remove`, { leadIds: [leadId] }],
    [`/api/campaigns/${id}/leads/${leadId}`, { first_name: 'Nope' }],
    [`/api/campaigns/${id}/leads/${leadId}/pause`, {}],
    [`/api/campaigns/${id}/leads/${leadId}/resume`, {}],
    [`/api/campaigns/${id}/leads/${leadId}/complete`, {}],
    [`/api/campaigns/${id}/leads/${leadId}/unsubscribe`, {}],
    [`/api/campaigns/${id}/leads/${leadId}/intent`, { intent: 'interested' }],
    [`/api/campaigns/${id}/leads/${leadId}/mailbox`, { mailbox_id: theirMailbox.id }],
    [`/api/campaigns/${id}/messages/bulk`, { leadIds: [leadId] }],
    [`/api/campaigns/${id}/messages/${theirMessage.id}/forward`, { to: ['a@b.test'], confirm: true }],
    [`/api/campaigns/${id}/threads/${theirMessage.id}/reply`, { body: 'hi', confirm: true }],
    [`/api/campaigns/${id}/test-send`, { node_id: 'A', to_email: 'a@b.test', confirm: true }],
  ]
  for (const [url, body] of posts) {
    const res = await client.post(url, body)
    assert.equal(res.status, 404, url)
    assert.equal(res.body.error, 'not_found', url)
  }

  const puts = [
    [`/api/campaigns/${id}/status`, { status: 'START' }],
    [`/api/campaigns/${id}/settings`, { follow_up_percentage: 10 }],
    [`/api/campaigns/${id}/schedule`, { start_hour: '09:00', end_hour: '10:00' }],
    [`/api/campaigns/${id}/sequence`, { mermaid: VALID_PLAYBOOK }],
    [`/api/campaigns/${id}/owner`, { user_id: owner.id }],
  ]
  for (const [url, body] of puts) {
    const res = await client.put(url, body)
    assert.equal(res.status, 404, url)
  }

  const deletes = [
    `/api/campaigns/${id}/permanent`,
    `/api/campaigns/${id}/mailboxes/${theirMailbox.id}`,
    `/api/campaigns/${id}/children/1`,
  ]
  for (const url of deletes) {
    const res = await client.del(url)
    assert.equal(res.status, 404, url)
  }

  const patched = await client.patch(`/api/campaigns/${id}`, { status: 'archived' })
  assert.equal(patched.status, 404)

  // Nothing over there changed.
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id).status, 'draft')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(id).n, 1)
})

test('a lead from another workspace is a 404 even on the caller\'s own campaign', async () => {
  const { campaign } = readyCampaign('lead-isolation')
  const theirLead = seedLead(db, stranger.id, 'outsider@acme.test')
  const res = await client.get(`/api/campaigns/${campaign.id}/leads/${theirLead.id}`)
  assert.equal(res.status, 404)
  assert.equal(res.body.message, 'No such lead')
})

// ===========================================================================
// Regression tests for the audit findings in Docs/REQUIREMENTS-MATRIX.md.
//
// Each one fails against the code as it was, not merely against a shape: the
// audit found these precisely because shape assertions passed while the
// parameters were ignored and the numbers were wrong.
// ===========================================================================

// ------------------------------------------- campaigns/statistics.md --------

const TWO_STEP_PLAYBOOK = `flowchart TD
    S([Start]) --> A[Send: intro]
    A -- reply: interested --> W([Won: call booked])
    A -- no reply 3d --> B[Send: follow up]
    B -- reply: interested --> W
    B -- no reply 5d --> L([Lost: no response])
`

// A campaign whose history exercises every documented row flag: two steps, four
// leads, one open, one click, one bounce, one reply, one unsubscribe.
function statisticsFixture(name) {
  const mailbox = seedMailbox(db, owner.id, `${name}@example.com`)
  const campaign = seedCampaign(db, owner.id, name, mailbox.id)
  db.prepare('UPDATE campaigns SET mermaid = ? WHERE id = ?').run(TWO_STEP_PLAYBOOK, campaign.id)

  const make = (local, first, last) => {
    const lead = seedLead(db, owner.id, `${local}@${name}.test`, { first_name: first, last_name: last })
    db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, ?, ?)')
      .run(campaign.id, lead.id, 'A', 'waiting')
    return lead
  }
  const opener = make('opener', 'Olive', 'Opener')
  const clicker = make('clicker', 'Clara', 'Clicker')
  const bouncer = make('bouncer', 'Boris', 'Bouncer')
  const leaver = make('leaver', 'Lena', 'Leaver')

  const send = (leadId, node, when, extra = {}) => {
    const m = seedMessage(db, owner.id, {
      campaignId: campaign.id, leadId, mailboxId: mailbox.id, direction: 'out', subject: `Step ${node}`,
    })
    const sets = { node_id: node, created_at: when, ...extra }
    db.prepare(`UPDATE messages SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...Object.values(sets), m.id)
    return m
  }
  // Step A on the 10th, step B on the 20th, so the sent-time window has
  // something to bite on.
  send(opener.id, 'A', '2026-03-10 09:00:00', { opened_at: '2026-03-10 10:00:00' })
  send(clicker.id, 'A', '2026-03-10 09:00:00', { clicked_at: '2026-03-10 10:00:00' })
  send(bouncer.id, 'A', '2026-03-10 09:00:00', { send_status: 'bounced' })
  send(leaver.id, 'B', '2026-03-20 09:00:00')
  const replier = seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: opener.id, mailboxId: mailbox.id, direction: 'in', intent: 'interested',
  })
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run('2026-03-11 09:00:00', replier.id)
  db.prepare("UPDATE campaign_leads SET unsubscribed_at = '2026-03-21 09:00:00' WHERE campaign_id = ? AND lead_id = ?")
    .run(campaign.id, leaver.id)
  // A test send, which must never reach a count.
  send(opener.id, 'A', '2026-03-12 09:00:00', { send_status: 'test' })

  return { campaign, opener, clicker, bouncer, leaver }
}

test('statistics implements the documented parameter names, not just Harry\'s', async () => {
  const { campaign } = statisticsFixture('stats-contract')
  const url = (qs) => `/api/campaigns/${campaign.id}/step-statistics?${qs}`

  // email_sequence_number resolves to the Send step at that position. Before
  // this existed the parameter was ignored entirely and every row came back.
  const stepOne = await client.get(url('email_sequence_number=1'))
  assert.equal(stepOne.status, 200)
  assert.equal(stepOne.body.total, 3, 'three real sends on step 1; the test send is excluded')
  assert.ok(stepOne.body.rows.every((r) => r.sequence_number === 1), 'every row is step 1')
  assert.ok(stepOne.body.rows.every((r) => r.step === 'A'))

  const stepTwo = await client.get(url('email_sequence_number=2'))
  assert.equal(stepTwo.body.total, 1)
  assert.equal(stepTwo.body.rows[0].sequence_number, 2)

  // TC-4: out of range names the field and states the whole 1-20 bound.
  const tooHigh = await client.get(url('email_sequence_number=25'))
  assert.equal(tooHigh.status, 422)
  assert.equal(tooHigh.body.field, 'email_sequence_number')
  assert.match(tooHigh.body.message, /1 to 20/)
  assert.equal((await client.get(url('email_sequence_number=0'))).status, 422)

  // A number inside the bound that this playbook has no step for is an empty
  // page, not an error.
  const noStep = await client.get(url('email_sequence_number=7'))
  assert.equal(noStep.status, 200)
  assert.deepEqual(noStep.body.rows, [])
  assert.equal(noStep.body.total, 0)

  // The documented sent-time window. Harry's `from`/`to` still work and mean
  // the same thing.
  const march10 = await client.get(url('sent_time_start_date=2026-03-09&sent_time_end_date=2026-03-11'))
  assert.equal(march10.body.total, 3, 'only the step-1 sends are inside the window')
  const aliased = await client.get(url('from=2026-03-09&to=2026-03-11'))
  assert.equal(aliased.body.total, march10.body.total)
  const inverted = await client.get(url('sent_time_start_date=2026-03-20&sent_time_end_date=2026-03-01'))
  assert.equal(inverted.status, 422)
  assert.equal(inverted.body.field, 'sent_time_end_date', 'the 422 names the parameter the caller sent')
})

test('statistics rows carry the documented fields, and email_status filters on them', async () => {
  const { campaign, opener, leaver } = statisticsFixture('stats-rows')
  const url = (qs) => `/api/campaigns/${campaign.id}/step-statistics?${qs}`

  const all = await client.get(url('limit=100'))
  assert.equal(all.body.total, 4)
  const openerRow = all.body.rows.find((r) => r.lead_email === `opener@stats-rows.test`)
  // The fields the spec names, none of which existed before.
  assert.equal(openerRow.lead_name, 'Olive Opener')
  assert.equal(openerRow.lead_email, `opener@stats-rows.test`)
  assert.equal(openerRow.sequence_number, 1)
  assert.ok(openerRow.sent_time, 'sent_time is populated')
  assert.equal(openerRow.is_opened, true)
  assert.equal(openerRow.is_clicked, false)
  assert.equal(openerRow.is_replied, true)
  assert.equal(openerRow.is_bounced, false)

  // Each documented status returns exactly the rows it names. Every one of the
  // four below used to be rejected or ignored.
  const opened = await client.get(url('email_status=opened'))
  assert.equal(opened.body.total, 1)
  assert.ok(opened.body.rows.every((r) => r.is_opened === true))

  const clicked = await client.get(url('email_status=clicked'))
  assert.equal(clicked.body.total, 1)
  assert.equal(clicked.body.rows[0].lead_email, `clicker@stats-rows.test`)

  // TC-9.
  const bounced = await client.get(url('email_status=bounced'))
  assert.equal(bounced.body.total, 1)
  assert.ok(bounced.body.rows.every((r) => r.is_bounced === true))

  const replied = await client.get(url('email_status=replied'))
  assert.equal(replied.body.total, 1)
  assert.equal(replied.body.rows[0].leadId, opener.id)

  const unsub = await client.get(url('email_status=unsubscribed'))
  assert.equal(unsub.body.total, 1, 'unsubscribed is a documented status and returns its rows')
  assert.equal(unsub.body.rows[0].leadId, leaver.id)

  const nonsense = await client.get(url('email_status=vibes'))
  assert.equal(nonsense.status, 422)
  assert.equal(nonsense.body.field, 'email_status')
})

test('the statistics rollup counts exactly the rows beside it', async () => {
  const { campaign } = statisticsFixture('stats-rollup')
  const url = (qs) => `/api/campaigns/${campaign.id}/step-statistics?${qs}`

  const all = await client.get(url('limit=1'))
  assert.equal(all.body.rollup.sent, 4, 'four real sends; the test send never counts')
  assert.equal(all.body.rollup.contacted, 4)
  assert.equal(all.body.rollup.opened, 1)
  assert.equal(all.body.rollup.clicked, 1)
  assert.equal(all.body.rollup.bounced, 1)
  assert.equal(all.body.rollup.replied, 1)
  assert.equal(all.body.rollup.unsubscribed, 1)
  assert.equal(all.body.rollup.total_leads, 4)
  // The rates come from server/metrics.js: opens per email sent, replying
  // leads per lead contacted.
  assert.equal(all.body.rollup.open_rate, 25)
  assert.equal(all.body.rollup.reply_rate, 25)

  // The rollup follows the filter rather than reporting the whole campaign
  // beside a filtered page — the §5 DoD this route used to fail outright.
  const stepTwo = await client.get(url('email_sequence_number=2'))
  assert.equal(stepTwo.body.rollup.sent, 1)
  assert.equal(stepTwo.body.rollup.sent, stepTwo.body.total)
  assert.equal(stepTwo.body.rollup.opened, 0)
  assert.equal(stepTwo.body.rollup.reflects_filters, true)

  const bounced = await client.get(url('email_status=bounced'))
  assert.equal(bounced.body.rollup.sent, 1)
  assert.equal(bounced.body.rollup.bounced, 1)
})

// ---------------------------------------------- campaigns/get-leads.md ------

test('the leads page is one query, not one per lead', async () => {
  const { campaign } = readyCampaign('leads-query-count')
  const leads = []
  for (let i = 0; i < 40; i++) leads.push({ email: `bulk${i}@count.test`, first_name: `Lead${i}` })
  await client.post(`/api/campaigns/${campaign.id}/leads/import`, { leads })

  // The defect was per-lead work: the route loaded every campaign_leads row and
  // ran an aggregate subquery for each one, so page 1 of a 50,000-lead campaign
  // issued ~50,001 queries. Counting prepared statements is the only assertion
  // that catches that — every shape assertion passed while it was happening.
  const realPrepare = db.prepare.bind(db)
  let prepared = 0
  db.prepare = (sql) => { prepared += 1; return realPrepare(sql) }
  let page
  try {
    page = await client.get(`/api/campaigns/${campaign.id}/leads?limit=10`)
  } finally {
    db.prepare = realPrepare
  }
  assert.equal(page.status, 200)
  assert.equal(page.body.leads.length, 10)
  assert.equal(page.body.total, 41, 'the count is the filtered total, not the page length')
  assert.ok(prepared < 20, `a 41-lead page should not scale with the audience (prepared ${prepared} statements)`)
})

test('leads filters, counts and slices in SQL, and the export walks the same query', async () => {
  const { campaign, lead } = readyCampaign('leads-sql-filters')
  await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [
      { email: 'opened@sqlf.test', first_name: 'Ora' },
      { email: 'clicked@sqlf.test', first_name: 'Cliff' },
      { email: 'replied@sqlf.test', first_name: 'Rae' },
      { email: 'quiet@sqlf.test', first_name: 'Quinn' },
    ],
  })
  const idOf = (email) => db.prepare('SELECT id FROM leads WHERE user_id = ? AND email = ?').get(owner.id, email).id
  const touch = (email, extra, direction = 'out') => {
    const m = seedMessage(db, owner.id, { campaignId: campaign.id, leadId: idOf(email), direction })
    if (Object.keys(extra).length) {
      db.prepare(`UPDATE messages SET ${Object.keys(extra).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...Object.values(extra), m.id)
    }
  }
  touch('opened@sqlf.test', { opened_at: '2026-03-10 10:00:00' })
  touch('clicked@sqlf.test', { clicked_at: '2026-03-10 10:00:00' })
  touch('replied@sqlf.test', {}, 'in')

  const opened = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=opened`)
  assert.equal(opened.body.total, 1)
  assert.equal(opened.body.leads[0].email, 'opened@sqlf.test')

  const clicked = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=clicked`)
  assert.equal(clicked.body.total, 1)
  assert.equal(clicked.body.leads[0].email, 'clicked@sqlf.test')

  const replied = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=replied`)
  assert.equal(replied.body.total, 1)
  assert.equal(replied.body.leads[0].replies, 1)

  // Nothing at all: the campaign's own lead plus Quinn.
  const silent = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=none`)
  assert.equal(silent.body.total, 2)
  assert.ok(silent.body.leads.every((r) => !r.opens && !r.clicks && !r.replies))

  // `total` is the filtered count even when the page is smaller than it.
  const paged = await client.get(`/api/campaigns/${campaign.id}/leads?limit=2`)
  assert.equal(paged.body.leads.length, 2)
  assert.equal(paged.body.total, 5)
  const second = await client.get(`/api/campaigns/${campaign.id}/leads?limit=2&offset=2`)
  const firstIds = paged.body.leads.map((r) => r.leadId)
  assert.equal(second.body.leads.some((r) => firstIds.includes(r.leadId)), false, 'pages do not overlap')

  // An inclusive date boundary, pushed into SQL with everything else.
  const boundary = await client.get(
    `/api/campaigns/${campaign.id}/leads?lastSentAfter=${encodeURIComponent('2026-03-10T00:00:00Z')}`
  )
  assert.equal(boundary.body.total, 2, 'the two leads with an outbound send on or after the bound')

  // The export produces exactly the rows the same filter shows, and does it
  // without asking for 50,000 of them first.
  const realPrepare = db.prepare.bind(db)
  let prepared = 0
  db.prepare = (sql) => { prepared += 1; return realPrepare(sql) }
  let csv
  try {
    csv = await client.get(`/api/campaigns/${campaign.id}/leads/export?engagement=opened`)
  } finally {
    db.prepare = realPrepare
  }
  const text = csv.body.raw ?? csv.body
  const lines = text.trim().split('\r\n')
  assert.equal(lines.length, 2, 'header plus the one row the filter shows')
  assert.ok(lines[1].includes('opened@sqlf.test'))
  assert.ok(prepared < 20, `the export streams one query (prepared ${prepared} statements)`)
  assert.ok(lead.email)
})

// --------------------------------------- campaigns/update-sequences.md ------

test('a sequence save can be previewed before it is committed, and long delays are refused', async () => {
  const { campaign, lead } = readyCampaign('sequence-preview')
  const renamed = VALID_PLAYBOOK.replace(/\bA\b/g, 'Intro')

  const preview = await client.put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: renamed, preview: true })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.preview, true)
  assert.equal(preview.body.saved, false)
  assert.equal(preview.body.remapped, 1, 'the lead standing at A would be parked')
  assert.equal(preview.body.remapping[0].node, 'A')
  assert.equal(preview.body.remapping[0].leads, 1)
  assert.equal(preview.body.remapping[0].goesTo, 'needs_attention')
  // Each step with its id and resolved position, as the response is required
  // to carry back.
  assert.deepEqual(preview.body.data.filter((s) => s.type === 'send').map((s) => [s.id, s.position]), [['Intro', 1]])
  // Nothing was written: that is the whole point of a preview.
  assert.equal(db.prepare('SELECT mermaid FROM campaigns WHERE id = ?').get(campaign.id).mermaid, VALID_PLAYBOOK)
  assert.equal(db.prepare('SELECT state FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).state, 'waiting')

  // 0-365 days, named per step.
  const tooLong = await client.put(`/api/campaigns/${campaign.id}/sequence`, {
    mermaid: VALID_PLAYBOOK.replace('no reply 3d', 'no reply 400d'),
  })
  assert.equal(tooLong.status, 422)
  assert.equal(tooLong.body.field, 'mermaid')
  assert.match(tooLong.body.message, /0 and 365 days/)
  assert.equal(db.prepare('SELECT mermaid FROM campaigns WHERE id = ?').get(campaign.id).mermaid, VALID_PLAYBOOK)

  // The real save reports the same remapping the preview promised.
  const saved = await client.put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: renamed })
  assert.equal(saved.body.remapped, preview.body.remapped)
  assert.deepEqual(saved.body.remapping, preview.body.remapping)
  assert.equal(saved.body.data.length, preview.body.data.length)
})

// ---------------------------------------------- campaigns/add-leads.md ------

test('add-leads accepts the documented field names and is idempotent', async () => {
  const { campaign } = readyCampaign('add-leads-contract')
  const body = {
    leads: [{
      email: 'documented@fields.test',
      first_name: 'Dee',
      company_name: 'Documented Ltd',
      phone_number: '+44 20 7946 0000',
      linkedin_profile: 'https://linkedin.com/in/dee',
      company_url: 'https://documented.example',
    }],
  }
  const first = await client.post(`/api/campaigns/${campaign.id}/leads/import`, body)
  assert.equal(first.status, 200)
  assert.equal(first.body.added_count, 1, 'the documented spelling is returned too')
  assert.equal(first.body.skipped_count, 0)
  assert.deepEqual(first.body.lead_ids, first.body.leadIds)

  // The source API's field names land in Harry's columns rather than being
  // dropped on the floor.
  const stored = db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(owner.id, 'documented@fields.test')
  assert.equal(stored.company, 'Documented Ltd')
  assert.equal(stored.phone, '+44 20 7946 0000')
  assert.equal(stored.linkedin, 'https://linkedin.com/in/dee')
  assert.equal(stored.website, 'https://documented.example')

  // §5 DoD: the same batch twice yields the same lead and link counts.
  const leadsBefore = db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ?').get(owner.id).n
  const linksBefore = db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n
  const again = await client.post(`/api/campaigns/${campaign.id}/leads/import`, body)
  assert.equal(again.body.added_count, 0)
  assert.equal(again.body.skippedByReason.already_in_campaign, 1)
  assert.equal(again.body.reusedExistingCount, 1, 'the person was matched, not duplicated')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ?').get(owner.id).n, leadsBefore)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n, linksBefore)
})

// ------------------------------------------------------------ telemetry ----

test('campaigns routes write the telemetry row every §5 Scope asks for', async () => {
  const { campaign } = readyCampaign('telemetry-rows')
  const before = db.prepare("SELECT COUNT(*) n FROM telemetry WHERE op LIKE 'campaigns%'").get().n

  await client.get(`/api/campaigns/${campaign.id}/detail`)
  await client.get(`/api/campaigns/${campaign.id}/steps`)
  await client.get(`/api/campaigns/${campaign.id}/leads?limit=5`)
  await client.get(`/api/campaigns/${campaign.id}/step-statistics`)
  await client.post(`/api/campaigns/${campaign.id}/leads/import`, { leads: [{ email: 'metered@tel.test' }] })

  const rows = db.prepare("SELECT op, ok FROM telemetry WHERE op LIKE 'campaigns%' ORDER BY id").all()
  assert.ok(rows.length >= before + 5, `five calls should leave five rows, got ${rows.length - before}`)
  const ops = rows.map((r) => r.op)
  assert.ok(ops.some((op) => op.includes('/campaigns/:id/detail')), 'get-by-id is metered')
  assert.ok(ops.some((op) => op.includes('/campaigns/:id/steps')), 'get-sequences is metered')
  assert.ok(ops.includes('campaigns.leads'), 'the leads list records its filter shape')
  assert.ok(ops.includes('campaigns.step-statistics'), 'statistics records its filter shape')
  assert.ok(ops.includes('campaigns.leads-import'), 'add-leads records batch size and duration')

  // A refused call is telemetry too, marked as a failure.
  const failures = db.prepare("SELECT COUNT(*) n FROM telemetry WHERE op LIKE 'campaigns%' AND ok = 0").get().n
  await client.put(`/api/campaigns/${campaign.id}/status`, { status: 'ACTIVE' })
  assert.equal(db.prepare("SELECT COUNT(*) n FROM telemetry WHERE op LIKE 'campaigns%' AND ok = 0").get().n, failures + 1)
})
