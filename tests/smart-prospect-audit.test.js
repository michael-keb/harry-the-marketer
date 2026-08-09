// smart-prospect, second pass — Docs/smart-prospect/*.
//
// The sibling file (tests/parity-prospects.test.js) proves the shapes: ceilings,
// 422 fields, workspace scoping, the mapping table. This file is about what the
// module DOES — what ends up in SQLite, what leaves for the provider, and, above
// all, what it says when it does not know.
//
// This category talks to a provider that is not configured here, and the failure
// it is most prone to is a confident answer built out of nothing: a total of
// zero when nothing was searched, "no changes" when nothing was reviewed, "that
// band is gone" when no band list was ever fetched. Each of those reads as a
// finding to the person looking at it. Every test below asserts a stored row, an
// outgoing request, or an explicit unknown — never an envelope.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, mount } from './helpers/parity-harness.js'

setup('smart-prospect-audit')

const { db } = await import('../server/db.js')
const {
  register, upstream, identityKey, translateSearch, ALLOWED_PROVIDER_KEYS,
} = await import('../server/parity/prospects.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// Replace the one network seam for a single test and always put it back.
async function withUpstream(stub, fn) {
  const realConfigured = upstream.configured
  const realCall = upstream.call
  upstream.configured = stub.configured ?? (() => true)
  upstream.call = stub.call
  try { return await fn() } finally {
    upstream.configured = realConfigured
    upstream.call = realCall
  }
}

// A stub that records every outgoing path and body, so a test can assert what
// was sent rather than only what came back.
function recorder(respond) {
  const calls = []
  return {
    calls,
    configured: () => true,
    call: async (path, opts = {}) => {
      calls.push({ path, method: opts.method || 'GET', body: opts.body ?? null })
      return respond(path, opts)
    },
    query: (path, key) => new URL(path, 'http://provider.test').searchParams.get(key),
    paths: () => calls.map((c) => c.path),
  }
}

function saveSearch(name, filters = {}) {
  return client.post('/api/prospects/searches', { name, filters })
}

function linkSearch(id, providerId) {
  db.prepare('UPDATE prospect_searches SET provider_filter_id = ? WHERE id = ?').run(String(providerId), id)
}

// ============================================================ honest unknowns

test('a cached filter list stops claiming the provider is connected', async () => {
  const stub = recorder(() => ({
    success: true,
    data: [{ id: 1, department_name: 'Engineering' }, { id: 2, department_name: 'Enablement' }],
  }))

  const live = await withUpstream(stub, () =>
    client.get('/api/prospects/filters/departments?search=engcache&limit=100'))
  assert.equal(live.status, 200)
  assert.equal(live.body.configured, true)
  assert.equal(live.body.cached, false)
  assert.equal(stub.calls.length, 1)

  // Same query, no credentials. The rows are real and still worth serving — but
  // `configured` describes the CONNECTION, and there isn't one. Reporting true
  // here would light up a working integration on the strength of a stale lookup
  // somebody else's workspace warmed.
  const offline = await client.get('/api/prospects/filters/departments?search=engcache&limit=100')
  assert.equal(offline.status, 200)
  assert.equal(offline.body.cached, true)
  assert.equal(offline.body.configured, false, 'a cache hit is not a connection')
  assert.match(offline.body.message, /PROSPECT_API_URL and PROSPECT_API_KEY/)
  assert.deepEqual(offline.body.items, live.body.items, 'the real cached rows are still served')
  assert.equal(stub.calls.length, 1, 'and no second call was attempted')

  const row = db.prepare('SELECT * FROM prospect_filter_cache WHERE kind = ?').get('departments')
  assert.ok(row, 'the vocabulary lives in Harry’s own table')
})

test('an unsearched audience has an unknown total, not a total of zero', async () => {
  const res = await client.post('/api/prospects/search', { limit: 25, filters: { title: ['CFO'] } })
  assert.equal(res.status, 200)
  assert.equal(res.body.configured, false)
  assert.deepEqual(res.body.items, [])
  // Zero is a finding — "nobody matches these filters" — and the empty state
  // that follows tells the user to relax a filter that was never applied.
  assert.equal(res.body.totalCount, null, 'nothing was searched, so nothing is known')

  // The draft is still Harry's own row, with the filters exactly as sent.
  const row = db.prepare('SELECT * FROM prospect_searches WHERE id = ?').get(res.body.searchId)
  assert.equal(row.workspace_id, owner.id)
  assert.equal(row.is_saved, 0)
  assert.deepEqual(JSON.parse(row.filters), { title: ['CFO'] })
  assert.equal(row.total_count, 0, 'the column keeps its default; the response does not report it as a count')
})

test('a review nobody performed does not report that nothing changed', async () => {
  const saved = await saveSearch('Unlinked review', { title: ['COO'] })
  const searchId = saved.body.id

  const res = await client.patch(`/api/prospects/searches/${searchId}/review`)
  assert.equal(res.status, 200)
  assert.equal(res.body.configured, false)
  // `records_updated: 0` is a documented finding: "nothing has changed since the
  // last review". "We never asked" must not render as that same sentence.
  assert.equal(res.body.recordsUpdated, null)
  assert.equal(res.body.providerReviewed, false)
  assert.equal(res.body.notReviewedBecause, 'provider_not_configured')
  assert.equal(res.body.verificationStatusList, null, 'the quality filters are not invented either')

  const stored = JSON.parse(db.prepare('SELECT last_review FROM prospect_searches WHERE id = ?').get(searchId).last_review)
  assert.equal(stored.providerReviewed, false)
  assert.equal(stored.recordsUpdated, null, 'the stored review says so too, not just the response')
})

test('a real review records the provider’s figure and moves the lead’s status only', async () => {
  const lead = seedLead(db, owner.id, 'stale@acme.test')
  const saved = await saveSearch('Linked review', { title: ['CTO'] })
  const searchId = saved.body.id
  linkSearch(searchId, 327105)

  const fetchId = Number(db.prepare(
    "INSERT INTO prospect_fetches (workspace_id, search_id, name, requested, status) VALUES (?, ?, 'run', 1, 'done')"
  ).run(owner.id, searchId).lastInsertRowid)
  db.prepare(
    `INSERT INTO prospect_contacts (workspace_id, fetch_id, email, email_verification_status, imported_lead_id)
     VALUES (?, ?, ?, 'catch_all_hard_bounced', ?)`
  ).run(owner.id, fetchId, 'stale@acme.test', lead.id)

  const stub = recorder(() => ({
    success: true,
    data: {
      filter_id: 327105,
      records_updated: 7,
      fetch_details: {
        leads_found: 40,
        email_fetched: 31,
        metrics: { totalContacts: 40, totalEmails: 31, invalidEmails: 2 },
        verification_status_list: ['valid', 'invalid'],
        catch_all_status_list: ['catch_all_verified'],
      },
    },
  }))

  const res = await withUpstream(stub, () => client.patch(`/api/prospects/searches/${searchId}/review`))
  assert.equal(res.status, 200)
  assert.equal(res.body.providerReviewed, true)
  assert.equal(res.body.recordsUpdated, 7)
  assert.deepEqual(res.body.verificationStatusList, ['valid', 'invalid'],
    'the available quality filters come from the response, not a hardcoded set')
  assert.equal(res.body.leadsFlagged, 1)

  // The provider's own id is what went in the URL, and it never comes back out.
  assert.equal(stub.calls[0].path, '/api/v1/search-email-leads/review-contacts/327105')
  assert.equal(stub.calls[0].method, 'PATCH')
  assert.equal(stub.calls[0].body, null, 'this endpoint documents no request body')
  assert.ok(!JSON.stringify(res.body).includes('327105'), 'the provider filter id stays server-side')

  const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  assert.equal(after.email, 'stale@acme.test', 'a review never rewrites the address')
  assert.equal(after.email_verification_status, 'catch_all_hard_bounced', 'only the status moves')
})

test('revenue bands are never declared dead on the strength of an empty list', async () => {
  // No provider and nothing cached: there is no list of active options to check
  // a draft's selections against, so no selection is struck.
  const blind = await client.get('/api/prospects/filters/revenue?staleIds=3,9')
  assert.equal(blind.status, 200)
  assert.equal(blind.body.configured, false)
  assert.deepEqual(blind.body.stale, [], 'an unknown is not a verdict')
  assert.equal(blind.body.staleUnknown, true)

  const stub = recorder(() => ({
    success: true,
    data: [{ id: 3, revenue: '$1M-$10M' }, { id: 4, revenue: '$10M-$50M' }],
  }))
  const live = await withUpstream(stub, () => client.get('/api/prospects/filters/revenue?staleIds=3,9'))
  assert.equal(live.body.configured, true)
  assert.equal(live.body.staleUnknown, false)
  assert.deepEqual(live.body.stale, ['9'], 'now there is a list, and only the missing band is flagged')
  assert.deepEqual(live.body.items, [
    { id: 3, label: '$1M-$10M' },
    { id: 4, label: '$10M-$50M' },
  ], 'bands render verbatim, currency symbol included')

  // This endpoint documents no limit, offset or search, so none is sent.
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].path, '/api/v1/search-email-leads/revenue', 'no query string is assembled')
})

