// smart-prospect, third pass — the fifteen lookup, listing and analytics specs.
//
// Docs/smart-prospect/{cities,company,countries,departments,domain,get-contacts,
// head-counts,industries,job-title,keywords,levels,recent-searches,
// reply-analytics,search-analytics,sub-industries}.md
//
// The two sibling files prove the ceilings, the mapping table and the fetch
// branch. This one is aimed at the failure this module keeps producing: a
// confident answer assembled out of nothing. "No cities match that", "you have
// seen every company", "the provider has never heard of these domains", "this
// search found nobody", "your integration is connected" — every one of those is
// a finding a user acts on, and every one of them was being produced by a code
// path that had never spoken to the provider.
//
// So: no test here passes on an envelope alone. Each asserts a stored row, the
// URL and body that left for the provider, or an explicit null where the answer
// is genuinely unknown.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, mount } from './helpers/parity-harness.js'

setup('smart-prospect-audit2')

const { db } = await import('../server/db.js')
const { register, upstream, translateSearch, inconsistentTrend } =
  await import('../server/parity/prospects.js')

const owner = seedUser(db, 'owner@example.com')
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

// Records every outgoing path and body so a test can assert what was SENT.
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
    of: (fragment) => calls.filter((c) => c.path.includes(fragment)),
  }
}

// The vocabulary cache is keyed (kind, query) with no workspace column, so
// every test uses its own `search` token and cannot be warmed by a neighbour.
let tokenSeq = 0
const token = () => `t${++tokenSeq}x`

// The analytics and reply caches are keyed by workspace, so the tests that care
// what an empty cache does get a workspace of their own.
async function freshWorkspace(label) {
  const user = seedUser(db, `${label}@example.com`)
  const api = await mount(register, user)
  test.after(() => api.close())
  return { user, api }
}

// ============================================================ honest unknowns
// The category's signature failure, hunted through the five shapes it takes in
// these fifteen specs.

test('an unsearched filter list has an unknown count, never a count of zero', async () => {
  // cities / countries / departments / head-counts / industries / levels /
  // sub-industries all document a `pagination` object whose `count` is the
  // provider's answer. Zero there is a finding — the specs say it renders as
  // "No cities match that" — so it cannot be what "we never asked" looks like.
  for (const kind of ['cities', 'countries', 'departments', 'head-counts', 'industries', 'levels', 'sub-industries']) {
    const res = await client.get(`/api/prospects/filters/${kind}?search=${token()}&limit=10`)
    assert.equal(res.status, 200, `${kind} must not error`)
    assert.equal(res.body.configured, false)
    assert.deepEqual(res.body.items, [], `${kind} invents no rows`)
    assert.equal(res.body.pagination.count, null,
      `${kind} must not report a count of zero for a list it never fetched`)
    // The echoes of the request are still true and the UI still has them.
    assert.equal(res.body.pagination.limit, 10)
    assert.equal(res.body.pagination.offset, 0)
    assert.equal(res.body.pagination.page, 1)
  }

  // And with a provider, zero really does mean zero.
  const empty = recorder(() => ({ success: true, data: [], pagination: null }))
  const none = await withUpstream(empty, () =>
    client.get(`/api/prospects/filters/cities?search=${token()}&limit=10`))
  assert.equal(none.body.configured, true)
  assert.equal(none.body.pagination.count, 0, 'a real empty page is a real zero')
})

test('an unsearched flat lookup does not claim you have seen the whole list', async () => {
  // company / domain / job-title / keywords document no pagination object at
  // all, so `hasMore` is the only end-of-list signal — and `false` means "stop,
  // that is everything". Saying that about a list nobody fetched hides the
  // provider's entire catalogue behind an empty dropdown.
  for (const kind of ['companies', 'domains', 'job-titles', 'keywords']) {
    const res = await client.get(`/api/prospects/filters/${kind}?search=${token()}&limit=10`)
    assert.equal(res.status, 200)
    assert.equal(res.body.configured, false)
    assert.deepEqual(res.body.items, [])
    assert.equal(res.body.hasMore, null, `${kind} cannot know whether there is more`)
  }

  // Full page → more to come. Short page → that is the end. Both are derived
  // from the page being full, because no count is documented.
  const full = recorder(() => ({ success: true, data: [{ job_title: 'A' }, { job_title: 'B' }] }))
  const t1 = token()
  const more = await withUpstream(full, () => client.get(`/api/prospects/filters/job-titles?search=${t1}&limit=2`))
  assert.equal(more.body.hasMore, true, 'exactly `limit` rows means there may be another page')

  const short = recorder(() => ({ success: true, data: [{ job_title: 'A' }] }))
  const t2 = token()
  const done = await withUpstream(short, () => client.get(`/api/prospects/filters/job-titles?search=${t2}&limit=2`))
  assert.equal(done.body.hasMore, false, 'a short page is the documented end of the list')
})

