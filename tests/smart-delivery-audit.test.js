// Smart delivery — the audit pass over Docs/smart-delivery/*.md.
//
// tests/parity-deliverability.test.js already covers the surface: every route
// answers, every 404 is silent, every validation names its field. This file is
// about the acceptance criteria underneath that — the ones a route can answer
// 200 to while doing nothing.
//
// Same conditions as the parity suite: NO deliverability provider is
// configured, so nothing here opens a socket. The store functions the
// reconciler calls are exercised directly, because "what happens when a
// listing arrives" is a question about Harry's own rows, not about the
// network.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedMailbox, mount } from './helpers/parity-harness.js'

setup('smart-delivery-audit')       // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register, storeBlacklist, storeAuthReport, normaliseBlacklistRows } =
  await import('../server/parity/deliverability.js')
const jobs = await import('../server/deliverability-runs.js')

const owner = seedUser(db, 'owner@delivery.test')
const client = await mount(register, owner)
const mailbox = seedMailbox(db, owner.id, 'sender@example.com')

// A playbook with one of each node type, so "is this a Send: step?" can be
// asked of a step that exists but is the wrong kind.
const campaign = db.prepare(
  "INSERT INTO campaigns (user_id, name, status, mermaid) VALUES (?, 'Playbook campaign', 'draft', ?) RETURNING *"
).get(owner.id, [
  'flowchart TD',
  '  S([Start]) --> A[Send: intro]',
  '  A --> W[Wait: 2 days]',
  '  W --> D{Replied?}',
  '  D --> E([Won])',
].join('\n'))

test.after(async () => { await client.close() })

// --- helpers ---------------------------------------------------------------

