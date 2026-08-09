// Analytics audit, second pass — the twenty-four specs in analytics/ and
// campaign-statistics/ that still had no test-backed verdict.
//
// The rule this file follows is the one the first pass learned the hard way: a
// reporting defect does not throw. It answers 200 with the documented keys and
// the wrong arithmetic. Two of those shipped green here already — outcome rows
// grouped by a `mailbox_id` the query never selected, so every mailbox read
// 0 won / 0 lost / 0 unsubscribed; and a field called `share_exact` carrying a
// value that had already been rounded.
//
// So every fixture below is seeded so the right answer is a specific non-zero
// number, and that number is the assertion. The highest-value cases are the
// ones where two surfaces have to report the same figure for the same data:
// a rate defined twice will drift, and the only thing that catches the drift is
// a test that reads both.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, mount } from './helpers/parity-harness.js'

setup('analytics-audit2')                // MUST precede any ../server import
const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/analytics.js')

// ---- fixtures ---------------------------------------------------------------

let seq = 0

function makeMailbox(wsId, email, { provider = 'sandbox', dailyLimit = 100, status = 'connected' } = {}) {
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit)
     VALUES (?, ?, ?, ?, ?)`
  ).run(wsId, provider, email, status, dailyLimit)
  return db.prepare('SELECT id FROM mailboxes WHERE user_id = ? AND email = ?').get(wsId, email).id
}

function makeClient(wsId, name, { deleted = false } = {}) {
  db.prepare('INSERT INTO clients (workspace_id, name, deleted_at) VALUES (?, ?, ?)')
    .run(wsId, name, deleted ? '2026-01-01 00:00:00' : '')
  return db.prepare('SELECT id FROM clients WHERE workspace_id = ? AND name = ? ORDER BY id DESC')
    .get(wsId, name).id
}

function makeCampaign(wsId, name, { mailboxId = null, clientId = null, status = 'draft', mermaid = '' } = {}) {
  const info = db.prepare(
    'INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid, client_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(wsId, name, status, mailboxId, mermaid, clientId)
  return Number(info.lastInsertRowid)
}

function makeLead(wsId, tag, { status = 'active' } = {}) {
  seq += 1
  const email = `${tag}-${seq}@acme.test`
  const info = db.prepare('INSERT INTO leads (user_id, email, status) VALUES (?, ?, ?)')
    .run(wsId, email, status)
  return Number(info.lastInsertRowid)
}

function attach(campaignId, leadId, extra = {}) {
  db.prepare(
    `INSERT INTO campaign_leads (campaign_id, lead_id, state, outcome, unsubscribed_at, updated_at)
     VALUES (?, ?, 'active', ?, ?, ?)`
  ).run(campaignId, leadId, extra.outcome || '', extra.unsubscribed_at || '',
    extra.updated_at || '2026-05-04 09:00:00')
}

function out(wsId, { campaignId, leadId, mailboxId = null, at, sendStatus = 'sent', openedAt = '', clickedAt = '', nodeId = '' }) {
  seq += 1
  return Number(db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email,
        provider_message_id, send_status, opened_at, clicked_at, node_id, created_at)
     VALUES (?, ?, ?, ?, 'out', 'Hello', 'Body', 'x@acme.test', ?, ?, ?, ?, ?, ?)`
  ).run(wsId, campaignId, leadId, mailboxId, `o-${seq}`, sendStatus, openedAt, clickedAt, nodeId, at).lastInsertRowid)
}

