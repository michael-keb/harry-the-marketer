// smart-prospect — Docs/smart-prospect/*.
//
// Every test here runs with NO prospect provider configured and makes no
// network call. The two places where the provider's behaviour is the thing
// under test — a 200 carrying `success: false`, and a cached filter list that
// must not be fetched twice — swap the module's one `upstream` seam for a
// counting stub and restore it afterwards, so what is asserted is Harry's
// handling of a payload rather than a fetch that never happens.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, mount } from './helpers/parity-harness.js'

setup('prospects')

const { db } = await import('../server/db.js')
const {
  register, upstream, translateSearch, SEARCH_MAP, ALLOWED_PROVIDER_KEYS,
  classifyFetch, renameBody, normaliseDomain, unknownFilterKeys, applyFoundEmail,
} = await import('../server/parity/prospects.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// Replace the network seam for one test and always put it back.
async function withUpstream(stub, fn) {
  const realConfigured = upstream.configured
  const realCall = upstream.call
  upstream.configured = stub.configured
  upstream.call = stub.call
  try { return await fn() } finally {
    upstream.configured = realConfigured
    upstream.call = realCall
  }
}

// ---------------------------------------------------------------- translation

test('the mapping table sends no undocumented key', () => {
  // Every Harry field set at once, so nothing can hide behind an empty value.
  // Distinct values per field, so an include/exclude pair does not collide.
  const filters = {}
  for (const [field, spec] of Object.entries(SEARCH_MAP)) {
    filters[field] = spec.kind === 'boolean' ? true : [`value-for-${field}`]
  }
  const body = translateSearch(filters, { limit: 10, scrollId: 's1', searchString: 'Everything' })

  for (const key of Object.keys(body)) {
    assert.ok(ALLOWED_PROVIDER_KEYS.has(key), `undocumented key sent upstream: ${key}`)
  }
  // And the reverse: every documented criteria field is actually emitted.
  for (const spec of Object.values(SEARCH_MAP)) {
    assert.ok(key(body, spec.key), `documented field never emitted: ${spec.key}`)
  }
  assert.equal(body.limit, 10)
  assert.equal(body.scroll_id, 's1')
  assert.equal(body.search_string, 'Everything')

  function key(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k) }
})

test('unknown Harry keys never reach the provider body and are reported instead', () => {
  const body = translateSearch({ title: 'Director', favouriteColour: 'blue' }, { limit: 5 })
  assert.deepEqual(body.title, ['Director'])           // scalar coerced to array
  assert.ok(!('favouriteColour' in body))
  assert.deepEqual(unknownFilterKeys({ title: 'x', favouriteColour: 'blue' }), ['favouriteColour'])
})

test('booleans pass through and every criteria value becomes an array', () => {
  const body = translateSearch({
    title: 'Director',
    countries: ['United States'],
    exactTitleMatch: true,
    hideOwnedContacts: false,
  }, { limit: 1 })
  assert.deepEqual(body.title, ['Director'])
  assert.deepEqual(body.country, ['United States'])
  assert.equal(body.titleExactMatch, true)
  assert.ok(!('dontDisplayOwnedContact' in body), 'a false toggle is simply not sent')
})

test('include and exclude cannot name the same value', () => {
  assert.throws(
    () => translateSearch({ includeTitles: ['CEO'], excludeTitles: ['ceo'] }, { limit: 1 }),
    (err) => err.status === 422 && err.body.field === 'includeTitles,excludeTitles'
  )
})

// -------------------------------------------------------------------- ceilings

test('limit above 500 is a 422 naming the field and the ceiling', async () => {
  const res = await client.post('/api/prospects/search', { limit: 501 })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'limit')
  assert.match(res.body.message, /500/)
})

test('limit is required and must be at least 1', async () => {
  const missing = await client.post('/api/prospects/search', { filters: { title: ['Director'] } })
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'limit')

  const zero = await client.post('/api/prospects/search', { limit: 0 })
  assert.equal(zero.status, 422)
  assert.equal(zero.body.field, 'limit')
})

test('a criteria array over 2000 items is a 422 naming the field and the ceiling', async () => {
  const domains = Array.from({ length: 2001 }, (_, i) => `acme${i}.com`)
  const res = await client.post('/api/prospects/search', { limit: 10, filters: { companyDomains: domains } })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'companyDomains')
  assert.match(res.body.message, /2000/)

  // Exactly 2000 is inside the ceiling.
  const ok = await client.post('/api/prospects/search', { limit: 10, filters: { companyDomains: domains.slice(0, 2000) } })
  assert.equal(ok.status, 200)
})