let seq = 0
async function makeManualTest(c = client, mb = mailbox, extra = {}) {
  seq += 1
  const res = await c.post('/api/deliverability/tests/manual', {
    name: `Audit manual ${seq}`,
    mailboxIds: [mb.id],
    ...extra,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

// A recurring test — the only kind with a schedule the runner will open.
async function makeAutomatedTest(c = client, mb = mailbox, extra = {}) {
  seq += 1
  const res = await c.post('/api/deliverability/tests/schedule', {
    name: `Audit automated ${seq}`,
    mailboxIds: [mb.id],
    scheduleStartTime: new Date(Date.now() + 3600_000).toISOString(),
    everyDays: 7,
    ...extra,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()
const countTests = () => db.prepare('SELECT COUNT(*) n FROM deliverability_tests').get().n

// Incidents raised for one test, found by the id every detail line carries.
function incidentsFor(testId) {
  return db.prepare(
    "SELECT detail FROM events WHERE user_id = ? AND type = 'needs_attention' AND detail LIKE ? ORDER BY id"
  ).all(owner.id, `%(#${testId})%`).map((r) => r.detail)
}

function report(testId, kind, payload, runNo = 1) {
  db.prepare(
    'INSERT INTO deliverability_reports (test_id, run_no, kind, ref, payload) VALUES (?, ?, ?, \'\', ?) ' +
    'ON CONFLICT (test_id, run_no, kind, ref) DO UPDATE SET payload = excluded.payload'
  ).run(testId, runNo, kind, JSON.stringify(payload))
}

// ===========================================================================
// create-manual-test / create-automated-test
// ===========================================================================

test('a sequenceStepId that is not a Send: step in that campaign is refused, and nothing is created', async () => {
  const before = countTests()

  // "the campaign or sequence_mapping_id does not belong to my workspace →
  // 404 and nothing is scheduled". A step id was previously stored without
  // ever being looked at.
  const unknown = await client.post('/api/deliverability/tests/manual', {
    name: 'Bogus step', mailboxIds: [mailbox.id], campaignId: campaign.id, sequenceStepId: 'ZZ',
  })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error, 'not_found')

  // A step that exists but is the wrong kind: the seed is composed from a
  // Send: step, so a Wait or a decision cannot produce the tested email.
  for (const stepId of ['W', 'D']) {
    const wrongKind = await client.post('/api/deliverability/tests/manual', {
      name: `Wrong kind ${stepId}`, mailboxIds: [mailbox.id], campaignId: campaign.id, sequenceStepId: stepId,
    })
    assert.equal(wrongKind.status, 422, stepId)
    assert.equal(wrongKind.body.field, 'sequenceStepId')
    assert.match(wrongKind.body.message, /Send: step/)
  }

  // The schedule route shares the same input reader, so it refuses identically.
  const scheduled = await client.post('/api/deliverability/tests/schedule', {
    name: 'Bogus step on a schedule',
    campaignId: campaign.id,
    sequenceStepId: 'ZZ',
    scheduleStartTime: iso(3600_000),
    everyDays: 7,
  })
  assert.equal(scheduled.status, 404)

  assert.equal(countTests(), before, 'not one of the four refusals wrote a row')

  // And the real Send: step is accepted and survives into the setup cache the
  // runner reads when it composes the seed.
  const ok = await makeManualTest(client, mailbox, { campaignId: campaign.id, sequenceStepId: 'A' })
  const setup = JSON.parse(db.prepare(
    "SELECT payload FROM deliverability_reports WHERE test_id = ? AND kind = 'setup'"
  ).get(ok.id).payload)
  assert.equal(setup.sequenceStepId, 'A')
  assert.equal(setup.campaignId, campaign.id)
})

test('a schedule with seed inboxes but no mailbox says it will send nothing, and sends nothing', async () => {
  const scoped = seedUser(db, 'no-mailbox@delivery.test')
  const c = await mount(register, scoped)
  try {
    const res = await c.post('/api/deliverability/tests/schedule', {
      name: 'Seeds with nowhere to send from',
      scheduleStartTime: iso(-60_000),
      everyDays: 7,
      seedEmails: ['nowhere@inbox.test'],
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))

    // A run row is one per (mailbox × seed inbox). With no mailbox that is
    // zero, however many seed inboxes are named — the note used to count
    // `mailboxIds.length || 1` and promise a send no run could make.
    assert.equal(res.body.awaitingSeeds, true)
    assert.match(res.body.nextRunNote, /mailboxIds/)
    assert.equal(/sends 1 seed/.test(res.body.nextRunNote), false, 'no count is promised')

    await jobs.openDueRuns()

    assert.equal(
      db.prepare('SELECT current_run_no FROM deliverability_tests WHERE id = ?').get(res.body.id).current_run_no, 1,
      'the run still opens — the schedule is real, it just has nothing to send'
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM deliverability_test_senders WHERE test_id = ?').get(res.body.id).n, 0,
      'no mailbox, so no (mailbox × seed) row exists for anything to send'
    )
    // The run's own status string has to agree with that emptiness. It was
    // decided from `runStatusFor(seedEmails.length)` before `createRunSenders`
    // reported back, so a run holding no senders was still labelled `running` —
    // a history view would tell the user their test was in flight when nothing
    // could ever happen. The status is now settled against what was queued.
    const run = db.prepare(
      'SELECT status FROM deliverability_test_runs WHERE test_id = ? ORDER BY run_no DESC LIMIT 1'
    ).get(res.body.id)
    assert.ok(run, 'a run row exists')
    assert.notEqual(run.status, 'running', 'and it does not claim to be running')

    await jobs.dispatchSeedSends()
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM messages WHERE to_email = 'nowhere@inbox.test'").get().n, 0
    )
  } finally {
    await c.close()
  }
})

// ===========================================================================
// stop-automated-test
// ===========================================================================

test('stopping keeps the schedule readable — only the status moves', async () => {
  const start = iso(3600_000)
  const created = (await client.post('/api/deliverability/tests/schedule', {
    name: 'Still legible once stopped',
    mailboxIds: [mailbox.id],
    scheduleStartTime: start,
    testEndDate: iso(30 * 86400_000),
    everyDays: 7,
  })).body

  const stop = await client.put(`/api/deliverability/tests/${created.id}/stop`)
  assert.equal(stop.status, 200)
  assert.equal(stop.body.status, 'stopped')

  // The row used to have `schedule_start_time` blanked at the same time, which
  // stopped nothing (openDueRuns selects on status) and erased when the
  // schedule had run from. A stopped test the list cannot describe is not the
  // "shows it as stopped rather than removing it" the spec asks for.
  const row = db.prepare('SELECT * FROM deliverability_tests WHERE id = ?').get(created.id)
  assert.equal(row.status, 'stopped')
  assert.equal(row.schedule_start_time, start)
  assert.equal(row.every_days, 7)

  const detail = await client.get(`/api/deliverability/tests/${created.id}`)
  assert.equal(detail.body.scheduleStartTime, start)
  assert.equal(detail.body.everyDays, 7)
  assert.match(detail.body.schedulerCronValue, /^\d+ \d+ \* \* \d$/, 'the cadence still renders')

  const listed = (await client.get('/api/deliverability/tests?limit=200')).body.items.find((t) => t.id === created.id)
  assert.equal(listed.status, 'stopped')
  assert.equal(listed.scheduleStartTime, start)
})

test('a stopped schedule opens no further run, sends no seed and consumes no allowance', async () => {
  const scoped = seedUser(db, 'stopped@delivery.test')
  const box = seedMailbox(db, scoped.id, 'stopped-mb@example.com')
  const c = await mount(register, scoped)
  try {
    const created = (await c.post('/api/deliverability/tests/schedule', {
      name: 'Stopped before it sent',
      mailboxIds: [box.id],
      scheduleStartTime: iso(-60_000),
      everyDays: 1,
      seedEmails: ['stopped-seed@inbox.test'],
    })).body

    await jobs.openDueRuns()
    const pending = db.prepare('SELECT * FROM deliverability_test_senders WHERE test_id = ?').all(created.id)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].send_status, 'pending', 'a real send is queued and waiting')

    assert.equal((await c.put(`/api/deliverability/tests/${created.id}/stop`)).status, 200)

    // The seed row is still there — stopping deletes nothing — but the tick
    // will not pick it up, which is the whole point of stopping: the daily
    // allowance stops being eaten.
    await jobs.dispatchSeedSends()
    await jobs.openDueRuns()

    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE to_email = 'stopped-seed@inbox.test'").get().n, 0)
    assert.equal(db.prepare('SELECT sent_today FROM mailboxes WHERE id = ?').get(box.id).sent_today, 0)
    assert.equal(
      db.prepare('SELECT send_status FROM deliverability_test_senders WHERE test_id = ?').get(created.id).send_status,
      'pending', 'the queued row is kept, not failed — the schedule was stopped, the send did not fail'
    )
    assert.equal(db.prepare('SELECT current_run_no FROM deliverability_tests WHERE id = ?').get(created.id).current_run_no, 1,
      'no further run was opened')
  } finally {
    await c.close()
  }
})

// ===========================================================================
// blacklists / ip-blacklist-count / domain-blacklist — the incident feed
// ===========================================================================

test('a new blocklist listing raises exactly one incident, and polling it raises none', async () => {
  const t = await makeManualTest()
  const listedAndClear = [
    { ip: '203.0.113.9', blacklist_type_value: 'Spamhaus', total_blacklist: 1 },
    { ip: '203.0.113.9', blacklist_type_value: 'Barracuda', total_blacklist: 0 },
  ]

  assert.equal(storeBlacklist(owner.id, t, 'ip', listedAndClear), 1, 'one listing, one incident')
  const first = incidentsFor(t.id)
  assert.equal(first.length, 1)
  assert.match(first[0], /203\.0\.113\.9/, 'the incident names the IP')
  assert.match(first[0], /Spamhaus/, 'and the blocklist')

  // The Monitoring incident feed reads events of this type; a listing that has
  // not moved must not appear again on the next fetch.
  assert.equal(storeBlacklist(owner.id, t, 'ip', listedAndClear), 0)
  assert.equal(storeBlacklist(owner.id, t, 'ip', listedAndClear), 0)
  assert.equal(incidentsFor(t.id).length, 1, 'one incident, not one per poll')

  // A second IP appearing is news.
  const withSecond = [...listedAndClear, { ip: '198.51.100.4', blacklist_type_value: 'Spamhaus', total_blacklist: 2 }]
  assert.equal(storeBlacklist(owner.id, t, 'ip', withSecond), 1)
  const both = incidentsFor(t.id)
  assert.equal(both.length, 2)
  assert.match(both[1], /198\.51\.100\.4/)

  // The count the list, the batch and the detail all read comes from the rows
  // that were just written — nothing caches an integer.
  const detail = await client.get(`/api/deliverability/tests/${t.id}/blacklist`)
  assert.equal(detail.body.totalBlacklist, 2)
  assert.equal(detail.body.state, 'listed')
  assert.equal(detail.body.groups.length, 2, 'grouped by IP')
  const batched = await client.get(`/api/deliverability/tests/blacklist-summary?testIds=${t.id}`)
  assert.deepEqual(batched.body.items, [{ testId: t.id, totalBlacklist: 2, state: 'listed' }])

  // Clearing is good news, and good news is not an incident.
  assert.equal(storeBlacklist(owner.id, t, 'ip', [{ ip: '203.0.113.9', blacklist_type_value: 'Spamhaus', total_blacklist: 0 }]), 0)
  assert.equal(incidentsFor(t.id).length, 2)
  const cleared = await client.get(`/api/deliverability/tests/${t.id}/blacklist`)
  assert.equal(cleared.body.totalBlacklist, 0)
  assert.equal(cleared.body.state, 'clear', 'checked and clean is not the same as never checked')
})

test('the documented domain-blacklist group shape stores rows rather than nothing', async () => {
  const t = await makeManualTest()

  // One group per from_email carrying seed_accounts, which is what the page
  // documents. The reader only understood a flat array, so a blocklisted
  // domain stored zero rows and read back as "pending" — never checked.
  const raised = storeBlacklist(owner.id, t, 'domain', [{
    from_email: 'sender@example.com',
    seed_accounts: [
      { id: 1, email: 'seed@gmail.test', esp: 'Gmail', domain_blacklisted: true },
      { id: 2, email: 'seed@outlook.test', esp: 'Outlook', domain_blacklisted: false },
    ],
  }])
  assert.equal(raised, 1)

  const rows = db.prepare("SELECT * FROM deliverability_blacklist WHERE test_id = ? AND kind = 'domain' ORDER BY provider").all(t.id)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.value), ['example.com', 'example.com'], 'the domain is derived from the group, once')
  assert.deepEqual(rows.map((r) => [r.provider, r.listed]), [['Gmail', 1], ['Outlook', 0]])

  const res = await client.get(`/api/deliverability/tests/${t.id}/domain-blacklist`)
  assert.equal(res.status, 200)
  assert.equal(res.body.state, 'listed')
  assert.equal(res.body.totalBlacklist, 1)
  assert.equal(res.body.groups.length, 1, 'rolled up to the domain')
  assert.equal(res.body.groups[0].domain, 'example.com')
  assert.equal(res.body.groups[0].blacklisted, true)
  assert.deepEqual(res.body.groups[0].listings.map((l) => l.provider), ['Gmail', 'Outlook'],
    'the observing provider is named per listing')

  assert.match(incidentsFor(t.id)[0], /example\.com/)

  // The flat shape the reader already understood still works, so accepting the
  // documented one costs nothing.
  storeBlacklist(owner.id, t, 'domain', [{ domain: 'other.test', provider: 'SURBL', blacklisted: false }])
  const flat = await client.get(`/api/deliverability/tests/${t.id}/domain-blacklist`)
  assert.equal(flat.body.state, 'clear')
  assert.deepEqual(flat.body.groups.map((g) => g.domain), ['other.test'])
})