function inn(wsId, { campaignId, leadId, mailboxId = null, at, intent = '' }) {
  seq += 1
  return Number(db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email,
        provider_message_id, intent, created_at)
     VALUES (?, ?, ?, ?, 'in', 'Re: Hello', 'Sure', 'x@acme.test', ?, ?, ?)`
  ).run(wsId, campaignId, leadId, mailboxId, `i-${seq}`, intent, at).lastInsertRowid)
}

const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0)

// The count-and-rate keys every rollup surface shares. Two surfaces reporting
// the same window must agree on all of them, not on the two a reviewer checks.
const STAT_KEYS = [
  'sent', 'opened', 'clicked', 'bounced', 'replied', 'replied_leads',
  'positive_replied', 'positive_reply_events', 'unique_lead_count', 'unique_open_count',
  'bounced_leads', 'won', 'lost', 'unsubscribed',
  'open_rate', 'click_rate', 'reply_rate', 'positive_reply_rate', 'win_rate',
  'unsubscribe_rate', 'bounce_rate', 'bounce_share', 'leads_per_reply', 'sample_size',
]

function sameStats(a, b, why) {
  for (const key of STAT_KEYS) {
    assert.equal(a[key], b[key], `${why}: ${key} is ${a[key]} on one surface and ${b[key]} on the other`)
  }
}

// ============================================================================
// 1. One week, read by nine different routes, which must all agree
// ============================================================================
//
// analytics/overview.md, day-wise-stats.md, day-wise-sent-time.md,
// day-wise-positive-reply.md, day-wise-positive-sent-time.md,
// campaign-performance.md, campaign-response-stats.md, lead-category-response.md,
// lead-stats.md, campaign-statistics/top-level.md, top-level-by-date.md.
//
// Every one of those specs asks for a number that another one of them also
// reports. The fixture is deliberately small and deliberately lopsided: one
// lead mailed twice, one lead replying on two different days, one bounce. Every
// figure below is therefore a different number from every other, so a route
// that silently returned the wrong aggregate cannot pass by coincidence.

const ws = seedUser(db, 'week@example.com')
const api = await mount(register, ws)
test.after(() => api.close())

const WEEK = 'from=2026-05-04&to=2026-05-08'
const NARROW = 'from=2026-05-05&to=2026-05-08'
const fix = {}

test('seed one week: five sends, three replies, two of them from the same lead on different days', () => {
  fix.mb = makeMailbox(ws.id, 'week@harry.test')
  fix.camp = makeCampaign(ws.id, 'Week one', { mailboxId: fix.mb })

  fix.l1 = makeLead(ws.id, 'l1')
  fix.l2 = makeLead(ws.id, 'l2', { status: 'bounced' })
  fix.l3 = makeLead(ws.id, 'l3')
  fix.l4 = makeLead(ws.id, 'l4')
  for (const id of [fix.l1, fix.l2, fix.l3, fix.l4]) attach(fix.camp, id)

  const o = (leadId, at, extra = {}) => out(ws.id, { campaignId: fix.camp, leadId, mailboxId: fix.mb, at, ...extra })
  const i = (leadId, at, intent) => inn(ws.id, { campaignId: fix.camp, leadId, mailboxId: fix.mb, at, intent })

  // Mon 4th: two sends, one of which bounces. The open on the first lands two
  // days later, which is the whole point of the two axes.
  o(fix.l1, '2026-05-04 09:00:00', { openedAt: '2026-05-06 10:00:00' })
  o(fix.l2, '2026-05-04 09:05:00', { sendStatus: 'bounced' })
  // Tue 5th: a chase to the same lead, and a first send to another.
  o(fix.l1, '2026-05-05 09:00:00')
  o(fix.l3, '2026-05-05 09:05:00')
  // Wed 6th: one more first send.
  o(fix.l4, '2026-05-06 09:00:00')
  // Replies: l3 twice, positively, on two different days; l4 once, a question.
  i(fix.l3, '2026-05-06 12:00:00', 'interested')
  i(fix.l4, '2026-05-06 13:00:00', 'question')
  i(fix.l3, '2026-05-07 12:00:00', 'interested')
})

test('overview reports the week exactly, with each rate on its documented denominator', async () => {
  const res = await api.get(`/api/analytics/overview?${WEEK}`)
  assert.equal(res.status, 200)
  const s = res.body.overall_stats

  assert.equal(s.sent, 5)
  assert.equal(s.opened, 1)
  assert.equal(s.clicked, 0)
  assert.equal(s.bounced, 1, 'one send carries send_status=bounced')
  assert.equal(s.replied, 3, 'reply events')
  assert.equal(s.replied_leads, 2, 'two distinct people replied')
  assert.equal(s.positive_replied, 1, 'one distinct lead replied positively, twice')
  assert.equal(s.positive_reply_events, 2, 'and those two replies are two events')
  assert.equal(s.unique_lead_count, 4)
  assert.equal(s.unique_open_count, 1)
  assert.equal(s.bounced_leads, 1)

  // The denominators, spelled out. open per email sent, reply per lead
  // contacted — the divergence that had one campaign reading 13.3% on one
  // screen and 40.0% on another.
  assert.equal(s.open_rate, 20, '1 of 5 emails')
  assert.equal(s.reply_rate, 50, '2 of 4 leads')
  assert.equal(s.positive_reply_rate, 25, '1 of 4 leads')
  assert.equal(s.bounce_share, 20, '1 bounced email of 5 sent')
  assert.equal(s.bounce_rate, 25, '1 bounced lead of 4 contacted')
  assert.notEqual(s.bounce_rate, s.bounce_share, 'the two bounce figures are different questions')
  assert.equal(s.leads_per_reply, 2, '4 leads earned 2 replying leads')
  assert.equal(s.sample_size, 4)
  assert.equal(s.opens_tracked, true)
})

test('the day-wise series sums to the range total for every additive field', async () => {
  const res = await api.get(`/api/analytics/daily?${WEEK}&timezone=UTC`)
  assert.equal(res.status, 200)
  const days = res.body.items
  assert.equal(days.length, 5, 'five days requested, five rows')

  const on = (date) => days.find((d) => d.day === date)
  assert.deepEqual(
    days.map((d) => [d.day, d.sent, d.opened, d.replied, d.bounced]),
    [
      ['2026-05-04', 2, 0, 0, 1],
      ['2026-05-05', 2, 0, 0, 0],
      ['2026-05-06', 1, 1, 2, 0],
      ['2026-05-07', 0, 0, 1, 0],
      ['2026-05-08', 0, 0, 0, 0],
    ],
    'each event sits on its own date: the open is on the 6th, not the 4th',
  )

  const overview = (await api.get(`/api/analytics/overview?${WEEK}`)).body.overall_stats
  for (const field of ['sent', 'opened', 'clicked', 'replied', 'bounced']) {
    assert.equal(sum(days, field), overview[field], `${field} is additive and must sum to the range total`)
  }

  // `unique_lead_reached` is the field the metadata warns about, and the
  // warning has to be true: lead 1 was mailed on two days, so the column sums
  // to one more than the range's distinct count.
  assert.equal(sum(days, 'unique_lead_reached'), 5)
  assert.equal(overview.unique_lead_count, 4)
  assert.deepEqual(res.body.metadata.non_additive, ['unique_lead_reached'])

  // `positive_replied` here counts reply events; the overview field of the same
  // name counts distinct leads. Summing the series matches `positive_reply_events`
  // and NOT the identically named overview field.
  assert.equal(sum(days, 'positive_replied'), 2)
  assert.equal(overview.positive_reply_events, 2)
  assert.equal(overview.positive_replied, 1)
  assert.equal(on('2026-05-07').positive_replied, 1)
})

test('the sent axis moves every metric onto the day the email went out', async () => {
  const res = await api.get(`/api/analytics/daily?axis=sent&${WEEK}&timezone=UTC`)
  assert.equal(res.status, 200)
  assert.equal(res.body.axis, 'sent')
  assert.equal(res.body.untraceable_replies, 0, 'every reply found the send it answers')

  assert.deepEqual(
    res.body.items.map((d) => [d.day, d.sent, d.opened, d.replied, d.positive_replied]),
    [
      // The open happened on the 6th; the email went out on the 4th.
      ['2026-05-04', 2, 1, 0, 0],
      // Both of lead 3's replies answer the send made on the 5th.
      ['2026-05-05', 2, 0, 2, 2],
      ['2026-05-06', 1, 0, 1, 0],
      ['2026-05-07', 0, 0, 0, 0],
      ['2026-05-08', 0, 0, 0, 0],
    ],
    'the two axes disagree about which day earned what, which is why both exist',
  )

  // The raw totals cannot move between axes; only their dates can.
  const event = (await api.get(`/api/analytics/daily?${WEEK}&timezone=UTC`)).body.items
  for (const field of ['sent', 'opened', 'replied', 'bounced']) {
    assert.equal(sum(res.body.items, field), sum(event, field), `${field} totals the same on both axes`)
  }
})

test('the sent axis refuses to guess a timezone, since the bucket depends on it', async () => {
  const res = await api.get(`/api/analytics/daily?axis=sent&${WEEK}`)
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'timezone')
})

test('positive replies are distinct leads per day, and the range total is not the sum', async () => {
  const res = await api.get(`/api/analytics/positive-replies/daily?${WEEK}&timezone=UTC`)
  assert.equal(res.status, 200)
  assert.equal(res.body.counting, 'distinct_leads')
  assert.deepEqual(
    res.body.items.map((d) => [d.day, d.count, d.reply_events]),
    [
      ['2026-05-04', 0, 0], ['2026-05-05', 0, 0],
      ['2026-05-06', 1, 1], ['2026-05-07', 1, 1], ['2026-05-08', 0, 0],
    ],
  )
  // The same person on two days is two day-points and one lead. Summing the
  // column would say two people were interested this week; one was.
  assert.equal(sum(res.body.items, 'count'), 2)
  assert.equal(res.body.range_total, 1)

  const overview = (await api.get(`/api/analytics/overview?${WEEK}`)).body.overall_stats
  assert.equal(res.body.range_total, overview.positive_replied,
    'the range figure is the one the overview tile shows')

  const bySend = await api.get(`/api/analytics/positive-replies/daily?axis=sent&${WEEK}&timezone=UTC`)
  assert.equal(bySend.status, 200)
  assert.deepEqual(
    bySend.body.items.filter((d) => d.reply_events > 0).map((d) => [d.day, d.count, d.reply_events]),
    [['2026-05-05', 1, 2]],
    'both replies are credited to the send that earned them, and the lead counts once',
  )
  assert.equal(bySend.body.range_total, 1)
  assert.equal(bySend.body.untraceable_replies, 0)
})

test('response stats count reply events, and say so against the overview tile', async () => {
  const res = await api.get(`/api/analytics/campaigns/response-stats?${WEEK}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.counting, 'reply_events')
  assert.deepEqual(res.body.totals, { positive: 2, neutral: 1, negative: 0, uncategorised: 0, total: 3 })

  const row = res.body.items.find((r) => r.campaign_id === fix.camp)
  assert.equal(row.positive, 2)
  assert.equal(row.neutral, 1)
  assert.equal(row.positive_reply, 2, 'the documented spelling is the same tally')
  assert.equal(row.neutral_reply, 1)
  assert.equal(row.negative_reply, 0)
  assert.equal(row.uncategorised_reply, 0)

  // The spec's TC-7 in full: one lead replying twice is 2 here and 1 on the
  // overview tile, and both are correct because they answer different questions.
  const overview = (await api.get(`/api/analytics/overview?${WEEK}`)).body.overall_stats
  assert.equal(res.body.totals.positive, 2)
  assert.equal(overview.positive_replied, 1)
  assert.equal(res.body.totals.positive, overview.positive_reply_events,
    'the event-shaped figure on each surface is the same number')
})

