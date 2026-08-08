// Tests for server/parity/gaps.js — the six backend gaps that were blocking a
// UI affordance. Each gets a happy path, a 422 that names its field, a
// cross-workspace 404 that leaks nothing, and paging.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, mount } from './helpers/parity-harness.js'

setup('gaps')                      // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register, parseBlockEntries, setTestTransport } = await import('../server/parity/gaps.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// ---- fixtures ---------------------------------------------------------------

function seedList(wsId, name) {
  const info = db.prepare('INSERT INTO lead_lists (workspace_id, name) VALUES (?, ?)').run(wsId, name)
  return db.prepare('SELECT * FROM lead_lists WHERE id = ?').get(info.lastInsertRowid)
}

function addMember(listId, leadId) {
  db.prepare('INSERT OR IGNORE INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(listId, leadId)
}

function seedWebhook(wsId, { name = 'Ops', url = 'https://hooks.example.com/harry', events = ['sent'], active = 1, campaignId = null } = {}) {
  const info = db.prepare(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories, is_active)
     VALUES (?, ?, ?, ?, 'shh', ?, '[]', ?)`
  ).run(wsId, campaignId, name, url, JSON.stringify(events), active)
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(info.lastInsertRowid)
}

function seedDelivery(wsId, webhookId, { eventType = 'sent', payload = '{"event_id":"e1"}', ok = 0, status = 500 } = {}) {
  const hash = `hash-${payload}`
  const info = db.prepare(
    `INSERT INTO webhook_deliveries
       (workspace_id, webhook_id, event_type, payload, payload_hash, status_code, ok, attempt, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, '')`
  ).run(wsId, webhookId, eventType, payload, hash, status, ok)
  return db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(info.lastInsertRowid)
}

function seedOrder(wsId, ref, { status = 'placed', total = 42, domains = ['a.test'] } = {}) {
  const info = db.prepare(
    `INSERT INTO sender_orders
       (workspace_id, vendor_id, order_ref, idempotency_key, status, forwarding_domain, domains, mailboxes, total, currency, created_by)
     VALUES (?, 'vendor-1', ?, ?, ?, 'fwd.test', ?, ?, ?, 'USD', 'owner@example.com')`
  ).run(wsId, ref, `idem-${ref}`, status, JSON.stringify(domains),
    JSON.stringify([{ address: 'secret.mailbox@a.test' }]), total)
  return db.prepare('SELECT * FROM sender_orders WHERE id = ?').get(info.lastInsertRowid)
}

const eventCount = () => db.prepare('SELECT COUNT(*) n FROM events').get().n

// A transport that answers whatever the test asks it to, and records the call.
// Nothing in this file touches the network.
const sent = []
let reply = { ok: true, status: 200, text: async () => 'ok' }
setTestTransport(async (url, init) => {
  sent.push({ url, init })
  return typeof reply === 'function' ? reply(url, init) : reply
})

// ---- 1. segment members -----------------------------------------------------

const segment = seedList(owner.id, 'Founders')
const ada = seedLead(db, owner.id, 'ada@acme.test', { first_name: 'Ada', last_name: 'Lovelace', company: 'Acme' })
const grace = seedLead(db, owner.id, 'grace@navy.test', { first_name: 'Grace', last_name: 'Hopper', company: 'Navy' })
const alan = seedLead(db, owner.id, 'alan@bletchley.test', { first_name: 'Alan', last_name: 'Turing', company: 'Bletchley' })
addMember(segment.id, ada.id)
addMember(segment.id, grace.id)
addMember(segment.id, alan.id)
seedLead(db, owner.id, 'outsider@nowhere.test')     // in the workspace, not in the segment

test('segment members: lists exactly the segment, with the Leads table fields', async () => {
  const before = eventCount()
  const res = await client.get(`/api/lead-lists/${segment.id}/leads`)
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 3)
  assert.equal(res.body.listName, 'Founders')
  assert.deepEqual(res.body.items.map((l) => l.email), [ada.email, grace.email, alan.email])
  assert.deepEqual(Object.keys(res.body.items[0]).sort(),
    ['addedAt', 'company', 'email', 'firstName', 'id', 'lastName', 'status', 'title'])
  assert.equal(res.body.items[0].firstName, 'Ada')
  assert.equal(res.body.items[0].status, ada.status)
  // A read writes no activity row.
  assert.equal(eventCount(), before)
})

test('segment members: ?q= searches name, email and company', async () => {
  const byName = await client.get(`/api/lead-lists/${segment.id}/leads?q=hopper`)
  assert.equal(byName.status, 200)
  assert.deepEqual(byName.body.items.map((l) => l.email), [grace.email])
  assert.equal(byName.body.total, 1)

  const byCompany = await client.get(`/api/lead-lists/${segment.id}/leads?q=bletchley`)
  assert.deepEqual(byCompany.body.items.map((l) => l.email), [alan.email])

  const none = await client.get(`/api/lead-lists/${segment.id}/leads?q=nobody`)
  assert.equal(none.body.total, 0)
  assert.deepEqual(none.body.items, [])
})

test('segment members: keyset paging walks the whole segment once', async () => {
  const seen = []
  let url = `/api/lead-lists/${segment.id}/leads?limit=2`
  for (let i = 0; i < 5; i++) {
    const res = await client.get(url)
    assert.equal(res.status, 200)
    seen.push(...res.body.items.map((l) => l.id))
    if (!res.body.hasMore) break
    url = `/api/lead-lists/${segment.id}/leads?limit=2&cursor=${res.body.nextCursor}`
  }
  assert.deepEqual(seen, [ada.id, grace.id, alan.id])
  assert.equal(new Set(seen).size, seen.length)
})

test('segment members: 422 names the field, 404 leaks nothing', async () => {
  const badId = await client.get('/api/lead-lists/not-a-number/leads')
  assert.equal(badId.status, 422)
  assert.equal(badId.body.field, 'id')

  const badLimit = await client.get(`/api/lead-lists/${segment.id}/leads?limit=0`)
  assert.equal(badLimit.status, 422)
  assert.equal(badLimit.body.field, 'limit')

  const theirs = seedList(stranger.id, "Stranger's people")
  const theirLead = seedLead(db, stranger.id, 'private@stranger.test')
  addMember(theirs.id, theirLead.id)
  const cross = await client.get(`/api/lead-lists/${theirs.id}/leads`)
  assert.equal(cross.status, 404)
  assert.equal(cross.body.error, 'not_found')
  assert.equal(JSON.stringify(cross.body).includes('Stranger'), false)
  assert.equal(JSON.stringify(cross.body).includes('private@stranger.test'), false)

  // A soft-deleted segment is indistinguishable from one that never existed.
  const gone = seedList(owner.id, 'Deleted')
  db.prepare("UPDATE lead_lists SET deleted_at = '2020-01-01' WHERE id = ?").run(gone.id)
  const deleted = await client.get(`/api/lead-lists/${gone.id}/leads`)
  assert.equal(deleted.status, 404)
})

// ---- 2. workspace people ----------------------------------------------------

const teammate = seedUser(db, 'joined@example.com')
db.prepare("INSERT INTO team_members (owner_id, email, role, status) VALUES (?, ?, 'manager', 'active')")
  .run(owner.id, teammate.email)
db.prepare("INSERT INTO team_members (owner_id, email, role, status) VALUES (?, 'pending@example.com', 'member', 'invited')")
  .run(owner.id)
// Somebody else's team member must never appear in this workspace's list.
db.prepare("INSERT INTO team_members (owner_id, email, role, status) VALUES (?, 'theirs@stranger.test', 'member', 'active')")
  .run(stranger.id)

test('workspace members: the owner plus active members, each with a real users.id', async () => {
  const before = eventCount()
  const res = await client.get('/api/workspace/members')
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 2)
  const [first, second] = res.body.items
  assert.equal(first.email, 'owner@example.com')
  assert.equal(first.id, owner.id)
  assert.equal(first.role, 'owner')
  assert.equal(first.assignable, true)
  assert.equal(second.email, 'joined@example.com')
  assert.equal(second.id, teammate.id)          // the id PUT /campaigns/:id/owner needs
  assert.equal(second.hasSignedIn, true)
  // Invited-but-not-joined is not in the default list, and nobody else's is.
  assert.equal(res.body.items.some((m) => m.email === 'pending@example.com'), false)
  assert.equal(res.body.items.some((m) => m.email === 'theirs@stranger.test'), false)
  assert.equal(eventCount(), before)
})

test('workspace members: leaks nothing beyond id, email, name and status', async () => {
  db.prepare("UPDATE users SET business_context = 'top secret positioning' WHERE id = ?").run(owner.id)
  const res = await client.get('/api/workspace/members?status=all')
  assert.equal(res.status, 200)
  for (const person of res.body.items) {
    assert.deepEqual(Object.keys(person).sort(),
      ['assignable', 'email', 'hasSignedIn', 'id', 'name', 'role', 'status'])
  }
  assert.equal(JSON.stringify(res.body).includes('top secret'), false)
  assert.equal(JSON.stringify(res.body).includes('sub'), false)

  const invited = res.body.items.find((m) => m.email === 'pending@example.com')
  assert.ok(invited, 'status=all includes invited people')
  assert.equal(invited.id, null)                 // no account yet
  assert.equal(invited.hasSignedIn, false)
  assert.equal(invited.assignable, false)        // PUT /campaigns/:id/owner would 422
})

test('workspace members: pages, and 422 names the field', async () => {
  const first = await client.get('/api/workspace/members?status=all&limit=1')
  assert.equal(first.status, 200)
  assert.equal(first.body.items.length, 1)
  assert.equal(first.body.hasMore, true)
  assert.equal(first.body.nextOffset, 1)
  assert.equal(first.body.total, 3)

  const rest = await client.get(`/api/workspace/members?status=all&limit=10&offset=${first.body.nextOffset}`)
  assert.equal(rest.body.items.length, 2)
  assert.equal(rest.body.hasMore, false)
  assert.equal(rest.body.items.some((m) => m.email === first.body.items[0].email), false)

  const bad = await client.get('/api/workspace/members?status=nonsense')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'status')

  const badLimit = await client.get('/api/workspace/members?limit=9999')
  assert.equal(badLimit.status, 422)
  assert.equal(badLimit.body.field, 'limit')
})

// ---- 3. sender orders -------------------------------------------------------

const orderA = seedOrder(owner.id, 'HTM-ORD-AAA', { status: 'placed', total: 10 })
const orderB = seedOrder(owner.id, 'HTM-ORD-BBB', { status: 'pending', total: 20 })
const orderC = seedOrder(owner.id, 'HTM-ORD-CCC', { status: 'placed', total: 30 })
seedOrder(stranger.id, 'HTM-ORD-THEIRS')
db.prepare('INSERT INTO sender_billing_details (workspace_id, encrypted) VALUES (?, ?)')
  .run(owner.id, 'ENCRYPTED-CARD-BLOB')

test('sender orders: newest first, workspace-scoped, no billing and no mailboxes', async () => {
  const before = eventCount()
  const res = await client.get('/api/senders/orders')
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 3)
  assert.deepEqual(res.body.data.map((o) => o.order_ref), ['HTM-ORD-CCC', 'HTM-ORD-BBB', 'HTM-ORD-AAA'])
  assert.deepEqual(Object.keys(res.body.data[0]).sort(),
    ['created_at', 'currency', 'domain_count', 'domains', 'order_ref', 'status', 'total', 'updated_at', 'vendor_id'])
  assert.equal(res.body.data[0].total, 30)
  assert.equal(res.body.data[0].currency, 'USD')
  assert.deepEqual(res.body.data[0].domains, ['a.test'])

  const body = JSON.stringify(res.body)
  assert.equal(body.includes('ENCRYPTED-CARD-BLOB'), false)
  assert.equal(body.includes('secret.mailbox@a.test'), false)
  // Another workspace's order history is invisible, not 403'd.
  assert.equal(body.includes('HTM-ORD-THEIRS'), false)
  assert.equal(eventCount(), before)
})

test('sender orders: filters by status, pages by cursor, and 422s a bad status', async () => {
  const placed = await client.get('/api/senders/orders?status=placed')
  assert.equal(placed.status, 200)
  assert.equal(placed.body.total, 2)
  assert.deepEqual(placed.body.data.map((o) => o.order_ref), ['HTM-ORD-CCC', 'HTM-ORD-AAA'])

  const first = await client.get('/api/senders/orders?limit=2')
  assert.equal(first.body.data.length, 2)
  assert.equal(first.body.hasMore, true)
  const next = await client.get(`/api/senders/orders?limit=2&cursor=${first.body.nextCursor}`)
  assert.equal(next.body.hasMore, false)
  assert.deepEqual(next.body.data.map((o) => o.order_ref), ['HTM-ORD-AAA'])

  const bad = await client.get('/api/senders/orders?status=shipped')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'status')
  assert.ok(bad.body.message.includes('pending'))

  // The literal route has not swallowed the by-reference lookup's shape.
  assert.equal(orderA.order_ref, 'HTM-ORD-AAA')
  assert.equal(orderB.status, 'pending')
  assert.equal(orderC.total, 30)
})

// ---- 4. webhook test event --------------------------------------------------

const hook = seedWebhook(owner.id, { name: 'Ops channel' })
const strangerHook = seedWebhook(stranger.id, { name: 'Not yours', url: 'https://hooks.stranger.test/x' })

test('webhook test: delivers one clearly-marked sample and records it as a test', async () => {
  sent.length = 0
  reply = { ok: true, status: 200, text: async () => 'ok' }
  const res = await client.post(`/api/webhooks/${hook.id}/test`, {})
  assert.equal(res.status, 200)
  assert.equal(res.body.data.delivered, true)
  assert.equal(res.body.data.status_code, 200)
  assert.equal(res.body.data.error, '')
  assert.equal(res.body.data.test, true)
  assert.equal(res.body.data.event_type, 'test')

  // Exactly one call, to this endpoint only.
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, hook.url)
  assert.equal(sent[0].init.headers['X-Harry-Test'], 'true')
  assert.equal(sent[0].init.headers['X-Harry-Event'], 'test')
  assert.ok(sent[0].init.headers['X-Harry-Signature'].startsWith('sha256='))

  // The payload is unmistakably a test at the top level, not buried.
  const payload = JSON.parse(sent[0].init.body)
  assert.equal(payload.test, true)
  assert.equal(payload.is_test, true)
  assert.equal(payload.event_type, 'test')
  assert.ok(/THIS IS A TEST/.test(payload.message))

  // And the attempt is on the record, flagged as a test.
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(res.body.data.delivery_id)
  assert.ok(row, 'the test delivery is recorded')
  assert.equal(row.webhook_id, hook.id)
  assert.equal(row.workspace_id, owner.id)
  assert.equal(row.event_type, 'test')
  assert.equal(row.ok, 1)
  assert.equal(row.status_code, 200)
  assert.equal(JSON.parse(row.payload).test, true)

  // A test is an auditable act, and one events row covers it.
  const audits = db.prepare("SELECT * FROM events WHERE type = 'webhook_tested' ORDER BY id DESC").all()
  assert.equal(audits.length, 1)
  assert.equal(audits[0].user_id, owner.id)
})

test('webhook test: reports the status code and the error when the endpoint refuses', async () => {
  sent.length = 0
  reply = { ok: false, status: 503, text: async () => 'upstream down' }
  const res = await client.post(`/api/webhooks/${hook.id}/test`, {})
  assert.equal(res.status, 200)                      // the test ran; the endpoint failed
  assert.equal(res.body.data.delivered, false)
  assert.equal(res.body.data.status_code, 503)
  assert.ok(res.body.data.error.includes('503'))
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(res.body.data.delivery_id)
  assert.equal(row.ok, 0)
  assert.equal(row.event_type, 'test')
  reply = { ok: true, status: 200, text: async () => 'ok' }
})

test('webhook test: 422 names the field, cross-workspace 404 leaks nothing', async () => {
  const bad = await client.post('/api/webhooks/not-a-number/test', {})
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'id')

  sent.length = 0
  const cross = await client.post(`/api/webhooks/${strangerHook.id}/test`, {})
  assert.equal(cross.status, 404)
  assert.equal(cross.body.error, 'not_found')
  assert.equal(JSON.stringify(cross.body).includes('Not yours'), false)
  assert.equal(JSON.stringify(cross.body).includes('stranger.test'), false)
  assert.equal(sent.length, 0, 'a stranger\'s endpoint is never contacted')
})

// ---- 5. workspace-wide webhook retry ----------------------------------------

const retryHook = seedWebhook(owner.id, { name: 'Retry me', url: 'https://hooks.example.com/retry' })
const otherHook = seedWebhook(owner.id, { name: 'Other', url: 'https://hooks.example.com/other' })

test('webhook retry: replays only failures, across every campaign, once per payload', async () => {
  // Two failed attempts at the same event on one endpoint, one failure on
  // another, one success (never replayed) and one failed *test* (excluded).
  seedDelivery(owner.id, retryHook.id, { payload: '{"event_id":"a"}', ok: 0 })
  seedDelivery(owner.id, retryHook.id, { payload: '{"event_id":"a"}', ok: 0 })
  seedDelivery(owner.id, otherHook.id, { payload: '{"event_id":"b"}', ok: 0 })
  seedDelivery(owner.id, retryHook.id, { payload: '{"event_id":"c"}', ok: 1, status: 200 })
  seedDelivery(owner.id, retryHook.id, { payload: '{"event_id":"t"}', ok: 0, eventType: 'test' })
  // A stranger's failure is never touched.
  seedDelivery(stranger.id, strangerHook.id, { payload: '{"event_id":"x"}', ok: 0 })

  sent.length = 0
  reply = { ok: true, status: 200, text: async () => 'ok' }
  const res = await client.post('/api/webhooks/retry', {})
  assert.equal(res.status, 200)
  assert.equal(res.body.retriggered_count, 2)       // a+b, not a+a+b, and no test
  assert.equal(res.body.delivered_count, 2)
  assert.equal(res.body.failed_count, 0)
  assert.equal(res.body.truncated, false)
  assert.deepEqual(sent.map((c) => c.url).sort(), [otherHook.url, retryHook.url].sort())
  assert.equal(sent.some((c) => c.url.includes('stranger')), false)

  // One events row for the sweep, not one per delivery.
  const audits = db.prepare("SELECT * FROM events WHERE type = 'webhooks_retriggered'").all()
  assert.equal(audits.length, 1)

  // Idempotent: the payloads have now succeeded, so a second sweep resends
  // nothing.
  sent.length = 0
  const again = await client.post('/api/webhooks/retry', {})
  assert.equal(again.body.retriggered_count, 0)
  assert.equal(again.body.skipped_count, 2)
  assert.equal(sent.length, 0)
})

test('webhook retry: scopes to one endpoint, and 404s a stranger\'s', async () => {
  seedDelivery(owner.id, retryHook.id, { payload: '{"event_id":"d"}', ok: 0 })
  seedDelivery(owner.id, otherHook.id, { payload: '{"event_id":"e"}', ok: 0 })

  sent.length = 0
  const one = await client.post('/api/webhooks/retry', { webhookId: retryHook.id })
  assert.equal(one.status, 200)
  assert.equal(one.body.webhookId, retryHook.id)
  assert.equal(one.body.retriggered_count, 1)
  assert.deepEqual(sent.map((c) => c.url), [retryHook.url])

  sent.length = 0
  const cross = await client.post('/api/webhooks/retry', { webhookId: strangerHook.id })
  assert.equal(cross.status, 404)
  assert.equal(cross.body.error, 'not_found')
  assert.equal(JSON.stringify(cross.body).includes('Not yours'), false)
  assert.equal(sent.length, 0)
})

test('webhook retry: the window is optional but validated, and 422 names the field', async () => {
  const badFrom = await client.post('/api/webhooks/retry', { from: 'yesterday-ish' })
  assert.equal(badFrom.status, 422)
  assert.equal(badFrom.body.field, 'from')

  const inverted = await client.post('/api/webhooks/retry', {
    from: '2024-06-01T00:00:00.000Z', to: '2024-01-01T00:00:00.000Z',
  })
  assert.equal(inverted.status, 422)
  assert.equal(inverted.body.field, 'from')

  const tooWide = await client.post('/api/webhooks/retry', {
    from: '2020-01-01T00:00:00.000Z', to: '2024-01-01T00:00:00.000Z',
  })
  assert.equal(tooWide.status, 422)
  assert.equal(tooWide.body.field, 'from')

  const badId = await client.post('/api/webhooks/retry', { webhookId: 'abc' })
  assert.equal(badId.status, 422)
  assert.equal(badId.body.field, 'webhookId')

  // A window that ends before anything happened replays nothing rather than
  // scanning the whole table.
  sent.length = 0
  const empty = await client.post('/api/webhooks/retry', {
    from: '2024-01-01T00:00:00.000Z', to: '2024-01-02T00:00:00.000Z',
  })
  assert.equal(empty.status, 200)
  assert.equal(empty.body.retriggered_count, 0)
  assert.equal(sent.length, 0)
  assert.equal(empty.body.message, 'Nothing to retry in this period')
})

// ---- 6. block-list line parsing ---------------------------------------------

test('parseBlockEntries: one bad line is one error, quoted whole', () => {
  const out = parseBlockEntries('not a valid entry!!\ngood.com')
  assert.equal(out.errors.length, 1, 'exactly one error for the one bad line')
  assert.equal(out.errors[0].input, 'not a valid entry!!')
  assert.ok(out.errors[0].message.includes('not a valid entry!!'))
  assert.equal(out.errors[0].line, 1)
  assert.equal(out.entries.length, 1)
  assert.equal(out.entries[0].value, 'good.com')
  assert.equal(out.entries[0].isDomain, true)
  assert.equal(out.requested, 2)
})

test('parseBlockEntries: splits on newlines, commas and semicolons only', () => {
  const out = parseBlockEntries('a.com, b.com; c.com\r\nd.com')
  assert.deepEqual(out.entries.map((e) => e.value), ['a.com', 'b.com', 'c.com', 'd.com'])
  assert.equal(out.errors.length, 0)

  // A space is not a separator: "a.com b.com" is one line and one error.
  const spaced = parseBlockEntries('a.com b.com')
  assert.equal(spaced.entries.length, 0)
  assert.equal(spaced.errors.length, 1)
  assert.equal(spaced.errors[0].input, 'a.com b.com')
})

test('parseBlockEntries: normalises scheme, www, path, brackets and a leading @', () => {
  const out = parseBlockEntries([
    'HTTPS://WWW.Competitor.com/pricing?ref=x',
    '@Another.COM',
    '<Ana@Example.ORG>',
    'mailto:bo@mail.example.org',
  ])
  assert.deepEqual(out.entries.map((e) => e.value),
    ['competitor.com', 'another.com', 'ana@example.org', 'bo@mail.example.org'])
  assert.deepEqual(out.entries.map((e) => e.isDomain), [true, true, false, false])
  assert.equal(out.errors.length, 0)
})

test('parseBlockEntries: 422 names the field for a shape it cannot read', () => {
  assert.throws(() => parseBlockEntries(42), (err) => {
    assert.equal(err.status, 422)
    assert.equal(err.body.field, 'domain_block_list')
    return true
  })
  assert.throws(() => parseBlockEntries([{ domain: 'x.com' }]), (err) => {
    assert.equal(err.body.field, 'domain_block_list')
    return true
  })
})

test('block-list parse: previews the paste and writes absolutely nothing', async () => {
  seedMailbox(db, owner.id, 'sender@ourdomain.test')
  db.prepare("INSERT INTO blocked_domains (workspace_id, value, is_domain) VALUES (?, 'already.test', 1)")
    .run(owner.id)

  const rowsBefore = db.prepare('SELECT COUNT(*) n FROM blocked_domains').get().n
  const eventsBefore = eventCount()

  const res = await client.post('/api/block-list/parse', {
    domain_block_list: 'not a valid entry!!\nhttps://www.NewOne.com/pricing\nalready.test\nnewone.com\nourdomain.test',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.preview, true)
  assert.equal(res.body.requested, 5)

  assert.deepEqual(res.body.willAdd.map((e) => e.value), ['newone.com'])
  assert.equal(res.body.willAddCount, 1)

  assert.deepEqual(res.body.duplicates.map((d) => [d.value, d.reason]).sort(),
    [['already.test', 'already_blocked'], ['newone.com', 'duplicate_in_request']].sort())

  const malformed = res.body.rejected.filter((r) => r.reason === 'malformed')
  assert.equal(malformed.length, 1)
  assert.equal(malformed[0].input, 'not a valid entry!!')
  const own = res.body.rejected.filter((r) => r.reason === 'own_sending_domain')
  assert.equal(own.length, 1)
  assert.equal(own[0].value, 'ourdomain.test')

  // Nothing was written — not a block-list row, not an activity row.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blocked_domains').get().n, rowsBefore)
  assert.equal(eventCount(), eventsBefore)
})

test('block-list parse: 422 names the field when the paste is missing', async () => {
  const missing = await client.post('/api/block-list/parse', {})
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'domain_block_list')

  const wrongShape = await client.post('/api/block-list/parse', { domain_block_list: 42 })
  assert.equal(wrongShape.status, 422)
  assert.equal(wrongShape.body.field, 'domain_block_list')

  const tooMany = await client.post('/api/block-list/parse', {
    domain_block_list: Array.from({ length: 1001 }, (_, i) => `d${i}.test`).join('\n'),
  })
  assert.equal(tooMany.status, 422)
  assert.equal(tooMany.body.field, 'domain_block_list')
})

// ---- cross-cutting ----------------------------------------------------------

test('a campaign and a mailbox in another workspace stay invisible', async () => {
  const theirCampaign = seedCampaign(db, stranger.id, 'Stranger campaign')
  seedMailbox(db, stranger.id, 'theirs@stranger.test')
  const hookThere = seedWebhook(stranger.id, { name: 'Campaign hook', campaignId: theirCampaign.id })
  const res = await client.post(`/api/webhooks/${hookThere.id}/test`, {})
  assert.equal(res.status, 404)

  const members = await client.get('/api/workspace/members?status=all')
  assert.equal(JSON.stringify(members.body).includes('stranger.test'), false)
})
