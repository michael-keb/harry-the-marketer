// Analytics audit — the figures that changed and had nothing pinning them.
//
// Every case below covers a behaviour that was altered in
// server/parity/analytics.js and shipped green, because green only meant "no
// existing test touched this". A reporting defect does not throw: it answers
// 200 with the right keys and the wrong arithmetic, which is how a mailbox came
// to report 0 won / 0 lost / 0 unsubscribed for months and nobody noticed.
//
// So nothing here asserts a shape. Every fixture is seeded so the correct
// answer is a specific non-zero number, and that number is the assertion.
//
// The empty-campaign-filter rule (`campaignClause([])`) is covered in
// tests/agent-followup.test.js and is deliberately not repeated; what is here
// is the rest of the `client_ids` contract, which that file does not reach.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, mount } from './helpers/parity-harness.js'

setup('analytics-audit')                 // MUST precede any ../server import
const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/analytics.js')

// ---- fixtures ---------------------------------------------------------------

const DAY = 86_400_000
const HOUR = 3_600_000

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10)
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

// A window wide enough for everything seeded "recently", and narrow enough that
// the route's 400-day cap is never in play.
const WINDOW = `from=${dayKey(Date.now() - 7 * DAY)}&to=${dayKey(Date.now() + DAY)}`

let seq = 0

function makeMailbox(wsId, email, {
  provider = 'sandbox', dailyLimit = 100,
  warmupEnabled = 0, warmupCount = 20, autoAdjust = 1,
} = {}) {
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit,
       warmup_enabled, warmup_daily_count, warmup_auto_adjust)
     VALUES (?, ?, ?, 'connected', ?, ?, ?, ?)`
  ).run(wsId, provider, email, dailyLimit, warmupEnabled, warmupCount, autoAdjust)
  return db.prepare('SELECT id FROM mailboxes WHERE user_id = ? AND email = ?').get(wsId, email).id
}

function makeClient(wsId, name) {
  db.prepare('INSERT INTO clients (workspace_id, name) VALUES (?, ?)').run(wsId, name)
  return db.prepare('SELECT id FROM clients WHERE workspace_id = ? AND name = ?').get(wsId, name).id
}

function makeCampaign(wsId, name, { mailboxId = null, clientId = null, status = 'draft' } = {}) {
  db.prepare(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid, client_id) VALUES (?, ?, ?, ?, '', ?)"
  ).run(wsId, name, status, mailboxId, clientId)
  return db.prepare('SELECT id FROM campaigns WHERE user_id = ? AND name = ?').get(wsId, name).id
}

function makeLead(wsId, tag) {
  seq += 1
  const email = `${tag}-${seq}@acme.test`
  db.prepare('INSERT INTO leads (user_id, email) VALUES (?, ?)').run(wsId, email)
  return db.prepare('SELECT id FROM leads WHERE user_id = ? AND email = ?').get(wsId, email).id
}

function outbound(wsId, { campaignId, leadId, mailboxId = null, at, sendStatus = 'sent' }) {
  seq += 1
  return db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email,
        provider_message_id, send_status, created_at)
     VALUES (?, ?, ?, ?, 'out', 'Hello', 'Body', 'x@acme.test', ?, ?, ?)`
  ).run(wsId, campaignId, leadId, mailboxId, `out-${seq}`, sendStatus, stamp(at)).lastInsertRowid
}