test('the category breakdown carries the same replies, with shares totalling 100', async () => {
  const res = await api.get(`/api/analytics/replies/by-category?${WEEK}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.total_replies, 3)
  assert.deepEqual(
    res.body.items.map((r) => [r.category, r.total_response, r.share]),
    [['interested', 2, 66.7], ['question', 1, 33.3]],
  )
  assert.equal(Math.round(sum(res.body.items, 'share') * 10) / 10, 100)
  // The unrounded ratio, which is the thing a reader checks the balancing with.
  assert.ok(Math.abs(res.body.items[0].share_exact - 200 / 3) < 1e-9)
})

test('the contact mix agrees with the overview on how many leads were contacted', async () => {
  const wide = await api.get(`/api/analytics/leads/contact-mix?${WEEK}`)
  assert.equal(wide.status, 200)
  assert.equal(wide.body.total, 4)
  assert.equal(wide.body.new, 4)
  assert.equal(wide.body.follow_up, 0)
  assert.equal(wide.body.new_share, 100)
  assert.equal(wide.body.data.lead_stats.count.total, 4, 'the documented envelope is the same tally')

  const overview = (await api.get(`/api/analytics/overview?${WEEK}`)).body.overall_stats
  assert.equal(wide.body.total, overview.unique_lead_count,
    'contact mix and the funnel count the same contacted leads')

  // Narrow the window past lead 1's first touch and it becomes a chase — the
  // rule the panel is required to state.
  const narrow = await api.get(`/api/analytics/leads/contact-mix?${NARROW}`)
  assert.equal(narrow.body.total, 3)
  assert.equal(narrow.body.new, 2, 'leads 3 and 4 were first reached inside this window')
  assert.equal(narrow.body.follow_up, 1, 'lead 1 was first reached before it')
  assert.equal(narrow.body.new_share, 66.7)
  assert.equal(narrow.body.follow_up_share, 33.3)
  assert.equal(narrow.body.new + narrow.body.follow_up, narrow.body.total, 'the parts equal the whole')

  const narrowOverview = (await api.get(`/api/analytics/overview?${NARROW}`)).body.overall_stats
  assert.equal(narrow.body.total, narrowOverview.unique_lead_count)
})

test('campaign performance, the workspace total and the campaign headline are one aggregate', async () => {
  const perf = await api.get(`/api/analytics/campaigns/performance?${WEEK}`)
  assert.equal(perf.status, 200)
  assert.equal(perf.body.items.length, 1)
  const row = perf.body.items[0]
  const overview = (await api.get(`/api/analytics/overview?${WEEK}`)).body.overall_stats

  sameStats(row, overview, 'the only campaign and the workspace')
  sameStats(perf.body.workspace, overview, 'performance workspace block and overview')
  assert.equal(row.campaign_name, 'Week one', 'the documented spelling sits beside Harry\'s')
  assert.equal(row.id, row.campaign_id)

  // top-level-by-date.md TC-9: a range covering the campaign's whole life must
  // agree exactly with the unranged headline. One aggregation, two entry points.
  const ranged = await api.get(
    `/api/campaigns/${fix.camp}/top-level-analytics-by-date?start_date=2026-05-01&end_date=2026-05-31`
  )
  assert.equal(ranged.status, 200)
  const allTime = await api.get(`/api/campaigns/${fix.camp}/analytics`)
  assert.equal(allTime.status, 200)
  sameStats(ranged.body.data, allTime.body.data, 'the ranged headline and the all-time one')
  assert.equal(allTime.body.data.sent, 5)
  assert.equal(allTime.body.data.leads_total, 4)

  // And the same window read through the workspace route.
  const sameWindow = await api.get(
    `/api/campaigns/${fix.camp}/top-level-analytics-by-date?start_date=2026-05-04&end_date=2026-05-08`
  )
  sameStats(sameWindow.body.data, row, 'the campaign headline and its row on Reports')
})

test('both dates are required on the ranged headline, and only that route requires them', async () => {
  const missing = await api.get(`/api/campaigns/${fix.camp}/top-level-analytics-by-date?start_date=2026-05-04`)
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'end_date')

  // The per-day route next door is happy with neither, and defaults.
  const ok = await api.get(`/api/campaigns/${fix.camp}/analytics-by-date`)
  assert.equal(ok.status, 200)
})

// ============================================================================
// 2. Leads per reply is computed, not inverted from a rounded rate
// ============================================================================
//
// analytics/leads-for-first-reply.md. TC-1 is 420 leads and 10 replies reading
// 42; the DoD is that the figure comes from the same aggregate as the rate.
// 84 leads and 2 replies is the same arithmetic in a tenth of the rows — and it
// is the case that separates the two implementations, because inverting the
// rounded rate gives 41.7 rather than 42.

const ratioWs = seedUser(db, 'ratio@example.com')
const ratioApi = await mount(register, ratioWs)
test.after(() => ratioApi.close())

test('seed 84 leads contacted and exactly 2 of them replying', () => {
  const mb = makeMailbox(ratioWs.id, 'ratio@harry.test')
  const camp = makeCampaign(ratioWs.id, 'Ratio', { mailboxId: mb })
  db.transaction(() => {
    for (let i = 0; i < 84; i += 1) {
      const leadId = makeLead(ratioWs.id, 'rt')
      out(ratioWs.id, { campaignId: camp, leadId, mailboxId: mb, at: '2026-05-04 09:00:00' })
      if (i < 2) inn(ratioWs.id, { campaignId: camp, leadId, mailboxId: mb, at: '2026-05-04 12:00:00', intent: 'interested' })
    }
  })()
})

test('leads per reply is 42, not the 41.7 an inverted rate would give', async () => {
  const res = await ratioApi.get(`/api/analytics/campaigns/performance?${WEEK}`)
  assert.equal(res.status, 200)
  const row = res.body.items[0]
  assert.equal(row.unique_lead_count, 84)
  assert.equal(row.replied_leads, 2)

  // 2/84 is 2.380…, which the house rule rounds to 2.4.
  assert.equal(row.reply_rate, 2.4)
  assert.equal(row.leads_per_reply, 42, '84 leads over 2 replying leads, from the same aggregate')
  assert.notEqual(row.leads_per_reply, Math.round((100 / row.reply_rate) * 10) / 10,
    'inverting the rounded rate gives 41.7 — the figure must not be derived from a rounded one')
  assert.equal(row.sample_size, 84, 'the client applies its small-sample caveat without a second call')
  assert.equal(res.body.workspace.leads_per_reply, 42)
})

test('with contacts but no replies the figure is 0, never Infinity', async () => {
  const quietWs = seedUser(db, 'quiet-ratio@example.com')
  const quietApi = await mount(register, quietWs)
  test.after(() => quietApi.close())
  const mb = makeMailbox(quietWs.id, 'quiet-ratio@harry.test')
  const camp = makeCampaign(quietWs.id, 'Silent', { mailboxId: mb })
  for (let i = 0; i < 3; i += 1) {
    out(quietWs.id, { campaignId: camp, leadId: makeLead(quietWs.id, 'qr'), mailboxId: mb, at: '2026-05-04 09:00:00' })
  }
  const res = await quietApi.get(`/api/analytics/campaigns/performance?${WEEK}`)
  const row = res.body.items[0]
  assert.equal(row.unique_lead_count, 3)
  assert.equal(row.replied_leads, 0)
  // HARRY-OVER-SPEC: the spec asks for null here; the house rule is 0.
  assert.equal(row.leads_per_reply, 0)
  assert.ok(Number.isFinite(row.leads_per_reply))
  assert.equal(row.sample_size, 3, 'sample_size is present on every response')
})

// ============================================================================
// 3. A follow-up is the node a "no reply" edge reaches — and nothing else
// ============================================================================
//
// analytics/followup-reply-rate.md. TC-7 is the case worth having: a `Send:`
// node reached by a `reply:` edge is a conversation, not a chase, and folding it
// into the denominator moves the rate. The fixture is built so that mistake
// changes 3.2 into 3.1.

const fuWs = seedUser(db, 'followup@example.com')
const fuApi = await mount(register, fuWs)
test.after(() => fuApi.close())

const PLAYBOOK = [
  'flowchart TD',
  '  S([Start])',
  '  A[Send: intro]',
  '  B[Send: chase]',
  '  C[Send: answer the question]',
  '  S --> A',
  '  A -- no reply 3d --> B',
  '  A -- reply: question --> C',
].join('\n')

const fu = {}

test('seed 125 first emails, 125 chases and 5 conversation replies', () => {
  fu.mb = makeMailbox(fuWs.id, 'followup@harry.test')
  fu.camp = makeCampaign(fuWs.id, 'Chased', { mailboxId: fu.mb, mermaid: PLAYBOOK })
  // A second campaign that only ever sends a first email, for the "no
  // follow-ups in this range" case.
  fu.firstOnly = makeCampaign(fuWs.id, 'First only', { mailboxId: fu.mb, mermaid: PLAYBOOK })

  db.transaction(() => {
    for (let i = 0; i < 125; i += 1) {
      const leadId = makeLead(fuWs.id, 'fu')
      const o = (at, nodeId) => out(fuWs.id, { campaignId: fu.camp, leadId, mailboxId: fu.mb, at, nodeId })
      o('2026-05-04 09:00:00', 'A')
      o('2026-05-06 09:00:00', 'B')
      // Ten leads answer the first email, before the chase went out.
      if (i < 10) inn(fuWs.id, { campaignId: fu.camp, leadId, mailboxId: fu.mb, at: '2026-05-05 12:00:00', intent: 'question' })
      // Four answer the chase.
      if (i >= 10 && i < 14) inn(fuWs.id, { campaignId: fu.camp, leadId, mailboxId: fu.mb, at: '2026-05-06 12:00:00', intent: 'interested' })
      // Five get a conversation reply sent to them, two of whom answer again.
      if (i < 5) {
        o('2026-05-07 09:00:00', 'C')
        if (i < 2) inn(fuWs.id, { campaignId: fu.camp, leadId, mailboxId: fu.mb, at: '2026-05-07 12:00:00', intent: 'interested' })
      }
    }
    for (let i = 0; i < 20; i += 1) {
      out(fuWs.id, {
        campaignId: fu.firstOnly, leadId: makeLead(fuWs.id, 'fo'), mailboxId: fu.mb,
        at: '2026-05-04 09:00:00', nodeId: 'A',
      })
    }
  })()
})

test('the follow-up rate counts only nodes a no-reply edge reaches', async () => {
  const res = await fuApi.get(`/api/analytics/followup-reply-rate?${WEEK}&campaign_ids=${fu.camp}`)
  assert.equal(res.status, 200)

  assert.equal(res.body.first_sent, 125)
  assert.equal(res.body.followups_sent, 125)
  assert.equal(res.body.conversation_sent, 5, 'the reply: node is its own kind')
  assert.equal(res.body.uncategorised_sent, 0, 'every send resolved to a playbook node')

  assert.equal(res.body.first_replies, 10)
  assert.equal(res.body.followup_replies, 4)
  assert.equal(res.body.conversation_replies, 2)

  // 4 of 125.
  assert.equal(res.body.rate, 3.2)
  assert.equal(res.body.data.followup_reply_rate, 3.2, 'the documented envelope is the same number')
  // 10 of 125, shown beside it because the follow-up rate is meaningless alone.
  assert.equal(res.body.first_email_rate, 8)
  assert.equal(res.body.has_followups, true)

  // Folding the conversation node into the denominator — the mistake TC-7 is
  // written to catch — would read 3.1 rather than 3.2.
  const wrong = Math.round((4 / (125 + 5)) * 1000) / 10
  assert.equal(wrong, 3.1)
  assert.notEqual(res.body.rate, wrong)
})

test('a campaign that only sent first emails says so rather than reporting 0%', async () => {
  const res = await fuApi.get(`/api/analytics/followup-reply-rate?${WEEK}&campaign_ids=${fu.firstOnly}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.first_sent, 20)
  assert.equal(res.body.followups_sent, 0)
  assert.equal(res.body.has_followups, false, '"nothing was chased" is not "nobody replied"')
  // HARRY-OVER-SPEC: the spec asks for null; the house rule is 0, and
  // `has_followups` carries the distinction instead.
  assert.equal(res.body.rate, 0)
  assert.ok(Number.isFinite(res.body.rate))
})

