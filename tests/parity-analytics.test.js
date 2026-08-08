// Analytics + campaign-statistics parity module.
//
// The things worth proving here are the ones a reporting bug hides behind: an
// empty workspace must return zeros rather than NaN, a chart series must carry
// a row for every day in the window, and another workspace's sends must never
// reach a rollup.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, seedMessage, mount } from './helpers/parity-harness.js'

setup('analytics')                 // MUST precede any ../server import
const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/analytics.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// ---- fixtures ---------------------------------------------------------------

const DAY = 86400000
const dayKey = (d) => new Date(d).toISOString().slice(0, 10)
const stamp = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ')

const T0 = Date.parse('2026-03-10T09:00:00Z')   // a fixed week, so the assertions are arithmetic
const D1 = dayKey(T0)
const D3 = dayKey(T0 + 2 * DAY)

function at(id, when) {
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(stamp(when), id)
}

// Empty-workspace assertions run first, before anything is seeded.
test('empty workspace returns zeros, never NaN or Infinity', async () => {
  const res = await client.get(`/api/analytics/overview?from=${D1}&to=${D3}`)
  assert.equal(res.status, 200)
  const s = res.body.overall_stats
  for (const key of ['sent', 'replied', 'unique_lead_count', 'positive_replied', 'bounced']) {
    assert.equal(s[key], 0, `${key} should be 0`)
  }
  for (const key of ['open_rate', 'reply_rate', 'positive_reply_rate', 'bounce_rate', 'bounce_share', 'leads_per_reply']) {
    assert.equal(s[key], 0, `${key} should be 0, got ${s[key]}`)
    assert.ok(Number.isFinite(s[key]), `${key} must be finite`)
  }

  const mix = await client.get(`/api/analytics/leads/contact-mix?from=${D1}&to=${D3}`)
  assert.equal(mix.body.total, 0)
  assert.equal(mix.body.new_share, 0)
  assert.equal(mix.body.follow_up_share, 0)

  const cats = await client.get(`/api/analytics/replies/by-category?from=${D1}&to=${D3}`)
  assert.deepEqual(cats.body.items, [])

  const followup = await client.get(`/api/analytics/followup-reply-rate?from=${D1}&to=${D3}`)
  assert.equal(followup.body.rate, 0)

  const monthly = await client.get('/api/analytics/clients/monthly-active')
  assert.deepEqual(monthly.body.items, [], 'no clients means no rows, not 24 zeros')
})

// ---- seed -------------------------------------------------------------------
// Owner: one campaign, one mailbox, three leads. Ada is contacted twice and
// replies positively; Grace is contacted once and never replies; Alan bounces.
const mailbox = seedMailbox(db, owner.id, 'sender@harry.test')
const campaign = seedCampaign(db, owner.id, 'Q3 outbound', mailbox.id)
const ada = seedLead(db, owner.id, 'ada@acme.test')
const grace = seedLead(db, owner.id, 'grace@acme.test', { first_name: 'Grace' })
const alan = seedLead(db, owner.id, 'alan@acme.test', { first_name: 'Alan' })

// Stranger's workspace: same shape, entirely separate.
const otherMailbox = seedMailbox(db, stranger.id, 'other@rival.test')
const otherCampaign = seedCampaign(db, stranger.id, 'Rival blast', otherMailbox.id)
const otherLead = seedLead(db, stranger.id, 'lead@rival.test')