test('an hour-old reply figure stops claiming the provider is connected', async () => {
  const { api } = await freshWorkspace('replycache')
  const stub = recorder(() => ({
    success: true,
    data: {
      currentMonth: { replied: 12 }, previousMonth: { replied: 9 },
      percentage_change: '+33.33%', trend: 'increase',
    },
  }))

  const live = await withUpstream(stub, () => api.get('/api/prospects/reply-analytics'))
  assert.equal(live.status, 200)
  assert.equal(live.body.configured, true)
  assert.equal(live.body.cached, false)
  assert.equal(stub.calls.length, 1)

  // The credentials are gone; the cached figure is still the provider's figure
  // and worth showing, but the connection it came through no longer exists.
  const offline = await api.get('/api/prospects/reply-analytics')
  assert.equal(offline.status, 200)
  assert.equal(offline.body.cached, true)
  assert.equal(offline.body.configured, false, 'a cache hit is not a connection')
  assert.match(offline.body.message, /PROSPECT_API_URL and PROSPECT_API_KEY/)
  assert.equal(offline.body.percentageChange, '+33.33%', 'and the real figure is still served')
  assert.equal(stub.calls.length, 1, 'with no second call attempted')
})

test('a cached credit balance stops claiming the provider is connected', async () => {
  const { api } = await freshWorkspace('analyticscache')
  const stub = recorder(() => ({
    success: true,
    data: {
      availableCredits: { available: 400, total: 1000, used: 600 },
      leadsFoundToday: 50, maxDailyFetchLimit: 1000, maxSingleFetchLimit: 500,
    },
  }))

  const live = await withUpstream(stub, () => api.get('/api/prospects/analytics'))
  assert.equal(live.body.configured, true)
  assert.equal(live.body.maxSingleFetchLimit, 500)

  const offline = await api.get('/api/prospects/analytics')
  assert.equal(offline.body.cached, true)
  assert.equal(offline.body.configured, false, 'a cached figure does not prove a live integration')
  assert.match(offline.body.message, /PROSPECT_API_URL and PROSPECT_API_KEY/)
  assert.equal(offline.body.credits.available, 400, 'the figure itself is still real')
})

test('an ICP title reconciliation nobody performed is not recorded as one that found nothing', async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'prospect_titles_reconciled'")
    .get(owner.id).n

  const blind = await client.post('/api/prospects/filters/job-titles/reconcile', {
    titles: ['Head of Operations', 'Chief Sasquatch Officer'],
  })
  assert.equal(blind.status, 200)
  assert.equal(blind.body.configured, false)
  assert.equal(blind.body.checkedAgainstProvider, false)
  assert.deepEqual(blind.body.unchecked, ['Head of Operations', 'Chief Sasquatch Officer'],
    'a title is not "unknown to the provider" when no provider was asked')

  // The events row is the audit trail a user reads to see why their search
  // targeted the titles it did. "0 matched, 2 unmatched" there is a finding
  // nobody produced.
  const row = db.prepare(
    "SELECT detail FROM events WHERE user_id = ? AND type = 'prospect_titles_reconciled' ORDER BY id DESC LIMIT 1"
  ).get(owner.id)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'prospect_titles_reconciled'")
    .get(owner.id).n, before + 1, 'exactly one row for the attempt')
  assert.match(row.detail, /no prospect provider is connected/)
  assert.ok(!/0 matched/.test(row.detail), 'and it does not read as a reconciliation that matched nothing')

  // With a provider, the same route makes the real claim and records the counts.
  const stub = recorder((path) => {
    const search = new URL(path, 'http://p.test').searchParams.get('search') || ''
    return search.toLowerCase() === 'head of operations'
      ? { success: true, data: [{ job_title: 'Head of Operations' }] }
      : { success: true, data: [] }
  })
  const live = await withUpstream(stub, () => client.post('/api/prospects/filters/job-titles/reconcile', {
    titles: ['Head of Operations', 'Chief Sasquatch Officer'],
  }))
  assert.deepEqual(live.body.matched, ['Head of Operations'])
  assert.deepEqual(live.body.unmatched, ['Chief Sasquatch Officer'], 'reported, never dropped')
  assert.deepEqual(live.body.unchecked, [])
  assert.equal(live.body.checkedAgainstProvider, true)

  const audited = db.prepare(
    "SELECT detail FROM events WHERE user_id = ? AND type = 'prospect_titles_reconciled' ORDER BY id DESC LIMIT 1"
  ).get(owner.id)
  assert.match(audited.detail, /1 matched, 1 unmatched/)
})

test('an ICP signal reconciliation nobody performed is not recorded as one that found nothing', async () => {
  const blind = await client.post('/api/prospects/filters/keywords/reconcile', { signals: ['jira', 'saas'] })
  assert.equal(blind.body.checkedAgainstProvider, false)
  assert.deepEqual(blind.body.unchecked, ['jira', 'saas'])

  const row = db.prepare(
    "SELECT detail FROM events WHERE user_id = ? AND type = 'prospect_keywords_reconciled' ORDER BY id DESC LIMIT 1"
  ).get(owner.id)
  assert.match(row.detail, /no prospect provider is connected/)

  const stub = recorder((path) => {
    const search = new URL(path, 'http://p.test').searchParams.get('search') || ''
    return search === 'saas' ? { success: true, data: [{ keyword: 'saas' }] } : { success: true, data: [] }
  })
  const live = await withUpstream(stub, () =>
    client.post('/api/prospects/filters/keywords/reconcile', { signals: ['Jira', 'saas'] }))
  assert.deepEqual(live.body.matched, ['saas'])
  assert.deepEqual(live.body.unmatched, ['Jira'], 'the signal is listed with its exact text, not dropped')
  assert.deepEqual(live.body.unchecked, [])
  assert.match(db.prepare(
    "SELECT detail FROM events WHERE user_id = ? AND type = 'prospect_keywords_reconciled' ORDER BY id DESC LIMIT 1"
  ).get(owner.id).detail, /1 matched, 1 unmatched/)
})