test('filter lookups reject a limit over 100 by name', async () => {
  const res = await client.get('/api/prospects/filters/cities?limit=250')
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'limit')
  assert.match(res.body.message, /100/)
})

test('the city lookup refuses a country without a state', async () => {
  const res = await client.get('/api/prospects/filters/cities?country=usa')
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'state')
})

// ---------------------------------------------------------------------- cursor

test('a cursor presented against changed filters restarts rather than mixing pages', async () => {
  const stub = {
    configured: () => true,
    calls: [],
    call: async (path, opts) => {
      stub.calls.push({ path, body: opts.body })
      return {
        success: true,
        data: {
          list: [{ id: 'a1', firstName: 'Ada', department: ['Sales'] }],
          total_count: 42,
          scroll_id: 'SCROLL-ONE',
          filter_id: '9001',
        },
      }
    },
  }

  await withUpstream(stub, async () => {
    const first = await client.post('/api/prospects/search', { limit: 5, filters: { title: ['Director'] } })
    assert.equal(first.status, 200)
    const cursor = first.body.cursor
    assert.ok(cursor, 'a cursor is minted for the client')
    assert.notEqual(cursor, 'SCROLL-ONE', 'the provider scroll id is never handed out')

    // Same filters: the cursor resolves and the scroll id goes upstream.
    const second = await client.post('/api/prospects/search', { limit: 5, filters: { title: ['Director'] }, cursor })
    assert.equal(second.body.cursorRestarted, false)
    assert.equal(stub.calls[1].body.scroll_id, 'SCROLL-ONE')

    // Changed filters: the cursor is refused server-side and page one is served.
    const third = await client.post('/api/prospects/search', {
      limit: 5,
      filters: { title: ['Director'], countries: ['United States'] },
      cursor,
    })
    assert.equal(third.status, 200)
    assert.equal(third.body.cursorRestarted, true)
    assert.ok(!('scroll_id' in stub.calls[2].body), 'no cursor is carried across a filter change')
  })
})

// ------------------------------------------------- fetch: 200 + success:false

test('classifyFetch treats a 200 carrying success:false as a credit failure', () => {
  const refused = classifyFetch({ success: false, message: 'Insufficient credits' })
  assert.equal(refused.ok, false)
  assert.equal(refused.status, 'insufficient_credits')
  assert.equal(refused.message, 'Insufficient credits')
  assert.deepEqual(refused.contacts, [])

  const good = classifyFetch({ success: true, data: { list: [{ id: 1 }], metrics: { totalEmails: 1 } } })
  assert.equal(good.ok, true)
  assert.equal(good.contacts.length, 1)
})

test('a credit failure is a 200 outcome, stored as insufficient_credits, creating no leads', async () => {
  const saved = await client.post('/api/prospects/searches', { name: 'Credit test', filters: { title: ['Director'] } })
  assert.equal(saved.status, 200)
  const searchId = saved.body.id

  const before = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id = ?').get(owner.id).n

  const stub = {
    configured: () => true,
    call: async () => ({ success: false, message: 'You do not have enough credits' }),
  }
  const res = await withUpstream(stub, () =>
    client.post(`/api/prospects/searches/${searchId}/fetch`, { mode: 'count', count: 100 }))

  assert.equal(res.status, 200, 'a documented refusal is not an HTTP error')
  assert.equal(res.body.success, false)
  assert.equal(res.body.status, 'insufficient_credits')
  assert.equal(res.body.message, 'You do not have enough credits')

  const row = db.prepare('SELECT * FROM prospect_fetches WHERE id = ?').get(res.body.fetchId)
  assert.equal(row.status, 'insufficient_credits')
  assert.equal(row.fetched, 0)

  const after = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id = ?').get(owner.id).n
  assert.equal(after, before, 'a refused fetch creates no leads')
})

