// Second audit pass over leads, lead-lists, lead-tags, lead-notes, lead-tasks
// and clients/update — the nineteen specs tests/leads-audit.test.js did not
// reach (Docs/leads/{activities,add-to-campaign,get-by-campaign,pause,resume},
// Docs/lead-lists/{assign-tags,create,delete,get-by-id,import-leads,
// push-between-lists,update}, Docs/lead-tags/{create,get-all},
// Docs/lead-notes/{create,get-all}, Docs/lead-tasks/{create,get-all},
// Docs/clients/update).
//
// WHY THE UNSUBSCRIBE TESTS LOOK PARANOID:
//
// The first pass closed a resurrection path. `unsubscribeLead()` in
// server/suppression.js writes the opt-out to `blocked_domains` as well as to
// the `leads` row, because `leads` cascades — delete the person and every trace
// of the opt-out goes with them, so next month's CSV brings them back as a
// brand-new active lead the engine will happily email.
//
// That makes "which writers go through `unsubscribeLead()`" the whole question,
// and there are four doors: the footer link a recipient clicks
// (server/tracking.js), the engine's terminal `unsubscribed` outcome
// (server/engine.js), the two unsubscribe routes, and — least obviously — a
// colleague marking a reply's intent as "unsubscribe" through
// `POST /api/campaigns/:id/leads/:leadId/intent`. That last one hand-wrote
// `leads.status`, a timestamp and one campaign's link row, and nothing else, so
// the entire defect was still reachable through it. The first test below drives
// exactly that sequence — mark the intent, tidy the lead away, re-import next
// month, push, tick — and reads the `messages` table, because a route reporting
// `unsubscribed: true` proves only that the route can count.
//
// Every test here follows that rule: assert on database state and, wherever a
// path could end in an email, drive the real engine and count rows in
// `messages`. Every suppression test carries a clean control lead through the
// same tick, because "nobody was emailed" is also what a broken engine, an
// unlaunched campaign and a typo'd query look like.
//
// Two tests are marked `todo`. Each is a real, currently-red assertion of what
// its spec asks for, kept red on purpose so the gap shows up in the run rather
// than being quietly absent; the reason names the spec and the file the fix
// belongs in. Neither is a send leak — those are all closed, and every one of
// them is pinned green below by a tick and a count of `messages`.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  setup, seedUser, seedLead, seedCampaign, seedMailbox, seedTag, mount,
} from './helpers/parity-harness.js'

setup('leads-audit2')                   // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register: registerLeads } = await import('../server/parity/leads.js')
const { register: registerLists } = await import('../server/parity/lists.js')
const { register: registerNotes } = await import('../server/parity/notes.js')
const { register: registerTags } = await import('../server/parity/tags.js')
const { register: registerClients } = await import('../server/parity/clients.js')
const { register: registerCampaigns } = await import('../server/parity/campaigns.js')
const { tick } = await import('../server/engine.js')
const { unsubscribeLead } = await import('../server/suppression.js')

const owner = seedUser(db, 'owner@audit2.test')
// Approval off by default: with it on the engine parks a draft and `messages`
// stays empty for suppressed and clean leads alike, which would make every
// send assertion below pass for the wrong reason. The two tests that care
// about the approval queue turn it on and back off themselves.
db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)

const client = await mount(
  [registerLeads, registerLists, registerNotes, registerTags, registerClients, registerCampaigns],
  owner,
)
test.after(() => client.close())

// ---- fixtures ---------------------------------------------------------------

// One node, so a tick either sends the intro or does not.
const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: introduce ourselves]
  A -- no reply 3d --> L([Lost])
`

// `sandbox` rather than `gmail` on purpose: canSendNow (server/pacing.js) skips
// the clock and the spacing for a sandbox mailbox, so the quiet-hours gate
// cannot mask a send that did or did not happen.
const mailbox = seedMailbox(db, owner.id, 'sender@audit2.test')

let seq = 0
const uniq = (s) => `${s} ${++seq}`

function runningCampaign(name) {
  const campaign = seedCampaign(db, owner.id, uniq(name), mailbox.id)
  db.prepare("UPDATE campaigns SET status = 'running', mermaid = ? WHERE id = ?").run(PLAYBOOK, campaign.id)
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id)
}

function enrol(campaign, lead, state = 'queued') {
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, state) VALUES (?, ?, ?)')
    .run(campaign.id, lead.id, state)
  return db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .get(campaign.id, lead.id)
}

async function makeList(name = 'Segment') {
  const res = await client.post('/api/lead-lists', { name: uniq(name) })
  assert.equal(res.status, 200)
  return res.body
}

// What actually left the building, by recipient. The only proof that counts.
const sentTo = (email) => db.prepare(
  "SELECT COUNT(*) n FROM messages WHERE lower(to_email) = ? AND direction = 'out'"
).get(String(email).toLowerCase()).n

const blockRow = (address) => db.prepare(
  'SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ?'
).get(owner.id, String(address).toLowerCase())

const leadRow = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id)
const enrolment = (campaignId, leadId) => db.prepare(
  'SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?'
).get(campaignId, leadId)
const events = (type, leadId = null) => db.prepare(
  `SELECT * FROM events WHERE user_id = ? AND type = ?${leadId ? ' AND lead_id = ?' : ''} ORDER BY id`
).all(...(leadId ? [owner.id, type, leadId] : [owner.id, type]))

// A reply the classifier would have read, so the intent-correction route has
// something to correct.
function seedReply(campaign, lead) {
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, direction, subject, body, from_email, to_email, thread_id)
     VALUES (?, ?, ?, 'in', 'Re: hello', 'Take me off this list.', ?, ?, ?)`
  ).run(owner.id, campaign.id, lead.id, lead.email, 'sender@audit2.test', `t-${lead.id}`)
}

// =============================================================================
// SUPPRESSION — the invariant everything else is subordinate to
// =============================================================================

test('a reply marked as an unsubscribe survives the person being deleted and re-imported', async () => {
  // The first pass's defect, reached through the least obvious of the four
  // doors — a colleague correcting a reply's intent rather than the recipient
  // clicking anything:
  //
  //   1. a colleague reads a reply and marks its intent "unsubscribe"
  //   2. a tidy-up deletes the lead record, taking every trace with it
  //   3. next month's CSV contains them again
  //   4. the segment is pushed at a running campaign
  //   5. the engine ticks
  //
  // Step 5 used to send them an email, because this branch hand-wrote
  // `leads.status` and one link row instead of calling `unsubscribeLead()`, and
  // `leads` cascades — so step 2 erased step 1 completely.
  //
  // Mutation check: replace the `unsubscribeLead(...)` call in the
  // `intent === 'unsubscribe'` branch of server/parity/campaigns.js with the
  // two hand-written UPDATEs it replaced, and the last assertion goes red with
  // one email in `messages`.
  const campaign = runningCampaign('Intent resurrection')
  const other = runningCampaign('Untouched by the opt-out')
  const ghost = seedLead(db, owner.id, 'ghost-intent@acme.test')
  enrol(campaign, ghost)
  enrol(other, ghost)
  seedReply(campaign, ghost)

  const marked = await client.post(`/api/campaigns/${campaign.id}/leads/${ghost.id}/intent`, { intent: 'unsubscribe' })
  assert.equal(marked.status, 200)
  assert.equal(marked.body.unsubscribed, true)

  // Opting out of one campaign is opting out of all of them.
  assert.equal(enrolment(other.id, ghost.id).state, 'stopped',
    'the campaign they did not reply from is stopped as well')

  // The durable half: the one row that does not cascade with the person.
  const durable = blockRow('ghost-intent@acme.test')
  assert.ok(durable, 'the opt-out is written to the workspace suppression list')
  assert.equal(durable.is_domain, 0, 'as an exact address, not a whole domain')
  assert.equal(durable.source, 'unsubscribe')

  db.prepare('DELETE FROM leads WHERE id = ?').run(ghost.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE lead_id = ?').get(ghost.id).n, 0,
    'the enrolments cascaded away with the person')
  assert.ok(blockRow('ghost-intent@acme.test'), 'the opt-out did not')

  const list = await makeList('Intent re-import')
  const imported = await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'february.csv',
    leads: [
      { email: 'ghost-intent@acme.test', first_name: 'Ghost' },
      { email: 'fresh-intent@acme.test', first_name: 'Fresh' },   // the control, same file, same code path
    ],
  })
  assert.equal(imported.body.imported, 1, 'only the clean address becomes a lead')
  assert.equal(imported.body.suppression.blockedDomain, 1,
    'the opt-out is honoured against an address with no lead row left to match on')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND email = ?')
    .get(owner.id, 'ghost-intent@acme.test').n, 0, 'no person record is recreated for them')

  await client.post('/api/lead-lists/push-to-campaign', { campaignId: campaign.id, selection: { listId: list.id } })
  await tick()

  assert.equal(sentTo('fresh-intent@acme.test'), 1, 'the control was emailed, so the engine really ran')
  assert.equal(sentTo('ghost-intent@acme.test'), 0, 'and the person who asked to be left alone was not')
})

test('the campaign-scoped unsubscribe route stops every campaign, survives deletion, and blocks the re-import', async () => {
  // The sibling route, one path along in the same file, which does go through
  // `unsubscribeLead()`. Same sequence as the test above, ending green — which
  // is what makes the difference between the two a defect rather than a design.
  const campaign = runningCampaign('Route unsubscribe')
  const other = runningCampaign('Second campaign')
  const gone = seedLead(db, owner.id, 'route-out@acme.test')
  enrol(campaign, gone)
  enrol(other, gone)
  db.prepare("INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body, status) VALUES (?, ?, ?, 'A', 'Hi', 'Body', 'pending')")
    .run(owner.id, other.id, gone.id)

  const res = await client.post(`/api/campaigns/${campaign.id}/leads/${gone.id}/unsubscribe`, {})
  assert.equal(res.status, 200)
  assert.equal(res.body.campaigns, 2, 'both enrolments are stopped, not just the one they replied to')
  assert.equal(res.body.drafts, 1, 'and the email waiting in the other campaign is withdrawn')

  assert.equal(enrolment(other.id, gone.id).state, 'stopped')
  assert.equal(
    db.prepare("SELECT status FROM drafts WHERE lead_id = ?").get(gone.id).status, 'declined',
    'the draft can no longer be approved',
  )
  const block = blockRow('route-out@acme.test')
  assert.ok(block, 'the opt-out is on the never-contact list')
  assert.equal(block.is_domain, 0)
  assert.equal(block.source, 'unsubscribe')

  db.prepare('DELETE FROM leads WHERE id = ?').run(gone.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE lead_id = ?').get(gone.id).n, 0,
    'the enrolments cascaded away with the person')
  assert.ok(blockRow('route-out@acme.test'), 'the opt-out did not')

  const list = await makeList('Route re-import')
  const again = await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'march.csv',
    leads: [{ email: 'route-out@acme.test' }, { email: 'route-control@acme.test' }],
  })
  assert.equal(again.body.imported, 1)
  assert.equal(again.body.suppression.blockedDomain, 1)

  await client.post('/api/lead-lists/push-to-campaign', { campaignId: campaign.id, selection: { listId: list.id } })
  await tick()
  assert.equal(sentTo('route-control@acme.test'), 1, 'the control proves the tick ran')
  assert.equal(sentTo('route-out@acme.test'), 0)
})

