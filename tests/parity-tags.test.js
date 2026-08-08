// Labels — Docs/lead-tags/* and Docs/email-account-tags/*.
//
// The cases the specs single out: the shared (workspace, applies_to, name) key
// keeping a lead label and a mailbox label of the same name apart, repeat adds
// being no-ops, mapping ids being distinct from tag ids, and the all-or-nothing
// rule (lead-tags/add-to-lead TC-8) that one bad id in a batch writes nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedMailbox, seedTag, mount } from './helpers/parity-harness.js'

setup('tags')                       // MUST run before importing ../server/*
const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/tags.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)

// Fixtures. The stranger's records exist only to be refused.
const lead = seedLead(db, owner.id, 'ada@acme.test')
const lead2 = seedLead(db, owner.id, 'grace@acme.test')
const lead3 = seedLead(db, owner.id, 'alan@acme.test')
const foreignLead = seedLead(db, stranger.id, 'mallory@evil.test', { first_name: 'Mallory', company: 'Evil Corp' })
const box1 = seedMailbox(db, owner.id, 'one@sender.test')
const box2 = seedMailbox(db, owner.id, 'two@sender.test')
const foreignBox = seedMailbox(db, stranger.id, 'foreign@sender.test')
const foreignTag = seedTag(db, stranger.id, 'Foreign', 'lead')

const eventCount = () => db.prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ?').get(owner.id).n

// ---- POST /api/tags -----------------------------------------------------------