test('seed', () => {
  const send = (leadId, when, extra = {}) => {
    const m = seedMessage(db, owner.id, {
      campaignId: campaign.id, leadId, mailboxId: mailbox.id, direction: 'out',
      subject: 'Hello', from_email: 'sender@harry.test', to_email: 'x@acme.test',
    })
    at(m.id, when)
    if (Object.keys(extra).length) {
      const sets = Object.keys(extra).map((k) => `${k} = ?`).join(', ')
      db.prepare(`UPDATE messages SET ${sets} WHERE id = ?`).run(...Object.values(extra), m.id)
    }
    return m
  }
  const reply = (leadId, when, intent) => {
    const m = seedMessage(db, owner.id, {
      campaignId: campaign.id, leadId, mailboxId: mailbox.id, direction: 'in', intent,
    })
    at(m.id, when)
    return m
  }

  // Day 1: three sends, one of them opened.
  send(ada.id, T0, { opened_at: stamp(T0 + 3600000) })
  send(grace.id, T0)
  send(alan.id, T0, { send_status: 'bounced' })
  // Day 3: one follow-up to Ada, and Ada replies interested (twice, same day).
  send(ada.id, T0 + 2 * DAY)
  reply(ada.id, T0 + 2 * DAY + 3600000, 'interested')
  reply(ada.id, T0 + 2 * DAY + 7200000, 'interested')
  db.prepare("UPDATE leads SET status = 'bounced' WHERE id = ?").run(alan.id)

  for (const leadId of [ada.id, grace.id, alan.id]) {
    db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, state) VALUES (?, ?, ?)')
      .run(campaign.id, leadId, 'active')
  }

  // The stranger's workspace sends on the very same days.
  const om = seedMessage(db, stranger.id, {
    campaignId: otherCampaign.id, leadId: otherLead.id, mailboxId: otherMailbox.id, direction: 'out',
  })
  at(om.id, T0)
  const or_ = seedMessage(db, stranger.id, {
    campaignId: otherCampaign.id, leadId: otherLead.id, mailboxId: otherMailbox.id,
    direction: 'in', intent: 'interested',
  })
  at(or_.id, T0 + DAY)
})

// ---- counts -----------------------------------------------------------------

test('seeded workspace returns correct counts and Harry\'s rate definitions', async () => {
  const res = await client.get(`/api/analytics/overview?from=${D1}&to=${D3}`)
  const s = res.body.overall_stats
  assert.equal(s.sent, 4)
  assert.equal(s.opened, 1)
  assert.equal(s.bounced, 1, 'one send carries send_status=bounced')
  assert.equal(s.replied, 2, 'reply events')
  assert.equal(s.replied_leads, 1, 'distinct leads that replied')
  assert.equal(s.unique_lead_count, 3, 'three distinct leads contacted, Ada counted once')
  assert.equal(s.positive_replied, 1)
  assert.equal(s.bounced_leads, 1)

  // Exactly the definitions in GET /analytics: distinct replied leads over
  // distinct contacted leads, opens over emails sent, one decimal place.
  assert.equal(s.reply_rate, Math.round((1 / 3) * 1000) / 10)
  assert.equal(s.open_rate, 25)
  assert.equal(s.positive_reply_rate, Math.round((1 / 3) * 1000) / 10)
  assert.equal(s.bounce_rate, Math.round((1 / 3) * 1000) / 10, 'per lead contacted')
  assert.equal(s.bounce_share, 25, 'per email sent')
  assert.equal(s.leads_per_reply, 3)
})