// ================================================================== searching

test('a live search stores the provider’s handle and total on Harry’s row', async () => {
  const stub = recorder(() => ({
    success: true,
    data: {
      list: [{
        id: 'adapt-1', firstName: 'Ada', lastName: 'Byron', fullName: 'Ada Byron',
        title: 'Head of Ops', company: { name: 'Acme', website: 'acme.com' },
        department: ['Operations', 'Finance'], level: 'Director', industry: 'Technology',
        email: 'preview@acme.test', emailDeliverability: 0.95,
      }],
      total_count: 16064669,
      filter_id: 424242,
      scroll_id: 'SCROLL-XYZ',
    },
  }))

  const res = await withUpstream(stub, () => client.post('/api/prospects/search', {
    limit: 10,
    filters: { title: ['Head of Ops'], hideOwnedContacts: true, favouriteColour: 'blue' },
  }))
  assert.equal(res.status, 200)
  assert.equal(res.body.totalCount, 16064669)
  assert.deepEqual(res.body.ignoredFilters, ['favouriteColour'], 'a stale UI field is reported, not dropped in silence')

  // The outgoing body carries the documented names and nothing else.
  const sent = stub.calls[0].body
  for (const key of Object.keys(sent)) {
    assert.ok(ALLOWED_PROVIDER_KEYS.has(key), `undocumented key sent upstream: ${key}`)
  }
  assert.deepEqual(sent.title, ['Head of Ops'])
  assert.equal(sent.dontDisplayOwnedContact, true)
  assert.ok(!('favouriteColour' in sent))

  // `department` is an array while `level` and `industry` are plain strings.
  assert.deepEqual(res.body.items[0].departments, ['Operations', 'Finance'])
  assert.equal(res.body.items[0].level, 'Director')
  assert.equal(res.body.items[0].emailIsPreviewOnly, true, 'a preview address is labelled, never offered as usable')
  assert.equal(res.body.items[0].deliverability, 0.95)

  // The handle every later endpoint needs is written to Harry's row, and the
  // client is given an opaque cursor instead of the provider's scroll id.
  const row = db.prepare('SELECT * FROM prospect_searches WHERE id = ?').get(res.body.searchId)
  assert.equal(row.provider_filter_id, '424242')
  assert.equal(row.total_count, 16064669)
  assert.ok(res.body.cursor && res.body.cursor !== 'SCROLL-XYZ')
  assert.ok(!JSON.stringify(res.body).includes('424242'))
})

