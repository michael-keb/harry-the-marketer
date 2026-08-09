// Audit pass over the spec rows that had never been reviewed:
// Docs/clients/get-all.md, Docs/clients/update.md, Docs/webhooks/get.md,
// Docs/webhooks/update.md, Docs/webhooks/delete.md and
// Docs/utilities/domain-block-list.md.
//
// The existing parity files already cover the happy paths and the field-named
// 422s. What was missing was every criterion whose proof is an *effect* rather
// than a response shape — a retry that never fires, a campaign-level endpoint
// that starts receiving again, an allowance breach that does not do what the
// toast used to claim. Each test here asserts on a stored row or on what the
// injected transport was actually handed, so none of them would pass if the
// feature underneath were removed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedCampaign, seedMessage, mount } from './helpers/parity-harness.js'

setup('audit')                     // MUST precede any ../server import

const { db } = await import('../server/db.js')
const clients = await import('../server/parity/clients.js')
const webhooks = await import('../server/parity/webhooks.js')
const utilities = await import('../server/parity/utilities.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const api = await mount([clients.register, webhooks.register, utilities.register], owner)
test.after(() => api.close())

const campaign = seedCampaign(db, owner.id, 'Audit campaign')

// A transport that records every call and answers from a script. Nothing in
// this file touches the network.
function stub(script = [{ status: 200 }], onCall = null) {
  const calls = []
  let i = 0
  const fn = async (url, init) => {
    calls.push({ url, body: init?.body, headers: init?.headers || {} })
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    if (onCall) await onCall(calls.length, url)
    return { status: step.status, ok: step.status >= 200 && step.status < 300, text: async () => step.text || '' }
  }
  fn.calls = calls
  return fn
}

const fire = (type, payload, transport) =>
  webhooks.fireWebhooks(owner.id, type, payload, { fetchImpl: transport, backoffMs: 0 })

async function makeHook(body) {
  const res = await api.post('/api/webhooks', body)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.id
}

const hookRow = (id) => db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
const deliveries = (id) => db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id').all(id)

// =============================================================== clients ====
// Docs/clients/get-all.md

test('get-all: a deleted client leaves every read, and its rows go back to the agency', async () => {
  const made = await api.post('/api/clients', { name: 'Doomed Brand', email: 'doomed@example.com' })
  const id = made.body.data.id
  const mine = seedCampaign(db, owner.id, 'Doomed work')
  await api.post(`/api/clients/${id}/scope`, { campaignIds: [mine.id] })
  assert.equal(db.prepare('SELECT client_id FROM campaigns WHERE id = ?').get(mine.id).client_id, id)

  assert.equal((await api.del(`/api/clients/${id}`)).status, 200)

  // The stored row is soft-deleted rather than destroyed, and the campaign is
  // returned to the agency rather than deleted with the brand.
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id)
  assert.ok(row, 'a deleted client keeps its row')
  assert.ok(row.deleted_at, 'deleted_at is stamped')
  assert.equal(db.prepare('SELECT client_id FROM campaigns WHERE id = ?').get(mine.id).client_id, null)

  // And it is absent from every read, including the one that asks for archived
  // clients too — `status=all` must not resurrect a deleted brand (TC-9).
  for (const url of ['/api/clients', '/api/clients?status=all', '/api/clients?status=archived']) {
    const list = await api.get(url)
    assert.equal(list.status, 200)
    assert.ok(!list.body.data.some((c) => c.id === id), `${url} still lists the deleted client`)
  }
  assert.equal((await api.get(`/api/clients/${id}`)).status, 404)
  assert.equal((await api.patch(`/api/clients/${id}`, { name: 'Back?' })).status, 404)
  assert.equal((await api.get(`/api/clients/${id}/api-keys`)).status, 404)
})

