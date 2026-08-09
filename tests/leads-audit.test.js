// Audit of leads, lead-lists, lead-tags, lead-notes and lead-tasks against
// Docs/{leads,lead-lists,lead-tags,lead-notes,lead-tasks}/*.md.
//
// The headline defect these tests exist for is a send leak, so most of them end
// by running the real engine and reading the `messages` table. Asserting on a
// push response saying `excluded: {unsubscribed: 1}` proves the route can
// count; only a tick proves nobody was emailed.
//
// The leak: `unsubscribeLead()` in server/suppression.js — the function behind
// the footer link a *recipient* clicks and behind the campaign-scoped
// unsubscribe route — wrote the opt-out to the `leads` row and stopped there.
// `POST /api/leads/:id/unsubscribe` additionally wrote a `blocked_domains` row,
// and that row is the only part of an opt-out that outlives the person: `leads`
// cascades, so deleting someone takes `campaign_leads`, `lead_list_leads` and
// every other trace with it.
//
// So the sequence below — click unsubscribe, get tidied out of the workspace,
// reappear in next month's CSV — put a person who had opted out back into a
// running campaign as a brand-new active lead, and the engine emailed them.
// Docs/leads/delete.md states the rule plainly: "the suppression entry survives
// the deletion, so re-importing that address is still refused."
//
// Every suppression test here carries a clean control lead through the same
// tick. Without one, "no message was sent" is also what a broken engine, an
// unlaunched campaign or a typo'd query looks like.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, seedTag, mount } from './helpers/parity-harness.js'

setup('leads-audit')                    // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register: registerLeads } = await import('../server/parity/leads.js')
const { register: registerLists } = await import('../server/parity/lists.js')
const { register: registerTags } = await import('../server/parity/tags.js')
const { register: registerNotes } = await import('../server/parity/notes.js')
const { tick } = await import('../server/engine.js')
const { unsubscribeLead } = await import('../server/suppression.js')

const owner = seedUser(db, 'owner@audit.test')
// Approval off on purpose: with it on the engine parks a draft and the
// `messages` table stays empty for suppressed and unsuppressed leads alike,
// which would make every assertion below pass for the wrong reason.
db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)

const client = await mount([registerLeads, registerLists, registerTags, registerNotes], owner)
test.after(() => client.close())

// ---- fixtures ---------------------------------------------------------------

// One node, so a tick either sends the intro or does not. Nothing in these
// tests turns on branching.
const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: introduce ourselves]
  A -- no reply 3d --> L([Lost])