// ============================================================ saved searches

test('a saved search is only orphaned when the provider’s whole list has been seen', async () => {
  const theirs = await mount(register, seedUser(db, 'third@example.com'))
  await theirs.close()

  const one = await saveSearch('Page one search', { title: ['A'] })
  const two = await saveSearch('Page two search', { title: ['B'] })
  const never = await saveSearch('Never linked search', { title: ['C'] })
  linkSearch(one.body.id, 111)
  linkSearch(two.body.id, 222)

  // The listing is paged, and the count that says whether a page is the whole
  // list sits at `data.totalCount`, not inside a pagination object.
  const partial = recorder(() => ({
    success: true,
    data: { savedSearches: [{ id: 111, search_string: 'Page one search' }], totalCount: 2 },
  }))
  const incomplete = await withUpstream(partial, () => client.get('/api/prospects/searches?limit=10'))
  assert.equal(incomplete.status, 200)
  const byName = (body) => Object.fromEntries(body.items.map((i) => [i.name, i]))
  const seenPartial = byName(incomplete.body)
  assert.equal(seenPartial['Page two search'].orphaned, false,
    'a search on page two is missing from the page, not missing from the account')

  const complete = recorder(() => ({
    success: true,
    data: { savedSearches: [{ id: 111, search_string: 'Page one search' }], totalCount: 1 },
  }))
  const full = await withUpstream(complete, () => client.get('/api/prospects/searches?limit=10'))
  const seenFull = byName(full.body)
  assert.equal(seenFull['Page one search'].orphaned, false)
  assert.equal(seenFull['Page two search'].orphaned, true, 'linked, and gone from a complete list')
  assert.equal(seenFull['Never linked search'].orphaned, false,
    'a search that was never at the provider cannot have been deleted from it')
  assert.equal(seenFull['Never linked search'].linked, false)

  // Nothing was written by a read.
  assert.equal(db.prepare('SELECT provider_filter_id FROM prospect_searches WHERE id = ?').get(two.body.id)
    .provider_filter_id, '222')
})