test('the campaign filter changes the answer, so it is not being ignored', async () => {
  const all = await fuApi.get(`/api/analytics/followup-reply-rate?${WEEK}`)
  assert.equal(all.body.first_sent, 145, 'both campaigns')
  assert.equal(all.body.followups_sent, 125)
  assert.equal(all.body.first_email_rate, Math.round((10 / 145) * 1000) / 10)
  assert.notEqual(all.body.first_email_rate, 8)
})

// ============================================================================
// 4. Providers and domains: the parts must equal the whole
// ============================================================================
//
// analytics/provider-performance.md TC-9 ("tag_wise sends do not double-count
// against overall") and domain-wise-health.md DoD ("sums across domains equal
// the workspace totals"). Both are the same class of defect: a grouped rollup
// that quietly counts a row twice, or drops it.

const provWs = seedUser(db, 'providers@example.com')
const provApi = await mount(register, provWs)
test.after(() => provApi.close())

const prov = {}

test('seed two gmail mailboxes on one domain, a sandbox on another, across two campaigns', () => {
  prov.alice = makeMailbox(provWs.id, 'alice@send.acme.test', { provider: 'gmail' })
  // Plus-addressed and on the same domain: the extraction must land it here too.
  prov.bob = makeMailbox(provWs.id, 'bob+outreach@send.acme.test', { provider: 'gmail' })
  prov.sandy = makeMailbox(provWs.id, 'sandy@boxes.sandbox.test', { provider: 'sandbox' })
  prov.p1 = makeCampaign(provWs.id, 'P one', { mailboxId: prov.alice })
  prov.p2 = makeCampaign(provWs.id, 'P two', { mailboxId: prov.bob })

  const at = '2026-05-04 09:00:00'
  // Alice: 10 sends to 5 leads, 4 of the messages opened.
  db.transaction(() => {
    for (let i = 0; i < 5; i += 1) {
      const leadId = makeLead(provWs.id, 'pa')
      out(provWs.id, { campaignId: prov.p1, leadId, mailboxId: prov.alice, at, openedAt: i < 4 ? '2026-05-04 10:00:00' : '' })
      out(provWs.id, { campaignId: prov.p1, leadId, mailboxId: prov.alice, at })
    }
    // Bob on P1: 6 sends to 3 leads, 3 opened.
    for (let i = 0; i < 3; i += 1) {
      const leadId = makeLead(provWs.id, 'pb')
      out(provWs.id, { campaignId: prov.p1, leadId, mailboxId: prov.bob, at, openedAt: '2026-05-04 10:00:00' })
      out(provWs.id, { campaignId: prov.p1, leadId, mailboxId: prov.bob, at })
    }
    // Bob on P2: 4 sends to 2 leads, none opened.
    for (let i = 0; i < 2; i += 1) {
      const leadId = makeLead(provWs.id, 'pc')
      out(provWs.id, { campaignId: prov.p2, leadId, mailboxId: prov.bob, at })
      out(provWs.id, { campaignId: prov.p2, leadId, mailboxId: prov.bob, at })
    }
    // Sandbox: 5 sends to 5 leads.
    for (let i = 0; i < 5; i += 1) {
      out(provWs.id, { campaignId: prov.p1, leadId: makeLead(provWs.id, 'ps'), mailboxId: prov.sandy, at })
    }
  })()
})

test('provider totals equal the sum of their per-campaign rows', async () => {
  const res = await provApi.get(`/api/analytics/mailboxes/providers?${WEEK}`)
  assert.equal(res.status, 200)

  const gmail = res.body.overall.find((p) => p.provider === 'gmail')
  const sandbox = res.body.overall.find((p) => p.provider === 'sandbox')
  assert.equal(gmail.sent, 20, '10 from alice plus 10 from bob')
  assert.equal(gmail.opened, 7)
  assert.equal(sandbox.sent, 5)
  assert.equal(sandbox.is_sandbox, true)
  assert.equal(gmail.is_sandbox, false)

  const gmailRows = res.body.by_campaign.filter((r) => r.provider === 'gmail')
  assert.equal(gmailRows.length, 2)
  assert.equal(sum(gmailRows, 'sent'), gmail.sent, 'the per-campaign split does not double-count')
  assert.equal(sum(gmailRows, 'opened'), gmail.opened)
  assert.deepEqual(
    gmailRows.map((r) => [r.campaign_name, r.sent, r.opened]).sort(),
    [['P one', 16, 7], ['P two', 4, 0]],
  )
  assert.equal(gmailRows[0].tag, gmailRows[0].campaign_name, 'the spec\'s tag is the campaign label, said plainly')

  // Only gmail is a real provider, so the comparison panel has nothing to
  // compare and the payload says so rather than leaving the UI to guess.
  assert.equal(res.body.real_providers, 1)

  // The shares on this route are per email sent — a provider's view. Per lead
  // contacted the same fixture reads 70, so a swapped denominator is visible.
  assert.equal(gmail.open_rate, 35, '7 opens of 20 emails')
  assert.equal(gmail.unique_lead_count, 10)
  assert.notEqual(gmail.open_rate, 70)
  assert.equal(res.body.data.email_providers_performance_overview.overall.length, res.body.overall.length)
})

test('domain rollups sum to the workspace, and read the address rather than a stored column', async () => {
  const res = await provApi.get(`/api/analytics/mailboxes/domains?${WEEK}`)
  assert.equal(res.status, 200)
  const rows = res.body.items
  assert.deepEqual(
    rows.map((r) => [r.domain, r.mailboxes, r.sent, r.opened]),
    [['send.acme.test', 2, 20, 7], ['boxes.sandbox.test', 1, 5, 0]],
    'a subdomain is its own domain and a plus-addressed mailbox lands on the right one',
  )

  const overview = (await provApi.get(`/api/analytics/overview?${WEEK}`)).body.overall_stats
  assert.equal(sum(rows, 'sent'), overview.sent, 'nothing is lost or counted twice between the two')
  assert.equal(sum(rows, 'opened'), overview.opened)
  assert.equal(overview.sent, 25)
})

test('a campaign filter narrows the domain figures rather than being accepted and ignored', async () => {
  const res = await provApi.get(`/api/analytics/mailboxes/domains?${WEEK}&campaign_ids=${prov.p2}`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items.map((r) => [r.domain, r.sent]), [['send.acme.test', 4]],
    'only bob\'s four sends on P two; the sandbox domain drops out entirely')
})

// ============================================================================
// 5. is_bounced filters this range's bounces, not a lifetime of them
// ============================================================================
//
// analytics/email-wise-health.md TC-7 and its DoD. A mailbox that bounced in
// March and has been clean since is not a problem account today, and a filter
// that says it is sends someone to rest a healthy mailbox.

const boxWs = seedUser(db, 'health@example.com')
const boxApi = await mount(register, boxWs)
test.after(() => boxApi.close())

const box = {}

test('seed one mailbox bouncing inside the range, one that bounced only before it, one silent', () => {
  box.now = makeMailbox(boxWs.id, 'aa-bouncing@harry.test')
  box.past = makeMailbox(boxWs.id, 'bb-recovered@harry.test')
  box.silent = makeMailbox(boxWs.id, 'cc-silent@harry.test')
  const camp = makeCampaign(boxWs.id, 'Health', { mailboxId: box.now })

  for (let i = 0; i < 4; i += 1) {
    out(boxWs.id, {
      campaignId: camp, leadId: makeLead(boxWs.id, 'hn'), mailboxId: box.now,
      at: '2026-05-05 09:00:00', sendStatus: i === 0 ? 'bounced' : 'sent',
    })
  }
  for (let i = 0; i < 3; i += 1) {
    out(boxWs.id, { campaignId: camp, leadId: makeLead(boxWs.id, 'hp'), mailboxId: box.past, at: '2026-05-05 09:00:00' })
  }
  // Two months earlier, one of which bounced — outside every window below.
  for (let i = 0; i < 2; i += 1) {
    out(boxWs.id, {
      campaignId: camp, leadId: makeLead(boxWs.id, 'ho'), mailboxId: box.past,
      at: '2026-03-01 09:00:00', sendStatus: i === 0 ? 'bounced' : 'sent',
    })
  }
})