test('per-campaign performance agrees with the workspace total', async () => {
  const res = await client.get(`/api/analytics/campaigns/performance?from=${D1}&to=${D3}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 1)
  const row = res.body.items[0]
  assert.equal(row.campaign_id, campaign.id)
  assert.equal(row.sent, 4)
  assert.equal(row.reply_rate, res.body.workspace.reply_rate)
  assert.equal(row.leads_per_reply, 3)
  assert.equal(row.sample_size, 3)
  assert.equal(typeof res.body.limit, 'number', 'list responses page server-side')
})

test('reply categories and sentiment buckets', async () => {
  const cats = await client.get(`/api/analytics/replies/by-category?from=${D1}&to=${D3}`)
  assert.deepEqual(cats.body.items, [{ category: 'interested', total_response: 2, share: 100 }])

  const resp = await client.get(`/api/analytics/campaigns/response-stats?from=${D1}&to=${D3}`)
  assert.equal(resp.body.counting, 'reply_events')
  assert.equal(resp.body.totals.positive, 2)
  assert.equal(resp.body.totals.negative, 0)
  assert.equal(resp.body.items[0].positive, 2)
})

test('contact mix splits new from follow-up on first-touch date', async () => {
  // The whole window: all three leads are new inside it.
  const all = await client.get(`/api/analytics/leads/contact-mix?from=${D1}&to=${D3}`)
  assert.equal(all.body.total, 3)
  assert.equal(all.body.new, 3)
  assert.equal(all.body.follow_up, 0)

  // Day 3 alone: Ada's only touch in the window is a chase.
  const later = await client.get(`/api/analytics/leads/contact-mix?from=${D3}&to=${D3}`)
  assert.equal(later.body.total, 1)
  assert.equal(later.body.new, 0)
  assert.equal(later.body.follow_up, 1)
})

test('reply-time distribution counts a lead once and returns every bucket', async () => {
  const res = await client.get(`/api/analytics/reply-time-distribution?from=${D1}&to=${D3}`)
  assert.equal(res.body.buckets.length, 6)
  assert.deepEqual(res.body.buckets.map((b) => b.bucket), ['0-1h', '1-6h', '6-24h', '1-3d', '3-7d', '7d+'])
  // Ada replied twice; only her first reply, one hour after the day-3 send, counts.
  assert.equal(res.body.total, 1)
  assert.equal(res.body.buckets.find((b) => b.bucket === '1-6h').count, 1)
  assert.equal(res.body.buckets.find((b) => b.bucket === '0-1h').count, 0)
})

// ---- dense series -----------------------------------------------------------

test('day-wise series is dense: a silent day is a zero row, not a gap', async () => {
  const res = await client.get(`/api/analytics/daily?from=${D1}&to=${D3}&timezone=UTC`)
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 3, 'three days requested, three rows returned')
  assert.deepEqual(res.body.items.map((d) => d.day), [D1, dayKey(T0 + DAY), D3])
  assert.equal(res.body.items[0].sent, 3)
  assert.equal(res.body.items[1].sent, 0, 'the silent middle day is present and zero')
  assert.equal(res.body.items[1].replied, 0)
  assert.equal(res.body.items[2].sent, 1)
  assert.equal(res.body.items[2].replied, 2)
  assert.deepEqual(res.body.metadata.non_additive, ['unique_lead_reached'])

  // Same for positive replies, on both axes.
  const pos = await client.get(`/api/analytics/positive-replies/daily?from=${D1}&to=${D3}&timezone=UTC`)
  assert.equal(pos.body.items.length, 3)
  assert.equal(pos.body.items[2].count, 1, 'distinct leads, so two replies from Ada count once')
  assert.equal(pos.body.items[2].reply_events, 2)

  const bySend = await client.get(`/api/analytics/positive-replies/daily?axis=sent&from=${D1}&to=${D3}&timezone=UTC`)
  assert.equal(bySend.body.axis, 'sent')
  assert.equal(bySend.body.items.length, 3)
  assert.equal(bySend.body.items[2].count, 1, 'attributed to the day-3 send that earned it')

  // Per-campaign daily series is dense too.
  const camp = await client.get(`/api/campaigns/${campaign.id}/analytics-by-date?start_date=${D1}&end_date=${D3}&time_zone=UTC`)
  assert.equal(camp.status, 200)
  assert.equal(camp.body.ok, true)
  assert.equal(camp.body.data.length, 3)
  assert.equal(camp.body.data[1].sent, 0)
})

// ---- validation -------------------------------------------------------------

test('an inverted date range is a 422 naming the field', async () => {
  const res = await client.get(`/api/analytics/overview?from=${D3}&to=${D1}`)
  assert.equal(res.status, 422)
  assert.equal(res.body.error, 'validation_failed')
  assert.equal(res.body.field, 'from')

  // The campaign-statistics routes use the documented parameter names, and the
  // 422 names the parameter the caller actually sent.
  const ranged = await client.get(
    `/api/campaigns/${campaign.id}/top-level-analytics-by-date?start_date=${D3}&end_date=${D1}`
  )
  assert.equal(ranged.status, 422)
  assert.equal(ranged.body.field, 'start_date')
})

test('an unknown timezone is a 422 naming timezone', async () => {
  const res = await client.get(`/api/analytics/daily?from=${D1}&to=${D3}&timezone=Mars/Olympus_Mons`)
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'timezone')

  const camp = await client.get(
    `/api/campaigns/${campaign.id}/analytics-by-date?start_date=${D1}&end_date=${D3}&time_zone=Nowhere/Nothing`
  )
  assert.equal(camp.status, 422)
  assert.equal(camp.body.field, 'time_zone')

  // A real zone is accepted.
  const ok = await client.get(`/api/analytics/daily?from=${D1}&to=${D3}&timezone=America/New_York`)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.range.timezone, 'America/New_York')
})

test('the sent axis insists on a timezone, since the bucket depends on it', async () => {
  const res = await client.get(`/api/analytics/daily?axis=sent&from=${D1}&to=${D3}`)
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'timezone')
})

test('malformed dates, oversized ranges and unknown axes are all 422s', async () => {
  const bad = await client.get('/api/analytics/overview?from=10-03-2026&to=2026-03-12')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'from')

  const huge = await client.get('/api/analytics/overview?from=2020-01-01&to=2026-01-01')
  assert.equal(huge.status, 422)
  assert.equal(huge.body.field, 'to')

  const axis = await client.get(`/api/analytics/daily?axis=sideways&from=${D1}&to=${D3}`)
  assert.equal(axis.status, 422)
  assert.equal(axis.body.field, 'axis')

  const missing = await client.get(`/api/campaigns/${campaign.id}/top-level-analytics-by-date?end_date=${D3}`)
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'start_date')
})

// ---- isolation --------------------------------------------------------------

test('a cross-workspace campaign id 404s and leaks nothing', async () => {
  const filtered = await client.get(`/api/analytics/overview?from=${D1}&to=${D3}&campaign_ids=${otherCampaign.id}`)
  assert.equal(filtered.status, 404)
  assert.equal(filtered.body.error, 'not_found')
  assert.ok(!JSON.stringify(filtered.body).includes('Rival'), 'the 404 never echoes the campaign')

  for (const path of [
    `/api/campaigns/${otherCampaign.id}/analytics`,
    `/api/campaigns/${otherCampaign.id}/statistics`,
    `/api/campaigns/${otherCampaign.id}/leads-statistics`,
    `/api/campaigns/${otherCampaign.id}/mailbox-statistics`,
    `/api/campaigns/${otherCampaign.id}/analytics-by-date`,
    `/api/campaigns/${otherCampaign.id}/top-level-analytics-by-date?start_date=${D1}&end_date=${D3}`,
  ]) {
    const res = await client.get(path)
    assert.equal(res.status, 404, `${path} should 404`)
    assert.ok(!JSON.stringify(res.body).includes('Rival'), `${path} leaked the campaign name`)
  }

  const missing = await client.get('/api/campaigns/999999/analytics')
  assert.equal(missing.status, 404, 'a missing campaign is indistinguishable from a foreign one')
})

test('another workspace never appears in a rollup', async () => {
  const overview = await client.get(`/api/analytics/overview?from=${D1}&to=${D3}`)
  assert.equal(overview.body.overall_stats.sent, 4, 'the stranger\'s send on day 1 is not counted')
  assert.equal(overview.body.overall_stats.unique_lead_count, 3)

  const picker = await client.get('/api/analytics/campaigns')
  assert.deepEqual(picker.body.items, [{ id: campaign.id, name: 'Q3 outbound' }])

  const health = await client.get(`/api/analytics/mailboxes/health?from=${D1}&to=${D3}`)
  assert.equal(health.body.items.length, 1)
  assert.equal(health.body.items[0].email, 'sender@harry.test')

  const domains = await client.get(`/api/analytics/mailboxes/domains?from=${D1}&to=${D3}`)
  assert.deepEqual(domains.body.items.map((d) => d.domain), ['harry.test'])

  const providers = await client.get(`/api/analytics/mailboxes/providers?from=${D1}&to=${D3}`)
  assert.equal(providers.body.overall.length, 1)
  assert.equal(providers.body.overall[0].sent, 4)

  const team = await client.get(`/api/analytics/team?from=${D1}&to=${D3}`)
  assert.deepEqual(team.body.items.map((m) => m.email), ['owner@example.com'])

  const statuses = await client.get('/api/analytics/campaigns/status-counts')
  assert.equal(statuses.body.campaigns_total, 1)
})

// ---- mailbox and campaign detail -------------------------------------------

test('a silent mailbox is returned with zeros rather than absence', async () => {
  const quiet = seedMailbox(db, owner.id, 'quiet@harry.test')
  const res = await client.get(`/api/analytics/mailboxes/health?from=${D1}&to=${D3}`)
  const row = res.body.items.find((m) => m.mailbox_id === quiet.id)
  assert.ok(row, 'the silent mailbox is present')
  assert.equal(row.sent, 0)
  assert.equal(row.open_rate, 0)
  assert.equal(row.is_sandbox, true)

  // Domains, by contrast, omit a domain with no sends at all.
  const domains = await client.get(`/api/analytics/mailboxes/domains?from=${D1}&to=${D3}`)
  assert.equal(domains.body.items.length, 1)

  const summary = await client.get('/api/analytics/mailboxes/summary')
  assert.equal(summary.body.total, 2)
  assert.equal(summary.body.sandbox, 2)
  assert.equal(summary.body.enabled_without_warmup, 0, 'sandbox mailboxes are excluded')
  db.prepare('DELETE FROM mailboxes WHERE id = ?').run(quiet.id)
})

test('campaign headline, per-step and per-lead statistics', async () => {
  const top = await client.get(`/api/campaigns/${campaign.id}/analytics`)
  assert.equal(top.status, 200)
  assert.equal(top.body.ok, true)
  assert.equal(top.body.data.sent, 4)
  assert.equal(top.body.data.leads_total, 3)
  assert.ok(top.body.data.by_stage, 'stages are derived, not stored')

  // The unranged route and a range covering the campaign's whole life agree.
  const ranged = await client.get(
    `/api/campaigns/${campaign.id}/top-level-analytics-by-date?start_date=${D1}&end_date=${D3}`
  )
  assert.equal(ranged.body.data.sent, top.body.data.sent)
  assert.equal(ranged.body.data.reply_rate, top.body.data.reply_rate)

  const steps = await client.get(`/api/campaigns/${campaign.id}/statistics`)
  assert.equal(steps.body.ok, true)
  assert.equal(steps.body.limit, 100)
  assert.equal(typeof steps.body.offset, 'number')

  const leads = await client.get(`/api/campaigns/${campaign.id}/leads-statistics`)
  assert.equal(leads.body.ok, true)
  assert.equal(leads.body.data.length, 3)
  assert.ok(leads.body.data.every((r) => typeof r.stage === 'string'))
  const adaRow = leads.body.data.find((r) => r.lead_id === ada.id)
  assert.equal(adaRow.sent, 2)
  assert.equal(adaRow.replied, 2)

  const boxes = await client.get(`/api/campaigns/${campaign.id}/mailbox-statistics`)
  assert.equal(boxes.body.ok, true)
  assert.equal(boxes.body.range.applied, 'default')
  assert.equal(boxes.body.data[0].sent, 4)

  // A half-specified range falls back to the campaign's whole life and says so.
  const partial = await client.get(`/api/campaigns/${campaign.id}/mailbox-statistics?start_date=${D3}`)
  assert.equal(partial.body.range.applied, 'campaign')
  assert.equal(partial.body.data[0].sent, 4)
})

test('paging is bounded and an over-large limit is refused', async () => {
  const res = await client.get('/api/analytics/campaigns?limit=1&offset=0')
  assert.equal(res.body.items.length, 1)
  assert.equal(res.body.hasMore, false)

  const tooBig = await client.get(`/api/campaigns/${campaign.id}/leads-statistics?limit=5000`)
  assert.equal(tooBig.status, 422)
  assert.equal(tooBig.body.field, 'limit')
})

test('reads write no events rows', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM events WHERE user_id = ?').get(owner.id).n
  await client.get(`/api/analytics/overview?from=${D1}&to=${D3}`)
  await client.get(`/api/analytics/daily?from=${D1}&to=${D3}&timezone=UTC`)
  await client.get(`/api/campaigns/${campaign.id}/analytics`)
  const after = db.prepare('SELECT COUNT(*) n FROM events WHERE user_id = ?').get(owner.id).n
  assert.equal(after, before)
})

// ===========================================================================
// Regression tests for the audit findings in Docs/REQUIREMENTS-MATRIX.md.
//
// Every one of these asserts a number, not a shape. The defects they cover all
// survived a shape test: the route answered 200 with the right keys while the
// arithmetic was wrong or the filter was silently returning nothing.
// ===========================================================================

// ------------------------------------- analytics/client-performance.md ------

// TC-9 needs a client whose numbers make the two candidate formulas visibly
// different, so it gets its own workspace rather than perturbing the fixture
// every assertion above depends on.
const acme = seedUser(db, 'acme@example.com')
const acmeClient = await mount(register, acme)
test.after(() => acmeClient.close())

const C1 = '2026-01-05'
const C2 = '2026-01-25'

test('seed a client with 900 contacted leads and 40 positive replies', () => {
  db.prepare("INSERT INTO clients (workspace_id, name) VALUES (?, 'Acme Corp')").run(acme.id)
  const client_ = db.prepare('SELECT * FROM clients WHERE workspace_id = ?').get(acme.id)
  const mb = seedMailbox(db, acme.id, 'acme-sender@harry.test')
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid, client_id) VALUES (?, 'Acme Q1', 'running', ?, '', ?)")
    .run(acme.id, mb.id, client_.id)
  const camp = db.prepare('SELECT * FROM campaigns WHERE user_id = ?').get(acme.id)

  const insertLead = db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (?, ?, ?)')
  const insertLink = db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, state) VALUES (?, ?, ?)')
  const insertMsg = db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, intent, created_at)
     VALUES (?, ?, ?, ?, ?, 'Hi', ?, ?)`
  )
  db.transaction(() => {
    for (let i = 0; i < 900; i++) {
      const leadId = insertLead.run(acme.id, `acme${i}@leads.test`, `Lead${i}`).lastInsertRowid
      insertLink.run(camp.id, leadId, 'active')
      insertMsg.run(acme.id, camp.id, leadId, mb.id, 'out', '', `${C1} 09:00:00`)
      // Forty of them reply positively; the rest say nothing at all.
      if (i < 40) insertMsg.run(acme.id, camp.id, leadId, mb.id, 'in', 'interested', `${C1} 12:00:00`)
    }
  })()
})