test('a second save under the same name is warned about rather than refused', async () => {
  const first = await saveSearch('Q3 ANZ operations', { title: ['Ops'] })
  assert.equal(first.status, 200)
  assert.equal(first.body.duplicateName, false)

  const second = await saveSearch('  q3 anz operations  ', { title: ['Ops'] })
  assert.equal(second.status, 200)
  assert.equal(second.body.duplicateName, true, 'the provider documents no uniqueness rule, so the collision is reported')

  const rows = db.prepare(
    'SELECT COUNT(*) AS n FROM prospect_searches WHERE workspace_id = ? AND is_saved = 1 AND lower(trim(name)) = ?'
  ).get(owner.id, 'q3 anz operations').n
  assert.equal(rows, 2, 'and both exist, because Harry does not invent a rule the API does not have')
})

test('renaming a saved search addresses the provider by its own id and sends only the name', async () => {
  const saved = await saveSearch('Before rename', { title: ['VP'] })
  linkSearch(saved.body.id, 327105)

  const stub = recorder(() => ({ success: true, message: 'Saved search updated successfully' }))
  const res = await withUpstream(stub, () =>
    client.put(`/api/prospects/searches/${saved.body.id}/name`, { name: 'After rename' }))
  assert.equal(res.status, 200)

  const put = stub.calls.find((c) => c.method === 'PUT')
  assert.equal(put.path, '/api/v1/search-email-leads/search-filters/save-search/327105',
    'the provider’s id, not Harry’s row id')
  assert.deepEqual(Object.keys(put.body), ['search_string'], 'criteria cannot be edited through this endpoint')
  assert.equal(put.body.search_string, 'After rename')

  assert.equal(db.prepare('SELECT name FROM prospect_searches WHERE id = ?').get(saved.body.id).name, 'After rename')
})

// ================================================================== fetching

test('a fetch creates leads, stores every contact, and skips the unusable ones', async () => {
  const existing = seedLead(db, owner.id, 'grace@navy.test', { first_name: 'Grace', company: 'Navy' })
  const saved = await saveSearch('Fetch me', { title: ['Engineer'] })
  linkSearch(saved.body.id, 900001)

  const stub = recorder((path) => {
    if (path.startsWith('/api/v1/search-email-leads/fetch-contacts')) {
      return {
        success: true,
        message: 'Contacts fetched',
        data: {
          list: [
            { id: 'a1', firstName: 'Ada', lastName: 'Byron', email: 'ada@acme.test', status: 'valid', title: 'CTO', company: { name: 'Acme', website: 'acme.com' } },
            { id: 'a2', firstName: 'Grace', lastName: 'Hopper', email: 'grace@navy.test', status: 'catch_all_verified', company: { name: 'US Navy' } },
            { id: 'a3', firstName: 'Nobody', lastName: 'Home', email: '', status: 'invalid' },
          ],
          metrics: { totalContacts: 3, totalEmails: 2, noEmailFound: 1 },
        },
      }
    }
    throw new Error(`unexpected path ${path}`)
  })

  const res = await withUpstream(stub, () =>
    client.post(`/api/prospects/searches/${saved.body.id}/fetch`, { mode: 'count', count: 3 }))
  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)
  assert.deepEqual(
    { created: res.body.leadsCreated, updated: res.body.leadsUpdated, skipped: res.body.skipped },
    { created: 1, updated: 1, skipped: 1 })

  // The outgoing body carries the provider's filter id, taken from Harry's row.
  assert.equal(stub.calls[0].body.filter_id, '900001')
  assert.equal(stub.calls[0].body.limit, 3)

  const fetchRow = db.prepare('SELECT * FROM prospect_fetches WHERE id = ?').get(res.body.fetchId)
  assert.equal(fetchRow.status, 'done')
  assert.equal(fetchRow.fetched, 3)
  assert.equal(fetchRow.credits_used, 2, 'credits come from the reported metrics, not the row count')

  const contacts = db.prepare('SELECT * FROM prospect_contacts WHERE fetch_id = ? ORDER BY id').all(res.body.fetchId)
  assert.equal(contacts.length, 3, 'every contact is stored, including the one that made no lead')
  assert.ok(contacts[0].imported_lead_id)
  assert.ok(contacts[1].imported_lead_id)
  assert.equal(contacts[2].imported_lead_id, null, 'an unusable address is never written as a blank lead')
  assert.equal(contacts[2].email, '')

  const created = db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(owner.id, 'ada@acme.test')
  assert.ok(created, 'a usable contact becomes a real lead')
  assert.equal(created.email_source, 'prospect_fetch')
  assert.equal(created.email_verification_status, 'valid')
  assert.equal(created.title, 'CTO')

  const filled = db.prepare('SELECT * FROM leads WHERE id = ?').get(existing.id)
  assert.equal(filled.first_name, 'Grace', 'a name a human entered is not overwritten')
  assert.equal(filled.company, 'Navy', 'nor a company')
  assert.equal(filled.email_verification_status, 'catch_all_verified', 'but the fresh status is taken')

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND email = ?')
    .get(owner.id, 'grace@navy.test').n, 1, 'and no duplicate lead is made')
})