test('the blocklist normaliser reads both published shapes and guesses at neither', () => {
  assert.deepEqual(
    normaliseBlacklistRows('ip', [{ ip: '203.0.113.1', blacklist_type_value: 'Spamhaus', total_blacklist: 3 }]),
    [{ value: '203.0.113.1', provider: 'Spamhaus', listed: 1 }],
  )
  assert.deepEqual(normaliseBlacklistRows('ip', null), [])
  assert.deepEqual(normaliseBlacklistRows('ip', { data: [] }), [])
  assert.deepEqual(
    normaliseBlacklistRows('domain', [{ from_email: 'a@b.test', seed_accounts: [{ esp: 'Gmail' }] }]),
    [{ value: 'b.test', provider: 'Gmail', listed: 0 }],
    'a seed with no verdict is not listed, and is not invented as listed either',
  )
})

// ===========================================================================
// dkim-details / spf-details / rdns-report
// ===========================================================================

test('an authentication report is graded per seed, and an unreadable check is never a pass', async () => {
  const t = await makeManualTest()
  report(t.id, 'dkim', {
    groups: [{
      from_email: 'Sender@Example.com',
      seed_accounts: [
        { id: 's1', email: 'seed@gmail.test', esp: 'Gmail', dkim_verified: true },
        { id: 's2', email: 'seed@outlook.test', esp: 'Outlook', dkim_verified: false },
        { id: 's3', email: 'seed@yahoo.test', esp: 'Yahoo' },
      ],
    }],
  })

  const res = await client.get(`/api/deliverability/tests/${t.id}/dkim`)
  assert.equal(res.status, 200)
  const group = res.body.groups[0]

  assert.equal(group.fromEmail, 'sender@example.com')
  assert.equal(group.seeds.length, 3, 'the documented seed_accounts array is read, not dropped')
  assert.deepEqual(group.seeds.map((s) => s.verified), [true, false, null])
  assert.deepEqual(group.seeds.map((s) => s.status), ['pass', 'fail', null])
  assert.deepEqual(group.esps, ['Gmail', 'Outlook', 'Yahoo'], 'the esp values are named')

  // Not averaged into a rate: the failing seed is named.
  assert.deepEqual(group.failing, [{ email: 'seed@outlook.test', esp: 'Outlook' }])
  assert.equal(group.verdict, 'failing')
  assert.equal(group.passingCount, 1)
  assert.equal(group.failingCount, 1)
  assert.equal(group.unknownCount, 1, 'a seed with no readable verdict counts as unknown, never as a pass')
  assert.deepEqual(res.body.failingAddresses, ['sender@example.com'])
})

