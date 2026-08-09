// Inbox parity tests — the one list route, the one mutation route, and the
// triage writes that hang off them.
//
// The things worth pinning, in the order the specs argue for them: every
// `state` returns the rows it claims and an unknown one is a 422; keyset paging
// survives a reply landing mid-scroll; archive, snooze, important and read all
// round-trip; a bulk mark-read writes ONE events row; every :id route 404s
// across a workspace boundary without leaking; a blocked domain applies with no
// way to opt out; and an unmatched reply attaches to a lead.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, seedMessage, mount } from './helpers/parity-harness.js'

setup('inbox')                     // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/inbox.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// ---- fixtures ---------------------------------------------------------------

// A real playbook, so intent corrections are validated against the reply edges
// the diagram actually offers rather than waved through.
const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro our product]
  A -- reply: interested --> B[Send: propose a call]
  A -- reply: unsubscribe --> U([Unsubscribed])
  B -- reply --> W([Won: call booked])
`

const mailbox = seedMailbox(db, owner.id, 'sender@example.com')
const campaign = seedCampaign(db, owner.id, 'Q3 outbound', mailbox.id)
db.prepare('UPDATE campaigns SET mermaid = ? WHERE id = ?').run(PLAYBOOK, campaign.id)
// The subsequence gets a real playbook of its own. Pushing a lead into a
// campaign whose diagram does not parse is refused now — it cannot compose
// anything, so the lead would be moved out of a working campaign and stranded
// in a broken one. An empty `mermaid` here made this fixture describe a
// campaign nobody would be allowed to push into.
const SUB_PLAYBOOK = `flowchart TD
  S([Start]) --> N[Send: the nurture follow-up]
  N -- reply --> W([Won])