test('client_health is positive replies per contacted lead, not the non-bounce share', async () => {
  const res = await acmeClient.get(`/api/analytics/clients/performance?from=${C1}&to=${C2}`)
  assert.equal(res.status, 200)
  const row = res.body.items[0]
  assert.equal(row.client_name, 'Acme Corp')
  assert.equal(row.unique_lead_count, 900)
  assert.equal(row.positive_replied, 40)

  // The whole finding: the code computed (sent − bounced) / sent, so a client
  // with 40 positive replies across 900 leads scored 100% healthy. TC-9 says
  // this reads about 4.4%.
  assert.equal(row.client_health, 4.4)
  assert.equal(row.client_health_formula, 'positive_replied / unique_lead_count')
  assert.notEqual(row.client_health, 100)
  // The old number survives under a name that says what it measures, so the
  // deliverability signal is not lost — only the label was ever wrong.
  assert.equal(row.non_bounce_rate, 100)

  // "campaigns that sent in this range".
  assert.equal(row.total_campaigns_count, 1)
  assert.equal(row.campaign_stats.client_health, row.client_health)
  assert.equal(res.body.data.client_wise_performance[0].client_id, row.client_id)

  // A range with no sends leaves the client present and zeroed rather than
  // missing, and a zero denominator is 0 — never NaN.
  const quiet = await acmeClient.get('/api/analytics/clients/performance?from=2026-02-01&to=2026-02-10')
  const quietRow = quiet.body.items[0]
  assert.equal(quietRow.unique_lead_count, 0)
  assert.equal(quietRow.total_campaigns_count, 0)
  assert.equal(quietRow.client_health, 0)
  assert.ok(Number.isFinite(quietRow.client_health))
})