test('a pasted account list is not declared unknown to a provider that was never asked', async () => {
  seedLead(db, owner.id, 'buyer@known.test')
  const blind = await client.post('/api/prospects/filters/domains/reconcile', {
    domains: ['https://www.Acme.com/pricing', 'acme.com', 'HOOLI.com'],
  })
  assert.equal(blind.status, 200)
  assert.deepEqual(blind.body.normalised, ['acme.com', 'hooli.com'], 'normalised and deduplicated first')
  assert.equal(blind.body.checkedAgainstProvider, false)
  assert.deepEqual(blind.body.unchecked, ['acme.com', 'hooli.com'],
    '"the provider does not cover this account" is a claim, and nothing was asked')

  const stub = recorder((path) => {
    const search = new URL(path, 'http://p.test').searchParams.get('search') || ''
    return search === 'acme.com'
      ? { success: true, data: [{ domain_name: 'ACME.com' }] }
      : { success: true, data: [] }
  })
  const live = await withUpstream(stub, () => client.post('/api/prospects/filters/domains/reconcile', {
    domains: ['https://www.Acme.com/', 'hooli.com', 'known.test'],
  }))
  assert.deepEqual(live.body.matched, ['acme.com'])
  assert.deepEqual(live.body.unknown, ['hooli.com'], 'now it really is unknown to the provider')
  assert.deepEqual(live.body.unchecked, [])
  assert.equal(live.body.checkedAgainstProvider, true)
  assert.deepEqual(live.body.existing, ['known.test'], 'a domain already on a lead is never re-fetched')
})