`
const sub = seedCampaign(db, owner.id, 'Q3 nurture', mailbox.id)
db.prepare('UPDATE campaigns SET parent_campaign_id = ?, mermaid = ? WHERE id = ?')
  .run(campaign.id, SUB_PLAYBOOK, sub.id)

// Six threads, each one outbound plus one inbound reply, so every list has
// something real to return rather than an artificial single-message thread.
const leads = []
const threads = []
for (let i = 1; i <= 6; i++) {
  const lead = seedLead(db, owner.id, `lead${i}@acme.test`, { first_name: `Lead${i}`, company: i === 3 ? 'Startup Inc' : 'Acme' })
  leads.push(lead)
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, node_id, thread_id) VALUES (?, ?, 'waiting', 'n1', ?)")
    .run(campaign.id, lead.id, `thread-${i}`)
  const out = seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: lead.id, mailboxId: mailbox.id, direction: 'out',
    thread_id: `thread-${i}`, subject: `Hello ${i}`, body: 'Opening line.', intent: '',
    from_email: 'sender@example.com', to_email: lead.email,
  })
  const inbound = seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: lead.id, mailboxId: mailbox.id, direction: 'in',
    thread_id: `thread-${i}`, subject: `Re: Hello ${i}`, body: i === 3 ? 'Johnson here, keen.' : 'Sounds good.',
    from_email: lead.email, to_email: 'sender@example.com', intent: 'interested',
  })
  threads.push({ lead, anchorId: out.id, inboundId: inbound.id, key: `thread-${i}` })
}

const pairing = (leadId, campaignId = campaign.id) =>
  db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId)

// A second workspace with one of everything, for the isolation tests.
const otherMailbox = seedMailbox(db, stranger.id, 'other@example.com')
const otherCampaign = seedCampaign(db, stranger.id, 'Their campaign', otherMailbox.id)
const otherLead = seedLead(db, stranger.id, 'them@other.test')
db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, thread_id) VALUES (?, ?, 'waiting', 'other-thread')")
  .run(otherCampaign.id, otherLead.id)
const otherMessage = seedMessage(db, stranger.id, {
  campaignId: otherCampaign.id, leadId: otherLead.id, mailboxId: otherMailbox.id, direction: 'in',
  thread_id: 'other-thread', subject: 'Their reply', body: 'Private.',
})
const otherPairing = pairing(otherLead.id, otherCampaign.id)

const eventCount = () => db.prepare('SELECT COUNT(*) n FROM events WHERE user_id = ?').get(owner.id).n

// ---- the one list route -----------------------------------------------------

test('an unknown state is a 422 naming the field', async () => {
  const res = await client.get('/api/inbox/threads?state=inbox-replies')
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'state')
  assert.match(res.body.message, /state must be one of/)
})

test('the default state lists every replied thread once', async () => {
  const res = await client.get('/api/inbox/threads')
  assert.equal(res.status, 200)
  assert.equal(res.body.state, 'active')
  assert.equal(res.body.total_count, 6)
  assert.equal(res.body.items.length, 6)
  assert.equal(res.body.items[0].rowType, 'thread')
  // Newest reply first, and one row per thread rather than one per message.
  assert.equal(res.body.items[0].lead.email, 'lead6@acme.test')
  assert.equal(new Set(res.body.items.map((i) => i.threadKey)).size, 6)
  assert.equal(res.body.items[0].message_count, 2)
})

test('search, campaign and intent filters narrow the same list', async () => {
  const bySearch = await client.get('/api/inbox/threads?search=Startup')
  assert.equal(bySearch.body.items.length, 1)
  assert.equal(bySearch.body.items[0].lead.company, 'Startup Inc')

  const byCampaign = await client.get(`/api/inbox/threads?campaignId=${campaign.id}`)
  assert.equal(byCampaign.body.total_count, 6)

  const byIntent = await client.get('/api/inbox/threads?intent=interested')
  assert.equal(byIntent.body.total_count, 6)
})

test('filter ceilings report field, provided count and maximum', async () => {
  const res = await client.get('/api/inbox/threads?campaignId=1,2,3,4,5,6')
  assert.equal(res.status, 422)
  assert.deepEqual(
    { field: res.body.field, provided: res.body.provided_count, max: res.body.max_allowed },
    { field: 'campaignId', provided: 6, max: 5 },
  )
  const search = await client.get(`/api/inbox/threads?search=${'x'.repeat(31)}`)
  assert.equal(search.status, 422)
  assert.equal(search.body.field, 'search')
})

test('a filter id from another workspace is refused, not silently dropped', async () => {
  const res = await client.get(`/api/inbox/threads?campaignId=${otherCampaign.id}`)
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'campaignId')
})

test('keyset paging stays stable when a new reply arrives mid-scroll', async () => {
  const first = await client.get('/api/inbox/threads?limit=2')
  assert.equal(first.body.items.length, 2)
  assert.equal(first.body.hasMore, true)
  const seen = first.body.items.map((i) => i.threadKey)

  // A brand-new reply on thread-1 while the reader is between pages. It sorts
  // to the very top; page two is keyed below the cursor, so it neither
  // duplicates nor skips anything the reader has already passed.
  seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: leads[0].id, mailboxId: mailbox.id, direction: 'in',
    thread_id: 'thread-1', subject: 'Re: Hello 1', body: 'One more thing.',
    from_email: leads[0].email, to_email: 'sender@example.com',
  })

  const second = await client.get(`/api/inbox/threads?limit=2&cursor=${first.body.nextCursor}`)
  const secondKeys = second.body.items.map((i) => i.threadKey)
  assert.equal(secondKeys.length, 2)
  assert.equal(secondKeys.filter((k) => seen.includes(k)).length, 0)
  assert.deepEqual(secondKeys, ['thread-4', 'thread-3'])

  // thread-1 is not skipped: its key jumped above the cursor, so it is now at
  // the top of page one where the reader will meet it next. Offset paging would
  // instead have shunted an unread row off the end of the last page.
  const third = await client.get(`/api/inbox/threads?limit=2&cursor=${second.body.nextCursor}`)
  assert.deepEqual(third.body.items.map((i) => i.threadKey), ['thread-2'])
  assert.equal(third.body.hasMore, false)
  assert.equal((await client.get('/api/inbox/threads?limit=2')).body.items[0].threadKey, 'thread-1')
})

// ---- read state and the badge ----------------------------------------------

test('unread starts at every thread and the badge matches the list', async () => {
  const list = await client.get('/api/inbox/threads?state=unread')
  const count = await client.get('/api/inbox/unread-count')
  assert.equal(list.body.total_count, 6)
  assert.equal(count.body.count, 6)
})

test('marking read is idempotent and marking unread puts it back', async () => {
  const id = threads[5].anchorId
  const read = await client.patch(`/api/inbox/threads/${id}`, { read: true })
  assert.equal(read.status, 200)
  assert.equal(read.body.is_read, true)

  const again = await client.patch(`/api/inbox/threads/${id}`, { read: true })
  assert.equal(again.status, 200)
  assert.equal(again.body.is_read, true)
  assert.equal((await client.get('/api/inbox/unread-count')).body.count, 5)

  const back = await client.patch(`/api/inbox/threads/${id}`, { read: false })
  assert.equal(back.body.is_read, false)
  assert.equal((await client.get('/api/inbox/unread-count')).body.count, 6)
})

test('a new inbound reply beats a mark-read — an unseen message is never hidden', async () => {
  const id = threads[4].anchorId
  await client.patch(`/api/inbox/threads/${id}`, { read: true })
  assert.equal((await client.get('/api/inbox/unread-count')).body.count, 5)

  seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: leads[4].id, mailboxId: mailbox.id, direction: 'in',
    thread_id: 'thread-5', subject: 'Re: Hello 5', body: 'Actually, one more.',
    from_email: leads[4].email, to_email: 'sender@example.com',
  })
  assert.equal((await client.get('/api/inbox/unread-count')).body.count, 6)
})

test('a bulk mark-read writes exactly one events row', async () => {
  const before = eventCount()
  const ids = threads.slice(0, 4).map((t) => t.anchorId)
  const res = await client.patch('/api/inbox/threads', { ids, read: true })
  assert.equal(res.status, 200)
  assert.equal(res.body.updated, 4)
  assert.equal(res.body.results.every((r) => r.ok && r.is_read), true)
  assert.equal(eventCount() - before, 1)

  const row = db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(owner.id)
  assert.equal(row.type, 'inbox_state_bulk')
  assert.match(row.detail, /4 threads/)

  // Put them back so later counts are predictable.
  await client.patch('/api/inbox/threads', { ids, read: false })
})

test('a bulk write is all-or-nothing when one id is out of workspace', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM messages WHERE user_id = ? AND read_at != \'\'').get(owner.id).n
  const res = await client.patch('/api/inbox/threads', { ids: [threads[0].anchorId, otherMessage.id], read: true })
  assert.equal(res.status, 404)
  const after = db.prepare('SELECT COUNT(*) n FROM messages WHERE user_id = ? AND read_at != \'\'').get(owner.id).n
  assert.equal(after, before)
})

test('a non-boolean read status is a 422 naming the field', async () => {
  const res = await client.patch(`/api/inbox/threads/${threads[0].anchorId}`, { read: 'yes' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'read')
})

// ---- archive, snooze, important --------------------------------------------

test('archive round-trips and leaves the active list', async () => {
  const id = threads[3].anchorId
  const on = await client.patch(`/api/inbox/threads/${id}`, { archived: true })
  assert.equal(on.body.is_archived, true)

  const archived = await client.get('/api/inbox/threads?state=archived')
  assert.deepEqual(archived.body.items.map((i) => i.threadKey), ['thread-4'])
  const active = await client.get('/api/inbox/threads')
  assert.equal(active.body.items.some((i) => i.threadKey === 'thread-4'), false)

  const off = await client.patch(`/api/inbox/threads/${id}`, { archived: false })
  assert.equal(off.body.is_archived, false)
  assert.equal((await client.get('/api/inbox/threads?state=archived')).body.total_count, 0)
})

test('a reply on an archived thread unarchives it without a job', async () => {
  await client.patch(`/api/inbox/threads/${threads[2].anchorId}`, { archived: true })
  assert.equal((await client.get('/api/inbox/threads?state=archived')).body.total_count, 1)
  seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: leads[2].id, mailboxId: mailbox.id, direction: 'in',
    thread_id: 'thread-3', subject: 'Re: Hello 3', body: 'Still here.',
    from_email: leads[2].email, to_email: 'sender@example.com',
  })
  assert.equal((await client.get('/api/inbox/threads?state=archived')).body.total_count, 0)
})

test('snooze hides a thread until its time, evaluated at read time', async () => {
  const id = threads[1].anchorId
  const future = new Date(Date.now() + 36e5).toISOString()
  const on = await client.patch(`/api/inbox/threads/${id}`, { snoozedUntil: future })
  assert.equal(on.body.is_snoozed, true)
  assert.equal((await client.get('/api/inbox/threads?state=snoozed')).body.total_count, 1)
  assert.equal((await client.get('/api/inbox/threads')).body.items.some((i) => i.threadKey === 'thread-2'), false)

  // Move the stored time into the past: no job runs, and the thread is awake
  // on the very next read.
  db.prepare("UPDATE messages SET snoozed_until = ? WHERE thread_id = 'thread-2'").run(new Date(Date.now() - 1000).toISOString())
  assert.equal((await client.get('/api/inbox/threads?state=snoozed')).body.total_count, 0)
  assert.equal((await client.get('/api/inbox/threads')).body.items.some((i) => i.threadKey === 'thread-2'), true)

  const off = await client.patch(`/api/inbox/threads/${id}`, { snoozedUntil: null })
  assert.equal(off.body.is_snoozed, false)
})

test('a manual star survives a later reply on the same thread', async () => {
  const id = threads[0].anchorId
  const on = await client.patch(`/api/inbox/threads/${id}`, { important: true })
  assert.equal(on.body.is_important, true)
  assert.deepEqual((await client.get('/api/inbox/threads?state=important')).body.items.map((i) => i.threadKey), ['thread-1'])

  seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: leads[0].id, mailboxId: mailbox.id, direction: 'in',
    thread_id: 'thread-1', subject: 'Re: Hello 1', body: 'And another.',
    from_email: leads[0].email, to_email: 'sender@example.com',
  })
  assert.equal((await client.get('/api/inbox/threads?state=important')).body.total_count, 1)
  await client.patch(`/api/inbox/threads/${id}`, { important: false })
})

test('a snoozed or archived thread is excluded from unread and its badge alike', async () => {
  const before = (await client.get('/api/inbox/unread-count')).body.count
  await client.patch(`/api/inbox/threads/${threads[1].anchorId}`, { snoozedUntil: new Date(Date.now() + 36e5).toISOString() })
  const list = await client.get('/api/inbox/threads?state=unread')
  const count = await client.get('/api/inbox/unread-count')
  assert.equal(count.body.count, before - 1)
  assert.equal(list.body.total_count, count.body.count)
  await client.patch(`/api/inbox/threads/${threads[1].anchorId}`, { snoozedUntil: null })
})

// ---- one thread in full -----------------------------------------------------

test('a thread returns its messages in order and a GET never marks it read', async () => {
  const id = threads[3].anchorId
  const res = await client.get(`/api/inbox/threads/${id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.lead.email, 'lead4@acme.test')
  assert.equal(res.body.campaign.name, 'Q3 outbound')
  assert.deepEqual(res.body.messages.map((m) => m.direction), ['out', 'in'])
  assert.equal(res.body.is_read, false)
  assert.equal((await client.get(`/api/inbox/threads/${id}`)).body.is_read, false)
})