test('the bouncing-only filter picks the mailbox bouncing now, not the one that once did', async () => {
  const all = await boxApi.get(`/api/analytics/mailboxes/health?${WEEK}`)
  assert.equal(all.status, 200)
  const by = new Map(all.body.items.map((r) => [r.mailbox_id, r]))
  assert.equal(by.get(box.now).sent, 4)
  assert.equal(by.get(box.now).bounced, 1)
  assert.equal(by.get(box.past).sent, 3)
  assert.equal(by.get(box.past).bounced, 0, 'March is outside this window')
  assert.equal(by.get(box.silent).sent, 0, 'a silent mailbox is zeros, not an absence')
  assert.equal(by.get(box.now).bounce_share, 25)

  const bouncing = await boxApi.get(`/api/analytics/mailboxes/health?${WEEK}&is_bounced=true`)
  assert.deepEqual(bouncing.body.items.map((r) => r.mailbox_id), [box.now],
    'lifetime bounces would have dragged the recovered mailbox in here')

  const clean = await boxApi.get(`/api/analytics/mailboxes/health?${WEEK}&is_bounced=false`)
  assert.deepEqual(clean.body.items.map((r) => r.mailbox_id).sort((a, b) => a - b),
    [box.past, box.silent].sort((a, b) => a - b))

  // Widen the window to include March and the recovered mailbox reappears —
  // proving the filter is reading the window and not a stored flag.
  const wide = await boxApi.get('/api/analytics/mailboxes/health?from=2026-02-01&to=2026-05-31&is_bounced=true')
  assert.deepEqual(wide.body.items.map((r) => r.mailbox_id).sort((a, b) => a - b),
    [box.now, box.past].sort((a, b) => a - b))
})

test('a boolean-ish is_bounced that is neither is a 422 naming the field', async () => {
  const res = await boxApi.get(`/api/analytics/mailboxes/health?${WEEK}&is_bounced=maybe`)
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'is_bounced')
})

// ============================================================================
// 6. "holding" is derived from the send window, not stored
// ============================================================================
//
// analytics/campaign-status-stats.md: the derived state must match what the
// engine actually obeys, and the counts must sum to the workspace's campaigns.

const statusWs = seedUser(db, 'holding@example.com')
const statusApi = await mount(register, statusWs)
test.after(() => statusApi.close())

const hold = {}

const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`

test('seed two running campaigns, a paused one and a draft, under one client', () => {
  const mb = makeMailbox(statusWs.id, 'holding@harry.test')
  hold.client = makeClient(statusWs.id, 'Held Ltd')
  hold.other = makeClient(statusWs.id, 'Other Ltd')
  makeCampaign(statusWs.id, 'Run one', { mailboxId: mb, status: 'running', clientId: hold.client })
  makeCampaign(statusWs.id, 'Run two', { mailboxId: mb, status: 'running', clientId: hold.client })
  makeCampaign(statusWs.id, 'Paused', { mailboxId: mb, status: 'paused', clientId: hold.client })
  makeCampaign(statusWs.id, 'Draft', { mailboxId: mb, status: 'draft', clientId: hold.other })
})

test('with the send window open a running campaign reads running', async () => {
  db.prepare("UPDATE users SET paced = 1, send_from = '00:00', send_to = '24:00', send_days = 'everyday', send_timezone = 'UTC' WHERE id = ?")
    .run(statusWs.id)
  const res = await statusApi.get('/api/analytics/campaigns/status-counts')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items, [
    { status: 'running', count: 2 },
    { status: 'draft', count: 1 },
    { status: 'paused', count: 1 },
  ])
  assert.equal(res.body.campaigns_total, 4)
  assert.equal(sum(res.body.items, 'count'), res.body.campaigns_total, 'the parts equal the whole')
})

test('with the send window shut the same campaigns read holding', async () => {
  // A one-minute window five minutes from now, in UTC. Shut right now, and
  // shut for a deterministic reason rather than by luck of the clock.
  const now = new Date()
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  const from = (nowMin + 5) % 1440
  db.prepare('UPDATE users SET paced = 1, send_from = ?, send_to = ?, send_days = ?, send_timezone = ? WHERE id = ?')
    .run(hhmm(from), hhmm((from + 1) % 1440), 'everyday', 'UTC', statusWs.id)

  const res = await statusApi.get('/api/analytics/campaigns/status-counts')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items, [
    { status: 'holding', count: 2 },
    { status: 'draft', count: 1 },
    { status: 'paused', count: 1 },
  ], 'only running campaigns move; a paused one is paused whatever the clock says')
  assert.equal(res.body.campaigns_total, 4)
  assert.ok(!res.body.items.some((r) => r.status === 'running'), 'a state with no campaigns is omitted')

  // Turning pacing off puts them back: the state is read from the same window
  // the sender obeys, never stored.
  db.prepare('UPDATE users SET paced = 0 WHERE id = ?').run(statusWs.id)
  const unpaced = await statusApi.get('/api/analytics/campaigns/status-counts')
  assert.deepEqual(unpaced.body.items.find((r) => r.status === 'running'), { status: 'running', count: 2 })
})

test('the client filter narrows the status counts', async () => {
  const res = await statusApi.get(`/api/analytics/campaigns/status-counts?client_ids=${hold.other}`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items, [{ status: 'draft', count: 1 }])
  assert.equal(res.body.campaigns_total, 1)

  const junk = await statusApi.get('/api/analytics/campaigns/status-counts?client_ids=not-a-number')
  assert.equal(junk.status, 422)
  assert.equal(junk.body.field, 'client_ids')
})

// ============================================================================
// 7. Day buckets across a daylight-saving boundary
// ============================================================================
//
// campaign-statistics/get-by-date-range.md DoD: "day bucketing is unit-tested
// across a daylight-saving boundary". US clocks go forward on 8 March 2026, so
// that day is 23 hours long in New York. Four sends, chosen so a naive fixed
// offset puts two of them on the wrong day.

const dstWs = seedUser(db, 'dst@example.com')
const dstApi = await mount(register, dstWs)
test.after(() => dstApi.close())

const dst = {}

test('seed four sends around the spring-forward instant', () => {
  const mb = makeMailbox(dstWs.id, 'dst@harry.test')
  dst.camp = makeCampaign(dstWs.id, 'Clocks', { mailboxId: mb })
  const o = (at) => out(dstWs.id, { campaignId: dst.camp, leadId: makeLead(dstWs.id, 'ds'), mailboxId: mb, at })
  o('2026-03-08 06:30:00')   // 01:30 EST — before the jump, still the 8th
  o('2026-03-08 07:30:00')   // 03:30 EDT — after the jump, still the 8th
  o('2026-03-09 03:59:00')   // 23:59 EDT on the 8th
  o('2026-03-09 04:01:00')   // 00:01 EDT on the 9th
})

test('a 23-hour day holds three of the four sends in New York, and two in UTC', async () => {
  const ny = await dstApi.get(
    `/api/campaigns/${dst.camp}/analytics-by-date?start_date=2026-03-07&end_date=2026-03-10&time_zone=America/New_York`
  )
  assert.equal(ny.status, 200)
  assert.deepEqual(ny.body.data.map((d) => [d.date, d.sent]), [
    ['2026-03-07', 0], ['2026-03-08', 3], ['2026-03-09', 1], ['2026-03-10', 0],
  ], 'the offset in force at each instant decides its day, not the offset at the range edge')
  assert.equal(ny.body.range.timezone, 'America/New_York')

  const utc = await dstApi.get(
    `/api/campaigns/${dst.camp}/analytics-by-date?start_date=2026-03-07&end_date=2026-03-10&time_zone=UTC`
  )
  assert.deepEqual(utc.body.data.map((d) => [d.date, d.sent]), [
    ['2026-03-07', 0], ['2026-03-08', 2], ['2026-03-09', 2], ['2026-03-10', 0],
  ])

  // Neither reading loses a send: only the day it lands on changes.
  assert.equal(sum(ny.body.data, 'sent'), 4)
  assert.equal(sum(utc.body.data, 'sent'), 4)
})

// ============================================================================
// 8. Per-step statistics: paging, filters and a node deleted from the diagram
// ============================================================================
//
// campaign-statistics/get-by-id.md TC-7, TC-9, TC-10 and the DoD line about a
// playbook edited after sending.

const stepWs = seedUser(db, 'steps@example.com')
const stepApi = await mount(register, stepWs)
test.after(() => stepApi.close())

const steps = {}

test('seed a twelve-step playbook, one send per step, plus a send from a deleted node', () => {
  const mb = makeMailbox(stepWs.id, 'steps@harry.test')
  const lines = ['flowchart TD', '  S([Start])']
  for (let n = 1; n <= 12; n += 1) lines.push(`  N${n}[Send: step ${n}]`)
  lines.push('  S --> N1')
  for (let n = 1; n < 12; n += 1) lines.push(`  N${n} --> N${n + 1}`)
  steps.camp = makeCampaign(stepWs.id, 'Twelve', { mailboxId: mb, mermaid: lines.join('\n') })

  for (let n = 1; n <= 12; n += 1) {
    out(stepWs.id, {
      campaignId: steps.camp, leadId: makeLead(stepWs.id, 'st'), mailboxId: mb,
      at: '2026-05-05 09:00:00', nodeId: `N${n}`,
      openedAt: n === 3 ? '2026-05-05 10:00:00' : '',
    })
  }
  // A second send on step 3, unopened, so a status filter has something to cut.
  out(stepWs.id, {
    campaignId: steps.camp, leadId: makeLead(stepWs.id, 'st'), mailboxId: mb,
    at: '2026-05-05 09:00:00', nodeId: 'N3',
  })
  // A node that used to exist. Its history must survive the diagram edit.
  out(stepWs.id, {
    campaignId: steps.camp, leadId: makeLead(stepWs.id, 'st'), mailboxId: mb,
    at: '2026-05-05 09:00:00', nodeId: 'GONE',
  })
})

const stepBase = () => `/api/campaigns/${steps.camp}/statistics?sent_time_start_date=2026-05-04&sent_time_end_date=2026-05-08`

test('every send node resolves to exactly one sequence number, and a deleted one is flagged', async () => {
  const res = await stepApi.get(stepBase())
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 13, 'twelve playbook steps plus the node that was deleted')

  const numbers = res.body.data.filter((r) => r.in_playbook).map((r) => r.sequence_number)
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.equal(new Set(numbers).size, 12, 'no sequence number is used twice')

  const gone = res.body.data.find((r) => r.node_id === 'GONE')
  assert.equal(gone.in_playbook, false, 'a step deleted after sending reports its history rather than vanishing')
  assert.equal(gone.sent, 1)
  assert.equal(sum(res.body.data, 'sent'), 14)
})

test('paging covers every step once', async () => {
  const seen = []
  for (const offset of [0, 5, 10]) {
    const res = await stepApi.get(`${stepBase()}&limit=5&offset=${offset}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.limit, 5)
    assert.equal(res.body.offset, offset)
    assert.equal(res.body.total, 13)
    seen.push(...res.body.data.map((r) => r.node_id))
  }
  assert.equal(seen.length, 13, '5, 5 and 3')
  assert.equal(new Set(seen).size, 13, 'no step appears on two pages')
})