`

const mailbox = seedMailbox(db, owner.id, 'sender@audit.test')

let seq = 0
const uniq = (s) => `${s} ${++seq}`

function runningCampaign(name) {
  const campaign = seedCampaign(db, owner.id, uniq(name), mailbox.id)
  db.prepare("UPDATE campaigns SET status = 'running', mermaid = ? WHERE id = ?").run(PLAYBOOK, campaign.id)
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id)
}

async function makeList(name = 'Segment') {
  const res = await client.post('/api/lead-lists', { name: uniq(name) })
  assert.equal(res.status, 200)
  return res.body
}

// What actually left the building, by recipient.
const sentTo = (email) => db.prepare(
  "SELECT COUNT(*) n FROM messages WHERE lower(to_email) = ? AND direction = 'out'"
).get(String(email).toLowerCase()).n

const blockRow = (address) => db.prepare(
  'SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ?'
).get(owner.id, String(address).toLowerCase())

const leadRow = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id)

// ---- the leak ---------------------------------------------------------------

test('a recipient-initiated unsubscribe records suppression that outlives the person', async () => {
  // The three unsubscribe paths must leave the same durable trace. This one is
  // the footer link, which is the path that legally matters and the one that
  // used to leave nothing behind but a row that cascades away.
  const lead = seedLead(db, owner.id, 'clicked@acme.test')
  const campaign = runningCampaign('Footer unsubscribe')
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state) VALUES (?, ?, 'queued')")
    .run(campaign.id, lead.id)

  const result = unsubscribeLead(owner.id, lead.id, { source: 'link', actor: 'recipient' })
  assert.equal(result.stopped, 1, 'the enrolment is stopped')

  const block = blockRow('clicked@acme.test')
  assert.ok(block, 'the address is on the never-contact list')
  assert.equal(block.is_domain, 0, 'as an exact address, not a whole domain')
  assert.equal(block.source, 'unsubscribe')

  // The point of the row: it survives the record it came from.
  db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE lead_id = ?').get(lead.id).n, 0,
    'the enrolment cascaded away with the person')
  assert.ok(blockRow('clicked@acme.test'), 'the opt-out did not')
})

test('a deleted-then-re-imported unsubscriber is never emailed again', async () => {
  // The whole defect, end to end, ending at the `messages` table.
  //
  //   1. they click the unsubscribe link in a footer
  //   2. a tidy-up deletes the lead record, taking every trace with it
  //   3. next month's CSV contains them again
  //   4. the segment is pushed at a running campaign
  //   5. the engine ticks
  //
  // Step 5 used to send them an email.
  const campaign = runningCampaign('Resurrection')
  const list = await makeList('Re-imported')

  const ghost = seedLead(db, owner.id, 'ghost@acme.test')
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state) VALUES (?, ?, 'queued')")
    .run(campaign.id, ghost.id)
  unsubscribeLead(owner.id, ghost.id, { source: 'link', actor: 'recipient' })
  db.prepare('DELETE FROM leads WHERE id = ?').run(ghost.id)

  const imported = await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'february.csv',
    // The control travels in the same file, through the same code path.
    leads: [{ email: 'ghost@acme.test', first_name: 'Ghost' }, { email: 'fresh@acme.test', first_name: 'Fresh' }],
  })
  assert.equal(imported.status, 200)
  assert.equal(imported.body.imported, 1, 'only the clean address becomes a lead')
  assert.equal(imported.body.blocked, 1, 'the opt-out is honoured against an address with no lead row')
  assert.equal(imported.body.suppression.blockedDomain, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND email = ?').get(owner.id, 'ghost@acme.test').n, 0,
    'no person record is recreated for them')

  const pushed = await client.post('/api/lead-lists/push-to-campaign', {
    campaignId: campaign.id,
    selection: { listId: list.id },
  })
  assert.equal(pushed.status, 200)
  assert.equal(pushed.body.pushed, 1)

  await tick()

  assert.equal(sentTo('fresh@acme.test'), 1, 'the control was emailed, so the engine really ran')
  assert.equal(sentTo('ghost@acme.test'), 0, 'and the person who opted out was not')
})

test('an import cannot resurrect an unsubscriber whose lead row still exists', async () => {
  const list = await makeList('Existing unsubscriber')
  const lead = seedLead(db, owner.id, 'still-here@acme.test')
  unsubscribeLead(owner.id, lead.id, { source: 'link', actor: 'recipient' })

  const res = await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'again.csv',
    leads: [{ email: 'still-here@acme.test', first_name: 'Renamed', company: 'New Co' }],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.blocked, 1)
  assert.equal(res.body.imported, 0)

  const stored = leadRow(lead.id)
  assert.equal(stored.status, 'unsubscribed', 'the re-import did not reset their status')
  assert.equal(stored.first_name, 'Ada', 'nor overwrite their details as a live lead would be updated')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE lead_id = ?').get(lead.id).n, 0,
    'and they were not added to the segment')
})

test('no request field can talk the import or the push past a suppression', async () => {
  // Refused rather than ignored: a caller who sends an override and gets a 200
  // has every reason to believe the opt-out was bypassed.
  const list = await makeList('Override attempt')
  const campaign = runningCampaign('Override attempt')

  for (const body of [
    { fileName: 'f.csv', leads: [], ignore_unsubscribe_list: true },
    { fileName: 'f.csv', leads: [], ignoreGlobalBlockList: true },
    { fileName: 'f.csv', leads: [], csvSettings: { ignoreGlobalBlockList: true } },
    { fileName: 'f.csv', leads: [], force: true },
  ]) {
    const res = await client.post(`/api/lead-lists/${list.id}/import`, body)
    assert.equal(res.status, 422, `refused: ${Object.keys(body).join(',')}`)
    assert.match(res.body.message, /Suppression cannot be bypassed/)
  }

  const push = await client.post('/api/lead-lists/push-to-campaign', {
    campaignId: campaign.id,
    selection: { listId: list.id },
    ignore_unsubscribe_list: true,
  })
  assert.equal(push.status, 422)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n, 0)
})

test('a lead carrying an unsubscribe timestamp but an active status is excluded and said so', async () => {
  // The unsubscribe writers do not all set the same columns, so a row can carry
  // `unsubscribed_at` with `status = 'active'`. The push used to test the
  // status alone: it attached this lead, reported `excluded.unsubscribed: 0`,
  // and left the mailer to kill the enrolment silently a tick later. The user
  // was told 2 leads were pushed and only 1 was ever going to be emailed.
  const campaign = runningCampaign('Mixed state')
  const half = seedLead(db, owner.id, 'half-out@acme.test')
  const control = seedLead(db, owner.id, 'control-mixed@acme.test')
  db.prepare("UPDATE leads SET status = 'active', unsubscribed_at = ? WHERE id = ?")
    .run('2025-01-01T00:00:00.000Z', half.id)

  const res = await client.post('/api/lead-lists/push-to-campaign', {
    campaignId: campaign.id,
    selection: { leadIds: [half.id, control.id] },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.pushed, 1, 'only the control is attached')
  assert.equal(res.body.excluded.unsubscribed, 1, 'and the exclusion is reported, not silent')
  assert.ok(res.body.exclusions.some((e) => e.leadId === half.id && e.reason === 'unsubscribed'))

  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .get(campaign.id, half.id).n, 0, 'no enrolment row was written for them at all')

  await tick()
  assert.equal(sentTo('control-mixed@acme.test'), 1)
  assert.equal(sentTo('half-out@acme.test'), 0)
})

test('a blocked domain keeps its subdomains off a campaign, through a segment', async () => {
  db.prepare("INSERT INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (?, 'rival.test', 1, 'manual')")
    .run(owner.id)
  const campaign = runningCampaign('Blocked domain')
  const list = await makeList('Blocked domain')

  const sub = seedLead(db, owner.id, 'anna@mail.rival.test')
  const bare = seedLead(db, owner.id, 'bob@rival.test')
  const fine = seedLead(db, owner.id, 'carol@notrival.test')
  for (const lead of [sub, bare, fine]) {
    db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)
  }

  const res = await client.post('/api/lead-lists/push-to-campaign', {
    campaignId: campaign.id,
    selection: { listId: list.id },
  })
  assert.equal(res.body.pushed, 1)
  assert.equal(res.body.excluded.blocked, 2, 'the subdomain is caught as well as the bare domain')

  await tick()
  assert.equal(sentTo('carol@notrival.test'), 1)
  assert.equal(sentTo('anna@mail.rival.test'), 0)
  assert.equal(sentTo('bob@rival.test'), 0)
})

// ---- labelling is organisation, never permission ----------------------------

test('labelling an unsubscribed lead is allowed and changes nothing about sending', async () => {
  // Docs/lead-tags/add-to-lead.md TC-10. A label is a note to a human; it must
  // not become a way of marking someone contactable again.
  const campaign = runningCampaign('Tagged unsubscriber')
  const tag = seedTag(db, owner.id, uniq('VIP'))
  const gone = seedLead(db, owner.id, 'tagged-gone@acme.test')
  const control = seedLead(db, owner.id, 'tagged-fine@acme.test')
  for (const lead of [gone, control]) {
    db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state) VALUES (?, ?, 'queued')")
      .run(campaign.id, lead.id)
  }
  unsubscribeLead(owner.id, gone.id, { source: 'link', actor: 'recipient' })

  const res = await client.post('/api/leads/tags', { leadIds: [gone.id, control.id], tagIds: [tag.id] })
  assert.equal(res.status, 200, 'the label applies — a label is not a permission')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_tags WHERE lead_id = ?').get(gone.id).n, 1)

  await tick()
  assert.equal(sentTo('tagged-fine@acme.test'), 1)
  assert.equal(sentTo('tagged-gone@acme.test'), 0, 'the label did not make them contactable')
})

test('a note or a task on a lead never becomes permission to email them', async () => {
  const campaign = runningCampaign('Noted unsubscriber')
  const gone = seedLead(db, owner.id, 'noted-gone@acme.test')
  const control = seedLead(db, owner.id, 'noted-fine@acme.test')
  for (const lead of [gone, control]) {
    db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state) VALUES (?, ?, 'queued')")
      .run(campaign.id, lead.id)
  }
  unsubscribeLead(owner.id, gone.id, { source: 'link', actor: 'recipient' })

  // Docs/lead-tasks/create.md TC-12: a task on an unsubscribed lead is allowed,
  // because "phone them to confirm" is legitimate work.
  const note = await client.post(`/api/leads/${gone.id}/notes`, { body: 'Asked to be removed — confirm by phone.' })
  assert.equal(note.status, 200)
  const task = await client.post(`/api/leads/${gone.id}/tasks`, { title: 'Phone to confirm removal' })
  assert.equal(task.status, 200)

  await tick()
  assert.equal(sentTo('noted-fine@acme.test'), 1)
  assert.equal(sentTo('noted-gone@acme.test'), 0)
})

// ---- segment membership is organisation only --------------------------------

test('moving leads between segments composes and sends nothing', async () => {
  // Docs/lead-lists/push-between-lists.md: "when the engine next ticks, then no
  // campaign changes as a result: segment membership is organisation only".
  const from = await makeList('Transfer source')
  const to = await makeList('Transfer target')
  const lead = seedLead(db, owner.id, 'transferred@acme.test')
  db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(from.id, lead.id)

  const before = db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out'").get().n
  const enrolments = db.prepare('SELECT COUNT(*) n FROM campaign_leads').get().n

  const res = await client.post('/api/lead-lists/transfer', {
    action: 'move', fromListId: from.id, toListId: to.id,
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.totalLeadsMoved, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(from.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(to.id).n, 1)

  await tick()
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out'").get().n, before,
    'nothing was sent by a filing change')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads').get().n, enrolments,
    'and nobody was enrolled anywhere by it')
})

test('deleting a segment keeps every lead and every campaign attachment', async () => {
  // Docs/lead-lists/delete.md: the grouping goes, the people stay, and a
  // campaign populated from the segment is untouched.
  const campaign = runningCampaign('Segment deleted')
  const list = await makeList('Doomed segment')
  const tag = seedTag(db, owner.id, uniq('region'), 'lead_list')
  const lead = seedLead(db, owner.id, 'kept@acme.test')
  db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)
  await client.post('/api/lead-lists/assign-tags', { listIds: [list.id], tagIds: [tag.id] })
  await client.post('/api/lead-lists/push-to-campaign', { campaignId: campaign.id, selection: { listId: list.id } })

  const res = await client.del(`/api/lead-lists/${list.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.leadsKept, 1)
  assert.equal(res.body.leadsDeleted, 0)
  assert.equal(res.body.tagsUnassigned, 1)

  assert.ok(leadRow(lead.id), 'the person survives the grouping')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .get(campaign.id, lead.id).n, 1, 'and stays attached to the campaign that was filled from it')
  assert.ok(db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id), 'the label itself survives for other segments')

  await tick()
  assert.equal(sentTo('kept@acme.test'), 1, 'the campaign kept running as if nothing happened')
})