test('creates a lead label with an explicit colour', async () => {
  const res = await client.post('/api/tags', { appliesTo: 'lead', name: 'VIP', color: '#FF5733' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.data.name, 'VIP')
  assert.equal(res.body.data.color, '#ff5733')      // normalised to lowercase
  assert.equal(res.body.data.appliesTo, 'lead')
  assert.ok(res.body.data.id > 0)
})

test('assigns a deterministic default colour when none is given', async () => {
  const first = await client.post('/api/tags', { appliesTo: 'lead', name: 'Client A' })
  assert.equal(first.status, 200)
  assert.match(first.body.data.color, /^#[0-9a-f]{6}$/)

  // Delete and recreate: the same name in the same workspace state must yield
  // the same swatch, which is what makes the default reproducible in a test.
  await client.del(`/api/tags/${first.body.data.id}`)
  const again = await client.post('/api/tags', { appliesTo: 'lead', name: 'Client A' })
  assert.equal(again.body.data.color, first.body.data.color)
  await client.del(`/api/tags/${again.body.data.id}`)
})

test('rejects a malformed colour and a missing name with a 422 naming the field', async () => {
  const badColor = await client.post('/api/tags', { appliesTo: 'lead', name: 'X', color: 'red' })
  assert.equal(badColor.status, 422)
  assert.equal(badColor.body.field, 'color')

  const shortHex = await client.post('/api/tags', { appliesTo: 'lead', name: 'X', color: '#FFF' })
  assert.equal(shortHex.status, 422)
  assert.equal(shortHex.body.field, 'color')

  const noName = await client.post('/api/tags', { appliesTo: 'lead', color: '#FF5733' })
  assert.equal(noName.status, 422)
  assert.equal(noName.body.field, 'name')

  const longName = await client.post('/api/tags', { appliesTo: 'lead', name: 'n'.repeat(200) })
  assert.equal(longName.status, 422)
  assert.equal(longName.body.field, 'name')
})

test('requires appliesTo, so a label never exists without knowing what it labels', async () => {
  const res = await client.post('/api/tags', { name: 'Orphan', color: '#4CAF50' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'appliesTo')

  const wrong = await client.post('/api/tags', { appliesTo: 'campaign', name: 'Orphan' })
  assert.equal(wrong.status, 422)
  assert.equal(wrong.body.field, 'appliesTo')
})

test('refuses a duplicate name with 409 carrying the existing label', async () => {
  const res = await client.post('/api/tags', { appliesTo: 'lead', name: '  vip  ', color: '#4CAF50' })
  assert.equal(res.status, 409)
  assert.equal(res.body.field, 'name')
  assert.ok(res.body.id > 0, 'the existing label id is handed back so the picker can open it')
  const rows = db.prepare("SELECT COUNT(*) AS n FROM tags WHERE workspace_id = ? AND applies_to = 'lead'").get(owner.id).n
  assert.equal(rows, 1, 'no lookalike was created')
})

test('a mailbox label may share a name with a lead label', async () => {
  const res = await client.post('/api/tags', { appliesTo: 'mailbox', name: 'VIP', color: '#4CAF50' })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.appliesTo, 'mailbox')

  const leadPicker = await client.get('/api/tags?appliesTo=lead')
  assert.deepEqual(leadPicker.body.data.map((t) => t.appliesTo), ['lead'])
  const boxPicker = await client.get('/api/tags?appliesTo=mailbox')
  assert.deepEqual(boxPicker.body.data.map((t) => t.appliesTo), ['mailbox'])

  await client.del(`/api/tags/${res.body.data.id}`)
})

// ---- PUT /api/tags/:id --------------------------------------------------------

test('renames a label without disturbing its mappings', async () => {
  const created = await client.post('/api/tags', { appliesTo: 'lead', name: 'Enterprise', color: '#4CAF50' })
  const tagId = created.body.data.id
  await client.post(`/api/leads/${lead.id}/tags`, { tagIds: [tagId] })
  await client.post(`/api/leads/${lead2.id}/tags`, { tagIds: [tagId] })

  const res = await client.put(`/api/tags/${tagId}`, { name: 'Priority', color: '#0891B2' })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.name, 'Priority')
  assert.equal(res.body.data.color, '#0891b2')

  const mapped = db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE tag_id = ?').get(tagId).n
  assert.equal(mapped, 2, 'renaming re-tagged nothing')

  // Clean up so later counts are predictable.
  await client.del(`/api/tags/${tagId}`)
})

test('update requires both name and colour and validates the hex', async () => {
  const tag = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const noColor = await client.put(`/api/tags/${tag.id}`, { name: 'VIP' })
  assert.equal(noColor.status, 422)
  assert.equal(noColor.body.field, 'color')

  const badColor = await client.put(`/api/tags/${tag.id}`, { name: 'VIP', color: 'green' })
  assert.equal(badColor.status, 422)
  assert.equal(badColor.body.field, 'color')

  const noName = await client.put(`/api/tags/${tag.id}`, { name: '', color: '#4CAF50' })
  assert.equal(noName.status, 422)
  assert.equal(noName.body.field, 'name')
})

test('a lead label cannot be edited through the mailbox panel, and appliesTo is immutable', async () => {
  const tag = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const res = await client.put(`/api/tags/${tag.id}`, { appliesTo: 'mailbox', name: 'VIP', color: '#4CAF50' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'appliesTo')
  const after = db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id)
  assert.equal(after.applies_to, 'lead')
})

test("another workspace's label 404s on update and is left untouched", async () => {
  const res = await client.put(`/api/tags/${foreignTag.id}`, { name: 'Stolen', color: '#4CAF50' })
  assert.equal(res.status, 404)
  assert.ok(!JSON.stringify(res.body).includes('Foreign'), 'the label name is not leaked')
  const after = db.prepare('SELECT * FROM tags WHERE id = ?').get(foreignTag.id)
  assert.equal(after.name, 'Foreign')
})

test('a rename onto another label\'s name is refused with 409', async () => {
  const other = await client.post('/api/tags', { appliesTo: 'lead', name: 'Warm', color: '#059669' })
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const res = await client.put(`/api/tags/${other.body.data.id}`, { name: 'vip', color: '#059669' })
  assert.equal(res.status, 409)
  assert.equal(res.body.field, 'name')
  assert.equal(res.body.id, vip.id)
  await client.del(`/api/tags/${other.body.data.id}`)
})

// ---- lead tagging -------------------------------------------------------------

test('adds labels to a lead, idempotently', async () => {
  const enterprise = await client.post('/api/tags', { appliesTo: 'lead', name: 'Enterprise', color: '#4CAF50' })
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const tagIds = [vip.id, enterprise.body.data.id]

  const first = await client.post(`/api/leads/${lead.id}/tags`, { tagIds })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.message, 'Tags added to lead successfully')

  const again = await client.post(`/api/leads/${lead.id}/tags`, { tagIds })
  assert.equal(again.status, 200, 'repeating is safe')
  assert.equal(again.body.added, 0)

  const rows = db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE lead_id = ?').get(lead.id).n
  assert.equal(rows, 2, 'two labels, not four')
})