// ---- assignment, revenue, intent, resume ------------------------------------

test('assignment moves a thread into the assigned state without gating approval', async () => {
  const cl = pairing(leads[0].id)
  const res = await client.patch(`/api/campaign-leads/${cl.id}/assignee`, { assignee: 'owner@example.com' })
  assert.equal(res.status, 200)
  assert.equal(res.body.assignedTo, 'owner@example.com')
  assert.equal(res.body.gatesApproval, false)

  const mine = await client.get('/api/inbox/threads?state=assigned')
  assert.deepEqual(mine.body.items.map((i) => i.threadKey), ['thread-1'])

  const cleared = await client.patch(`/api/campaign-leads/${cl.id}/assignee`, { assignee: null })
  assert.equal(cleared.body.assignedTo, '')
})

test('a bulk assignment reports every id and writes one events row', async () => {
  const before = eventCount()
  const ids = [pairing(leads[1].id).id, pairing(leads[2].id).id]
  const res = await client.patch('/api/campaign-leads/assignee', { ids, assignee: 'owner@example.com' })
  assert.equal(res.body.updated, 2)
  assert.equal(eventCount() - before, 1)
  await client.patch('/api/campaign-leads/assignee', { ids, assignee: null })
})

test('an assignee outside the workspace is a 404 that names nobody', async () => {
  const cl = pairing(leads[0].id)
  const res = await client.patch(`/api/campaign-leads/${cl.id}/assignee`, { assignee: 'stranger@example.com' })
  assert.equal(res.status, 404)
  assert.equal(res.body.message, 'No such team member')
})