// ------------------------------------ campaign-statistics/get-by-id.md ------

test('email_status filters on what actually happened, not on send_status', async () => {
  // The seeded history sits in a fixed March week, so the window is explicit:
  // the route's default range is the last thirty days and would find nothing.
  const base = `/api/campaigns/${campaign.id}/statistics?sent_time_start_date=${D1}&sent_time_end_date=${D3}`
  const sentOf = (body) => body.data.reduce((sum, r) => sum + r.sent, 0)

  const unfiltered = await client.get(base)
  assert.equal(sentOf(unfiltered.body), 4)

  // Each of these compared against `messages.send_status` — whose values are
  // 'sent', 'bounced', 'test', 'scheduled' — so all four silently returned
  // zero rows on every campaign in the product.
  const opened = await client.get(`${base}&email_status=opened`)
  assert.equal(opened.status, 200)
  assert.equal(sentOf(opened.body), 1, 'one send was opened')

  const replied = await client.get(`${base}&email_status=replied`)
  assert.equal(sentOf(replied.body), 1, 'one send earned the reply')

  const bounced = await client.get(`${base}&email_status=bounced`)
  assert.equal(sentOf(bounced.body), 1)

  const clicked = await client.get(`${base}&email_status=clicked`)
  assert.equal(sentOf(clicked.body), 0, 'nothing was clicked, and that is a real zero')

  const nonsense = await client.get(`${base}&email_status=delivered`)
  assert.equal(nonsense.status, 422)
  assert.equal(nonsense.body.field, 'email_status')
})