test('a search that was never run carries no lead count into the recent list', async () => {
  const preview = await client.post('/api/prospects/search', {
    limit: 25,
    filters: { title: ['CFO'], favouriteColour: 'blue' },
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.totalCount, null)

  const row = db.prepare('SELECT * FROM prospect_searches WHERE id = ?').get(preview.body.searchId)
  assert.equal(row.total_count, 0, 'the column holds its default')

  const recent = await client.get('/api/prospects/searches/recent?limit=20')
  assert.equal(recent.status, 200)
  const mine = recent.body.items.find((i) => i.id === preview.body.searchId)
  assert.ok(mine, 'a preview is what the Recent list is made of')
  // The recent-searches payload documents no fetch_details and no count. A
  // zero here reads as "this search found nobody" for a search that was never
  // executed — the exact confusion the spec's TC-8 exists to prevent.
  assert.equal(mine.totalCount, null, 'no count is displayed for a search that never ran')
  // An unrenderable filter key survives to the client rather than being dropped,
  // so a reopened search is never quietly narrower than the original.
  assert.equal(mine.filters.favouriteColour, 'blue')
  assert.deepEqual(preview.body.ignoredFilters, ['favouriteColour'])

  // And a search that HAS run reports the provider's real figure.
  const stub = recorder(() => ({
    success: true,
    data: { list: [], total_count: 4821, filter_id: 660011 },
  }))
  const ran = await withUpstream(stub, () => client.post('/api/prospects/search', {
    limit: 25, filters: { title: ['CFO'], countries: ['Australia'] },
  }))
  const after = await client.get('/api/prospects/searches/recent?limit=20')
  const real = after.body.items.find((i) => i.id === ran.body.searchId)
  assert.equal(real.totalCount, 4821, 'a figure the provider actually returned is a number')
})

// ======================================================== per-search analytics

test('per-search analytics ask the provider by ITS filter id, never Harry’s row id', async () => {
  const saved = await client.post('/api/prospects/searches', { name: 'Analytics target', filters: { title: ['VP'] } })
  const harryId = saved.body.id
  db.prepare('UPDATE prospect_searches SET provider_filter_id = ? WHERE id = ?').run('327105', harryId)
  assert.notEqual(String(harryId), '327105', 'the two id spaces are genuinely different in this test')

  const stub = recorder(() => ({
    success: true,
    data: {
      availableCredits: { available: 10, total: 20, used: 10 },
      maxSingleFetchLimit: 500, maxDailyFetchLimit: 1000, leadsFoundToday: 0,
      filterData: { leadsFound: 88, emailsFetched: 42 },
    },
  }))
  const res = await withUpstream(stub, () => client.get(`/api/prospects/analytics?filterId=${harryId}`))
  assert.equal(res.status, 200)

  const sent = stub.calls[0].path
  assert.equal(stub.query(sent, 'filter_id'), '327105',
    'the provider’s own id — Harry’s row id addresses a stranger’s filter or none')
  assert.notEqual(stub.query(sent, 'filter_id'), String(harryId), 'and never Harry’s row id')
  assert.equal(res.body.filterData.leadsFound, 88)
  assert.equal(res.body.filterDataAvailable, true)
  assert.ok(!JSON.stringify(res.body).includes('327105'), 'and it does not come back out')
})

test('a search with no provider id gets no per-search figures rather than the account’s', async () => {
  const saved = await client.post('/api/prospects/searches', { name: 'Never linked', filters: { title: ['CTO'] } })
  assert.equal(db.prepare('SELECT provider_filter_id FROM prospect_searches WHERE id = ?')
    .get(saved.body.id).provider_filter_id, '')

  const stub = recorder(() => ({
    success: true,
    data: {
      availableCredits: { available: 10, total: 20, used: 10 },
      // The account-wide payload still carries a filterData block. Attributing
      // it to a search the provider was never asked about would put somebody
      // else's numbers under this search's name.
      filterData: { leadsFound: 999, emailsFetched: 999 },
    },
  }))
  const res = await withUpstream(stub, () => client.get(`/api/prospects/analytics?filterId=${saved.body.id}`))
  assert.equal(res.status, 200)
  assert.equal(stub.query(stub.calls[0].path, 'filter_id'), null, 'no filter_id is guessed at')
  assert.equal(res.body.filterData, null)
  assert.equal(res.body.filterDataAvailable, false)
  assert.equal(res.body.filterDataUnavailableBecause, 'search_not_linked_to_provider',
    'and the client is told which of the two it is holding')
})

test('a fetch invalidates the per-search credit figures, not only the account’s', async () => {
  const { user, api } = await freshWorkspace('invalidation')
  const saved = await api.post('/api/prospects/searches', { name: 'Spend me', filters: {} })
  db.prepare('UPDATE prospect_searches SET provider_filter_id = ? WHERE id = ?').run('4242', saved.body.id)

  let available = 100
  const stub = recorder((path) => {
    if (path.includes('search-analytics')) {
      return {
        success: true,
        data: {
          availableCredits: { available, total: 200, used: 200 - available },
          maxSingleFetchLimit: 500, maxDailyFetchLimit: 1000, leadsFoundToday: 0,
          filterData: { leadsFound: 5, emailsFetched: 5 },
        },
      }
    }
    return { success: true, data: { list: [], metrics: { totalEmails: 3 } } }
  })

  await withUpstream(stub, async () => {
    const warm = await api.get(`/api/prospects/analytics?filterId=${saved.body.id}`)
    assert.equal(warm.body.credits.available, 100)

    const spend = await api.post(`/api/prospects/searches/${saved.body.id}/fetch`, { mode: 'count', count: 3 })
    assert.equal(spend.status, 200)
    assert.equal(db.prepare('SELECT status FROM prospect_fetches WHERE id = ?').get(spend.body.fetchId).status, 'done')

    available = 97
    const after = await api.get(`/api/prospects/analytics?filterId=${saved.body.id}`)
    assert.equal(after.body.cached, false, 'a fetch changes the balance, so the per-search figure is refetched too')
    assert.equal(after.body.credits.available, 97, 'and the balance shown is the one after the spend')
  })

  // The snapshot Monitoring reads is Harry's own row, written from the payload.
  const credits = db.prepare('SELECT * FROM prospect_credits WHERE workspace_id = ?').get(user.id)
  assert.equal(credits.email_credits, 97)
  assert.equal(credits.lead_credits, 200)
})

test('the single-fetch and daily caps are enforced server-side, with the number in the message', async () => {
  const { api } = await freshWorkspace('caps')
  const saved = await api.post('/api/prospects/searches', { name: 'Capped', filters: {} })
  db.prepare('UPDATE prospect_searches SET provider_filter_id = ? WHERE id = ?').run('5150', saved.body.id)

  const stub = recorder((path) => {
    if (path.includes('search-analytics')) {
      return {
        success: true,
        data: {
          availableCredits: { available: 9000, total: 9000, used: 0 },
          maxSingleFetchLimit: 500, maxDailyFetchLimit: 1000, leadsFoundToday: 950,
        },
      }
    }
    throw new Error(`the fetch must never leave: ${path}`)
  })

  await withUpstream(stub, async () => {
    await api.get('/api/prospects/analytics')   // the caps arrive and are cached

    const overSingle = await api.post(`/api/prospects/searches/${saved.body.id}/fetch`, { mode: 'count', count: 600 })
    assert.equal(overSingle.status, 422)
    assert.equal(overSingle.body.field, 'count')
    assert.match(overSingle.body.message, /500/, 'the cap is named, not just "invalid"')

    // 1000 allowed today less 950 already found leaves 50.
    const overDaily = await api.post(`/api/prospects/searches/${saved.body.id}/fetch`, { mode: 'count', count: 400 })
    assert.equal(overDaily.status, 422)
    assert.match(overDaily.body.message, /50/)

    assert.equal(stub.of('fetch-contacts').length, 0, 'nothing was sent, so nothing was charged')
  })

  // A refused fetch is refused before the row is written, so the history does
  // not fill up with receipts for fetches that never happened.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prospect_fetches WHERE search_id = ?').get(saved.body.id).n, 0)
})

test('search analytics pass the provider’s preformatted change text through untouched', async () => {
  const { api } = await freshWorkspace('passthrough')
  const stub = recorder(() => ({
    success: true,
    data: {
      leadsFound: { current: 220, previousMonth: 190, percentageChange: 15.789473, percentageChangeText: '+15.79%', trend: 'increase', total: 4100 },
      emailsFetched: { current: 90, previousMonth: 120, percentageChange: -25, percentageChangeText: '-25%', trend: 'decrease', total: 900 },
      availableCredits: { available: 500, total: 1000, used: 500 },
      leadsFoundToday: 12, maxDailyFetchLimit: 1000, maxSingleFetchLimit: 500,
    },
  }))
  const res = await withUpstream(stub, () => api.get('/api/prospects/analytics'))
  assert.equal(res.status, 200)
  assert.equal(res.body.leadsFound.percentageChangeText, '+15.79%',
    'the text is displayed; Harry never formats the number itself')
  assert.equal(res.body.leadsFound.percentageChange, 15.789473, 'and the raw number is untouched too')
  assert.equal(res.body.emailsFetched.percentageChangeText, '-25%')
  // All three credit figures survive: "500 of 1000 used" is a different message
  // from "500 left".
  assert.deepEqual(res.body.credits, { available: 500, total: 1000, used: 500 })
  assert.equal(res.body.maxSingleFetchLimit, 500)
  assert.equal(res.body.maxDailyFetchLimit, 1000)
  assert.equal(res.body.foundToday, 12)
})

// ========================================================== reply analytics

test('reply analytics send no parameter the endpoint does not document', async () => {
  const { api } = await freshWorkspace('replyparams')
  const stub = recorder(() => ({
    success: true,
    data: { currentMonth: { replied: 5 }, previousMonth: { replied: 4 }, percentage_change: '+25%', trend: 'increase' },
  }))
  const res = await withUpstream(stub, () => api.get('/api/prospects/reply-analytics?month=2025-01&campaignId=7'))
  assert.equal(res.status, 200)
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].path, '/api/v1/search-email-leads/reply-analytics',
    'the endpoint documents no parameters, so none is assembled')
  assert.equal(stub.calls[0].method, 'GET')
  assert.equal(stub.calls[0].body, null)
  assert.equal(res.body.percentageChange, '+25%')
})