test('revenue is stored in minor units and negatives are refused', async () => {
  const cl = pairing(leads[0].id)
  const res = await client.patch(`/api/campaign-leads/${cl.id}/revenue`, { amount: 1234.56, currency: 'gbp' })
  assert.equal(res.status, 200)
  assert.equal(res.body.amount_minor, 123456)
  assert.equal(res.body.amount, 1234.56)
  assert.equal(res.body.currency, 'GBP')
  assert.equal(db.prepare('SELECT revenue_amount FROM campaign_leads WHERE id = ?').get(cl.id).revenue_amount, 123456)

  const negative = await client.patch(`/api/campaign-leads/${cl.id}/revenue`, { amount: -1 })
  assert.equal(negative.status, 422)
  assert.equal(negative.body.field, 'amount')
  assert.equal(negative.body.provided_value, -1)

  // Zero is a real value; null clears.
  assert.equal((await client.patch(`/api/campaign-leads/${cl.id}/revenue`, { amount: 0 })).body.amount, 0)
  assert.equal((await client.patch(`/api/campaign-leads/${cl.id}/revenue`, { amount: null })).body.amount, null)
})

test('a human intent correction records the actor and withdraws a stale draft', async () => {
  const cl = pairing(leads[1].id)
  db.prepare("INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body, status) VALUES (?, ?, ?, 'n2', 's', 'b', 'pending')")
    .run(owner.id, campaign.id, leads[1].id)

  const res = await client.patch(`/api/campaign-leads/${cl.id}/intent`, { intent: 'not interested' })
  assert.equal(res.status, 200)
  assert.equal(res.body.intent, 'not interested')

  const after = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(cl.id)
  assert.equal(after.intent_set_by, 'owner@example.com')
  assert.ok(after.intent_set_at)

  const draft = db.prepare('SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, leads[1].id)
  assert.equal(draft.status, 'declined')
  assert.match(draft.reviewed_by, /stale after reroute/)
})

test('an intent the playbook does not offer is a 422 naming the field', async () => {
  const cl = pairing(leads[1].id)
  const res = await client.patch(`/api/campaign-leads/${cl.id}/intent`, { intent: 'wants a pony' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'intent')
})

test('resume refuses a lead that is not paused, then honours a delay', async () => {
  const cl = pairing(leads[2].id)
  const refused = await client.patch(`/api/campaign-leads/${cl.id}/resume`, { delayDays: 1 })
  assert.equal(refused.status, 422)
  assert.equal(refused.body.field, 'id')

  db.prepare("UPDATE campaign_leads SET paused_at = ?, state = 'waiting' WHERE id = ?").run(new Date().toISOString(), cl.id)
  const delayed = await client.patch(`/api/campaign-leads/${cl.id}/resume`, { delayDays: 3 })
  assert.equal(delayed.status, 200)
  assert.equal(delayed.body.paused, true)
  const withDelay = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(cl.id)
  assert.ok(withDelay.resume_at)
  assert.ok(withDelay.paused_at, 'still paused until resume_at passes')

  const nowRes = await client.patch(`/api/campaign-leads/${cl.id}/resume`, { delayDays: 0 })
  assert.equal(nowRes.body.paused, false)
  const resumed = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(cl.id)
  assert.equal(resumed.paused_at, '')
  assert.equal(resumed.resume_at, '')
})

// ---- saved views ------------------------------------------------------------

test('a saved view runs through the same query path as ad-hoc filters', async () => {
  const created = await client.post('/api/inbox/views', {
    name: 'Startup replies', filters: { state: 'active', search: 'Startup', campaignId: [campaign.id] },
  })
  assert.equal(created.status, 200)

  const adhoc = await client.get(`/api/inbox/threads?state=active&search=Startup&campaignId=${campaign.id}`)
  const viaView = await client.get(`/api/inbox/threads?viewId=${created.body.id}`)
  assert.deepEqual(viaView.body.items.map((i) => i.threadKey), adhoc.body.items.map((i) => i.threadKey))
  assert.equal(viaView.body.items.length, 1)

  const dup = await client.post('/api/inbox/views', { name: 'Startup replies', filters: {} })
  assert.equal(dup.status, 422)
  assert.equal(dup.body.field, 'name')
})

test('a view whose campaign has gone is reported broken, never silently unfiltered', async () => {
  const created = await client.post('/api/inbox/views', { name: 'Doomed', filters: { campaignId: [sub.id] } })
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(sub.id)
  const views = await client.get('/api/inbox/views')
  const doomed = views.body.find((v) => v.id === created.body.id)
  assert.equal(doomed.is_broken, true)
  assert.deepEqual(doomed.broken, [`campaignId:${sub.id}`])
  await client.del(`/api/inbox/views/${created.body.id}`)
  // Put the subsequence back for the push test below.
  db.prepare("INSERT INTO campaigns (id, user_id, name, status, mailbox_id, mermaid, parent_campaign_id) VALUES (?, ?, 'Q3 nurture', 'draft', ?, ?, ?)")
    .run(sub.id, owner.id, mailbox.id, SUB_PLAYBOOK, campaign.id)
})

// ---- untracked replies ------------------------------------------------------

test('an unmatched reply attaches to a lead and leaves the queue', async () => {
  const info = db.prepare(
    `INSERT INTO unmatched_messages (workspace_id, mailbox_id, from_email, subject, body, thread_id, provider_message_id)
     VALUES (?, ?, 'nobody@nowhere.test', 'Who is this', 'Please stop', 'stray-1', 'p-1')`
  ).run(owner.id, mailbox.id)
  const id = Number(info.lastInsertRowid)

  const listed = await client.get('/api/inbox/unmatched')
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].body, '', 'bodies are withheld until asked for')
  assert.equal((await client.get('/api/inbox/unmatched?withBody=1')).body.items[0].body, 'Please stop')

  const attached = await client.post(`/api/inbox/unmatched/${id}/attach`, { leadId: leads[5].id, campaignId: campaign.id })
  assert.equal(attached.status, 200)
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(attached.body.messageId)
  assert.equal(message.direction, 'in')
  assert.equal(message.lead_id, leads[5].id)
  // Intent is left for the engine's own classifier — one code path decides it.
  assert.equal(message.intent, '')

  const row = db.prepare('SELECT * FROM unmatched_messages WHERE id = ?').get(id)
  assert.equal(row.status, 'attached')
  assert.equal(row.resolved_by, 'owner@example.com')
  assert.equal((await client.get('/api/inbox/unmatched')).body.items.length, 0)

  const twice = await client.post(`/api/inbox/unmatched/${id}/attach`, { leadId: leads[5].id })
  assert.equal(twice.status, 422)
})