test('each sending address is graded on its own, because one can pass while another fails', async () => {
  const t = await makeManualTest()
  report(t.id, 'spf', {
    groups: [
      { from_email: 'good@example.com', seed_accounts: [{ esp: 'Gmail', spf_verified: true }, { esp: 'Outlook', spf_verified: true }] },
      { from_email: 'bad@example.com', seed_accounts: [{ esp: 'Gmail', spf_verified: true }, { esp: 'Outlook', spf_verified: false }] },
    ],
  })

  const res = await client.get(`/api/deliverability/tests/${t.id}/spf`)
  assert.deepEqual(res.body.groups.map((g) => g.verdict), ['passing', 'failing'])
  assert.deepEqual(res.body.failingAddresses, ['bad@example.com'])
  // SPF passing at one provider and failing at another for the same address is
  // the alignment pattern the spec asks to be shown side by side, not summed.
  assert.deepEqual(res.body.groups[1].seeds.map((s) => [s.esp, s.status]), [['Gmail', 'pass'], ['Outlook', 'fail']])
})

test('the combined authentication read gives all three checks one shape', async () => {
  const t = await makeManualTest()
  report(t.id, 'dkim', { groups: [{ from_email: 'a@example.com', seed_accounts: [{ esp: 'Gmail', dkim_verified: false }] }] })
  report(t.id, 'rdns', { groups: [{ from_email: 'a@example.com', seed_accounts: [{ esp: 'Gmail', rdns_verified: true }] }] })

  const res = await client.get(`/api/deliverability/tests/${t.id}/authentication`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.checks.map((c) => c.check), ['dkim', 'spf', 'rdns'])

  const [dkim, spf, rdns] = res.body.checks
  assert.deepEqual(dkim.failingAddresses, ['a@example.com'])
  assert.equal(dkim.groups[0].verdict, 'failing')
  assert.equal(spf.available, false, 'a check nothing has fetched is not a pass either')
  assert.deepEqual(spf.groups, [])
  assert.equal(rdns.groups[0].verdict, 'passing')
  assert.deepEqual(rdns.failingAddresses, [])
})

