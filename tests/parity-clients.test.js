// clients — agency client workspaces (Docs/clients/*.md).
//
// The two things worth failing loudly on: Harry never accepts a credential, and
// an API key's plaintext exists in exactly one response and nowhere else. Every
// other case here is the usual parity contract — field-named 422s, leak-free
// 404s, and a workspace boundary that holds.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedCampaign, seedLead, seedMessage, mount } from './helpers/parity-harness.js'

setup('clients')

const { db } = await import('../server/db.js')
const { register, resolveClientApiKey } = await import('../server/parity/clients.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// A client belonging to the other agency, created straight in the database so
// no route of ours ever saw it. Every cross-workspace assertion uses this id.
db.prepare("INSERT INTO clients (workspace_id, name, email) VALUES (?, 'Rival Brand', 'rival@example.com')").run(stranger.id)
const foreign = db.prepare('SELECT * FROM clients WHERE workspace_id = ?').get(stranger.id)

const created = []
async function makeClient(body) {
  const res = await client.post('/api/clients', body)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  created.push(res.body.data.id)
  return res.body.data
}

// ---- create -----------------------------------------------------------------

test('empty account lists no clients', async () => {
  const res = await client.get('/api/clients')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, data: [], nextCursor: null, hasMore: false })
})

test('creates a client with permissions, branding and an allowance', async () => {
  const data = await makeClient({
    name: 'Acme Agency',
    email: 'Admin@Acme.com',
    permission: ['campaigns', 'email_accounts', 'leads'],
    is_credit_assigned: true,
    email_credits: 10000,
    lead_credits: 5000,
    color: '#7c3aed',
    logo_url: 'https://cdn.example.com/acme.png',
  })
  assert.ok(data.id)
  assert.equal(data.name, 'Acme Agency')
  assert.equal(data.email, 'admin@acme.com')
  // SmartLead's `email_accounts` maps to Harry's real area name.
  assert.deepEqual(data.permissions, ['campaigns', 'mailboxes', 'leads'])
  assert.deepEqual(data.credits, {
    assigned: true, email_credits: 10000, lead_credits: 5000, source: 'client allowance',
  })
  assert.ok(data.created_at)

  const events = db.prepare("SELECT * FROM events WHERE user_id = ? AND type = 'client_created'").all(owner.id)
  assert.equal(events.length, 1)
  assert.match(events[0].detail, /owner@example\.com created client "Acme Agency"/)
})