test('fetch validates exactly one of count and adaptIds, and the count ceiling', async () => {
  const saved = await client.post('/api/prospects/searches', { name: 'Ceilings', filters: {} })
  const id = saved.body.id

  const both = await client.post(`/api/prospects/searches/${id}/fetch`, { mode: 'count', count: 5, adaptIds: ['a'] })
  assert.equal(both.status, 422)
  assert.equal(both.body.field, 'count,adaptIds')

  const neither = await client.post(`/api/prospects/searches/${id}/fetch`, { mode: 'count' })
  assert.equal(neither.status, 422)

  const tooMany = await client.post(`/api/prospects/searches/${id}/fetch`, { mode: 'count', count: 10001 })
  assert.equal(tooMany.status, 422)
  assert.equal(tooMany.body.field, 'count')
  assert.match(tooMany.body.message, /10000/)
})

// ------------------------------------------------------------ workspace scope

test('another workspace cannot reach a saved search by id', async () => {
  const theirs = await mount(register, stranger)
  try {
    const mine = await client.post('/api/prospects/searches', { name: 'Mine only', filters: { title: ['CTO'] } })
    const id = mine.body.id

    for (const call of [
      () => theirs.put(`/api/prospects/searches/${id}/name`, { name: 'Hijacked' }),
      () => theirs.patch(`/api/prospects/searches/${id}/review`),
      () => theirs.post(`/api/prospects/searches/${id}/fetch`, { mode: 'count', count: 1 }),
      () => theirs.get(`/api/prospects/analytics?filterId=${id}`),
    ]) {
      const res = await call()
      assert.equal(res.status, 404)
      assert.equal(res.body.error, 'not_found')
      assert.ok(!JSON.stringify(res.body).includes('Mine only'), '404 leaks nothing about the record')
    }

    // And their own list does not contain it.
    const list = await theirs.get('/api/prospects/searches')
    assert.equal(list.status, 200)
    assert.equal(list.body.items.length, 0)

    // The owner still sees it unchanged.
    const still = db.prepare('SELECT name FROM prospect_searches WHERE id = ?').get(id)
    assert.equal(still.name, 'Mine only')
  } finally {
    await theirs.close()
  }
})

// ---------------------------------------------------------------- vocabularies

test('a cached filter lookup does not call the provider twice', async () => {
  let calls = 0
  const stub = {
    configured: () => true,
    call: async () => {
      calls++
      return { success: true, data: [{ id: 1, level_name: 'Entry' }, { id: 2, level_name: 'Director' }] }
    },
  }

  await withUpstream(stub, async () => {
    const first = await client.get('/api/prospects/filters/levels?limit=100')
    assert.equal(first.status, 200)
    assert.equal(first.body.cached, false)
    assert.deepEqual(first.body.items, [{ id: 1, name: 'Entry' }, { id: 2, name: 'Director' }])

    const second = await client.get('/api/prospects/filters/levels?limit=100')
    assert.equal(second.body.cached, true)
    assert.deepEqual(second.body.items, first.body.items)

    assert.equal(calls, 1, 'the second identical lookup is served from prospect_filter_cache')
  })

  const row = db.prepare('SELECT * FROM prospect_filter_cache WHERE kind = ?').get('levels')
  assert.ok(row, 'the vocabulary is cached in Harry’s own table, keyed (kind, query)')
})

test('with no provider every vocabulary route still answers honestly', async () => {
  const paths = [
    '/api/prospects/filters/cities', '/api/prospects/filters/countries',
    '/api/prospects/filters/states', '/api/prospects/filters/departments',
    '/api/prospects/filters/head-counts', '/api/prospects/filters/industries',
    '/api/prospects/filters/job-titles', '/api/prospects/filters/keywords',
    '/api/prospects/filters/revenue', '/api/prospects/filters/sub-industries',
    '/api/prospects/filters/companies', '/api/prospects/filters/domains',
  ]
  for (const path of paths) {
    const res = await client.get(path)
    assert.equal(res.status, 200, `${path} must not 500`)
    assert.equal(res.body.configured, false, `${path} reports the provider is missing`)
    assert.match(res.body.message, /PROSPECT_API_URL and PROSPECT_API_KEY/)
    assert.deepEqual(res.body.items, [], `${path} invents nothing`)
  }
})

test('company results are marked against the workspace’s own leads', async () => {
  seedLead(db, owner.id, 'ada@acme.test', { company: '  ACME  ' })
  let calls = 0
  const stub = {
    configured: () => true,
    call: async () => {
      calls++
      return { success: true, data: [{ company_name: 'Acme' }, { company_name: 'Globex' }] }
    },
  }
  await withUpstream(stub, async () => {
    const res = await client.get('/api/prospects/filters/companies?search=ac&limit=100')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.items, [
      { name: 'Acme', alreadyInLeads: true },     // case and whitespace insensitive
      { name: 'Globex', alreadyInLeads: false },
    ])
    assert.equal(res.body.hasMore, false, 'hasMore is derived from a full page, not a count')
  })
  assert.equal(calls, 1)
})

