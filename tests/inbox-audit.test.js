// Inbox audit — the behaviours the inbox specs ask for, checked against what
// the database holds afterwards rather than against what the response said.
//
// This repo has shipped the same bug three times: cc and bcc validated and
// echoed back but never sent; a bulk write returning a hardcoded `ok: true` on
// every row while one transaction rolled all of them back; an importance score
// that did not exist. Every one of those had a green test asserting the
// response envelope. So the rule here is that a test reads `messages`,
// `campaign_leads` or `lead_reminders` after the call, and a test that would
// still pass if the feature did nothing has no business in this file.
//
// The four that matter most, and what each would miss if it were written the
// lazy way:
//
//   * a duplicate push to a subsequence — the old code was an
//     ON CONFLICT DO UPDATE that reset a *finished* run to `queued` and blanked
//     its outcome. Asserting the 422 alone would not have caught that; the
//     assertion that matters is that the completed pairing is still finished.
//   * cc and bcc on the Inbox reply route — read back off the written message
//     row, because that row is the only evidence anything was actually sent to
//     them.
//   * revenue — "nothing recorded", "recorded zero" and "cleared" are three
//     states that all leave `revenue_amount` at 0, so only
//     `revenue_updated_at` can tell them apart.
//   * bulk assignment — counts are compared against a fresh count of the rows
//     that actually carry the new assignee.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  setup, seedUser, seedLead, seedCampaign, seedMailbox, seedMessage, mount,
} from './helpers/parity-harness.js'

setup('inbox-audit')                   // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/inbox.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
const strangerClient = await mount(register, stranger)
test.after(() => Promise.all([client.close(), strangerClient.close()]))

// ---- fixtures ---------------------------------------------------------------

// A playbook that parses, because push-to-subsequence now refuses a target that
// cannot compose anything — a lead moved into a broken diagram is stranded.
const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro our product]
  A -- reply: interested --> B[Send: propose a call]
  B -- reply --> W([Won: call booked])