test('rejects a password field without storing anything', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM clients WHERE workspace_id = ?').get(owner.id).n
  const res = await client.post('/api/clients', {
    name: 'Password Brand', email: 'pw@example.com', password: 'hunter2',
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'password')
  assert.match(res.body.message, /Auth0/)
  assert.doesNotMatch(JSON.stringify(res.body), /hunter2/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients WHERE workspace_id = ?').get(owner.id).n, before)
  // Nothing password-shaped anywhere in the trail.
  const trail = db.prepare('SELECT detail FROM events WHERE user_id = ?').all(owner.id).map((e) => e.detail).join(' ')
  assert.doesNotMatch(trail, /hunter2|password/i)
})

test('password is rejected before any other validation, and on update too', async () => {
  const bare = await client.post('/api/clients', { password: 'hunter2' })
  assert.equal(bare.status, 422)
  assert.equal(bare.body.field, 'password')

  const onUpdate = await client.patch(`/api/clients/${created[0]}`, { name: 'Renamed', password: 'hunter2' })
  assert.equal(onUpdate.status, 422)
  assert.equal(onUpdate.body.field, 'password')
  const row = db.prepare('SELECT name FROM clients WHERE id = ?').get(created[0])
  assert.equal(row.name, 'Acme Agency')
})

test('names the missing field on an incomplete create', async () => {
  const res = await client.post('/api/clients', { name: 'No Contact' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'email')
})

test('rejects an unknown permission and lists the valid areas', async () => {
  const res = await client.post('/api/clients', {
    name: 'Everything Brand', email: 'everything@example.com', permission: ['everything'],
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'permission')
  assert.match(res.body.message, /campaigns, mailboxes, leads, inbox, reports/)
})

test('rejects an oversized logo without writing a partial record', async () => {
  const res = await client.post('/api/clients', {
    name: 'Huge Logo', email: 'logo@example.com', logo: 'A'.repeat(200_001),
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'logo')
  assert.match(res.body.message, /150 KB/)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE name = 'Huge Logo'").get().n, 0)
})

test('ignores credits when the assignment flag is absent', async () => {
  const data = await makeClient({ name: 'Pool Brand', email: 'pool@example.com', email_credits: 10000 })
  assert.equal(data.credits.assigned, false)
  assert.equal(data.credits.email_credits, 0)
  assert.match(data.credits.note, /agency pool/)
})

test('duplicate client name conflicts', async () => {
  const res = await client.post('/api/clients', { name: 'acme agency', email: 'another@acme.com' })
  assert.equal(res.status, 409)
  assert.equal(res.body.field, 'name')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE lower(name) = 'acme agency'").get().n, 1)
})

test('duplicate contact email is a 422 naming the field', async () => {
  const res = await client.post('/api/clients', { name: 'Acme Two', email: 'admin@acme.com' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'email')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE email = 'admin@acme.com'").get().n, 1)
})

test('a team member email cannot double as a client contact', async () => {
  db.prepare("INSERT INTO team_members (owner_id, email, role) VALUES (?, 'colleague@example.com', 'member')").run(owner.id)
  const res = await client.post('/api/clients', { name: 'Colleague Brand', email: 'colleague@example.com' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'email')
  assert.match(res.body.message, /team member/)
})

test('an id in the create body points at the update route instead of creating', async () => {
  const res = await client.post('/api/clients', { id: created[0], name: 'Acme Agency', email: 'admin@acme.com' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'id')
  assert.match(res.body.message, /PATCH \/api\/clients/)
})

// ---- list -------------------------------------------------------------------

test('lists clients newest first with exactly the four light fields', async () => {
  const res = await client.get('/api/clients')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.data.length, 2)
  assert.deepEqual(Object.keys(res.body.data[0]).sort(), ['created_at', 'email', 'id', 'name'])
  assert.equal(res.body.data[0].name, 'Pool Brand') // newest first
  // No branding, permissions or allowance leaks into the switcher's payload.
  assert.doesNotMatch(JSON.stringify(res.body), /permissions|credits|logo_url|color/)
})

test('another agency\'s clients are absent from the list', async () => {
  const res = await client.get('/api/clients')
  assert.equal(res.status, 200)
  assert.ok(!res.body.data.some((c) => c.id === foreign.id))
  assert.doesNotMatch(JSON.stringify(res.body), /Rival Brand/)
})

test('a stray parameter is ignored rather than breaking the list', async () => {
  const res = await client.get('/api/clients?clientId=abc')
  assert.equal(res.status, 200)
  assert.equal(res.body.data.length, 2)
})

// ---- update -----------------------------------------------------------------

test('partial update merges and leaves untouched fields alone', async () => {
  const res = await client.patch(`/api/clients/${created[0]}`, { name: 'Acme Agency Updated' })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.name, 'Acme Agency Updated')
  assert.equal(res.body.data.email, 'admin@acme.com')
  assert.deepEqual(res.body.data.permissions, ['campaigns', 'mailboxes', 'leads'])
  assert.equal(res.body.data.credits.email_credits, 10000)
  assert.equal(res.body.changed, true)
})

test('an identical save is a no-op with no activity-trail entry', async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'client_updated'").get(owner.id).n
  const res = await client.patch(`/api/clients/${created[0]}`, { name: 'Acme Agency Updated' })
  assert.equal(res.status, 200)
  assert.equal(res.body.changed, false)
  const after = db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'client_updated'").get(owner.id).n
  assert.equal(after, before)
})

test('removing a permission is recorded with who did it', async () => {
  const res = await client.patch(`/api/clients/${created[0]}`, { permission: ['campaigns', 'leads'] })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data.permissions, ['campaigns', 'leads'])
  const entry = db.prepare("SELECT * FROM events WHERE user_id = ? AND type = 'client_updated' ORDER BY id DESC LIMIT 1").get(owner.id)
  assert.match(entry.detail, /owner@example\.com/)
  assert.match(entry.detail, /-mailboxes/)
})

test('changing a contact email to one already in use fails on the field', async () => {
  const res = await client.patch(`/api/clients/${created[0]}`, { email: 'pool@example.com' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'email')
  assert.equal(db.prepare('SELECT email FROM clients WHERE id = ?').get(created[0]).email, 'admin@acme.com')
  assert.equal(db.prepare('SELECT email FROM clients WHERE id = ?').get(created[1]).email, 'pool@example.com')
})

test('an unknown or cross-workspace client id 404s without leaking', async () => {
  for (const id of [foreign.id, 999999]) {
    const read = await client.get(`/api/clients/${id}`)
    assert.equal(read.status, 404)
    assert.doesNotMatch(JSON.stringify(read.body), /Rival Brand|rival@example\.com/)

    const patched = await client.patch(`/api/clients/${id}`, { name: 'Hijacked' })
    assert.equal(patched.status, 404)

    const keys = await client.get(`/api/clients/${id}/api-keys`)
    assert.equal(keys.status, 404)

    const minted = await client.post(`/api/clients/${id}/api-keys`, { keyName: 'Sneaky' })
    assert.equal(minted.status, 404)
  }
  // Nothing was created for the other agency along the way.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_api_keys').get().n, 0)
  assert.equal(db.prepare('SELECT name FROM clients WHERE id = ?').get(foreign.id).name, 'Rival Brand')
})

// ---- api keys ---------------------------------------------------------------

let productionKey = null

test('mints a key, shows the value exactly once, and never again', async () => {
  const res = await client.post(`/api/clients/${created[0]}/api-keys`, { keyName: 'Production Key', scope: 'write' })
  assert.equal(res.status, 200)
  assert.ok(res.body.data.api_key)
  assert.equal(res.body.data.status, 'active')
  assert.equal(res.body.data.scope, 'write')
  assert.equal(res.body.data.never_used, true)
  assert.equal(res.body.data.last_used_at, null)
  assert.match(res.body.notice, /only time/i)
  productionKey = { id: res.body.data.id, value: res.body.data.api_key, prefix: res.body.data.key_prefix }

  // The stored row holds a hash, not the value.
  const row = db.prepare('SELECT * FROM client_api_keys WHERE id = ?').get(productionKey.id)
  assert.notEqual(row.key_hash, productionKey.value)
  assert.equal(row.key_hash.length, 64)
  assert.ok(productionKey.value.startsWith(row.key_prefix))

  // And no later read hands it back.
  const list = await client.get(`/api/clients/${created[0]}/api-keys`)
  assert.equal(list.status, 200)
  assert.equal(list.body.data.length, 1)
  assert.equal(list.body.data[0].api_key, undefined)
  assert.doesNotMatch(JSON.stringify(list.body), new RegExp(productionKey.value))
  assert.doesNotMatch(JSON.stringify(list.body), new RegExp(row.key_hash))
  assert.doesNotMatch(JSON.stringify(list.body), /key_hash/)
})

test('key creation is never logged with the value', () => {
  const trail = db.prepare("SELECT detail FROM events WHERE user_id = ? AND type LIKE 'client_api_key%'").all(owner.id)
  assert.ok(trail.length >= 1)
  const joined = trail.map((e) => e.detail).join(' ')
  assert.doesNotMatch(joined, new RegExp(productionKey.value))
  assert.match(joined, /Production Key/)
})

test('rejects a key name outside the documented character set', async () => {
  const res = await client.post(`/api/clients/${created[0]}/api-keys`, { keyName: 'prod/key!' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'keyName')
  assert.match(res.body.message, /letters, numbers, spaces, hyphens and underscores/)
})

test('resolves a live key and stamps last_used_at', () => {
  const resolved = resolveClientApiKey(productionKey.value)
  assert.ok(resolved)
  assert.equal(resolved.clientId, created[0])
  assert.equal(resolved.wsId, owner.id)
  assert.equal(resolved.scope, 'write')
  assert.equal(JSON.stringify(resolved.key).includes('key_hash'), false)
  const row = db.prepare('SELECT last_used_at FROM client_api_keys WHERE id = ?').get(productionKey.id)
  assert.ok(row.last_used_at)
})

test('last_used_at writes are throttled to once a minute', () => {
  db.prepare("UPDATE client_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(productionKey.id)
  const first = db.prepare('SELECT last_used_at FROM client_api_keys WHERE id = ?').get(productionKey.id).last_used_at
  // A stamp from an hour ago is refreshed; a fresh one is left alone.
  resolveClientApiKey(productionKey.value)
  assert.equal(db.prepare('SELECT last_used_at FROM client_api_keys WHERE id = ?').get(productionKey.id).last_used_at, first)

  db.prepare("UPDATE client_api_keys SET last_used_at = '2020-01-01 00:00:00' WHERE id = ?").run(productionKey.id)
  resolveClientApiKey(productionKey.value)
  const refreshed = db.prepare('SELECT last_used_at FROM client_api_keys WHERE id = ?').get(productionKey.id).last_used_at
  assert.notEqual(refreshed, '2020-01-01 00:00:00')
})

test('a garbage or foreign key value resolves to nothing', () => {
  assert.equal(resolveClientApiKey('nonsense'), null)
  assert.equal(resolveClientApiKey(`${productionKey.prefix}_${'0'.repeat(48)}`), null)
  assert.equal(resolveClientApiKey(''), null)
})

test('reset keeps the id and name, kills the old value and shows the new one once', async () => {
  const res = await client.post(`/api/api-keys/${productionKey.id}/reset`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.id, productionKey.id)
  assert.equal(res.body.data.key_name, 'Production Key')
  assert.ok(res.body.data.api_key)
  assert.notEqual(res.body.data.api_key, productionKey.value)

  assert.equal(resolveClientApiKey(productionKey.value), null)
  assert.ok(resolveClientApiKey(res.body.data.api_key))
  productionKey = { id: res.body.data.id, value: res.body.data.api_key, prefix: res.body.data.key_prefix }

  const list = await client.get(`/api/clients/${created[0]}/api-keys`)
  assert.doesNotMatch(JSON.stringify(list.body), new RegExp(productionKey.value))
})

test('filters keys by status and by partial, case-insensitive name', async () => {
  const staging = await client.post(`/api/clients/${created[0]}/api-keys`, { keyName: 'Staging' })
  assert.equal(staging.status, 200)

  const revoked = await client.del(`/api/api-keys/${staging.body.data.id}`)
  assert.equal(revoked.status, 200)
  assert.equal(revoked.body.data.status, 'revoked')
  assert.ok(revoked.body.data.revoked_at)

  const active = await client.get(`/api/clients/${created[0]}/api-keys?status=active`)
  assert.deepEqual(active.body.data.map((k) => k.key_name), ['Production Key'])

  const inactive = await client.get(`/api/clients/${created[0]}/api-keys?status=inactive`)
  assert.deepEqual(inactive.body.data.map((k) => k.key_name), ['Staging'])

  // Default listing is the active set: a revoked key is not a live key.
  const dflt = await client.get(`/api/clients/${created[0]}/api-keys`)
  assert.deepEqual(dflt.body.data.map((k) => k.key_name), ['Production Key'])

  const search = await client.get(`/api/clients/${created[0]}/api-keys?status=all&keyName=prod`)
  assert.deepEqual(search.body.data.map((k) => k.key_name), ['Production Key'])
})

test('a revoked key is dead on the very next resolution', async () => {
  const minted = await client.post(`/api/clients/${created[0]}/api-keys`, { keyName: 'Short Lived' })
  const value = minted.body.data.api_key
  assert.ok(resolveClientApiKey(value))
  await client.del(`/api/api-keys/${minted.body.data.id}`)
  assert.equal(resolveClientApiKey(value), null)

  const trail = db.prepare("SELECT detail FROM events WHERE user_id = ? AND type = 'client_api_key_revoked' ORDER BY id DESC LIMIT 1").get(owner.id)
  assert.match(trail.detail, /owner@example\.com revoked API key "Short Lived"/)
  assert.doesNotMatch(trail.detail, new RegExp(value))
})

test('a key belonging to another workspace is invisible', async () => {
  db.prepare(
    `INSERT INTO client_api_keys (workspace_id, client_id, key_name, key_prefix, key_hash) VALUES (?, ?, 'Rival Key', 'htmk_deadbeef00', '${'ab'.repeat(32)}')`
  ).run(stranger.id, foreign.id)
  const rival = db.prepare("SELECT id FROM client_api_keys WHERE key_name = 'Rival Key'").get()
  assert.equal((await client.del(`/api/api-keys/${rival.id}`)).status, 404)
  assert.equal((await client.post(`/api/api-keys/${rival.id}/reset`)).status, 404)
  assert.equal(db.prepare('SELECT status FROM client_api_keys WHERE id = ?').get(rival.id).status, 'active')
})

// ---- client scope -----------------------------------------------------------

test('attaches campaigns and leads to a client, all or nothing', async () => {
  const campaign = seedCampaign(db, owner.id, 'Acme Q3')
  const lead = seedLead(db, owner.id, 'ada@acme.test')
  const strangerLead = seedLead(db, stranger.id, 'rival@rival.test')

  const rejected = await client.post(`/api/clients/${created[0]}/scope`, {
    campaignIds: [campaign.id], leadIds: [lead.id, strangerLead.id],
  })
  assert.equal(rejected.status, 404)
  assert.equal(rejected.body.id, strangerLead.id)
  // Nothing applied: the campaign in the same request is untouched.
  assert.equal(db.prepare('SELECT client_id FROM campaigns WHERE id = ?').get(campaign.id).client_id, null)

  const ok = await client.post(`/api/clients/${created[0]}/scope`, {
    campaignIds: [campaign.id], leadIds: [lead.id],
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body.counts, { campaigns: 1, leads: 1, mailboxes: 0 })
  assert.equal(db.prepare('SELECT client_id FROM campaigns WHERE id = ?').get(campaign.id).client_id, created[0])

  // One events row for the bulk action, not one per record.
  const rows = db.prepare("SELECT * FROM events WHERE user_id = ? AND type = 'client_scope_attached'").all(owner.id)
  assert.equal(rows.length, 1)

  const listed = await client.get(`/api/clients/${created[0]}/scope/leads`)
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.data.map((l) => l.email), ['ada@acme.test'])

  const detached = await client.del(`/api/clients/${created[0]}/scope`, { leadIds: [lead.id] })
  assert.equal(detached.status, 200)
  assert.equal(detached.body.counts.leads, 0)
  assert.equal(db.prepare('SELECT client_id FROM leads WHERE id = ?').get(lead.id).client_id, null)
})

test('deleting a client releases its rows and kills its keys', async () => {
  const target = await makeClient({ name: 'Doomed Brand', email: 'doomed@example.com' })
  const campaign = seedCampaign(db, owner.id, 'Doomed Q4')
  await client.post(`/api/clients/${target.id}/scope`, { campaignIds: [campaign.id] })
  const key = await client.post(`/api/clients/${target.id}/api-keys`, { keyName: 'Doomed Key' })
  const value = key.body.data.api_key

  const res = await client.del(`/api/clients/${target.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.released.campaigns, 1)
  assert.equal(resolveClientApiKey(value), null)
  assert.equal(db.prepare('SELECT client_id FROM campaigns WHERE id = ?').get(campaign.id).client_id, null)

  const list = await client.get('/api/clients')
  assert.ok(!list.body.data.some((c) => c.id === target.id))
  assert.equal((await client.get(`/api/clients/${target.id}`)).status, 404)
})

test('an allowance lowered below usage is accepted and stated, not refused', async () => {
  const brand = await makeClient({ name: 'Busy Brand', email: 'busy@example.com' })
  const campaign = seedCampaign(db, owner.id, 'Busy Q1')
  await client.post(`/api/clients/${brand.id}/scope`, { campaignIds: [campaign.id] })
  for (let i = 0; i < 3; i += 1) seedMessage(db, owner.id, { campaignId: campaign.id, direction: 'out' })

  const res = await client.patch(`/api/clients/${brand.id}`, {
    is_credit_assigned: true, email_credits: 1, lead_credits: 0,
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.credits.email_credits, 1)
  assert.deepEqual(
    { used: res.body.overAllowance.used, allowed: res.body.overAllowance.allowed },
    { used: 3, allowed: 1 }
  )
  const entry = db.prepare("SELECT * FROM events WHERE user_id = ? AND type = 'client_over_allowance' ORDER BY id DESC LIMIT 1").get(owner.id)
  assert.match(entry.detail, /Busy Brand" is over its allowance: 3 of 1/)
})

// ---- the standing guarantee -------------------------------------------------

test('no stored key hash appears in any response body', async () => {
  const hashes = db.prepare('SELECT key_hash FROM client_api_keys').all().map((r) => r.key_hash).filter(Boolean)
  assert.ok(hashes.length >= 2)
  const bodies = []
  bodies.push(await client.get('/api/clients'))
  bodies.push(await client.get(`/api/clients/${created[0]}`))
  bodies.push(await client.get(`/api/clients/${created[0]}/api-keys?status=all`))
  bodies.push(await client.get(`/api/clients/${created[0]}/scope`))
  bodies.push(await client.patch(`/api/clients/${created[0]}`, { color: '#111111' }))
  const blob = JSON.stringify(bodies.map((b) => b.body))
  for (const hash of hashes) assert.doesNotMatch(blob, new RegExp(hash))
  assert.doesNotMatch(blob, /key_hash|password/)
})