test('per-step rows carry campaign_id and unsubscribed, and the bounds are the documented ones', async () => {
  const base = `/api/campaigns/${campaign.id}/statistics?sent_time_start_date=${D1}&sent_time_end_date=${D3}`
  const res = await client.get(base)
  assert.ok(res.body.data.length > 0)
  for (const row of res.body.data) {
    assert.equal(row.campaign_id, campaign.id, 'every row names its campaign')
    assert.equal(typeof row.unsubscribed, 'number', 'unsubscribed is one of the documented counts')
  }

  // 1-20, both ends, with the message stating the range.
  const high = await client.get(`${base}&email_sequence_number=21`)
  assert.equal(high.status, 422)
  assert.equal(high.body.field, 'email_sequence_number')
  assert.match(high.body.message, /1 to 20/)
  assert.equal((await client.get(`${base}&email_sequence_number=0`)).status, 422)

  // Above 1000 is clamped rather than refused, and the applied limit is echoed.
  const huge = await client.get(`${base}&limit=5000`)
  assert.equal(huge.status, 200)
  assert.equal(huge.body.limit, 1000)
})

test('an unsubscribe lands on the last step that reached the lead', async () => {
  db.prepare("UPDATE campaign_leads SET unsubscribed_at = ? WHERE campaign_id = ? AND lead_id = ?")
    .run(stamp(T0 + 3 * DAY), campaign.id, grace.id)
  const res = await client.get(`/api/campaigns/${campaign.id}/statistics?sent_time_start_date=${D1}&sent_time_end_date=${D3}`)
  const total = res.body.data.reduce((sum, r) => sum + r.unsubscribed, 0)
  assert.equal(total, 1, 'counted once, not once per step the lead ever saw')
  db.prepare("UPDATE campaign_leads SET unsubscribed_at = '' WHERE campaign_id = ? AND lead_id = ?")
    .run(campaign.id, grace.id)
})