test('a repeated fetch inside the window is answered from the first, not charged again', async () => {
  const saved = await saveSearch('Double click', {})
  linkSearch(saved.body.id, 900002)

  const stub = recorder(() => ({ success: true, data: { list: [], metrics: { totalEmails: 0 } } }))
  const body = { mode: 'count', count: 7 }

  const [first, second] = await withUpstream(stub, async () => [
    await client.post(`/api/prospects/searches/${saved.body.id}/fetch`, body),
    await client.post(`/api/prospects/searches/${saved.body.id}/fetch`, body),
  ])

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.ok(!first.body.idempotent)
  assert.equal(second.body.idempotent, true)
  assert.equal(second.body.fetchId, first.body.fetchId, 'the same receipt, not a second one')
  assert.equal(stub.calls.length, 1, 'one upstream call, so one charge')

  const rows = db.prepare('SELECT COUNT(*) AS n FROM prospect_fetches WHERE workspace_id = ? AND search_id = ?')
    .get(owner.id, saved.body.id).n
  assert.equal(rows, 1, 'and one row in the fetch history')
})

test('the fetch history joins provider rows by name, because the ids are different things', async () => {
  const saved = await saveSearch('History source', {})
  linkSearch(saved.body.id, 555)
  const localId = Number(db.prepare(
    `INSERT INTO prospect_fetches (workspace_id, search_id, provider_filter_id, name, requested, fetched, status)
     VALUES (?, ?, '555', 'Marketing pull', 10, 10, 'done')`
  ).run(owner.id, saved.body.id).lastInsertRowid)

  const stub = recorder(() => ({
    success: true,
    data: {
      fetchedLeads: [
        // The fetched list's own id — a different id space from the search's
        // filter id. A join on `provider_filter_id` would match this decoy.
        { id: 555, search_string: 'Somebody else’s list', fetch_details: { leads_found: 999 } },
        { id: 327107, search_string: 'Marketing pull', fetch_details: { leads_found: 12, email_fetched: 9 } },
      ],
      totalCount: 2,
    },
  }))

  const res = await withUpstream(stub, () => client.get('/api/prospects/fetches?limit=10'))
  assert.equal(res.status, 200)
  const row = res.body.items.find((i) => i.id === localId)
  assert.equal(row.linked, true)
  assert.equal(row.fetchDetails.leads_found, 12, 'the row’s own figures, not the decoy’s 999')
})

test('renaming a fetched list never puts Harry’s row id in the provider’s URL', async () => {
  const localId = Number(db.prepare(
    `INSERT INTO prospect_fetches (workspace_id, provider_filter_id, name, requested, status)
     VALUES (?, '555', 'Original list', 5, 'done')`
  ).run(owner.id).lastInsertRowid)

  const stub = recorder((path, opts) => {
    if (opts.method === 'PUT') return { success: true, message: 'Fetched lead updated successfully' }
    return {
      success: true,
      data: { fetchedLeads: [{ id: 327107, search_string: 'Original list' }], totalCount: 1 },
    }
  })

  const res = await withUpstream(stub, () =>
    client.put(`/api/prospects/fetches/${localId}/name`, { name: 'Q3 ANZ ops leaders' }))
  assert.equal(res.status, 200)
  assert.equal(res.body.providerLinked, true)

  const put = stub.calls.find((c) => c.method === 'PUT')
  assert.equal(put.path, '/api/v1/search-email-leads/search-filters/fetched-searches/327107')
  assert.deepEqual(Object.keys(put.body), ['search_string'])
  for (const call of stub.calls) {
    assert.ok(!call.path.endsWith(`/fetched-searches/${localId}`),
      'Harry’s own row id is not a provider id and is never sent as one')
  }
  assert.equal(db.prepare('SELECT name FROM prospect_fetches WHERE id = ?').get(localId).name, 'Q3 ANZ ops leaders')
})