test('a contradictory reply payload is shown as received and flagged for Monitoring', async () => {
  const { api } = await freshWorkspace('replymismatch')
  const stub = recorder(() => ({
    success: true,
    // Fewer replies than last month, but the provider says "increase".
    data: { currentMonth: { replied: 3 }, previousMonth: { replied: 40 }, percentage_change: '-92.5%', trend: 'increase' },
  }))
  const res = await withUpstream(stub, () => api.get('/api/prospects/reply-analytics'))
  assert.equal(res.status, 200)
  assert.equal(res.body.trend, 'increase', 'Harry does not silently correct the provider')
  assert.equal(res.body.currentMonth.replied, 3)
  assert.equal(res.body.percentageChange, '-92.5%', 'and does not recompute the change either')
  assert.equal(res.body.trendConsistent, false)

  const flagged = db.prepare(
    "SELECT detail FROM telemetry WHERE op = 'prospects.reply_analytics' ORDER BY id DESC LIMIT 1"
  ).get()
  assert.match(flagged.detail, /disagrees/, 'Monitoring is told the provider’s numbers disagree with each other')

  // An unrecognised trend word is never judged — mapping it to a direction is
  // exactly the guess the spec forbids.
  assert.equal(inconsistentTrend({ trend: 'flat', current: 3, previousMonth: 40 }), false)
  assert.equal(inconsistentTrend({ trend: 'decrease', current: 3, previousMonth: 40 }), false)
  assert.equal(inconsistentTrend({ trend: 'decrease', current: 40, previousMonth: 3 }), true)
})