test('an unmatched reply can be dismissed instead', async () => {
  const info = db.prepare(
    "INSERT INTO unmatched_messages (workspace_id, mailbox_id, from_email, subject, body) VALUES (?, ?, 'spam@nowhere.test', 'Hi', 'x')"
  ).run(owner.id, mailbox.id)
  const res = await client.post(`/api/inbox/unmatched/${Number(info.lastInsertRowid)}/dismiss`)
  assert.equal(res.status, 200)
  assert.equal(db.prepare('SELECT status FROM unmatched_messages WHERE id = ?').get(Number(info.lastInsertRowid)).status, 'dismissed')
})

// ---- reminders --------------------------------------------------------------

test('a reminder is set against a thread and overdue is derived, never stored', async () => {
  const past = new Date(Date.now() - 36e5).toISOString()
  const res = await client.post(`/api/inbox/threads/${threads[0].anchorId}/reminders`, { note: 'Chase this', remindAt: past })
  assert.equal(res.status, 200)
  assert.equal(res.body.is_overdue, true)
  assert.equal(Object.keys(db.prepare('SELECT * FROM lead_reminders WHERE id = ?').get(res.body.id)).includes('is_overdue'), false)

  const listed = await client.get('/api/reminders?due=overdue')
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].is_overdue, true)

  // Reminders show up in the shared list route rather than a parallel query.
  const state = await client.get('/api/inbox/threads?state=reminders')
  assert.deepEqual(state.body.items.map((i) => i.threadKey), ['thread-1'])
  assert.equal(state.body.items[0].is_overdue_reminder, true)

  const moved = await client.patch(`/api/reminders/${res.body.id}`, { remindAt: new Date(Date.now() + 864e5).toISOString() })
  assert.equal(moved.body.is_overdue, false)
  assert.equal((await client.del(`/api/reminders/${res.body.id}`)).status, 200)
})