test('an authentication failure raises one incident per address and provider, on the transition', async () => {
  const t = await makeManualTest()
  const failingAtGmail = [{ from_email: 'a@example.com', seed_accounts: [{ esp: 'Gmail', spf_verified: false }] }]

  storeAuthReport(owner.id, t, 1, 'spf', 'spf', failingAtGmail)
  const first = incidentsFor(t.id)
  assert.equal(first.length, 1)
  assert.match(first[0], /SPF failed for a@example\.com at Gmail/)

  storeAuthReport(owner.id, t, 1, 'spf', 'spf', failingAtGmail)
  assert.equal(incidentsFor(t.id).length, 1, 'the same failure on the next fetch is not news')

  storeAuthReport(owner.id, t, 1, 'spf', 'spf', [{
    from_email: 'a@example.com',
    seed_accounts: [{ esp: 'Gmail', spf_verified: false }, { esp: 'Outlook', spf_verified: false }],
  }])
  const second = incidentsFor(t.id)
  assert.equal(second.length, 2)
  assert.match(second[1], /at Outlook/)

  // Fixing one and leaving the other raises nothing: only new trouble does.
  storeAuthReport(owner.id, t, 1, 'spf', 'spf', [{
    from_email: 'a@example.com',
    seed_accounts: [{ esp: 'Gmail', spf_verified: true }, { esp: 'Outlook', spf_verified: false }],
  }])
  assert.equal(incidentsFor(t.id).length, 2)

  // Each check is its own incident: a DKIM failure is not the SPF one again.
  storeAuthReport(owner.id, t, 1, 'dkim', 'dkim', [{ from_email: 'a@example.com', seed_accounts: [{ esp: 'Gmail', dkim_verified: false }] }])
  const withDkim = incidentsFor(t.id)
  assert.equal(withDkim.length, 3)
  assert.match(withDkim[2], /^.*DKIM failed for a@example\.com at Gmail$/)
})

// ===========================================================================
// schedule-history
// ===========================================================================