test('a failing reply lookup reports itself unavailable instead of throwing into Reports', async () => {
  const { api } = await freshWorkspace('replyfail')
  const stub = {
    configured: () => true,
    call: async () => { const e = new Error('boom'); e.status = 500; throw e },
  }
  const res = await withUpstream(stub, () => api.get('/api/prospects/reply-analytics'))
  assert.equal(res.status, 200, 'a provider outage is not a Harry error page')
  assert.equal(res.body.available, false)
  assert.equal(res.body.currentMonth, null, 'and no figure is invented to fill the card')
  assert.match(res.body.message, /unavailable/i)

  // Nothing from this endpoint is written into Harry's own reporting tables:
  // mixing a provider's undocumented count with a rate derived from real Gmail
  // threads would corrupt a number the product guarantees.
  const stub2 = recorder(() => ({
    success: true,
    data: { currentMonth: { replied: 77 }, previousMonth: { replied: 1 }, percentage_change: '+7600%', trend: 'increase' },
  }))
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
  await withUpstream(stub2, () => api.get('/api/prospects/reply-analytics'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before,
    'the provider’s reply figure never becomes a message row')
})

// ================================================================== lookups

test('the city lookup carries state and country verbatim and enforces the documented dependency', async () => {
  const country = await client.get('/api/prospects/filters/cities?country=usa')
  assert.equal(country.status, 422)
  assert.equal(country.body.field, 'state')
  assert.match(country.body.message, /state/)

  const long = await client.get(`/api/prospects/filters/cities?search=${'x'.repeat(256)}`)
  assert.equal(long.status, 422)
  assert.equal(long.body.field, 'search')

  const t = token()
  const stub = recorder(() => ({ success: true, data: [{ id: 1, city_name: 'Austin' }] }))
  const res = await withUpstream(stub, () =>
    client.get(`/api/prospects/filters/cities?search=${t}&state=california,texas&country=usa&limit=100`))
  assert.equal(res.status, 200)
  const sent = stub.calls[0].path
  assert.equal(stub.query(sent, 'state'), 'california,texas', 'one parameter, comma-separated, as documented')
  assert.equal(stub.query(sent, 'country'), 'usa')
  assert.equal(stub.query(sent, 'search'), t)
  assert.deepEqual(res.body.items, [{ id: 1, name: 'Austin' }], 'city_name is renamed once, on the server')
})

test('country prefix filtering is served from the cached page and matches starts-with', async () => {
  db.prepare("DELETE FROM prospect_filter_cache WHERE kind = 'countries'").run()
  const stub = recorder(() => ({
    success: true,
    data: [
      { id: 1, country_name: 'United States' },
      { id: 2, country_name: 'United Kingdom' },
      { id: 3, country_name: 'Australia' },
    ],
  }))

  await withUpstream(stub, async () => {
    const cold = await client.get('/api/prospects/filters/countries?limit=100')
    assert.equal(cold.body.items.length, 3, 'the first load asks for the whole list, not the provider’s default ten')
    assert.equal(stub.query(stub.calls[0].path, 'limit'), '100')

    const prefix = await client.get('/api/prospects/filters/countries?search=united&limit=100')
    assert.deepEqual(prefix.body.items.map((i) => i.name), ['United States', 'United Kingdom'])
    assert.equal(prefix.body.cached, true)

    const infix = await client.get('/api/prospects/filters/countries?search=kingdom&limit=100')
    assert.deepEqual(infix.body.items, [],
      'matching is documented as starts-with, so the UI must not promise "contains"')
    assert.equal(infix.body.pagination.count, 0, 'and a real cached list gives a real zero')

    assert.equal(stub.calls.length, 1, 'both filters were served from the one cached page')
  })
})

test('the seniority ladder is assembled across the provider’s pages, not handed to the client to page', async () => {
  const t = token()
  const ladder = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, level_name: `Level ${i + 1}` }))
  const stub = recorder((path) => {
    const offset = Number(new URL(path, 'http://p.test').searchParams.get('offset') || 0)
    const limit = Number(new URL(path, 'http://p.test').searchParams.get('limit') || 10)
    return { success: true, data: ladder.slice(offset, offset + limit) }
  })

  const res = await withUpstream(stub, () => client.get(`/api/prospects/filters/levels?search=${t}&limit=10`))
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 25, 'the whole ladder arrives in one response')
  assert.equal(res.body.pagesFetched, 3, '10, 10, then a short page of 5 ends the walk')
  assert.equal(stub.calls.length, 3)
  assert.deepEqual(res.body.items[0], { id: 1, name: 'Level 1' })
  assert.deepEqual(res.body.items.at(-1), { id: 25, name: 'Level 25' })
  assert.equal(res.body.pagination.count, 25, 'the count describes what was returned, not the last page')

  // Reopening the group costs nothing: every page is in Harry's own cache.
  const again = await withUpstream(stub, () => client.get(`/api/prospects/filters/levels?search=${t}&limit=10`))
  assert.equal(again.body.items.length, 25)
  assert.equal(again.body.cached, true)
  assert.equal(stub.calls.length, 3, 'and no further provider call is made')
})

test('a relabelled band or level changes the label and nothing else, because ids are what travel', async () => {
  // head-counts and levels both promise the same thing: the search carries the
  // provider's id, so a relabel is cosmetic.
  const first = translateSearch({ headCountIds: [3, 4], levelIds: [7], departmentIds: [11], industryIds: [2] }, { limit: 10 })
  assert.deepEqual(first.companyHeadCount, ['3', '4'])
  assert.deepEqual(first.level, ['7'])
  assert.deepEqual(first.department, ['11'])
  assert.deepEqual(first.companyIndustry, ['2'])

  const t = token()
  const labels = { 3: '11-50', 4: '51-200' }
  const stub = recorder(() => ({
    success: true,
    data: Object.entries(labels).map(([id, head_count]) => ({ id: Number(id), head_count })),
  }))
  const before = await withUpstream(stub, () => client.get(`/api/prospects/filters/head-counts?search=${t}&limit=100`))
  assert.deepEqual(before.body.items, [{ id: 3, label: '11-50' }, { id: 4, label: '51-200' }],
    'bands render verbatim as the provider’s strings — no numeric parsing, no invented slider')

  // The label moves; the search body does not.
  labels[3] = '11 to 50 people'
  db.prepare("DELETE FROM prospect_filter_cache WHERE kind = 'head-counts'").run()
  const t2 = token()
  const after = await withUpstream(stub, () => client.get(`/api/prospects/filters/head-counts?search=${t2}&limit=100`))
  assert.equal(after.body.items[0].label, '11 to 50 people')
  assert.deepEqual(
    translateSearch({ headCountIds: [3, 4] }, { limit: 10 }).companyHeadCount,
    first.companyHeadCount,
    'the outgoing search is unchanged by a relabel')
})