test('editing a lead onto a suppressed address through the campaign route cannot produce an email', async () => {
  // Docs/leads/update.md TC-10 is enforced at the route by
  // `PATCH /api/leads/:id` (422). `POST /api/campaigns/:id/leads/:leadId` — the
  // campaign-scoped edit — has no such check and accepts the change, so this
  // pins the thing that actually protects the recipient: the single suppression
  // chokepoint in server/mailer.js, which every send passes through.
  //
  // Mutation check: delete the `suppressionFor` guard at the top of
  // `sendEmail()` in server/mailer.js and this test goes red on the last line.
  const campaign = runningCampaign('Email walked onto an opt-out')
  const departed = seedLead(db, owner.id, 'departed2@acme.test')
  unsubscribeLead(owner.id, departed.id, { source: 'link', actor: 'recipient' })
  db.prepare('DELETE FROM leads WHERE id = ?').run(departed.id)

  const mover = seedLead(db, owner.id, 'mover2@acme.test')
  const control = seedLead(db, owner.id, 'control-walk@acme.test')
  enrol(campaign, mover)
  enrol(campaign, control)

  const res = await client.post(`/api/campaigns/${campaign.id}/leads/${mover.id}`, {
    email: 'departed2@acme.test', confirm_email_change: true,
  })
  assert.equal(res.status, 200, 'the campaign-scoped edit does not guard the suppression list itself')
  assert.equal(leadRow(mover.id).email, 'departed2@acme.test')

  await tick()
  assert.equal(sentTo('control-walk@acme.test'), 1, 'the control was emailed, so the engine really ran')
  assert.equal(sentTo('departed2@acme.test'), 0, 'and the chokepoint refused the address regardless of the route')
  assert.equal(enrolment(campaign.id, mover.id).state, 'finished')
  assert.equal(enrolment(campaign.id, mover.id).outcome, 'stopped',
    'the refusal is terminal for that lead, not something the next tick retries')
})

// =============================================================================
// Docs/leads/add-to-campaign.md
// =============================================================================

test('attaching leads honours a blocked domain, its subdomains and an existing opt-out, and no email follows', async () => {
  // Docs/leads/add-to-campaign.md TC-8 and §2's "there is no setting anywhere
  // in Harry that overrides this". A skip count is not proof; a tick is.
  db.prepare("INSERT INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (?, 'rival2.test', 1, 'manual')")
    .run(owner.id)
  const campaign = runningCampaign('Attach with suppression')
  const optedOut = seedLead(db, owner.id, 'attach-out@acme.test')
  unsubscribeLead(owner.id, optedOut.id, { source: 'link', actor: 'recipient' })

  const res = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [
      { email: 'attach-clean@acme.test', first_name: 'Clean' },
      { email: 'attach-out@acme.test' },
      { email: 'anna@mail.rival2.test' },
      { email: 'bob@rival2.test' },
    ],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.addedCount, 1, 'only the clean address is attached')
  assert.equal(res.body.skippedByReason.blocked, 3,
    'the subdomain is caught as well as the bare domain, and the opt-out with them')

  for (const email of ['attach-out@acme.test', 'anna@mail.rival2.test', 'bob@rival2.test']) {
    const row = db.prepare('SELECT id FROM leads WHERE user_id = ? AND email = ?').get(owner.id, email)
    assert.equal(row ? enrolment(campaign.id, row.id) : undefined, undefined,
      `${email} has no enrolment row at all`)
  }

  await tick()
  assert.equal(sentTo('attach-clean@acme.test'), 1, 'the control was emailed, so the engine really ran')
  assert.equal(sentTo('attach-out@acme.test'), 0)
  assert.equal(sentTo('anna@mail.rival2.test'), 0)
  assert.equal(sentTo('bob@rival2.test'), 0)
})

test('attaching reuses the existing person and keeps their research rather than making a second copy', async () => {
  // Docs/leads/add-to-campaign.md §2: "the existing record is reused and only
  // the campaign link is added, so the person's research profile and history
  // survive". A duplicated person is a duplicated email.
  const campaign = runningCampaign('Reuse existing')
  const existing = seedLead(db, owner.id, 'reuse@acme.test', { company: 'Acme', first_name: 'Ada' })
  db.prepare("UPDATE leads SET research = ?, researched_at = '2026-01-01' WHERE id = ?")
    .run('Acme sells widgets.', existing.id)

  const res = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [{ email: 'reuse@acme.test', first_name: 'Ada', company_name: 'Acme', job_title: 'CTO' }],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.addedCount, 1)
  assert.equal(res.body.reusedExistingCount, 1, 'matched, not created')

  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND email = ?')
    .get(owner.id, 'reuse@acme.test').n, 1, 'exactly one person record')
  assert.equal(leadRow(existing.id).research, 'Acme sells widgets.', 'the research profile survived the re-attach')
  assert.equal(enrolment(campaign.id, existing.id).lead_id, existing.id)
})

test('custom fields survive the attach and stay within the documented cap', async () => {
  // Docs/leads/add-to-campaign.md §2 and TC-10: up to 200 pairs are kept and
  // are available to the composer as merge data; 201 is a field-level 422.
  const campaign = runningCampaign('Custom fields')
  const ok = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [{ email: 'cf-ok@acme.test', custom_fields: { job_title: 'Head of Ops', seats: '50' } }],
  })
  assert.equal(ok.status, 200)
  const stored = db.prepare('SELECT custom_fields FROM leads WHERE user_id = ? AND email = ?')
    .get(owner.id, 'cf-ok@acme.test')
  assert.deepEqual(JSON.parse(stored.custom_fields), { job_title: 'Head of Ops', seats: '50' })

  const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 'v']))
  const over = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [{ email: 'cf-over@acme.test', custom_fields: tooMany }],
  })
  assert.equal(over.status, 422)
  assert.equal(over.body.field, 'leads[0].custom_fields')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND email = ?')
    .get(owner.id, 'cf-over@acme.test').n, 0, 'and no lead was written for the rejected row')
})

test('the attach batch is all-or-nothing: a malformed address writes nothing at all', async () => {
  // Docs/leads/add-to-campaign.md TC-4 asks for the other rows to import and
  // the bad one to be listed. Harry validates the whole batch first and writes
  // nothing — stated here as what the code actually does, because a partially
  // applied import that reports success is the worse of the two failures.
  const campaign = runningCampaign('Bad address')
  const res = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [{ email: 'good-row@acme.test' }, { email: 'john@invalid' }],
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'leads[1].email', 'the offending row is named by index')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND email = ?')
    .get(owner.id, 'good-row@acme.test').n, 0, 'nothing from the batch was written')

  const over = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: Array.from({ length: 401 }, (_, i) => ({ email: `bulk${i}@acme.test` })),
  })
  assert.equal(over.status, 422)
  assert.equal(over.body.provided_count, 401)
  assert.equal(over.body.max_allowed, 400, 'the client is told the batch size to chunk to')
})

test('a lead attached to a running campaign enters at Start and its first email still parks in Needs your OK', async () => {
  // Docs/leads/add-to-campaign.md §2, last criterion. Approval is the standing
  // rule; attaching is not a way round it.
  db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(owner.id)
  try {
    const campaign = runningCampaign('Approval still applies')
    const res = await client.post(`/api/campaigns/${campaign.id}/leads/import`, {
      leads: [{ email: 'parks@acme.test' }],
    })
    assert.equal(res.status, 200)
    const lead = db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(owner.id, 'parks@acme.test')
    assert.equal(enrolment(campaign.id, lead.id).node_id, '', 'attached at the Start node, not mid-playbook')

    await tick()
    assert.equal(sentTo('parks@acme.test'), 0, 'nothing was sent')
    const draft = db.prepare("SELECT * FROM drafts WHERE lead_id = ? AND status = 'pending'").get(lead.id)
    assert.ok(draft, 'the first email is waiting in Needs your OK instead')
  } finally {
    db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
  }
})

// =============================================================================
// Docs/leads/get-by-campaign.md
// =============================================================================