test('domains are normalised and deduplicated before anything is looked up', async () => {
  assert.equal(normaliseDomain('https://WWW.Acme.com/pricing?x=1'), 'acme.com')
  assert.equal(normaliseDomain('acme.com/'), 'acme.com')

  const res = await client.post('/api/prospects/filters/domains/reconcile', {
    domains: ['https://www.Globex.com/', 'globex.com', 'HOOLI.com'],
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.normalised, ['globex.com', 'hooli.com'])
  assert.equal(res.body.configured, false)
  assert.deepEqual(res.body.matched, [], 'nothing is claimed as matched without a provider')
  assert.deepEqual(res.body.unknown, ['globex.com', 'hooli.com'])
})

test('a reconcile list over the cap is a 422 naming the maximum', async () => {
  const titles = Array.from({ length: 1001 }, (_, i) => `Title ${i}`)
  const res = await client.post('/api/prospects/filters/job-titles/reconcile', { titles })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'titles')
  assert.match(res.body.message, /1000/)
})

// ------------------------------------------------------------- saved searches

test('saving writes an events row, previewing does not', async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type LIKE 'prospect_%'").get(owner.id).n

  const preview = await client.post('/api/prospects/search', { limit: 25, filters: { title: ['Head of Ops'] } })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.configured, false)
  assert.ok(preview.body.searchId, 'a preview still writes Harry’s own row')

  const mid = db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type LIKE 'prospect_%'").get(owner.id).n
  assert.equal(mid, before, 'a preview is not an audited action')

  const saved = await client.post('/api/prospects/searches', { name: 'Ops leaders', filters: { title: ['Head of Ops'] } })
  assert.equal(saved.status, 200)
  const after = db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type LIKE 'prospect_%'").get(owner.id).n
  assert.equal(after, before + 1, 'a save writes exactly one events row')
})

test('telemetry records which filters were set by name, never their values', async () => {
  const res = await client.post('/api/prospects/search', {
    limit: 10,
    filters: { title: ['Chief Sasquatch Officer'], countries: ['Atlantis'] },
  })
  assert.deepEqual(res.body.appliedFilters, ['title', 'countries'])
  const rows = db.prepare("SELECT detail FROM telemetry WHERE op = 'prospects.search' ORDER BY id DESC LIMIT 5").all()
  for (const row of rows) {
    assert.ok(!row.detail.includes('Sasquatch'), 'a filter value never reaches telemetry')
    assert.ok(!row.detail.includes('Atlantis'))
  }
})

test('the rename body carries only search_string', async () => {
  assert.deepEqual(Object.keys(renameBody('New name')), ['search_string'])

  const saved = await client.post('/api/prospects/searches', { name: 'Old name', filters: { title: ['VP'] } })
  const id = saved.body.id

  const blank = await client.put(`/api/prospects/searches/${id}/name`, { name: '' })
  assert.equal(blank.status, 422)
  assert.equal(blank.body.field, 'name')

  const tooLong = await client.put(`/api/prospects/searches/${id}/name`, { name: 'x'.repeat(256) })
  assert.equal(tooLong.status, 422)
  assert.match(tooLong.body.message, /255/)

  const ok = await client.put(`/api/prospects/searches/${id}/name`, { name: 'New name' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.previousName, 'Old name')
  assert.equal(db.prepare('SELECT name FROM prospect_searches WHERE id = ?').get(id).name, 'New name')

  const zero = await client.put('/api/prospects/searches/0/name', { name: 'nope' })
  assert.equal(zero.status, 422, 'the rename pattern excludes zero')
})

test('saved and recent listings page and stay inside the workspace', async () => {
  const saved = await client.get('/api/prospects/searches?limit=2&offset=0')
  assert.equal(saved.status, 200)
  assert.ok(saved.body.items.length <= 2)
  assert.equal(typeof saved.body.totalCount, 'number')
  assert.ok(saved.body.items.every((i) => i.isSaved))

  const recent = await client.get('/api/prospects/searches/recent?limit=3')
  assert.equal(recent.status, 200)
  assert.ok(recent.body.items.length <= 3)
  assert.ok(recent.body.items.every((i) => typeof i.summary === 'string'))

  const bad = await client.get('/api/prospects/searches?limit=0')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'limit')
})