test('the step, status and sent-time filters compose', async () => {
  const three = await stepApi.get(`${stepBase()}&email_sequence_number=3`)
  assert.equal(three.status, 200)
  const row = three.body.data.find((r) => r.node_id === 'N3')
  assert.equal(row.sent, 2, 'both sends on step 3')
  assert.equal(sum(three.body.data, 'sent'), 2, 'and nothing from any other step')
  // The counts are right; the row set is not what the spec describes. "Only
  // step 3 is returned" would be one row; Harry returns all twelve playbook
  // steps with eleven of them zeroed — and drops the row for the node deleted
  // from the diagram, which the unfiltered call does return. Pinned as the
  // behaviour that exists, not adjusted to match either reading.
  assert.equal(three.body.data.length, 12)
  assert.equal(three.body.data.filter((r) => r.sent > 0).length, 1)
  assert.equal(three.body.data.some((r) => r.node_id === 'GONE'), false)

  const opened = await stepApi.get(`${stepBase()}&email_sequence_number=3&email_status=opened`)
  assert.equal(opened.status, 200)
  const openedRow = opened.body.data.find((r) => r.node_id === 'N3')
  assert.equal(openedRow.sent, 1, 'one of the two was opened')
  assert.equal(openedRow.opened, 1)
  assert.equal(openedRow.open_rate, 100)
  assert.deepEqual(opened.body.filters, { email_sequence_number: 3, email_status: 'opened' })

  // A window that excludes every send empties the counts without emptying the
  // step list, so the diagram still annotates.
  const elsewhere = await stepApi.get(
    `/api/campaigns/${steps.camp}/statistics?sent_time_start_date=2026-06-01&sent_time_end_date=2026-06-02`
  )
  assert.equal(elsewhere.status, 200)
  assert.equal(sum(elsewhere.body.data, 'sent'), 0)
})

// ============================================================================
// 9. Lead statistics: stable ordering under insertion, and the activity filter
// ============================================================================
//
// campaign-statistics/lead-statistics.md DoD: "stable ordering is proved by a
// test that inserts a lead between two page fetches".

const leadWs = seedUser(db, 'leadstats@example.com')
const leadApi = await mount(register, leadWs)
test.after(() => leadApi.close())

const ls = { ids: [] }

test('seed five leads whose last activity is five different days', () => {
  const mb = makeMailbox(leadWs.id, 'leadstats@harry.test')
  ls.camp = makeCampaign(leadWs.id, 'Ordering', { mailboxId: mb })
  for (let day = 5; day >= 1; day -= 1) {
    const leadId = makeLead(leadWs.id, `d${day}`)
    ls.ids.push(leadId)
    attach(ls.camp, leadId)
    out(leadWs.id, {
      campaignId: ls.camp, leadId, mailboxId: mb,
      at: `2026-05-0${day} 09:00:00`,
    })
  }
})

test('inserting a lead between two page fetches never duplicates or drops a row', async () => {
  const page1 = await leadApi.get(`/api/campaigns/${ls.camp}/leads-statistics?limit=2&offset=0`)
  assert.equal(page1.status, 200)
  assert.equal(page1.body.total, 5)
  assert.deepEqual(page1.body.data.map((r) => r.lead_id), ls.ids.slice(0, 2),
    'newest activity first — the 5th and the 4th')
  assert.equal(page1.body.data[0].sent, 1)

  // A lead arrives mid-scroll whose only activity is older than every row on
  // page one. Offset paging is only stable if the order is total.
  const mb = db.prepare('SELECT id FROM mailboxes WHERE user_id = ?').get(leadWs.id).id
  const late = makeLead(leadWs.id, 'late')
  attach(ls.camp, late)
  out(leadWs.id, { campaignId: ls.camp, leadId: late, mailboxId: mb, at: '2026-04-01 09:00:00' })

  const page2 = await leadApi.get(`/api/campaigns/${ls.camp}/leads-statistics?limit=2&offset=2`)
  assert.equal(page2.body.total, 6)
  assert.deepEqual(page2.body.data.map((r) => r.lead_id), ls.ids.slice(2, 4),
    'the 3rd and the 2nd — no row from page one repeats, none is skipped')

  const page3 = await leadApi.get(`/api/campaigns/${ls.camp}/leads-statistics?limit=2&offset=4`)
  assert.deepEqual(page3.body.data.map((r) => r.lead_id), [ls.ids[4], late],
    'the newcomer lands last, where its activity date puts it')
  assert.equal(page3.body.hasMore, false)

  const past = await leadApi.get(`/api/campaigns/${ls.camp}/leads-statistics?limit=2&offset=6`)
  assert.deepEqual(past.body.data, [], 'paging past the end stops rather than looping')
})

test('event_time_gt keeps only leads active since that date', async () => {
  const res = await leadApi.get(`/api/campaigns/${ls.camp}/leads-statistics?event_time_gt=2026-05-03`)
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 3, 'the 5th, the 4th and the 3rd')
  assert.deepEqual(res.body.data.map((r) => r.lead_id), ls.ids.slice(0, 3))

  const none = await leadApi.get(`/api/campaigns/${ls.camp}/leads-statistics?event_time_gt=2026-06-01`)
  assert.deepEqual(none.body.data, [])
  assert.equal(none.body.total, 0)

  const junk = await leadApi.get(`/api/campaigns/${ls.camp}/leads-statistics?event_time_gt=March 2024`)
  assert.equal(junk.status, 422, 'HARRY-OVER-SPEC: the spec says 400; the parity surface is 422 throughout')
  assert.equal(junk.body.field, 'event_time_gt')
})

// ============================================================================
// 10. Mailbox statistics per campaign: the split, and a revoked mailbox
// ============================================================================
//
// campaign-statistics/mailbox-statistics.md TC-1, TC-9 and TC-10.

const mbWs = seedUser(db, 'mailboxstats@example.com')
const mbApi = await mount(register, mbWs)
test.after(() => mbApi.close())

const mbs = {}

test('seed one campaign sending from three mailboxes with different results', () => {
  mbs.a = makeMailbox(mbWs.id, 'a-heavy@harry.test')
  mbs.b = makeMailbox(mbWs.id, 'b-light@harry.test')
  mbs.c = makeMailbox(mbWs.id, 'c-revoked@harry.test', { provider: 'gmail' })
  mbs.camp = makeCampaign(mbWs.id, 'Split', { mailboxId: mbs.a })
  db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?), (?, ?)')
    .run(mbs.camp, mbs.b, mbs.camp, mbs.c)

  const send = (mailboxId, n, opened = 0) => {
    for (let i = 0; i < n; i += 1) {
      out(mbWs.id, {
        campaignId: mbs.camp, leadId: makeLead(mbWs.id, 'ms'), mailboxId,
        at: '2026-05-05 09:00:00', openedAt: i < opened ? '2026-05-05 10:00:00' : '',
      })
    }
  }
  send(mbs.a, 9, 3)
  send(mbs.b, 4, 1)
  send(mbs.c, 2, 2)
})