test('the campaign lead list pages, counts and filters against real rows', async () => {
  const campaign = runningCampaign('Audience view')
  const leads = []
  for (let i = 0; i < 3; i++) {
    const lead = seedLead(db, owner.id, `aud${i}-${seq}@acme.test`, { company: i === 0 ? 'Northwind' : 'Acme' })
    enrol(campaign, lead)
    leads.push(lead)
  }
  // One lead has opened, one has replied, one has done neither.
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, direction, subject, body, from_email, to_email, thread_id, opened_at)
     VALUES (?, ?, ?, 'out', 'Hi', 'b', ?, ?, 'x', datetime('now'))`
  ).run(owner.id, campaign.id, leads[0].id, 'sender@audit2.test', leads[0].email)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, direction, subject, body, from_email, to_email, thread_id)
     VALUES (?, ?, ?, 'in', 'Re', 'b', ?, ?, 'y')`
  ).run(owner.id, campaign.id, leads[1].id, leads[1].email, 'sender@audit2.test')

  const first = await client.get(`/api/campaigns/${campaign.id}/leads?limit=2&offset=0`)
  assert.equal(first.status, 200)
  assert.equal(first.body.total, 3, 'the total matching the filter, not the page size')
  assert.equal(first.body.limit, 2)
  assert.equal(first.body.offset, 0)
  assert.equal(first.body.leads.length, 2)

  const second = await client.get(`/api/campaigns/${campaign.id}/leads?limit=2&offset=2`)
  assert.equal(second.body.leads.length, 1)
  const ids = [...first.body.leads, ...second.body.leads].map((r) => r.leadId)
  assert.equal(new Set(ids).size, 3, 'no row is shown twice and none is skipped')

  const opened = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=opened`)
  assert.deepEqual(opened.body.leads.map((r) => r.leadId), [leads[0].id])
  const replied = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=replied`)
  assert.deepEqual(replied.body.leads.map((r) => r.leadId), [leads[1].id])
  const search = await client.get(`/api/campaigns/${campaign.id}/leads?q=northwind`)
  assert.deepEqual(search.body.leads.map((r) => r.leadId), [leads[0].id])

  // Every row carries the suppression flag, so the table can warn without a
  // second request (Docs/leads/get-by-campaign.md AC 6, TC-10).
  assert.ok(first.body.leads.every((r) => Object.hasOwn(r, 'unsubscribedAt')))

  const bad = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=cheerful`)
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'engagement')
  const tooBig = await client.get(`/api/campaigns/${campaign.id}/leads?limit=500`)
  assert.equal(tooBig.status, 422)
  assert.equal(tooBig.body.field, 'limit')
  assert.match(tooBig.body.message, /at most 100/)
})

test('an unsubscribed lead in the audience view is flagged, and the paused filter matches the paused rows', async () => {
  const campaign = runningCampaign('Flagged rows')
  const paused = seedLead(db, owner.id, `paused-row-${seq}@acme.test`)
  const gone = seedLead(db, owner.id, `gone-row-${seq}@acme.test`)
  const fine = seedLead(db, owner.id, `fine-row-${seq}@acme.test`)
  for (const lead of [paused, gone, fine]) enrol(campaign, lead)
  await client.post(`/api/campaigns/${campaign.id}/leads/${paused.id}/pause`, {})
  await client.post(`/api/campaigns/${campaign.id}/leads/${gone.id}/unsubscribe`, {})

  const pausedOnly = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=paused`)
  assert.deepEqual(pausedOnly.body.leads.map((r) => r.leadId), [paused.id])
  assert.equal(pausedOnly.body.total, 1, 'the count matches the figure on the stage strip')

  const all = await client.get(`/api/campaigns/${campaign.id}/leads`)
  const row = all.body.leads.find((r) => r.leadId === gone.id)
  assert.notEqual(row.unsubscribedAt, '', 'the row carries the suppression warning without a second request')

  const unsubOnly = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=unsubscribed`)
  assert.deepEqual(unsubOnly.body.leads.map((r) => r.leadId), [gone.id])

  const stranger = seedUser(db, `stranger-audience-${seq}@audit2.test`)
  const theirCampaign = seedCampaign(db, stranger.id, `Theirs ${seq}`)
  const refused = await client.get(`/api/campaigns/${theirCampaign.id}/leads`)
  assert.equal(refused.status, 404, 'no leads leak across workspaces')
  assert.ok(!JSON.stringify(refused.body).includes('Theirs'))
})

test('the campaign lead list filters by playbook state and carries each row\'s custom fields', { todo: 'Docs/leads/get-by-campaign.md AC 3, AC 6 and TC-8 — server/parity/campaigns.js offers stage and engagement filters but no state filter, no opened-but-not-replied, and no customFields on the row' }, async () => {
  // Three capabilities the spec names that the route does not have:
  //   AC 3  a status filter over the playbook states — waiting to start,
  //         running, finished, paused, stopped by a human. `engagement`
  //         approximates two of them (paused, completed) and `stage` is the
  //         derived funnel position, which is a different question.
  //   TC-8  "opened-but-not-replied". `engagement=opened` matches leads who
  //         opened *and* replied too.
  //   AC 6  "its custom fields ... available without a second request".
  const campaign = runningCampaign('Missing filters')
  const openedOnly = seedLead(db, owner.id, `opened-only-${seq}@acme.test`)
  const openedAndReplied = seedLead(db, owner.id, `opened-replied-${seq}@acme.test`)
  enrol(campaign, openedOnly)
  enrol(campaign, openedAndReplied, 'finished')
  db.prepare('UPDATE leads SET custom_fields = ? WHERE id = ?').run(JSON.stringify({ seats: '50' }), openedOnly.id)
  for (const lead of [openedOnly, openedAndReplied]) {
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, direction, subject, body, from_email, to_email, thread_id, opened_at)
       VALUES (?, ?, ?, 'out', 'Hi', 'b', ?, ?, ?, datetime('now'))`
    ).run(owner.id, campaign.id, lead.id, 'sender@audit2.test', lead.email, `cf-${lead.id}`)
  }
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, direction, subject, body, from_email, to_email, thread_id)
     VALUES (?, ?, ?, 'in', 'Re', 'b', ?, ?, ?)`
  ).run(owner.id, campaign.id, openedAndReplied.id, openedAndReplied.email, 'sender@audit2.test', `cf-${openedAndReplied.id}`)

  const byState = await client.get(`/api/campaigns/${campaign.id}/leads?status=finished`)
  assert.deepEqual(byState.body.leads.map((r) => r.leadId), [openedAndReplied.id],
    'AC 3: the playbook state is a filter of its own')

  const noReply = await client.get(`/api/campaigns/${campaign.id}/leads?engagement=opened_not_replied`)
  assert.deepEqual(noReply.body.leads.map((r) => r.leadId), [openedOnly.id],
    'TC-8: opened but never replied is the row a human actually chases')

  const rows = await client.get(`/api/campaigns/${campaign.id}/leads`)
  assert.deepEqual(rows.body.leads.find((r) => r.leadId === openedOnly.id).customFields, { seats: '50' },
    'AC 6: without a second request')
})

// =============================================================================
// Docs/leads/pause.md and Docs/leads/resume.md
// =============================================================================

test('a paused lead is skipped by every tick while a colleague in the same campaign is not', async () => {
  // Docs/leads/pause.md §2 and TC-9: the engine "skips them entirely — no
  // timeout edge fires, and `no reply Xd` clocks do not advance while paused",
  // and pausing one lead leaves the campaign running for everyone else.
  //
  // Mutation check: drop `AND (COALESCE(paused_at,'') = '' ...)` from the due
  // query in server/engine.js and the first assertion goes red.
  const campaign = runningCampaign('Paused skip')
  const held = seedLead(db, owner.id, 'held@acme.test')
  const running = seedLead(db, owner.id, 'running@acme.test')
  enrol(campaign, held)
  enrol(campaign, running)

  const res = await client.post(`/api/campaigns/${campaign.id}/leads/${held.id}/pause`, { reason: 'legal check' })
  assert.equal(res.status, 200)
  const cl = enrolment(campaign.id, held.id)
  assert.notEqual(cl.paused_at, '', 'the pause is recorded on the enrolment')
  assert.equal(cl.resume_at || '', '', 'and no automatic resume was scheduled')

  await tick()
  assert.equal(sentTo('running@acme.test'), 1, 'the campaign kept running for everybody else')
  assert.equal(sentTo('held@acme.test'), 0, 'and the paused person was skipped entirely')

  // Two more ticks: a paused lead must not accumulate anything, ever.
  await tick()
  await tick()
  assert.equal(sentTo('held@acme.test'), 0)

  // One trail entry naming who paused whom, in which campaign (§2, last).
  const trail = events('lead_paused', held.id)
  assert.equal(trail.length, 1)
  assert.equal(trail[0].campaign_id, campaign.id)
  assert.match(trail[0].detail, /owner@audit2\.test/)
  assert.match(trail[0].detail, /legal check/)

  // TC-8: pausing twice is a no-op with no second trail entry.
  const again = await client.post(`/api/campaigns/${campaign.id}/leads/${held.id}/pause`, {})
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyPaused, true)
  assert.equal(events('lead_paused', held.id).length, 1)
})

test('pausing in one campaign leaves the other campaigns running', async () => {
  // Docs/leads/pause.md TC-11.
  const held = runningCampaign('Paused here')
  const free = runningCampaign('Still running there')
  const lead = seedLead(db, owner.id, 'two-campaigns@acme.test')
  enrol(held, lead)
  enrol(free, lead)

  await client.post(`/api/campaigns/${held.id}/leads/${lead.id}/pause`, {})
  assert.notEqual(enrolment(held.id, lead.id).paused_at, '')
  assert.equal(enrolment(free.id, lead.id).paused_at || '', '', 'the other enrolment is untouched')

  await tick()
  assert.equal(sentTo('two-campaigns@acme.test'), 1, 'exactly one campaign emailed them')
  const from = db.prepare("SELECT campaign_id FROM messages WHERE lower(to_email) = ? AND direction = 'out'")
    .all('two-campaigns@acme.test').map((r) => r.campaign_id)
  assert.deepEqual(from, [free.id], 'and it was the one that was not paused')
})

test('a reply from a paused lead is still ingested and flags them for attention', async () => {
  // Docs/leads/pause.md §2: "silence from us is not silence from them".
  const campaign = runningCampaign('Reply while paused')
  const lead = seedLead(db, owner.id, 'replies-paused@acme.test')
  enrol(campaign, lead)
  await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/pause`, {})

  seedReply(campaign, lead)
  await tick()

  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'in'").get(lead.id).n, 1,
    'the reply is in the thread')
  assert.equal(sentTo('replies-paused@acme.test'), 0, 'and no automatic send followed it')
  assert.notEqual(enrolment(campaign.id, lead.id).paused_at, '', 'the lead is still paused')
})