test('get-all: an archived client is hidden by default, listed on request, and keeps its rows', async () => {
  const made = await api.post('/api/clients', { name: 'Resting Brand', email: 'resting@example.com' })
  const id = made.body.data.id
  const mine = seedCampaign(db, owner.id, 'Resting work')
  await api.post(`/api/clients/${id}/scope`, { campaignIds: [mine.id] })

  assert.equal((await api.patch(`/api/clients/${id}`, { status: 'archived' })).status, 200)
  assert.equal(db.prepare('SELECT status FROM clients WHERE id = ?').get(id).status, 'archived')

  const dflt = await api.get('/api/clients')
  assert.ok(!dflt.body.data.some((c) => c.id === id), 'archived clients are out of the default list')
  const all = await api.get('/api/clients?status=all')
  assert.ok(all.body.data.some((c) => c.id === id), 'status=all lists it')

  // Archiving is not deleting: the scope survives, which is the whole
  // difference between the two actions.
  assert.equal(db.prepare('SELECT client_id FROM campaigns WHERE id = ?').get(mine.id).client_id, id)
  assert.equal((await api.patch(`/api/clients/${id}`, { status: 'unknown' })).status, 422)
})

test('get-all: 220 clients page through completely, once each, and an absurd limit is refused', async () => {
  const insert = db.prepare('INSERT INTO clients (workspace_id, name, email, permissions, status) VALUES (?, ?, ?, ?, ?)')
  const seeded = new Set()
  for (let i = 0; i < 220; i += 1) {
    const info = insert.run(owner.id, `Bulk brand ${i}`, `bulk${i}@example.com`, '[]', 'active')
    seeded.add(Number(info.lastInsertRowid))
  }

  const seen = []
  let cursor = null
  for (let guard = 0; guard < 20; guard += 1) {
    const url = `/api/clients?limit=50${cursor ? `&cursor=${cursor}` : ''}`
    const res = await api.get(url)
    assert.equal(res.status, 200)
    assert.ok(res.body.data.length <= 50, 'a page never exceeds the limit it was asked for')
    seen.push(...res.body.data.map((c) => c.id))
    if (!res.body.hasMore) { cursor = null; break }
    cursor = res.body.nextCursor
    assert.ok(cursor, 'hasMore without a cursor would strand the caller')
  }
  assert.equal(cursor, null, 'paging terminated')
  assert.equal(new Set(seen).size, seen.length, 'no client was returned on two pages')
  for (const id of seeded) assert.ok(seen.includes(id), `client ${id} was never returned`)

  // Unbounded requests are rejected rather than clamped (the standing rule).
  assert.equal((await api.get('/api/clients?limit=5000')).status, 422)
})

// Docs/clients/update.md

test('update: a one-field save changes exactly that column in the stored row', async () => {
  const made = await api.post('/api/clients', {
    name: 'Merge Brand',
    email: 'merge@example.com',
    permission: ['campaigns', 'leads'],
    color: '#123456',
    logo_url: 'https://cdn.example.com/merge.png',
    is_credit_assigned: true,
    email_credits: 500,
    lead_credits: 250,
  })
  const id = made.body.data.id
  const before = db.prepare('SELECT * FROM clients WHERE id = ?').get(id)

  const res = await api.patch(`/api/clients/${id}`, { name: 'Merge Brand Renamed' })
  assert.equal(res.status, 200)
  assert.equal(res.body.changed, true)

  const after = db.prepare('SELECT * FROM clients WHERE id = ?').get(id)
  assert.equal(after.name, 'Merge Brand Renamed')
  for (const column of ['email', 'logo_url', 'color', 'permissions', 'status']) {
    assert.equal(after[column], before[column], `${column} was collateral damage on a name-only save`)
  }
  // The allowance lives outside the row; a partial save must not reset it.
  assert.deepEqual(res.body.data.credits, {
    assigned: true, email_credits: 500, lead_credits: 250, source: 'client allowance',
  })
})