// ---- lead lists: paging and counts ------------------------------------------

test('the segments list defaults to ten per page and derives its counts', async () => {
  // Docs/lead-lists/get-all.md TC-10 names the default; TC-11 and get-by-id's
  // TC-8 insist the count is derived from membership rather than stored.
  const made = []
  for (let i = 0; i < 12; i++) made.push(await makeList(`Default paging ${i}`))

  const first = await client.get('/api/lead-lists')
  assert.equal(first.status, 200)
  assert.equal(first.body.limit, 10, 'the documented default')
  assert.equal(first.body.items.length, 10)
  assert.ok(first.body.hasMore)

  const target = made[0]
  const before = (await client.get(`/api/lead-lists/${target.id}`)).body
  assert.equal(before.leadCount, 0)

  const lead = seedLead(db, owner.id, `counted-${seq}@acme.test`)
  db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(target.id, lead.id)

  const after = (await client.get(`/api/lead-lists/${target.id}`)).body
  assert.equal(after.leadCount, 1, 'derived, so it cannot go stale')
})

// ---- the lead record --------------------------------------------------------

test('a save that changes nothing is a no-op, not an error and not a lost draft', async () => {
  // Docs/leads/update.md TC-6: "200 with no change recorded and no activity
  // trail entry". The form re-submits every field, so a user who edits nothing
  // must not be told off — and must not have their queued email discarded,
  // which is what the write path does when it believes something changed.
  const lead = seedLead(db, owner.id, 'unchanged@acme.test', { company: 'Acme' })
  const campaign = runningCampaign('No-op save')
  db.prepare(
    "INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body, status) VALUES (?, ?, ?, 'A', 'Hi', 'Body', 'pending')"
  ).run(owner.id, campaign.id, lead.id)
  const trailBefore = db.prepare("SELECT COUNT(*) n FROM events WHERE lead_id = ? AND type = 'lead_updated'").get(lead.id).n

  const res = await client.patch(`/api/leads/${lead.id}`, { company: 'Acme', firstName: 'Ada' })
  assert.equal(res.status, 200)
  assert.equal(res.body.changed, false)
  assert.deepEqual(res.body.changedFields, [])
  assert.equal(res.body.draftsInvalidated, 0)

  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE lead_id = ? AND type = 'lead_updated'").get(lead.id).n,
    trailBefore, 'no trail entry for a change that did not happen')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM drafts WHERE lead_id = ? AND status = 'pending'").get(lead.id).n, 1,
    'and the queued email survives')

  // A body naming nothing updatable is still a 422 — that is a malformed
  // request, not a user who edited nothing.
  const empty = await client.patch(`/api/leads/${lead.id}`, {})
  assert.equal(empty.status, 422)
  assert.equal(empty.body.field, 'fields')
})

