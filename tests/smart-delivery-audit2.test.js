// Smart delivery — the second audit pass over Docs/smart-delivery/*.md.
//
// tests/parity-deliverability.test.js proves the surface answers;
// tests/smart-delivery-audit.test.js proves the create/stop/blocklist/auth
// acceptance criteria underneath it. This file takes the twenty-five specs
// those two left without a test-backed verdict — the folders, the batched
// count, the per-test report readers, the run history and the sender views —
// and asks of each the only question that matters: does the route DO the thing,
// or does it merely SAY it?
//
// Same conditions as both: NO deliverability provider is configured, so nothing
// here opens a socket. Store functions the reconciler would call are exercised
// directly, because "what happens when a payload arrives" is a question about
// Harry's own rows, not about the network.
//
// Two claims in this category are asserted by counting SQL statements rather
// than by reading a response, because "one grouped query" and "one query for a
// page of fifty" are promises no response body can keep or break.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedMailbox, mount } from './helpers/parity-harness.js'

setup('smart-delivery-audit2')      // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register, storeRuns } = await import('../server/parity/deliverability.js')
const jobs = await import('../server/deliverability-runs.js')

const owner = seedUser(db, 'owner@delivery2.test')
const client = await mount(register, owner)
const mailbox = seedMailbox(db, owner.id, 'sender@example.com')

test.after(async () => { await client.close() })

// --- helpers ---------------------------------------------------------------

