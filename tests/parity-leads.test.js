// Docs/leads/* — the prospect record and its lifecycle.
//
// The cases the specs are explicit about: a cross-workspace 404 that leaks
// nothing about the person, 422s that name the offending field, a global
// unsubscribe that closes every open campaign row and cannot be undone, a
// category list that seeds once, literal paths that survive next to /leads/:id,
// and a CSV export with correct headers and RFC 4180 quoting.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, seedMessage, mount } from './helpers/parity-harness.js'

setup('leads')                     // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/leads.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// ---- fixtures ---------------------------------------------------------------

const mailbox = seedMailbox(db, owner.id)
const ada = seedLead(db, owner.id, 'ada@acme.test')
const grace = seedLead(db, owner.id, 'grace@navy.test', { first_name: 'Grace', last_name: 'Hopper', company: 'Navy' })
// The person the owner must never be able to see or name.
const outsider = seedLead(db, stranger.id, 'katherine@nasa.test', {
  first_name: 'Katherine', last_name: 'Johnson', company: 'NASA',
})

const alpha = seedCampaign(db, owner.id, 'Alpha', mailbox.id)
const beta = seedCampaign(db, owner.id, 'Beta', mailbox.id)

function attach(campaignId, leadId, state = 'active') {
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state, node_id) VALUES (?, ?, ?, 'A')")
    .run(campaignId, leadId, state)
  return db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId)
}

// `Response.text()` strips a leading byte order mark as part of UTF-8 decoding,
// so the raw bytes are read instead — the BOM is the point of the assertion.
async function csv(res) {
  return Buffer.from(await res.arrayBuffer()).toString('utf8')
}

const csvRows = (text) => text.replace(/^\uFEFF/, '').trim().split('\r\n')

function draftFor(campaignId, leadId) {
  const info = db.prepare(
    "INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body) VALUES (?, ?, ?, 'A', 'Hi', 'Body')"
  ).run(owner.id, campaignId, leadId)
  return info.lastInsertRowid
}

// ---- categories -------------------------------------------------------------

test('lead categories seed once from the classifier vocabulary and do not duplicate', async () => {
  const first = await client.get('/api/lead-categories')
  assert.equal(first.status, 200)
  const names = first.body.data.map((c) => c.name)
  assert.deepEqual(names, ['interested', 'not interested', 'not now', 'question', 'unsubscribe', 'out of office'])
  assert.ok(first.body.data.every((c) => c.isBuiltin))
  assert.equal(first.body.data.find((c) => c.name === 'interested').sentiment, 'positive')
  assert.equal(first.body.data.find((c) => c.name === 'not interested').sentiment, 'negative')

  const second = await client.get('/api/lead-categories')
  assert.equal(second.body.data.length, 6)
  assert.deepEqual(second.body.data.map((c) => c.id), first.body.data.map((c) => c.id))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_categories WHERE workspace_id = ?').get(owner.id).n, 6)
})

test('a workspace category can be added, renamed and deleted; built-ins cannot', async () => {
  const created = await client.post('/api/lead-categories', { name: 'Referred us on' })
  assert.equal(created.status, 200)
  assert.equal(created.body.data.isBuiltin, false)
  assert.equal(created.body.data.sentiment, 'neutral')
  const id = created.body.data.id

  // Case-insensitive uniqueness, per workspace.
  const clash = await client.post('/api/lead-categories', { name: 'referred US on' })
  assert.equal(clash.status, 409)
  assert.equal(clash.body.field, 'name')

  const renamed = await client.patch(`/api/lead-categories/${id}`, { name: 'Referral' })
  assert.equal(renamed.body.data.name, 'Referral')

  const builtin = (await client.get('/api/lead-categories')).body.data.find((c) => c.isBuiltin)
  assert.equal((await client.patch(`/api/lead-categories/${builtin.id}`, { name: 'nope' })).status, 403)
  assert.equal((await client.del(`/api/lead-categories/${builtin.id}`)).status, 403)

  assert.equal((await client.del(`/api/lead-categories/${id}`)).status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_categories WHERE id = ?').get(id).n, 0)
})

test('a category still applied to a lead cannot be deleted and the count comes back', async () => {
  const created = await client.post('/api/lead-categories', { name: 'Wants a demo' })
  const id = created.body.data.id
  const enrolment = attach(alpha.id, grace.id)
  db.prepare('UPDATE campaign_leads SET category_id = ? WHERE id = ?').run(id, enrolment.id)

  const refused = await client.del(`/api/lead-categories/${id}`)
  assert.equal(refused.status, 409)
  assert.equal(refused.body.referenceCount, 1)

  db.prepare('UPDATE campaign_leads SET category_id = NULL WHERE id = ?').run(enrolment.id)
  assert.equal((await client.del(`/api/lead-categories/${id}`)).status, 200)
})

test('a name is required and a cross-workspace category 404s', async () => {
  const missing = await client.post('/api/lead-categories', {})
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'name')

  db.prepare('INSERT INTO lead_categories (workspace_id, name) VALUES (?, ?)').run(stranger.id, 'theirs')
  const theirs = db.prepare('SELECT * FROM lead_categories WHERE workspace_id = ? AND name = ?').get(stranger.id, 'theirs')
  const res = await client.patch(`/api/lead-categories/${theirs.id}`, { name: 'mine' })
  assert.equal(res.status, 404)
  assert.ok(!JSON.stringify(res.body).includes('theirs'))
})