test('the run trend compares only completed runs measured over the same window', async () => {
  const t = await makeManualTest()
  const put = (runNo, status, metrics) => db.prepare(
    `INSERT INTO deliverability_test_runs (test_id, run_no, status, metrics) VALUES (?, ?, ?, ?)
     ON CONFLICT (test_id, run_no) DO UPDATE SET status = excluded.status, metrics = excluded.metrics`
  ).run(t.id, runNo, status, JSON.stringify(metrics))

  put(1, 'completed', { inboxCount: 100, adjustedTotalEmailCount: 100, replyWindowEndHour: 1 })
  put(2, 'completed', { inboxCount: 184, adjustedTotalEmailCount: 200, replyWindowEndHour: 24 })
  put(3, 'completed', { inboxCount: 180, adjustedTotalEmailCount: 200, replyWindowEndHour: 24 })
  put(4, 'running', { inboxCount: 5, adjustedTotalEmailCount: 0, replyWindowEndHour: 24 })

  const res = await client.get(`/api/deliverability/tests/${t.id}/history`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.runs.map((r) => r.runNo), [4, 3, 2, 1], 'most recent run first')

  const byNo = new Map(res.body.runs.map((r) => [r.runNo, r]))
  assert.equal(byNo.get(3).inboxRate, 0.9, '180 of 200 is derived per run')
  assert.equal(byNo.get(2).inboxRate, 0.92)
  assert.equal(byNo.get(4).partial, true)
  assert.equal(byNo.get(4).inboxRate, null,
    'a run nothing has graded has no rate — it must not be plotted as 0%')

  assert.equal(res.body.trendPoints, -2, 'down 2 points across the last two comparable runs')
  assert.deepEqual(res.body.trendBasis, [3, 2],
    'run 1 was measured over a different window and run 4 is not finished')
})

test('a manual test with one run shows it without inventing a trend', async () => {
  const t = await makeManualTest()
  const res = await client.get(`/api/deliverability/tests/${t.id}/history`)
  assert.equal(res.body.runs.length, 1)
  assert.equal(res.body.trendPoints, null)
  assert.deepEqual(res.body.trendBasis, [])
  assert.equal(res.body.total, 1)
})

// ===========================================================================
// mailbox-count / mailbox-summary
// ===========================================================================

test('the inbox rate is derived once and is absent when nothing has been delivered', async () => {
  const empty = await makeManualTest()
  report(empty.id, 'counts', { inboxCount: 0, spamCount: 0, tabCount: 0, failedCount: 0, totalEmailCount: 0 })
  const none = await client.get(`/api/deliverability/tests/${empty.id}/counts`)
  assert.equal(none.body.inboxRate, null, 'no percentage is calculated from nothing')
  assert.equal(none.body.belowBenchmark, false, 'and "no results yet" is not a failing grade')

  const weak = await makeManualTest()
  report(weak.id, 'counts', { inboxCount: 100, spamCount: 60, tabCount: 20, failedCount: 10, totalEmailCount: 200 })
  const res = await client.get(`/api/deliverability/tests/${weak.id}/counts`)
  assert.equal(res.body.inboxRate, 0.5)
  assert.equal(res.body.belowBenchmark, true)
  assert.equal(res.body.benchmark, 0.8)
  assert.equal(res.body.tabCount, 20, 'a Promotions tab is its own state')
  assert.equal(res.body.failedCount, 10, 'a failure is not a spam placement')
  assert.equal(res.body.notYetDelivered, 10, 'the difference is shown, not hidden')
})

test('per-mailbox results are matched to connected mailboxes, and an unmatched address still renders', async () => {
  const t = await makeManualTest()
  report(t.id, 'mailboxes', [
    { from_email: 'Sender@Example.com', esp: 'Gmail', total_email_count: 100, inbox_count: 90, tab_count: 4, spam_count: 4, failed_count: 2, placement_score: 90 },
    { from_email: 'Sender@Example.com', esp: 'Outlook', total_email_count: 100, inbox_count: 60, spam_count: 40, placement_score: 60 },
    { from_email: 'nobody@elsewhere.test', esp: 'Gmail', total_email_count: 50, inbox_count: 25 },
  ])

  const res = await client.get(`/api/deliverability/tests/${t.id}/mailboxes`)
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 3)

  const [gmail, outlook, stranger] = res.body.items
  assert.equal(gmail.matched, true)
  assert.equal(gmail.mailboxId, mailbox.id)
  assert.equal(gmail.inboxRate, 0.9)
  assert.equal(outlook.inboxRate, 0.6, 'the same address is graded per receiving provider')
  assert.equal(outlook.mailboxId, mailbox.id)
  assert.equal(stranger.matched, false)
  assert.equal(stranger.mailboxId, null, 'an address that is not connected here is shown, not omitted')
  assert.equal(res.body.unmatched, 1)
})

// ===========================================================================
// provider-report / geo-report
// ===========================================================================