// ------------------------------------- analytics/team-board-stats.md --------

test('the team board reports reply rate, positive replies and unique opens', async () => {
  db.prepare('UPDATE campaign_leads SET assigned_email = ? WHERE campaign_id = ?').run(owner.email, campaign.id)
  const res = await client.get(`/api/analytics/team?from=${D1}&to=${D3}`)
  assert.equal(res.status, 200)
  const me = res.body.items.find((m) => m.email === owner.email)

  // Ada, Grace and Alan were all contacted; only Ada opened, and only Ada
  // replied — positively, twice, which is still one lead.
  assert.equal(me.lead_count, 3)
  assert.equal(me.unique_open_count, 1)
  assert.equal(me.reply_count, 1)
  assert.equal(me.positive_reply_count, 1)
  assert.equal(me.reply_rate, Math.round((1 / 3) * 1000) / 10, 'per lead contacted, like every other rate here')
  assert.equal(me.positive_reply_rate, me.reply_rate)
  assert.equal(typeof me.average_reply_seconds, 'number', 'sorting uses the number, not the label')
  // The attribution rule for each column comes from here, not from the panel.
  assert.equal(res.body.attribution.reply_count, 'the assignee of each lead who replied in the range')
  assert.equal(res.body.data.team_board_stats[0].email, res.body.items[0].email)

  // A member with nothing in the range is a zero row carrying the note, never
  // an omission.
  db.prepare("INSERT INTO team_members (owner_id, email, role, status) VALUES (?, 'idle@example.com', 'member', 'active')").run(owner.id)
  const withIdle = await client.get(`/api/analytics/team?from=${D1}&to=${D3}`)
  const idle = withIdle.body.items.find((m) => m.email === 'idle@example.com')
  assert.ok(idle, 'the inactive member is present')
  assert.equal(idle.lead_count, 0)
  assert.equal(idle.reply_rate, 0)
  assert.equal(idle.no_activity, true)
  db.prepare("DELETE FROM team_members WHERE owner_id = ? AND email = 'idle@example.com'").run(owner.id)
  db.prepare("UPDATE campaign_leads SET assigned_email = '' WHERE campaign_id = ?").run(campaign.id)
})