// ---- lookup and detail ------------------------------------------------------

test('GET /api/leads/:id returns the person and their enrolments', async () => {
  attach(beta.id, ada.id)
  const res = await client.get(`/api/leads/${ada.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.email, 'ada@acme.test')
  assert.equal(res.body.data.stage, 'not contacted')
  assert.deepEqual(res.body.data.customFields, {})
  assert.equal(res.body.enrolments.length, 1)
  assert.equal(res.body.enrolments[0].campaignName, 'Beta')
})

test("another workspace's lead 404s and the body names neither the person nor the address", async () => {
  const res = await client.get(`/api/leads/${outsider.id}`)
  assert.equal(res.status, 404)
  const text = JSON.stringify(res.body).toLowerCase()
  assert.ok(!text.includes('katherine'))
  assert.ok(!text.includes('johnson'))
  assert.ok(!text.includes('nasa'))
  assert.equal(res.body.message, 'No such lead')
})

test('GET /api/leads/by-email is case-insensitive, trims, and a miss is a 200', async () => {
  const hit = await client.get('/api/leads/by-email?email=%20ADA%40Acme.test%20')
  assert.equal(hit.status, 200)
  assert.equal(hit.body.found, true)
  assert.equal(hit.body.data.id, ada.id)
  assert.ok(Array.isArray(hit.body.enrolments))

  const miss = await client.get('/api/leads/by-email?email=nobody@nowhere.test')
  assert.equal(miss.status, 200)
  assert.equal(miss.body.found, false)
  assert.equal(miss.body.data, null)

  // A lead in another workspace is a miss, never a hit.
  const theirs = await client.get('/api/leads/by-email?email=katherine@nasa.test')
  assert.equal(theirs.status, 200)
  assert.equal(theirs.body.found, false)
})

test('a missing or malformed email names the parameter', async () => {
  const missing = await client.get('/api/leads/by-email')
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'email')

  const malformed = await client.get('/api/leads/by-email?email=not-an-address')
  assert.equal(malformed.status, 422)
  assert.equal(malformed.body.field, 'email')
})

test('the literal paths are not swallowed by /leads/:id', async () => {
  // Each would be read as an id if registration order were wrong.
  const activities = await client.get('/api/leads/activities')
  assert.equal(activities.status, 200)
  assert.ok(Array.isArray(activities.body.data))

  const byEmail = await client.get('/api/leads/by-email?email=ada@acme.test')
  assert.equal(byEmail.body.found, true)

  const res = await fetch(`${client.base}/api/leads/export`)
  assert.equal(res.status, 200)
  assert.ok(res.headers.get('content-type').startsWith('text/csv'))
  await res.text()
})

// ---- update -----------------------------------------------------------------

test('PATCH merges custom fields, keeps unnamed keys, and records field names only', async () => {
  db.prepare("UPDATE leads SET custom_fields = ? WHERE id = ?").run(JSON.stringify({ sector: 'gov', seats: 5 }), grace.id)
  const before = db.prepare('SELECT COUNT(*) n FROM events WHERE user_id = ?').get(owner.id).n

  const res = await client.patch(`/api/leads/${grace.id}`, {
    title: 'Rear Admiral',
    phone: '+1 555 0100',
    location: 'Arlington',
    customFields: { seats: 12, renewal: '2027-01-01' },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data.customFields, { sector: 'gov', seats: 12, renewal: '2027-01-01' })
  assert.equal(res.body.data.title, 'Rear Admiral')
  assert.equal(res.body.data.phone, '+1 555 0100')
  assert.deepEqual(res.body.changedFields.sort(), ['customFields', 'location', 'phone', 'title'])

  const after = db.prepare('SELECT COUNT(*) n FROM events WHERE user_id = ?').get(owner.id).n
  assert.equal(after, before + 1)                    // one row for the edit
  const event = db.prepare("SELECT * FROM events WHERE user_id = ? AND type = 'lead_updated' ORDER BY id DESC LIMIT 1").get(owner.id)
  // Field names, never values.
  assert.ok(event.detail.includes('title'))
  assert.ok(!event.detail.includes('Rear Admiral'))
  assert.ok(!event.detail.includes('Arlington'))
})

test('customFields must be an object and the 422 names it', async () => {
  for (const bad of [[1, 2], 'nope', 42]) {
    const res = await client.patch(`/api/leads/${grace.id}`, { customFields: bad })
    assert.equal(res.status, 422)
    assert.equal(res.body.field, 'customFields')
  }
  const nested = await client.patch(`/api/leads/${grace.id}`, { customFields: { deep: { a: 1 } } })
  assert.equal(nested.status, 422)
  assert.equal(nested.body.field, 'customFields')
})

test('an empty PATCH is a 422 and a cross-workspace PATCH leaks nothing', async () => {
  const empty = await client.patch(`/api/leads/${grace.id}`, {})
  assert.equal(empty.status, 422)
  assert.equal(empty.body.field, 'fields')

  const theirs = await client.patch(`/api/leads/${outsider.id}`, { title: 'Mathematician' })
  assert.equal(theirs.status, 404)
  assert.ok(!JSON.stringify(theirs.body).toLowerCase().includes('katherine'))
  assert.equal(db.prepare('SELECT title FROM leads WHERE id = ?').get(outsider.id).title, 'Head of Operations')
})

test('changing the email revalidates uniqueness, and changing the company invalidates the draft and the profile', async () => {
  const dupe = await client.patch(`/api/leads/${grace.id}`, { email: 'ada@acme.test' })
  assert.equal(dupe.status, 409)
  assert.equal(dupe.body.field, 'email')

  const malformed = await client.patch(`/api/leads/${grace.id}`, { email: 'not-an-address' })
  assert.equal(malformed.status, 422)
  assert.equal(malformed.body.field, 'email')

  db.prepare("UPDATE leads SET research = 'profile text', researched_at = '2026-01-01' WHERE id = ?").run(grace.id)
  const draftId = draftFor(alpha.id, grace.id)

  const res = await client.patch(`/api/leads/${grace.id}`, { company: 'US Navy' })
  assert.equal(res.status, 200)
  assert.equal(res.body.researchRefreshQueued, true)
  assert.equal(res.body.draftsInvalidated, 1)
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(grace.id)
  assert.equal(lead.research, '')
  assert.equal(lead.researched_at, '')
  // The queued email is gone, so it can never be approved.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts WHERE id = ?').get(draftId).n, 0)
})

// ---- unsubscribe ------------------------------------------------------------

test('unsubscribing is global: every open campaign row is closed and the suppression is recorded', async () => {
  const lead = seedLead(db, owner.id, 'mary@jackson.test', { first_name: 'Mary', last_name: 'Jackson' })
  const a = attach(alpha.id, lead.id, 'waiting')
  const b = attach(beta.id, lead.id, 'queued')
  // A row that was already finished is left exactly as it was.
  const other = seedLead(db, owner.id, 'bystander@acme.test')
  const untouched = attach(alpha.id, other.id, 'active')
  const draftId = draftFor(alpha.id, lead.id)

  const res = await client.post(`/api/leads/${lead.id}/unsubscribe`, { source: 'recipient', reason: 'one-click link' })
  assert.equal(res.status, 200)
  assert.equal(res.body.changed, true)
  assert.equal(res.body.campaignsClosed, 2)
  assert.equal(res.body.draftsDropped, 1)

  const stored = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  assert.equal(stored.status, 'unsubscribed')
  assert.ok(stored.unsubscribed_at)
  assert.equal(stored.unsubscribed_source, 'recipient')

  for (const id of [a.id, b.id]) {
    const row = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(id)
    assert.equal(row.state, 'finished')
    assert.equal(row.outcome, 'unsubscribed')
    assert.ok(row.unsubscribed_at)
  }
  assert.equal(db.prepare('SELECT state FROM campaign_leads WHERE id = ?').get(untouched.id).state, 'active')

  // The suppression is keyed on the address, so it survives the person record.
  const block = db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ?')
    .get(owner.id, 'mary@jackson.test')
  assert.ok(block)
  assert.equal(block.is_domain, 0)
  assert.equal(block.source, 'unsubscribe')
  db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id)
  assert.ok(db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ?')
    .get(owner.id, 'mary@jackson.test'))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts WHERE id = ?').get(draftId).n, 0)
})

test('a second unsubscribe reports no change and leaves a single trail entry', async () => {
  const lead = seedLead(db, owner.id, 'annie@easley.test')
  attach(alpha.id, lead.id, 'active')

  const first = await client.post(`/api/leads/${lead.id}/unsubscribe`, {})
  assert.equal(first.body.changed, true)
  const trail = () => db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = 'lead_unsubscribed' AND lead_id = ?")
    .get(owner.id, lead.id).n
  assert.equal(trail(), 1)

  const second = await client.post(`/api/leads/${lead.id}/unsubscribe`, {})
  assert.equal(second.status, 200)
  assert.equal(second.body.changed, false)
  assert.equal(second.body.campaignsClosed, 0)
  assert.equal(trail(), 1)
})

test('the unsubscribed source is validated and a cross-workspace unsubscribe leaks nothing', async () => {
  const bad = await client.post(`/api/leads/${ada.id}/unsubscribe`, { source: 'ignore_suppression' })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'source')

  const theirs = await client.post(`/api/leads/${outsider.id}/unsubscribe`, {})
  assert.equal(theirs.status, 404)
  assert.ok(!JSON.stringify(theirs.body).toLowerCase().includes('nasa'))
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(outsider.id).status, 'active')
})

test('an edit cannot move a lead onto a suppressed address', async () => {
  const res = await client.patch(`/api/leads/${ada.id}`, { email: 'mary@jackson.test' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'email')
  assert.equal(db.prepare('SELECT email FROM leads WHERE id = ?').get(ada.id).email, 'ada@acme.test')
})

// ---- activities -------------------------------------------------------------

test('activities are workspace-scoped, paged, and filtered by date with named errors', async () => {
  const lead = seedLead(db, owner.id, 'dorothy@vaughan.test')
  for (let i = 0; i < 5; i++) {
    db.prepare("INSERT INTO events (user_id, campaign_id, lead_id, type, detail) VALUES (?, ?, ?, 'sent', ?)")
      .run(owner.id, alpha.id, lead.id, `email ${i}`)
  }
  // Another workspace's activity must never appear.
  db.prepare("INSERT INTO events (user_id, lead_id, type, detail) VALUES (?, ?, 'sent', 'secret')")
    .run(stranger.id, outsider.id)

  const first = await client.get(`/api/leads/${lead.id}/activities?limit=2`)
  assert.equal(first.status, 200)
  assert.equal(first.body.data.length, 2)
  assert.equal(first.body.hasMore, true)
  assert.ok(first.body.data.every((row) => row.leadId === lead.id))
  assert.equal(first.body.data[0].campaignName, 'Alpha')

  const rest = await client.get(`/api/leads/${lead.id}/activities?limit=10&offset=2`)
  assert.equal(rest.body.data.length, 3)
  assert.equal(rest.body.hasMore, false)

  const all = await client.get('/api/leads/activities?limit=1000')
  assert.ok(!JSON.stringify(all.body).includes('secret'))
  assert.ok(all.body.data.every((row) => row.leadEmail))

  const badTo = await client.get('/api/leads/activities?to=2026-01-01')
  assert.equal(badTo.status, 422)
  assert.equal(badTo.body.field, 'from')

  const badDate = await client.get('/api/leads/activities?from=yesterday')
  assert.equal(badDate.status, 422)
  assert.equal(badDate.body.field, 'from')

  const windowed = await client.get('/api/leads/activities?from=2000-01-01&to=2000-01-02')
  assert.equal(windowed.body.data.length, 0)

  const theirs = await client.get(`/api/leads/${outsider.id}/activities`)
  assert.equal(theirs.status, 404)
  assert.ok(!JSON.stringify(theirs.body).toLowerCase().includes('katherine'))
})

// ---- export -----------------------------------------------------------------

test('the CSV export carries the right headers, a BOM, RFC 4180 quoting and the derived stage', async () => {
  const tricky = seedLead(db, owner.id, 'awkward@quote.test', {
    first_name: 'Ann, "Annie"',
    last_name: 'O\'Neil\nSecond line',
    company: 'Comma, Inc',
  })
  attach(alpha.id, tricky.id)
  // A sent message moves the derived stage off "not contacted" without storing it.
  seedMessage(db, owner.id, { campaignId: alpha.id, leadId: tricky.id, mailboxId: mailbox.id, direction: 'out' })

  const before = db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = 'leads_exported'").get(owner.id).n
  const res = await fetch(`${client.base}/api/leads/export`)
  assert.equal(res.status, 200)
  assert.ok(res.headers.get('content-type').startsWith('text/csv'))
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/)

  const text = await csv(res)
  assert.equal(text.charCodeAt(0), 0xfeff)                      // byte order mark
  // The header is a contract with whatever reads the file. Docs/leads/export.md
  // §2's engagement columns are appended, so every existing column keeps its
  // index; `website` is the company URL (`company_url` is its other documented
  // spelling for the same `leads.website` column) and is not repeated.
  assert.equal(csvRows(text)[0], 'id,email,firstName,lastName,company,title,phone,website,linkedin,location,status,stage,campaigns,customFields,unsubscribedAt,createdAt,lastStepSent,openCount,clickCount,replyCount')
  // A comma and an embedded quote are quoted and the quote is doubled.
  assert.ok(text.includes('"Ann, ""Annie"""'))
  assert.ok(text.includes('"Comma, Inc"'))
  assert.ok(text.includes('O\'Neil\nSecond line'))              // newline survives inside quotes
  assert.ok(text.includes(',contacted,'))                       // derived by the shared stage function
  assert.ok(text.includes('ada@acme.test'))
  assert.ok(!text.includes('katherine@nasa.test'))              // never another workspace

  const after = db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = 'leads_exported'").get(owner.id).n
  assert.equal(after, before + 1)                               // one trail entry per export, naming the actor
  const event = db.prepare("SELECT * FROM events WHERE user_id = ? AND type = 'leads_exported' ORDER BY id DESC LIMIT 1").get(owner.id)
  assert.ok(event.detail.includes('owner@example.com'))
})

test('the export filters by status, stage and campaign, and validates each', async () => {
  const byCampaign = await fetch(`${client.base}/api/leads/export?campaignId=${beta.id}`)
  const rows = csvRows(await csv(byCampaign)).slice(1)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].includes('ada@acme.test'))
  assert.match(byCampaign.headers.get('content-disposition'), new RegExp(`campaign-${beta.id}\\.csv`))

  const unsubscribed = await fetch(`${client.base}/api/leads/export?status=unsubscribed`)
  const unsubRows = csvRows(await csv(unsubscribed)).slice(1)
  assert.ok(unsubRows.length >= 1)
  assert.ok(unsubRows.every((row) => row.includes(',unsubscribed,')))

  const badStatus = await client.get('/api/leads/export?status=sleeping')
  assert.equal(badStatus.status, 422)
  assert.equal(badStatus.body.field, 'status')

  const badStage = await client.get('/api/leads/export?stage=thinking')
  assert.equal(badStage.status, 422)
  assert.equal(badStage.body.field, 'stage')

  // A campaign in another workspace is "No such campaign" and nothing else.
  const theirs = seedCampaign(db, stranger.id, 'Theirs')
  const res = await client.get(`/api/leads/export?campaignId=${theirs.id}`)
  assert.equal(res.status, 404)
  assert.equal(res.body.message, 'No such campaign')
})

test('the export streams in pages rather than materialising the workspace', async () => {
  // More rows than the internal batch so the paging loop runs more than once.
  const insert = db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (let i = 0; i < 600; i++) insert.run(owner.id, `bulk${i}@load.test`, `Bulk${i}`)
  })()
  const res = await fetch(`${client.base}/api/leads/export?q=bulk`)
  const rows = csvRows(await csv(res)).slice(1)
  assert.equal(rows.length, 600)
  assert.ok(rows[0].includes('bulk0@load.test'))
  assert.ok(rows[599].includes('bulk599@load.test'))
})