test('provider and region rollups are labelled partial until the test completes, and rates are served as given', async () => {
  const t = await makeManualTest()
  const payload = {
    overallTotalCount: 300,
    status: 'running',
    result: [
      { provider: 'Gmail', inbox_rate: 0.92, spam_rate: 0.05, bounce_rate: 0.01, mailbox_count: 120, avg_delivery_time_seconds: 45 },
      { provider: 'Outlook', inbox_rate: 0.55, spam_rate: 0.4, bounce_rate: 0.02, mailbox_count: 2 },
    ],
  }
  report(t.id, 'providers', payload)

  const running = await client.get(`/api/deliverability/tests/${t.id}/providers`)
  assert.equal(running.body.partial, true, 'a test that has not finished reports partial figures')
  assert.equal(running.body.status, 'running')
  assert.equal(running.body.overallTotalCount, 300)
  assert.equal(running.body.result[0].inboxRate, 0.92, 'the rate is served as given, never recomputed')
  assert.equal(running.body.result[1].mailboxCount, 2, 'the sample size travels with the rate')
  assert.equal(running.body.result[1].avgDeliveryTimeSeconds, null, 'a missing figure is null, not zero')
  assert.deepEqual(running.body.belowBenchmark, ['Outlook'])

  report(t.id, 'providers', { ...payload, status: 'completed' })
  const done = await client.get(`/api/deliverability/tests/${t.id}/providers`)
  assert.equal(done.body.partial, false)

  // The geo report is the same shape through the same code, keyed on region.
  report(t.id, 'regions', {
    overallTotalCount: 300,
    status: 'completed',
    result: [{ region: 'North America', inbox_rate: 0.9, mailbox_count: 200 }, { region: 'Asia Pacific', inbox_rate: 0.7, mailbox_count: 100 }],
  })
  const geo = await client.get(`/api/deliverability/tests/${t.id}/regions`)
  assert.deepEqual(geo.body.result.map((r) => r.region), ['North America', 'Asia Pacific'])
  assert.deepEqual(geo.body.belowBenchmark, ['Asia Pacific'])
  assert.equal(geo.body.partial, false)
})

// ===========================================================================
// sender-list
// ===========================================================================

test('the sender list separates "waiting to be sent" from "sent, nowhere reported" from "misconfigured"', async () => {
  const t = await makeManualTest(client, mailbox, { seedEmails: ['a@inbox.test', 'b@inbox.test'] })
  const rows = db.prepare('SELECT id FROM deliverability_test_senders WHERE test_id = ? ORDER BY id').all(t.id)
  assert.equal(rows.length, 2)

  db.prepare("UPDATE deliverability_test_senders SET send_status = 'sent' WHERE id = ?").run(rows[0].id)
  db.prepare("UPDATE deliverability_test_senders SET send_status = 'sent', placement = 'inbox' WHERE id = ?").run(rows[1].id)

  const res = await client.get(`/api/deliverability/tests/${t.id}/senders`)
  assert.equal(res.status, 200)
  assert.equal(res.body.awaitingPlacement, 1, 'sent, but nobody has reported a folder')
  assert.equal(res.body.awaitingSeeds, 0)
  assert.equal(res.body.misconfigured, false)
  assert.equal(res.body.placementSource, 'none', 'with no provider, nothing can report a folder')
  assert.deepEqual(res.body.items.map((i) => i.seedEmail).sort(), ['a@inbox.test', 'b@inbox.test'],
    'the destination is half of a placement result')
  assert.equal(res.body.items.every((i) => i.mailboxConnected), true)
  const serialised = JSON.stringify(res.body)
  assert.equal(serialised.includes('client_id') || serialised.includes('user_id'), false)

  // A test whose senders have gone is a misconfiguration, not a clean result.
  db.prepare('DELETE FROM deliverability_test_senders WHERE test_id = ?').run(t.id)
  const empty = await client.get(`/api/deliverability/tests/${t.id}/senders`)
  assert.equal(empty.body.misconfigured, true)
  assert.deepEqual(empty.body.items, [])
})

// ===========================================================================
// folders and the list
// ===========================================================================

test('a whitespace-only folder name is refused, and a created folder is on the activity trail', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM deliverability_folders').get().n
  const blank = await client.post('/api/deliverability/folders', { name: '   ' })
  assert.equal(blank.status, 422)
  assert.equal(blank.body.field, 'name')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_folders').get().n, before)

  const made = await client.post('/api/deliverability/folders', { name: 'Audit filing' })
  assert.equal(made.status, 200)
  const trail = db.prepare(
    "SELECT detail FROM events WHERE user_id = ? AND type = 'deliverability_folder_created' AND detail LIKE '%Audit filing%'"
  ).all(owner.id)
  assert.equal(trail.length, 1, 'who created it and its name')
  assert.match(trail[0].detail, new RegExp(`#${made.body.id}`))
})