test('a reminder anchored to a message outside the thread is a 422', async () => {
  const res = await client.post(`/api/inbox/threads/${threads[0].anchorId}/reminders`, {
    note: 'nope', remindAt: new Date().toISOString(), messageId: threads[3].anchorId,
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'messageId')
})

// ---- sending ----------------------------------------------------------------

test('nothing sends without the user OK — a reply refuses an unconfirmed request', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'out'").get(owner.id).n
  const res = await client.post(`/api/inbox/threads/${threads[3].anchorId}/reply`, { body: 'Great, thanks.' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'confirm')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND direction = 'out'").get(owner.id).n, before)
})

test('a confirmed reply goes through the normal send path and is marked manual', async () => {
  const res = await client.post(`/api/inbox/threads/${threads[3].anchorId}/reply`, { body: 'Great, thanks.', confirm: true })
  assert.equal(res.status, 200)
  const sent = db.prepare('SELECT * FROM messages WHERE id = ?').get(res.body.messageId)
  assert.equal(sent.manual_reply, 1)
  assert.equal(sent.direction, 'out')
  assert.equal(sent.to_email, 'lead4@acme.test')
  assert.ok(sent.tracking_token, 'the tracking token and opt-out footer ride along as usual')
})

test('a scheduled reply is queued, listed and cancellable', async () => {
  const at = new Date(Date.now() + 864e5).toISOString()
  const res = await client.post(`/api/inbox/threads/${threads[3].anchorId}/reply`, { body: 'Later.', confirm: true, sendAt: at })
  assert.equal(res.body.scheduled, true)

  const list = await client.get('/api/inbox/threads?state=scheduled')
  assert.equal(list.body.items.length, 1)
  assert.equal(list.body.items[0].rowType, 'message')
  assert.equal(list.body.items[0].send_status, 'queued')

  const status = await client.get(`/api/messages/${res.body.messageId}/status`)
  assert.equal(status.body.status, 'queued')
  assert.equal(status.body.terminal, false)
  assert.equal(status.body.scheduledAt, at)

  assert.equal((await client.del(`/api/scheduled/${res.body.messageId}`)).status, 200)
  assert.equal((await client.del(`/api/scheduled/${res.body.messageId}`)).status, 422)
  assert.equal((await client.get('/api/inbox/threads?state=scheduled')).body.total_count, 0)
})

test('a forward needs an OK, builds its chain server-side and records recipients', async () => {
  const unconfirmed = await client.post(`/api/threads/${threads[3].anchorId}/forward`, { to: 'colleague@example.com' })
  assert.equal(unconfirmed.status, 422)
  assert.equal(unconfirmed.body.field, 'confirm')

  const res = await client.post(`/api/threads/${threads[3].anchorId}/forward`, {
    to: 'colleague@example.com', cc: ['boss@example.com'], note: 'FYI', confirm: true,
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.recipients, 2)
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(res.body.messageId)
  assert.equal(row.forwarded_to, 'colleague@example.com,boss@example.com')
  assert.ok(row.forwarded_at)
  assert.match(row.body, /^FYI/)
  assert.match(row.body, /Opening line\./, 'the quoted chain comes from stored messages')
  assert.equal(row.tracking_token || '', '', 'a forward carries no tracking pixel')

  const bad = await client.post(`/api/threads/${threads[3].anchorId}/forward`, { to: 'not-an-address', confirm: true })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'to')
})

test('the sent list shows outbound messages with honest open data', async () => {
  const res = await client.get('/api/inbox/threads?state=sent')
  assert.equal(res.body.items[0].rowType, 'message')
  assert.ok(res.body.total_count >= 7)
  assert.equal(typeof res.body.items[0].stats.open_tracking_known, 'boolean')
})

// ---- suppression ------------------------------------------------------------

test('blocking a domain applies everywhere and offers no bypass', async () => {
  const blockedLead = seedLead(db, owner.id, 'target@blocked.test')
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, node_id, thread_id) VALUES (?, ?, 'waiting', 'n1', 'thread-blocked')")
    .run(campaign.id, blockedLead.id)
  const out = seedMessage(db, owner.id, {
    campaignId: campaign.id, leadId: blockedLead.id, mailboxId: mailbox.id, direction: 'out',
    thread_id: 'thread-blocked', subject: 'Hi', body: 'Hello.', from_email: 'sender@example.com', to_email: blockedLead.email,
  })
  db.prepare("INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body, status) VALUES (?, ?, ?, 'n2', 's', 'b', 'pending')")
    .run(owner.id, campaign.id, blockedLead.id)

  const bypass = await client.post('/api/blocked-domains', { domains: ['blocked.test'], ignoreBlockList: true })
  assert.equal(bypass.status, 422)
  assert.equal(bypass.body.field, 'ignoreBlockList')

  const res = await client.post('/api/blocked-domains', { domains: ['BLOCKED.test'] })
  assert.equal(res.status, 200)
  assert.equal(res.body.bypassAvailable, false)
  assert.deepEqual(res.body.blocked, ['blocked.test'])
  assert.equal(res.body.affectedLeads, 1)

  assert.equal(db.prepare('SELECT outcome FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, blockedLead.id).outcome, 'blocked')
  assert.equal(db.prepare('SELECT status FROM drafts WHERE lead_id = ?').get(blockedLead.id).status, 'declined')

  // The send paths refuse too, with no flag that reopens them.
  const reply = await client.post(`/api/inbox/threads/${out.id}/reply`, { body: 'hi', confirm: true })
  assert.equal(reply.status, 422)
  const forced = await client.post(`/api/inbox/threads/${out.id}/reply`, { body: 'hi', confirm: true, force: true })
  assert.equal(forced.status, 422)
  assert.equal(forced.body.field, 'force')
  const forward = await client.post(`/api/threads/${threads[3].anchorId}/forward`, { to: 'someone@blocked.test', confirm: true })
  assert.equal(forward.status, 422)

  // Re-blocking is idempotent, and the list and delete round-trip.
  await client.post('/api/blocked-domains', { domains: ['blocked.test'] })
  const list = await client.get('/api/blocked-domains')
  assert.equal(list.body.items.filter((r) => r.value === 'blocked.test').length, 1)
  assert.equal((await client.del(`/api/blocked-domains/${list.body.items[0].id}`)).status, 200)
})

// ---- subsequence ------------------------------------------------------------

test('pushing to a subsequence closes the source pairing rather than deleting it', async () => {
  const source = pairing(leads[5].id)
  const res = await client.post(`/api/inbox/threads/${threads[5].anchorId}/push-to-subsequence`, {
    subsequenceId: sub.id, startAfterSeconds: 3600,
  })
  assert.equal(res.status, 200)
  const closed = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(source.id)
  assert.ok(closed, 'the source pairing survives for Reports attribution')
  assert.equal(closed.state, 'stopped')
  assert.equal(closed.outcome, 'moved')

  const moved = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(res.body.campaignLeadId)
  assert.equal(moved.campaign_id, sub.id)
  assert.equal(moved.moved_from_campaign_id, campaign.id)
  assert.ok(moved.resume_at, 'the delay is held by the engine, not by a person')
})

test('a subsequence that is not a child of the source campaign is a 422', async () => {
  const orphan = seedCampaign(db, owner.id, 'Unrelated', mailbox.id)
  const res = await client.post(`/api/inbox/threads/${threads[4].anchorId}/push-to-subsequence`, { subsequenceId: orphan.id })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'subsequenceId')
})

test('a subsequence whose playbook does not parse refuses the push and moves nobody', async () => {
  // Readiness is checked before the lead is moved, not after. A campaign whose
  // diagram cannot be parsed cannot compose an email, so a lead pushed into it
  // would be taken out of a working campaign and stranded in a broken one —
  // neither being worked nor visibly stuck. The refusal names the diagram,
  // because that is the thing the user has to go and fix.
  const broken = seedCampaign(db, owner.id, 'Half-drawn nurture', mailbox.id)
  db.prepare('UPDATE campaigns SET parent_campaign_id = ?, mermaid = ? WHERE id = ?')
    .run(campaign.id, 'this is not a flowchart', broken.id)

  const before = db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(broken.id).n
  const res = await client.post(`/api/inbox/threads/${threads[4].anchorId}/push-to-subsequence`, { subsequenceId: broken.id })

  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'subsequenceId')
  assert.match(res.body.message, /playbook|diagram/i, 'and says what to fix')
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(broken.id).n,
    before,
    'nobody was moved',
  )
})