test('an edit cannot walk a lead onto an address that has opted out', async () => {
  // Docs/leads/update.md TC-10. The interesting case is the one the workspace
  // uniqueness check cannot catch: the opted-out person has been deleted, so
  // only the suppression list remembers them.
  const gone = seedLead(db, owner.id, 'departed@acme.test')
  unsubscribeLead(owner.id, gone.id, { source: 'link', actor: 'recipient' })
  db.prepare('DELETE FROM leads WHERE id = ?').run(gone.id)

  const mover = seedLead(db, owner.id, 'mover@acme.test')
  const res = await client.patch(`/api/leads/${mover.id}`, { email: 'departed@acme.test' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'email')
  assert.match(res.body.message, /suppression list/)
  assert.equal(leadRow(mover.id).email, 'mover@acme.test', 'and the address was not changed')
})

test('an enrolment names the label applied in that campaign, not just its id', async () => {
  // Docs/leads/get-by-email.md: "every enrolment is listed with the campaign
  // name, the campaign-lead mapping identifier and the label applied in that
  // campaign". A bare id means the caller needs a second request to render one
  // row, which is the thing this lookup exists to avoid.
  const categories = await client.get('/api/lead-categories')
  const interested = categories.body.data.find((c) => c.name === 'interested')
  assert.ok(interested)

  const campaign = runningCampaign('Labelled enrolment')
  const lead = seedLead(db, owner.id, 'labelled@acme.test')
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, category_id) VALUES (?, ?, 'waiting', ?)")
    .run(campaign.id, lead.id, interested.id)

  const res = await client.get('/api/leads/by-email?email=LABELLED%40acme.test')
  assert.equal(res.status, 200)
  assert.equal(res.body.found, true)
  const enrolment = res.body.enrolments.find((e) => e.campaignId === campaign.id)
  assert.ok(enrolment.enrolmentId, 'the campaign-lead mapping identifier')
  assert.equal(enrolment.categoryId, interested.id)
  assert.equal(enrolment.category.name, 'interested')
  assert.equal(enrolment.category.sentiment, 'positive')
})