test('review is validated, recorded and never touches a lead’s address', async () => {
  const lead = seedLead(db, owner.id, 'review@acme.test')
  const saved = await client.post('/api/prospects/searches', { name: 'Review me', filters: { title: ['CFO'] } })
  const searchId = saved.body.id

  const fetchId = Number(db.prepare(
    "INSERT INTO prospect_fetches (workspace_id, search_id, name, requested, status) VALUES (?, ?, 'run', 1, 'done')"
  ).run(owner.id, searchId).lastInsertRowid)
  db.prepare(
    `INSERT INTO prospect_contacts (workspace_id, fetch_id, email, email_verification_status, imported_lead_id)
     VALUES (?, ?, ?, 'invalid', ?)`
  ).run(owner.id, fetchId, 'review@acme.test', lead.id)

  const bad = await client.patch('/api/prospects/searches/abc/review')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'filterId')

  const res = await client.patch(`/api/prospects/searches/${searchId}/review`)
  assert.equal(res.status, 200)
  assert.equal(res.body.leadsFlagged, 1)

  const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  assert.equal(after.email, 'review@acme.test', 'a review never rewrites the address')
  assert.equal(after.email_verification_status, 'invalid', 'only the status moves')
})

// -------------------------------------------------------------------- fetches

test('the fetch history lists Harry’s own rows and renames validate', async () => {
  const list = await client.get('/api/prospects/fetches?limit=5')
  assert.equal(list.status, 200)
  assert.equal(list.body.configured, false)
  assert.ok(Array.isArray(list.body.items))

  const id = list.body.items[0].id
  const blank = await client.put(`/api/prospects/fetches/${id}/name`, { name: '' })
  assert.equal(blank.status, 422)

  const ok = await client.put(`/api/prospects/fetches/${id}/name`, { name: 'Renamed list' })
  assert.equal(ok.status, 200)
  assert.equal(db.prepare('SELECT name FROM prospect_fetches WHERE id = ?').get(id).name, 'Renamed list')

  const theirs = await mount(register, stranger)
  try {
    const cross = await theirs.put(`/api/prospects/fetches/${id}/name`, { name: 'Hijacked' })
    assert.equal(cross.status, 404)
  } finally { await theirs.close() }
})

test('contacts require exactly one of filterId and adaptIds', async () => {
  const both = await client.post('/api/prospects/contacts', { filterId: 1, adaptIds: ['a'] })
  assert.equal(both.status, 422)
  assert.equal(both.body.field, 'filterId,adaptIds')

  const neither = await client.post('/api/prospects/contacts', {})
  assert.equal(neither.status, 422)
  assert.equal(neither.body.field, 'filterId,adaptIds')

  const badStatus = await client.post('/api/prospects/contacts', { adaptIds: ['a'], verificationStatus: 'maybe' })
  assert.equal(badStatus.status, 422)
  assert.equal(badStatus.body.field, 'verificationStatus')
  assert.match(badStatus.body.message, /valid, catch_all, invalid/)

  const tooMany = await client.post('/api/prospects/contacts', {
    adaptIds: Array.from({ length: 201 }, (_, i) => `id${i}`),
  })
  assert.equal(tooMany.status, 422)
  assert.match(tooMany.body.message, /200/)
})

test('fetched contacts are marked against existing leads', async () => {
  const saved = await client.post('/api/prospects/searches', { name: 'Marked', filters: {} })
  const fetchId = Number(db.prepare(
    "INSERT INTO prospect_fetches (workspace_id, search_id, name, requested, status) VALUES (?, ?, 'run', 2, 'done')"
  ).run(owner.id, saved.body.id).lastInsertRowid)
  db.prepare(
    `INSERT INTO prospect_contacts (workspace_id, fetch_id, first_name, last_name, email)
     VALUES (?, ?, 'Ada', 'Lovelace', 'ada@acme.test'), (?, ?, 'Grace', 'Hopper', 'grace@navy.test')`
  ).run(owner.id, fetchId, owner.id, fetchId)

  const res = await client.post('/api/prospects/contacts', { filterId: saved.body.id, limit: 10 })
  assert.equal(res.status, 200)
  const byEmail = Object.fromEntries(res.body.items.map((i) => [i.email, i.alreadyInLeads]))
  assert.equal(byEmail['ada@acme.test'], true)      // seeded earlier
  assert.equal(byEmail['grace@navy.test'], false)
})