// ---- notes and tasks from a thread -----------------------------------------

test('a note and a task can be raised from a thread without naming the lead', async () => {
  const note = await client.post(`/api/inbox/threads/${threads[0].anchorId}/notes`, { text: 'Met at the conference.' })
  assert.equal(note.status, 200)
  assert.equal(note.body.lead_id, leads[0].id)
  assert.equal(note.body.author_email, 'owner@example.com')

  const task = await client.post(`/api/inbox/threads/${threads[0].anchorId}/tasks`, {
    name: 'Send the deck', dueAt: new Date(Date.now() - 1000).toISOString(),
  })
  assert.equal(task.status, 200)
  assert.equal(task.body.is_overdue, true)
  assert.equal(task.body.created_by, 'owner@example.com')
})

// ---- cross-workspace isolation ---------------------------------------------

test('every :id route 404s across a workspace boundary and leaks nothing', async () => {
  const cases = [
    ['GET', `/api/inbox/threads/${otherMessage.id}`],
    ['PATCH', `/api/inbox/threads/${otherMessage.id}`, { read: true }],
    ['GET', `/api/messages/${otherMessage.id}/status`],
    ['DELETE', `/api/scheduled/${otherMessage.id}`],
    ['POST', `/api/inbox/threads/${otherMessage.id}/reminders`, { note: 'x', remindAt: new Date().toISOString() }],
    ['POST', `/api/inbox/threads/${otherMessage.id}/reply`, { body: 'x', confirm: true }],
    ['POST', `/api/threads/${otherMessage.id}/forward`, { to: 'a@b.test', confirm: true }],
    ['POST', `/api/inbox/threads/${otherMessage.id}/notes`, { text: 'x' }],
    ['POST', `/api/inbox/threads/${otherMessage.id}/tasks`, { name: 'x' }],
    ['POST', `/api/inbox/threads/${otherMessage.id}/push-to-subsequence`, { subsequenceId: sub.id }],
    ['PATCH', `/api/campaign-leads/${otherPairing.id}/revenue`, { amount: 1 }],
    ['PATCH', `/api/campaign-leads/${otherPairing.id}/resume`, { delayDays: 0 }],
    ['PATCH', `/api/campaign-leads/${otherPairing.id}/intent`, { intent: 'interested' }],
    ['PATCH', `/api/campaign-leads/${otherPairing.id}/assignee`, { assignee: null }],
  ]
  for (const [method, url, body] of cases) {
    const res = method === 'GET' ? await client.get(url)
      : method === 'PATCH' ? await client.patch(url, body)
        : method === 'DELETE' ? await client.del(url)
          : await client.post(url, body)
    assert.equal(res.status, 404, `${method} ${url}`)
    assert.equal(res.body.error, 'not_found', `${method} ${url}`)
    // Nothing about the other workspace's record comes back.
    assert.equal(JSON.stringify(res.body).includes('them@other.test'), false, `${method} ${url}`)
    assert.equal(JSON.stringify(res.body).includes('Their'), false, `${method} ${url}`)
  }
})

test('the other workspace records are still untouched afterwards', async () => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(otherMessage.id)
  assert.equal(msg.read_at || '', '')
  assert.equal(msg.archived_at || '', '')
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(otherPairing.id)
  assert.equal(Math.round(cl.revenue_amount || 0), 0)
  assert.equal(cl.assigned_email || '', '')
})

test('rows from another workspace never appear in any state', async () => {
  for (const state of ['active', 'all', 'archived', 'assigned', 'important', 'reminders', 'scheduled', 'sent', 'snoozed', 'unread']) {
    const res = await client.get(`/api/inbox/threads?state=${encodeURIComponent(state)}`)
    assert.equal(res.status, 200, state)
    for (const item of res.body.items) {
      assert.notEqual(item.threadKey, 'other-thread', state)
      assert.notEqual(item.lead?.email, 'them@other.test', state)
    }
  }
})
