// Lead lists — Docs/lead-lists/*.md, all nine endpoints.
//
// The three rules the category exists to prove are asserted here rather than
// assumed: membership counts are derived, suppression cannot be overridden by
// any request field, and a campaign is never created implicitly.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, mount } from './helpers/parity-harness.js'

setup('lists')                     // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/lists.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// ---- helpers ---------------------------------------------------------------

let seq = 0
const uniq = (prefix) => `${prefix} ${++seq}`

async function makeList(name = uniq('Segment')) {
  const res = await client.post('/api/lead-lists', { name })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

function strangerList(name = uniq('Their segment')) {
  const info = db.prepare('INSERT INTO lead_lists (workspace_id, name) VALUES (?, ?)').run(stranger.id, name)
  return Number(info.lastInsertRowid)
}

function tagFor(wsId, name, appliesTo = 'lead_list') {
  db.prepare('INSERT INTO tags (workspace_id, applies_to, name, color) VALUES (?, ?, ?, ?)')
    .run(wsId, appliesTo, name, '#8b5cf6')
  return db.prepare('SELECT * FROM tags WHERE workspace_id = ? AND applies_to = ? AND name = ?').get(wsId, appliesTo, name)
}

function block(value, isDomain = 1) {
  db.prepare('INSERT OR IGNORE INTO blocked_domains (workspace_id, value, is_domain) VALUES (?, ?, ?)')
    .run(owner.id, value, isDomain)
}

const events = (type) => db.prepare('SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = ?').get(owner.id, type).n

// ---- create ----------------------------------------------------------------

test('create returns a segment with a derived zero count', async () => {
  const before = events('lead_list_created')
  const res = await client.post('/api/lead-lists', { name: '  Q1 2025 Enterprise Prospects  ' })
  assert.equal(res.status, 200)
  assert.equal(res.body.name, 'Q1 2025 Enterprise Prospects')   // trimmed
  assert.equal(res.body.leadCount, 0)
  assert.ok(res.body.createdAt)
  assert.equal(events('lead_list_created'), before + 1)
})

test('create 422s on an empty name, naming the field', async () => {
  const res = await client.post('/api/lead-lists', { name: '   ' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'name')
})

test('create accepts the source API spelling listName', async () => {
  const res = await client.post('/api/lead-lists', { listName: uniq('Køln — Q1 (tier 1)') })
  assert.equal(res.status, 200)
})

test('create refuses a duplicate name case- and whitespace-insensitively', async () => {
  const first = await makeList('SMB Tech Companies')
  const res = await client.post('/api/lead-lists', { name: '  smb tech companies ' })
  assert.equal(res.status, 409)
  assert.equal(res.body.id, first.id)              // the UI can link to the existing one
})

// ---- get-all ---------------------------------------------------------------

test('get-all filters by partial name and by label, together', async () => {
  const tech = await makeList('Listing SMB Tech Companies')
  const ent = await makeList('Listing Enterprise Prospects')
  const tag = tagFor(owner.id, uniq('region'))

  const assigned = await client.post('/api/lead-lists/assign-tags', { listIds: [tech.id], tagIds: [tag.id] })
  assert.equal(assigned.status, 200)

  const byName = await client.get('/api/lead-lists?q=listing%20smb')
  assert.equal(byName.status, 200)
  assert.deepEqual(byName.body.items.map((i) => i.id), [tech.id])

  const byTag = await client.get(`/api/lead-lists?tagIds=${tag.id},999999`)
  assert.deepEqual(byTag.body.items.map((i) => i.id), [tech.id])

  // The two narrow together rather than one replacing the other.
  const both = await client.get(`/api/lead-lists?q=listing%20enterprise&tagIds=${tag.id}`)
  assert.deepEqual(both.body.items, [])
  assert.ok(ent.id)
})

test('get-all 422s on an out-of-range limit and a negative offset', async () => {
  const limit = await client.get('/api/lead-lists?limit=5000')
  assert.equal(limit.status, 422)
  assert.equal(limit.body.field, 'limit')

  const offset = await client.get('/api/lead-lists?offset=-1')
  assert.equal(offset.status, 422)
  assert.equal(offset.body.field, 'offset')
})

test('paging is stable — no segment appears on two pages, even after an insert', async () => {
  const made = []
  for (let i = 0; i < 6; i++) made.push(await makeList(`Paging ${i} ${uniq('x')}`))

  const first = await client.get('/api/lead-lists?limit=3')
  assert.equal(first.body.items.length, 3)
  assert.ok(first.body.hasMore)

  // A segment created mid-scroll must not shuffle the second page.
  await makeList(uniq('Inserted mid-scroll'))

  const second = await client.get(`/api/lead-lists?limit=3&cursor=${first.body.nextCursor}`)
  const ids = new Set(first.body.items.map((i) => i.id))
  for (const item of second.body.items) assert.ok(!ids.has(item.id), 'no repeat across pages')
  assert.ok(made.length)
})

test('get-all never returns another workspace segment', async () => {
  strangerList('Invisible segment')
  const res = await client.get('/api/lead-lists?q=Invisible')
  assert.deepEqual(res.body.items, [])
})

// ---- get-by-id -------------------------------------------------------------

test('get-by-id derives the count and 404s across workspaces without leaking', async () => {
  const list = await makeList()
  const lead = seedLead(db, owner.id, `count-${seq}@acme.test`)
  db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)

  const res = await client.get(`/api/lead-lists/${list.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.leadCount, 1)
  assert.deepEqual(res.body.tags, [])

  const theirs = strangerList('Secret Name Nobody Should See')
  const cross = await client.get(`/api/lead-lists/${theirs}`)
  assert.equal(cross.status, 404)
  assert.equal(JSON.stringify(cross.body).includes('Secret Name'), false)

  const missing = await client.get('/api/lead-lists/999999')
  assert.equal(missing.status, 404)
  assert.deepEqual(cross.body, missing.body)      // indistinguishable
})

test('get-by-id 422s on a non-numeric id', async () => {
  const res = await client.get('/api/lead-lists/abc')
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'id')
})

// ---- update ----------------------------------------------------------------

test('update renames, trims, and leaves membership alone', async () => {
  const list = await makeList('Rename me')
  const lead = seedLead(db, owner.id, `rename-${seq}@acme.test`)
  db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)

  const res = await client.put(`/api/lead-lists/${list.id}`, { listName: '  Renamed  ' })
  assert.equal(res.status, 200)
  assert.equal(res.body.name, 'Renamed')
  assert.equal(res.body.changed, true)

  const after = await client.get(`/api/lead-lists/${list.id}`)
  assert.equal(after.body.leadCount, 1)
  assert.equal(after.body.createdAt, list.createdAt)
})

test('a no-op rename writes nothing', async () => {
  const list = await makeList('No-op name')
  const before = events('lead_list_renamed')
  const res = await client.put(`/api/lead-lists/${list.id}`, { name: 'No-op name' })
  assert.equal(res.status, 200)
  assert.equal(res.body.changed, false)
  assert.equal(events('lead_list_renamed'), before)
})

test('update 422s on an empty name and 409s on a taken one', async () => {
  const a = await makeList('Update target A')
  await makeList('Update target B')

  const empty = await client.put(`/api/lead-lists/${a.id}`, { name: '' })
  assert.equal(empty.status, 422)
  assert.equal(empty.body.field, 'name')

  const taken = await client.put(`/api/lead-lists/${a.id}`, { name: 'update target b' })
  assert.equal(taken.status, 409)

  const unchanged = await client.get(`/api/lead-lists/${a.id}`)
  assert.equal(unchanged.body.name, 'Update target A')
})

test('update 404s across workspaces and renames nothing', async () => {
  const theirs = strangerList('Their untouched name')
  const res = await client.put(`/api/lead-lists/${theirs}`, { name: 'Hijacked' })
  assert.equal(res.status, 404)
  assert.equal(db.prepare('SELECT name FROM lead_lists WHERE id = ?').get(theirs).name, 'Their untouched name')
})

// ---- delete ----------------------------------------------------------------

test('delete is soft, keeps every lead, and clears only the label rows', async () => {
  const list = await makeList('Delete me')
  const tag = tagFor(owner.id, uniq('label'))
  const leads = [1, 2, 3].map((n) => seedLead(db, owner.id, `del-${seq}-${n}@acme.test`))
  for (const lead of leads) db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)
  await client.post('/api/lead-lists/assign-tags', { listIds: [list.id], tagIds: [tag.id] })

  const before = db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ?').get(owner.id).n
  const res = await client.del(`/api/lead-lists/${list.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.message, 'Lead list deleted successfully')
  assert.equal(res.body.leadsKept, 3)
  assert.equal(res.body.leadsDeleted, 0)

  // Leads survive; the tag itself survives; the assignment is gone.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ?').get(owner.id).n, before)
  assert.ok(db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id = ?').get(list.id).n, 0)

  // Soft: the row still exists but is invisible and gone from the listing.
  assert.ok(String(db.prepare('SELECT deleted_at FROM lead_lists WHERE id = ?').get(list.id).deleted_at))
  assert.equal((await client.get(`/api/lead-lists/${list.id}`)).status, 404)
  const listing = await client.get('/api/lead-lists?q=Delete me')
  assert.deepEqual(listing.body.items, [])
})

test('deleting twice returns 404, and a stranger segment is never removed', async () => {
  const list = await makeList('Delete twice')
  assert.equal((await client.del(`/api/lead-lists/${list.id}`)).status, 200)
  assert.equal((await client.del(`/api/lead-lists/${list.id}`)).status, 404)

  const theirs = strangerList('Their survivor')
  assert.equal((await client.del(`/api/lead-lists/${theirs}`)).status, 404)
  assert.ok(db.prepare('SELECT * FROM lead_lists WHERE id = ?').get(theirs))
})

// ---- assign-tags -----------------------------------------------------------

test('assign-tags applies removals before additions and is idempotent', async () => {
  const a = await makeList()
  const b = await makeList()
  const one = tagFor(owner.id, uniq('t'))
  const two = tagFor(owner.id, uniq('t'))
  const three = tagFor(owner.id, uniq('t'))

  const first = await client.post('/api/lead-lists/assign-tags', { listIds: [a.id, b.id], tagIds: [one.id, two.id, three.id] })
  assert.equal(first.status, 200)
  assert.equal(first.body.message, 'Tags updated successfully')

  const again = await client.post('/api/lead-lists/assign-tags', { listIds: [a.id, b.id], tagIds: [one.id, two.id, three.id] })
  assert.equal(again.status, 200)
  assert.equal(again.body.added, 0)                     // repeating is safe

  // An id in both arrays ends up removed.
  const mixed = await client.post('/api/lead-lists/assign-tags', { listIds: [a.id], tagIds: [three.id], removeTagIds: [three.id] })
  assert.equal(mixed.status, 200)
  const tags = (await client.get(`/api/lead-lists/${a.id}`)).body.tags.map((t) => t.id)
  assert.equal(tags.includes(three.id), false)
  assert.equal(tags.includes(one.id), true)
})

test('assign-tags writes one events row for the whole bulk action', async () => {
  const a = await makeList()
  const b = await makeList()
  const tag = tagFor(owner.id, uniq('t'))
  const before = events('lead_list_tags_assigned')
  await client.post('/api/lead-lists/assign-tags', { listIds: [a.id, b.id], tagIds: [tag.id] })
  assert.equal(events('lead_list_tags_assigned'), before + 1)
})

test('assign-tags bounds listIds at 1-10 and requires tagIds', async () => {
  const tag = tagFor(owner.id, uniq('t'))
  const many = await client.post('/api/lead-lists/assign-tags', { listIds: Array.from({ length: 11 }, (_, i) => i + 1), tagIds: [tag.id] })
  assert.equal(many.status, 422)
  assert.equal(many.body.field, 'listIds')

  const none = await client.post('/api/lead-lists/assign-tags', { listIds: [], tagIds: [tag.id] })
  assert.equal(none.status, 422)
  assert.equal(none.body.field, 'listIds')

  const list = await makeList()
  const removeOnly = await client.post('/api/lead-lists/assign-tags', { listIds: [list.id], removeTagIds: [tag.id] })
  assert.equal(removeOnly.status, 422)
  assert.equal(removeOnly.body.field, 'tagIds')

  const notArray = await client.post('/api/lead-lists/assign-tags', { listIds: '500', tagIds: [tag.id] })
  assert.equal(notArray.status, 422)
  assert.equal(notArray.body.field, 'listIds')
})

test('assign-tags is all-or-nothing when one id is a stranger or missing', async () => {
  const mine = await makeList()
  const tag = tagFor(owner.id, uniq('t'))
  const theirs = strangerList()

  const cross = await client.post('/api/lead-lists/assign-tags', { listIds: [mine.id, theirs], tagIds: [tag.id] })
  assert.equal(cross.status, 404)
  assert.equal(cross.body.id, theirs)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id = ?').get(mine.id).n, 0)

  const missing = await client.post('/api/lead-lists/assign-tags', { listIds: [mine.id, 999999], tagIds: [tag.id] })
  assert.equal(missing.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id = ?').get(mine.id).n, 0)

  // A tag belonging to another workspace, and one that is not a lead-list tag.
  const theirTag = tagFor(stranger.id, uniq('t'))
  const badTag = await client.post('/api/lead-lists/assign-tags', { listIds: [mine.id], tagIds: [theirTag.id] })
  assert.equal(badTag.status, 404)

  const mailboxTag = tagFor(owner.id, uniq('mb'), 'mailbox')
  const wrongKind = await client.post('/api/lead-lists/assign-tags', { listIds: [mine.id], tagIds: [mailboxTag.id] })
  assert.equal(wrongKind.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_tags WHERE list_id = ?').get(mine.id).n, 0)
})

// ---- import ----------------------------------------------------------------

test('import creates leads, dedupes on re-import, and records a summary row', async () => {
  const list = await makeList('Import target')
  const rows = [
    { email: 'Ada@import.test', first_name: 'Ada', company: 'Acme' },
    { email: 'grace@import.test', firstName: 'Grace' },
    { email: 'ada@import.test' },                       // duplicate within the file
  ]
  const res = await client.post(`/api/lead-lists/${list.id}/import`, {
    leads: rows, fileName: 'enterprise-prospects-jan2025.csv', customFields: { industry: 'SaaS' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.totalLeads, 3)
  assert.equal(res.body.imported, 2)
  assert.equal(res.body.duplicates, 1)
  assert.equal(res.body.blocked, 0)
  assert.equal(res.body.invalid, 0)
  // The four numbers add up.
  assert.equal(res.body.imported + res.body.duplicates + res.body.blocked + res.body.invalid, res.body.totalLeads)
  assert.equal(res.body.leadCount, 2)

  const lead = db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(owner.id, 'ada@import.test')
  assert.equal(JSON.parse(lead.custom_fields).industry, 'SaaS')

  // Re-importing the identical file adds nothing.
  const again = await client.post(`/api/lead-lists/${list.id}/import`, { leads: rows, fileName: 'enterprise-prospects-jan2025.csv' })
  assert.equal(again.body.imported, 0)
  assert.equal(again.body.duplicates, 3)
  assert.equal(again.body.leadCount, 2)
  assert.match(again.body.message, /Nothing new to add/)

  const imports = db.prepare('SELECT * FROM lead_list_imports WHERE list_id = ? ORDER BY id').all(list.id)
  assert.equal(imports.length, 2)
  assert.equal(imports[0].filename, 'enterprise-prospects-jan2025.csv')
  assert.equal(imports[0].requested, 3)
  assert.equal(imports[0].created, 2)

  const header = await client.get(`/api/lead-lists/${list.id}`)
  assert.equal(header.body.lastImport.fileName, 'enterprise-prospects-jan2025.csv')
})

test('import 422s on a missing fileName and on a non-array body', async () => {
  const list = await makeList()
  const noFile = await client.post(`/api/lead-lists/${list.id}/import`, { leads: [{ email: 'a@b.test' }] })
  assert.equal(noFile.status, 422)
  assert.equal(noFile.body.field, 'fileName')

  const noLeads = await client.post(`/api/lead-lists/${list.id}/import`, { fileName: 'x.csv' })
  assert.equal(noLeads.status, 422)
  assert.equal(noLeads.body.field, 'leads')

  const notArray = await client.post(`/api/lead-lists/${list.id}/import`, { fileName: 'x.csv', leads: 'nope' })
  assert.equal(notArray.status, 422)
  assert.equal(notArray.body.field, 'leads')
})

test('import reports per-row failures with line numbers and still imports the rest', async () => {
  const list = await makeList()
  const res = await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'messy.csv',
    leads: [{ email: 'good@rows.test' }, { first_name: 'No email' }, { email: 'john@@company' }],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.imported, 1)
  assert.equal(res.body.invalid, 2)
  assert.deepEqual(res.body.errors.map((e) => e.row), [2, 3])
  assert.match(res.body.errors[0].reason, /required/)
  assert.match(res.body.errors[1].reason, /malformed/)
})

test('an empty import is a 200 that changes nothing', async () => {
  const list = await makeList()
  const res = await client.post(`/api/lead-lists/${list.id}/import`, { leads: [], fileName: 'empty.csv' })
  assert.equal(res.status, 200)
  assert.equal(res.body.totalLeads, 0)
  assert.equal(res.body.message, 'Nothing to import')
  assert.equal(res.body.leadCount, 0)
})

test('import excludes blocked domains and unsubscribed addresses, with no override', async () => {
  block('blocked.test')
  block('one.person@allowed.test', 0)
  const gone = seedLead(db, owner.id, 'quit@allowed.test')
  db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(gone.id)

  const list = await makeList()

  // Every documented bypass, offered one at a time and then nested inside
  // csvSettings. Each is refused by name rather than quietly dropped: a 200
  // would let a caller migrating from SmartLead believe the opt-out was waived.
  for (const bypass of [
    { ignore_global_block_list: true },
    { ignore_unsubscribe_list: true },
    { ignoreGlobalBlockList: true },
    { csvSettings: { ignoreUnsubscribeList: true } },
  ]) {
    const refused = await client.post(`/api/lead-lists/${list.id}/import`, {
      fileName: 'suppressed.csv', leads: [{ email: 'fine@allowed.test' }], ...bypass,
    })
    assert.equal(refused.status, 422, JSON.stringify(refused.body))
    assert.match(refused.body.message, /bypass/i)
  }
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(list.id).n, 0,
    'a refused import writes nothing'
  )

  // And with no flag in sight, suppression applies anyway — which is the point.
  const res = await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'suppressed.csv',
    leads: [
      { email: 'fine@allowed.test' },
      { email: 'someone@blocked.test' },
      { email: 'deep@mail.blocked.test' },      // subdomain of a blocked domain
      { email: 'one.person@allowed.test' },     // blocked as a whole address
      { email: 'quit@allowed.test' },           // unsubscribed
    ],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.imported, 1)
  assert.equal(res.body.blocked, 4)
  assert.equal(res.body.suppression.blockedDomain, 3)
  assert.equal(res.body.suppression.unsubscribed, 1)
  assert.equal(res.body.leadCount, 1)

  const members = db.prepare(
    'SELECT l.email FROM lead_list_leads m JOIN leads l ON l.id = m.lead_id WHERE m.list_id = ?'
  ).all(list.id).map((r) => r.email)
  assert.deepEqual(members, ['fine@allowed.test'])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND email LIKE ?').get(owner.id, '%blocked.test').n, 0)
})

test('import 404s on another workspace segment and creates nothing', async () => {
  const theirs = strangerList()
  const before = db.prepare('SELECT COUNT(*) n FROM leads').get().n
  const res = await client.post(`/api/lead-lists/${theirs}/import`, { fileName: 'x.csv', leads: [{ email: 'nope@cross.test' }] })
  assert.equal(res.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads').get().n, before)
})

test('import writes one events row per import, not one per row', async () => {
  const list = await makeList()
  const before = events('lead_list_imported')
  await client.post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'bulk.csv',
    leads: Array.from({ length: 25 }, (_, i) => ({ email: `bulk${i}-${seq}@rows.test` })),
  })
  assert.equal(events('lead_list_imported'), before + 1)
})

// ---- transfer --------------------------------------------------------------

test('transfer moves a whole list and copies without emptying the source', async () => {
  const from = await makeList()
  const to = await makeList()
  const leads = [1, 2, 3].map((n) => seedLead(db, owner.id, `xfer-${seq}-${n}@acme.test`))
  for (const lead of leads) db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(from.id, lead.id)

  const copied = await client.post('/api/lead-lists/transfer', { action: 'copy', fromListId: from.id, toListId: to.id })
  assert.equal(copied.status, 200)
  assert.equal(copied.body.totalLeadsMoved, 3)
  assert.equal((await client.get(`/api/lead-lists/${from.id}`)).body.leadCount, 3)
  assert.equal((await client.get(`/api/lead-lists/${to.id}`)).body.leadCount, 3)

  // Re-running the identical copy transfers zero and still returns 200.
  const rerun = await client.post('/api/lead-lists/transfer', { action: 'copy', fromListId: from.id, toListId: to.id })
  assert.equal(rerun.status, 200)
  assert.equal(rerun.body.transferred, 0)
  assert.equal(rerun.body.alreadyPresent, 3)

  const moved = await client.post('/api/lead-lists/transfer', { action: 'move', fromListId: from.id, toListId: to.id })
  assert.equal(moved.status, 200)
  assert.equal((await client.get(`/api/lead-lists/${from.id}`)).body.leadCount, 0)
  assert.equal((await client.get(`/api/lead-lists/${to.id}`)).body.leadCount, 3)
})

test('transfer takes explicit lead ids and 422s on the ambiguous cases', async () => {
  const from = await makeList()
  const to = await makeList()
  const lead = seedLead(db, owner.id, `explicit-${seq}@acme.test`)

  const ok = await client.post('/api/lead-lists/transfer', { action: 'copy', leadIds: [lead.id], toListId: to.id })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.transferred, 1)

  const both = await client.post('/api/lead-lists/transfer', { action: 'copy', leadIds: [lead.id], fromListId: from.id, toListId: to.id })
  assert.equal(both.status, 422)
  assert.equal(both.body.field, 'leadIds')

  const neither = await client.post('/api/lead-lists/transfer', { action: 'move', toListId: to.id })
  assert.equal(neither.status, 422)
  assert.equal(neither.body.field, 'fromListId')

  const same = await client.post('/api/lead-lists/transfer', { action: 'move', fromListId: to.id, toListId: to.id })
  assert.equal(same.status, 422)
  assert.equal(same.body.field, 'toListId')

  const noTarget = await client.post('/api/lead-lists/transfer', { action: 'copy', leadIds: [lead.id] })
  assert.equal(noTarget.status, 422)
  assert.equal(noTarget.body.field, 'toListId')

  const tooMany = await client.post('/api/lead-lists/transfer', {
    action: 'copy', toListId: to.id, leadIds: Array.from({ length: 10001 }, (_, i) => i + 1),
  })
  assert.equal(tooMany.status, 422)
  assert.equal(tooMany.body.field, 'leadIds')

  const badAction = await client.post('/api/lead-lists/transfer', { action: 'teleport', fromListId: from.id, toListId: to.id })
  assert.equal(badAction.status, 422)
  assert.equal(badAction.body.field, 'action')
})

test('transfer 404s on a stranger lead or list and writes nothing', async () => {
  const to = await makeList()
  const theirLead = seedLead(db, stranger.id, `theirs-${seq}@acme.test`)

  const crossLead = await client.post('/api/lead-lists/transfer', { action: 'copy', leadIds: [theirLead.id], toListId: to.id })
  assert.equal(crossLead.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(to.id).n, 0)

  const crossList = await client.post('/api/lead-lists/transfer', { action: 'copy', leadIds: [1], toListId: strangerList() })
  assert.equal(crossList.status, 404)
})

test('moving from an empty list is a 200 that changes nothing', async () => {
  const from = await makeList()
  const to = await makeList()
  const res = await client.post('/api/lead-lists/transfer', { action: 'move', fromListId: from.id, toListId: to.id })
  assert.equal(res.status, 200)
  assert.equal(res.body.totalLeadsMoved, 0)
  assert.equal(res.body.message, 'Nothing to move')
})

test('a single lead can be moved between two lists from its own path', async () => {
  const from = await makeList()
  const to = await makeList()
  const lead = seedLead(db, owner.id, `single-${seq}@acme.test`)
  db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(from.id, lead.id)

  const res = await client.post(`/api/leads/${lead.id}/move`, { action: 'move', fromListId: from.id, toListId: to.id })
  assert.equal(res.status, 200)
  assert.equal(res.body.transferred, 1)
  assert.equal((await client.get(`/api/lead-lists/${from.id}`)).body.leadCount, 0)
  assert.equal((await client.get(`/api/lead-lists/${to.id}`)).body.leadCount, 1)

  const theirLead = seedLead(db, stranger.id, `single-theirs-${seq}@acme.test`)
  const cross = await client.post(`/api/leads/${theirLead.id}/move`, { action: 'copy', toListId: to.id })
  assert.equal(cross.status, 404)
})

// ---- push to campaign ------------------------------------------------------

test('push attaches a segment, dedupes on re-push, and can move', async () => {
  const mailbox = seedMailbox(db, owner.id, `push-${seq}@example.com`)
  const campaign = seedCampaign(db, owner.id, uniq('Push campaign'), mailbox.id)
  const list = await makeList()
  const leads = [1, 2, 3].map((n) => seedLead(db, owner.id, `push-${seq}-${n}@acme.test`))
  for (const lead of leads) db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)

  const first = await client.post('/api/lead-lists/push-to-campaign', {
    campaignId: campaign.id, action: 'copy', leadList: { listId: list.id },
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.totalLeads, 3)
  assert.equal(first.body.pushed, 3)
  assert.equal(first.body.duplicates, 0)
  assert.equal((await client.get(`/api/lead-lists/${list.id}`)).body.leadCount, 3)   // copy keeps them

  // Re-pushing attaches nobody and resets nobody's position.
  db.prepare("UPDATE campaign_leads SET node_id = 'n3', state = 'waiting' WHERE campaign_id = ?").run(campaign.id)
  const again = await client.post('/api/lead-lists/push-to-campaign', {
    campaignId: campaign.id, action: 'copy', leadList: { listId: list.id },
  })
  assert.equal(again.body.pushed, 0)
  assert.equal(again.body.duplicates, 3)
  const states = db.prepare('SELECT DISTINCT node_id, state FROM campaign_leads WHERE campaign_id = ?').all(campaign.id)
  assert.deepEqual(states, [{ node_id: 'n3', state: 'waiting' }])

  // A move empties the source segment but never deletes a lead.
  const moved = await client.post('/api/campaigns/' + campaign.id + '/attach-segment', {
    action: 'move', selection: { listId: list.id },
  })
  assert.equal(moved.status, 200)
  assert.equal((await client.get(`/api/lead-lists/${list.id}`)).body.leadCount, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE id IN (?, ?, ?)').get(...leads.map((l) => l.id)).n, 3)
})

test('push refuses a campaign that does not exist, and never creates one from a name', async () => {
  const list = await makeList()

  const missing = await client.post('/api/lead-lists/push-to-campaign', { campaignId: 999999, leadList: { listId: list.id } })
  assert.equal(missing.status, 404)

  const theirMailbox = seedMailbox(db, stranger.id, `cross-${seq}@example.com`)
  const theirCampaign = seedCampaign(db, stranger.id, uniq('Their campaign'), theirMailbox.id)
  const cross = await client.post('/api/lead-lists/push-to-campaign', { campaignId: theirCampaign.id, leadList: { listId: list.id } })
  assert.equal(cross.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(theirCampaign.id).n, 0)

  const noTarget = await client.post('/api/lead-lists/push-to-campaign', { leadList: { listId: list.id } })
  assert.equal(noTarget.status, 422)
  assert.equal(noTarget.body.field, 'campaignId')

  // The source API would conjure a campaign from this string. Harry will not.
  const before = db.prepare('SELECT COUNT(*) n FROM campaigns').get().n
  const byName = await client.post('/api/lead-lists/push-to-campaign', {
    campaignName: 'Brand new campaign', leadList: { listId: list.id },
  })
  assert.equal(byName.status, 422)
  assert.equal(byName.body.field, 'campaignName')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaigns').get().n, before)
})

test('push 422s unless exactly one selection method is given', async () => {
  const campaign = seedCampaign(db, owner.id, uniq('Selection campaign'), seedMailbox(db, owner.id, `sel-${seq}@example.com`).id)
  const list = await makeList()

  const ambiguous = await client.post('/api/lead-lists/push-to-campaign', {
    campaignId: campaign.id, leadList: { listId: list.id, leadIds: [1], allLeads: true },
  })
  assert.equal(ambiguous.status, 422)
  assert.equal(ambiguous.body.field, 'selection')

  const none = await client.post('/api/lead-lists/push-to-campaign', { campaignId: campaign.id, leadList: {} })
  assert.equal(none.status, 422)
  assert.equal(none.body.field, 'selection')

  const moveWithoutList = await client.post('/api/lead-lists/push-to-campaign', {
    campaignId: campaign.id, action: 'move', leadList: { leadIds: [1] },
  })
  assert.equal(moveWithoutList.status, 422)
  assert.equal(moveWithoutList.body.field, 'listId')
})

test('push excludes unsubscribed, bounced and blocked leads with no override', async () => {
  block('pushblocked.test')
  const campaign = seedCampaign(db, owner.id, uniq('Suppression campaign'), seedMailbox(db, owner.id, `sup-${seq}@example.com`).id)
  const list = await makeList()

  const fine = seedLead(db, owner.id, `sup-fine-${seq}@acme.test`)
  const gone = seedLead(db, owner.id, `sup-gone-${seq}@acme.test`)
  const bounced = seedLead(db, owner.id, `sup-bounced-${seq}@acme.test`)
  const blocked = seedLead(db, owner.id, `sup-blocked-${seq}@pushblocked.test`)
  db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(gone.id)
  db.prepare("UPDATE leads SET status = 'bounced' WHERE id = ?").run(bounced.id)
  for (const lead of [fine, gone, bounced, blocked]) {
    db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)
  }

  const res = await client.post('/api/lead-lists/push-to-campaign', {
    campaignId: campaign.id,
    action: 'copy',
    leadList: { listId: list.id },

  })
  assert.equal(res.status, 200)
  assert.equal(res.body.totalLeads, 4)
  assert.equal(res.body.pushed, 1)
  assert.deepEqual(res.body.excluded, { unsubscribed: 1, bounced: 1, blocked: 1 })

  const attached = db.prepare('SELECT lead_id FROM campaign_leads WHERE campaign_id = ?').all(campaign.id).map((r) => r.lead_id)
  assert.deepEqual(attached, [fine.id])
})

test('pushing an empty segment is a 200 that leaves the campaign untouched', async () => {
  const campaign = seedCampaign(db, owner.id, uniq('Empty push'), seedMailbox(db, owner.id, `empty-${seq}@example.com`).id)
  const list = await makeList()
  const res = await client.post('/api/lead-lists/push-to-campaign', { campaignId: campaign.id, leadList: { listId: list.id } })
  assert.equal(res.status, 200)
  assert.equal(res.body.pushed, 0)
  assert.equal(res.body.message, 'Nothing to push')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n, 0)
})

test('push writes one events row per push', async () => {
  const campaign = seedCampaign(db, owner.id, uniq('Audit push'), seedMailbox(db, owner.id, `audit-${seq}@example.com`).id)
  const list = await makeList()
  for (const n of [1, 2, 3, 4]) {
    const lead = seedLead(db, owner.id, `audit-${seq}-${n}@acme.test`)
    db.prepare('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)').run(list.id, lead.id)
  }
  const before = events('lead_list_pushed_to_campaign')
  await client.post('/api/lead-lists/push-to-campaign', { campaignId: campaign.id, leadList: { listId: list.id } })
  assert.equal(events('lead_list_pushed_to_campaign'), before + 1)
})