function inbound(wsId, { campaignId, leadId, mailboxId = null, at, intent = '' }) {
  seq += 1
  return db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email,
        provider_message_id, intent, created_at)
     VALUES (?, ?, ?, ?, 'in', 'Re: Hello', 'Sure', 'x@acme.test', ?, ?, ?)`
  ).run(wsId, campaignId, leadId, mailboxId, `in-${seq}`, intent, stamp(at)).lastInsertRowid
}

// Sum a share column the way a reader would, without inviting float noise into
// the assertion — 33.4 + 33.3 + 33.3 is 100.00000000000001 in IEEE 754.
const sumShares = (rows) => Math.round(rows.reduce((a, r) => a + r.share, 0) * 10) / 10

// ============================================================================
// 1. Shares round so the column totals exactly 100
// ============================================================================
//
// `share` moved from a plain per-row rounding to largest remainder. The point
// is that three equal thirds read 33.3 each and a breakdown summing to 99.9
// sends the reader hunting for a missing category. The risk is the opposite: a
// distribution rule that quietly moves a share further than one rounding unit
// from its true value would be a lie told to fix a cosmetic problem.

const shareWs = seedUser(db, 'shares@example.com')
const shareClient = await mount(register, shareWs)
test.after(() => shareClient.close())

// Two windows, so two different rounding shapes can be asserted without either
// fixture contaminating the other's total.
const THIRDS_AT = Date.now() - 6 * DAY
const SIXTHS_AT = Date.now() - 20 * DAY
const THIRDS = `from=${dayKey(THIRDS_AT)}&to=${dayKey(THIRDS_AT)}`
const SIXTHS = `from=${dayKey(SIXTHS_AT)}&to=${dayKey(SIXTHS_AT)}`

test('seed two reply mixes whose raw shares do not add up', () => {
  const mb = makeMailbox(shareWs.id, 'shares@harry.test')
  const camp = makeCampaign(shareWs.id, 'Share mix', { mailboxId: mb })

  // Three categories, one reply each: 33.333% apiece, which rounds to 33.3 and
  // sums to 99.9.
  for (const intent of ['interested', 'question', 'not now']) {
    inbound(shareWs.id, { campaignId: camp, leadId: makeLead(shareWs.id, 'th'), mailboxId: mb, at: THIRDS_AT, intent })
  }

  // Six categories, one reply each: 16.667% apiece, which rounds to 16.7 and
  // sums to 100.2 — the error in the other direction.
  for (const intent of ['interested', 'question', 'not now', 'not interested', 'out of office', 'unsubscribe']) {
    inbound(shareWs.id, { campaignId: camp, leadId: makeLead(shareWs.id, 'sx'), mailboxId: mb, at: SIXTHS_AT, intent })
  }
})

test('three equal categories total exactly 100, not 99.9', async () => {
  const res = await shareClient.get(`/api/analytics/replies/by-category?${THIRDS}`)
  assert.equal(res.status, 200)
  const rows = res.body.items
  assert.equal(res.body.total_replies, 3)
  assert.equal(rows.length, 3)
  for (const row of rows) assert.equal(row.total_response, 1, 'each category has exactly one reply')

  // The whole point of the change.
  assert.equal(sumShares(rows), 100, 'the column adds up')

  // And it adds up because one row took the spare tenth, not because a share
  // was invented: two rows keep 33.3 and exactly one reads 33.4.
  const values = rows.map((r) => r.share).sort((a, b) => a - b)
  assert.deepEqual(values, [33.3, 33.3, 33.4])

  // No share moved further than one rounding unit from its true value.
  for (const row of rows) {
    assert.ok(Math.abs(row.share - 100 / 3) <= 0.1, `${row.category} share ${row.share} is within a tenth of 33.33`)
  }

  // The unrounded ratio is carried alongside. It used to be the row rounded on
  // its own — 33.3 — which made a field named `exact` the one thing in the
  // payload that was not.
  for (const row of rows) {
    assert.ok(Math.abs(row.share_exact - 100 / 3) < 1e-9, `share_exact is the true ratio, got ${row.share_exact}`)
    assert.equal(row.percentage, row.share, 'the documented spelling is the same number')
  }
  // Round each true ratio on its own, the way a naive implementation would,
  // and the column reads 99.9 — a missing category rather than rounding. That
  // is the defect the balancing exists to correct, reproduced from the exact
  // figures the payload still carries.
  assert.equal(
    Math.round(rows.reduce((a, r) => a + Math.round(r.share_exact * 10) / 10, 0) * 10) / 10, 99.9,
    'rounded row by row it adds up to 99.9',
  )
})

test('six equal categories total exactly 100, not 100.2', async () => {
  const res = await shareClient.get(`/api/analytics/replies/by-category?${SIXTHS}`)
  assert.equal(res.status, 200)
  const rows = res.body.items
  assert.equal(res.body.total_replies, 6)
  assert.equal(rows.length, 6)

  assert.equal(sumShares(rows), 100, 'rounding up six times over does not overshoot')
  assert.equal(rows.filter((r) => r.share === 16.7).length, 4)
  assert.equal(rows.filter((r) => r.share === 16.6).length, 2)
  for (const row of rows) {
    assert.equal(row.total_response, 1)
    assert.ok(Math.abs(row.share_exact - 100 / 6) < 1e-9, `share_exact is the true ratio, got ${row.share_exact}`)
    assert.ok(Math.abs(row.share - 100 / 6) <= 0.1, `${row.category} share ${row.share} stays within a tenth`)
  }
  assert.equal(
    Math.round(rows.reduce((a, r) => a + Math.round(r.share_exact * 10) / 10, 0) * 10) / 10, 100.2,
    'rounded row by row it overshoots, which is what the adjustment is for',
  )
})

// ============================================================================
// 2. Archived campaigns no longer inflate the status counts
// ============================================================================
//
// The Campaigns list hides archived campaigns. This route counted them, so the
// Dashboard tile and the page it links to disagreed by however many campaigns
// had ever been archived — and the difference grew silently over time.

const statusWs = seedUser(db, 'status@example.com')
const statusClient = await mount(register, statusWs)
test.after(() => statusClient.close())

test('seed two live campaigns and one archived', () => {
  const mb = makeMailbox(statusWs.id, 'status@harry.test')
  makeCampaign(statusWs.id, 'Status one', { mailboxId: mb })
  makeCampaign(statusWs.id, 'Status two', { mailboxId: mb })
  makeCampaign(statusWs.id, 'Status gone', { mailboxId: mb, status: 'archived' })
})

test('an archived campaign is not counted by default', async () => {
  const res = await statusClient.get('/api/analytics/campaigns/status-counts')
  assert.equal(res.status, 200)
  assert.equal(res.body.campaigns_total, 2, 'three campaigns exist; two are visible')
  assert.equal(res.body.includes_archived, false, 'the payload says which set was counted')
  assert.deepEqual(res.body.items, [{ status: 'draft', count: 2 }])
  assert.deepEqual(res.body.data.campaign_status_stats, res.body.items)
})

test('include_archived brings it back, and says so', async () => {
  const res = await statusClient.get('/api/analytics/campaigns/status-counts?include_archived=true')
  assert.equal(res.status, 200)
  assert.equal(res.body.campaigns_total, 3)
  assert.equal(res.body.includes_archived, true)
  assert.deepEqual(res.body.items, [
    { status: 'draft', count: 2 },
    { status: 'archived', count: 1 },
  ])
})

// ============================================================================
// 3. A test send does not make a client active for the month
// ============================================================================
//
// This is the one where a wrong answer bills someone for a month they did not
// use. The activity scan counted every outbound row, so pressing "send me a
// test" on a dormant account drew it a bar on the monthly chart.

const monthWs = seedUser(db, 'months@example.com')
const monthClient = await mount(register, monthWs)
test.after(() => monthClient.close())

const THIS_MONTH = new Date().toISOString().slice(0, 7)

test('seed one trading client, one that only ran a test, and one that did nothing', () => {
  const mb = makeMailbox(monthWs.id, 'months@harry.test')

  const live = makeClient(monthWs.id, 'Live Ltd')
  const liveCamp = makeCampaign(monthWs.id, 'Live work', { mailboxId: mb, clientId: live })
  outbound(monthWs.id, { campaignId: liveCamp, leadId: makeLead(monthWs.id, 'lv'), mailboxId: mb, at: Date.now() })

  // Its only outbound row is a test send — real enough to sit in the thread,
  // never outreach.
  const probe = makeClient(monthWs.id, 'Probe Ltd')
  const probeCamp = makeCampaign(monthWs.id, 'Probe work', { mailboxId: mb, clientId: probe })
  outbound(monthWs.id, {
    campaignId: probeCamp, leadId: makeLead(monthWs.id, 'pb'), mailboxId: mb,
    at: Date.now(), sendStatus: 'test',
  })

  // Campaigns, no sends at all: the other half of "activity means sends".
  const dormant = makeClient(monthWs.id, 'Dormant Ltd')
  makeCampaign(monthWs.id, 'Dormant work', { mailboxId: mb, clientId: dormant })
})

test('only the client that really sent counts as active this month', async () => {
  const res = await monthClient.get('/api/analytics/clients/monthly-active?months=24&timezone=UTC')
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 24)

  const row = res.body.items.find((m) => m.month === THIS_MONTH)
  assert.ok(row, 'the current month is in the series')
  assert.equal(row.count, 1, 'one client traded; a test send and an idle campaign are not trading')

  // Nothing was pushed into a neighbouring month either.
  const across = res.body.items.reduce((a, m) => a + m.count, 0)
  assert.equal(across, 1, 'exactly one client-month of activity in two years')
})

test('all three clients still exist — the quiet ones are absent from activity, not from the workspace', async () => {
  const res = await monthClient.get('/api/analytics/clients')
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 3)
  assert.deepEqual(res.body.items.map((c) => c.name), ['Dormant Ltd', 'Live Ltd', 'Probe Ltd'])
})

// ============================================================================
// 4. The rest of the client_ids contract
// ============================================================================

const filterWs = seedUser(db, 'filters@example.com')
const outsider = seedUser(db, 'outsider@example.com')
const filterClient = await mount(register, filterWs)
test.after(() => filterClient.close())

const scope = {}

test('seed two clients with different volumes, plus an unassigned campaign', () => {
  const mb = makeMailbox(filterWs.id, 'filters@harry.test')

  scope.alpha = makeClient(filterWs.id, 'Alpha Ltd')
  scope.beta = makeClient(filterWs.id, 'Beta Ltd')
  scope.campAlpha = makeCampaign(filterWs.id, 'Alpha run', { mailboxId: mb, clientId: scope.alpha })
  scope.campBeta = makeCampaign(filterWs.id, 'Beta run', { mailboxId: mb, clientId: scope.beta })
  scope.campNone = makeCampaign(filterWs.id, 'Unassigned run', { mailboxId: mb })

  // Five, three and two: every subset below has its own distinguishable total,
  // so a filter that silently does nothing cannot pass by coincidence.
  const at = Date.now() - 3 * DAY
  for (let i = 0; i < 5; i += 1) {
    outbound(filterWs.id, { campaignId: scope.campAlpha, leadId: makeLead(filterWs.id, 'al'), mailboxId: mb, at })
  }
  for (let i = 0; i < 3; i += 1) {
    outbound(filterWs.id, { campaignId: scope.campBeta, leadId: makeLead(filterWs.id, 'be'), mailboxId: mb, at })
  }
  for (let i = 0; i < 2; i += 1) {
    outbound(filterWs.id, { campaignId: scope.campNone, leadId: makeLead(filterWs.id, 'un'), mailboxId: mb, at })
  }

  // Another workspace's client, so "not yours" can be told from "not real".
  scope.foreign = makeClient(outsider.id, 'Foreign Ltd')
})

const sentFor = async (query) => {
  const res = await filterClient.get(`/api/analytics/overview?${WINDOW}${query}`)
  assert.equal(res.status, 200, `expected 200 for ${query}, got ${res.status}`)
  return res.body.overall_stats.sent
}

test('a client filter narrows to that client and nothing else', async () => {
  assert.equal(await sentFor(''), 10, 'five, three and two')
  assert.equal(await sentFor(`&client_ids=${scope.alpha}`), 5)
  assert.equal(await sentFor(`&client_ids=${scope.beta}`), 3)
})

test('several clients at once is their sum, and excludes the unassigned campaign', async () => {
  assert.equal(await sentFor(`&client_ids=${scope.alpha},${scope.beta}`), 8,
    'eight, not ten — the campaign with no client is not swept in')
})

test('client_ids and campaign_ids together mean the intersection, not the union', async () => {
  // The dangerous reading is the union: asking for Alpha's campaign under
  // Beta's account would answer with Alpha's numbers.
  assert.equal(await sentFor(`&client_ids=${scope.beta}&campaign_ids=${scope.campAlpha}`), 0,
    'the campaign is not that client\'s, so nothing matches')
  assert.equal(await sentFor(`&client_ids=${scope.alpha}&campaign_ids=${scope.campAlpha}`), 5,
    'and when they agree, the figures come through')
  assert.equal(await sentFor(`&client_ids=${scope.alpha},${scope.beta}&campaign_ids=${scope.campBeta}`), 3,
    'the campaign wins the narrowing when it is inside the client set')
})

test('a junk client_ids is a 422 naming the field', async () => {
  const res = await filterClient.get(`/api/analytics/overview?${WINDOW}&client_ids=1,,abc`)
  assert.equal(res.status, 422)
  assert.equal(res.body.error, 'validation_failed')
  assert.equal(res.body.field, 'client_ids')

  const negative = await filterClient.get(`/api/analytics/overview?${WINDOW}&client_ids=-1`)
  assert.equal(negative.status, 422)
  assert.equal(negative.body.field, 'client_ids')
})

test('another workspace\'s client is an empty answer, while its campaign is a 404', async () => {
  // Deliberately different, and the difference is the point: a client id is a
  // filter, and a filter that 404s tells the caller the client exists. A
  // campaign id names a record, and naming someone else's is a 404.
  const res = await filterClient.get(`/api/analytics/overview?${WINDOW}&client_ids=${scope.foreign}`)
  assert.equal(res.status, 200, 'no 404, so nothing is confirmed about the other workspace')
  assert.equal(res.body.overall_stats.sent, 0, 'and certainly not this workspace\'s ten sends')
  assert.ok(!JSON.stringify(res.body).includes('Foreign'), 'the name never appears')

  const foreignCampaign = makeCampaign(outsider.id, 'Foreign run')
  const byCampaign = await filterClient.get(`/api/analytics/overview?${WINDOW}&campaign_ids=${foreignCampaign}`)
  assert.equal(byCampaign.status, 404)
})

// ============================================================================
// 5 & 7. Mailbox statistics window, and the warm-up ramp block
// ============================================================================

const boxWs = seedUser(db, 'boxes@example.com')
const boxClient = await mount(register, boxWs)
test.after(() => boxClient.close())

const boxes = {}
const RECENT = Date.now() - 3 * DAY
const OLD = Date.now() - 30 * DAY

test('seed a campaign that sent both recently and a month ago', () => {
  boxes.mb = makeMailbox(boxWs.id, 'aa-sender@harry.test')
  boxes.camp = makeCampaign(boxWs.id, 'Windowed', { mailboxId: boxes.mb })
  for (let i = 0; i < 2; i += 1) {
    outbound(boxWs.id, { campaignId: boxes.camp, leadId: makeLead(boxWs.id, 'rc'), mailboxId: boxes.mb, at: RECENT })
  }
  for (let i = 0; i < 4; i += 1) {
    outbound(boxWs.id, { campaignId: boxes.camp, leadId: makeLead(boxWs.id, 'ol'), mailboxId: boxes.mb, at: OLD })
  }

  // Three mailboxes at different points of the ramp.
  boxes.ramping = makeMailbox(boxWs.id, 'bb-ramping@harry.test', {
    provider: 'gmail', dailyLimit: 50, warmupEnabled: 1, warmupCount: 12, autoAdjust: 1,
  })
  boxes.finished = makeMailbox(boxWs.id, 'cc-finished@harry.test', {
    provider: 'gmail', dailyLimit: 50, warmupEnabled: 1, warmupCount: 50, autoAdjust: 0,
  })
  boxes.never = makeMailbox(boxWs.id, 'dd-never@harry.test', {
    provider: 'sandbox', dailyLimit: 30, warmupEnabled: 0, warmupCount: 20, autoAdjust: 1,
  })
})

test('with no dates the figures are all-time, and the range says so instead of inventing one', async () => {
  const res = await boxClient.get(`/api/campaigns/${boxes.camp}/mailbox-statistics`)
  assert.equal(res.status, 200)
  assert.equal(res.body.range.applied, 'default')
  // The defect: a thirty-day from/to was echoed beside all-time figures, so a
  // caption described a window the numbers had never been scoped by.
  assert.equal(res.body.range.from, null)
  assert.equal(res.body.range.to, null)
  assert.equal(res.body.range.days, null)
  assert.equal(res.body.range.timezone, 'UTC')
  assert.equal(res.body.data[0].sent, 6, 'both the recent two and the month-old four')
})

test('half a range falls back to the campaign\'s whole life, and still names no window', async () => {
  const res = await boxClient.get(
    `/api/campaigns/${boxes.camp}/mailbox-statistics?start_date=${dayKey(RECENT)}`
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.range.applied, 'campaign')
  assert.equal(res.body.range.from, null)
  assert.equal(res.body.range.to, null)
  assert.equal(res.body.data[0].sent, 6, 'a half-applied filter is no filter, not a silent one')
})

test('a full range is applied and echoed back exactly', async () => {
  const from = dayKey(Date.now() - 7 * DAY)
  const to = dayKey(Date.now() + DAY)
  const res = await boxClient.get(
    `/api/campaigns/${boxes.camp}/mailbox-statistics?start_date=${from}&end_date=${to}`
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.range.applied, 'requested')
  assert.equal(res.body.range.from, from)
  assert.equal(res.body.range.to, to)
  assert.equal(res.body.range.days, 9)
  assert.equal(res.body.data[0].sent, 2, 'the window bites — the month-old four are outside it')
})

test('limit stays inside its documented 1-20 bound', async () => {
  const res = await boxClient.get(`/api/campaigns/${boxes.camp}/mailbox-statistics?limit=25`)
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'limit')
})

test('each mailbox reports where it actually is in its warm-up ramp', async () => {
  const res = await boxClient.get(`/api/analytics/mailboxes/health?${WINDOW}`)
  assert.equal(res.status, 200)
  const by = new Map(res.body.items.map((r) => [r.mailbox_id, r]))

  assert.deepEqual(by.get(boxes.ramping).ramp, {
    warmup_enabled: true, daily_target: 12, daily_limit: 50, ramping: true, auto_adjust: true,
  }, 'twelve a day of a fifty limit — a low sent count here is the ramp, not a fault')

  assert.deepEqual(by.get(boxes.finished).ramp, {
    warmup_enabled: true, daily_target: 50, daily_limit: 50, ramping: false, auto_adjust: false,
  }, 'warm-up on but arrived at the limit is no longer ramping')

  assert.deepEqual(by.get(boxes.never).ramp, {
    warmup_enabled: false, daily_target: 30, daily_limit: 30, ramping: false, auto_adjust: true,
  }, 'with warm-up off the target is simply the limit')
})

// ============================================================================
// 6. The median reply-time bucket
// ============================================================================

const timeWs = seedUser(db, 'timing@example.com')
const timeClient = await mount(register, timeWs)
test.after(() => timeClient.close())

test('seed six replies whose median bucket is not their commonest bucket', () => {
  const mb = makeMailbox(timeWs.id, 'timing@harry.test')
  const camp = makeCampaign(timeWs.id, 'Timing', { mailboxId: mb })
  const sentAt = Date.now() - 3 * DAY

  // Two inside the hour, one within six, three within the day. The commonest
  // bucket is 6-24h; the median is 1-6h. A "median" that reported the mode
  // would pass a lazier fixture.
  for (const gap of [0.5 * HOUR, 0.75 * HOUR, 3 * HOUR, 8 * HOUR, 10 * HOUR, 12 * HOUR]) {
    const leadId = makeLead(timeWs.id, 'tm')
    outbound(timeWs.id, { campaignId: camp, leadId, mailboxId: mb, at: sentAt })
    inbound(timeWs.id, { campaignId: camp, leadId, mailboxId: mb, at: sentAt + gap, intent: 'interested' })
  }
})

test('the reply-time distribution reports counts, average and median as numbers', async () => {
  const res = await timeClient.get(`/api/analytics/reply-time-distribution?${WINDOW}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 6)
  assert.equal(res.body.untraceable_replies, 0, 'every reply found the send it answers')

  const count = (name) => res.body.buckets.find((b) => b.bucket === name).count
  assert.equal(count('0-1h'), 2)
  assert.equal(count('1-6h'), 1)
  assert.equal(count('6-24h'), 3)
  assert.equal(count('1-3d'), 0)
  assert.equal(count('3-7d'), 0)
  assert.equal(count('7d+'), 0)

  // (0.5 + 0.75 + 3 + 8 + 10 + 12) / 6 = 5.708…
  assert.equal(res.body.average_hours, 5.71)

  // Three replies land at or before the end of 1-6h out of six, so that is
  // where the halfway point falls — even though 6-24h holds more of them.
  assert.equal(res.body.median_bucket, '1-6h')

  for (const b of res.body.buckets) {
    assert.equal(b.time_range, b.bucket, 'the documented spelling is the same label')
  }
})

test('with no replies at all there is no median to state', async () => {
  const quiet = seedUser(db, 'quiet@example.com')
  const quietClient = await mount(register, quiet)
  test.after(() => quietClient.close())
  const res = await quietClient.get(`/api/analytics/reply-time-distribution?${WINDOW}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 0)
  assert.equal(res.body.median_bucket, null, 'null, not the first bucket by accident')
  assert.equal(res.body.average_hours, 0)
  assert.equal(res.body.buckets.length, 6, 'and every bucket still comes back, at zero')
})