test('a fetched list the provider does not list is renamed locally and said to be unlinked', async () => {
  const localId = Number(db.prepare(
    `INSERT INTO prospect_fetches (workspace_id, name, requested, status) VALUES (?, 'Only here', 1, 'done')`
  ).run(owner.id).lastInsertRowid)

  const stub = recorder(() => ({ success: true, data: { fetchedLeads: [], totalCount: 0 } }))
  const res = await withUpstream(stub, () =>
    client.put(`/api/prospects/fetches/${localId}/name`, { name: 'Still only here' }))

  assert.equal(res.status, 200)
  assert.equal(res.body.providerLinked, false)
  assert.equal(stub.calls.filter((c) => c.method === 'PUT').length, 0,
    'no id could be resolved, so no rename is guessed at')
  assert.equal(db.prepare('SELECT name FROM prospect_fetches WHERE id = ?').get(localId).name, 'Still only here')
})

// ==================================================================== states

test('country ids are resolved to names before the state list is asked for', async () => {
  const stub = recorder((path) => {
    if (path.startsWith('/api/v1/search-email-leads/countries')) {
      return {
        success: true,
        data: [
          { id: 1, country_name: 'United States' },
          { id: 2, country_name: 'Canada' },
        ],
      }
    }
    return { success: true, data: [{ id: 10, state_name: 'California' }, { id: 11, state_name: 'Ontario' }] }
  })

  // Cold cache: the countries list is loaded rather than given up on, because an
  // unresolved id would otherwise mean an unfiltered request for every region on
  // earth presented as though it were narrowed.
  const res = await withUpstream(stub, () =>
    client.get('/api/prospects/filters/states?countryIds=1,2&search=res1'))
  assert.equal(res.status, 200)
  assert.equal(res.body.narrowed, true)
  assert.deepEqual(res.body.unresolvedCountryIds, [])

  const statesCall = stub.calls.find((c) => c.path.startsWith('/api/v1/search-email-leads/states'))
  assert.ok(statesCall, 'the state list was requested')
  assert.equal(stub.query(statesCall.path, 'country'), 'United States,Canada',
    'names, comma-separated — an id here would silently return nothing')
  assert.equal(res.body.items.length, 2)
})

test('an unresolvable country never yields the whole world dressed up as a narrowed list', async () => {
  const stub = recorder((path) => {
    if (path.startsWith('/api/v1/search-email-leads/countries')) return { success: true, data: [{ id: 1, country_name: 'United States' }] }
    return { success: true, data: [{ id: 99, state_name: 'Everywhere' }] }
  })

  const res = await withUpstream(stub, () =>
    client.get('/api/prospects/filters/states?countryIds=9999&search=res2'))
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items, [], 'nothing is returned rather than everything')
  assert.deepEqual(res.body.unresolvedCountryIds, ['9999'])
  assert.equal(res.body.narrowed, false)
  assert.equal(stub.calls.filter((c) => c.path.startsWith('/api/v1/search-email-leads/states')).length, 0,
    'and no unfiltered state request is made')
})

test('a country list over 255 characters is split and merged without duplicates', async () => {
  // A cold countries cache, so the resolution step runs for real.
  db.prepare("DELETE FROM prospect_filter_cache WHERE kind = 'countries'").run()
  const names = Array.from({ length: 20 }, (_, i) => `Republic of Very Long Country Name ${i}`)
  const stub = recorder((path) => {
    if (path.startsWith('/api/v1/search-email-leads/countries')) {
      return { success: true, data: names.map((country_name, i) => ({ id: i + 100, country_name })) }
    }
    // One state per requested country, plus a shared one to prove the merge
    // deduplicates rather than concatenating.
    const country = new URL(path, 'http://p.test').searchParams.get('country') || ''
    const first = country.split(',')[0]
    return {
      success: true,
      data: [
        { id: `s-${first}`, state_name: `State of ${first}` },
        { id: 'shared', state_name: 'Shared region' },
      ],
    }
  })

  const ids = Array.from({ length: 20 }, (_, i) => i + 100).join(',')
  const res = await withUpstream(stub, () =>
    client.get(`/api/prospects/filters/states?countryIds=${ids}&search=res3`))
  assert.equal(res.status, 200)
  assert.ok(res.body.splitRequests > 1, `a long country string is split (was ${res.body.splitRequests})`)

  const stateCalls = stub.calls.filter((c) => c.path.startsWith('/api/v1/search-email-leads/states'))
  assert.equal(stateCalls.length, res.body.splitRequests)
  for (const call of stateCalls) {
    assert.ok((stub.query(call.path, 'country') || '').length <= 255, 'no chunk exceeds the documented cap')
  }
  const seen = res.body.items.map((i) => i.id)
  assert.equal(new Set(seen).size, seen.length, 'the merged list has no duplicates')
  assert.equal(seen.filter((id) => id === 'shared').length, 1)
})