test('the industry tree keeps the two sub-industry shapes apart', async () => {
  const t = token()
  const stub = recorder((path) => {
    const offset = Number(new URL(path, 'http://p.test').searchParams.get('offset') || 0)
    const pages = [
      [
        {
          id: 1,
          industry_name: 'Technology',
          // An id here would be a trap: the NESTED list documents only a name,
          // and code that reads one would silently key on undefined.
          sub_industry_list: [
            { id: 99, sub_industry_name: 'Software' },
            { id: 98, sub_industry_name: 'Hardware' },
          ],
        },
        { id: 2, industry_name: 'Healthcare', sub_industry_list: [] },
      ],
      [{ id: 3, industry_name: 'Education', sub_industry_list: [] }],
    ]
    return { success: true, data: pages[offset / 2] || [] }
  })

  const res = await withUpstream(stub, () =>
    client.get(`/api/prospects/filters/industries?search=${t}&limit=2`))
  assert.equal(res.status, 200)
  assert.equal(stub.query(stub.calls[0].path, 'withSubIndustry'), 'true',
    'the documented values are the STRINGS true and false')
  assert.equal(res.body.items.length, 3, 'two provider pages become one taxonomy')
  assert.equal(res.body.pagesFetched, 2)

  const tech = res.body.items.find((i) => i.name === 'Technology')
  assert.deepEqual(tech.subIndustries, [{ name: 'Software' }, { name: 'Hardware' }],
    'nested sub-industries carry a name and nothing else, id or not')
  for (const sub of tech.subIndustries) {
    assert.ok(!('id' in sub), 'no code path may read an id that the payload does not promise')
  }
  const health = res.body.items.find((i) => i.name === 'Healthcare')
  assert.deepEqual(health.subIndustries, [], 'an industry with none renders without an expander')

  const off = await withUpstream(stub, () =>
    client.get(`/api/prospects/filters/industries?search=${token()}&withSubIndustry=false&limit=2`))
  assert.equal(off.status, 200)
  assert.equal(stub.query(stub.calls.at(-1).path, 'withSubIndustry'), 'false')
})

test('the flat sub-industry lookup returns the id the nested list does not, and flags a missing parent', async () => {
  const t = token()
  const stub = recorder(() => ({
    success: true,
    data: [
      { id: 41, sub_industry_name: 'E-Learning', industry_id: 7 },
      { id: 42, sub_industry_name: 'E-Commerce', industry_id: 9 },
    ],
  }))

  const res = await withUpstream(stub, () =>
    client.get(`/api/prospects/filters/sub-industries?search=${t}&industryIds=7&limit=100`))
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items[0], { id: 41, name: 'E-Learning', industryId: 7, parentMissing: false })
  assert.deepEqual(res.body.items[1], { id: 42, name: 'E-Commerce', industryId: 9, parentMissing: true },
    'a sub-industry whose parent is not selected is flagged, not silently contradicting the industry filter')

  const bad = await client.get('/api/prospects/filters/sub-industries?industryId=abc')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'industryId')

  const narrowed = await withUpstream(stub, () =>
    client.get(`/api/prospects/filters/sub-industries?search=${token()}&industryId=7&limit=100`))
  assert.equal(narrowed.status, 200)
  assert.equal(stub.query(stub.calls.at(-1).path, 'industry_id'), '7',
    'the provider’s own parameter name, sent only when a parent was chosen')
})

test('company results are keyed by name and marked against this workspace’s leads', async () => {
  seedLead(db, owner.id, 'cfo@initech.test', { company: '  initech  ' })
  const t = token()
  const stub = recorder(() => ({
    success: true,
    // Two companies sharing a name: the payload documents no id, so there is
    // nothing to tell them apart and the UI must not pretend otherwise.
    data: [{ company_name: 'Initech' }, { company_name: 'Vandelay' }, { company_name: 'Vandelay' }],
  }))
  const res = await withUpstream(stub, () => client.get(`/api/prospects/filters/companies?search=${t}&limit=100`))
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items, [
    { name: 'Initech', alreadyInLeads: true },   // case- and whitespace-insensitive
    { name: 'Vandelay', alreadyInLeads: false },
    { name: 'Vandelay', alreadyInLeads: false },
  ])
  for (const item of res.body.items) {
    assert.ok(!('id' in item), 'no id is invented for a payload that documents none')
  }
})

// ============================================================= get contacts