`

const mailbox = seedMailbox(db, owner.id, 'sender@example.com')
db.prepare('UPDATE mailboxes SET signature = ? WHERE id = ?')
  .run('— Dana\nHead of Ops, Acme', mailbox.id)

const campaign = seedCampaign(db, owner.id, 'Audit outbound', mailbox.id)
db.prepare('UPDATE campaigns SET mermaid = ?, status = ? WHERE id = ?').run(PLAYBOOK, 'running', campaign.id)

const sub = seedCampaign(db, owner.id, 'Audit nurture', mailbox.id)
db.prepare('UPDATE campaigns SET mermaid = ?, parent_campaign_id = ? WHERE id = ?').run(PLAYBOOK, campaign.id, sub.id)

// A colleague, so an assignee resolves to a real workspace member.
db.prepare("INSERT INTO team_members (owner_id, email, role, status) VALUES (?, 'mate@example.com', 'member', 'active')")
  .run(owner.id)

let seq = 0

// One outbound and one inbound message under a shared thread id, plus the
// campaign_leads pairing the triage routes hang off. Every group below builds
// its own conversations inside its own campaign so one group's rows can never
// change another group's list.
function conversation(campaignId, { email, node = 'A', leadStatus = 'active', reply = true } = {}) {
  seq += 1
  const address = email || `audit${seq}@acme.test`
  const lead = seedLead(db, owner.id, address, { first_name: `Lead${seq}` })
  if (leadStatus !== 'active') db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(leadStatus, lead.id)
  const thread = `audit-thread-${seq}`
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, node_id, thread_id) VALUES (?, ?, 'waiting', ?, ?)")
    .run(campaignId, lead.id, node, thread)
  const out = seedMessage(db, owner.id, {
    campaignId, leadId: lead.id, mailboxId: mailbox.id, direction: 'out',
    thread_id: thread, subject: `Hello ${seq}`, body: 'Opening line.', intent: '',
    from_email: mailbox.email, to_email: address,
  })
  const inbound = reply
    ? seedMessage(db, owner.id, {
      campaignId, leadId: lead.id, mailboxId: mailbox.id, direction: 'in',
      thread_id: thread, subject: `Re: Hello ${seq}`, body: 'Sounds good.',
      from_email: address, to_email: mailbox.email, intent: 'interested',
    })
    : null
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, lead.id)
  return { lead, thread, out, inbound, cl, anchorId: out.id }
}

const pairing = (campaignId, leadId) =>
  db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId)
const pairingCount = (campaignId, leadId) =>
  db.prepare('SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId).n
const outboundRows = (leadId) =>
  db.prepare("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY id").all(leadId)
const lastOutbound = (leadId) =>
  db.prepare("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(leadId)
const emails = (items) => items.map((i) => i.lead?.email).sort()

// =============================================================== priority 1 ==
// A duplicate push to a subsequence.

test('a lead already in the subsequence is refused, and their finished run is left exactly as it was', async () => {
  const c = conversation(campaign.id, { email: 'push-twice@acme.test' })

  const first = await client.post(`/api/inbox/threads/${c.inbound.id}/push-to-subsequence`, { subsequenceId: sub.id })
  assert.equal(first.status, 200, JSON.stringify(first.body))

  const moved = pairing(sub.id, c.lead.id)
  assert.ok(moved, 'the push created the pairing in the subsequence')
  assert.equal(moved.state, 'queued')

  // The subsequence runs its course. This is the state the old ON CONFLICT
  // DO UPDATE destroyed: it set `state` back to 'queued' and `outcome` to ''.
  db.prepare("UPDATE campaign_leads SET state = 'finished', outcome = 'won', node_id = 'W' WHERE id = ?").run(moved.id)

  const second = await client.post(`/api/inbox/threads/${c.inbound.id}/push-to-subsequence`, { subsequenceId: sub.id })
  assert.equal(second.status, 422, 'pushing the same lead in twice is refused')
  assert.equal(second.body.field, 'subsequenceId')

  const after = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(moved.id)
  assert.equal(after.state, 'finished', 'the completed run was not restarted')
  assert.equal(after.outcome, 'won', 'and its outcome was not blanked')
  assert.equal(after.node_id, 'W', 'and it did not lose its place in the playbook')
  assert.equal(pairingCount(sub.id, c.lead.id), 1, 'no second pairing was created')
})

test('a push closes the source pairing rather than deleting it, so the trail survives', async () => {
  const c = conversation(campaign.id, { email: 'push-source@acme.test' })
  const res = await client.post(`/api/inbox/threads/${c.inbound.id}/push-to-subsequence`, { subsequenceId: sub.id })
  assert.equal(res.status, 200)

  const source = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(c.cl.id)
  assert.ok(source, 'the source pairing still exists')
  assert.equal(source.state, 'stopped')
  assert.equal(source.outcome, 'moved')

  const moved = pairing(sub.id, c.lead.id)
  assert.equal(moved.moved_from_campaign_id, campaign.id, 'the move is recorded on the new pairing')
})

test('stopOnSourceReply lands on the moved lead, never on the whole campaign', async () => {
  const c = conversation(campaign.id, { email: 'push-stop@acme.test' })
  const before = db.prepare('SELECT stop_on_source_reply FROM campaigns WHERE id = ?').get(sub.id)

  const res = await client.post(`/api/inbox/threads/${c.inbound.id}/push-to-subsequence`, {
    subsequenceId: sub.id, stopOnSourceReply: true,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))

  // The original bug, still guarded: pushing one lead used to change the
  // setting for every other lead already in that subsequence.
  const after = db.prepare('SELECT stop_on_source_reply FROM campaigns WHERE id = ?').get(sub.id)
  assert.equal(after.stop_on_source_reply, before.stop_on_source_reply,
    'a single lead\'s move never changes a campaign-wide setting')

  const moved = pairing(sub.id, c.lead.id)
  assert.equal(moved.stop_on_source_reply, 1, 'the flag is on this lead\'s pairing')
  assert.ok(moved.moved_after_message_id >= c.inbound.id,
    'the reply that prompted the move is on the near side of the watermark')

  // A second lead pushed without the box ticked is unaffected by the first.
  const plain = conversation(campaign.id, { email: 'push-nostop@acme.test' })
  const plainRes = await client.post(`/api/inbox/threads/${plain.inbound.id}/push-to-subsequence`, {
    subsequenceId: sub.id,
  })
  assert.equal(plainRes.status, 200, JSON.stringify(plainRes.body))
  assert.equal(pairing(sub.id, plain.lead.id).stop_on_source_reply, 0)
})

// =============================================================== priority 2 ==
// cc and bcc on the reply route the Inbox actually calls.

test('cc and bcc reach the message row that was actually written', async () => {
  const c = conversation(campaign.id, { email: 'reply-copies@acme.test' })
  const before = outboundRows(c.lead.id).length

  const res = await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Happy to help.',
    confirm: true,
    cc: ['Colleague@Ours.test', 'boss@ours.test'],
    bcc: ['crm@ours.test'],
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))

  const rows = outboundRows(c.lead.id)
  assert.equal(rows.length, before + 1, 'exactly one message was written')
  const sent = rows[rows.length - 1]
  assert.equal(sent.cc_emails, 'colleague@ours.test, boss@ours.test', 'the copies are on the record, lowercased')
  assert.equal(sent.bcc_emails, 'crm@ours.test')
  assert.equal(sent.manual_reply, 1)
})

test('the thread view shows a reader who else received the reply', async () => {
  const c = conversation(campaign.id, { email: 'reply-visible@acme.test' })
  await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Noted.', confirm: true, cc: ['colleague@ours.test'],
  })
  const view = await client.get(`/api/inbox/threads/${c.inbound.id}`)
  const replied = view.body.messages.filter((m) => m.direction === 'out').pop()
  assert.equal(replied.cc_emails, 'colleague@ours.test')
})

test('no copies means empty columns, never the string "undefined"', async () => {
  const c = conversation(campaign.id, { email: 'reply-nocopies@acme.test' })
  await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, { body: 'Just you.', confirm: true })
  const sent = lastOutbound(c.lead.id)
  assert.equal(sent.cc_emails, '')
  assert.equal(sent.bcc_emails, '')
})

test('a scheduled reply carries its copies into the queued row, so they survive the wait', async () => {
  const c = conversation(campaign.id, { email: 'reply-later@acme.test' })
  const when = new Date(Date.now() + 3600_000).toISOString()

  const res = await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Later.', confirm: true, sendAt: when, cc: ['colleague@ours.test'], bcc: ['crm@ours.test'],
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))

  const parked = lastOutbound(c.lead.id)
  assert.equal(parked.send_status, 'queued')
  assert.ok(parked.scheduled_at, 'it is parked with a time')
  assert.equal(parked.cc_emails, 'colleague@ours.test', 'the copies were stored, not held in the request')
  assert.equal(parked.bcc_emails, 'crm@ours.test')
})

test('a cc address on the never-contact list refuses the reply and writes nothing', async () => {
  const c = conversation(campaign.id, { email: 'reply-blocked-cc@acme.test' })
  const blocked = await client.post('/api/blocked-domains', { domains: ['never-contact.test'] })
  assert.equal(blocked.status, 200)

  const before = outboundRows(c.lead.id).length
  const res = await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Hello', confirm: true, cc: ['someone@never-contact.test'],
  })

  assert.equal(res.status, 422, 'a refusal, not a 500 from the transport')
  assert.equal(res.body.field, 'cc', 'and it names the field the composer can highlight')
  assert.equal(outboundRows(c.lead.id).length, before,
    'nothing was written, so nothing was sent to anybody — not the lead either')
})

test('a bcc address on the never-contact list refuses the reply too', async () => {
  const c = conversation(campaign.id, { email: 'reply-blocked-bcc@acme.test' })
  const before = outboundRows(c.lead.id).length
  const res = await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Hello', confirm: true, bcc: ['quiet@never-contact.test'],
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'bcc')
  assert.equal(outboundRows(c.lead.id).length, before)
})

// ---- signature --------------------------------------------------------------

test('addSignature appends the mailbox signature exactly once', async () => {
  const c = conversation(campaign.id, { email: 'reply-signed@acme.test' })
  await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Thanks!', confirm: true, addSignature: true,
  })
  const sent = lastOutbound(c.lead.id)
  assert.equal(sent.body.split('Head of Ops, Acme').length - 1, 1, 'signed once')
  assert.match(sent.body, /^Thanks!/, 'and the typed reply is still what it opens with')
})

test('a reply that already quotes the signature is not signed twice', async () => {
  const c = conversation(campaign.id, { email: 'reply-signed-twice@acme.test' })
  await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Thanks!\n\n— Dana\nHead of Ops, Acme', confirm: true, addSignature: true,
  })
  assert.equal(lastOutbound(c.lead.id).body.split('Head of Ops, Acme').length - 1, 1)
})

test('without addSignature the body is stored exactly as written', async () => {
  const c = conversation(campaign.id, { email: 'reply-unsigned@acme.test' })
  await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, { body: 'Short and unsigned.', confirm: true })
  assert.equal(lastOutbound(c.lead.id).body, 'Short and unsigned.')
})

// ---- address parsing --------------------------------------------------------

test('the same address twice in cc is stored once', async () => {
  const c = conversation(campaign.id, { email: 'reply-dupe-cc@acme.test' })
  await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Hi', confirm: true, cc: ['colleague@ours.test', 'COLLEAGUE@ours.test'],
  })
  assert.equal(lastOutbound(c.lead.id).cc_emails, 'colleague@ours.test', 'de-duplicated, not sent twice')
})

test('a malformed cc address is refused by field name and nothing is written', async () => {
  const c = conversation(campaign.id, { email: 'reply-bad-cc@acme.test' })
  const before = outboundRows(c.lead.id).length
  const res = await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Hi', confirm: true, cc: ['not-an-address'],
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'cc')
  assert.equal(outboundRows(c.lead.id).length, before)
})

test('more copied recipients than the cap is refused before anything is sent', async () => {
  const c = conversation(campaign.id, { email: 'reply-many-cc@acme.test' })
  const before = outboundRows(c.lead.id).length
  const many = Array.from({ length: 26 }, (_, i) => `person${i}@ours.test`)
  const res = await client.post(`/api/inbox/threads/${c.inbound.id}/reply`, {
    body: 'Hi', confirm: true, cc: many,
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'cc')
  assert.equal(outboundRows(c.lead.id).length, before)
})

// =============================================================== priority 3 ==
// Revenue: three states that all leave `revenue_amount` at 0.

test('nothing recorded, a recorded zero and a cleared amount are three distinct states', async () => {
  const c = conversation(campaign.id, { email: 'revenue-states@acme.test' })

  // 1. Never touched.
  assert.equal(pairing(campaign.id, c.lead.id).revenue_updated_at, '', 'nothing recorded yet')
  let view = await client.get(`/api/inbox/threads/${c.inbound.id}`)
  assert.equal(view.body.campaignLead.revenue.recorded, false)

  // 2. A deliberate zero — "we won it and it was free" is an answer.
  const zero = await client.patch(`/api/campaign-leads/${c.cl.id}/revenue`, { amount: 0 })
  assert.equal(zero.status, 200)
  let row = pairing(campaign.id, c.lead.id)
  assert.equal(Math.round(row.revenue_amount), 0)
  assert.notEqual(row.revenue_updated_at, '', 'a recorded zero leaves a timestamp behind')
  assert.equal(row.revenue_updated_by, owner.email)
  view = await client.get(`/api/inbox/threads/${c.inbound.id}`)
  assert.equal(view.body.campaignLead.revenue.recorded, true, 'and reads back as recorded')
  assert.equal(view.body.campaignLead.revenue.amount_minor, 0)

  // 3. Cleared again. Same amount as (2) in the column, different answer.
  const cleared = await client.patch(`/api/campaign-leads/${c.cl.id}/revenue`, { amount: null })
  assert.equal(cleared.status, 200)
  row = pairing(campaign.id, c.lead.id)
  assert.equal(Math.round(row.revenue_amount), 0)
  assert.equal(row.revenue_updated_at, '', 'clearing takes the timestamp away again')
  assert.equal(row.revenue_updated_by, '')
  view = await client.get(`/api/inbox/threads/${c.inbound.id}`)
  assert.equal(view.body.campaignLead.revenue.recorded, false)
})

test('a fractional amount is stored as whole minor units and comes back unrounded', async () => {
  const c = conversation(campaign.id, { email: 'revenue-precision@acme.test' })
  const res = await client.patch(`/api/campaign-leads/${c.cl.id}/revenue`, { amount: 1234.56, currency: 'aud' })
  assert.equal(res.status, 200)

  const row = pairing(campaign.id, c.lead.id)
  assert.equal(row.revenue_amount, 123456, 'stored as integral minor units, so nothing drifts')
  assert.equal(row.revenue_currency, 'AUD')

  const view = await client.get(`/api/inbox/threads/${c.inbound.id}`)
  assert.equal(view.body.campaignLead.revenue.amount, 1234.56)
  assert.equal(view.body.campaignLead.revenue.currency, 'AUD')
})

test('a negative amount is refused and the recorded value is untouched', async () => {
  const c = conversation(campaign.id, { email: 'revenue-negative@acme.test' })
  await client.patch(`/api/campaign-leads/${c.cl.id}/revenue`, { amount: 500 })
  const before = pairing(campaign.id, c.lead.id)

  const res = await client.patch(`/api/campaign-leads/${c.cl.id}/revenue`, { amount: -1000 })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'amount')
  assert.equal(res.body.provided_value, -1000)

  const after = pairing(campaign.id, c.lead.id)
  assert.equal(after.revenue_amount, before.revenue_amount, 'the stored amount did not move')
  assert.equal(after.revenue_updated_at, before.revenue_updated_at)
})

test('a revenue amount on another workspace\'s pairing is a 404 and writes nothing', async () => {
  const c = conversation(campaign.id, { email: 'revenue-cross@acme.test' })
  const res = await strangerClient.patch(`/api/campaign-leads/${c.cl.id}/revenue`, { amount: 999 })
  assert.equal(res.status, 404)
  assert.equal(pairing(campaign.id, c.lead.id).revenue_updated_at, '', 'nothing was recorded')
})

// =============================================================== priority 4 ==
// Bulk assignment.

test('a bulk assignment\'s counts match the rows that actually carry the assignee', async () => {
  const bulk = seedCampaign(db, owner.id, 'Bulk assign', mailbox.id)
  db.prepare('UPDATE campaigns SET mermaid = ? WHERE id = ?').run(PLAYBOOK, bulk.id)
  const cs = [1, 2, 3].map((n) => conversation(bulk.id, { email: `bulk${n}@acme.test` }))
  const ids = cs.map((c) => c.cl.id)

  const res = await client.patch('/api/campaign-leads/assignee', { ids, assignee: 'mate@example.com' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.requested, 3)
  assert.equal(res.body.failed, 0)

  const reallyAssigned = db.prepare(
    `SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND assigned_email = 'mate@example.com'`
  ).get(bulk.id).n
  assert.equal(res.body.updated, reallyAssigned,
    '`updated` is a count of rows that changed, not the length of the input')
  assert.equal(reallyAssigned, 3)

  for (const c of cs) {
    const row = pairing(bulk.id, c.lead.id)
    assert.equal(row.assigned_email, 'mate@example.com')
    assert.equal(row.assigned_by, owner.email, 'the actor is recorded')
    assert.notEqual(row.assigned_at, '', 'and when')
  }
  for (const r of res.body.results) assert.equal(r.previous, '', 'none of them had an assignee before')
})

test('a reassignment reports the previous holder from the row, not from the request', async () => {
  const bulk = seedCampaign(db, owner.id, 'Bulk reassign', mailbox.id)
  const cs = [1, 2].map((n) => conversation(bulk.id, { email: `rebulk${n}@acme.test` }))
  const ids = cs.map((c) => c.cl.id)

  await client.patch('/api/campaign-leads/assignee', { ids, assignee: 'mate@example.com' })
  const res = await client.patch('/api/campaign-leads/assignee', { ids, assignee: owner.email })

  assert.equal(res.status, 200)
  for (const r of res.body.results) assert.equal(r.previous, 'mate@example.com')
  for (const c of cs) assert.equal(pairing(bulk.id, c.lead.id).assigned_email, owner.email)
})

test('clearing the assignee in bulk empties the column rather than writing "none"', async () => {
  const bulk = seedCampaign(db, owner.id, 'Bulk unassign', mailbox.id)
  const c = conversation(bulk.id, { email: 'unbulk@acme.test' })

  await client.patch('/api/campaign-leads/assignee', { ids: [c.cl.id], assignee: 'mate@example.com' })
  const res = await client.patch('/api/campaign-leads/assignee', { ids: [c.cl.id], assignee: 'none' })

  assert.equal(res.status, 200)
  const row = pairing(bulk.id, c.lead.id)
  assert.equal(row.assigned_email, '')
  assert.equal(row.assigned_by, '')
  assert.equal(row.assigned_at, '')
})

test('one id from another workspace refuses the whole call and leaves every other row alone', async () => {
  const bulk = seedCampaign(db, owner.id, 'Bulk cross', mailbox.id)
  const ours = [1, 2].map((n) => conversation(bulk.id, { email: `crossbulk${n}@acme.test` }))

  // A pairing that genuinely belongs to somebody else.
  const theirCampaign = seedCampaign(db, stranger.id, 'Their campaign')
  const theirLead = seedLead(db, stranger.id, 'theirs@elsewhere.test')
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state) VALUES (?, ?, 'waiting')")
    .run(theirCampaign.id, theirLead.id)
  const theirs = pairing(theirCampaign.id, theirLead.id)

  const res = await client.patch('/api/campaign-leads/assignee', {
    ids: [ours[0].cl.id, theirs.id, ours[1].cl.id],
    assignee: 'mate@example.com',
  })

  assert.equal(res.status, 404, 'an id outside the workspace is not a per-row failure to report back')
  for (const c of ours) {
    assert.equal(pairing(bulk.id, c.lead.id).assigned_email, '', 'and nothing was written for the others')
  }
  assert.equal(db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(theirs.id).assigned_email, '')
})

test('an assignee outside the workspace is refused and nobody is assigned', async () => {
  const bulk = seedCampaign(db, owner.id, 'Bulk outsider', mailbox.id)
  const c = conversation(bulk.id, { email: 'outsider@acme.test' })
  const res = await client.patch('/api/campaign-leads/assignee', {
    ids: [c.cl.id], assignee: 'nobody@elsewhere.test',
  })
  assert.equal(res.status, 404)
  assert.equal(pairing(bulk.id, c.lead.id).assigned_email, '')
})

// ============================================================ reply age =====

test('reply age is reported in fractions of an hour, not rounded to the nearest one', async () => {
  const ages = seedCampaign(db, owner.id, 'Reply ages', mailbox.id)
  const stale = conversation(ages.id, { email: 'age-stale@acme.test' })
  const fresh = conversation(ages.id, { email: 'age-fresh@acme.test' })

  // SQLite writes `created_at` as 'YYYY-MM-DD HH:MM:SS' with no zone, which is
  // the format the age calculation reads back.
  const sqliteTime = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ')
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(sqliteTime(2.5 * 3600_000), stale.inbound.id)
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(sqliteTime(0.5 * 3600_000), fresh.inbound.id)

  const res = await client.get(`/api/inbox/threads?state=all&campaignId=${ages.id}&limit=20`)
  assert.equal(res.status, 200)
  const byEmail = Object.fromEntries(res.body.items.map((i) => [i.lead.email, i]))

  assert.equal(byEmail['age-stale@acme.test'].reply_age_hours, 2.5,
    'two and a half hours is 2.5, not 3')
  assert.equal(byEmail['age-fresh@acme.test'].reply_age_hours, 0.5,
    'and half an hour is 0.5, not 0 — whole-hour rounding erased everything under an hour')
})

// ========================================================= email status =====
// The seven engagement predicates, on the conversation folders. (The message
// folders refuse the filter outright; tests/agent-followup.test.js covers that.)

const statusCampaign = seedCampaign(db, owner.id, 'Engagement', mailbox.id)
const suppressedCampaign = seedCampaign(db, owner.id, 'Suppressed engagement', mailbox.id)

const accepted = conversation(statusCampaign.id, { email: 'st-accepted@acme.test', reply: false })
const notReplied = conversation(statusCampaign.id, { email: 'st-notreplied@acme.test', reply: false })
const clicked = conversation(statusCampaign.id, { email: 'st-clicked@acme.test', reply: false })
const replied = conversation(statusCampaign.id, { email: 'st-replied@acme.test' })
db.prepare("UPDATE messages SET opened_at = '2026-01-01 10:00:00' WHERE id = ?").run(notReplied.out.id)
db.prepare("UPDATE messages SET opened_at = '2026-01-01 10:00:00', clicked_at = '2026-01-01 10:05:00' WHERE id = ?")
  .run(clicked.out.id)

const gone = conversation(suppressedCampaign.id, { email: 'st-gone@acme.test', reply: false, leadStatus: 'unsubscribed' })
const bounced = conversation(suppressedCampaign.id, { email: 'st-bounced@acme.test', reply: false, leadStatus: 'bounced' })

const byStatus = async (campaignId, status) => {
  const res = await client.get(`/api/inbox/threads?state=all&campaignId=${campaignId}&limit=20&emailStatus=${encodeURIComponent(status)}`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return emails(res.body.items)
}

test('Replied selects only the conversations that have an inbound message', async () => {
  assert.deepEqual(await byStatus(statusCampaign.id, 'Replied'), ['st-replied@acme.test'])
})

test('Not Replied means opened with no reply, not merely unanswered', async () => {
  // st-accepted has no reply either, but it was never opened — the spec is
  // explicit that this segment is the people who read it and said nothing.
  assert.deepEqual(await byStatus(statusCampaign.id, 'Not Replied'),
    ['st-clicked@acme.test', 'st-notreplied@acme.test'])
})

test('Opened and Clicked select on the engagement recorded against the thread', async () => {
  assert.deepEqual(await byStatus(statusCampaign.id, 'Opened'),
    ['st-clicked@acme.test', 'st-notreplied@acme.test'])
  assert.deepEqual(await byStatus(statusCampaign.id, 'Clicked'), ['st-clicked@acme.test'])
})

test('Accepted is a thread that went out and never came back in any form', async () => {
  assert.deepEqual(await byStatus(statusCampaign.id, 'Accepted'), ['st-accepted@acme.test'])
})

test('two statuses OR together into one segment rather than two requests', async () => {
  const res = await client.get(
    `/api/inbox/threads?state=all&campaignId=${statusCampaign.id}&limit=20&emailStatus=Opened,Replied`)
  assert.equal(res.status, 200)
  assert.deepEqual(emails(res.body.items),
    ['st-clicked@acme.test', 'st-notreplied@acme.test', 'st-replied@acme.test'])
})

test('Unsubscribed and Bounced follow the lead record, not the message', async () => {
  assert.deepEqual(await byStatus(suppressedCampaign.id, 'Unsubscribed'), ['st-gone@acme.test'])
  assert.deepEqual(await byStatus(suppressedCampaign.id, 'Bounced'), ['st-bounced@acme.test'])
})

test('an unknown engagement status is a 422 naming the valid values, never an empty list', async () => {
  const res = await client.get(`/api/inbox/threads?state=all&campaignId=${statusCampaign.id}&emailStatus=Delivered`)
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'emailStatus')
  assert.match(res.body.message, /Not Replied/)
})

test('the status a row reports is the one the filter would have matched it on', async () => {
  const res = await client.get(`/api/inbox/threads?state=all&campaignId=${statusCampaign.id}&limit=20`)
  const byEmail = Object.fromEntries(res.body.items.map((i) => [i.lead.email, i.email_status]))
  assert.equal(byEmail['st-accepted@acme.test'], 'Accepted')
  assert.equal(byEmail['st-notreplied@acme.test'], 'Not Replied')
  assert.equal(byEmail['st-clicked@acme.test'], 'Clicked')
  assert.equal(byEmail['st-replied@acme.test'], 'Replied')

  const sup = await client.get(`/api/inbox/threads?state=all&campaignId=${suppressedCampaign.id}&limit=20`)
  const supByEmail = Object.fromEntries(sup.body.items.map((i) => [i.lead.email, i.email_status]))
  assert.equal(supByEmail['st-gone@acme.test'], 'Unsubscribed')
  assert.equal(supByEmail['st-bounced@acme.test'], 'Bounced')
})

// =============================================== saved views on a node ======

test('a view saved on a playbook node empties itself as leads advance past it', async () => {
  const viewCampaign = seedCampaign(db, owner.id, 'Node view', mailbox.id)
  const staying = conversation(viewCampaign.id, { email: 'node-stay@acme.test', node: 'n1' })
  const advancing = conversation(viewCampaign.id, { email: 'node-move@acme.test', node: 'n1' })

  const created = await client.post('/api/inbox/views', {
    name: 'Sitting at n1',
    filters: { state: 'all', campaignId: String(viewCampaign.id), nodeId: 'n1' },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))

  const before = await client.get(`/api/inbox/threads?viewId=${created.body.id}&limit=20`)
  assert.equal(before.status, 200)
  assert.deepEqual(emails(before.body.items), ['node-move@acme.test', 'node-stay@acme.test'])

  // The engine moves one lead on. Nobody edits the view.
  db.prepare("UPDATE campaign_leads SET node_id = 'n2' WHERE id = ?").run(advancing.cl.id)

  const after = await client.get(`/api/inbox/threads?viewId=${created.body.id}&limit=20`)
  assert.deepEqual(emails(after.body.items), ['node-stay@acme.test'],
    'the advanced lead left the view without the view being touched')
  assert.equal(after.body.total_count, 1, 'and the count agrees with the list')
  void staying
})

// ================================================ per-state filter ceilings ==

test('the sent folder honours its own wider campaign ceiling', async () => {
  const many = Array.from({ length: 16 }, (_, i) => seedCampaign(db, owner.id, `Ceiling ${i}`, mailbox.id))
  const six = many.slice(0, 6).map((c) => c.id).join(',')
  const sixteen = many.map((c) => c.id).join(',')

  const replies = await client.get(`/api/inbox/threads?state=active&campaignId=${six}`)
  assert.equal(replies.status, 422, 'the replies folder still stops at five')
  assert.equal(replies.body.field, 'campaignId')
  assert.equal(replies.body.max_allowed, 5)
  assert.equal(replies.body.provided_count, 6)

  const sent = await client.get(`/api/inbox/threads?state=sent&campaignId=${six}`)
  assert.equal(sent.status, 200, 'but the sent folder accepts six, as its spec documents')

  const tooMany = await client.get(`/api/inbox/threads?state=sent&campaignId=${sixteen}`)
  assert.equal(tooMany.status, 422)
  assert.equal(tooMany.body.max_allowed, 15, 'and names its own maximum, not the replies one')
  assert.equal(tooMany.body.provided_count, 16)
})

// ==================================================== reminders =============
// The only group in this file that writes `lead_reminders`, so the unfiltered
// reminder list below is exactly these rows.

const reminderCampaign = seedCampaign(db, owner.id, 'Reminders', mailbox.id)
const reminderThreadA = conversation(reminderCampaign.id, { email: 'rem-a@acme.test' })
const reminderThreadB = conversation(reminderCampaign.id, { email: 'rem-b@acme.test' })

const OVERDUE = new Date(Date.now() - 3600_000).toISOString()
const SOON = new Date(Date.now() + 3600_000).toISOString()
const LATER = new Date(Date.now() + 2 * 3600_000).toISOString()

test('seed reminders', async () => {
  // Deliberately inserted out of time order, so an id-ordered list and a
  // time-ordered one cannot accidentally agree.
  const soon = await client.post(`/api/inbox/threads/${reminderThreadA.inbound.id}/reminders`,
    { note: 'in an hour', remindAt: SOON })
  assert.equal(soon.status, 200, JSON.stringify(soon.body))
  const later = await client.post(`/api/inbox/threads/${reminderThreadB.inbound.id}/reminders`,
    { note: 'in two hours', remindAt: LATER })
  assert.equal(later.status, 200)
  const overdue = await client.post(`/api/inbox/threads/${reminderThreadA.inbound.id}/reminders`,
    { note: 'already late', remindAt: OVERDUE })
  assert.equal(overdue.status, 200)

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_reminders WHERE workspace_id = ?').get(owner.id).n, 3)
})

test('the reminder list opens on what you are already late on', async () => {
  const res = await client.get('/api/reminders?limit=20')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items.map((r) => r.note), ['already late', 'in an hour', 'in two hours'])
  assert.equal(res.body.items[0].is_overdue, true, 'and says so, derived at read time')
  assert.equal(res.body.items[1].is_overdue, false)
})

test('reminder_desc reverses the order exactly', async () => {
  const asc = await client.get('/api/reminders?limit=20&sort=reminder_asc')
  const desc = await client.get('/api/reminders?limit=20&sort=reminder_desc')
  assert.equal(desc.status, 200)
  assert.deepEqual(desc.body.items.map((r) => r.note), asc.body.items.map((r) => r.note).reverse())
})

test('paging a reminder list keyed on time skips nobody and repeats nobody', async () => {
  // The cursor used to be `id > ?` whatever the order, and these three rows were
  // inserted in an order that disagrees with their times — which is the normal
  // case, because people set reminders for whenever suits them.
  for (const sort of ['reminder_asc', 'reminder_desc']) {
    const seen = []
    let cursor = null
    for (let pageNo = 0; pageNo < 5; pageNo++) {
      const qs = `/api/reminders?limit=1&sort=${sort}${cursor ? `&cursor=${cursor}` : ''}`
      const res = await client.get(qs)
      assert.equal(res.status, 200)
      seen.push(...res.body.items.map((r) => r.note))
      if (!res.body.hasMore) break
      cursor = res.body.nextCursor
    }
    const expected = sort === 'reminder_asc'
      ? ['already late', 'in an hour', 'in two hours']
      : ['in two hours', 'in an hour', 'already late']
    assert.deepEqual(seen, expected, `${sort} paged one at a time`)
  }
})

test('the reminders folder is ordered by when the reminder falls due, not by the last reply', async () => {
  const res = await client.get(`/api/inbox/threads?state=reminders&campaignId=${reminderCampaign.id}&limit=20`)
  assert.equal(res.status, 200)
  assert.equal(res.body.sort, 'reminder_asc', 'the default for a daily review')
  // Thread A holds the overdue reminder, thread B the one two hours out.
  assert.deepEqual(res.body.items.map((i) => i.lead.email), ['rem-a@acme.test', 'rem-b@acme.test'])
  assert.equal(res.body.items[0].is_overdue_reminder, true)
})

test('cancelling a reminder removes the row and records who did it', async () => {
  const row = db.prepare("SELECT * FROM lead_reminders WHERE note = 'in two hours'").get()
  const before = db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get('reminder_cancelled').n

  const res = await client.del(`/api/reminders/${row.id}`)
  assert.equal(res.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_reminders WHERE id = ?').get(row.id).n, 0)

  const after = db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get('reminder_cancelled')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get('reminder_cancelled').n, before + 1)
  assert.match(after.detail, /owner@example\.com/)
})

test('POST /api/inbox/sync is workspace-scoped and succeeds with no OAuth mailboxes', async () => {
  const res = await client.post('/api/inbox/sync')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.mailboxes, 0)
  assert.equal(res.body.attached, 0)
  assert.equal(res.body.untracked, 0)

  // Another workspace must not see this call fail just because it has no senders.
  const other = await strangerClient.post('/api/inbox/sync')
  assert.equal(other.status, 200)
  assert.equal(other.body.mailboxes, 0)
})