test('a state selection is flagged stale only when a real list came back', async () => {
  db.prepare("DELETE FROM prospect_filter_cache WHERE kind = 'countries'").run()
  const stub = recorder((path) => {
    if (path.startsWith('/api/v1/search-email-leads/countries')) return { success: true, data: [{ id: 1, country_name: 'United States' }] }
    return { success: true, data: [{ id: 10, state_name: 'California' }] }
  })

  const live = await withUpstream(stub, () =>
    client.get('/api/prospects/filters/states?countryIds=1&stateIds=10,11&search=res4'))
  assert.equal(live.status, 200)
  assert.equal(live.body.staleUnknown, false)
  assert.deepEqual(live.body.staleStateIds, ['11'], 'flagged, not silently dropped')

  // No provider and nothing cached for this query: no list, so no verdict.
  const blind = await client.get('/api/prospects/filters/states?stateIds=10,11&search=res5')
  assert.equal(blind.status, 200)
  assert.equal(blind.body.configured, false)
  assert.equal(blind.body.staleUnknown, true)
  assert.deepEqual(blind.body.staleStateIds, [], 'a selection is not struck on the strength of an empty list')
})

// =============================================================== find emails

test('a found address goes to the lead it belongs to, whatever order the provider answers in', async () => {
  // Both leads already hold the address the provider will confirm, because the
  // workspace's unique (user_id, email) index allows only one blank address at a
  // time. What the swap changes is therefore visible in the per-lead status: a
  // row applied to the wrong lead disagrees with that lead's stored address and
  // is refused as `differs_from_existing`, so a positional match scores zero.
  const ada = seedLead(db, owner.id, 'ada.byron@acme.com', { first_name: 'Ada', last_name: 'Byron' })
  const grace = seedLead(db, owner.id, 'grace.hopper@navy.test', { first_name: 'Grace', last_name: 'Hopper' })
  db.prepare("UPDATE leads SET website = 'https://www.acme.com/pricing' WHERE id = ?").run(ada.id)
  db.prepare("UPDATE leads SET website = 'navy.test' WHERE id = ?").run(grace.id)

  const stub = recorder(() => ({
    success: true,
    // Reversed, and with a row for somebody nobody asked about. Position-based
    // matching would put Grace's answer on Ada.
    data: [
      { firstName: 'Grace', lastName: 'Hopper', companyDomain: 'navy.test', email_id: 'grace.hopper@navy.test', status: 'Found', verification_status: 'Valid' },
      { firstName: 'Ada', lastName: 'Byron', companyDomain: 'acme.com', email_id: 'ada.byron@acme.com', status: 'Found', verification_status: 'Catch All' },
      { firstName: 'Nobody', lastName: 'Asked', companyDomain: 'nowhere.test', email_id: 'x@nowhere.test', status: 'Found', verification_status: 'Valid' },
    ],
  }))

  const res = await withUpstream(stub, () =>
    client.post('/api/leads/find-emails', { leadIds: [ada.id, grace.id] }))
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'done')
  assert.equal(res.body.found, 2)

  const adaAfter = db.prepare('SELECT * FROM leads WHERE id = ?').get(ada.id)
  const graceAfter = db.prepare('SELECT * FROM leads WHERE id = ?').get(grace.id)
  assert.equal(adaAfter.email, 'ada.byron@acme.com')
  assert.equal(adaAfter.email_verification_status, 'Catch All', 'Ada carries Ada’s status, not the first row’s')
  assert.equal(graceAfter.email, 'grace.hopper@navy.test')
  assert.equal(graceAfter.email_verification_status, 'Valid')
  assert.equal(adaAfter.email_source, 'find_emails')

  // The stranger's row matched nobody and wrote nothing.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND email = ?')
    .get(owner.id, 'x@nowhere.test').n, 0)
  assert.ok(res.body.results.some((r) => r.reason === 'unmatched_row'), 'and it is reported rather than dropped')

  // The outgoing batch carries exactly the three documented fields per contact.
  const sent = stub.calls[0].body
  assert.equal(sent.contacts.length, 2)
  for (const c of sent.contacts) {
    assert.deepEqual(Object.keys(c).sort(), ['companyDomain', 'firstName', 'lastName'])
  }
  assert.equal(sent.contacts.find((c) => c.firstName === 'Ada').companyDomain, 'acme.com',
    'the registrable domain, normalised from the lead’s website')

  const job = db.prepare('SELECT * FROM email_find_jobs WHERE id = ?').get(res.body.jobId)
  assert.equal(job.status, 'done')
  assert.equal(job.found, 2)
})