test('the contacts search box searches names, exactly as its label promises', async () => {
  const saved = await client.post('/api/prospects/searches', { name: 'Contact search', filters: {} })
  const fetchId = Number(db.prepare(
    "INSERT INTO prospect_fetches (workspace_id, search_id, name, requested, status) VALUES (?, ?, 'run', 3, 'done')"
  ).run(owner.id, saved.body.id).lastInsertRowid)
  db.prepare(
    `INSERT INTO prospect_contacts (workspace_id, fetch_id, first_name, last_name, email, title, company)
     VALUES (?, ?, 'Ada', 'Byron', 'ada@zephyr.test', 'Head of Zephyr Ops', 'Zephyr Industries')`
  ).run(owner.id, fetchId)

  const byName = await client.post('/api/prospects/contacts', { filterId: saved.body.id, search: 'byron' })
  assert.equal(byName.status, 200)
  assert.equal(byName.body.items.length, 1, 'surname matches')
  assert.equal(byName.body.items[0].fullName, 'Ada Byron')
  assert.deepEqual(byName.body.items[0].company, { name: 'Zephyr Industries', website: '' })

  const byFullName = await client.post('/api/prospects/contacts', { filterId: saved.body.id, search: 'ada byron' })
  assert.equal(byFullName.body.items.length, 1, 'and so does the full name')

  // The documented behaviour is first_name / last_name / full_name only. A
  // company hit here would make the field's label a lie.
  for (const term of ['Zephyr Industries', 'Head of Zephyr']) {
    const res = await client.post('/api/prospects/contacts', { filterId: saved.body.id, search: term })
    assert.equal(res.body.items.length, 0, `"${term}" is a company or title, and this box searches names`)
    assert.equal(res.body.totalCount, 0)
  }
})

test('the verification and catch-all filters compose instead of cancelling each other out', async () => {
  const saved = await client.post('/api/prospects/searches', { name: 'Quality filters', filters: {} })
  const fetchId = Number(db.prepare(
    "INSERT INTO prospect_fetches (workspace_id, search_id, name, requested, status) VALUES (?, ?, 'run', 4, 'done')"
  ).run(owner.id, saved.body.id).lastInsertRowid)
  const insert = db.prepare(
    `INSERT INTO prospect_contacts (workspace_id, fetch_id, first_name, last_name, email, email_verification_status)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  insert.run(owner.id, fetchId, 'Good', 'One', 'good@q.test', 'valid')
  insert.run(owner.id, fetchId, 'Bad', 'One', 'bad@q.test', 'invalid')
  insert.run(owner.id, fetchId, 'Risky', 'One', 'risky@q.test', 'catch_all_hard_bounced')
  insert.run(owner.id, fetchId, 'Maybe', 'One', 'maybe@q.test', 'catch_all_verified')

  const only = (body) => client.post('/api/prospects/contacts', { filterId: saved.body.id, ...body })

  const valid = await only({ verificationStatus: 'valid' })
  assert.deepEqual(valid.body.items.map((i) => i.email), ['good@q.test'])

  const invalid = await only({ verificationStatus: 'invalid' })
  assert.deepEqual(invalid.body.items.map((i) => i.email), ['bad@q.test'])

  // Upstream these are two fields; Harry keeps one column. `catch_all` must
  // still mean every catch-all contact, or the filter silently returns nothing
  // and reads as "no contacts match" when the truth is "we cannot express it".
  const catchAll = await only({ verificationStatus: 'catch_all' })
  assert.deepEqual(catchAll.body.items.map((i) => i.email).sort(), ['maybe@q.test', 'risky@q.test'])

  const bounced = await only({ catchAllStatus: 'catch_all_hard_bounced' })
  assert.deepEqual(bounced.body.items.map((i) => i.email), ['risky@q.test'])

  const both = await only({ verificationStatus: 'catch_all', catchAllStatus: 'catch_all_hard_bounced' })
  assert.deepEqual(both.body.items.map((i) => i.email), ['risky@q.test'],
    'the two documented filters narrow together rather than contradicting')

  // All five catch-all values are accepted, and nothing else is.
  for (const value of ['catch_all_verified', 'catch_all_soft_bounced', 'catch_all_hard_bounced', 'catch_all_unknown', 'catch_all_bounced']) {
    const res = await only({ catchAllStatus: value })
    assert.equal(res.status, 200, `${value} is documented and must be accepted`)
  }
})

test('contact paging uses the totals Harry can actually count', async () => {
  const saved = await client.post('/api/prospects/searches', { name: 'Paging', filters: {} })
  const fetchId = Number(db.prepare(
    "INSERT INTO prospect_fetches (workspace_id, search_id, name, requested, status) VALUES (?, ?, 'run', 5, 'done')"
  ).run(owner.id, saved.body.id).lastInsertRowid)
  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO prospect_contacts (workspace_id, fetch_id, provider_contact_id, first_name, last_name, email)
       VALUES (?, ?, ?, 'Page', ?, ?)`
    ).run(owner.id, fetchId, `adapt-${i}`, `Row${i}`, `page${i}@p.test`)
  }

  const first = await client.post('/api/prospects/contacts', { filterId: saved.body.id, limit: 2, offset: 0 })
  assert.equal(first.body.totalCount, 5)
  assert.deepEqual(first.body.pagination, { limit: 2, offset: 0, total: 5, hasMore: true })

  const last = await client.post('/api/prospects/contacts', { filterId: saved.body.id, limit: 2, offset: 4 })
  assert.equal(last.body.items.length, 1)
  assert.equal(last.body.pagination.hasMore, false, '"load more" disappears exactly at the end')

  // The id list is the other half of the exclusive choice, and it selects by
  // the provider's contact id rather than by position in the page.
  const byId = await client.post('/api/prospects/contacts', { adaptIds: ['adapt-3', 'adapt-0'] })
  assert.equal(byId.status, 200)
  assert.deepEqual(byId.body.items.map((i) => i.email).sort(), ['page0@p.test', 'page3@p.test'])
})