// ----------------------------------------------------------------- find emails

test('find-emails reports ineligible leads by the field that is missing', async () => {
  const complete = seedLead(db, owner.id, 'full@acme.test', { first_name: 'Ada', last_name: 'Byron' })
  db.prepare("UPDATE leads SET website = 'https://acme.test' WHERE id = ?").run(complete.id)
  const partial = seedLead(db, owner.id, 'partial@nowhere.test', { first_name: '', last_name: '' })

  const res = await client.post('/api/leads/find-emails', { leadIds: [complete.id, partial.id] })
  assert.equal(res.status, 200)
  assert.equal(res.body.configured, false)
  assert.equal(res.body.requested, 1)
  assert.deepEqual(res.body.ineligible, [{ leadId: partial.id, missing: ['firstName', 'lastName'] }])

  const job = await client.get(`/api/leads/find-emails/${res.body.jobId}`)
  assert.equal(job.status, 200)
  assert.equal(job.body.status, 'pending')
  assert.equal(job.body.requested, 1)

  const stranger404 = await mount(register, stranger)
  try {
    const cross = await stranger404.get(`/api/leads/find-emails/${res.body.jobId}`)
    assert.equal(cross.status, 404)
  } finally { await stranger404.close() }
})

test('find-emails batches at ten', async () => {
  const ids = []
  for (let i = 0; i < 25; i++) {
    const lead = seedLead(db, owner.id, `batch${i}@acme.test`, { first_name: 'B', last_name: `L${i}` })
    ids.push(lead.id)
  }
  const res = await client.post('/api/leads/find-emails', { leadIds: ids })
  assert.equal(res.status, 200)
  assert.equal(res.body.requested, 25)
  assert.equal(res.body.batches, 3, '25 leads become three requests of at most ten')
})

test('a "Not Found" row never writes an address onto a lead', () => {
  const lead = seedLead(db, owner.id, 'keepme@acme.test')
  const out = applyFoundEmail(owner.id, lead.id, { status: 'Not Found', email_id: '', verification_status: null })
  assert.equal(out.written, false)
  const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  assert.equal(after.email, 'keepme@acme.test')
  assert.equal(after.email_verification_status, '')
})

// ------------------------------------------------------------ the provider key

test('the provider key never appears in any response body', async () => {
  process.env.PROSPECT_API_KEY = 'super-secret-key-do-not-leak'
  try {
    const responses = [
      await client.post('/api/prospects/search', { limit: 10, filters: { title: ['CTO'] } }),
      await client.post('/api/prospects/searches', { name: 'Key check', filters: {} }),
      await client.get('/api/prospects/searches'),
      await client.get('/api/prospects/searches/recent'),
      await client.get('/api/prospects/fetches'),
      await client.get('/api/prospects/analytics'),
      await client.get('/api/prospects/reply-analytics'),
      await client.get('/api/prospects/filters/countries'),
      await client.post('/api/prospects/filters/keywords/reconcile', { signals: ['devops'] }),
    ]
    for (const res of responses) {
      const text = JSON.stringify(res.body)
      assert.ok(!text.includes('super-secret-key-do-not-leak'), 'the provider key stays on the server')
      assert.ok(!text.includes('scroll_id'), 'no provider cursor concept reaches the client')
      assert.ok(!text.includes('filter_id'), 'no provider filter id reaches the client')
      assert.ok(!text.includes('provider_filter_id'))
    }
  } finally {
    delete process.env.PROSPECT_API_KEY
  }
})

test('analytics and reply analytics degrade without throwing', async () => {
  const analytics = await client.get('/api/prospects/analytics')
  assert.equal(analytics.status, 200)
  assert.equal(analytics.body.configured, false)
  assert.equal(analytics.body.maxSingleFetchLimit, null)

  const badFilter = await client.get('/api/prospects/analytics?filterId=abc')
  assert.equal(badFilter.status, 422)
  assert.equal(badFilter.body.field, 'filterId')

  const replies = await client.get('/api/prospects/reply-analytics')
  assert.equal(replies.status, 200)
  assert.equal(replies.body.configured, false)
  assert.equal(replies.body.percentageChange, null)
})