let seq = 0
async function makeManualTest(c = client, mb = mailbox, extra = {}) {
  seq += 1
  const res = await c.post('/api/deliverability/tests/manual', {
    name: `Audit2 manual ${seq}`,
    mailboxIds: [mb.id],
    ...extra,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

async function makeAutomatedTest(c = client, mb = mailbox, extra = {}) {
  seq += 1
  const res = await c.post('/api/deliverability/tests/schedule', {
    name: `Audit2 automated ${seq}`,
    mailboxIds: [mb.id],
    scheduleStartTime: new Date(Date.now() + 3600_000).toISOString(),
    everyDays: 7,
    ...extra,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

// SQLite writes `datetime('now')` as 'YYYY-MM-DD HH:MM:SS' in UTC. A cached row
// is aged by writing that format directly rather than by waiting five minutes.
function sqlTime(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ')
}

// A cached provider payload, written the way the reconciler writes one.
function report(testId, kind, payload, runNo = 1, fetchedAt = null) {
  db.prepare(
    `INSERT INTO deliverability_reports (test_id, run_no, kind, ref, payload, fetched_at)
     VALUES (?, ?, ?, '', ?, ?)
     ON CONFLICT (test_id, run_no, kind, ref)
     DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).run(testId, runNo, kind, JSON.stringify(payload), fetchedAt || sqlTime())
}

// Every SQL statement the server compiles while `fn` runs. Sequential tests and
// a private listener mean nothing else is talking to this database, so the log
// is exactly what the handler did. This is the only way to hold a route to "one
// grouped query" rather than to a response body that looks the same either way.
async function withQueryLog(fn) {
  const original = db.prepare
  const hadOwn = Object.prototype.hasOwnProperty.call(db, 'prepare')
  const seen = []
  db.prepare = function patched(sql) { seen.push(String(sql)); return original.call(db, sql) }
  try {
    const result = await fn()
    return { result, seen }
  } finally {
    if (hadOwn) db.prepare = original
    else delete db.prepare
  }
}

const deliverabilityQueries = (seen) => seen.filter((sql) => /deliverability_/.test(sql))
const eventCount = (wsId) => db.prepare('SELECT COUNT(*) n FROM events WHERE user_id = ?').get(wsId).n

// ===========================================================================
// get-folders — "counts come from one grouped query", "ordering is stable"
// ===========================================================================

test('the folder list is one grouped query however many folders it holds, ordered stably', async () => {
  const scoped = seedUser(db, 'folder-list@delivery2.test')
  const box = seedMailbox(db, scoped.id, 'folder-list-mb@example.com')
  const c = await mount(register, scoped)
  try {
    const folders = []
    for (let i = 0; i < 5; i++) {
      const made = await c.post('/api/deliverability/folders', { name: `Folder ${i}` })
      assert.equal(made.status, 200)
      folders.push(made.body)
    }
    // Two tests in each, so an N+1 has something to be N of.
    for (const folder of folders) {
      await makeManualTest(c, box, { folderId: folder.id })
      await makeManualTest(c, box, { folderId: folder.id })
    }

    const { result, seen } = await withQueryLog(() => c.get('/api/deliverability/folders'))
    assert.equal(result.status, 200)

    const queries = deliverabilityQueries(seen)
    assert.equal(queries.length, 1,
      `the list must be one grouped query; it compiled ${queries.length}:\n${queries.join('\n---\n')}`)
    assert.match(queries[0], /LEFT JOIN/i, 'and the count comes from that same statement')

    assert.equal(result.body.items.length, 5)
    assert.deepEqual(result.body.items.map((f) => f.testCount), [2, 2, 2, 2, 2])

    // Five folders created inside the same second share one `created_at`, which
    // is exactly when an unstable sort shows itself. The id tiebreak makes the
    // order deterministic and newest-first.
    assert.deepEqual(result.body.items.map((f) => f.name),
      ['Folder 4', 'Folder 3', 'Folder 2', 'Folder 1', 'Folder 0'])
    assert.deepEqual(result.body.items.map((f) => f.id), [...folders].map((f) => f.id).reverse())

    // Repeating the read gives the same order — a sort that fell back on
    // SQLite's row order would be free to differ here.
    const again = await c.get('/api/deliverability/folders')
    assert.deepEqual(again.body.items.map((f) => f.id), result.body.items.map((f) => f.id))

    // Every folder carries both documented timestamps; the table has no
    // `updated_at` column, so the created time is reported rather than dropped.
    for (const item of result.body.items) {
      assert.ok(item.createdAt, 'created_at is present')
      assert.equal(item.updatedAt, item.createdAt)
    }
  } finally {
    await c.close()
  }
})

// ===========================================================================
// get-folder-by-id / get-folders / list-tests — "reads write nothing to the
// activity trail"
// ===========================================================================

test('reading folders, tests and reports writes nothing to the activity trail', async () => {
  const scoped = seedUser(db, 'reads@delivery2.test')
  const box = seedMailbox(db, scoped.id, 'reads-mb@example.com')
  const c = await mount(register, scoped)
  try {
    const folder = (await c.post('/api/deliverability/folders', { name: 'Read me' })).body
    const t = await makeManualTest(c, box, { folderId: folder.id })

    // A write does move the trail — so the assertion below is about reads, not
    // about a trail nothing ever writes to.
    const afterWrites = eventCount(scoped.id)
    assert.ok(afterWrites >= 2, 'creating a folder and a test is on the trail')

    const reads = [
      '/api/deliverability/folders',
      `/api/deliverability/folders/${folder.id}`,
      '/api/deliverability/tests',
      `/api/deliverability/tests/${t.id}`,
      `/api/deliverability/tests/blacklist-summary?testIds=${t.id}`,
      `/api/deliverability/tests/${t.id}/blacklist`,
      `/api/deliverability/tests/${t.id}/domain-blacklist`,
      `/api/deliverability/tests/${t.id}/counts`,
      `/api/deliverability/tests/${t.id}/mailboxes`,
      `/api/deliverability/tests/${t.id}/providers`,
      `/api/deliverability/tests/${t.id}/regions`,
      `/api/deliverability/tests/${t.id}/ips`,
      `/api/deliverability/tests/${t.id}/spam-filters`,
      `/api/deliverability/tests/${t.id}/senders`,
      `/api/deliverability/tests/${t.id}/senders/report`,
      `/api/deliverability/tests/${t.id}/history`,
      `/api/deliverability/tests/${t.id}/authentication`,
      `/api/deliverability/tests/${t.id}/dkim`,
      `/api/deliverability/tests/${t.id}/spf`,
      `/api/deliverability/tests/${t.id}/rdns`,
      `/api/deliverability/tests/${t.id}/content`,
    ]
    for (const url of reads) {
      const res = await c.get(url)
      assert.equal(res.status, 200, `${url} answered ${res.status}`)
    }
    // A 404 read must not write one either.
    assert.equal((await c.get('/api/deliverability/folders/9999999')).status, 404)

    assert.equal(eventCount(scoped.id), afterWrites,
      'twenty-one reads and a refusal, and the activity trail is untouched')

    // The folder detail and the filtered list count the same rows.
    const detail = await c.get(`/api/deliverability/folders/${folder.id}`)
    const filtered = await c.get(`/api/deliverability/tests?folderId=${folder.id}`)
    assert.equal(detail.body.testCount, filtered.body.items.length)
    assert.equal(detail.body.testCount, 1)
  } finally {
    await c.close()
  }
})

// ===========================================================================
// delete-folder — the refusal is measurable, and the trail names the unfiling
// ===========================================================================

test('a refused folder deletion is recorded in telemetry, and the unfiling is named on the trail', async () => {
  const scoped = seedUser(db, 'folder-del@delivery2.test')
  const box = seedMailbox(db, scoped.id, 'folder-del-mb@example.com')
  const c = await mount(register, scoped)
  try {
    const folder = (await c.post('/api/deliverability/folders', { name: 'Not empty' })).body
    const t = await makeManualTest(c, box, { folderId: folder.id })

    const refusalsBefore = db.prepare(
      "SELECT COUNT(*) n FROM telemetry WHERE op = 'deliverability.folders.delete_refused'"
    ).get().n

    const refused = await c.del(`/api/deliverability/folders/${folder.id}`)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.testCount, 1)

    // "telemetry records refused deletions so a confusing empty-only rule can be
    // measured rather than guessed at" — the row is the measurement.
    const refusals = db.prepare(
      "SELECT * FROM telemetry WHERE op = 'deliverability.folders.delete_refused' ORDER BY id DESC"
    ).all()
    assert.equal(refusals.length - refusalsBefore, 1, 'exactly one refusal recorded')
    assert.equal(refusals[0].ok, 0)
    assert.match(refusals[0].detail, /1 tests/)

    // Nothing moved: the folder is still there and the test is still filed.
    assert.ok(db.prepare('SELECT id FROM deliverability_folders WHERE id = ?').get(folder.id))
    assert.equal(db.prepare('SELECT folder_id FROM deliverability_tests WHERE id = ?').get(t.id).folder_id, folder.id)

    const ok = await c.del(`/api/deliverability/folders/${folder.id}?unfile=1`)
    assert.equal(ok.status, 200)
    assert.equal(ok.body.testsUnfiled, 1)
    assert.equal(ok.body.testsDeleted, 0)

    const trail = db.prepare(
      "SELECT detail FROM events WHERE user_id = ? AND type = 'deliverability_folder_deleted'"
    ).all(scoped.id)
    assert.equal(trail.length, 1)
    assert.match(trail[0].detail, /Not empty/, 'the trail names the folder')
    assert.match(trail[0].detail, /1 test\(s\) unfiled, 0 deleted/, 'and how many tests were unfiled')

    // The test itself outlived the folder, with its result rows intact.
    const row = db.prepare('SELECT * FROM deliverability_tests WHERE id = ?').get(t.id)
    assert.ok(row, 'deleting a folder never deletes a test')
    assert.equal(row.folder_id, null)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_test_senders WHERE test_id = ?').get(t.id).n, 1)
  } finally {
    await c.close()
  }
})

// ===========================================================================
// ip-blacklist-count — "the batched route answers a page of 50 test ids in one
// query"
// ===========================================================================

test('a page of fifty test ids is answered in one query, and ids that are not mine are omitted', async () => {
  const scoped = seedUser(db, 'batch@delivery2.test')
  const box = seedMailbox(db, scoped.id, 'batch-mb@example.com')
  const c = await mount(register, scoped)
  const strangerTest = await makeManualTest()      // owned by `owner`, not `scoped`
  try {
    const mine = []
    for (let i = 0; i < 3; i++) mine.push(await makeManualTest(c, box))

    const ins = db.prepare(
      'INSERT INTO deliverability_blacklist (test_id, kind, value, provider, listed) VALUES (?, ?, ?, ?, ?)'
    )
    ins.run(mine[0].id, 'ip', '203.0.113.9', 'Spamhaus', 1)
    ins.run(mine[0].id, 'ip', '203.0.113.9', 'Barracuda', 0)
    ins.run(mine[1].id, 'ip', '198.51.100.4', 'Spamhaus', 0)
    // mine[2] has no rows at all: pending, which must not read as clear.

    // Fifty ids: three of mine, the stranger's, and forty-six that do not exist.
    const filler = []
    for (let i = 0; filler.length < 46; i++) filler.push(900000 + i)
    const ids = [...mine.map((t) => t.id), strangerTest.id, ...filler]
    assert.equal(ids.length, 50)

    const { result, seen } = await withQueryLog(
      () => c.get(`/api/deliverability/tests/blacklist-summary?testIds=${ids.join(',')}`)
    )
    assert.equal(result.status, 200)

    const queries = deliverabilityQueries(seen)
    assert.equal(queries.length, 1,
      `fifty ids must cost one query; it compiled ${queries.length}`)

    assert.deepEqual(result.body.items, [
      { testId: mine[0].id, totalBlacklist: 1, state: 'listed' },
      { testId: mine[1].id, totalBlacklist: 0, state: 'clear' },
      { testId: mine[2].id, totalBlacklist: null, state: 'pending' },
    ], 'checked-and-clean, never-checked and listed are three different answers')

    // Ids outside the workspace are named as unavailable rather than 404'd, and
    // the stranger's test is indistinguishable from one that never existed.
    assert.equal(result.body.unavailable.length, 47)
    assert.ok(result.body.unavailable.includes(strangerTest.id))
    assert.equal(JSON.stringify(result.body).includes(strangerTest.name), false)

    // The batched answer and the per-test detail are the same derivation.
    const detail = await c.get(`/api/deliverability/tests/${mine[0].id}/blacklist?summary=1`)
    assert.equal(detail.body.totalBlacklist, 1)
    assert.equal(detail.body.state, 'listed')
  } finally {
    await c.close()
  }
})

// ===========================================================================
// ip-details — whois flattened into named fields
// ===========================================================================

test('whois data is flattened into named fields, and a missing sub-field is null rather than a crash', async () => {
  const t = await makeManualTest()
  report(t.id, 'ips', [
    {
      ip: '203.0.113.10',
      blacklisted: true,
      summary: 'This IP has sent spam in the last 30 days.',
      whois_data: {
        isp: 'Example ISP', organization: 'Example Ltd',
        location: 'United States', reverse_dns: 'mail.example.com',
      },
      created_at: '2026-01-01T00:00:00Z',
    },
    // Half a whois block: the fields that are missing must read as "not set".
    { ip: '198.51.100.7', blacklisted: false, summary: null, whois_data: { isp: 'Other ISP' } },
    // No whois block at all.
    { ip: '198.51.100.8' },
  ])

  const res = await client.get(`/api/deliverability/tests/${t.id}/ips`)
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 3, 'nothing is dropped for being incomplete')

  const [first, partial, bare] = res.body.items
  assert.deepEqual(first, {
    ip: '203.0.113.10',
    blacklisted: true,
    summary: 'This IP has sent spam in the last 30 days.',
    isp: 'Example ISP',
    organization: 'Example Ltd',
    location: 'United States',
    reverseDns: 'mail.example.com',
    createdAt: '2026-01-01T00:00:00Z',
  }, 'the provider sentence is served verbatim and whois arrives as named fields')

  assert.equal(partial.isp, 'Other ISP')
  assert.equal(partial.organization, null)
  assert.equal(partial.location, null)
  assert.equal(partial.reverseDns, null, 'a missing reverse DNS record reads as not set, not as empty string')
  assert.equal(partial.blacklisted, false)

  assert.equal(bare.ip, '198.51.100.8')
  assert.equal(bare.reverseDns, null)
  assert.equal(bare.blacklisted, false, 'absent is not blacklisted, and not true either')

  // The cache is served with its own freshness, so a stale panel says so.
  assert.equal(res.body.available, true)
  assert.equal(res.body.stale, false)
  assert.ok(res.body.fetchedAt)

  // And an unfetched test is empty *and* says nothing has been fetched, rather
  // than reporting a clean result.
  const fresh = await makeManualTest()
  const none = await client.get(`/api/deliverability/tests/${fresh.id}/ips`)
  assert.deepEqual(none.body.items, [])
  assert.equal(none.body.available, false)
  assert.equal(none.body.fetchedAt, null)
  assert.equal(none.body.stale, true)
})

// ===========================================================================
// schedule-history — the documented run shape, re-fetch, paging
// ===========================================================================

test('the documented run payload is stored once, and re-fetching updates rather than duplicates', async () => {
  const t = await makeAutomatedTest()
  const runs = (n, status) => ({
    test_run_no: n,
    status,
    inbox_count: 184, tab_count: 6, spam_count: 10,
    adjusted_total_email_count: 200,
    reply_hour_interval_start: 0, reply_hour_interval_end: 24,
  })

  storeRuns(t.id, [runs(1, 'completed'), runs(2, 'running')])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_test_runs WHERE test_id = ?').get(t.id).n, 2)

  // The same page fetched again — the throttle exists, but a repeat must be
  // harmless when it happens.
  storeRuns(t.id, [runs(1, 'completed'), runs(2, 'completed')])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_test_runs WHERE test_id = ?').get(t.id).n, 2,
    're-fetching does not duplicate a run')
  assert.equal(
    db.prepare('SELECT status FROM deliverability_test_runs WHERE test_id = ? AND run_no = 2').get(t.id).status,
    'completed', 'it updates the run it already had')

  // The constraint the definition of done names, asserted directly: the store
  // is not the only thing standing between a re-fetch and a duplicate.
  assert.throws(
    () => db.prepare('INSERT INTO deliverability_test_runs (test_id, run_no, status) VALUES (?, 1, ?)').run(t.id, 'running'),
    /UNIQUE/i,
  )

  // A run number the provider cannot name is skipped rather than stored as 0.
  storeRuns(t.id, [{ test_run_no: 0, status: 'completed' }, { status: 'completed' }])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_test_runs WHERE test_id = ?').get(t.id).n, 2)

  const res = await client.get(`/api/deliverability/tests/${t.id}/history`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.runs.map((r) => r.runNo), [2, 1], 'most recent run first')
  const run = res.body.runs[0]
  assert.equal(run.inboxCount, 184)
  assert.equal(run.tabCount, 6)
  assert.equal(run.spamCount, 10)
  assert.equal(run.adjustedTotalEmailCount, 200)
  assert.equal(run.inboxRate, 0.92, '184 of 200 is derived server-side, once')
  assert.equal(run.replyWindowStartHour, 0)
  assert.equal(run.replyWindowEndHour, 24, 'the measurement window travels with the rate')
  assert.equal(run.partial, false)
})

test('run history pages by run number without repeating or skipping a run', async () => {
  const t = await makeAutomatedTest()
  storeRuns(t.id, Array.from({ length: 5 }, (_, i) => ({
    test_run_no: i + 1, status: 'completed',
    inbox_count: 90, adjusted_total_email_count: 100,
    reply_hour_interval_start: 0, reply_hour_interval_end: 24,
  })))

  const first = await client.get(`/api/deliverability/tests/${t.id}/history?limit=2`)
  assert.deepEqual(first.body.runs.map((r) => r.runNo), [5, 4])
  assert.equal(first.body.total, 5, 'the total is the whole history, not the page')
  assert.equal(first.body.hasMore, true)
  assert.equal(first.body.nextBefore, 4)

  const second = await client.get(`/api/deliverability/tests/${t.id}/history?limit=2&before=${first.body.nextBefore}`)
  assert.deepEqual(second.body.runs.map((r) => r.runNo), [3, 2])
  assert.equal(second.body.hasMore, true)

  const third = await client.get(`/api/deliverability/tests/${t.id}/history?limit=2&before=${second.body.nextBefore}`)
  assert.deepEqual(third.body.runs.map((r) => r.runNo), [1])
  assert.equal(third.body.hasMore, false)
  assert.equal(third.body.nextBefore, null)

  const seen = [...first.body.runs, ...second.body.runs, ...third.body.runs].map((r) => r.runNo)
  assert.deepEqual(seen, [5, 4, 3, 2, 1], 'every run once, in order, across the three pages')
})

// ===========================================================================
// test-details — a provider id that cannot be resolved is shown, not hidden
// ===========================================================================

test('an unresolvable provider id is shown with a reason rather than being hidden', async () => {
  const t = await makeManualTest()

  // A workspace that once had a provider connected: the id is stored, and the
  // seed list that would name it is no longer reachable.
  db.prepare("UPDATE deliverability_reports SET payload = ? WHERE test_id = ? AND kind = 'setup'")
    .run(JSON.stringify({
      campaignId: null, sequenceStepId: null, providerId: 'gmail_na',
      description: 'Checked against Gmail North America', createdBy: owner.email, seedEmails: [],
    }), t.id)

  const res = await client.get(`/api/deliverability/tests/${t.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.providerId, 'gmail_na', 'the raw value is shown rather than dropped')
  assert.equal(res.body.providerLabel, null)
  assert.match(res.body.providerUnavailableReason, /not available/i, 'with a note saying why it is not resolved')
  assert.equal(res.body.description, 'Checked against Gmail North America')

  // The rest of the documented header is answered in the same request — the
  // client makes no follow-up call to name a folder, a step or a setting.
  assert.equal(res.body.linkChecker, false)
  assert.equal(res.body.testWithSlAccount, false)
  assert.equal(res.body.folderId, null)
  assert.equal(res.body.campaignId, null)
  assert.equal(res.body.sequenceStepId, null)
  assert.ok(res.body.createdAt && res.body.updatedAt)

  const serialised = JSON.stringify(res.body)
  assert.equal(serialised.includes('client_id'), false)
  assert.equal(serialised.includes('user_id'), false)
  assert.equal(serialised.includes('createdBy'), false, 'the workspace-internal author is not published either')
})

// ===========================================================================
// list-tests — the cadence fields every row is rendered from
// ===========================================================================

test('every list row carries the cadence fields, and a manual test prints no cadence', async () => {
  const scoped = seedUser(db, 'cadence@delivery2.test')
  const box = seedMailbox(db, scoped.id, 'cadence-mb@example.com')
  const c = await mount(register, scoped)
  try {
    const manual = await makeManualTest(c, box)
    const automated = await makeAutomatedTest(c, box)

    const list = await c.get('/api/deliverability/tests')
    assert.equal(list.status, 200)
    const byId = new Map(list.body.items.map((row) => [row.id, row]))

    const auto = byId.get(automated.id)
    assert.equal(auto.type, 'automated')
    assert.equal(auto.status, 'active')
    assert.equal(auto.everyDays, 7)
    assert.equal(auto.currentRunNo, 0, 'a schedule has run nothing yet')
    assert.ok(auto.scheduleStartTime, 'the row can say when the cadence starts')

    const one = byId.get(manual.id)
    assert.equal(one.type, 'manual')
    assert.equal(one.everyDays, null, 'null, never the string "null"')
    assert.equal(one.currentRunNo, 1)
    assert.equal(one.testEndDate, null)

    // The literal "null" is the failure this criterion is about.
    assert.equal(JSON.stringify(list.body).includes('"null"'), false)
  } finally {
    await c.close()
  }
})

// ===========================================================================
// sender-list — a removed mailbox does not take the record with it
// ===========================================================================

test('removing the sending mailbox leaves the sender row readable, labelled not connected', async () => {
  const scoped = seedUser(db, 'gone-mb@delivery2.test')
  const box = seedMailbox(db, scoped.id, 'about-to-go@example.com')
  const c = await mount(register, scoped)
  try {
    const t = await makeManualTest(c, box, { seedEmails: ['seed@inbox.test'] })

    const before = await c.get(`/api/deliverability/tests/${t.id}/senders`)
    assert.equal(before.body.items.length, 1)
    assert.equal(before.body.items[0].mailboxId, box.id)
    assert.equal(before.body.items[0].mailboxConnected, true)

    // Exactly what DELETE /api/mailboxes/:id does. `mailbox_id` is
    // `ON DELETE SET NULL`, so the link goes; the address stored on the row is
    // what survives, and it is the address the user is diagnosing.
    db.prepare('DELETE FROM mailboxes WHERE id = ?').run(box.id)

    const after = await c.get(`/api/deliverability/tests/${t.id}/senders`)
    assert.equal(after.status, 200)
    assert.equal(after.body.items.length, 1, 'the row is kept — a removed mailbox does not erase the test')
    assert.equal(after.body.items[0].fromEmail, 'about-to-go@example.com',
      'the address the test actually sent from is still named')
    assert.equal(after.body.items[0].seedEmail, 'seed@inbox.test')
    assert.equal(after.body.items[0].mailboxConnected, false, 'and is labelled not connected in Harry')
    assert.equal(after.body.items[0].mailboxId, null)
    assert.equal(after.body.misconfigured, false, 'a sender list with rows is not a misconfiguration')

    const serialised = JSON.stringify(after.body)
    assert.equal(serialised.includes('client_id') || serialised.includes('user_id'), false)
  } finally {
    await c.close()
  }
})

// ===========================================================================
// reply-headers — a reply belongs to exactly one test, and nothing is kept
// ===========================================================================

test('a reply id from another test is refused, and no header fetch leaves a row behind', async () => {
  const a = await makeManualTest()
  const b = await makeManualTest()
  const senderA = db.prepare('SELECT * FROM deliverability_test_senders WHERE test_id = ?').get(a.id)

  // The row exists — for another test. Reading it through test B must not be a
  // way to see it.
  const crossed = await client.get(`/api/deliverability/tests/${b.id}/replies/${senderA.id}/headers`)
  assert.equal(crossed.status, 404)
  assert.equal(crossed.body.error, 'not_found')

  const reportsBefore = db.prepare('SELECT COUNT(*) n FROM deliverability_reports WHERE test_id = ?').get(a.id).n
  const mine = await client.get(`/api/deliverability/tests/${a.id}/replies/${senderA.id}/headers`)
  assert.equal(mine.status, 200)
  assert.equal(mine.body.headers, null)
  assert.equal(mine.body.summary, null)
  assert.equal(mine.body.cached, false)
  assert.match(mine.body.message, /not stored/i)

  // The provider's own seed id is the other accepted key, because that is what
  // a reply is called once the provider has reported one.
  db.prepare('UPDATE deliverability_test_senders SET seed_id = ? WHERE id = ?').run('seed-xyz', senderA.id)
  const bySeedId = await client.get(`/api/deliverability/tests/${a.id}/replies/seed-xyz/headers`)
  assert.equal(bySeedId.status, 200)
  assert.equal(bySeedId.body.replyId, 'seed-xyz')
  assert.equal((await client.get(`/api/deliverability/tests/${b.id}/replies/seed-xyz/headers`)).status, 404)

  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_reports WHERE test_id = ?').get(a.id).n, reportsBefore,
    'headers are fetched live and never cached')
  const leaked = db.prepare(
    "SELECT COUNT(*) n FROM telemetry WHERE op LIKE 'deliverability.reply_headers%' AND detail != ''"
  ).get().n
  assert.equal(leaked, 0, 'the telemetry row carries latency and status, never a header value')
})

// ===========================================================================
// sender-report — history per address, with its confidence attached
// ===========================================================================

test('sender history is keyed on the address, and an unmatched one still renders with its sample size', async () => {
  const t = await makeManualTest()
  report(t.id, 'sender_report', [
    {
      from_email: 'Sender@Example.com',
      sender_name: 'Sales team',
      details: {
        tests_count: 12, avg_inbox_rate: 0.91, avg_spam_rate: 0.05,
        avg_bounce_rate: 0.01, reputation_score: 8.7, last_test_date: '2026-01-01T00:00:00Z',
      },
    },
    { from_email: 'nobody@elsewhere.test', details: { tests_count: 1, avg_inbox_rate: 1 } },
  ])

  const res = await client.get(`/api/deliverability/tests/${t.id}/senders/report`)
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 2)

  const [known, stranger] = res.body.items
  assert.equal(known.fromEmail, 'sender@example.com', 'normalised, so the match is not case-dependent')
  assert.equal(known.mailboxId, mailbox.id, 'matched to the connected mailbox server-side')
  assert.equal(known.senderName, 'Sales team')
  assert.equal(known.testsCount, 12, 'the sample size travels with the averages')
  assert.equal(known.avgInboxRate, 0.91)
  assert.equal(known.reputationScore, 8.7, 'an unstated scale is served as given, never converted to a percentage')
  assert.equal(known.lastTestDate, '2026-01-01T00:00:00Z')

  assert.equal(stranger.mailboxId, null, 'an address with no connected mailbox still stores and renders a record')
  assert.equal(stranger.testsCount, 1)
  assert.equal(stranger.avgSpamRate, null, 'a figure the provider did not send is null, not zero')
  assert.equal(stranger.reputationScore, null)

  // A test whose report has never been fetched says so rather than showing a
  // table of zeroes.
  const fresh = await makeManualTest()
  const empty = await client.get(`/api/deliverability/tests/${fresh.id}/senders/report`)
  assert.deepEqual(empty.body.items, [])
  assert.equal(empty.body.available, false)
  assert.equal(empty.body.fetchedAt, null)
})

// ===========================================================================
// spam-filter-report — an untriggered address is still a group
// ===========================================================================

test('a sending address that triggered no filter is still its own group, with both figures shown', async () => {
  const t = await makeManualTest()
  report(t.id, 'spam_filters', {
    groups: [
      { from_email: 'clean@example.com', spam_filter_details: [] },
      {
        from_email: 'caught@example.com',
        spam_filter_details: [{
          filter: 'SpamAssassin', triggered_count: 5, trigger_percentage: 5,
          reasons: ['High spam score', 'Missing DKIM signature'],
        }],
      },
    ],
  })

  const res = await client.get(`/api/deliverability/tests/${t.id}/spam-filters`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.groups.map((g) => g.fromEmail), ['clean@example.com', 'caught@example.com'],
    'an address with nothing to report is present, so an absent group cannot be read as a missing result')
  assert.deepEqual(res.body.groups[0].spamFilterDetails, [])

  const detail = res.body.groups[1].spamFilterDetails[0]
  assert.equal(detail.filter, 'SpamAssassin')
  assert.equal(detail.triggeredCount, 5, '5 of 100 and 5% mean the same thing to different readers')
  assert.equal(detail.triggerPercentage, 5)
  assert.deepEqual(detail.reasons.map((r) => r.reason), ['High spam score', 'Missing DKIM signature'],
    'each reason is its own line and is never rewritten')
  assert.deepEqual(detail.reasons.map((r) => r.reasonType), ['content', 'authentication'])
})

// ===========================================================================
// mailbox-summary / provider-report / geo-report — absent is not zero
// ===========================================================================

test('an absent figure stays null, and an empty rollup still names its total and status', async () => {
  const t = await makeManualTest()
  report(t.id, 'mailboxes', [
    { from_email: 'sender@example.com', esp: 'Gmail', total_email_count: 100, inbox_count: 90, placement_score: 90 },
    { from_email: 'sender@example.com', esp: 'Outlook', total_email_count: 100, inbox_count: 88 },
  ])

  const mailboxes = await client.get(`/api/deliverability/tests/${t.id}/mailboxes`)
  assert.equal(mailboxes.body.items[0].placementScore, 90)
  assert.equal(mailboxes.body.items[1].placementScore, null,
    'a mailbox the provider gave no score for is unscored, not a zero-scoring mailbox')
  assert.equal(mailboxes.body.items[1].inboxRate, 0.88, 'the rate is still derived from the counts it did send')
  assert.deepEqual(mailboxes.body.items.map((i) => i.esp), ['Gmail', 'Outlook'],
    'one address, a row per receiving provider')

  // A completed rollup with nothing in it is a real answer: the panel draws no
  // chart but still reports the total it was measured over.
  report(t.id, 'providers', { overallTotalCount: 300, status: 'completed', result: [] })
  const providers = await client.get(`/api/deliverability/tests/${t.id}/providers`)
  assert.deepEqual(providers.body.result, [])
  assert.equal(providers.body.overallTotalCount, 300)
  assert.equal(providers.body.status, 'completed')
  assert.equal(providers.body.partial, false)
  assert.equal(providers.body.available, true, 'fetched-and-empty is not the same as never fetched')
  assert.deepEqual(providers.body.belowBenchmark, [])

  const regions = await client.get(`/api/deliverability/tests/${t.id}/regions`)
  assert.equal(regions.body.available, false, 'and the geo rollup, never fetched, says so separately')
  assert.equal(regions.body.status, null)
  assert.equal(regions.body.partial, true)
})

// ===========================================================================
// dkim-details / spf-details / rdns-report — a cached result is served with its
// own freshness, and staleness never hides it
// ===========================================================================

test('a cached authentication result is served with its fetch time, and a stale one is still shown', async () => {
  const t = await makeManualTest()
  const groups = { groups: [{ from_email: 'a@example.com', seed_accounts: [{ esp: 'Gmail', dkim_verified: true }] }] }

  report(t.id, 'dkim', groups, 1, sqlTime(-2 * 3600_000))
  const stale = await client.get(`/api/deliverability/tests/${t.id}/dkim`)
  assert.equal(stale.status, 200)
  assert.equal(stale.body.available, true)
  assert.equal(stale.body.stale, true, 'two hours old is past the five-minute window')
  assert.ok(stale.body.fetchedAt, 'and the fetch time is served with it')
  assert.equal(stale.body.groups.length, 1, 'a stale result is still shown — hiding it would read as "no result"')
  assert.equal(stale.body.groups[0].verdict, 'passing')

  report(t.id, 'spf', groups, 1, sqlTime(-60_000))
  const fresh = await client.get(`/api/deliverability/tests/${t.id}/spf`)
  assert.equal(fresh.body.stale, false)

  // The combined read reports each check's freshness on its own, so one stale
  // section cannot make a fresh one look old.
  const combined = await client.get(`/api/deliverability/tests/${t.id}/authentication`)
  const byCheck = new Map(combined.body.checks.map((c) => [c.check, c]))
  assert.equal(byCheck.get('dkim').stale, true)
  assert.equal(byCheck.get('spf').stale, false)
  assert.equal(byCheck.get('rdns').available, false)
  assert.equal(combined.body.stale, false, 'the whole panel is stale only when every check is')
})

// ===========================================================================
// delete-tests-bulk — deleting a test stops the work it had queued
// ===========================================================================

test('deleting a test removes every child row and stops the seed sends it had queued', async () => {
  const scoped = seedUser(db, 'bulk-del@delivery2.test')
  const box = seedMailbox(db, scoped.id, 'bulk-del-mb@example.com')
  const c = await mount(register, scoped)
  try {
    const t = await makeManualTest(c, box, {
      seedEmails: ['queued.one@inbox.test', 'queued.two@inbox.test'],
    })
    report(t.id, 'ips', [{ ip: '203.0.113.1' }])
    db.prepare("INSERT INTO deliverability_blacklist (test_id, kind, value, provider, listed) VALUES (?, 'ip', '203.0.113.1', 'Spamhaus', 1)").run(t.id)

    const pending = db.prepare(
      "SELECT COUNT(*) n FROM deliverability_test_senders WHERE test_id = ? AND send_status = 'pending'"
    ).get(t.id).n
    assert.equal(pending, 2, 'two real sends are queued and a tick would make them')

    const res = await c.post('/api/deliverability/tests/delete', { testIds: [t.id] })
    assert.equal(res.status, 200)
    assert.equal(res.body.deleted, 1, 'the count reported is the count of rows actually removed')
    assert.ok(res.body.cachedReportRowsRemoved >= 5)

    for (const table of ['deliverability_reports', 'deliverability_blacklist', 'deliverability_test_senders', 'deliverability_test_runs']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE test_id = ?`).get(t.id).n, 0,
        `${table} left an orphan`)
    }

    // The point of the deletion, rather than the report of it: the queued work
    // does not happen afterwards.
    await jobs.dispatchSeedSends()
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM messages WHERE to_email IN ('queued.one@inbox.test','queued.two@inbox.test')").get().n,
      0, 'a deleted test sends nothing')
    assert.equal(db.prepare('SELECT sent_today FROM mailboxes WHERE id = ?').get(box.id).sent_today, 0,
      'and consumes none of the mailbox allowance')
  } finally {
    await c.close()
  }
})
