// Sending controls outside the playbook — Docs/utilities/*.
//
// The cases the two specs single out: a pasted blob of mixed addresses, domains
// and browser-bar URLs coming out normalised and de-duplicated with every
// malformed line reported rather than dropped; a workspace's own sending domain
// refused; paging and search; and — the point of the whole category — that
// `sendSingleEmail` parks a draft instead of sending while approvals are on,
// and refuses a blocked domain or an unsubscribed lead with nothing that can
// override it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, mount } from './helpers/parity-harness.js'

setup('utilities')                  // MUST precede any ../server import
const { db } = await import('../server/db.js')
const { register, sendSingleEmail } = await import('../server/parity/utilities.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// Fixtures. The owner sends from harry.test; the stranger's rows exist only to
// be refused.
const box = seedMailbox(db, owner.id, 'outreach@harry.test')
const lead = seedLead(db, owner.id, 'ada@acme.test')
const campaign = seedCampaign(db, owner.id, 'Q3 outbound', box.id)
const foreignBox = seedMailbox(db, stranger.id, 'foreign@elsewhere.test')

const blockRows = () => db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ? ORDER BY id').all(owner.id)
const draftsFor = (leadId) => db.prepare('SELECT * FROM drafts WHERE user_id = ? AND lead_id = ?').all(owner.id, leadId)
const messagesTo = (address) => db.prepare('SELECT * FROM messages WHERE to_email = ?').all(address)

// ---- POST /api/block-list -----------------------------------------------------

test('a pasted blob is split, normalised and stored, with the malformed line reported', async () => {
  const res = await client.post('/api/block-list', {
    domain_block_list:
      'HTTPS://WWW.Competitor.com/pricing?ref=1\n' +
      'spam@Vendor.test, other.co.uk\n' +
      'notadomain',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.addedCount, 3)
  assert.equal(res.body.message, '3 entries added to block list')

  const values = res.body.added.map((r) => r.value)
  assert.deepEqual(values, ['competitor.com', 'spam@vendor.test', 'other.co.uk'])
  // A URL out of the browser bar is a domain; an address stays an address.
  assert.deepEqual(res.body.added.map((r) => r.isDomain), [true, false, true])
  assert.equal(res.body.added[0].sourceLabel, 'Added by you')

  // Reported, not silently dropped.
  assert.equal(res.body.rejectedCount, 1)
  assert.equal(res.body.rejected[0].input, 'notadomain')
  assert.equal(res.body.rejected[0].reason, 'malformed')
})

test('an array, a blob and www./https:// spellings all collapse to one row', async () => {
  const res = await client.post('/api/block-list', {
    domain_block_list: ['competitor.com', 'www.competitor.com', 'https://competitor.com/'],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.addedCount, 0)
  assert.equal(res.body.duplicateCount, 3)
  assert.equal(res.body.duplicates[0].reason, 'already_blocked')       // already stored
  assert.equal(res.body.duplicates[1].reason, 'duplicate_in_request')  // repeated in the paste
  assert.equal(blockRows().filter((r) => r.value === 'competitor.com').length, 1)
})

test('domain_block_list of the wrong type is a 422 naming the field', async () => {
  const res = await client.post('/api/block-list', { domain_block_list: 42 })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'domain_block_list')
  const missing = await client.post('/api/block-list', {})
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'domain_block_list')
})

test('a workspace cannot block its own sending domain or mailbox', async () => {
  const res = await client.post('/api/block-list', {
    domain_block_list: ['harry.test', 'outreach@harry.test', 'someoneelse@harry.test'],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.rejectedCount, 2)
  assert.deepEqual(res.body.rejected.map((r) => r.reason), ['own_sending_domain', 'own_sending_domain'])
  assert.match(res.body.rejected[0].message, /replies/)
  // A different person at that domain is still blockable.
  assert.equal(res.body.addedCount, 1)
  assert.equal(res.body.added[0].value, 'someoneelse@harry.test')
})

// ---- GET /api/block-list ------------------------------------------------------

test('the list pages, refuses a limit above 1000, and searches both forms', async () => {
  await client.post('/api/block-list', { domain_block_list: 'one.test\ntwo.test\nthree.test' })

  const first = await client.get('/api/block-list?limit=2&offset=0')
  assert.equal(first.status, 200)
  assert.equal(first.body.data.length, 2)
  assert.equal(first.body.hasMore, true)
  assert.equal(first.body.limit, 2)
  assert.equal(first.body.total, blockRows().length)

  const second = await client.get(`/api/block-list?limit=2&offset=${first.body.nextOffset}`)
  assert.equal(second.status, 200)
  assert.notEqual(second.body.data[0].id, first.body.data[0].id)

  const tooMany = await client.get('/api/block-list?limit=5000')
  assert.equal(tooMany.status, 422)
  assert.equal(tooMany.body.field, 'limit')

  // Search matches a bare domain and an address at that domain, and nothing else.
  const hits = await client.get('/api/block-list?search=vendor.test')
  assert.deepEqual(hits.body.data.map((r) => r.emailOrDomain), ['spam@vendor.test'])
  const none = await client.get('/api/block-list?search=nothing-like-this')
  assert.deepEqual(none.body.data, [])
  assert.equal(none.body.total, 0)
})

test('another workspace\'s entries are invisible and undeletable', async () => {
  db.prepare('INSERT INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (?, ?, 1, ?)')
    .run(stranger.id, 'stranger-only.test', 'manual')
  const foreign = db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ?').get(stranger.id)

  const list = await client.get('/api/block-list?limit=1000')
  assert.equal(list.body.data.some((r) => r.value === 'stranger-only.test'), false)

  const del = await client.del(`/api/block-list/${foreign.id}`)
  assert.equal(del.status, 404)
  assert.ok(db.prepare('SELECT 1 FROM blocked_domains WHERE id = ?').get(foreign.id), 'the stranger\'s row survives')
})

test('removal is idempotent-by-404 and names what becomes contactable again', async () => {
  const entry = blockRows().find((r) => r.value === 'other.co.uk')
  const del = await client.del(`/api/block-list/${entry.id}`)
  assert.equal(del.status, 200)
  assert.match(del.body.message, /other\.co\.uk/)
  const again = await client.del(`/api/block-list/${entry.id}`)
  assert.equal(again.status, 404)

  const trail = db.prepare("SELECT * FROM events WHERE user_id = ? AND type = 'block_list_removed' ORDER BY id DESC").get(owner.id)
  assert.match(trail.detail, /contacted again/)
})

// ---- sendSingleEmail: nothing sends without the user's OK ---------------------

test('parks a draft instead of sending while approvals are on', async () => {
  const result = await sendSingleEmail(owner.id, {
    fromMailboxId: box.id, leadId: lead.id, campaignId: campaign.id,
    subject: 'Following up', body: 'As promised, here are the numbers.',
  })
  assert.equal(result.status, 'parked')
  assert.equal(result.sent, false)
  assert.ok(result.draftId)

  const parked = draftsFor(lead.id)
  assert.equal(parked.length, 1)
  assert.equal(parked[0].status, 'pending')
  assert.equal(parked[0].subject, 'Following up')
  assert.equal(messagesTo('ada@acme.test').length, 0, 'nothing left the mailbox')

  // A second attempt joins the existing draft rather than colliding with the
  // one-open-draft index or queuing a duplicate.
  const again = await sendSingleEmail(owner.id, {
    fromMailboxId: box.id, leadId: lead.id, campaignId: campaign.id,
    subject: 'Following up again', body: 'Still here.',
  })
  assert.equal(again.status, 'parked')
  assert.equal(again.alreadyPending, true)
  assert.equal(draftsFor(lead.id).length, 1)
})

test('a caller-initiated send with no campaign or lead fails closed, naming the field', async () => {
  await assert.rejects(
    () => sendSingleEmail(owner.id, {
      fromMailboxId: box.id, to: 'someone@nowhere.test', subject: 'Hi', body: 'Hello',
    }),
    (err) => {
      assert.equal(err.status, 422)
      assert.equal(err.body.field, 'campaignId')
      return true
    }
  )
  assert.equal(messagesTo('someone@nowhere.test').length, 0)
})

// ---- sendSingleEmail: suppression is unconditional ----------------------------

test('a blocked domain is refused, subdomains included, with no bypass available', async () => {
  await client.post('/api/block-list', { domain_block_list: ['blocked.test'] })
  const blockedLead = seedLead(db, owner.id, 'ana@mail.blocked.test')
  const before = db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n

  const result = await sendSingleEmail(owner.id, {
    fromMailboxId: box.id, leadId: blockedLead.id, campaignId: campaign.id,
    subject: 'Hello', body: 'Hello there.',
    // No override exists: these are not options the function has.
    ignoreBlockList: true, ignore_global_block_list: true, force: true, skipApproval: true,
  })
  assert.equal(result.status, 'refused')
  assert.equal(result.reason, 'blocked')
  assert.match(result.message, /never-contact list \(blocked\.test\)/)

  // The blocked lead never even produces a draft to clutter the Inbox.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, before)
  assert.equal(messagesTo('ana@mail.blocked.test').length, 0)
  const trail = db.prepare("SELECT * FROM events WHERE user_id = ? AND type = 'send_refused' ORDER BY id DESC").get(owner.id)
  assert.match(trail.detail, /ana@mail\.blocked\.test/)
})

test('system mail cannot bypass suppression either', async () => {
  const result = await sendSingleEmail(owner.id, {
    fromMailboxId: box.id, to: 'someone@blocked.test',
    subject: 'Your invite', body: 'Join the workspace.', system: true,
  })
  assert.equal(result.status, 'refused')
  assert.equal(result.reason, 'blocked')
  assert.equal(messagesTo('someone@blocked.test').length, 0)
})

test('an unsubscribed lead is refused outright', async () => {
  const gone = seedLead(db, owner.id, 'grace@acme.test')
  db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(gone.id)
  const result = await sendSingleEmail(owner.id, {
    fromMailboxId: box.id, leadId: gone.id, campaignId: campaign.id,
    subject: 'One more thing', body: 'Just checking in.', force: true,
  })
  assert.equal(result.status, 'refused')
  assert.equal(result.reason, 'unsubscribed')
  assert.equal(draftsFor(gone.id).length, 0)
  assert.equal(messagesTo('grace@acme.test').length, 0)
})

test('the mailbox daily limit is refused with the time it comes back', async () => {
  const tired = seedMailbox(db, owner.id, 'tired@harry.test')
  db.prepare('UPDATE mailboxes SET daily_limit = 0 WHERE id = ?').run(tired.id)
  const target = seedLead(db, owner.id, 'alan@acme.test')

  const result = await sendSingleEmail(owner.id, {
    fromMailboxId: tired.id, leadId: target.id, campaignId: campaign.id,
    subject: 'Hello', body: 'Hello there.',
  })
  assert.equal(result.status, 'refused')
  assert.equal(result.reason, 'daily_limit')
  assert.ok(result.until, 'says when it becomes possible')
  assert.equal(draftsFor(target.id).length, 0)
})

// ---- sendSingleEmail: the caller's mistakes -----------------------------------

test('a mailbox in another workspace is a 404 that echoes nothing', async () => {
  await assert.rejects(
    () => sendSingleEmail(owner.id, {
      fromMailboxId: foreignBox.id, leadId: lead.id, campaignId: campaign.id,
      subject: 'Hi', body: 'Hello',
    }),
    (err) => {
      assert.equal(err.status, 404)
      assert.equal(err.body.error, 'not_found')
      assert.doesNotMatch(JSON.stringify(err.body), /elsewhere\.test/)
      return true
    }
  )
})

test('a missing sender or body is a 422 naming the field', async () => {
  await assert.rejects(
    () => sendSingleEmail(owner.id, { leadId: lead.id, subject: 'Hi', body: 'Hello' }),
    (err) => (assert.equal(err.status, 422), assert.equal(err.body.field, 'fromEmail'), true)
  )
  await assert.rejects(
    () => sendSingleEmail(owner.id, { fromMailboxId: box.id, leadId: lead.id, subject: 'Hi' }),
    (err) => (assert.equal(err.status, 422), assert.equal(err.body.field, 'body'), true)
  )
})

test('attachments are validated before anything is sent', async () => {
  const bad = { filename: 'payload.exe', mimeType: 'application/x-msdownload', content: 'AAAA' }
  await assert.rejects(
    () => sendSingleEmail(owner.id, {
      fromMailboxId: box.id, leadId: lead.id, campaignId: campaign.id,
      subject: 'Hi', body: 'Hello', attachments: [bad],
    }),
    (err) => (assert.equal(err.status, 422), assert.equal(err.body.field, 'attachments'), true)
  )

  const huge = { filename: 'big.pdf', mimeType: 'application/pdf', content: Buffer.alloc(11 * 1024 * 1024).toString('base64') }
  await assert.rejects(
    () => sendSingleEmail(owner.id, {
      fromMailboxId: box.id, leadId: lead.id, campaignId: campaign.id,
      subject: 'Hi', body: 'Hello', attachments: [huge],
    }),
    (err) => (assert.equal(err.status, 422), assert.equal(err.body.field, 'attachments'), true)
  )

  // A well-formed attachment is refused honestly rather than dropped: neither
  // provider path can carry one yet, and a send that quietly loses the file
  // would be worse than one that says so.
  const fine = { filename: 'terms.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4').toString('base64') }
  await assert.rejects(
    () => sendSingleEmail(owner.id, {
      fromMailboxId: box.id, leadId: lead.id, campaignId: campaign.id,
      subject: 'Hi', body: 'Hello', attachments: [fine],
    }),
    (err) => (assert.equal(err.status, 501), assert.equal(err.body.field, 'attachments'), true)
  )

  // An empty array is not an attachment and must not be treated as one.
  const empty = await sendSingleEmail(owner.id, {
    fromMailboxId: box.id, leadId: lead.id, campaignId: campaign.id,
    subject: 'Hi', body: 'Hello', attachments: [],
  })
  assert.equal(empty.status, 'parked')
})

// ---- sendSingleEmail: what actually sending looks like ------------------------

test('with approvals off the send goes through the shared mailer path', async () => {
  // A second workspace, so turning the rule off here cannot leak into the
  // owner's tests above.
  db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(stranger.id)
  const theirLead = seedLead(db, stranger.id, 'ada@theirs.test')
  const theirCampaign = seedCampaign(db, stranger.id, 'Their campaign', foreignBox.id)

  const result = await sendSingleEmail(stranger.id, {
    fromMailboxId: foreignBox.id, leadId: theirLead.id, campaignId: theirCampaign.id,
    subject: 'Hello', body: 'Hello there.',
  })
  assert.equal(result.status, 'sent')
  assert.ok(result.messageId)
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.messageId)
  assert.equal(message.campaign_id, theirCampaign.id)
  assert.equal(message.direction, 'out')
  assert.ok(message.tracking_token, 'carries the tracking furniture campaign mail carries')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE user_id = ?').get(stranger.id).n, 0)
})

test('system mail with no campaign sends and is recorded against a null campaign', async () => {
  const result = await sendSingleEmail(owner.id, {
    fromEmail: 'outreach@harry.test', to: 'teammate@harry-team.test',
    subject: 'You are invited', body: 'Join the workspace.', system: true,
  })
  assert.equal(result.status, 'sent')
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.messageId)
  assert.equal(message.campaign_id, null)
  assert.equal(message.from_email, 'outreach@harry.test')
  assert.ok(message.tracking_token)
  // It counts against the mailbox's allowance like any other send.
  assert.equal(db.prepare('SELECT sent_today FROM mailboxes WHERE id = ?').get(box.id).sent_today, 1)
  // And it shows up in the delivery telemetry Monitoring reads.
  const sends = db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE kind = 'send'").get().n
  assert.ok(sends >= 1)
})