test('reads a lead\'s labels with a mapping id distinct from the tag id', async () => {
  const res = await client.get(`/api/tags?leadId=${lead.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.length, 2)
  for (const chip of res.body.data) {
    assert.ok(chip.id > 0 && chip.mappingId > 0)
    assert.ok(chip.name && chip.color)
  }
  const mapping = db.prepare('SELECT id FROM lead_tags WHERE lead_id = ? ORDER BY id').all(lead.id)
  assert.deepEqual(res.body.data.map((c) => c.mappingId), mapping.map((m) => m.id))
})

test('a lead carrying no labels returns an empty array', async () => {
  const res = await client.get(`/api/tags?leadId=${lead3.id}`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data, [])
})

test('empty tagIds is a 422 naming the field', async () => {
  const res = await client.post(`/api/leads/${lead.id}/tags`, { tagIds: [] })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'tagIds')

  const missing = await client.post(`/api/leads/${lead.id}/tags`, {})
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'tagIds')
})

test('a non-numeric leadId is a 422, a foreign leadId a 404 that leaks nothing', async () => {
  const bad = await client.get('/api/tags?leadId=abc')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'leadId')

  const foreign = await client.get(`/api/tags?leadId=${foreignLead.id}`)
  assert.equal(foreign.status, 404)
  const body = JSON.stringify(foreign.body)
  assert.ok(!body.includes('Mallory') && !body.includes('Evil'), 'no lead details in the body')
})

test('tagging a foreign lead writes nothing', async () => {
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const res = await client.post(`/api/leads/${foreignLead.id}/tags`, { tagIds: [vip.id] })
  assert.equal(res.status, 404)
  const rows = db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE lead_id = ?').get(foreignLead.id).n
  assert.equal(rows, 0)
})

test('TC-8: one unknown tag id aborts the whole request', async () => {
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const before = db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE lead_id = ?').get(lead3.id).n
  const res = await client.post(`/api/leads/${lead3.id}/tags`, { tagIds: [vip.id, 999999] })
  assert.equal(res.status, 404)
  assert.equal(res.body.id, 999999, 'the 404 names the rejected id')
  const after = db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE lead_id = ?').get(lead3.id).n
  assert.equal(after, before, 'the valid label was not applied either')
})

test('a cross-workspace tag id aborts the whole request', async () => {
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const res = await client.post(`/api/leads/${lead3.id}/tags`, { tagIds: [vip.id, foreignTag.id] })
  assert.equal(res.status, 404)
  assert.equal(res.body.id, foreignTag.id)
  const after = db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE lead_id = ?').get(lead3.id).n
  assert.equal(after, 0)
})

test('a mailbox label cannot be stuck on a lead', async () => {
  const boxTag = await client.post('/api/tags', { appliesTo: 'mailbox', name: 'Primary Senders', color: '#4CAF50' })
  const res = await client.post(`/api/leads/${lead3.id}/tags`, { tagIds: [boxTag.body.data.id] })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'tagIds')
})

test('bulk tagging writes one events row, not one per lead', async () => {
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const before = eventCount()
  const res = await client.post('/api/leads/tags', {
    leadIds: [lead.id, lead2.id, lead3.id],
    tagIds: [vip.id],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.leads, 3)
  assert.equal(eventCount() - before, 1, 'one row for the bulk action')
  for (const id of [lead.id, lead2.id, lead3.id]) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE lead_id = ? AND tag_id = ?').get(id, vip.id).n
    assert.equal(n, 1)
  }
})

test('bulk tagging with a foreign lead in the batch writes nothing', async () => {
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const fresh = seedLead(db, owner.id, 'fresh@acme.test')
  const res = await client.post('/api/leads/tags', {
    leadIds: [fresh.id, foreignLead.id],
    tagIds: [vip.id],
  })
  assert.equal(res.status, 404)
  assert.equal(res.body.id, foreignLead.id)
  const n = db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE lead_id = ?').get(fresh.id).n
  assert.equal(n, 0)
})

// ---- removing a lead label ----------------------------------------------------

test('removes one mapping and leaves the label and other leads alone', async () => {
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const mapping = db.prepare('SELECT * FROM lead_tags WHERE lead_id = ? AND tag_id = ?').get(lead.id, vip.id)

  const res = await client.del(`/api/leads/tags/${mapping.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.message, 'Tag removed from lead successfully')

  assert.ok(db.prepare('SELECT * FROM tags WHERE id = ?').get(vip.id), 'the label itself survives')
  const other = db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE lead_id = ? AND tag_id = ?').get(lead2.id, vip.id).n
  assert.equal(other, 1, 'other leads keep it')

  const repeat = await client.del(`/api/leads/tags/${mapping.id}`)
  assert.equal(repeat.status, 404, 'a second removal reads as already-removed')
})

test('TC-7: passing a tag id where a mapping id belongs is a 404, not a wrong deletion', async () => {
  // Both are plausible-looking numbers, so the fixture deliberately hunts for a
  // tag id that is NOT also a live mapping id — the exact confusion under test.
  let tagId = 0
  for (let i = 0; i < 20; i++) {
    const made = await client.post('/api/tags', { appliesTo: 'lead', name: `probe-${i}` })
    tagId = made.body.data.id
    if (!db.prepare('SELECT 1 FROM lead_tags WHERE id = ?').get(tagId)) break
  }
  assert.ok(!db.prepare('SELECT 1 FROM lead_tags WHERE id = ?').get(tagId))

  const before = db.prepare('SELECT COUNT(*) AS n FROM lead_tags').get().n
  const res = await client.del(`/api/leads/tags/${tagId}`)
  assert.equal(res.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_tags').get().n, before, 'nothing was deleted')

  const bad = await client.del('/api/leads/tags/abc')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'mappingId')
})

test("another workspace's mapping 404s", async () => {
  db.prepare('INSERT INTO lead_tags (workspace_id, lead_id, tag_id) VALUES (?, ?, ?)')
    .run(stranger.id, foreignLead.id, foreignTag.id)
  const mapping = db.prepare('SELECT * FROM lead_tags WHERE lead_id = ?').get(foreignLead.id)

  const res = await client.del(`/api/leads/tags/${mapping.id}`)
  assert.equal(res.status, 404)
  assert.ok(db.prepare('SELECT 1 FROM lead_tags WHERE id = ?').get(mapping.id), 'their mapping survives')
})

test('bulk removal strips a label from many leads in one transaction', async () => {
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP'").get(owner.id)
  const before = eventCount()
  const res = await client.del('/api/leads/tags/bulk', { leadIds: [lead2.id, lead3.id], tagIds: [vip.id] })
  assert.equal(res.status, 200)
  assert.equal(res.body.removed, 2)
  assert.equal(eventCount() - before, 1, 'one row for the bulk removal')

  // Idempotent: removing what is no longer there still succeeds.
  const again = await client.del('/api/leads/tags/bulk', { leadIds: [lead2.id, lead3.id], tagIds: [vip.id] })
  assert.equal(again.status, 200)
  assert.equal(again.body.removed, 0)
  assert.ok(db.prepare('SELECT 1 FROM tags WHERE id = ?').get(vip.id), 'the label survives at a count of zero')
})

// ---- mailbox tagging ----------------------------------------------------------

test('assigns mailbox labels in a batch, idempotently', async () => {
  const senders = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'Primary Senders'").get(owner.id)
  const second = await client.post('/api/tags', { appliesTo: 'mailbox', name: 'Client A', color: '#db2777' })

  const before = eventCount()
  const res = await client.post('/api/tags/assign', {
    appliesTo: 'mailbox',
    mailboxIds: [box1.id, box2.id],
    tagIds: [senders.id, second.body.data.id],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.message, 'Tags assigned successfully')
  assert.equal(res.body.assigned, 4)
  assert.equal(eventCount() - before, 1, 'one row per batch, not per pairing')

  const again = await client.post('/api/tags/assign', {
    mailboxIds: [box1.id, box2.id],
    tagIds: [senders.id, second.body.data.id],
  })
  assert.equal(again.status, 200)
  assert.equal(again.body.assigned, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailbox_tag_map').get().n, 4)
})

test('the batch bounds are enforced server-side with a field-level 422', async () => {
  const senders = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'Primary Senders'").get(owner.id)
  const tooMany = await client.post('/api/tags/assign', {
    mailboxIds: Array.from({ length: 26 }, (_, i) => i + 1),
    tagIds: [senders.id],
  })
  assert.equal(tooMany.status, 422)
  assert.equal(tooMany.body.field, 'mailboxIds')
  assert.match(tooMany.body.message, /25/)

  const noMailboxes = await client.post('/api/tags/assign', { mailboxIds: [], tagIds: [senders.id] })
  assert.equal(noMailboxes.status, 422)
  assert.equal(noMailboxes.body.field, 'mailboxIds')

  const noTags = await client.post('/api/tags/assign', { mailboxIds: [box1.id], tagIds: [] })
  assert.equal(noTags.status, 422)
  assert.equal(noTags.body.field, 'tagIds')
})

test('a lead label is refused for mailbox assignment', async () => {
  const vip = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'VIP' AND applies_to = 'lead'").get(owner.id)
  const res = await client.post('/api/tags/assign', { mailboxIds: [box1.id], tagIds: [vip.id] })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'tagIds')
})

test('a cross-workspace mailbox anywhere in the batch rolls the whole thing back', async () => {
  const senders = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'Primary Senders'").get(owner.id)
  const fresh = seedMailbox(db, owner.id, 'three@sender.test')
  const res = await client.post('/api/tags/assign', {
    mailboxIds: [fresh.id, foreignBox.id],
    tagIds: [senders.id],
  })
  assert.equal(res.status, 404)
  assert.equal(res.body.id, foreignBox.id)
  const n = db.prepare('SELECT COUNT(*) AS n FROM mailbox_tag_map WHERE mailbox_id = ?').get(fresh.id).n
  assert.equal(n, 0, 'nothing assigned for the valid id either')
})

test('removal deletes mappings only and is idempotent', async () => {
  const senders = db.prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = 'Primary Senders'").get(owner.id)
  const tagsBefore = db.prepare('SELECT COUNT(*) AS n FROM tags WHERE workspace_id = ?').get(owner.id).n

  const res = await client.del('/api/tags/assign', { mailboxIds: [box1.id, box2.id], tagIds: [senders.id] })
  assert.equal(res.status, 200)
  assert.equal(res.body.message, 'Tags removed successfully')
  assert.equal(res.body.removed, 2)

  const again = await client.del('/api/tags/assign', { mailboxIds: [box1.id, box2.id], tagIds: [senders.id] })
  assert.equal(again.status, 200)
  assert.equal(again.body.removed, 0, 'removing what is not there still succeeds')

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags WHERE workspace_id = ?').get(owner.id).n, tagsBefore,
    'the tags table is untouched by a removal')
  assert.ok(db.prepare('SELECT 1 FROM tags WHERE id = ?').get(senders.id))
})

// ---- POST /api/tags/lookup ----------------------------------------------------

// Dedicated fixtures so the lookup assertions do not depend on what the
// assignment tests above left behind.
const lookBox1 = seedMailbox(db, owner.id, 'look1@sender.test')
const lookBox2 = seedMailbox(db, owner.id, 'look2@sender.test')

test('looks mailboxes up by address, case- and whitespace-insensitively', async () => {
  const tag = await client.post('/api/tags', { appliesTo: 'mailbox', name: 'Lookup Tag', color: '#0891b2' })
  await client.post('/api/tags/assign', { mailboxIds: [lookBox1.id], tagIds: [tag.body.data.id] })

  const res = await client.post('/api/tags/lookup', {
    appliesTo: 'mailbox',
    emails: ['  Look1@Sender.TEST  ', 'look2@sender.test', 'look2@sender.test', foreignBox.email, 'nobody@nowhere.test'],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.length, 2, 'duplicates collapse, foreign and unknown are absent')

  const [first, second] = res.body.data
  assert.equal(first.fromEmail, 'look1@sender.test', 'the stored address is echoed, not the typed one')
  assert.deepEqual(first.tags.map((t) => t.name), ['Lookup Tag'])
  assert.deepEqual(second.tags, [], 'an untagged mailbox is a row with an empty array, not an omitted row')

  assert.deepEqual(res.body.notFound.sort(), [foreignBox.email, 'nobody@nowhere.test'].sort())
  assert.ok(!JSON.stringify(res.body.data).includes(foreignBox.email))
})

test('a lead label never appears in a mailbox lookup', async () => {
  // Same name on both sides of the discriminator.
  const leadSide = await client.post('/api/tags', { appliesTo: 'lead', name: 'Lookup Tag', color: '#dc2626' })
  assert.equal(leadSide.status, 200)
  await client.post(`/api/leads/${lead.id}/tags`, { tagIds: [leadSide.body.data.id] })

  const res = await client.post('/api/tags/lookup', { emails: ['look1@sender.test'] })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data[0].tags.map((t) => t.id), [
    db.prepare("SELECT id FROM tags WHERE workspace_id = ? AND name = 'Lookup Tag' AND applies_to = 'mailbox'").get(owner.id).id,
  ])
})

test('an empty or oversized address list is a 422 naming emails', async () => {
  const empty = await client.post('/api/tags/lookup', { emails: [] })
  assert.equal(empty.status, 422)
  assert.equal(empty.body.field, 'emails')

  const missing = await client.post('/api/tags/lookup', {})
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'emails')

  const huge = await client.post('/api/tags/lookup', {
    emails: Array.from({ length: 201 }, (_, i) => `x${i}@sender.test`),
  })
  assert.equal(huge.status, 422)
  assert.equal(huge.body.field, 'emails')
})

