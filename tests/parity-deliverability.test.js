// Smart delivery parity tests.
//
// Everything here runs with NO deliverability provider configured — the env
// vars are deliberately unset — so the suite makes no network call. That is the
// point: the category's whole contract is that a workspace with no provider
// still gets every route, every validation and every one of its own rows.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedMailbox, mount } from './helpers/parity-harness.js'

setup('deliverability')            // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register, normaliseProviders, parseAuthResults, UPSTREAM, UNVERIFIED } =
  await import('../server/parity/deliverability.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
const other = await mount(register, stranger)

const mailbox = seedMailbox(db, owner.id, 'sender@example.com')
const strangerMailbox = seedMailbox(db, stranger.id, 'someone@elsewhere.test')

test.after(async () => { await client.close(); await other.close() })

// --- helpers ---------------------------------------------------------------

let seq = 0
async function makeManualTest(c = client, mb = mailbox, extra = {}) {
  seq += 1
  const res = await c.post('/api/deliverability/tests/manual', {
    name: `Manual test ${seq}`,
    mailboxIds: [mb.id],
    ...extra,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

function countRows(table, testId) {
  return db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE test_id = ?`).get(testId).n
}

// ---------------------------------------------------------------------------

test('the request-contract table names every ambiguous endpoint in one place', () => {
  assert.equal(Object.keys(UPSTREAM).length, 28, 'one entry per documented endpoint')

  // Six endpoints publish their body as {}.
  const emptyBody = Object.entries(UPSTREAM)
    .filter(([, s]) => s.body && Object.keys(s.body({ providerTestIds: [] })).length === 0)
    .map(([k]) => k)
    .sort()
  assert.deepEqual(emptyBody, ['geoReport', 'listTests', 'providerReport', 'stopTest'].sort(),
    'the literal {} bodies; the two create routes and the bulk delete send Harry\'s own inferred shape')

  // Three disagree with themselves on method, and carry a fallback.
  const disputed = Object.entries(UPSTREAM).filter(([, s]) => s.altMethod).map(([k]) => k).sort()
  assert.deepEqual(disputed, ['rdnsReport', 'spamFilterReport', 'stopTest'])
  assert.equal(UPSTREAM.stopTest.method, 'PUT')
  assert.equal(UPSTREAM.stopTest.altMethod, 'POST')
  assert.equal(UPSTREAM.rdnsReport.method, 'GET')
  assert.equal(UPSTREAM.spamFilterReport.method, 'GET')

  // Nine unverified entries, each carrying a note saying what is unknown.
  assert.equal(UNVERIFIED.length, 9)
  for (const entry of UNVERIFIED) assert.ok(entry.note.length > 20, `${entry.key} needs a note`)
})

test('provider reference data reports configured:false and names the missing env vars', async () => {
  const res = await client.get('/api/deliverability/providers')
  assert.equal(res.status, 200)
  assert.equal(res.body.configured, false)
  assert.deepEqual(res.body.regions, [])
  assert.deepEqual(res.body.missingEnv, ['DELIVERABILITY_API_URL', 'DELIVERABILITY_API_KEY'])
  assert.equal(res.body.canCreateTests, false)
  assert.match(res.body.message, /no deliverability provider is connected/i)
})

test('the provider normaliser accepts the documented object and an array', () => {
  const one = {
    region_id: 'na', region_name: 'North America',
    groups: [{ group_id: 'gmail_na', group_name: 'Gmail', provider_count: 150 }],
  }
  const fromObject = normaliseProviders(one)
  const fromArray = normaliseProviders([one])
  assert.deepEqual(fromObject, fromArray)
  assert.equal(fromObject[0].groups[0].groupId, 'gmail_na')
  assert.equal(fromObject[0].groups[0].providerCount, 150)
  assert.deepEqual(normaliseProviders(null), [])
})

test('a submitted providerId is refused while the seed list cannot be verified', async () => {
  const res = await client.post('/api/deliverability/tests/manual', {
    name: 'With a guessed provider',
    mailboxIds: [mailbox.id],
    providerId: 'gmail_na',
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'providerId')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deliverability_tests WHERE name = 'With a guessed provider'").get().n, 0)
})

// --- folders ---------------------------------------------------------------

test('folders: create, list, read and the duplicate-name conflict', async () => {
  const created = await client.post('/api/deliverability/folders', { name: '  Q3 checks  ' })
  assert.equal(created.status, 200)
  assert.equal(created.body.name, 'Q3 checks', 'trimmed server-side')
  assert.equal(created.body.testCount, 0)
  assert.ok(created.body.createdAt && created.body.updatedAt)
  assert.equal(created.body.configured, false)

  const missing = await client.post('/api/deliverability/folders', {})
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'name')

  const dup = await client.post('/api/deliverability/folders', { name: 'q3 CHECKS' })
  assert.equal(dup.status, 409, 'case-insensitive uniqueness inside the workspace')
  assert.equal(dup.body.field, 'name')

  const list = await client.get('/api/deliverability/folders')
  assert.equal(list.status, 200)
  assert.ok(list.body.items.some((f) => f.id === created.body.id))

  const one = await client.get(`/api/deliverability/folders/${created.body.id}`)
  assert.equal(one.status, 200)
  assert.equal(one.body.name, 'Q3 checks')
  assert.equal(one.body.testCount, 0)

  const bad = await client.get('/api/deliverability/folders/not-a-number')
  assert.equal(bad.status, 422)
})

test('deleting a folder never deletes a test, and refuses until the unfile is confirmed', async () => {
  const folder = (await client.post('/api/deliverability/folders', { name: 'Holds a test' })).body
  const t = await makeManualTest(client, mailbox, { folderId: folder.id })

  const beforeTests = db.prepare('SELECT COUNT(*) n FROM deliverability_tests').get().n

  const refused = await client.del(`/api/deliverability/folders/${folder.id}`)
  assert.equal(refused.status, 409)
  assert.equal(refused.body.testCount, 1, 'the refusal names the count so the UI can say it')

  const ok = await client.del(`/api/deliverability/folders/${folder.id}?unfile=1`)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.testsUnfiled, 1)
  assert.equal(ok.body.testsDeleted, 0)

  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_tests').get().n, beforeTests)
  assert.equal(db.prepare('SELECT folder_id FROM deliverability_tests WHERE id = ?').get(t.id).folder_id, null)
  assert.equal((await client.get(`/api/deliverability/folders/${folder.id}`)).status, 404)

  const events = db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = 'deliverability_folder_deleted'").get(owner.id).n
  assert.equal(events, 1, 'deletion appears in the activity trail')
})

test('a folder from another workspace is invisible and 404s without naming itself', async () => {
  const mine = (await client.post('/api/deliverability/folders', { name: 'Private filing' })).body

  const list = await other.get('/api/deliverability/folders')
  assert.equal(list.status, 200)
  assert.equal(list.body.items.some((f) => f.id === mine.id), false)

  const read = await other.get(`/api/deliverability/folders/${mine.id}`)
  assert.equal(read.status, 404)
  assert.equal(JSON.stringify(read.body).includes('Private filing'), false)

  const del = await other.del(`/api/deliverability/folders/${mine.id}?unfile=1`)
  assert.equal(del.status, 404)
  assert.ok(db.prepare('SELECT id FROM deliverability_folders WHERE id = ?').get(mine.id), 'nothing deleted')
})

// --- tests: create, validate, read -----------------------------------------

test('a manual test is created from the workspace\'s own rows with no provider', async () => {
  const body = await makeManualTest()
  assert.equal(body.configured, false)
  assert.equal(body.type, 'manual')
  assert.equal(body.status, 'active')
  assert.equal(body.everyDays, null, 'a manual test has no cadence — null, never the string "null"')
  assert.equal(body.currentRunNo, 1)
  assert.deepEqual(body.blacklist, { totalBlacklist: null, state: 'pending' })
  assert.equal(countRows('deliverability_test_senders', body.id), 1)
  assert.equal(countRows('deliverability_test_runs', body.id), 1)
})

// This assertion used to read `seedsQueued: 1` for exactly this request, and it
// passed for months while the product sent nothing: there was no seed inbox, no
// job, and no code path that could ever have performed the queued work. It is
// changed rather than deleted because the number was the defect, not the field.
test('a manual test with no seed inboxes reports no queued work and says what it is waiting for', async () => {
  const body = await makeManualTest()
  assert.equal(body.seedsQueued, 0, 'nothing can be sent, so nothing may be reported as queued')
  assert.equal(body.awaitingSeeds, true)
  assert.match(body.message, /nothing will be sent yet/i)
  assert.match(body.message, /seedEmails/)

  // The row exists so the sender list still answers — but it says why, rather
  // than sitting on `pending` and implying a send that is coming.
  const senders = db.prepare('SELECT * FROM deliverability_test_senders WHERE test_id = ?').all(body.id)
  assert.equal(senders.length, 1)
  assert.equal(senders[0].send_status, 'awaiting_seeds')
  assert.equal(senders[0].seed_email, '')

  const run = db.prepare('SELECT * FROM deliverability_test_runs WHERE test_id = ?').get(body.id)
  assert.equal(run.status, 'awaiting_seeds', 'a run with nothing to send is not "running"')
})

test('a manual test with seed inboxes queues one send per mailbox and seed', async () => {
  const body = await makeManualTest(client, mailbox, {
    seedEmails: ['Seed.One@inbox.test', 'seed.two@inbox.test'],
  })
  assert.equal(body.seedsQueued, 2)
  assert.equal(body.awaitingSeeds, false)
  assert.deepEqual(body.seedEmails, ['seed.one@inbox.test', 'seed.two@inbox.test'], 'normalised, deduped')
  assert.match(body.message, /2 seed send\(s\) queued/)

  const senders = db.prepare(
    'SELECT sender_email, seed_email, send_status FROM deliverability_test_senders WHERE test_id = ? ORDER BY seed_email'
  ).all(body.id)
  assert.deepEqual(senders, [
    { sender_email: 'sender@example.com', seed_email: 'seed.one@inbox.test', send_status: 'pending' },
    { sender_email: 'sender@example.com', seed_email: 'seed.two@inbox.test', send_status: 'pending' },
  ])
  assert.equal(db.prepare('SELECT status FROM deliverability_test_runs WHERE test_id = ?').get(body.id).status, 'running')

  // The seed list survives into the setup cache, because run 7 of a schedule
  // has to be able to find the list run 1 used.
  const setup = JSON.parse(db.prepare(
    "SELECT payload FROM deliverability_reports WHERE test_id = ? AND kind = 'setup'"
  ).get(body.id).payload)
  assert.deepEqual(setup.seedEmails, ['seed.one@inbox.test', 'seed.two@inbox.test'])
})

test('a malformed seed inbox is a 422 naming the field, and nothing is created', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM deliverability_tests').get().n
  const bad = await client.post('/api/deliverability/tests/manual', {
    name: 'Typo', mailboxIds: [mailbox.id], seedEmails: ['not-an-address'],
  })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'seedEmails')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_tests').get().n, before)
})

test('a manual test needs a mailbox, and another workspace\'s mailbox 404s', async () => {
  const noMailbox = await client.post('/api/deliverability/tests/manual', { name: 'No senders' })
  assert.equal(noMailbox.status, 422)
  assert.equal(noMailbox.body.field, 'mailboxIds')

  const foreign = await client.post('/api/deliverability/tests/manual', {
    name: 'Someone else\'s mailbox', mailboxIds: [strangerMailbox.id],
  })
  assert.equal(foreign.status, 404)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deliverability_tests WHERE name LIKE 'Someone else%'").get().n, 0)
})

test('an automated schedule echoes its cadence and rejects an end date that never runs', async () => {
  const start = new Date(Date.now() + 3600_000).toISOString()
  const end = new Date(Date.now() + 30 * 86400_000).toISOString()

  const res = await client.post('/api/deliverability/tests/schedule', {
    name: 'Weekly placement check',
    scheduleStartTime: start,
    testEndDate: end,
    everyDays: 7,
    minTimeBtwnEmails: 5,
    minTimeUnit: 'minutes',
    linkChecker: true,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.type, 'automated')
  assert.equal(res.body.status, 'active')
  assert.equal(res.body.everyDays, 7)
  assert.equal(res.body.linkChecker, true)
  assert.match(res.body.schedulerCronValue, /^\d+ \d+ \* \* \d$/)
  assert.equal(res.body.duplicateOf, null)

  for (const [field, body] of [
    ['scheduleStartTime', { name: 'x', everyDays: 7 }],
    ['everyDays', { name: 'x', scheduleStartTime: start }],
    ['testEndDate', { name: 'x', scheduleStartTime: end, testEndDate: start, everyDays: 7 }],
    ['minTimeUnit', { name: 'x', scheduleStartTime: start, everyDays: 7, minTimeUnit: 'fortnights' }],
    ['everyDays', { name: 'x', scheduleStartTime: start, everyDays: 0 }],
  ]) {
    const bad = await client.post('/api/deliverability/tests/schedule', body)
    assert.equal(bad.status, 422, JSON.stringify(body))
    assert.equal(bad.body.field, field, `422 names ${field}`)
  }

  const trail = db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = 'deliverability_test_scheduled'").get(owner.id).n
  assert.equal(trail, 1)
})

test('the detail resolves its references and never leaks client_id or user_id', async () => {
  const campaign = db.prepare("INSERT INTO campaigns (user_id, name, status, mermaid) VALUES (?, 'Q3 outbound', 'draft', ?) RETURNING *")
    .get(owner.id, 'flowchart TD\n  S([Start]) --> A[Send: intro]\n  A --> W([Won])')

  const created = await makeManualTest(client, mailbox, {
    campaignId: campaign.id,
    sequenceStepId: 'A',
    description: 'Checking the intro email',
  })

  const res = await client.get(`/api/deliverability/tests/${created.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.campaignName, 'Q3 outbound')
  assert.equal(res.body.sequenceStepLabel, 'Send: intro')
  assert.equal(res.body.description, 'Checking the intro email')
  assert.equal(res.body.providerId, null)
  const serialised = JSON.stringify(res.body)
  assert.equal(serialised.includes('client_id'), false)
  assert.equal(serialised.includes('user_id'), false)
  assert.equal(serialised.includes('blocklist_count'), false)

  // A deleted campaign yields a null name with a reason, not a 500.
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaign.id)
  const after = await client.get(`/api/deliverability/tests/${created.id}`)
  assert.equal(after.status, 200)
  assert.equal(after.body.campaignName, null)
  assert.match(after.body.campaignUnavailableReason, /no longer exists/)
})

test('a malformed test id is a 422, an unknown one a 404 that names nothing', async () => {
  const malformed = await client.get('/api/deliverability/tests/not a valid id!')
  assert.equal(malformed.status, 422)
  const unknown = await client.get('/api/deliverability/tests/9999999')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error, 'not_found')
})

// --- cross-workspace isolation ---------------------------------------------

test('another workspace\'s tests never appear and every route 404s on them', async () => {
  const mine = await makeManualTest(client, mailbox, {})

  const list = await other.get('/api/deliverability/tests')
  assert.equal(list.status, 200)
  assert.equal(list.body.items.some((t) => t.id === mine.id), false)

  const routes = [
    '', '/authentication', '/blacklist', '/blacklist?summary=1', '/domain-blacklist',
    '/content', '/counts', '/dkim', '/spf', '/rdns', '/history', '/ips',
    '/mailboxes', '/providers', '/regions', '/senders', '/senders/report', '/spam-filters',
  ]
  for (const suffix of routes) {
    const res = await other.get(`/api/deliverability/tests/${mine.id}${suffix}`)
    assert.equal(res.status, 404, `GET ${suffix || '/'} must 404 across workspaces`)
    assert.equal(JSON.stringify(res.body).includes(mine.name), false)
  }

  const stop = await other.put(`/api/deliverability/tests/${mine.id}/stop`)
  assert.equal(stop.status, 404)
  assert.equal(db.prepare('SELECT status FROM deliverability_tests WHERE id = ?').get(mine.id).status, 'active')

  const del = await other.post('/api/deliverability/tests/delete', { testIds: [mine.id] })
  assert.equal(del.status, 404)
  assert.ok(db.prepare('SELECT id FROM deliverability_tests WHERE id = ?').get(mine.id), 'nothing deleted')

  const summary = await other.get(`/api/deliverability/tests/blacklist-summary?testIds=${mine.id}`)
  assert.equal(summary.status, 200)
  assert.deepEqual(summary.body.items, [])
  assert.deepEqual(summary.body.unavailable, [mine.id])
})

// --- paging ----------------------------------------------------------------

test('paging is stable when a new test is created mid-scroll', async () => {
  const scoped = seedUser(db, 'pager@example.com')
  const box = seedMailbox(db, scoped.id, 'pager-mb@example.com')
  const pager = await mount(register, scoped)
  try {
    const made = []
    for (let i = 0; i < 3; i++) made.push(await makeManualTest(pager, box))
    const ids = made.map((t) => t.id)

    const first = await pager.get('/api/deliverability/tests?limit=2')
    assert.equal(first.status, 200)
    assert.equal(first.body.total, 3)
    assert.deepEqual(first.body.items.map((t) => t.id), [ids[2], ids[1]], 'newest first')
    assert.equal(first.body.hasMore, true)

    // A fourth test arrives while the reader is between pages.
    const fresh = await makeManualTest(pager, box)

    const second = await pager.get(`/api/deliverability/tests?limit=2&cursor=${first.body.nextCursor}`)
    assert.equal(second.status, 200)
    assert.deepEqual(second.body.items.map((t) => t.id), [ids[0]],
      'the mid-scroll insert neither repeats a row nor pushes one off the page')
    assert.equal(second.body.items.some((t) => t.id === fresh.id), false)
    assert.equal(second.body.hasMore, false)
  } finally {
    await pager.close()
  }
})

// --- blocklist counts ------------------------------------------------------

test('blocklist counts on the list come from the same rows as the detail', async () => {
  const t = await makeManualTest()

  // Pending, never zero, before anything has been checked.
  const beforeDetail = await client.get(`/api/deliverability/tests/${t.id}/blacklist?summary=1`)
  assert.equal(beforeDetail.status, 200)
  assert.deepEqual(
    { totalBlacklist: beforeDetail.body.totalBlacklist, state: beforeDetail.body.state },
    { totalBlacklist: null, state: 'pending' },
  )

  const ins = db.prepare(
    'INSERT INTO deliverability_blacklist (test_id, kind, value, provider, listed) VALUES (?, ?, ?, ?, ?)'
  )
  ins.run(t.id, 'ip', '203.0.113.9', 'Spamhaus', 1)
  ins.run(t.id, 'ip', '203.0.113.9', 'Barracuda', 0)   // same IP, second check
  ins.run(t.id, 'ip', '198.51.100.4', 'Spamhaus', 1)
  ins.run(t.id, 'domain', 'example.com', 'SURBL', 0)

  const detail = await client.get(`/api/deliverability/tests/${t.id}/blacklist`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.totalBlacklist, 2)
  assert.equal(detail.body.state, 'listed')
  assert.equal(detail.body.groups.length, 2, 'grouped by IP: one listed IP reported once')

  const summary = await client.get(`/api/deliverability/tests/${t.id}/blacklist?summary=1`)
  assert.equal(summary.body.totalBlacklist, detail.body.totalBlacklist)

  const list = await client.get('/api/deliverability/tests?limit=200')
  const row = list.body.items.find((x) => x.id === t.id)
  assert.deepEqual(row.blacklist, { totalBlacklist: detail.body.totalBlacklist, state: detail.body.state },
    'the list and the detail are provably the same derivation')

  const batched = await client.get(`/api/deliverability/tests/blacklist-summary?testIds=${t.id}`)
  assert.equal(batched.status, 200)
  assert.deepEqual(batched.body.items, [{ testId: t.id, totalBlacklist: 2, state: 'listed' }])

  // The domain rollup reads its own rows, not the IP ones.
  const domain = await client.get(`/api/deliverability/tests/${t.id}/domain-blacklist`)
  assert.equal(domain.body.totalBlacklist, 0)
  assert.equal(domain.body.state, 'clear')
})

test('the batched summary caps its id list and validates it', async () => {
  const none = await client.get('/api/deliverability/tests/blacklist-summary')
  assert.equal(none.status, 422)
  assert.equal(none.body.field, 'testIds')

  const bad = await client.get('/api/deliverability/tests/blacklist-summary?testIds=1,frog')
  assert.equal(bad.status, 422)

  const tooMany = Array.from({ length: 51 }, (_, i) => i + 1).join(',')
  const over = await client.get(`/api/deliverability/tests/blacklist-summary?testIds=${tooMany}`)
  assert.equal(over.status, 422)
  assert.match(over.body.message, /at most 50/)
})

// --- every report route ----------------------------------------------------

test('every report route answers well-formed with configured:false rather than 500', async () => {
  const t = await makeManualTest()

  const expectations = {
    '/authentication': (b) => {
      assert.equal(b.checks.length, 3)
      assert.deepEqual(b.checks.map((c) => c.check), ['dkim', 'spf', 'rdns'])
      for (const c of b.checks) { assert.deepEqual(c.groups, []); assert.equal(c.available, false) }
    },
    '/dkim': (b) => { assert.equal(b.check, 'dkim'); assert.deepEqual(b.groups, []) },
    '/spf': (b) => { assert.equal(b.check, 'spf'); assert.deepEqual(b.groups, []) },
    '/rdns': (b) => { assert.equal(b.check, 'rdns'); assert.deepEqual(b.groups, []) },
    '/blacklist': (b) => assert.equal(b.state, 'pending'),
    '/domain-blacklist': (b) => assert.deepEqual(b.groups, []),
    '/counts': (b) => {
      assert.equal(b.inboxRate, null, 'no percentage when nothing has been delivered')
      assert.equal(b.totalEmailCount, 0)
      assert.equal(b.notYetDelivered, 0)
    },
    '/ips': (b) => assert.deepEqual(b.items, []),
    '/mailboxes': (b) => assert.deepEqual(b.items, []),
    '/providers': (b) => { assert.deepEqual(b.result, []); assert.equal(b.partial, true) },
    '/regions': (b) => { assert.deepEqual(b.result, []); assert.equal(b.partial, true) },
    '/spam-filters': (b) => assert.deepEqual(b.groups, []),
    '/senders': (b) => { assert.equal(b.items.length, 1); assert.equal(b.items[0].fromEmail, 'sender@example.com') },
    '/senders/report': (b) => assert.deepEqual(b.items, []),
    '/history': (b) => { assert.equal(b.runs.length, 1); assert.equal(b.trendPoints, null) },
    '/content': (b) => {
      assert.equal(b.htmlIsUntrusted, true)
      assert.equal(b.stored, false)
      assert.equal(b.html, null)
      assert.ok(b.renderContract.includes('sandboxed'))
    },
  }

  for (const [suffix, check] of Object.entries(expectations)) {
    const res = await client.get(`/api/deliverability/tests/${t.id}${suffix}`)
    assert.equal(res.status, 200, `GET ${suffix} returned ${res.status}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.configured, false, `${suffix} must report configured:false`)
    assert.deepEqual(res.body.missingEnv, ['DELIVERABILITY_API_URL', 'DELIVERABILITY_API_KEY'], suffix)
    check(res.body)
  }

  // The reply-header route needs a reply that belongs to the test.
  const sender = db.prepare('SELECT * FROM deliverability_test_senders WHERE test_id = ?').get(t.id)
  const headers = await client.get(`/api/deliverability/tests/${t.id}/replies/${sender.id}/headers`)
  assert.equal(headers.status, 200)
  assert.equal(headers.body.configured, false)
  assert.equal(headers.body.headers, null)
  assert.equal(headers.body.summary, null)
  assert.equal(headers.body.cached, false)

  const foreignReply = await client.get(`/api/deliverability/tests/${t.id}/replies/999999/headers`)
  assert.equal(foreignReply.status, 404)

  const malformedReply = await client.get(`/api/deliverability/tests/${t.id}/replies/not a reply/headers`)
  assert.equal(malformedReply.status, 422)
})

test('content and headers are never stored, and the content route sets its sandbox headers', async () => {
  const t = await makeManualTest()
  const before = countRows('deliverability_reports', t.id)

  const res = await fetch(`${client.base}/api/deliverability/tests/${t.id}/content`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-security-policy') || '', /sandbox/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('cache-control'), 'no-store')

  await client.get(`/api/deliverability/tests/${t.id}/replies/${db.prepare('SELECT id FROM deliverability_test_senders WHERE test_id = ?').get(t.id).id}/headers`)

  assert.equal(countRows('deliverability_reports', t.id), before, 'no report row written by a live-only fetch')
  const leaked = db.prepare("SELECT COUNT(*) n FROM telemetry WHERE detail LIKE '%Authentication-Results%' OR detail LIKE '%<script%'").get().n
  assert.equal(leaked, 0, 'no header or body value reaches telemetry')
})

test('cached report payloads are rendered whole, with a staleness marker', async () => {
  const t = await makeManualTest()
  db.prepare(
    "INSERT INTO deliverability_reports (test_id, run_no, kind, ref, payload, fetched_at) VALUES (?, 1, 'counts', '', ?, datetime('now'))"
  ).run(t.id, JSON.stringify({ inboxCount: 264, spamCount: 24, tabCount: 6, failedCount: 4, totalEmailCount: 300 }))

  const res = await client.get(`/api/deliverability/tests/${t.id}/counts`)
  assert.equal(res.status, 200)
  assert.equal(res.body.inboxCount, 264)
  assert.equal(res.body.inboxRate, 0.88)
  assert.equal(res.body.tabCount, 6, 'a Promotions tab is never folded into the inbox figure')
  assert.equal(res.body.notYetDelivered, 2)
  assert.equal(res.body.available, true)
  assert.equal(res.body.stale, false)
  assert.ok(res.body.fetchedAt)
})

test('spam-filter reasons are classified alongside the raw string, unknown by default', async () => {
  const t = await makeManualTest()
  db.prepare(
    "INSERT INTO deliverability_reports (test_id, run_no, kind, ref, payload) VALUES (?, 1, 'spam_filters', '', ?)"
  ).run(t.id, JSON.stringify({
    groups: [{
      from_email: 'sender@example.com',
      spam_filter_details: [{
        filter: 'SpamAssassin',
        triggered_count: 5,
        trigger_percentage: 5,
        reasons: ['Missing DKIM signature', 'Listed on Spamhaus', 'Subject line is all caps', 'Mercury is in retrograde'],
      }],
    }],
  }))

  const res = await client.get(`/api/deliverability/tests/${t.id}/spam-filters`)
  assert.equal(res.status, 200)
  const reasons = res.body.groups[0].spamFilterDetails[0].reasons
  assert.deepEqual(reasons.map((r) => r.reasonType), ['authentication', 'reputation', 'content', 'unknown'])
  assert.equal(reasons[0].reason, 'Missing DKIM signature', 'the raw string is never rewritten')
  assert.equal(res.body.unclassifiedReasons, 1)
})

test('Authentication-Results parses defensively and never throws', () => {
  assert.deepEqual(
    parseAuthResults({ 'Authentication-Results': 'mx.test; dkim=pass; spf=pass; dmarc=fail' }),
    { dkim: 'pass', spf: 'pass', dmarc: 'fail' },
  )
  assert.equal(parseAuthResults({ 'Reveived-Spf': 'pass' }), null, 'the misspelled key is not depended on')
  assert.equal(parseAuthResults({ 'Authentication-Results': 'total gibberish' }), null)
  assert.equal(parseAuthResults(null), null)
})

// --- stop ------------------------------------------------------------------

test('stopping a schedule deletes nothing and is idempotent', async () => {
  const t = await makeManualTest()
  db.prepare("INSERT INTO deliverability_reports (test_id, run_no, kind, ref, payload) VALUES (?, 1, 'ips', '', '[]')").run(t.id)

  const runsBefore = countRows('deliverability_test_runs', t.id)
  const reportsBefore = countRows('deliverability_reports', t.id)

  const stop = await client.put(`/api/deliverability/tests/${t.id}/stop`)
  assert.equal(stop.status, 200)
  assert.equal(stop.body.changed, true)
  assert.equal(stop.body.status, 'stopped')
  assert.equal(stop.body.runsKept, runsBefore)
  assert.equal(stop.body.cachedReportRowsKept, reportsBefore)
  assert.equal(countRows('deliverability_test_runs', t.id), runsBefore)
  assert.equal(countRows('deliverability_reports', t.id), reportsBefore)

  const again = await client.put(`/api/deliverability/tests/${t.id}/stop`)
  assert.equal(again.status, 200, 'already stopped is success')
  assert.equal(again.body.changed, false)

  const trail = db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = 'deliverability_test_stopped'").get(owner.id).n
  assert.equal(trail, 1, 'one trail entry, not one per call')
})

// --- bulk delete -----------------------------------------------------------

test('bulk delete is all-or-nothing, capped, and writes one activity row', async () => {
  const a = await makeManualTest()
  const b = await makeManualTest()
  db.prepare("INSERT INTO deliverability_reports (test_id, run_no, kind, ref, payload) VALUES (?, 1, 'ips', '', '[]')").run(a.id)
  db.prepare("INSERT INTO deliverability_blacklist (test_id, kind, value, provider, listed) VALUES (?, 'ip', '203.0.113.1', 'Spamhaus', 1)").run(a.id)

  const empty = await client.post('/api/deliverability/tests/delete', { testIds: [] })
  assert.equal(empty.status, 422)
  assert.equal(empty.body.field, 'testIds')

  const capped = await client.post('/api/deliverability/tests/delete', {
    testIds: Array.from({ length: 201 }, (_, i) => i + 1),
  })
  assert.equal(capped.status, 422)
  assert.match(capped.body.message, /at most 200/)

  // One bad id and nothing at all is deleted.
  const partial = await client.post('/api/deliverability/tests/delete', { testIds: [a.id, 9999999, b.id] })
  assert.equal(partial.status, 404)
  assert.equal(partial.body.id, 9999999, 'the 404 identifies the rejected id')
  assert.ok(db.prepare('SELECT id FROM deliverability_tests WHERE id = ?').get(a.id))
  assert.ok(db.prepare('SELECT id FROM deliverability_tests WHERE id = ?').get(b.id))

  const eventsBefore = db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = 'deliverability_tests_deleted'").get(owner.id).n

  const done = await client.post('/api/deliverability/tests/delete', { testIds: [a.id, b.id] })
  assert.equal(done.status, 200)
  assert.equal(done.body.deleted, 2)
  assert.equal(done.body.message, 'Tests deleted successfully')
  assert.ok(done.body.cachedReportRowsRemoved >= 4)

  for (const id of [a.id, b.id]) {
    assert.equal(db.prepare('SELECT id FROM deliverability_tests WHERE id = ?').get(id), undefined)
    for (const table of ['deliverability_reports', 'deliverability_blacklist', 'deliverability_test_senders', 'deliverability_test_runs']) {
      assert.equal(countRows(table, id), 0, `${table} left an orphan for #${id}`)
    }
  }

  const eventsAfter = db.prepare("SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = 'deliverability_tests_deleted'").get(owner.id).n
  assert.equal(eventsAfter - eventsBefore, 1, 'one events row per bulk call, not one per test')
})

test('deleting a running automated test also stops its schedule', async () => {
  const scheduled = (await client.post('/api/deliverability/tests/schedule', {
    name: 'Runs weekly until deleted',
    scheduleStartTime: new Date(Date.now() + 3600_000).toISOString(),
    everyDays: 7,
  })).body
  assert.equal(scheduled.status, 'active')

  const res = await client.post('/api/deliverability/tests/delete', { testIds: [scheduled.id] })
  assert.equal(res.status, 200)
  assert.equal(res.body.schedulesStopped, 1)
  assert.equal(db.prepare('SELECT id FROM deliverability_tests WHERE id = ?').get(scheduled.id), undefined)
})

// --- list filters ----------------------------------------------------------

test('the list filters by status, type and folder without leaving the workspace', async () => {
  const scoped = seedUser(db, 'filters@example.com')
  const box = seedMailbox(db, scoped.id, 'filters-mb@example.com')
  const c = await mount(register, scoped)
  try {
    const folder = (await c.post('/api/deliverability/folders', { name: 'Filed' })).body
    const filed = await makeManualTest(c, box, { folderId: folder.id })
    const loose = await makeManualTest(c, box)
    await c.put(`/api/deliverability/tests/${loose.id}/stop`)

    const byFolder = await c.get(`/api/deliverability/tests?folderId=${folder.id}`)
    assert.deepEqual(byFolder.body.items.map((t) => t.id), [filed.id])
    assert.equal(byFolder.body.items[0].folderName, 'Filed')

    const unfiled = await c.get('/api/deliverability/tests?folderId=0')
    assert.deepEqual(unfiled.body.items.map((t) => t.id), [loose.id])

    const stopped = await c.get('/api/deliverability/tests?status=stopped')
    assert.deepEqual(stopped.body.items.map((t) => t.id), [loose.id])

    const manual = await c.get('/api/deliverability/tests?type=manual')
    assert.equal(manual.body.total, 2)

    const bogus = await c.get('/api/deliverability/tests?status=exploded')
    assert.equal(bogus.status, 422)
    assert.equal(bogus.body.field, 'status')

    assert.equal((await c.get('/api/deliverability/tests')).body.activeCount, 1)
  } finally {
    await c.close()
  }
})