// ---------------------------------------- analytics/mailbox-health.md -------

test('the mailbox summary carries the documented envelope and reports a new disconnection', async () => {
  const first = await client.get('/api/analytics/mailboxes/summary')
  assert.equal(first.status, 200)
  // The documented shape and the flat one MailboxesTab reads are the same
  // numbers, not two counts that could drift.
  assert.deepEqual(first.body.data.overall_mailbox_stats.total_connected, first.body.total_connected)
  assert.equal(first.body.data.overall_mailbox_stats.disconnected, 0)

  // A revoked connection moves the mailbox on the very next call — no cache
  // stands between the mailbox record and the count.
  const before = db.prepare("SELECT COUNT(*) n FROM telemetry WHERE op = 'mailboxes.disconnected_rose'").get().n
  db.prepare("UPDATE mailboxes SET status = 'disconnected' WHERE id = ?").run(mailbox.id)
  const after = await client.get('/api/analytics/mailboxes/summary')
  assert.equal(after.body.data.overall_mailbox_stats.disconnected, 1)
  assert.equal(after.body.total_connected, first.body.total_connected - 1)
  // The transition is the incident, so it is the transition that is logged.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM telemetry WHERE op = 'mailboxes.disconnected_rose'").get().n, before + 1)
  const steady = await client.get('/api/analytics/mailboxes/summary')
  assert.equal(steady.body.disconnected, 1)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM telemetry WHERE op = 'mailboxes.disconnected_rose'").get().n, before + 1,
    'a steady state is not an incident')
  db.prepare("UPDATE mailboxes SET status = 'connected' WHERE id = ?").run(mailbox.id)
})