// ---- listing and deletion -----------------------------------------------------

test('the workspace list carries a usage count and pages', async () => {
  const res = await client.get('/api/tags?appliesTo=mailbox')
  assert.equal(res.status, 200)
  for (const tag of res.body.data) assert.equal(typeof tag.usageCount, 'number')
  const lookup = res.body.data.find((t) => t.name === 'Lookup Tag')
  assert.equal(lookup.usageCount, 1, 'one mailbox carries it')
  const senders = res.body.data.find((t) => t.name === 'Primary Senders')
  assert.equal(senders.usageCount, 0, 'a label with no mappings still lists, at a count of zero')

  const first = await client.get('/api/tags?appliesTo=lead&limit=1')
  assert.equal(first.body.data.length, 1)
  assert.equal(first.body.hasMore, true)
  assert.ok(first.body.nextCursor > 0)
  const next = await client.get(`/api/tags?appliesTo=lead&limit=1&cursor=${first.body.nextCursor}`)
  assert.notEqual(next.body.data[0].id, first.body.data[0].id)

  const overLimit = await client.get('/api/tags?limit=5000')
  assert.equal(overLimit.status, 422)
  assert.equal(overLimit.body.field, 'limit')
})

test('deleting a label takes its mappings with it and leaves no orphan chip', async () => {
  const created = await client.post('/api/tags', { appliesTo: 'lead', name: 'Temporary', color: '#7c3aed' })
  const tagId = created.body.data.id
  await client.post(`/api/leads/${lead.id}/tags`, { tagIds: [tagId] })

  const before = eventCount()
  const res = await client.del(`/api/tags/${tagId}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.removedMappings, 1)
  assert.equal(eventCount() - before, 1)

  const chips = await client.get(`/api/tags?leadId=${lead.id}`)
  assert.ok(!chips.body.data.some((c) => c.id === tagId), 'no orphan mapping is returned')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_tags WHERE tag_id = ?').get(tagId).n, 0)
})

test("another workspace's label cannot be deleted", async () => {
  const res = await client.del(`/api/tags/${foreignTag.id}`)
  assert.equal(res.status, 404)
  assert.ok(db.prepare('SELECT 1 FROM tags WHERE id = ?').get(foreignTag.id))
})

test.after(() => client.close())