test('update: an over-allowance save reports the breach and the pause it really performs', async () => {
  const made = await api.post('/api/clients', { name: 'Spendy Brand', email: 'spendy@example.com' })
  const id = made.body.data.id
  const theirs = seedCampaign(db, owner.id, 'Spendy Q1')
  await api.post(`/api/clients/${id}/scope`, { campaignIds: [theirs.id] })
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(theirs.id)
  for (let i = 0; i < 4; i += 1) seedMessage(db, owner.id, { campaignId: theirs.id, direction: 'out' })

  const res = await api.patch(`/api/clients/${id}`, {
    is_credit_assigned: true, email_credits: 2, lead_credits: 0,
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.overAllowance.used, 4)
  assert.equal(res.body.overAllowance.allowed, 2)

  // update.md AC 4 asks for the client's sending to be paused, and it now is:
  // `client_allowance` in server/gates.js refuses every send from a campaign
  // belonging to an over-allowance client, so the claim below is one the send
  // path keeps. (The proof that no email leaves is in
  // tests/terminal-and-limits.test.js, which drives `tick()` and counts rows in
  // `messages`; this file only checks that the response tells the truth.)
  assert.equal(res.body.overAllowance.enforced, true)
  assert.match(res.body.overAllowance.reason, /will not send again/i)
  // The pause is a condition, not a status change: raising the allowance
  // resumes sending with nothing to un-pause, so the campaign row is untouched.
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(theirs.id).status, 'running')

  // The breach is on the trail exactly once, naming the numbers.
  const trail = db.prepare(
    "SELECT * FROM events WHERE user_id = ? AND type = 'client_over_allowance' ORDER BY id DESC LIMIT 1"
  ).get(owner.id)
  assert.match(trail.detail, /Spendy Brand" is over its allowance: 4 of 2/)
})

test('update: a rename frees the old name for another client and still refuses a live clash', async () => {
  const first = await api.post('/api/clients', { name: 'Shared Name', email: 'first@example.com' })
  assert.equal(first.status, 200)
  // The name is taken while it is in use.
  const clash = await api.post('/api/clients', { name: 'Shared Name', email: 'second@example.com' })
  assert.equal(clash.status, 409)
  assert.equal(clash.body.field, 'name')

  await api.patch(`/api/clients/${first.body.data.id}`, { name: 'Shared Name Moved On' })
  const reused = await api.post('/api/clients', { name: 'Shared Name', email: 'second@example.com' })
  assert.equal(reused.status, 200, 'the freed name is usable again')

  // And renaming back onto a live name is refused, not silently applied.
  const back = await api.patch(`/api/clients/${first.body.data.id}`, { name: 'Shared Name' })
  assert.equal(back.status, 409)
  assert.equal(db.prepare('SELECT name FROM clients WHERE id = ?').get(first.body.data.id).name, 'Shared Name Moved On')
})

// ============================================================== webhooks ====
// Docs/webhooks/get.md

test('get: delivery history is capped at ten rows, newest first', async () => {
  const id = await makeHook({
    name: 'Chatty', webhook_url: 'https://hooks.example.test/chatty', event_types: ['EMAIL_SENT'],
  })
  const insert = db.prepare(
    `INSERT INTO webhook_deliveries (workspace_id, webhook_id, event_type, payload, payload_hash, status_code, ok, attempt)
     VALUES (?, ?, 'sent', '{}', ?, 200, 1, 1)`
  )
  for (let i = 0; i < 14; i += 1) insert.run(owner.id, id, `hash-${i}`)
  assert.equal(deliveries(id).length, 14)

  const res = await api.get(`/api/webhooks/${id}`)
  assert.equal(res.status, 200)
  const shown = res.body.data.deliveries
  assert.equal(shown.length, 10, 'the cap is ten, not "about ten"')
  const ids = shown.map((d) => d.id)
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first')
  assert.equal(ids[0], Math.max(...deliveries(id).map((d) => d.id)), 'the newest attempt is the first row')

  await api.del(`/api/webhooks/${id}`)
})

test('get: an auto-paused endpoint says it is paused, why, and how to resume', async () => {
  const id = await makeHook({
    name: 'Failing', webhook_url: 'https://hooks.example.test/failing', event_types: ['EMAIL_SENT'],
  })
  // Five consecutive failures is the documented auto-pause threshold. Each
  // fireWebhooks call is one event; one attempt each keeps the run countable.
  const transport = stub([{ status: 500, text: 'upstream exploded' }])
  for (let i = 0; i < 5; i += 1) {
    await webhooks.fireWebhooks(owner.id, 'sent', {}, { fetchImpl: transport, backoffMs: 0, maxAttempts: 1 })
  }
  assert.equal(hookRow(id).is_active, 0, 'the endpoint rested itself')

  const res = await api.get(`/api/webhooks/${id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.is_active, false)
  const paused = res.body.data.paused
  assert.ok(paused, 'a paused endpoint must say so in the read')
  assert.equal(paused.automatic, true)
  assert.equal(paused.consecutive_failures, 5)
  assert.match(paused.reason, /5 consecutive failed deliveries/)
  assert.match(paused.reason, /500/)
  assert.deepEqual(paused.resume, { method: 'PATCH', path: `/api/webhooks/${id}`, body: { is_active: true } })

  // And the offered Resume is the one that actually works.
  const resumed = await api.patch(paused.resume.path, paused.resume.body)
  assert.equal(resumed.status, 200)
  assert.equal(hookRow(id).is_active, 1)
  assert.equal((await api.get(`/api/webhooks/${id}`)).body.data.paused, null)

  await api.del(`/api/webhooks/${id}`)
})

// Docs/webhooks/update.md

test('update: after a URL change the next event goes to the new URL only', async () => {
  const id = await makeHook({
    name: 'Moving', webhook_url: 'https://hooks.example.test/old', event_types: ['EMAIL_SENT'],
    secret: 'keep-this-secret',
  })

  const before = stub()
  await fire('sent', {}, before)
  assert.deepEqual(before.calls.map((c) => c.url), ['https://hooks.example.test/old'])

  assert.equal((await api.patch(`/api/webhooks/${id}`, { webhook_url: 'https://hooks.example.test/new' })).status, 200)

  const after = stub()
  await fire('sent', {}, after)
  assert.deepEqual(after.calls.map((c) => c.url), ['https://hooks.example.test/new'],
    'the old URL must never see another event')

  // The signature still verifies with the secret captured before the move
  // (update.md TC-10) — the URL edit did not rotate it.
  const signed = webhooks.signPayload('keep-this-secret', after.calls[0].body)
  assert.equal(after.calls[0].headers['X-Harry-Signature'], signed)

  await api.del(`/api/webhooks/${id}`)
})

test('update: an endpoint listening for nothing is delivered nothing, and restoring the selection restores delivery', async () => {
  const id = await makeHook({
    name: 'Muted', webhook_url: 'https://hooks.example.test/muted', event_types: ['EMAIL_SENT'],
  })

  assert.equal((await api.patch(`/api/webhooks/${id}`, { event_types: [] })).status, 200)
  assert.equal(hookRow(id).event_types, '[]')

  const silent = stub()
  await fire('sent', {}, silent)
  assert.equal(silent.calls.length, 0, 'an empty selection must deliver nothing')
  assert.equal(deliveries(id).length, 0, 'and record no attempt')

  assert.equal((await api.patch(`/api/webhooks/${id}`, { event_types: ['EMAIL_SENT'] })).status, 200)
  const loud = stub()
  await fire('sent', {}, loud)
  assert.equal(loud.calls.length, 1)

  await api.del(`/api/webhooks/${id}`)
})

test('update: emptying categories switches reply-intent filtering off', async () => {
  const id = await makeHook({
    name: 'Picky', webhook_url: 'https://hooks.example.test/picky',
    event_types: ['LEAD_CATEGORY_UPDATED'], categories: ['interested'],
  })
  assert.deepEqual(JSON.parse(hookRow(id).categories), ['interested'])

  const filtered = stub()
  await fire('reclassified', { category: 'not_interested' }, filtered)
  assert.equal(filtered.calls.length, 0, 'a filtered-out intent is not delivered')
  const matched = stub()
  await fire('reclassified', { category: 'interested' }, matched)
  assert.equal(matched.calls.length, 1)

  assert.equal((await api.patch(`/api/webhooks/${id}`, { categories: [] })).status, 200)
  assert.deepEqual(JSON.parse(hookRow(id).categories), [])

  const everything = stub()
  await fire('reclassified', { category: 'not_interested' }, everything)
  assert.equal(everything.calls.length, 1, 'empty means all intents, not no intents')

  await api.del(`/api/webhooks/${id}`)
})

// Docs/webhooks/delete.md

test('delete: a retry already queued behind a failure is cancelled by the deletion', async () => {
  const id = await makeHook({
    name: 'Retrying', webhook_url: 'https://hooks.example.test/retrying', event_types: ['EMAIL_SENT'],
  })

  // The first attempt fails with a retryable status; while the delivery loop is
  // between attempts, the endpoint is deleted through the real route. Attempt
  // two must never happen.
  let deleteStatus = null
  const transport = stub([{ status: 500 }], async (call) => {
    if (call === 1) deleteStatus = (await api.del(`/api/webhooks/${id}`)).status
  })

  const results = await webhooks.fireWebhooks(
    owner.id, 'sent', {}, { fetchImpl: transport, backoffMs: 0, maxAttempts: 3 }
  )
  assert.equal(deleteStatus, 200, 'the deletion itself succeeded mid-flight')
  assert.equal(transport.calls.length, 1, 'the queued retry fired anyway')
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, false)
  assert.equal(results[0].cancelled, true)

  // Exactly one attempt is on the record, and it outlives the endpoint.
  assert.equal(deliveries(id).length, 1)
  assert.equal(hookRow(id).is_active, -1)
})

test('delete: removing the workspace-level endpoint hands the event back to the campaign-level one', async () => {
  const campaignHook = await makeHook({
    name: 'Campaign level', webhook_url: 'https://hooks.example.test/campaign-level',
    association_type: 'campaign', email_campaign_id: campaign.id, event_types: ['EMAIL_SENT'],
  })
  const workspaceHook = await makeHook({
    name: 'Workspace level', webhook_url: 'https://hooks.example.test/workspace-level',
    event_types: ['EMAIL_SENT'],
  })

  // While both exist the workspace-level one wins, and the campaign list says so.
  const overridden = stub()
  await fire('sent', { campaign_id: campaign.id }, overridden)
  assert.deepEqual(overridden.calls.map((c) => c.url), ['https://hooks.example.test/workspace-level'])
  const listed = await api.get(`/api/campaigns/${campaign.id}/webhooks`)
  assert.equal(listed.body.data.find((w) => w.id === campaignHook).overridden, true)

  assert.equal((await api.del(`/api/webhooks/${workspaceHook}`)).status, 200)

  // TC-11: the campaign-level endpoint starts receiving, with no second code
  // path to keep in step — the priority decision is one function.
  const restored = stub()
  await fire('sent', { campaign_id: campaign.id }, restored)
  assert.deepEqual(restored.calls.map((c) => c.url), ['https://hooks.example.test/campaign-level'])
  assert.equal(deliveries(campaignHook).length, 1)

  const relisted = await api.get(`/api/campaigns/${campaign.id}/webhooks`)
  assert.equal(relisted.body.data.find((w) => w.id === campaignHook).overridden, false)
  assert.ok(!relisted.body.inherited.some((w) => w.id === workspaceHook),
    'a deleted workspace endpoint must not still be shown as inherited')

  await api.del(`/api/webhooks/${campaignHook}`)
})

test('delete: a tombstoned endpoint is gone from every read but its history still counts', async () => {
  const id = await makeHook({
    name: 'Historic', webhook_url: 'https://hooks.example.test/historic', event_types: ['EMAIL_SENT'],
  })
  await fire('sent', {}, stub())
  assert.equal(deliveries(id).length, 1)

  assert.equal((await api.del(`/api/webhooks/${id}`)).status, 200)

  const list = await api.get('/api/webhooks')
  assert.ok(!list.body.data.some((w) => w.id === id), 'the tombstone is filtered from the list')
  assert.equal((await api.get(`/api/webhooks/${id}`)).status, 404)
  assert.equal((await api.patch(`/api/webhooks/${id}`, { name: 'Back' })).status, 404)
  // The row and its deliveries are still there for the audit trail.
  assert.equal(hookRow(id).is_active, -1)
  assert.equal(deliveries(id).length, 1)
  // And the deletion named the host, never the secret.
  const trail = db.prepare(
    "SELECT * FROM events WHERE user_id = ? AND type = 'webhook_deleted' ORDER BY id DESC LIMIT 1"
  ).get(owner.id)
  assert.match(trail.detail, /hooks\.example\.test/)
  assert.doesNotMatch(trail.detail, new RegExp(hookRow(id).secret))
})

test('delete: a cross-workspace webhook id is a 404 that changes nothing', async () => {
  const theirs = db.prepare(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories)
     VALUES (?, NULL, 'Not yours', 'https://hooks.example.test/theirs', 'their-secret', '["sent"]', '[]')`
  ).run(stranger.id).lastInsertRowid

  const res = await api.del(`/api/webhooks/${theirs}`)
  assert.equal(res.status, 404)
  assert.ok(!JSON.stringify(res.body).includes('Not yours'))
  assert.equal(hookRow(theirs).is_active, 1, "another workspace's endpoint was tombstoned")
})

// ============================================================= utilities ====
// Docs/utilities/domain-block-list.md

test('block list: a row carries the source API field names as well as Harry\'s', async () => {
  const added = await api.post('/api/block-list', { domain_block_list: ['audit-competitor.test'] })
  assert.equal(added.status, 200)
  assert.equal(added.body.addedCount, 1)

  const list = await api.get('/api/block-list?search=audit-competitor')
  assert.equal(list.status, 200)
  const row = list.body.data.find((r) => r.value === 'audit-competitor.test')
  assert.ok(row, 'the entry is findable by search')

  // domain-block-list.md AC 1 names these fields exactly.
  assert.equal(row.email_or_domain, 'audit-competitor.test')
  assert.equal(row.created_at, row.createdAt)
  assert.equal(row.client_id, null)
  assert.equal(row.source, 'manual')
  assert.equal(row.sourceLabel, 'Added by you')
  assert.equal(row.is_domain, true)
  // The stored row is what the response describes.
  const stored = db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ?')
    .get(owner.id, 'audit-competitor.test')
  assert.equal(stored.is_domain, 1)
  assert.equal(stored.source, 'manual')
  assert.equal(stored.created_by, owner.email)
})

test('block list: a caller cannot forge the source of an entry', async () => {
  // "Bounced" and "Unsubscribed" mean Harry observed something. A client that
  // could claim them would be able to launder a manual block into evidence.
  const res = await api.post('/api/block-list', {
    domain_block_list: ['forged.test'], source: 'bounced', created_by: 'someone-else@example.com',
  })
  assert.equal(res.status, 200)
  const stored = db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ?')
    .get(owner.id, 'forged.test')
  assert.equal(stored.source, 'manual')
  assert.equal(stored.created_by, owner.email)
})

test('block list: removing an entry makes the address contactable again', async () => {
  await api.post('/api/block-list', { domain_block_list: ['reversible.test'] })
  const stored = db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ?')
    .get(owner.id, 'reversible.test')
  assert.ok(utilities.blockMatch(owner.id, 'ana@reversible.test'), 'blocked while the row exists')

  assert.equal((await api.del(`/api/block-list/${stored.id}`)).status, 200)
  assert.equal(utilities.blockMatch(owner.id, 'ana@reversible.test'), null, 'the block outlived its row')
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM blocked_domains WHERE id = ?').get(stored.id).n, 0
  )
  // Second delete is a 404, which the UI reads as already-removed.
  assert.equal((await api.del(`/api/block-list/${stored.id}`)).status, 404)
})