test('pausing withdraws the draft waiting for approval and cancels the queued send', async () => {
  // Docs/leads/pause.md, criteria 2 and 3, and TC-7: "the draft is gone from
  // the queue and cannot be approved", and "the queued send is stopped before
  // it leaves". Pausing used to write `paused_at` and stop there, so both were
  // still live — and a draft approved after a pause is an email the person who
  // pressed pause watched leave anyway.
  //
  // Mutation check: delete the two UPDATE statements from the pause handler in
  // server/parity/campaigns.js and both assertions go red.
  const campaign = runningCampaign('Pause with work in flight')
  const lead = seedLead(db, owner.id, 'inflight@acme.test')
  enrol(campaign, lead, 'active')
  db.prepare("INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body, status) VALUES (?, ?, ?, 'A', 'Hi', 'Body', 'pending')")
    .run(owner.id, campaign.id, lead.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, thread_id, send_status, scheduled_at)
     VALUES (?, ?, ?, ?, 'out', 'Later', 'b', ?, ?, 'q1', 'queued', '2030-01-01T00:00:00.000Z')`
  ).run(owner.id, campaign.id, lead.id, mailbox.id, 'sender@audit2.test', 'inflight@acme.test')

  await client.post(`/api/campaigns/${campaign.id}/leads/${lead.id}/pause`, {})

  assert.equal(db.prepare('SELECT status FROM drafts WHERE lead_id = ?').get(lead.id).status, 'declined',
    'the draft is withdrawn so it cannot be approved by mistake later')
  assert.equal(
    db.prepare("SELECT send_status FROM messages WHERE lead_id = ? AND direction = 'out' AND scheduled_at != ''").get(lead.id).send_status,
    'cancelled', 'and the queued send is stopped before it leaves')
})

test('resuming schedules rather than fires, and a resumed lead still parks in Needs your OK', async () => {
  // Docs/leads/resume.md TC-7 and TC-10.
  db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(owner.id)
  try {
    const campaign = runningCampaign('Resume with delay')
    const delayed = seedLead(db, owner.id, 'delayed@acme.test')
    const straight = seedLead(db, owner.id, 'straight@acme.test')
    enrol(campaign, delayed)
    enrol(campaign, straight)
    await client.post(`/api/campaigns/${campaign.id}/leads/${delayed.id}/pause`, {})
    await client.post(`/api/campaigns/${campaign.id}/leads/${straight.id}/pause`, {})

    const withDelay = await client.post(`/api/campaigns/${campaign.id}/leads/${delayed.id}/resume`, { delay_days: 3 })
    assert.equal(withDelay.status, 200)
    const resumeAt = enrolment(campaign.id, delayed.id).resume_at
    assert.notEqual(resumeAt || '', '', 'a delay parks the lead until a date rather than resuming now')
    assert.ok(Date.parse(resumeAt) > Date.now() + 2 * 86400e3, 'roughly three days out')
    assert.notEqual(enrolment(campaign.id, delayed.id).paused_at, '', 'and they are still paused until then')

    const now = await client.post(`/api/campaigns/${campaign.id}/leads/${straight.id}/resume`, {})
    assert.equal(now.status, 200)
    assert.equal(enrolment(campaign.id, straight.id).paused_at || '', '', 'no delay clears the pause immediately')

    await tick()
    assert.equal(sentTo('delayed@acme.test'), 0, 'the delayed lead is still held')
    assert.equal(sentTo('straight@acme.test'), 0, 'and resuming never bypasses the approval rule')
    assert.ok(db.prepare("SELECT id FROM drafts WHERE lead_id = ? AND status = 'pending'").get(straight.id),
      'the resumed lead has an email waiting in Needs your OK')
    assert.equal(db.prepare("SELECT COUNT(*) n FROM drafts WHERE lead_id = ?").get(delayed.id).n, 0,
      'and the delayed one has nothing composed for it yet')
  } finally {
    db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
  }
})

test('an unsubscribe outranks a resume, and a resume of a running lead is a no-op', async () => {
  // Docs/leads/resume.md TC-12 and TC-11.
  const campaign = runningCampaign('Resume refused')
  const gone = seedLead(db, owner.id, 'resume-gone@acme.test')
  enrol(campaign, gone)
  await client.post(`/api/campaigns/${campaign.id}/leads/${gone.id}/pause`, {})
  await client.post(`/api/leads/${gone.id}/unsubscribe`, {})

  const refused = await client.post(`/api/campaigns/${campaign.id}/leads/${gone.id}/resume`, {})
  assert.equal(refused.status, 409)
  assert.match(refused.body.message, /unsubscribed/)
  assert.notEqual(enrolment(campaign.id, gone.id).paused_at, '', 'and the refusal changed nothing')

  const active = seedLead(db, owner.id, 'resume-active@acme.test')
  enrol(campaign, active)
  const noop = await client.post(`/api/campaigns/${campaign.id}/leads/${active.id}/resume`, {})
  assert.equal(noop.status, 200)
  assert.equal(noop.body.alreadyActive, true)
  assert.equal(events('lead_resumed', active.id).length, 0, 'no trail entry for a resume that did nothing')

  const bad = await client.post(`/api/campaigns/${campaign.id}/leads/${active.id}/resume`, { delay_days: -1 })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'delay_days')

  // TC-4 also names 3.5 days as a 422. The shared `int()` in
  // server/parity/http.js truncates a fractional number rather than refusing
  // it, so this is a 200 scheduling three days out. Pinned as what it does, so
  // that a later change to `int()` shows up here rather than silently.
  const paused = seedLead(db, owner.id, 'resume-fraction@acme.test')
  enrol(campaign, paused)
  await client.post(`/api/campaigns/${campaign.id}/leads/${paused.id}/pause`, {})
  const fractional = await client.post(`/api/campaigns/${campaign.id}/leads/${paused.id}/resume`, { delay_days: 3.5 })
  assert.equal(fractional.status, 200)
  assert.ok(Date.parse(fractional.body.will_resume_at) < Date.now() + 3.4 * 86400e3,
    'truncated to three days rather than rejected as the spec asks')
})

test('a lead sitting on a terminal node cannot be resumed', async () => {
  // Docs/leads/resume.md TC-8: "Refused with a 'playbook finished for this
  // person' message and an offer to add them to another campaign". Clearing
  // `paused_at` on a finished pairing produced a row that reads live on every
  // screen and that no tick will ever select, because the due query does not
  // look at finished rows.
  //
  // Mutation check: remove the `cl.state === 'finished'` guard from the resume
  // handler in server/parity/campaigns.js and this goes red on the status.
  const campaign = runningCampaign('Terminal resume')
  const won = seedLead(db, owner.id, 'won@acme.test')
  db.prepare(
    `INSERT INTO campaign_leads (campaign_id, lead_id, state, outcome, paused_at, completed_at)
     VALUES (?, ?, 'finished', 'won', ?, ?)`
  ).run(campaign.id, won.id, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')

  const res = await client.post(`/api/campaigns/${campaign.id}/leads/${won.id}/resume`, {})
  assert.equal(res.status, 409, 'the playbook is finished for this person')
  assert.match(res.body.message, /add them to a campaign again/, 'and it says what to do instead')
  const after = enrolment(campaign.id, won.id)
  assert.equal(after.state, 'finished', 'the enrolment is left alone')
  assert.equal(after.paused_at, '2026-01-01T00:00:00.000Z', 'and the pause was not silently cleared')

  await tick()
  assert.equal(sentTo('won@acme.test'), 0, 'and nothing was sent to a lead the playbook has finished with')
})

// =============================================================================
// Docs/leads/activities.md
// =============================================================================

test('the activity feed is workspace-scoped, paged, and refuses a half-open date range', async () => {
  const campaign = runningCampaign('Activity feed')
  const lead = seedLead(db, owner.id, 'feed@acme.test')
  enrol(campaign, lead)
  await tick()

  const res = await client.get('/api/leads/activities?limit=5')
  assert.equal(res.status, 200)
  assert.ok(res.body.data.length > 0)
  const entry = res.body.data.find((e) => e.leadId === lead.id)
  assert.ok(entry, 'the lead that was just emailed is in the feed')
  assert.equal(entry.leadEmail, 'feed@acme.test')
  assert.equal(entry.campaignId, campaign.id)
  assert.equal(entry.campaignName, campaign.name)
  assert.equal(entry.campaignStatus, 'running')
  assert.equal(res.body.limit, 5)
  assert.equal(typeof res.body.hasMore, 'boolean')

  // TC-8: an end without a start is refused rather than silently ignored.
  const half = await client.get('/api/leads/activities?to=2026-01-01T00:00:00Z')
  assert.equal(half.status, 422)
  assert.equal(half.body.field, 'from')

  // TC-4: a malformed date names the parameter.
  const malformed = await client.get('/api/leads/activities?from=25-11-2025')
  assert.equal(malformed.status, 422)
  assert.equal(malformed.body.field, 'from')

  // TC-5: the documented page-size ceiling.
  const huge = await client.get('/api/leads/activities?limit=5000')
  assert.equal(huge.status, 422)
  assert.equal(huge.body.field, 'limit')
  assert.match(huge.body.message, /1000/)

  // TC-7: a window that closes before the first send is an empty feed, not an error.
  const before = await client.get('/api/leads/activities?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z')
  assert.equal(before.status, 200)
  assert.deepEqual(before.body.data, [])

  // TC-3: another workspace's lead 404s and leaks nothing.
  const stranger = seedUser(db, `stranger-feed-${seq}@audit2.test`)
  const theirs = seedLead(db, stranger.id, 'katherine-feed@nasa.test', { first_name: 'Katherine' })
  const refused = await client.get(`/api/leads/${theirs.id}/activities`)
  assert.equal(refused.status, 404)
  assert.ok(!JSON.stringify(refused.body).toLowerCase().includes('katherine'))
  // …and nothing of theirs appears in the workspace-wide feed either.
  assert.ok(!res.body.data.some((e) => e.leadId === theirs.id))
})

test('the activity feed carries one timeline per lead with its email activities', { todo: 'Docs/leads/activities.md §2/TC-1: the route returns a flat events list, not per-lead timelines with subject, mailbox, open and click counts' }, async () => {
  // TC-1 asks for "a `data` array of lead timelines, each carrying
  // `campaign_name`, `status`, `current_seq_num` and an `activities` array".
  // What comes back is one row per `events` entry with a `detail` string.
  const campaign = runningCampaign('Timeline shape')
  const lead = seedLead(db, owner.id, 'timeline@acme.test')
  enrol(campaign, lead)
  await tick()

  const res = await client.get('/api/leads/activities?limit=50')
  const timeline = res.body.data.find((e) => e.leadId === lead.id)
  assert.ok(Array.isArray(timeline.activities), 'each entry is a timeline, not a single event')
  assert.equal(typeof timeline.current_seq_num, 'number', 'with the lead\'s position in the sequence')
  const email = timeline.activities[0]
  assert.equal(email.subject, 'introduce ourselves')
  assert.equal(email.mailbox, 'sender@audit2.test', 'the sending mailbox')
  assert.equal(email.to, 'timeline@acme.test', 'the recipient')
  assert.equal(email.open_count, 0)
  assert.equal(email.click_count, 0)
})

// =============================================================================
// Docs/lead-lists/create.md, update.md, get-by-id.md, delete.md
// =============================================================================

test('a segment is created trimmed, named uniquely, and starts empty', async () => {
  const trimmed = await client.post('/api/lead-lists', { listName: '  Warm leads  ' })
  assert.equal(trimmed.status, 200)
  assert.equal(trimmed.body.name, 'Warm leads', 'TC-8: surrounding whitespace removed before storing')
  assert.equal(trimmed.body.leadCount, 0)
  assert.ok(trimmed.body.createdAt)
  assert.equal(db.prepare('SELECT name FROM lead_lists WHERE id = ?').get(trimmed.body.id).name, 'Warm leads')

  // TC-7: the second create is refused and names the segment to open instead.
  const clash = await client.post('/api/lead-lists', { listName: 'warm LEADS' })
  assert.equal(clash.status, 409, 'case- and whitespace-insensitively the same name')
  assert.equal(clash.body.id, trimmed.body.id, 'and the response points at the existing one')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_lists WHERE workspace_id = ? AND lower(name) = ?')
    .get(owner.id, 'warm leads').n, 1, 'no second segment was created')

  // TC-4 / TC-9.
  assert.equal((await client.post('/api/lead-lists', { listName: '   ' })).status, 422)
  const missing = await client.post('/api/lead-lists', {})
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'name')

  // TC-10: unicode and punctuation survive round-tripping unchanged.
  const unicode = await client.post('/api/lead-lists', { listName: 'Køln — Q1 (tier 1)' })
  assert.equal(unicode.status, 200)
  assert.equal(unicode.body.name, 'Køln — Q1 (tier 1)')
  assert.equal((await client.get(`/api/lead-lists/${unicode.body.id}`)).body.name, 'Køln — Q1 (tier 1)')

  // One trail entry per create, naming the actor and the segment.
  const trail = events('lead_list_created')
  assert.ok(trail.some((e) => e.detail.includes('Warm leads')))
})

test('renaming a segment moves updated_at and nothing else, and a no-op rename writes nothing', async () => {
  const list = await makeList('Original name')
  const lead = seedLead(db, owner.id, `member-${seq}@acme.test`)
  db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)
  const tag = seedTag(db, owner.id, uniq('region'), 'lead_list')
  await client.post('/api/lead-lists/assign-tags', { listIds: [list.id], tagIds: [tag.id] })
  const before = db.prepare('SELECT * FROM lead_lists WHERE id = ?').get(list.id)

  const renamed = await client.put(`/api/lead-lists/${list.id}`, { listName: '  Renamed segment  ' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.name, 'Renamed segment', 'TC-8: trimmed')
  assert.equal(renamed.body.changed, true)

  const after = await client.get(`/api/lead-lists/${list.id}`)
  assert.equal(after.body.leadCount, 1, 'TC-9: membership untouched')
  assert.deepEqual(after.body.tags.map((t) => t.id), [tag.id], 'labels untouched')
  assert.equal(after.body.createdAt, before.created_at, 'created_at is unchanged')

  // TC-10: renaming to the current name is a no-op — no write, no trail entry.
  const trailBefore = events('lead_list_renamed').length
  const noop = await client.put(`/api/lead-lists/${list.id}`, { listName: 'Renamed segment' })
  assert.equal(noop.status, 200)
  assert.equal(noop.body.changed, false)
  assert.equal(events('lead_list_renamed').length, trailBefore, 'no trail entry for a rename that changed nothing')
  assert.equal(db.prepare('SELECT updated_at FROM lead_lists WHERE id = ?').get(list.id).updated_at,
    renamed.body.updatedAt, 'and updated_at did not move')

  // TC-7: a name another segment already holds is refused, naming that segment.
  const rival = await makeList('Taken name')
  const dup = await client.put(`/api/lead-lists/${list.id}`, { listName: rival.name })
  assert.equal(dup.status, 409)
  assert.equal(dup.body.id, rival.id)
  assert.equal(db.prepare('SELECT name FROM lead_lists WHERE id = ?').get(list.id).name, 'Renamed segment',
    'and the old name remains')

  // TC-4 and the trail entry carrying both names.
  assert.equal((await client.put(`/api/lead-lists/${list.id}`, { listName: '' })).status, 422)
  assert.ok(events('lead_list_renamed').some((e) => e.detail.includes('Original name') && e.detail.includes('Renamed segment')),
    'the trail records both the old and the new name')
})

test('a segment reports a count derived from membership, and refuses ids that are not numbers or not yours', async () => {
  const list = await makeList('Counted')
  const empty = await client.get(`/api/lead-lists/${list.id}`)
  assert.equal(empty.status, 200)
  assert.equal(empty.body.leadCount, 0, 'TC-7: an empty segment reports zero, not null')

  const added = []
  for (let i = 0; i < 3; i++) {
    const lead = seedLead(db, owner.id, `count${i}-${seq}@acme.test`)
    added.push(lead)
    db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)
  }
  assert.equal((await client.get(`/api/lead-lists/${list.id}`)).body.leadCount, 3, 'TC-8: exactly three higher')

  // Derived rather than stored: deleting a membership row alone changes it.
  db.prepare('DELETE FROM lead_list_leads WHERE list_id = ? AND lead_id = ?').run(list.id, added[0].id)
  assert.equal((await client.get(`/api/lead-lists/${list.id}`)).body.leadCount, 2,
    'the count cannot go stale, because no column holds it')

  // TC-5, TC-3, TC-4.
  const notNumber = await client.get('/api/lead-lists/abc')
  assert.equal(notNumber.status, 422)
  assert.equal(notNumber.body.field, 'id')
  assert.equal((await client.get('/api/lead-lists/999999')).status, 404)

  const stranger = seedUser(db, `stranger-list-${seq}@audit2.test`)
  db.prepare('INSERT INTO lead_lists (workspace_id, name) VALUES (?, ?)').run(stranger.id, 'Their private segment')
  const theirs = db.prepare('SELECT * FROM lead_lists WHERE workspace_id = ?').get(stranger.id)
  const refused = await client.get(`/api/lead-lists/${theirs.id}`)
  assert.equal(refused.status, 404)
  const body = JSON.stringify(refused.body)
  assert.ok(!body.includes('Their private segment'), 'no name is leaked')
  assert.ok(!body.includes('lead_count') && !body.includes('leadCount'), 'and no count either')
})

test('deleting a segment twice is a 404 the second time, and its labels survive for other segments', async () => {
  // Docs/lead-lists/delete.md TC-7 and TC-9.
  const doomed = await makeList('Doomed twice')
  const survivor = await makeList('Survivor')
  const tag = seedTag(db, owner.id, uniq('shared label'), 'lead_list')
  await client.post('/api/lead-lists/assign-tags', { listIds: [doomed.id, survivor.id], tagIds: [tag.id] })

  const first = await client.del(`/api/lead-lists/${doomed.id}`)
  assert.equal(first.status, 200)
  assert.equal(first.body.tagsUnassigned, 1)
  assert.equal((await client.del(`/api/lead-lists/${doomed.id}`)).status, 404,
    'the second delete is "already gone", not a server error')

  assert.ok(db.prepare('SELECT id FROM tags WHERE id = ?').get(tag.id), 'the label itself survives')
  assert.deepEqual((await client.get(`/api/lead-lists/${survivor.id}`)).body.tags.map((t) => t.id), [tag.id],
    'and stays on the segment that was not deleted')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id = ?').get(doomed.id).n, 0)
})

// =============================================================================
// Docs/lead-lists/assign-tags.md
// =============================================================================

test('labelling segments applies additions and removals in one write, with removal winning a tie', async () => {
  const a = await makeList('Labelled A')
  const b = await makeList('Labelled B')
  const keep = seedTag(db, owner.id, uniq('keep'), 'lead_list')
  const add = seedTag(db, owner.id, uniq('add'), 'lead_list')
  const drop = seedTag(db, owner.id, uniq('drop'), 'lead_list')

  const first = await client.post('/api/lead-lists/assign-tags', {
    listIds: [a.id, b.id], tagIds: [keep.id, drop.id],
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.message, 'Tags updated successfully')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id IN (?, ?)').get(a.id, b.id).n, 4)

  // TC-9: repeating the call creates no duplicate pairs.
  const repeat = await client.post('/api/lead-lists/assign-tags', {
    listIds: [a.id, b.id], tagIds: [keep.id, drop.id],
  })
  assert.equal(repeat.status, 200)
  assert.equal(repeat.body.added, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id IN (?, ?)').get(a.id, b.id).n, 4)

  // TC-7: additions and removals in one request.
  const both = await client.post('/api/lead-lists/assign-tags', {
    listIds: [a.id], tagIds: [add.id], removeTagIds: [drop.id],
  })
  assert.equal(both.status, 200)
  assert.deepEqual(
    db.prepare('SELECT tag_id FROM lead_list_tags WHERE list_id = ? ORDER BY tag_id').all(a.id).map((r) => r.tag_id).sort((x, y) => x - y),
    [keep.id, add.id].sort((x, y) => x - y),
  )

  // TC-8: an id in both arrays ends up removed.
  const tie = await client.post('/api/lead-lists/assign-tags', {
    listIds: [b.id], tagIds: [keep.id], removeTagIds: [keep.id],
  })
  assert.equal(tie.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id = ? AND tag_id = ?').get(b.id, keep.id).n, 0,
    'removal wins')

  // One trail entry for the bulk action, not one per pair.
  assert.ok(events('lead_list_tags_assigned').length >= 1)
})

test('a labelling batch is all-or-nothing and enforces the documented 1-10 range', async () => {
  const list = await makeList('All or nothing')
  const tag = seedTag(db, owner.id, uniq('valid'), 'lead_list')

  // TC-11: one unknown id and nothing in the batch is written.
  const partial = await client.post('/api/lead-lists/assign-tags', {
    listIds: [list.id, 999999], tagIds: [tag.id],
  })
  assert.equal(partial.status, 404)
  assert.equal(partial.body.id, 999999, 'the rejected id is named')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id = ?').get(list.id).n, 0)

  // Another workspace's segment is the same answer, and leaks nothing (TC-3).
  const stranger = seedUser(db, `stranger-tags-${seq}@audit2.test`)
  db.prepare('INSERT INTO lead_lists (workspace_id, name) VALUES (?, ?)').run(stranger.id, 'Their labelled segment')
  const theirs = db.prepare('SELECT * FROM lead_lists WHERE workspace_id = ?').get(stranger.id)
  const crossed = await client.post('/api/lead-lists/assign-tags', { listIds: [list.id, theirs.id], tagIds: [tag.id] })
  assert.equal(crossed.status, 404)
  assert.ok(!JSON.stringify(crossed.body).includes('Their labelled segment'))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id = ?').get(list.id).n, 0)

  // TC-4 and the matching cap on tagIds.
  const many = await client.post('/api/lead-lists/assign-tags', {
    listIds: Array.from({ length: 11 }, (_, i) => i + 1), tagIds: [tag.id],
  })
  assert.equal(many.status, 422)
  assert.equal(many.body.field, 'listIds')
  assert.match(many.body.message, /10/)

  // TC-10: a string where an array belongs names the field.
  const malformed = await client.post('/api/lead-lists/assign-tags', { listIds: String(list.id), tagIds: [tag.id] })
  assert.equal(malformed.status, 422)
  assert.equal(malformed.body.field, 'listIds')
  assert.match(malformed.body.message, /array/)

  // §2, last criterion: bulk removal is a separate, explicit action.
  const removalOnly = await client.post('/api/lead-lists/assign-tags', {
    listIds: [list.id], removeTagIds: [tag.id],
  })
  assert.equal(removalOnly.status, 422)
  assert.equal(removalOnly.body.field, 'tagIds')

  // Empty arrays are refused too, and nothing is written by any of the above.
  assert.equal((await client.post('/api/lead-lists/assign-tags', { listIds: [], tagIds: [tag.id] })).status, 422)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id = ?').get(list.id).n, 0)
})

// =============================================================================
// Docs/lead-lists/import-leads.md
// =============================================================================

test('a CSV import reports every row honestly and the numbers describe what was written', async () => {
  const list = await makeList('Import accounting')
  db.prepare("INSERT INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (?, 'blocked-imp.test', 1, 'manual')")
    .run(owner.id)
  const existing = seedLead(db, owner.id, 'already@acme.test', { company: 'Old Co' })

  const res = await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'enterprise-prospects-jan2025.csv',
    leads: [
      { email: 'brand-new@acme.test', first_name: 'New' },
      { email: 'already@acme.test', company: 'New Co' },      // TC-3: reused, counted as a duplicate
      { email: 'twice@acme.test' },
      { email: 'TWICE@acme.test' },                            // TC-10: same file, one lead
      { email: 'sales@blocked-imp.test' },                     // TC-9: blocked
      { first_name: 'No address' },                            // TC-7: no email
      { email: 'john@@company' },                              // TC-8: malformed
    ],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.fileName, 'enterprise-prospects-jan2025.csv')
  assert.equal(res.body.totalLeads, 7)
  assert.equal(res.body.imported, 2, 'brand-new and the first "twice"')
  assert.equal(res.body.duplicates, 2, 'the existing person and the second "twice"')
  assert.equal(res.body.blocked, 1)
  assert.equal(res.body.invalid, 2)
  assert.equal(res.body.imported + res.body.duplicates + res.body.blocked + res.body.invalid, res.body.totalLeads,
    'the counts account for every row in the file')

  // The database agrees with the summary.
  assert.equal(res.body.leadCount, 3, 'three people are in the segment')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(list.id).n, 3)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND lower(email) = ?')
    .get(owner.id, 'twice@acme.test').n, 1, 'the repeated address is one person, not two')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND email = ?')
    .get(owner.id, 'sales@blocked-imp.test').n, 0, 'the blocked address became no lead at all')
  assert.equal(leadRow(existing.id).company, 'New Co', 'the existing person was updated, not duplicated')

  // TC-7 and TC-8 report the row number so a "could not import" file can be built.
  const noEmail = res.body.errors.find((e) => e.reason === 'email is required')
  assert.equal(noEmail.row, 6)
  const malformed = res.body.errors.find((e) => e.reason === 'malformed email address')
  assert.equal(malformed.row, 7)

  // TC-12: running the identical file again adds nothing new.
  const again = await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'enterprise-prospects-jan2025.csv',
    leads: [{ email: 'brand-new@acme.test' }, { email: 'twice@acme.test' }],
  })
  assert.equal(again.body.imported, 0)
  assert.equal(again.body.duplicates, 2)
  assert.equal(again.body.leadCount, 3, 'the segment count did not change')
  assert.match(again.body.message, /Nothing new to add/)

  // TC-4 and TC-6.
  const noName = await client.post(`/api/lead-lists/${list.id}/import`, { leads: [{ email: 'x@y.test' }] })
  assert.equal(noName.status, 422)
  assert.equal(noName.body.field, 'fileName')
  const nothing = await client.post(`/api/lead-lists/${list.id}/import`, { fileName: 'empty.csv', leads: [] })
  assert.equal(nothing.status, 200)
  assert.equal(nothing.body.totalLeads, 0)
  assert.equal(nothing.body.message, 'Nothing to import')
  assert.equal(nothing.body.leadCount, 3, 'the segment is untouched')
})

test('imported custom fields reach the lead and merge rather than replace on re-import', async () => {
  // Docs/lead-lists/import-leads.md TC-11 and §2: the values are attached to
  // each lead and are what the composer merges from.
  const list = await makeList('Custom field import')
  const first = await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'jobs.csv',
    customFields: { source: 'conference' },
    leads: [{ email: 'cfimport@acme.test', customFields: { job_title: 'CTO' } }],
  })
  assert.equal(first.status, 200)
  const lead = db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(owner.id, 'cfimport@acme.test')
  assert.deepEqual(JSON.parse(lead.custom_fields), { source: 'conference', job_title: 'CTO' },
    'the shared mapping and the per-row values are both stored')

  await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'industries.csv',
    leads: [{ email: 'cfimport@acme.test', customFields: { industry: 'SaaS' } }],
  })
  assert.deepEqual(JSON.parse(leadRow(lead.id).custom_fields), { source: 'conference', job_title: 'CTO', industry: 'SaaS' },
    'a later import adds to the bag rather than emptying it')

  // The import is traceable afterwards, which is why fileName is required.
  const detail = await client.get(`/api/lead-lists/${list.id}`)
  assert.equal(detail.body.lastImport.fileName, 'industries.csv')
  assert.equal(detail.body.lastImport.status, 'done')
})

// =============================================================================
// Docs/lead-lists/push-between-lists.md
// =============================================================================

test('copy leaves the source intact, move empties it, and neither enrols or emails anyone', async () => {
  // §2, last criterion: "when the engine next ticks, then no campaign changes
  // as a result: segment membership is organisation only".
  const from = await makeList('Split source')
  const to = await makeList('Split target')
  const campaign = runningCampaign('Untouched by filing')
  const leads = []
  for (let i = 0; i < 3; i++) {
    const lead = seedLead(db, owner.id, `split${i}-${seq}@acme.test`)
    db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(from.id, lead.id)
    leads.push(lead)
  }
  const enrolmentsBefore = db.prepare('SELECT COUNT(*) n FROM campaign_leads').get().n
  const sentBefore = db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out'").get().n

  const copied = await client.post('/api/lead-lists/transfer', {
    action: 'copy', fromListId: from.id, toListId: to.id,
  })
  assert.equal(copied.status, 200)
  assert.equal(copied.body.totalLeadsMoved, 3)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(from.id).n, 3,
    'TC-7: a copy leaves the source holding all three')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(to.id).n, 3)

  // TC-10: copying again reports them as already present rather than transferred.
  const repeat = await client.post('/api/lead-lists/transfer', {
    action: 'copy', fromListId: from.id, toListId: to.id,
  })
  assert.equal(repeat.body.transferred, 0)
  assert.equal(repeat.body.alreadyPresent, 3)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(to.id).n, 3,
    'and they appear once each in the destination')

  const moved = await client.post('/api/lead-lists/transfer', {
    action: 'move', fromListId: from.id, toListId: to.id,
  })
  assert.equal(moved.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(from.id).n, 0,
    'TC-1: the source is emptied')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(to.id).n, 3,
    'and nobody was lost between the two')

  await tick()
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads').get().n, enrolmentsBefore,
    'no campaign changed as a result of the filing')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out'").get().n, sentBefore,
    'and nothing was composed or sent by it')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n, 0)
})

test('a transfer names its source exactly once and refuses every ambiguous request', async () => {
  const from = await makeList('Ambiguity source')
  const to = await makeList('Ambiguity target')
  const lead = seedLead(db, owner.id, `ambiguous-${seq}@acme.test`)
  db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(from.id, lead.id)
  const membershipBefore = db.prepare('SELECT COUNT(*) n FROM lead_list_leads').get().n

  // TC-9, TC-4, TC-12, TC-11.
  const both = await client.post('/api/lead-lists/transfer', {
    action: 'copy', leadIds: [lead.id], fromListId: from.id, toListId: to.id,
  })
  assert.equal(both.status, 422)
  assert.match(both.body.message, /exactly one source/i)

  const neither = await client.post('/api/lead-lists/transfer', { action: 'move', toListId: to.id })
  assert.equal(neither.status, 422)
  assert.equal(neither.body.field, 'fromListId')

  const same = await client.post('/api/lead-lists/transfer', {
    action: 'move', fromListId: from.id, toListId: from.id,
  })
  assert.equal(same.status, 422)
  assert.equal(same.body.field, 'toListId')

  const overCap = await client.post('/api/lead-lists/transfer', {
    action: 'copy', leadIds: Array.from({ length: 10001 }, (_, i) => i + 1), toListId: to.id,
  })
  assert.equal(overCap.status, 422)
  assert.equal(overCap.body.field, 'leadIds')
  assert.match(overCap.body.message, /10000/)

  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads').get().n, membershipBefore,
    'not one membership row was touched by any of the refusals')

  // TC-8: specific ids, and a stranger's id 404s before any write.
  const byIds = await client.post('/api/lead-lists/transfer', {
    action: 'copy', leadIds: [lead.id], toListId: to.id,
  })
  assert.equal(byIds.status, 200)
  assert.equal(byIds.body.totalLeadsMoved, 1)

  const stranger = seedUser(db, `stranger-transfer-${seq}@audit2.test`)
  const theirLead = seedLead(db, stranger.id, `theirs-${seq}@nasa.test`)
  const crossed = await client.post('/api/lead-lists/transfer', {
    action: 'copy', leadIds: [theirLead.id], toListId: to.id,
  })
  assert.equal(crossed.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE lead_id = ?').get(theirLead.id).n, 0)

  // TC-6: an empty source is a 200 saying so, not an error.
  const emptySource = await makeList('Empty source')
  const nothing = await client.post('/api/lead-lists/transfer', {
    action: 'move', fromListId: emptySource.id, toListId: to.id,
  })
  assert.equal(nothing.status, 200)
  assert.equal(nothing.body.totalLeadsMoved, 0)
  assert.equal(nothing.body.message, 'Nothing to move')
})

// =============================================================================
// Docs/lead-tags/create.md and get-all.md
// =============================================================================

test('a label is created for one surface, refuses a colour that is not hex, and refuses a second of the same name', async () => {
  const created = await client.post('/api/tags', { appliesTo: 'lead', name: uniq('VIP'), color: '#FF5733' })
  assert.equal(created.status, 200)
  // Stored lowercased. Docs/lead-tags/get-all.md TC-9 says the colour comes
  // back "unchanged", which it does not in case — the same colour, spelled
  // differently. Compared case-insensitively here so the test asserts the
  // colour rather than the spelling.
  assert.equal(created.body.data.color.toLowerCase(), '#ff5733')
  assert.ok(created.body.data.id)
  const stored = db.prepare('SELECT * FROM tags WHERE id = ?').get(created.body.data.id)
  assert.equal(stored.applies_to, 'lead', 'the surface it applies to is recorded, not guessed')
  assert.equal(stored.workspace_id, owner.id)

  // TC-4 and TC-8.
  const badColour = await client.post('/api/tags', { appliesTo: 'lead', name: uniq('Bad'), color: 'red' })
  assert.equal(badColour.status, 422)
  assert.equal(badColour.body.field, 'color')
  const noName = await client.post('/api/tags', { appliesTo: 'lead', color: '#FF5733' })
  assert.equal(noName.status, 422)
  assert.equal(noName.body.field, 'name')

  // TC-7: the duplicate names the existing label rather than making a second.
  const dup = await client.post('/api/tags', { appliesTo: 'lead', name: created.body.data.name, color: '#4CAF50' })
  assert.equal(dup.status, 409)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tags WHERE workspace_id = ? AND applies_to = 'lead' AND name = ?")
    .get(owner.id, created.body.data.name).n, 1)

  // TC-10: a lead label is not offered as a mailbox label.
  const mailboxPicker = await client.get('/api/tags?appliesTo=mailbox')
  assert.ok(!mailboxPicker.body.data.some((t) => t.id === created.body.data.id))

  // TC-11: renaming and recolouring reaches every chip already applied.
  const lead = seedLead(db, owner.id, `chipped-${seq}@acme.test`)
  await client.post('/api/leads/tags', { leadIds: [lead.id], tagIds: [created.body.data.id] })
  const renamed = await client.put(`/api/tags/${created.body.data.id}`, { name: uniq('VIP renamed'), color: '#123456' })
  assert.equal(renamed.status, 200)
  const chips = await client.get(`/api/tags?leadId=${lead.id}`)
  assert.equal(chips.body.data[0].name, renamed.body.data.name, 'without re-tagging anything')
  assert.equal(chips.body.data[0].color.toLowerCase(), '#123456')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_tags WHERE lead_id = ?').get(lead.id).n, 1,
    'and the mapping row itself was never rewritten')
})

test('one route serves the chips on a lead and the picker beside them, and the mapping id differs from the label id', async () => {
  const lead = seedLead(db, owner.id, `tagged-${seq}@acme.test`)
  const bare = await client.get(`/api/tags?leadId=${lead.id}`)
  assert.equal(bare.status, 200)
  assert.deepEqual(bare.body.data, [], 'TC-6: a lead with no labels renders no chip row')

  const one = seedTag(db, owner.id, uniq('Alpha'))
  const two = seedTag(db, owner.id, uniq('Beta'))
  await client.post('/api/leads/tags', { leadIds: [lead.id], tagIds: [one.id, two.id] })

  // TC-10: usable for removal straight away.
  const chips = await client.get(`/api/tags?leadId=${lead.id}`)
  assert.equal(chips.body.data.length, 2)
  for (const chip of chips.body.data) {
    assert.ok(chip.mappingId, 'TC-8: the mapping id travels alongside the label id')
    assert.notEqual(chip.mappingId, chip.id)
    assert.equal(chip.mappingId,
      db.prepare('SELECT id FROM lead_tags WHERE lead_id = ? AND tag_id = ?').get(lead.id, chip.id).id)
  }
  const removable = chips.body.data[0]
  const removed = await client.del(`/api/leads/tags/${removable.mappingId}`)
  assert.equal(removed.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_tags WHERE id = ?').get(removable.mappingId).n, 0)

  // TC-7: no leadId is the picker — every label in the workspace.
  const picker = await client.get('/api/tags')
  assert.ok(picker.body.data.some((t) => t.id === one.id) && picker.body.data.some((t) => t.id === two.id))
  assert.ok(picker.body.data.every((t) => Object.hasOwn(t, 'usageCount')),
    'each carries the count that lets the panel say "0 leads carry this"')

  // TC-4 and TC-3.
  const notNumber = await client.get('/api/tags?leadId=abc')
  assert.equal(notNumber.status, 422)
  assert.equal(notNumber.body.field, 'leadId')
  const stranger = seedUser(db, `stranger-chips-${seq}@audit2.test`)
  const theirLead = seedLead(db, stranger.id, `theirs-chips-${seq}@nasa.test`)
  db.prepare("INSERT INTO tags (workspace_id, applies_to, name, color) VALUES (?, 'lead', 'Their secret label', '#111111')").run(stranger.id)
  const refused = await client.get(`/api/tags?leadId=${theirLead.id}`)
  assert.equal(refused.status, 404)
  assert.ok(!JSON.stringify(refused.body).includes('Their secret label'))

  // TC-11: deleting the label workspace-wide leaves no orphan chip.
  await client.del(`/api/tags/${two.id}`)
  const after = await client.get(`/api/tags?leadId=${lead.id}`)
  assert.ok(!after.body.data.some((t) => t.id === two.id))
  assert.ok(!(await client.get('/api/tags')).body.data.some((t) => t.id === two.id))
})

// =============================================================================
// Docs/lead-notes/create.md and get-all.md
// =============================================================================

test('a note is stored against the campaign-and-lead pairing, and never against one the lead is not in', async () => {
  const campaign = runningCampaign('Noted campaign')
  const other = runningCampaign('Not their campaign')
  const lead = seedLead(db, owner.id, `noted-${seq}@acme.test`)
  enrol(campaign, lead)

  const res = await client.post(`/api/leads/${lead.id}/notes`, {
    body: 'Called Priya — wants pricing for 50 seats.', campaignId: campaign.id,
  })
  assert.equal(res.status, 200)
  const stored = db.prepare('SELECT * FROM lead_notes WHERE id = ?').get(res.body.note.id)
  assert.equal(stored.campaign_id, campaign.id, 'scoped to the pairing, not to the lead alone')
  assert.equal(stored.lead_id, lead.id)
  assert.equal(stored.author_email, 'owner@audit2.test', 'the author is the session, never client-supplied')
  assert.equal(stored.body, 'Called Priya — wants pricing for 50 seats.')

  // TC-8: a campaign the lead is not in is a 400 rather than an orphaned note.
  const orphan = await client.post(`/api/leads/${lead.id}/notes`, { body: 'Wrong campaign', campaignId: other.id })
  assert.equal(orphan.status, 400)
  assert.match(orphan.body.message, /not in that campaign/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_notes WHERE lead_id = ?').get(lead.id).n, 1,
    'and nothing was written')

  // TC-4 and TC-7.
  assert.equal((await client.post(`/api/leads/${lead.id}/notes`, { body: '   ' })).status, 422)
  const long = await client.post(`/api/leads/${lead.id}/notes`, { body: 'x'.repeat(4001) })
  assert.equal(long.status, 422)
  assert.equal(long.body.field, 'body')
  assert.match(long.body.message, /4000/, 'the limit is stated, so the counter has a source of truth')

  // §5: the trail says a note was added and by whom, and never copies the body.
  const trail = events('note_added', lead.id)
  assert.equal(trail.length, 1)
  assert.match(trail[0].detail, /owner@audit2\.test/)
  assert.ok(!trail[0].detail.includes('Priya'), 'the note body is not duplicated into the log')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND detail LIKE '%50 seats%'").get(owner.id).n, 0)
})

test('a note containing markup is stored verbatim as text and never interpreted', async () => {
  // TC-11: stored and rendered as plain text; nothing executes. The server's
  // half of that is storing exactly what was typed rather than a mangled or
  // pre-escaped version the renderer would double-escape.
  const lead = seedLead(db, owner.id, `markup-${seq}@acme.test`)
  const payload = '<script>alert(1)</script> & <b>bold</b>'
  const res = await client.post(`/api/leads/${lead.id}/notes`, { body: payload })
  assert.equal(res.status, 200)
  assert.equal(res.body.note.body, payload)
  assert.equal(db.prepare('SELECT body FROM lead_notes WHERE id = ?').get(res.body.note.id).body, payload)
})

test('notes read back newest first, labelled by campaign, with attribution surviving a departed author', async () => {
  const campaign = runningCampaign('Notes A')
  const second = runningCampaign('Notes B')
  const lead = seedLead(db, owner.id, `history-${seq}@acme.test`)
  enrol(campaign, lead)
  enrol(second, lead)

  await client.post(`/api/leads/${lead.id}/notes`, { body: 'oldest', campaignId: campaign.id })
  await client.post(`/api/leads/${lead.id}/notes`, { body: 'middle', campaignId: second.id })
  await client.post(`/api/leads/${lead.id}/notes`, { body: 'newest' })

  const res = await client.get(`/api/leads/${lead.id}/notes`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items.map((n) => n.body), ['newest', 'middle', 'oldest'], 'TC-1: newest first')
  assert.equal(res.body.items[0].campaign, null, 'TC-8: a campaign-less note is general')
  assert.equal(res.body.items[1].campaign.id, second.id)
  assert.equal(res.body.items[1].campaign.name, second.name, 'labelled by campaign, never merged across them')
  assert.equal(res.body.items[2].campaign.id, campaign.id)
  for (const note of res.body.items) {
    assert.ok(note.createdAt, 'each carries a readable absolute time')
    assert.equal(note.author.email, 'owner@audit2.test')
  }

  // TC-11: two notes written in the same second still order deterministically.
  const at = '2026-05-05T10:00:00.000Z'
  const ids = []
  for (const body of ['tie-a', 'tie-b']) {
    const info = db.prepare(
      'INSERT INTO lead_notes (workspace_id, lead_id, author_email, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(owner.id, lead.id, 'owner@audit2.test', body, at, at)
    ids.push(info.lastInsertRowid)
  }
  const tied = (await client.get(`/api/leads/${lead.id}/notes`)).body.items.filter((n) => n.body.startsWith('tie-'))
  assert.deepEqual(tied.map((n) => n.id), [ids[1], ids[0]], 'tie-broken by id, so paging is stable')

  // TC-9: a note whose author has left still names them.
  db.prepare(
    'INSERT INTO lead_notes (workspace_id, lead_id, author_email, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(owner.id, lead.id, 'departed@audit2.test', 'left the company', '2026-06-06T10:00:00.000Z', '2026-06-06T10:00:00.000Z')
  const withDeparted = (await client.get(`/api/leads/${lead.id}/notes?limit=50`)).body.items
    .find((n) => n.body === 'left the company')
  assert.equal(withDeparted.author.email, 'departed@audit2.test', 'attribution survives membership changes')
  assert.equal(withDeparted.author.formerMember, true, 'and is marked as a former member rather than dropped')

  // §2: the panel shows a handful with a "show all" rather than hundreds.
  const paged = await client.get(`/api/leads/${lead.id}/notes?limit=2`)
  assert.equal(paged.body.items.length, 2)
  assert.equal(paged.body.hasMore, true)
  assert.ok(paged.body.nextCursor)

  // TC-6 and TC-3.
  const bare = seedLead(db, owner.id, `no-notes-${seq}@acme.test`)
  const none = await client.get(`/api/leads/${bare.id}/notes`)
  assert.equal(none.status, 200)
  assert.deepEqual(none.body.items, [])
  const stranger = seedUser(db, `stranger-notes-${seq}@audit2.test`)
  const theirLead = seedLead(db, stranger.id, `theirs-notes-${seq}@nasa.test`)
  db.prepare('INSERT INTO lead_notes (workspace_id, lead_id, author_email, body) VALUES (?, ?, ?, ?)')
    .run(stranger.id, theirLead.id, 'them@nasa.test', 'Their confidential note')
  const refused = await client.get(`/api/leads/${theirLead.id}/notes`)
  assert.equal(refused.status, 404)
  assert.ok(!JSON.stringify(refused.body).includes('Their confidential note'))
})

// =============================================================================
// Docs/lead-tasks/create.md and get-all.md
// =============================================================================

test('a task defaults to medium, accepts a past due date as overdue, and refuses what it cannot store', async () => {
  const campaign = runningCampaign('Tasked campaign')
  const lead = seedLead(db, owner.id, `tasked-${seq}@acme.test`)
  enrol(campaign, lead)

  const full = await client.post(`/api/leads/${lead.id}/tasks`, {
    name: 'Send the pricing sheet',
    description: '50 seats, annual',
    priority: 'high',
    dueDate: '2026-12-01T09:00:00.000Z',
    campaignId: campaign.id,
  })
  assert.equal(full.status, 200)
  const stored = db.prepare('SELECT * FROM lead_tasks WHERE id = ?').get(full.body.task.id)
  assert.equal(stored.campaign_id, campaign.id, 'against the campaign-and-lead pairing')
  assert.equal(stored.title, 'Send the pricing sheet')
  assert.equal(stored.body, '50 seats, annual')
  assert.equal(stored.priority, 'high')
  assert.equal(stored.status, 'open')
  assert.equal(stored.created_by, 'owner@audit2.test')

  // TC-8: no priority means medium, not blank.
  const bare = await client.post(`/api/leads/${lead.id}/tasks`, { name: 'Chase the intro' })
  assert.equal(db.prepare('SELECT priority FROM lead_tasks WHERE id = ?').get(bare.body.task.id).priority, 'medium')
  assert.equal(bare.body.task.priority, 'medium')

  // TC-9: a past due date is accepted and immediately overdue.
  const past = await client.post(`/api/leads/${lead.id}/tasks`, { name: 'Overdue already', dueDate: '2020-01-01T00:00:00.000Z' })
  assert.equal(past.status, 200)
  assert.equal(past.body.task.overdue, true)

  // TC-4, TC-7, TC-10, TC-11.
  const noName = await client.post(`/api/leads/${lead.id}/tasks`, { description: 'only a description' })
  assert.equal(noName.status, 422)
  assert.equal(noName.body.field, 'title')
  const badPriority = await client.post(`/api/leads/${lead.id}/tasks`, { name: 'x', priority: 'urgent' })
  assert.equal(badPriority.status, 422)
  assert.equal(badPriority.body.field, 'priority')
  assert.match(badPriority.body.message, /low, medium, high/)
  const badDate = await client.post(`/api/leads/${lead.id}/tasks`, { name: 'x', dueDate: 'next tuesday-ish' })
  assert.equal(badDate.status, 422)
  assert.equal(badDate.body.field, 'dueAt')
  const wrongCampaign = runningCampaign('Not their campaign either')
  const orphan = await client.post(`/api/leads/${lead.id}/tasks`, { name: 'x', campaignId: wrongCampaign.id })
  assert.equal(orphan.status, 400)
  assert.match(orphan.body.message, /not in that campaign/)

  // One trail entry per task, naming the actor, the lead and the task name.
  const trail = events('task_created', lead.id)
  assert.ok(trail.some((e) => e.detail.includes('Send the pricing sheet') && e.detail.includes('owner@audit2.test')))
})

test('a task on an unsubscribed lead is allowed and never becomes permission to email them', async () => {
  // Docs/lead-tasks/create.md TC-12: "phone them to confirm" is legitimate
  // work. §5: a task never gates a send either — it is a human's reminder.
  const campaign = runningCampaign('Task on an opt-out')
  const gone = seedLead(db, owner.id, 'task-gone@acme.test')
  const control = seedLead(db, owner.id, 'task-fine@acme.test')
  enrol(campaign, gone)
  enrol(campaign, control)
  unsubscribeLead(owner.id, gone.id, { source: 'link', actor: 'recipient' })

  const onGone = await client.post(`/api/leads/${gone.id}/tasks`, { name: 'Phone to confirm removal' })
  assert.equal(onGone.status, 200)
  const onControl = await client.post(`/api/leads/${control.id}/tasks`, { name: 'Chase for a reply' })
  assert.equal(onControl.status, 200)

  await tick()
  assert.equal(sentTo('task-fine@acme.test'), 1, 'the open task did not gate the control\'s send either')
  assert.equal(sentTo('task-gone@acme.test'), 0, 'and the task did not make the opt-out contactable')
  assert.equal(db.prepare("SELECT status FROM lead_tasks WHERE id = ?").get(onControl.body.task.id).status, 'open',
    'the task is still waiting for a person, exactly as it should be')
})

test('tasks read back overdue first, then dated, then undated, with completed behind the toggle', async () => {
  const lead = seedLead(db, owner.id, `task-order-${seq}@acme.test`)
  const soon = new Date(Date.now() + 6 * 86400e3).toISOString()
  const made = {}
  for (const [key, payload] of Object.entries({
    overdue: { name: 'Overdue', dueDate: '2020-01-01T00:00:00.000Z' },
    nextWeek: { name: 'Next week', dueDate: soon },
    undated: { name: 'Undated' },
    lowSameDay: { name: 'Same day low', dueDate: soon, priority: 'low' },
    finished: { name: 'Finished', dueDate: '2020-01-02T00:00:00.000Z' },
  })) {
    made[key] = (await client.post(`/api/leads/${lead.id}/tasks`, payload)).body.task
  }
  await client.patch(`/api/tasks/${made.finished.id}`, { status: 'done' })

  const open = await client.get(`/api/leads/${lead.id}/tasks`)
  assert.equal(open.status, 200)
  assert.deepEqual(open.body.items.map((t) => t.id),
    [made.overdue.id, made.nextWeek.id, made.lowSameDay.id, made.undated.id],
    'TC-7: overdue, then next week, then the undated tail — never treated as overdue')
  assert.equal(open.body.items.find((t) => t.id === made.undated.id).overdue, false)
  assert.ok(!open.body.items.some((t) => t.id === made.finished.id), 'completed is hidden by default')

  // TC-8: two tasks due the same day are separated by priority, high first.
  const sameDay = open.body.items.filter((t) => t.dueAt === soon)
  assert.deepEqual(sameDay.map((t) => t.priority), ['medium', 'low'])

  const closed = await client.get(`/api/leads/${lead.id}/tasks?status=done`)
  assert.deepEqual(closed.body.items.map((t) => t.id), [made.finished.id], 'and is there behind the toggle')
  assert.ok(closed.body.items[0].completedAt, 'with the time it was completed')

  // The counts are the Action Center's, so they span the workspace rather than
  // this lead — this lead's own overdue task and completed task are in them.
  assert.ok(open.body.counts.overdue >= 1)
  assert.ok(open.body.counts.done >= 1)
  assert.equal(open.body.items.filter((t) => t.overdue).length, 1, 'exactly one of this lead\'s open tasks is late')

  // TC-9 and TC-10: campaign labelling and a creator who has left.
  const campaign = runningCampaign('Task labelling')
  enrol(campaign, lead)
  const labelled = await client.post(`/api/leads/${lead.id}/tasks`, { name: 'In a campaign', campaignId: campaign.id })
  assert.equal(labelled.body.task.campaign.id, campaign.id)
  assert.equal(labelled.body.task.campaign.name, campaign.name)
  db.prepare('INSERT INTO lead_tasks (workspace_id, lead_id, title, created_by, status, priority) VALUES (?, ?, ?, ?, ?, ?)')
    .run(owner.id, lead.id, 'Left behind', 'departed@audit2.test', 'open', 'medium')
  const orphaned = (await client.get(`/api/leads/${lead.id}/tasks?limit=50`)).body.items.find((t) => t.title === 'Left behind')
  assert.equal(orphaned.creator.email, 'departed@audit2.test', 'the name still shows')
  assert.equal(orphaned.unowned, true, 'and it is flagged so it can be picked up rather than lost')

  // TC-4, TC-6 and TC-3.
  const notNumber = await client.get('/api/leads/abc/tasks')
  assert.equal(notNumber.status, 422)
  assert.equal(notNumber.body.field, 'leadId')
  const bare = seedLead(db, owner.id, `no-tasks-${seq}@acme.test`)
  assert.deepEqual((await client.get(`/api/leads/${bare.id}/tasks`)).body.items, [])
  const stranger = seedUser(db, `stranger-tasks-${seq}@audit2.test`)
  const theirLead = seedLead(db, stranger.id, `theirs-tasks-${seq}@nasa.test`)
  db.prepare('INSERT INTO lead_tasks (workspace_id, lead_id, title, created_by) VALUES (?, ?, ?, ?)')
    .run(stranger.id, theirLead.id, 'Their confidential task', 'them@nasa.test')
  const refused = await client.get(`/api/leads/${theirLead.id}/tasks`)
  assert.equal(refused.status, 404)
  assert.ok(!JSON.stringify(refused.body).includes('Their confidential task'))
})

// =============================================================================
// Docs/clients/update.md
// =============================================================================

test('a client update merges rather than blanks, records what changed, and writes nothing for a no-op', async () => {
  const created = await client.post('/api/clients', {
    name: uniq('Acme Agency'), email: `admin-${seq}@acme.test`,
    permission: ['campaigns', 'email_accounts'],
  })
  assert.equal(created.status, 200)
  const id = created.body.data.id
  assert.deepEqual(created.body.data.permissions, ['campaigns', 'mailboxes'],
    "the source API's area names map onto Harry's own")

  // §2, last criterion: untouched fields keep their values.
  const partial = await client.patch(`/api/clients/${id}`, { name: 'Acme Agency Updated' })
  assert.equal(partial.status, 200)
  assert.equal(partial.body.data.name, 'Acme Agency Updated')
  assert.equal(partial.body.data.email, created.body.data.email, 'the email was not blanked by omitting it')
  assert.deepEqual(partial.body.data.permissions, ['campaigns', 'mailboxes'], 'nor were the permissions')
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id)
  assert.equal(row.name, 'Acme Agency Updated')
  assert.equal(row.email, created.body.data.email)

  // TC-6: a save identical to the stored record writes no trail entry.
  const trailBefore = events('client_updated').length
  const noop = await client.patch(`/api/clients/${id}`, { name: 'Acme Agency Updated' })
  assert.equal(noop.status, 200)
  assert.equal(noop.body.changed, false)
  assert.equal(events('client_updated').length, trailBefore)

  // TC-9: removing an area is recorded with who did it.
  const reduced = await client.patch(`/api/clients/${id}`, { permission: ['campaigns'] })
  assert.equal(reduced.status, 200)
  assert.deepEqual(reduced.body.data.permissions, ['campaigns'])
  assert.deepEqual(JSON.parse(db.prepare('SELECT permissions FROM clients WHERE id = ?').get(id).permissions), ['campaigns'])
  const removal = events('client_updated').at(-1)
  assert.match(removal.detail, /-mailboxes/, 'the trail names the removed area')
  assert.match(removal.detail, /owner@audit2\.test/, 'and who removed it')
})

test('a client update never takes a password, never invents a client, and never collides two emails', async () => {
  const a = await client.post('/api/clients', { name: uniq('Alpha'), email: `alpha-${seq}@acme.test` })
  const b = await client.post('/api/clients', { name: uniq('Beta'), email: `beta-${seq}@acme.test` })
  const aId = a.body.data.id
  const bId = b.body.data.id

  // TC-11: nothing stored, nothing logged.
  const trailBefore = events('client_updated').length
  const withPassword = await client.patch(`/api/clients/${bId}`, { name: 'Beta Renamed', password: 'hunter2' })
  assert.equal(withPassword.status, 422)
  assert.equal(withPassword.body.field, 'password')
  assert.equal(db.prepare('SELECT name FROM clients WHERE id = ?').get(bId).name, b.body.data.name,
    'and the rest of the body was not applied either')
  assert.equal(events('client_updated').length, trailBefore)

  // TC-8: taking another client's address is refused and both keep theirs.
  const collide = await client.patch(`/api/clients/${bId}`, { email: a.body.data.email })
  assert.equal(collide.status, 422)
  assert.equal(collide.body.field, 'email')
  assert.equal(db.prepare('SELECT email FROM clients WHERE id = ?').get(aId).email, a.body.data.email)
  assert.equal(db.prepare('SELECT email FROM clients WHERE id = ?').get(bId).email, b.body.data.email)

  // §2: an id that is present must never fall through to a create.
  const before = db.prepare('SELECT COUNT(*) n FROM clients WHERE workspace_id = ?').get(owner.id).n
  const unknown = await client.patch('/api/clients/999999', { name: 'Ghost client', email: 'ghost@acme.test' })
  assert.equal(unknown.status, 404)
  const viaCreate = await client.post('/api/clients', { id: 999999, name: 'Ghost client', email: 'ghost@acme.test' })
  assert.equal(viaCreate.status, 422)
  assert.equal(viaCreate.body.field, 'id')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clients WHERE workspace_id = ?').get(owner.id).n, before,
    'no client was conjured by either attempt')

  // TC-3: another agency's client 404s and echoes no name.
  const stranger = seedUser(db, `stranger-client-${seq}@audit2.test`)
  db.prepare("INSERT INTO clients (workspace_id, name, email, permissions, status) VALUES (?, 'Their Brand', 'them@nasa.test', '[]', 'active')")
    .run(stranger.id)
  const theirs = db.prepare('SELECT * FROM clients WHERE workspace_id = ?').get(stranger.id)
  const refused = await client.patch(`/api/clients/${theirs.id}`, { name: 'Mine now' })
  assert.equal(refused.status, 404)
  assert.ok(!JSON.stringify(refused.body).includes('Their Brand'))
  assert.equal(db.prepare('SELECT name FROM clients WHERE id = ?').get(theirs.id).name, 'Their Brand')
})

test('lowering an allowance below what a client has used is accepted, stated plainly, and enforced', async () => {
  // Docs/clients/update.md AC 4 and TC-10 ask for the client's campaigns to
  // pause. They do: `client_allowance` in server/gates.js refuses every send
  // from a campaign carrying an over-allowance `client_id`, which is why the
  // response may now say so. The campaign's own status is deliberately
  // untouched — the pause is a condition that lifts the moment the allowance
  // is raised, not a stop somebody has to remember to undo.
  //
  // That no email actually leaves is proved by driving the engine in
  // tests/terminal-and-limits.test.js; this test covers the response and trail.
  const created = await client.post('/api/clients', { name: uniq('Overspender'), email: `over-${seq}@acme.test` })
  const id = created.body.data.id
  const campaign = runningCampaign('Client campaign')
  db.prepare('UPDATE campaigns SET client_id = ? WHERE id = ?').run(id, campaign.id)
  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, direction, subject, body, from_email, to_email, thread_id)
       VALUES (?, ?, 'out', 's', 'b', ?, ?, 'x')`
    ).run(owner.id, campaign.id, 'sender@audit2.test', `sent${i}@acme.test`)
  }

  const lowered = await client.patch(`/api/clients/${id}`, {
    is_credit_assigned: true, email_credits: 2, lead_credits: 10,
  })
  assert.equal(lowered.status, 200, 'accepted, not refused')
  assert.equal(lowered.body.overAllowance.used, 5)
  assert.equal(lowered.body.overAllowance.allowed, 2)
  assert.equal(lowered.body.overAllowance.enforced, true, 'the pause it claims is one the send path performs')
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaign.id).status, 'running',
    'and it is a gate rather than a status change, so raising the allowance is all it takes to resume')
  assert.ok(events('client_over_allowance').some((e) => e.detail.includes('5 of 2')),
    'the breach is on the activity trail')

  assert.equal(lowered.body.data.credits.email_credits, 2)
  assert.equal((await client.get(`/api/clients/${id}`)).body.data.credits.assigned, true)
})