test('a lead with no address at all is the one that gets filled in', async () => {
  const lead = seedLead(db, owner.id, 'blank-lookup@placeholder.test', { first_name: 'Alan', last_name: 'Turing' })
  db.prepare("UPDATE leads SET website = 'bletchley.test', email = '' WHERE id = ?").run(lead.id)

  const stub = recorder(() => ({
    success: true,
    data: [{
      firstName: 'Alan', lastName: 'Turing', companyDomain: 'bletchley.test',
      email_id: 'alan@bletchley.test', status: 'Found', verification_status: 'Valid',
    }],
  }))
  const res = await withUpstream(stub, () => client.post('/api/leads/find-emails', { leadIds: [lead.id] }))
  assert.equal(res.body.found, 1)

  const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  assert.equal(after.email, 'alan@bletchley.test')
  assert.equal(after.email_verification_status, 'Valid')
  assert.equal(after.email_source, 'find_emails')
})

test('identityKey normalises the three documented fields', () => {
  assert.equal(identityKey({ firstName: ' Ada ', lastName: 'BYRON', companyDomain: 'https://WWW.Acme.com/x' }),
    identityKey({ firstName: 'ada', lastName: 'byron', companyDomain: 'acme.com' }))
  assert.notEqual(identityKey({ firstName: 'Ada', lastName: 'Byron', companyDomain: 'acme.com' }),
    identityKey({ firstName: 'Ada', lastName: 'Byron', companyDomain: 'other.com' }))
})

test('running out of credit stops the job and keeps what the earlier batches wrote', async () => {
  const ids = []
  for (let i = 0; i < 15; i++) {
    const lead = seedLead(db, owner.id, `bat-ch${i}@batch.test`, { first_name: 'Bat', last_name: `Ch${i}` })
    db.prepare("UPDATE leads SET website = 'batch.test' WHERE id = ?").run(lead.id)
    ids.push(lead.id)
  }

  let batch = 0
  const stub = {
    configured: () => true,
    call: async (path, opts) => {
      batch++
      if (batch > 1) {
        const err = new Error('payment required')
        err.status = 402
        throw err
      }
      return {
        success: true,
        data: opts.body.contacts.map((c) => ({
          ...c,
          email_id: `${c.firstName}-${c.lastName}@batch.test`.toLowerCase(),
          status: 'Found',
          verification_status: 'Valid',
        })),
      }
    },
  }

  const res = await withUpstream(stub, () => client.post('/api/leads/find-emails', { leadIds: ids }))
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'failed')
  assert.match(res.body.error, /credits/i)
  assert.equal(res.body.found, 10, 'the first batch of ten is kept')
  assert.equal(batch, 2, 'and the job stops rather than working through the rest')

  const written = db.prepare(
    "SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND email_source = 'find_emails' AND email LIKE 'bat-ch%@batch.test'"
  ).get(owner.id).n
  assert.equal(written, 10, 'the first batch’s ten leads really carry the lookup’s result')
  const untouched = db.prepare(
    "SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND email_source = '' AND email LIKE 'bat-ch%@batch.test'"
  ).get(owner.id).n
  assert.equal(untouched, 5, 'and the five the job never reached are unchanged')

  const job = db.prepare('SELECT * FROM email_find_jobs WHERE id = ?').get(res.body.jobId)
  assert.equal(job.status, 'failed')
  assert.equal(job.found, 10, 'the job row says where it stopped')
})

// ================================================== marking against the leads

test('company marking is per workspace even though the vocabulary cache is shared', async () => {
  seedLead(db, owner.id, 'buyer@globex.test', { company: 'Globex' })
  const stub = recorder(() => ({ success: true, data: [{ company_name: 'Globex' }, { company_name: 'Initech' }] }))

  const mine = await withUpstream(stub, () => client.get('/api/prospects/filters/companies?search=glo&limit=100'))
  assert.equal(mine.status, 200)
  assert.deepEqual(mine.body.items, [
    { name: 'Globex', alreadyInLeads: true },
    { name: 'Initech', alreadyInLeads: false },
  ])

  const theirs = await mount(register, stranger)
  try {
    const res = await withUpstream(stub, () => theirs.get('/api/prospects/filters/companies?search=glo&limit=100'))
    assert.equal(res.status, 200)
    assert.equal(res.body.cached, true, 'the reference data is shared')
    assert.deepEqual(res.body.items.map((i) => i.alreadyInLeads), [false, false],
      'but another workspace’s leads are not')
    assert.equal(stub.calls.length, 1)
  } finally {
    await theirs.close()
  }
})

test('a filter value never reaches the outgoing body through an unmapped key', () => {
  const body = translateSearch({
    title: ['Director'],
    api_key: 'leaked',
    scroll_id: 'not-yours',
    search_string: 'nor-this',
  }, { limit: 5 })
  assert.deepEqual(Object.keys(body).sort(), ['limit', 'title'])
})
