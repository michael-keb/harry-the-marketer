// The client lens.
//
// `client_id` was written by every create path and read by nothing, so an
// agency could tag work by client and never filter by it. These tests hold the
// filter honest at the two ends that matter: it must narrow, and it must never
// let one client's records appear under another's name.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedCampaign, seedMailbox, mount } from './helpers/parity-harness.js'

setup('client-lens')

const { db } = await import('../server/db.js')
const { register: registerCampaigns } = await import('../server/parity/campaigns.js')
const { register: registerMailboxes } = await import('../server/parity/mailboxes.js')

const owner = seedUser(db, 'owner@lens.test')
const stranger = seedUser(db, 'stranger@lens.test')
const client = await mount([registerCampaigns, registerMailboxes], owner)
test.after(() => client.close())

function seedClient(wsId, name) {
  const info = db.prepare(
    "INSERT INTO clients (workspace_id, name, email) VALUES (?, ?, ?)"
  ).run(wsId, name, `${name.toLowerCase().replace(/\s+/g, '')}@example.test`)
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid)
}

const northwind = seedClient(owner.id, 'Northwind')
const contoso = seedClient(owner.id, 'Contoso')

// Two campaigns for one client, one for the other, one for nobody — the
// "nobody" case matters: an agency's own work is not a client's work.
const nwA = seedCampaign(db, owner.id, 'NW spring')
const nwB = seedCampaign(db, owner.id, 'NW autumn')
const coA = seedCampaign(db, owner.id, 'Contoso launch')
const houseCampaign = seedCampaign(db, owner.id, 'Our own marketing')
db.prepare('UPDATE campaigns SET client_id = ? WHERE id IN (?, ?)').run(northwind.id, nwA.id, nwB.id)
db.prepare('UPDATE campaigns SET client_id = ? WHERE id = ?').run(contoso.id, coA.id)

const nwBox = seedMailbox(db, owner.id, 'nw@example.com')
const houseBox = seedMailbox(db, owner.id, 'house@example.com')
db.prepare('UPDATE mailboxes SET client_id = ? WHERE id = ?').run(northwind.id, nwBox.id)

test('without a client, the lens shows everything in the workspace', async () => {
  const res = await client.get('/api/campaign-list?limit=50')
  assert.equal(res.status, 200)
  const names = res.body.campaigns.map((c) => c.name)
  assert.equal(names.length, 4)
  assert.ok(names.includes('Our own marketing'), 'the agency\'s own work is not hidden')
})

test('a client narrows campaigns to that client, and excludes unassigned work', async () => {
  const res = await client.get(`/api/campaign-list?clientId=${northwind.id}&limit=50`)
  assert.equal(res.status, 200)
  const names = res.body.campaigns.map((c) => c.name).sort()
  assert.deepEqual(names, ['NW autumn', 'NW spring'])
  assert.equal(res.body.total, 2, 'the total respects the filter, not just the page')
})

test('one client never sees another client\'s campaigns', async () => {
  const res = await client.get(`/api/campaign-list?clientId=${contoso.id}&limit=50`)
  const names = res.body.campaigns.map((c) => c.name)
  assert.deepEqual(names, ['Contoso launch'])
  assert.ok(!names.some((n) => n.startsWith('NW')))
})

test('the lens narrows the mailbox fleet the same way', async () => {
  const all = await client.get('/api/mailboxes/fleet?limit=50')
  assert.equal(all.status, 200)
  const allEmails = (all.body.data || all.body.items).map((m) => m.fromEmail)
  assert.equal(allEmails.length, 2)

  const scoped = await client.get(`/api/mailboxes/fleet?clientId=${northwind.id}&limit=50`)
  const scopedEmails = (scoped.body.data || scoped.body.items).map((m) => m.fromEmail)
  assert.deepEqual(scopedEmails, ['nw@example.com'])
})

test('another workspace\'s client id narrows to nothing rather than leaking', async () => {
  // A client belonging to someone else must not act as a key into this
  // workspace. The workspace scope is applied first, so the worst case is an
  // empty list — never another workspace's rows.
  const theirs = seedClient(stranger.id, 'Their client')
  const res = await client.get(`/api/campaign-list?clientId=${theirs.id}&limit=50`)
  assert.equal(res.status, 200)
  assert.equal(res.body.campaigns.length, 0)
})

test('a malformed client id is refused rather than silently ignored', async () => {
  // Silently dropping it would show every client's work under one client's
  // name, which is the one failure mode this feature must not have.
  const res = await client.get('/api/campaign-list?clientId=not-a-number&limit=50')
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'clientId')
})