test('a folder\'s test count follows the tests actually in it', async () => {
  const scoped = seedUser(db, 'folders@delivery.test')
  const box = seedMailbox(db, scoped.id, 'folders-mb@example.com')
  const c = await mount(register, scoped)
  try {
    const folder = (await c.post('/api/deliverability/folders', { name: 'Counted' })).body
    assert.equal(folder.testCount, 0, 'an empty folder is distinguishable from a missing one')

    const filed = await makeManualTest(c, box, { folderId: folder.id })
    const gone = await makeManualTest(c, box, { folderId: folder.id })
    db.prepare("UPDATE deliverability_tests SET deleted_at = datetime('now') WHERE id = ?").run(gone.id)

    const one = await c.get(`/api/deliverability/folders/${folder.id}`)
    assert.equal(one.body.testCount, 1, 'a deleted test is not still filed')

    const list = await c.get('/api/deliverability/folders')
    assert.equal(list.body.items.find((f) => f.id === folder.id).testCount, 1,
      'the list and the detail count the same rows')

    // The list filtered to that folder agrees with the count.
    const tests = await c.get(`/api/deliverability/tests?folderId=${folder.id}`)
    assert.deepEqual(tests.body.items.map((t) => t.id), [filed.id])
  } finally {
    await c.close()
  }
})

test('a test outlives the folder it was filed in', async () => {
  const folder = (await client.post('/api/deliverability/folders', { name: 'Vanishing' })).body
  const t = await makeManualTest(client, mailbox, { folderId: folder.id })

  // Not through the route — the route unfiles first and refuses until that is
  // confirmed. This is the row going out from under the test.
  db.prepare('DELETE FROM deliverability_folders WHERE id = ?').run(folder.id)

  // `folder_id REFERENCES deliverability_folders(id) ON DELETE SET NULL` means
  // there is no dangling id to explain: the test simply becomes unfiled, and
  // the result is kept either way. (The route's `folderUnavailableReason` is
  // therefore unreachable while foreign keys are enforced — it is the belt to
  // that braces, not a state this database can produce.)
  assert.equal(db.prepare('SELECT folder_id FROM deliverability_tests WHERE id = ?').get(t.id).folder_id, null)

  const detail = await client.get(`/api/deliverability/tests/${t.id}`)
  assert.equal(detail.status, 200, 'the test still opens')
  assert.equal(detail.body.folderId, null)
  assert.equal(detail.body.folderName, null)
  assert.equal(detail.body.folderUnavailableReason, null)
  assert.equal(detail.body.name, t.name, 'and is otherwise untouched')
})

test('the list searches by name inside the workspace and pages what it finds', async () => {
  const scoped = seedUser(db, 'search@delivery.test')
  const box = seedMailbox(db, scoped.id, 'search-mb@example.com')
  const c = await mount(register, scoped)
  try {
    const hit = await makeManualTest(c, box, { name: 'Gmail placement check' })
    await makeManualTest(c, box, { name: 'Outlook placement check' })
    await makeManualTest(c, box, { name: 'Yahoo placement check' })

    const q = await c.get('/api/deliverability/tests?q=GMAIL')
    assert.equal(q.status, 200)
    assert.deepEqual(q.body.items.map((t) => t.id), [hit.id], 'case-insensitive substring on the name')
    assert.equal(q.body.total, 1, 'the total is the filtered total, not the workspace total')

    const all = await c.get('/api/deliverability/tests?limit=2')
    assert.equal(all.body.total, 3)
    assert.equal(all.body.hasMore, true)
    assert.equal(all.body.activeCount, 3)
    assert.equal(all.body.servedFrom, 'local')

    const none = await c.get('/api/deliverability/tests?q=nothing-matches-this')
    assert.deepEqual(none.body.items, [])
    assert.equal(none.body.total, 0)
    assert.equal(none.body.hasMore, false)
  } finally {
    await c.close()
  }
})

// ===========================================================================
// provider-ids
// ===========================================================================

test('the provider list publishes how much of this category is built on unpublished shapes', async () => {
  const res = await client.get('/api/deliverability/providers')
  assert.equal(res.status, 200)
  assert.equal(res.body.contracts.unverified, 9)
  assert.equal(res.body.contracts.entries.length, 9)
  for (const entry of res.body.contracts.entries) {
    assert.ok(entry.key, 'each entry names the endpoint it is about')
    assert.ok(entry.method, 'and the method it sends')
  }
  // A test with no seeds proves nothing, so creation is blocked rather than
  // falling back to a guessed provider id.
  assert.equal(res.body.canCreateTests, false)
  assert.equal(res.body.cached, false)
})