test('each mailbox reports its own share, and the shares add up to the campaign', async () => {
  const res = await mbApi.get(`/api/campaigns/${mbs.camp}/mailbox-statistics`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data.map((r) => [r.email, r.sent, r.opened, r.open_rate]), [
    ['a-heavy@harry.test', 9, 3, 33.3],
    ['b-light@harry.test', 4, 1, 25],
    ['c-revoked@harry.test', 2, 2, 100],
  ], 'ordered by volume, and each rate on its own mailbox\'s sends')
  assert.equal(sum(res.body.data, 'sent'), 15)

  const headline = await mbApi.get(`/api/campaigns/${mbs.camp}/analytics`)
  assert.equal(headline.body.data.sent, 15, 'the per-mailbox split and the campaign headline agree')
})

test('a mailbox whose token was revoked keeps its history', async () => {
  db.prepare("UPDATE mailboxes SET status = 'disconnected', refresh_token = '' WHERE id = ?").run(mbs.c)
  const res = await mbApi.get(`/api/campaigns/${mbs.camp}/mailbox-statistics`)
  const row = res.body.data.find((r) => r.mailbox_id === mbs.c)
  assert.equal(row.status, 'disconnected', 'the marker the UI needs')
  assert.equal(row.sent, 2, 'and the numbers are not zeroed with it')
  assert.equal(row.opened, 2)

  const summary = await mbApi.get('/api/analytics/mailboxes/summary')
  assert.equal(summary.body.disconnected, 1)
  assert.equal(summary.body.total, 3)
  assert.equal(summary.body.total_connected, 2)
})

test('paging over the mailbox breakdown stays inside its 1-20 bound', async () => {
  const first = await mbApi.get(`/api/campaigns/${mbs.camp}/mailbox-statistics?limit=2&offset=0`)
  assert.equal(first.body.data.length, 2)
  assert.equal(first.body.hasMore, true)
  const second = await mbApi.get(`/api/campaigns/${mbs.camp}/mailbox-statistics?limit=2&offset=2`)
  assert.equal(second.body.data.length, 1)
  assert.equal(second.body.hasMore, false)
  assert.equal(
    new Set([...first.body.data, ...second.body.data].map((r) => r.mailbox_id)).size, 3,
    'no mailbox on two pages',
  )
})

// ============================================================================
// 11. The reserved needs-attention bucket cannot be produced by a user's label
// ============================================================================
//
// analytics/lead-category-response.md TC-8 and its DoD, plus
// campaign-response-stats.md's "uncategorised, never folded into neutral".

const catWs = seedUser(db, 'categories@example.com')
const catApi = await mount(register, catWs)
test.after(() => catApi.close())

test('seed unclassified replies, replies whose own label is needs_attention, and a custom edge label', () => {
  const mb = makeMailbox(catWs.id, 'categories@harry.test')
  const camp = makeCampaign(catWs.id, 'Labels', { mailboxId: mb })
  const reply = (intent) => inn(catWs.id, {
    campaignId: camp, leadId: makeLead(catWs.id, 'ct'), mailboxId: mb,
    at: '2026-05-05 12:00:00', intent,
  })
  for (let i = 0; i < 3; i += 1) reply('')
  for (let i = 0; i < 2; i += 1) reply('needs_attention')
  reply('send pricing')
})