test('categories can be filtered to one sentiment', async () => {
  // Docs/leads/categories.md TC-7. Sentiment is what Reports groups on, so a
  // caller must be able to ask for it without matching on names itself.
  const positive = await client.get('/api/lead-categories?sentiment=positive')
  assert.equal(positive.status, 200)
  assert.ok(positive.body.data.length > 0)
  assert.deepEqual(positive.body.data.map((c) => c.name), ['interested'])

  const negative = await client.get('/api/lead-categories?sentiment=negative')
  assert.deepEqual(negative.body.data.map((c) => c.name).sort(), ['not interested', 'unsubscribe'])

  const bad = await client.get('/api/lead-categories?sentiment=cheerful')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'sentiment')
})

test('the workspace boundary holds across every route in these five categories', async () => {
  // One test rather than five near-identical ones: the rule is the same and the
  // failure would be the same.
  const stranger = seedUser(db, 'stranger@audit.test')
  const theirLead = seedLead(db, stranger.id, 'katherine@nasa.test', { first_name: 'Katherine' })
  db.prepare('INSERT INTO lead_lists (workspace_id, name) VALUES (?, ?)').run(stranger.id, 'Their segment')
  const theirList = db.prepare('SELECT * FROM lead_lists WHERE workspace_id = ?').get(stranger.id)
  db.prepare("INSERT INTO tags (workspace_id, applies_to, name, color) VALUES (?, 'lead', 'Theirs', '#111111')").run(stranger.id)
  const theirTag = db.prepare("SELECT * FROM tags WHERE workspace_id = ?").get(stranger.id)

  const attempts = [
    await client.get(`/api/leads/${theirLead.id}`),
    await client.get(`/api/leads/${theirLead.id}/activities`),
    await client.patch(`/api/leads/${theirLead.id}`, { company: 'Mine now' }),
    await client.post(`/api/leads/${theirLead.id}/unsubscribe`, {}),
    await client.get(`/api/lead-lists/${theirList.id}`),
    await client.del(`/api/lead-lists/${theirList.id}`),
    await client.post(`/api/lead-lists/${theirList.id}/import`, { fileName: 'x.csv', leads: [{ email: 'x@y.test' }] }),
    await client.post('/api/leads/tags', { leadIds: [theirLead.id], tagIds: [theirTag.id] }),
    await client.get(`/api/leads/${theirLead.id}/notes`),
    await client.post(`/api/leads/${theirLead.id}/notes`, { body: 'peeking' }),
    await client.get(`/api/leads/${theirLead.id}/tasks`),
    await client.post(`/api/leads/${theirLead.id}/tasks`, { title: 'peeking' }),
  ]
  for (const res of attempts) {
    assert.equal(res.status, 404, `refused: ${JSON.stringify(res.body)}`)
    const body = JSON.stringify(res.body).toLowerCase()
    assert.ok(!body.includes('katherine'), 'and the refusal names nobody')
    assert.ok(!body.includes('nasa'), 'and nothing about them')
    assert.ok(!body.includes('their segment'))
  }

  // Nothing was written into the other workspace either.
  assert.equal(leadRow(theirLead.id).company, 'Acme')
  assert.equal(leadRow(theirLead.id).status, 'active')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_notes WHERE lead_id = ?').get(theirLead.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_tasks WHERE lead_id = ?').get(theirLead.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_tags WHERE lead_id = ?').get(theirLead.id).n, 0)
  assert.equal(String(db.prepare('SELECT deleted_at FROM lead_lists WHERE id = ?').get(theirList.id).deleted_at || ''), '')
})