test('a user\'s own "needs_attention" label is kept apart from the reserved bucket', async () => {
  const res = await catApi.get(`/api/analytics/replies/by-category?${WEEK}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.total_replies, 6)
  assert.deepEqual(res.body.items.map((r) => [r.category, r.total_response, r.share]), [
    ['needs_attention', 3, 50],
    ['needs_attention (intent)', 2, 33.3],
    ['send pricing', 1, 16.7],
  ], 'the classifier\'s three unplaceable replies, and two the user labelled that way on purpose')
  assert.equal(Math.round(sum(res.body.items, 'share') * 10) / 10, 100)

  // Merging the two would have read 5 in one bucket, which is the collision the
  // reserved key exists to prevent.
  assert.notEqual(res.body.items[0].total_response, 5)
})

test('unrecognised intents land in uncategorised, never in neutral', async () => {
  const res = await catApi.get(`/api/analytics/campaigns/response-stats?${WEEK}`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.totals,
    { positive: 0, neutral: 0, negative: 0, uncategorised: 6, total: 6 })
  const row = res.body.items[0]
  assert.equal(row.uncategorised, 6)
  assert.equal(row.uncategorised_reply, 6)
  assert.equal(row.neutral, 0, 'a reply nobody could classify is not a polite brush-off')
})

// ============================================================================
// 12. Contact mix counts lead-campaign pairs, the overview counts leads
// ============================================================================
//
// analytics/lead-stats.md asks for `count.total` to agree with the funnel's
// contacted total. It does — until one person is in two campaigns. Recorded
// here as the number it actually returns rather than the one the spec assumes.

const dupWs = seedUser(db, 'twocampaigns@example.com')
const dupApi = await mount(register, dupWs)
test.after(() => dupApi.close())

test('seed one person mailed by two campaigns in the same week', () => {
  const mb = makeMailbox(dupWs.id, 'two@harry.test')
  const a = makeCampaign(dupWs.id, 'Camp A', { mailboxId: mb })
  const b = makeCampaign(dupWs.id, 'Camp B', { mailboxId: mb })
  const leadId = makeLead(dupWs.id, 'both')
  out(dupWs.id, { campaignId: a, leadId, mailboxId: mb, at: '2026-05-04 09:00:00' })
  out(dupWs.id, { campaignId: b, leadId, mailboxId: mb, at: '2026-05-05 09:00:00' })
})

test('one person in two campaigns is two contacts and one lead', async () => {
  const mix = await dupApi.get(`/api/analytics/leads/contact-mix?${WEEK}`)
  const overview = (await dupApi.get(`/api/analytics/overview?${WEEK}`)).body.overall_stats
  assert.equal(mix.body.total, 2, 'contact mix counts one lead per campaign')
  assert.equal(mix.body.new, 2)
  assert.equal(overview.unique_lead_count, 1, 'the funnel counts the person once')
  // Not an assertion that either is wrong — an assertion that the difference is
  // known and pinned, because lead-stats.md AC7 assumes the two always agree.
  assert.notEqual(mix.body.total, overview.unique_lead_count)
})

// ============================================================================
// 13. The campaign headline cache invalidates on the next send, reply or outcome
// ============================================================================
//
// campaign-statistics/top-level.md DoD, which nothing tested.

const cacheWs = seedUser(db, 'cache@example.com')
const cacheApi = await mount(register, cacheWs)
test.after(() => cacheApi.close())

const cache = {}

test('seed a campaign with one send', () => {
  cache.mb = makeMailbox(cacheWs.id, 'cache@harry.test')
  cache.camp = makeCampaign(cacheWs.id, 'Cached', { mailboxId: cache.mb })
  cache.lead = makeLead(cacheWs.id, 'cc')
  attach(cache.camp, cache.lead)
  out(cacheWs.id, { campaignId: cache.camp, leadId: cache.lead, mailboxId: cache.mb, at: '2026-05-04 09:00:00' })
})

test('a second read is served from cache, and a new send invalidates it', async () => {
  const first = await cacheApi.get(`/api/campaigns/${cache.camp}/analytics`)
  assert.equal(first.status, 200)
  assert.equal(first.body.cached, false)
  assert.equal(first.body.data.sent, 1)

  const again = await cacheApi.get(`/api/campaigns/${cache.camp}/analytics`)
  assert.equal(again.body.cached, true, 'nothing changed, so nothing was recomputed')
  assert.equal(again.body.data.sent, 1)

  out(cacheWs.id, { campaignId: cache.camp, leadId: cache.lead, mailboxId: cache.mb, at: '2026-05-05 09:00:00' })
  const afterSend = await cacheApi.get(`/api/campaigns/${cache.camp}/analytics`)
  assert.equal(afterSend.body.cached, false, 'the next send invalidates without anyone remembering to')
  assert.equal(afterSend.body.data.sent, 2)
})

test('an outcome reached with no new message also invalidates', async () => {
  await cacheApi.get(`/api/campaigns/${cache.camp}/analytics`)
  const warm = await cacheApi.get(`/api/campaigns/${cache.camp}/analytics`)
  assert.equal(warm.body.cached, true)
  assert.equal(warm.body.data.won, 0)

  db.prepare("UPDATE campaign_leads SET outcome = 'won', completed_at = '2026-05-06 09:00:00', updated_at = '2026-05-06 09:00:00' WHERE campaign_id = ? AND lead_id = ?")
    .run(cache.camp, cache.lead)

  const after = await cacheApi.get(`/api/campaigns/${cache.camp}/analytics`)
  assert.equal(after.body.cached, false, 'a win with no new email still moves the headline')
  assert.equal(after.body.data.won, 1)
  assert.equal(after.body.data.by_stage.won, 1, 'the stage is derived, never stored')
})

// ============================================================================
// 14. The two pickers: campaigns and clients
// ============================================================================
//
// analytics/campaign-list.md TC-7/TC-8 and client-list.md TC-3/TC-9.

const pickWs = seedUser(db, 'pickers@example.com')
const pickOther = seedUser(db, 'pickers-rival@example.com')
const pickApi = await mount(register, pickWs)
test.after(() => pickApi.close())

const pick = {}

test('seed duplicate campaign names, two clients and a deleted one', () => {
  const mb = makeMailbox(pickWs.id, 'pickers@harry.test')
  pick.acme = makeClient(pickWs.id, 'Acme')
  pick.beta = makeClient(pickWs.id, 'Beta')
  pick.gone = makeClient(pickWs.id, 'Deleted Ltd', { deleted: true })
  pick.foreign = makeClient(pickOther.id, 'Rival Ltd')

  pick.c1 = makeCampaign(pickWs.id, 'Q1 Cold Outreach', { mailboxId: mb, clientId: pick.acme })
  pick.c2 = makeCampaign(pickWs.id, 'Q1 Cold Outreach', { mailboxId: mb, clientId: pick.beta })
  pick.c3 = makeCampaign(pickWs.id, 'Zebra', { mailboxId: mb })
})

test('two campaigns with one name stay distinguishable, because selection is keyed on id', async () => {
  const res = await pickApi.get('/api/analytics/campaigns')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data.campaign_list, [
    { id: pick.c1, name: 'Q1 Cold Outreach' },
    { id: pick.c2, name: 'Q1 Cold Outreach' },
    { id: pick.c3, name: 'Zebra' },
  ], 'sorted by name, and by id where the names tie')
  for (const row of res.body.items) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name'], 'ids and names, nothing heavier')
  }

  const byClient = await pickApi.get(`/api/analytics/campaigns?client_ids=${pick.beta}`)
  assert.deepEqual(byClient.body.items.map((r) => r.id), [pick.c2],
    'the two same-named campaigns are told apart by their client')

  const both = await pickApi.get(`/api/analytics/campaigns?client_ids=${pick.acme},${pick.beta}`)
  assert.equal(both.body.items.length, 2, 'and the unassigned campaign is not swept in')

  const byId = await pickApi.get(`/api/analytics/campaigns?ids=${pick.c2},${pick.c3}`)
  assert.deepEqual(byId.body.items.map((r) => r.id), [pick.c2, pick.c3])

  const someoneElses = await pickApi.get(`/api/analytics/campaigns?client_ids=${pick.foreign}`)
  assert.equal(someoneElses.status, 200, 'a filter that 404s would confirm the client exists')
  assert.deepEqual(someoneElses.body.items, [])
})

test('the client list omits a deleted client and never reaches another workspace', async () => {
  const res = await pickApi.get('/api/analytics/clients')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data.client_list, [
    { id: pick.acme, name: 'Acme' },
    { id: pick.beta, name: 'Beta' },
  ], 'the soft-deleted client is gone from the picker')
  assert.ok(!JSON.stringify(res.body).includes('Rival'))
  assert.ok(!JSON.stringify(res.body).includes('Deleted Ltd'))

  const filtered = await pickApi.get(`/api/analytics/clients?client_ids=${pick.beta}`)
  assert.deepEqual(filtered.body.items.map((c) => c.id), [pick.beta])

  const junk = await pickApi.get('/api/analytics/clients?client_ids=1,,abc')
  assert.equal(junk.status, 422)
  assert.equal(junk.body.field, 'client_ids')
})

test('client-list.md TC-9 cannot happen: two clients may not share a name in one workspace', () => {
  // Recorded rather than worked around. The spec's test case seeds two clients
  // both called "Acme" and expects both in the picker; `clients` carries
  // UNIQUE (workspace_id, name), so the second insert never lands. The picker's
  // id-keyed selection is still proved above by the two same-named campaigns.
  assert.throws(() => makeClient(pickWs.id, 'Acme'), /UNIQUE constraint failed/)
  // And a soft-deleted client still holds its name, so the name cannot be
  // reused until the row is really gone.
  assert.throws(() => makeClient(pickWs.id, 'Deleted Ltd'), /UNIQUE constraint failed/)
})

// ============================================================================
// 15. Monthly active clients: a gap month is a zero, not a missing bar
// ============================================================================
//
// analytics/month-wise-client-count.md TC-7, TC-10 and TC-11.

const monthWs = seedUser(db, 'monthly@example.com')
const monthApi = await mount(register, monthWs)
test.after(() => monthApi.close())

const month = {}

// Month keys relative to the machine's today, so the series is deterministic
// wherever it runs.
const monthKey = (back) => {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
  return d.toISOString().slice(0, 7)
}
const firstOfMonth = (back) => `${monthKey(back)}-15 09:00:00`

test('seed a client trading two months ago and this month, and another only this month', () => {
  const mb = makeMailbox(monthWs.id, 'monthly@harry.test')
  month.steady = makeClient(monthWs.id, 'Steady Ltd')
  month.newcomer = makeClient(monthWs.id, 'Newcomer Ltd')
  const steadyCamp = makeCampaign(monthWs.id, 'Steady work', { mailboxId: mb, clientId: month.steady })
  const newCamp = makeCampaign(monthWs.id, 'New work', { mailboxId: mb, clientId: month.newcomer })

  out(monthWs.id, { campaignId: steadyCamp, leadId: makeLead(monthWs.id, 'sd'), mailboxId: mb, at: firstOfMonth(2) })
  out(monthWs.id, { campaignId: steadyCamp, leadId: makeLead(monthWs.id, 'sd'), mailboxId: mb, at: firstOfMonth(0) })
  out(monthWs.id, { campaignId: newCamp, leadId: makeLead(monthWs.id, 'nc'), mailboxId: mb, at: firstOfMonth(0) })
})

test('the quiet month in the middle is a zero, and the series is in order', async () => {
  const res = await monthApi.get('/api/analytics/clients/monthly-active?months=6&timezone=UTC')
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 6)
  assert.deepEqual(res.body.items.map((m) => m.month),
    [5, 4, 3, 2, 1, 0].map(monthKey), 'chronological, and every month present')

  const by = new Map(res.body.items.map((m) => [m.month, m.count]))
  assert.equal(by.get(monthKey(2)), 1, 'Steady traded')
  assert.equal(by.get(monthKey(1)), 0, 'a gap in trading is visible, not skipped')
  assert.equal(by.get(monthKey(0)), 2, 'both clients traded')
  assert.equal(sum(res.body.items, 'count'), 3)

  const one = await monthApi.get(`/api/analytics/clients/monthly-active?months=6&timezone=UTC&client_ids=${month.newcomer}`)
  const byOne = new Map(one.body.items.map((m) => [m.month, m.count]))
  assert.equal(byOne.get(monthKey(2)), 0, 'the newcomer was not trading then')
  assert.equal(byOne.get(monthKey(0)), 1)
  assert.equal(sum(one.body.items, 'count'), 1, 'one client\'s continuity, not the workspace\'s')
})

test('the window is bounded, and asking past the bound is a 422', async () => {
  const res = await monthApi.get('/api/analytics/clients/monthly-active?months=61')
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'months')

  const dflt = await monthApi.get('/api/analytics/clients/monthly-active')
  assert.equal(dflt.body.months, 24, 'twenty-four months by default, said in the payload')
  assert.equal(dflt.body.items.length, 24)
})

// ============================================================================
// 16. Nothing in this module writes
// ============================================================================

test('none of the twenty-four routes writes an events row', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM events').get().n
  for (const path of [
    `/api/analytics/overview?${WEEK}`,
    `/api/analytics/daily?${WEEK}&timezone=UTC`,
    `/api/analytics/daily?axis=sent&${WEEK}&timezone=UTC`,
    `/api/analytics/positive-replies/daily?${WEEK}&timezone=UTC`,
    `/api/analytics/campaigns/performance?${WEEK}`,
    `/api/analytics/campaigns/response-stats?${WEEK}`,
    '/api/analytics/campaigns/status-counts',
    '/api/analytics/campaigns',
    '/api/analytics/clients',
    '/api/analytics/clients/monthly-active',
    `/api/analytics/replies/by-category?${WEEK}`,
    `/api/analytics/leads/contact-mix?${WEEK}`,
    `/api/analytics/followup-reply-rate?${WEEK}`,
    `/api/analytics/mailboxes/health?${WEEK}`,
    `/api/analytics/mailboxes/domains?${WEEK}`,
    `/api/analytics/mailboxes/providers?${WEEK}`,
    '/api/analytics/mailboxes/summary',
    `/api/campaigns/${fix.camp}/analytics`,
    `/api/campaigns/${fix.camp}/analytics-by-date`,
    `/api/campaigns/${fix.camp}/top-level-analytics-by-date?start_date=2026-05-04&end_date=2026-05-08`,
    `/api/campaigns/${fix.camp}/statistics`,
    `/api/campaigns/${fix.camp}/leads-statistics`,
    `/api/campaigns/${fix.camp}/mailbox-statistics`,
  ]) {
    const res = await api.get(path)
    assert.equal(res.status, 200, `${path} answered ${res.status}`)
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, before, 'reads are reads')
})
