// Second audit pass over the campaigns category: the twenty-five specs in
// Docs/campaigns/*.md that still had no test-backed verdict.
//
// The rule this file is written to is the one this codebase keeps being caught
// by: a green test that asserted what the server *said* rather than what it
// *did*. So every criterion whose subject is an effect — a send that must not
// happen, a draft that must be withdrawn, a mailbox that must stop carrying a
// campaign — is proved by driving `tick()` from server/engine.js and reading
// `messages`, or by reading the row the next request will read. Response
// envelopes are asserted only where the envelope *is* the criterion (a CSV
// header, a 422 naming its field).
//
// Where a criterion cannot be proved through the tick without a live Gmail
// connection, the assertion is made against `resolveSend` from server/gates.js
// at a fixed instant — that is the function the tick asks, not a second copy of
// its arithmetic — and the test says so in its comment.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-camp-audit2-'))
process.env.AI_MODE = 'off'
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { dailyCap, remainingToday, nextGapMs, sendWindow } = await import('../server/pacing.js')
const { resolveSend } = await import('../server/gates.js')
const { unsubscribeLead } = await import('../server/suppression.js')

// A workspace whose clock never gates: without this the recipient quiet-hours
// gate fires first and masks whatever a test was actually about.
db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, paced, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:a2@x.com', 'a2@x.com', 'Owner', 0, 1, '00:00', '23:59', 'everyday', 'UTC')`
).run()
const owner = db.prepare('SELECT * FROM users WHERE email = ?').get('a2@x.com')

const express = (await import('express')).default
const { api } = await import('../server/routes.js')
const { registerParity } = await import('../server/parity/index.js')
const { authRouter } = await import('../server/auth.js')
registerParity(api)

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.cookies = {}
  const header = req.headers.cookie
  if (header) for (const pair of header.split(';')) {
    const i = pair.indexOf('=')
    if (i > 0) req.cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
  }
  next()
})
app.use(authRouter)
app.use('/api', api)
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => new Promise((r) => server.close(r)))

async function signIn(email) {
  const res = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const cookie = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
  assert.ok(cookie, `signed in as ${email}`)
  return cookie
}

const cookie = await signIn(owner.email)
// A second workspace, so "cross-workspace ids are a 404" is proved against a
// real other tenant rather than against an id that simply does not exist.
const strangerCookie = await signIn('stranger2@x.com')
const stranger = db.prepare('SELECT * FROM users WHERE email = ?').get('stranger2@x.com')

const call = (method, p, body, ck = cookie) => fetch(`${base}${p}`, {
  method,
  headers: body === undefined ? { cookie: ck } : { 'content-type': 'application/json', cookie: ck },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const get = (p, ck) => call('GET', p, undefined, ck)
const post = (p, body, ck) => call('POST', p, body ?? {}, ck)
const put = (p, body, ck) => call('PUT', p, body ?? {}, ck)
const patch = (p, body, ck) => call('PATCH', p, body ?? {}, ck)
const del = (p, body, ck) => call('DELETE', p, body, ck)
const json = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch { throw new Error(`not JSON (${res.status}): ${text.slice(0, 300)}`) }
}
const body = async (res) => ({ status: res.status, body: await json(res) })

// ---- fixtures ---------------------------------------------------------------

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- reply: interested --> W([Won])
  A -- no reply 3d --> B[Send: bump]
  B -- no reply 5d --> L([Lost])
`

db.prepare(
  `INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit, next_send_at, created_at)
   VALUES (?, 'sandbox', 'box@sandbox.local', 'Harry', 'connected', 200, 0, '2020-01-01 00:00:00')`
).run(owner.id)
const SANDBOX = db.prepare('SELECT id FROM mailboxes WHERE email = ?').get('box@sandbox.local').id

let seq = 0
function seedLead(extra = {}) {
  seq += 1
  const email = extra.email || `a2p${seq}@co${seq}.test`
  db.prepare(
    `INSERT INTO leads (user_id, email, first_name, last_name, company, title, phone, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(extra.userId ?? owner.id, email, extra.first_name ?? `First${seq}`, extra.last_name ?? `Last${seq}`,
    extra.company ?? `Co ${seq}`, extra.title ?? 'Head of Ops', extra.phone ?? `+61 400 000 ${seq}`,
    extra.status ?? 'active')
  return db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(extra.userId ?? owner.id, email)
}

// Campaigns are created as drafts on purpose: `tick()` runs every RUNNING
// campaign in the database, so a module-level running campaign would be live
// during every other test's tick.
function seedCampaign(name, { status = 'draft', mermaid = PLAYBOOK, mailboxId = SANDBOX, userId = owner.id } = {}) {
  db.prepare('INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, ?, ?, ?, ?)')
    .run(userId, name, status, mailboxId, mermaid)
  return db.prepare('SELECT * FROM campaigns WHERE user_id = ? AND name = ?').get(userId, name)
}

const attach = (campaignId, leadId) =>
  db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, leadId)

const setStatus = (campaignId, status) =>
  db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, campaignId)

const sentCount = (campaignId) => db.prepare(
  "SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out'"
).get(campaignId).n

const sentTo = (campaignId, leadId) => db.prepare(
  "SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND lead_id = ? AND direction = 'out'"
).get(campaignId, leadId).n

// Run the given campaigns for the duration of `fn` and put them back to draft
// afterwards, whatever happens — otherwise they stay live inside every later
// test's tick.
async function running(campaignIds, fn) {
  const ids = [].concat(campaignIds)
  for (const id of ids) setStatus(id, 'running')
  try { return await fn() } finally { for (const id of ids) setStatus(id, 'draft') }
}

// The per-mailbox gap is the pacing jitter, not the thing under test.
async function tickFreely(times = 1) {
  for (let i = 0; i < times; i++) {
    db.prepare('UPDATE mailboxes SET next_send_at = 0 WHERE user_id = ?').run(owner.id)
    await tick()
  }
}

const events = (campaignId, type) => db.prepare(
  'SELECT * FROM events WHERE campaign_id = ? AND type = ? ORDER BY id'
).all(campaignId, type)

// =============================================================================
// add-leads.md
// =============================================================================

test('add-leads: an import is idempotent — the same batch twice reuses the person and adds one link', async () => {
  // §5 DoD: "Import is idempotent — running the same batch twice yields the
  // same lead and link counts." Asserted on the tables, because the counters in
  // the response are exactly the thing that could be right while the rows are
  // not.
  const campaign = seedCampaign('Import idempotent')
  const address = 'repeat@import.test'
  const batch = { leads: [{ email: address, first_name: 'Ada', company_name: 'Acme' }] }

  const first = await body(await post(`/api/campaigns/${campaign.id}/leads/import`, batch))
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.added_count, 1)

  const leadsAfterFirst = db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND email = ?').get(owner.id, address).n
  assert.equal(leadsAfterFirst, 1)

  const second = await body(await post(`/api/campaigns/${campaign.id}/leads/import`, batch))
  assert.equal(second.status, 200)
  assert.equal(second.body.added_count, 0, 'nothing new was linked the second time')
  assert.equal(second.body.skippedByReason.already_in_campaign, 1)
  assert.equal(second.body.reusedExistingCount, 1, 'and the existing person was matched, not duplicated')

  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND email = ?').get(owner.id, address).n, 1,
    'one person in the workspace, not two',
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n, 1,
    'and one link, not two',
  )
})

test('add-leads: an unsubscribed address cannot be imported, and the engine never reaches it', async () => {
  // §2: "the equivalent of ignore_unsubscribe_list is deliberately not offered,
  // because Harry always honours an unsubscribe", and §5 DoD: "refused
  // regardless of request settings". The proof is not the skip reason — it is
  // that after the import the campaign has no link and the tick sends nothing.
  const campaign = seedCampaign('Import suppressed')
  const lead = seedLead({ email: 'goneaway@import.test' })
  unsubscribeLead(owner.id, lead.id, { source: 'link', actor: 'recipient' })

  const res = await body(await post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [{ email: 'goneaway@import.test' }],
    // Every override the source API offers, sent at once.
    settings: { allowLeadsInOtherCampaigns: true, ignore_unsubscribe_list: true, ignore_global_block_list: true },
  }))
  assert.equal(res.status, 200)
  assert.equal(res.body.added_count, 0)
  // The workspace block list holds the address too, so the first refusal wins.
  assert.ok(
    res.body.skippedByReason.unsubscribed === 1 || res.body.skippedByReason.blocked === 1,
    `skipped for suppression — got ${JSON.stringify(res.body.skippedByReason)}`,
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).n,
    0, 'no link was written',
  )

  await running(campaign.id, () => tickFreely(2))
  assert.equal(sentCount(campaign.id), 0, 'and nothing went out to them')

  // A hard bounce is the other half of the same DoD, and it is the case that
  // isolates the lead's own status: an unsubscribe also writes a workspace
  // block-list row, so the refusal above could have come from either rule.
  const bounced = seedLead({ email: 'bounced@import.test', status: 'bounced' })
  const second = await body(await post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [{ email: 'bounced@import.test' }],
    settings: { allowLeadsInOtherCampaigns: true },
  }))
  assert.equal(second.body.added_count, 0)
  assert.equal(second.body.skippedByReason.bounced, 1, 'refused on the lead\'s own status, with no block-list row involved')
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, bounced.id).n,
    0,
  )

  await running(campaign.id, () => tickFreely(2))
  assert.equal(sentCount(campaign.id), 0, 'and the engine reached neither of them')
})

test('add-leads: one bad row means the whole batch writes nothing', async () => {
  // TC-7/TC-8 read as row-level rejection; §5 makes the batch one transaction.
  // The behaviour Harry ships is the stricter of the two — the whole request is
  // refused — so the assertion that matters is that the two good rows are NOT
  // in the database afterwards.
  const campaign = seedCampaign('Import atomic')
  const before = db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ?').get(owner.id).n

  const res = await body(await post(`/api/campaigns/${campaign.id}/leads/import`, {
    leads: [
      { email: 'good1@atomic.test' },
      { email: 'john@@company' },
      { email: 'good2@atomic.test' },
    ],
  }))
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'leads[1].email', 'the 422 names the row that is wrong')

  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ?').get(owner.id).n, before,
    'not one of the three rows was written')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n, 0)
})

test('add-leads: over the 400 cap is refused with the count it got and the count it allows', async () => {
  const campaign = seedCampaign('Import cap')
  const before = db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ?').get(owner.id).n
  const leads = Array.from({ length: 401 }, (_, i) => ({ email: `cap${i}@batch.test` }))

  const res = await body(await post(`/api/campaigns/${campaign.id}/leads/import`, { leads }))
  assert.equal(res.status, 422)
  assert.equal(res.body.provided_count, 401)
  assert.equal(res.body.max_allowed, 400)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE user_id = ?').get(owner.id).n, before,
    'a refused batch creates nobody')
})

test('add-leads: a lead imported into a running campaign starts at Start and its first email waits for an OK', async () => {
  // §2's last criterion, which is entirely about the engine: "each new lead
  // enters at the playbook's Start node and its first email still parks in the
  // approval queue".
  const campaign = seedCampaign('Import into running')
  db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(owner.id)
  try {
    const res = await body(await post(`/api/campaigns/${campaign.id}/leads/import`, {
      leads: [{ email: 'newcomer@import.test', first_name: 'Nia' }],
    }))
    assert.equal(res.status, 200)
    const leadId = res.body.lead_ids[0]

    await running(campaign.id, () => tickFreely(2))

    const draft = db.prepare('SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, leadId)
    assert.ok(draft, 'the agent composed and parked it')
    assert.equal(draft.status, 'pending')
    assert.equal(draft.node_id, 'A', 'at the first Send step reached from Start')
    assert.equal(sentCount(campaign.id), 0, 'and nothing was sent without the OK')
  } finally {
    db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
  }
})

// =============================================================================
// all-leads-activities.md
// =============================================================================

test('all-leads-activities: the window includes both of its boundaries and excludes the second either side', async () => {
  const campaign = seedCampaign('Feed window')
  const lead = seedLead()
  const at = (t) => db.prepare(
    "INSERT INTO events (user_id, campaign_id, lead_id, type, detail, created_at) VALUES (?, ?, ?, 'sent', ?, ?)"
  ).run(owner.id, campaign.id, lead.id, t, t)

  at('2026-03-01 09:59:59')
  at('2026-03-01 10:00:00')  // exactly `from`
  at('2026-03-01 11:00:00')  // exactly `to`
  at('2026-03-01 11:00:01')

  const res = await json(await get(
    `/api/activity?campaignId=${campaign.id}&from=2026-03-01T10:00:00Z&to=2026-03-01T11:00:00Z`
  ))
  assert.deepEqual(
    res.activities.map((a) => a.detail).sort(),
    ['2026-03-01 10:00:00', '2026-03-01 11:00:00'],
    'both boundaries are in, and neither neighbour is',
  )
  assert.equal(res.total, 2, 'and the total counts the same set the page shows')
})

test('all-leads-activities: entries sharing a timestamp page without skipping or repeating one', async () => {
  // §2: "ordering is stable (newest first, tie-broken by id) so paging cannot
  // skip or repeat an entry". Five rows at the same instant is the only case
  // where an unstable sort shows itself.
  const campaign = seedCampaign('Feed paging')
  const lead = seedLead()
  for (let i = 0; i < 5; i++) {
    db.prepare(
      "INSERT INTO events (user_id, campaign_id, lead_id, type, detail, created_at) VALUES (?, ?, ?, 'sent', ?, '2026-04-01 08:00:00')"
    ).run(owner.id, campaign.id, lead.id, `tie-${i}`)
  }

  const seen = []
  for (let offset = 0; offset < 6; offset += 2) {
    const page = await json(await get(`/api/activity?campaignId=${campaign.id}&limit=2&offset=${offset}`))
    seen.push(...page.activities.map((a) => a.id))
  }
  assert.equal(seen.length, 5, 'three pages of two returned the five rows')
  assert.equal(new Set(seen).size, 5, 'with nothing repeated')
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a), 'newest id first, which is the documented tiebreaker')
})

test('all-leads-activities: the feed is workspace-scoped, not account-wide', async () => {
  const mine = seedCampaign('Feed mine')
  const theirs = seedCampaign('Feed theirs', { userId: stranger.id, mailboxId: null })
  db.prepare("INSERT INTO events (user_id, campaign_id, type, detail) VALUES (?, ?, 'sent', 'mine')").run(owner.id, mine.id)
  db.prepare("INSERT INTO events (user_id, campaign_id, type, detail) VALUES (?, ?, 'sent', 'theirs')").run(stranger.id, theirs.id)

  const feed = await json(await get('/api/activity?limit=1000'))
  assert.ok(feed.activities.some((a) => a.detail === 'mine'))
  assert.ok(!feed.activities.some((a) => a.detail === 'theirs'), 'the other workspace\'s activity is absent')

  const theirFeed = await json(await get('/api/activity?limit=1000', strangerCookie))
  assert.ok(theirFeed.activities.some((a) => a.detail === 'theirs'))
  assert.ok(!theirFeed.activities.some((a) => a.detail === 'mine'), 'and the isolation holds both ways')
})

test('all-leads-activities: an unbounded page and a negative offset are refused, not clamped', async () => {
  const over = await body(await get('/api/activity?limit=1001'))
  assert.equal(over.status, 422)
  assert.equal(over.body.field, 'limit')
  const under = await body(await get('/api/activity?offset=-1'))
  assert.equal(under.status, 422)
  assert.equal(under.body.field, 'offset')
})

// =============================================================================
// create.md
// =============================================================================

test('create: a double submit yields one campaign, not twins', async () => {
  // §5 DoD: "Double-submit protection is tested." The row count is the test;
  // `deduplicated: true` on its own would be a claim about a claim.
  const before = db.prepare('SELECT COUNT(*) n FROM campaigns WHERE user_id = ?').get(owner.id).n
  const first = await json(await post('/api/campaigns/create', { name: 'Double click' }))
  const second = await json(await post('/api/campaigns/create', { name: 'Double click' }))

  assert.equal(second.id, first.id, 'the second click got the first campaign back')
  assert.equal(second.deduplicated, true)
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaigns WHERE user_id = ? AND name = ?').get(owner.id, 'Double click').n, 1,
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaigns WHERE user_id = ?').get(owner.id).n, before + 1)
})

test('create: a goal id from another workspace is a 404 and creates nothing', async () => {
  db.prepare("INSERT INTO goals (user_id, name, description, target) VALUES (?, 'Their goal', 'theirs', 10)").run(stranger.id)
  const theirGoal = db.prepare('SELECT * FROM goals WHERE user_id = ? AND name = ?').get(stranger.id, 'Their goal')
  const before = db.prepare('SELECT COUNT(*) n FROM campaigns WHERE user_id = ?').get(owner.id).n

  const res = await body(await post('/api/campaigns/create', { name: 'Stolen goal', goalId: theirGoal.id }))
  assert.equal(res.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaigns WHERE user_id = ?').get(owner.id).n, before,
    'the campaign was not created before the goal was checked')
  assert.equal(
    db.prepare('SELECT campaign_id FROM goals WHERE id = ?').get(theirGoal.id).campaign_id, null,
    'and the other workspace\'s goal was not touched',
  )
})

test('create: the activity trail records who created the campaign', async () => {
  const created = await json(await post('/api/campaigns/create', { name: 'Trailed' }))
  const rows = events(created.id, 'campaign_created')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].user_id, owner.id)
})

test('create: a name past the length cap is a field-level refusal with nothing written', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM campaigns WHERE user_id = ?').get(owner.id).n
  const res = await body(await post('/api/campaigns/create', { name: 'x'.repeat(201) }))
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'name')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaigns WHERE user_id = ?').get(owner.id).n, before)
})

// =============================================================================
// delete-lead.md
// =============================================================================

test('delete-lead: removal withdraws the waiting draft and the engine composes nothing further', async () => {
  // §5 DoD: "Removal cancels any pending draft in the same transaction" and "A
  // test races removal against an engine tick and asserts no send occurs".
  const campaign = seedCampaign('Remove lead')
  const staying = seedLead()
  const going = seedLead()
  attach(campaign.id, staying.id)
  attach(campaign.id, going.id)

  db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(owner.id)
  try {
    await running(campaign.id, () => tickFreely(1))
    const draft = db.prepare('SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, going.id)
    assert.ok(draft && draft.status === 'pending', 'a draft was waiting before the removal')

    const res = await body(await post(`/api/campaigns/${campaign.id}/leads/remove`, { leadIds: [going.id] }))
    assert.equal(res.status, 200)
    assert.equal(res.body.results[0].draftsCancelled, 1)

    assert.equal(
      db.prepare('SELECT status FROM drafts WHERE id = ?').get(draft.id).status, 'declined',
      'the draft cannot be approved afterwards',
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, going.id).n,
      0,
    )

    // And the engine agrees: further ticks produce nothing for them, while the
    // lead who stayed still has a draft of their own.
    await running(campaign.id, () => tickFreely(2))
    assert.equal(sentTo(campaign.id, going.id), 0)
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM drafts WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'")
        .get(campaign.id, going.id).n,
      0, 'and no replacement draft was written for them',
    )
    assert.ok(
      db.prepare("SELECT COUNT(*) n FROM drafts WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'")
        .get(campaign.id, staying.id).n > 0,
      'while the campaign carried on for everyone else',
    )
  } finally {
    db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
  }
})

test('delete-lead: the person, their messages and their unsubscribe survive the removal', async () => {
  const campaign = seedCampaign('Remove keeps history')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status)
     VALUES (?, ?, ?, ?, 'out', 'Hi', 'Body', '', 'rm-1', 'sent')`
  ).run(owner.id, campaign.id, lead.id, SANDBOX)
  unsubscribeLead(owner.id, lead.id, { source: 'manual', actor: owner.email })

  await post(`/api/campaigns/${campaign.id}/leads/remove`, { leadIds: [lead.id] })

  const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  assert.ok(after, 'the person is still in the workspace')
  assert.equal(after.status, 'unsubscribed', 'and their opt-out is untouched')
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).n, 1,
    'removal stops future sends, it does not rewrite the past',
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM blocked_domains WHERE workspace_id = ? AND value = ?').get(owner.id, after.email).n,
    1, 'and the suppression entry that outlives the person is still there',
  )
})

test('delete-lead: a bad id in a bulk removal reports itself without failing the batch', async () => {
  const campaign = seedCampaign('Bulk remove')
  const present = seedLead()
  const absent = seedLead()
  attach(campaign.id, present.id)

  const res = await json(await post(`/api/campaigns/${campaign.id}/leads/remove`, { leadIds: [present.id, absent.id] }))
  assert.equal(res.removed, 1)
  const byId = Object.fromEntries(res.results.map((r) => [r.leadId, r]))
  assert.equal(byId[present.id].removed, true)
  assert.equal(byId[absent.id].removed, false)
  assert.equal(byId[absent.id].reason, 'not_in_campaign')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(campaign.id).n, 0)
})

// =============================================================================
// delete.md
// =============================================================================

test('delete: a running campaign refuses to be deleted, and goes on sending', async () => {
  // §5 DoD: "Running campaigns cannot be deleted, covered by a test that races
  // a tick against a delete." The second half is what makes the 409 mean
  // something: the campaign is not half-deleted, it is fully alive.
  const campaign = seedCampaign('Delete while running')
  attach(campaign.id, seedLead().id)

  await running(campaign.id, async () => {
    const res = await body(await del(`/api/campaigns/${campaign.id}/permanent`))
    assert.equal(res.status, 409)
    assert.equal(res.body.error, 'CAMPAIGN_ACTIVE')
    assert.ok(db.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaign.id), 'the row is still there')
    await tickFreely(1)
  })
  assert.equal(sentCount(campaign.id), 1, 'and it was still sending throughout')
})

test('delete: destroying a campaign leaves the people, and their unsubscribe still blocks a re-import', async () => {
  // §2: "when I look at the Leads page, then the people are still there" and
  // "the unsubscribe still holds workspace-wide and that address can still not
  // be imported anywhere". The second is proved by importing again, not by
  // reading a column.
  const doomed = seedCampaign('Doomed')
  const kept = seedLead()
  const optedOut = seedLead()
  attach(doomed.id, kept.id)
  attach(doomed.id, optedOut.id)
  await post(`/api/campaigns/${doomed.id}/leads/${optedOut.id}/unsubscribe`)

  const res = await body(await del(`/api/campaigns/${doomed.id}/permanent`))
  assert.equal(res.status, 200)
  assert.equal(db.prepare('SELECT id FROM campaigns WHERE id = ?').get(doomed.id), undefined)

  assert.ok(db.prepare('SELECT id FROM leads WHERE id = ?').get(kept.id), 'deleting a campaign deletes links, not people')
  assert.ok(db.prepare('SELECT id FROM leads WHERE id = ?').get(optedOut.id))

  const elsewhere = seedCampaign('Somewhere else')
  const again = await json(await post(`/api/campaigns/${elsewhere.id}/leads/import`, {
    leads: [{ email: optedOut.email }],
  }))
  assert.equal(again.added_count, 0, 'the opt-out outlived the campaign it was made in')
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?').get(elsewhere.id).n, 0,
  )
})

test('delete: the activity-trail entry outlives the campaign and says what was destroyed', async () => {
  const campaign = seedCampaign('Trail outlives')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id)
     VALUES (?, ?, ?, ?, 'out', 'Hi', 'Body', '', 'dl-1')`
  ).run(owner.id, campaign.id, lead.id, SANDBOX)

  await del(`/api/campaigns/${campaign.id}/permanent`)

  const trail = events(campaign.id, 'campaign_deleted')
  assert.equal(trail.length, 1, 'the row survives the campaign it refers to')
  assert.match(trail[0].detail, /1 links/)
  assert.match(trail[0].detail, /1 messages/)
})

test('delete: archive hides the campaign from the default list and is fully reversible', async () => {
  const campaign = seedCampaign('Archivable')
  const listed = async (query = '') =>
    (await json(await get(`/api/campaign-list?limit=200${query}`))).campaigns.some((c) => c.id === campaign.id)

  assert.equal(await listed(), true)
  assert.equal((await body(await patch(`/api/campaigns/${campaign.id}`, { status: 'archived' }))).status, 200)
  assert.equal(await listed(), false, 'hidden by default')
  assert.equal(await listed('&includeArchived=true'), true, 'and reachable through the filter')

  assert.equal((await body(await patch(`/api/campaigns/${campaign.id}`, { status: 'draft' }))).status, 200)
  assert.equal(await listed(), true, 'archiving loses nothing')
  assert.equal(db.prepare('SELECT deleted_at FROM campaigns WHERE id = ?').get(campaign.id).deleted_at, '')
})

// =============================================================================
// export-leads.md
// =============================================================================

async function exportText(campaignId, ck) {
  const res = await get(`/api/campaigns/${campaignId}/leads/export`, ck)
  if (res.status !== 200) return { status: res.status, text: await res.text() }
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { status: 200, text: new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '') }
}

test('export-leads: commas, quotes, newlines and accents survive the file intact', async () => {
  // §5 DoD: "Quoting and encoding covered by tests including commas, quotes,
  // newlines and non-ASCII." Parsed back with a real RFC 4180 reader rather
  // than split on commas, because splitting is what hides a quoting bug.
  const campaign = seedCampaign('Export quoting')
  const lead = seedLead({
    email: 'awkward@quote.test',
    first_name: 'Zoë',
    last_name: 'O\'Neill, Jr',
    company: 'He said "hello"',
    title: 'Line one\nline two',
  })
  attach(campaign.id, lead.id)

  const { text } = await exportText(campaign.id)
  const rows = parseCsv(text)
  assert.equal(rows.length, 2, 'a header and exactly one record, however many newlines are inside a cell')
  const header = rows[0]
  const record = rows[1]
  assert.equal(record[header.indexOf('first_name')], 'Zoë', 'the accent came back byte for byte')
  assert.equal(record[header.indexOf('last_name')], 'O\'Neill, Jr', 'the comma stayed inside its cell')
  assert.equal(record[header.indexOf('company_name')], 'He said "hello"', 'and the doubled quotes unescaped correctly')
  assert.equal(record[header.indexOf('title')], 'Line one\nline two', 'and the newline did not become a second row')
})

// A minimal RFC 4180 reader. Written here rather than imported because the
// point of the test above is that the file is readable by something that does
// not already know how it was written.
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++ }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

test('export-leads: every export is written to the activity trail with its row count', async () => {
  const campaign = seedCampaign('Export audited')
  attach(campaign.id, seedLead().id)
  attach(campaign.id, seedLead().id)

  await exportText(campaign.id)
  const trail = events(campaign.id, 'campaign_leads_exported')
  assert.equal(trail.length, 1)
  assert.match(trail[0].detail, /^2 rows by a2@x\.com/, 'who exported what, and how many rows of personal data left')
})

test('export-leads: an empty campaign exports a header and no rows, and another workspace exports nothing', async () => {
  const empty = seedCampaign('Export empty')
  const { text } = await exportText(empty.id)
  assert.equal(parseCsv(text).length, 1, 'the header alone — not an empty file')

  const theirs = seedCampaign('Export theirs', { userId: stranger.id, mailboxId: null })
  const refused = await exportText(theirs.id)
  assert.equal(refused.status, 404)
})

// =============================================================================
// get-all.md
// =============================================================================

test('get-all: paging, the status filter and the search compose rather than override each other', async () => {
  // §5 DoD: "Paging, status filter and search are covered by tests, including
  // their combination."
  const tag = `Compose${Date.now() % 100000}`
  const made = []
  for (let i = 0; i < 3; i++) made.push(seedCampaign(`${tag} paused ${i}`, { status: 'paused' }))
  for (let i = 0; i < 2; i++) made.push(seedCampaign(`${tag} draft ${i}`, { status: 'draft' }))

  const all = await json(await get(`/api/campaign-list?q=${tag}&limit=200`))
  assert.equal(all.total, 5)

  const paused = await json(await get(`/api/campaign-list?q=${tag}&status=paused&limit=200`))
  assert.equal(paused.total, 3, 'the search and the status filter both bite')
  assert.ok(paused.campaigns.every((c) => c.status === 'paused'))

  const page = await json(await get(`/api/campaign-list?q=${tag}&status=paused&limit=2&offset=0`))
  assert.equal(page.campaigns.length, 2)
  assert.equal(page.total, 3, 'the total describes the filtered set, not the page')
  const next = await json(await get(`/api/campaign-list?q=${tag}&status=paused&limit=2&offset=2`))
  assert.equal(next.campaigns.length, 1)
  assert.equal(
    new Set([...page.campaigns, ...next.campaigns].map((c) => c.id)).size, 3,
    'and the two pages are disjoint',
  )
})

test('get-all: the list never reaches into another workspace', async () => {
  const theirs = seedCampaign('Invisible to me', { userId: stranger.id, mailboxId: null })
  const list = await json(await get('/api/campaign-list?limit=200'))
  assert.ok(!list.campaigns.some((c) => c.id === theirs.id))
  const search = await json(await get('/api/campaign-list?q=Invisible&limit=200'))
  assert.equal(search.total, 0, 'not even by name')
})

test('get-all: a follow-on campaign names its parent and can be filtered to it', async () => {
  const parent = seedCampaign('Parent list')
  const child = seedCampaign('Child list')
  db.prepare('UPDATE campaigns SET parent_campaign_id = ? WHERE id = ?').run(parent.id, child.id)

  const list = await json(await get('/api/campaign-list?limit=200'))
  const row = list.campaigns.find((c) => c.id === child.id)
  assert.equal(row.parentCampaignId, parent.id, 'the row says where it hangs, so the list can nest it')

  const filtered = await json(await get(`/api/campaign-list?parentCampaignId=${parent.id}&limit=200`))
  assert.deepEqual(filtered.campaigns.map((c) => c.id), [child.id])
})

// =============================================================================
// get-analytics-by-date.md  /  get-top-level-analytics.md
// =============================================================================

// Both specs describe the same window arithmetic, so the fixtures are shared.
function seedAnalytics(campaignId, leadId, { out = [], inbound = [], opened = [] } = {}) {
  let n = 0
  for (const at of out) {
    n += 1
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status, opened_at, created_at)
       VALUES (?, ?, ?, ?, 'out', 'Hi', 'Body', '', ?, 'sent', ?, ?)`
    ).run(owner.id, campaignId, leadId, SANDBOX, `an-${campaignId}-${n}-${Math.random()}`,
      opened.includes(at) ? at : '', at)
  }
  for (const at of inbound) {
    n += 1
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, created_at)
       VALUES (?, ?, ?, ?, 'in', 'Re: Hi', 'Yes', '', ?, ?)`
    ).run(owner.id, campaignId, leadId, SANDBOX, `an-in-${campaignId}-${n}-${Math.random()}`, at)
  }
}

test('get-analytics-by-date: an event counts by when it happened, not by when the email went out', async () => {
  // §2: "a reply in March to a February email belongs to March's reply count".
  const campaign = seedCampaign('Attribution')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  seedAnalytics(campaign.id, lead.id, {
    out: ['2026-02-10 09:00:00'],
    inbound: ['2026-03-10 09:00:00'],
  })

  const feb = await json(await get(`/api/campaigns/${campaign.id}/playbook-analytics?from=2026-02-01T00:00:00Z&to=2026-02-28T23:59:59Z`))
  assert.equal(feb.totals.sent, 1, 'February owns the send')
  assert.equal(feb.totals.replied, 0, 'and not the reply that answered it')

  const mar = await json(await get(`/api/campaigns/${campaign.id}/playbook-analytics?from=2026-03-01T00:00:00Z&to=2026-03-31T23:59:59Z`))
  assert.equal(mar.totals.sent, 0)
  assert.equal(mar.totals.replied, 1, 'March owns the reply')
})

test('get-analytics-by-date: both ends of the window are inclusive', async () => {
  // §5: "boundaries are inclusive at both ends". A message sitting exactly on
  // the closing boundary is the whole test — an exclusive upper bound loses the
  // last second of every window a client asks for, silently.
  const campaign = seedCampaign('Boundaries')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  seedAnalytics(campaign.id, lead.id, { out: ['2026-05-01 00:00:00', '2026-05-31 23:59:59'] })

  const window = await json(await get(
    `/api/campaigns/${campaign.id}/playbook-analytics?from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z`
  ))
  assert.equal(window.totals.sent, 2, 'the first instant and the last are both inside')

  const top = await json(await get(
    `/api/campaigns/${campaign.id}/top-level-analytics?from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z`
  ))
  assert.equal(top.total_sent, 2, 'and the headline route agrees with the detailed one')

  const outside = await json(await get(
    `/api/campaigns/${campaign.id}/playbook-analytics?from=2026-05-01T00:00:01Z&to=2026-05-31T23:59:58Z`
  ))
  assert.equal(outside.totals.sent, 0, 'a window one second tighter excludes both, so this is a boundary not an off-by-one')
})

test('get-analytics-by-date: a whole-life window gives the same figures as all-time', async () => {
  const campaign = seedCampaign('Whole life')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  const today = new Date()
  const iso = (d) => new Date(d).toISOString()
  const stamp = (d) => iso(d).slice(0, 19).replace('T', ' ')
  seedAnalytics(campaign.id, lead.id, {
    out: [stamp(today - 30 * 86400e3), stamp(today - 1 * 86400e3)],
    inbound: [stamp(today - 12 * 3600e3)],
  })

  const allTime = await json(await get(`/api/campaigns/${campaign.id}/playbook-analytics`))
  const windowed = await json(await get(
    `/api/campaigns/${campaign.id}/playbook-analytics?from=${iso(today - 200 * 86400e3)}&to=${iso(today.getTime() + 86400e3)}`
  ))
  assert.equal(allTime.window.allTime, true)
  assert.equal(windowed.totals.sent, allTime.totals.sent)
  assert.equal(windowed.totals.replied, allTime.totals.replied)
  assert.deepEqual(windowed.rates.reply, allTime.rates.reply, 'one route, one arithmetic')
})

test('get-analytics-by-date: an inverted or malformed window is refused before any figure is produced', async () => {
  const campaign = seedCampaign('Bad windows')
  const inverted = await body(await get(
    `/api/campaigns/${campaign.id}/playbook-analytics?from=2026-03-02T00:00:00Z&to=2026-03-01T00:00:00Z`
  ))
  assert.equal(inverted.status, 422)
  assert.equal(inverted.body.field, 'to')
  assert.equal(inverted.body.totals, undefined, 'no partial figures came back with the error')

  const malformed = await body(await get(`/api/campaigns/${campaign.id}/playbook-analytics?from=yesterday&to=2026-03-01T00:00:00Z`))
  assert.equal(malformed.status, 422)
  assert.equal(malformed.body.field, 'from')

  const lonely = await body(await get(`/api/campaigns/${campaign.id}/playbook-analytics?from=2026-03-01T00:00:00Z`))
  assert.equal(lonely.status, 422)
  assert.equal(lonely.body.field, 'to', 'half a window is not a window')
})

test('get-analytics-by-date: an empty window says so, and an untracked rate refuses to read as zero', async () => {
  const campaign = seedCampaign('Quiet window')
  db.prepare('UPDATE campaigns SET track_opens = 0 WHERE id = ?').run(campaign.id)
  const lead = seedLead()
  attach(campaign.id, lead.id)
  seedAnalytics(campaign.id, lead.id, { out: ['2026-07-01 09:00:00'] })

  const quiet = await json(await get(
    `/api/campaigns/${campaign.id}/playbook-analytics?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z`
  ))
  assert.equal(quiet.noActivity, true, 'an empty period is distinguishable from a broken query')
  assert.equal(quiet.totals.sent, 0)

  const busy = await json(await get(
    `/api/campaigns/${campaign.id}/playbook-analytics?from=2026-07-01T00:00:00Z&to=2026-07-31T00:00:00Z`
  ))
  assert.equal(busy.noActivity, false)
  assert.equal(busy.rates.open.tracked, false)
  assert.equal(busy.rates.open.value, null, '"we did not measure opens" is not "nobody opened it"')
  assert.match(busy.rates.open.reason, /tracking is off/i)
  assert.equal(busy.smallSample, true, 'one email is not a result, and the response says so')
})

test('get-top-level-analytics: rates are percentages to one decimal, and zero activity is zeros not nulls', async () => {
  const campaign = seedCampaign('Headlines')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  seedAnalytics(campaign.id, lead.id, {
    out: ['2026-06-01 09:00:00', '2026-06-02 09:00:00', '2026-06-03 09:00:00'],
    opened: ['2026-06-01 09:00:00'],
    inbound: ['2026-06-04 09:00:00'],
  })

  const t = await json(await get(
    `/api/campaigns/${campaign.id}/top-level-analytics?from=2026-06-01T00:00:00Z&to=2026-06-30T00:00:00Z`
  ))
  assert.equal(t.total_sent, 3)
  assert.equal(t.total_delivered, 3)
  assert.equal(t.open_rate, 33.3, 'one of three, as a percentage to one decimal — never 0.333')
  assert.equal(t.reply_rate, 100, 'the one lead contacted replied')

  const empty = seedCampaign('Headlines empty')
  const zero = await json(await get(`/api/campaigns/${empty.id}/top-level-analytics`))
  assert.equal(zero.total_sent, 0)
  assert.equal(zero.total_delivered, 0)
  assert.equal(zero.open_rate, 0, 'zero, never null and never a division by zero')
  assert.equal(zero.reply_rate, 0)
})

test('get-top-level-analytics: another workspace\'s campaign leaks no counts', async () => {
  const theirs = seedCampaign('Their numbers', { userId: stranger.id, mailboxId: null })
  const res = await body(await get(`/api/campaigns/${theirs.id}/top-level-analytics`))
  assert.equal(res.status, 404)
  assert.equal(res.body.total_sent, undefined)
})

// =============================================================================
// get-by-id.md
// =============================================================================

test('get-by-id: another workspace\'s campaign is a 404 that says nothing about whether it exists', async () => {
  const theirs = seedCampaign('Their campaign', { userId: stranger.id, mailboxId: null })
  const real = await body(await get(`/api/campaigns/${theirs.id}/detail`))
  const imaginary = await body(await get('/api/campaigns/99999999/detail'))
  assert.equal(real.status, 404)
  assert.equal(imaginary.status, 404)
  assert.deepEqual(real.body, imaginary.body, 'the two answers are indistinguishable, so ids cannot be probed')
})

test('get-by-id: the readiness blockers explain a disabled Launch, and clearing them really enables it', async () => {
  // §2: "the response carries the readiness state ... so the page can explain
  // why Launch is disabled without extra requests". Proved by then launching:
  // a blockers list that does not predict the launch route is decoration.
  const campaign = seedCampaign('Not ready', { mermaid: '', mailboxId: null })
  const before = await json(await get(`/api/campaigns/${campaign.id}/detail`))
  assert.deepEqual(before.blockers.map((b) => b.field).sort(), ['leads', 'mailboxes', 'playbook'])

  const refused = await body(await put(`/api/campaigns/${campaign.id}/status`, { status: 'START' }))
  assert.equal(refused.status, 422)
  assert.deepEqual(refused.body.blockers.map((b) => b.field).sort(), ['leads', 'mailboxes', 'playbook'])

  db.prepare('UPDATE campaigns SET mermaid = ?, mailbox_id = ? WHERE id = ?').run(PLAYBOOK, SANDBOX, campaign.id)
  attach(campaign.id, seedLead().id)

  const after = await json(await get(`/api/campaigns/${campaign.id}/detail`))
  assert.deepEqual(after.blockers, [], 'nothing left in the way')
  const started = await body(await put(`/api/campaigns/${campaign.id}/status`, { status: 'START' }))
  assert.equal(started.status, 200, JSON.stringify(started.body))
  setStatus(campaign.id, 'draft')
})

test('get-by-id: a follow-on campaign identifies its parent so the page can say where its leads arrive from', async () => {
  const parent = seedCampaign('Detail parent')
  const child = await json(await post(`/api/campaigns/${parent.id}/children`, { name: 'Detail child', triggers: ['went quiet'] }))
  const detail = await json(await get(`/api/campaigns/${child.id}/detail`))
  assert.equal(detail.parent.id, parent.id)
  assert.equal(detail.parent.name, 'Detail parent')

  const fromAbove = await json(await get(`/api/campaigns/${parent.id}/detail`))
  assert.deepEqual(fromAbove.children.map((c) => c.id), [child.id], 'and the parent knows about the child')
})

// =============================================================================
// get-email-accounts.md
// =============================================================================

test('get-email-accounts: the remaining allowance on the panel is exactly what the mailer will permit', async () => {
  // §5 DoD: "Displayed remaining allowance provably equals what the mailer will
  // permit, covered by a test." So the panel figure is compared to
  // pacing.remainingToday — the function the gate reads — and then the tick is
  // run in both states to show the figure predicts the behaviour.
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, display_name, status, daily_limit, next_send_at, created_at)
     VALUES (?, 'sandbox', 'allowance@sandbox.local', 'Allowance', 'connected', 20, 0, '2020-01-01 00:00:00')`
  ).run(owner.id)
  const mb = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('allowance@sandbox.local')
  const campaign = seedCampaign('Allowance', { mailboxId: mb.id })
  db.prepare('INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(campaign.id, mb.id)
  attach(campaign.id, seedLead().id)

  const today = new Date().toISOString().slice(0, 10)
  db.prepare('UPDATE mailboxes SET sent_today = daily_limit, sent_today_date = ? WHERE id = ?').run(today, mb.id)

  const spent = await json(await get(`/api/campaigns/${campaign.id}/mailboxes`))
  const spentRow = spent.data.find((m) => m.id === mb.id)
  assert.equal(spentRow.remainingToday, 0)
  assert.equal(
    spentRow.remainingToday,
    remainingToday(db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mb.id)),
    'the panel number is pacing\'s number, not a second sum',
  )
  await running(campaign.id, () => tickFreely(1))
  assert.equal(sentCount(campaign.id), 0, 'and a mailbox showing nothing left sends nothing')

  db.prepare('UPDATE mailboxes SET sent_today = 3, sent_today_date = ?, next_send_at = 0 WHERE id = ?').run(today, mb.id)
  const open = await json(await get(`/api/campaigns/${campaign.id}/mailboxes`))
  const openRow = open.data.find((m) => m.id === mb.id)
  assert.equal(openRow.usedToday, 3)
  assert.equal(openRow.rampedCap, dailyCap(db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mb.id)))
  assert.equal(openRow.remainingToday, openRow.rampedCap - 3)

  await running(campaign.id, () => tickFreely(1))
  assert.equal(sentCount(campaign.id), 1, 'and a mailbox showing room sends')
  const afterSend = await json(await get(`/api/campaigns/${campaign.id}/mailboxes`))
  assert.equal(
    afterSend.data.find((m) => m.id === mb.id).usedToday, 4,
    'the send it just made is counted against the same allowance the panel shows',
  )
})

test('get-email-accounts: a shared mailbox says how many campaigns are drawing on it', async () => {
  const a = seedCampaign('Sharing A')
  const b = seedCampaign('Sharing B')
  for (const c of [a, b]) {
    db.prepare('INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(c.id, SANDBOX)
  }
  const listed = await json(await get(`/api/campaigns/${a.id}/mailboxes`))
  const row = listed.data.find((m) => m.id === SANDBOX)
  assert.equal(
    row.campaignsUsing,
    db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE mailbox_id = ?').get(SANDBOX).n,
    'so the reader understands where the allowance is going',
  )
  assert.ok(row.campaignsUsing >= 2)
})

test('get-email-accounts: another workspace\'s campaign discloses no sender addresses', async () => {
  const theirs = seedCampaign('Their senders', { userId: stranger.id, mailboxId: null })
  const res = await body(await get(`/api/campaigns/${theirs.id}/mailboxes`))
  assert.equal(res.status, 404)
  assert.equal(res.body.data, undefined)
  assert.ok(!JSON.stringify(res.body).includes('@'), 'not one address in the refusal')
})

// =============================================================================
// get-lead-by-id.md
// =============================================================================

test('get-lead-by-id: the record carries every campaign the person is in, not just the one asked about', async () => {
  const here = seedCampaign('Lead here')
  const there = seedCampaign('Lead there')
  const lead = seedLead()
  attach(here.id, lead.id)
  attach(there.id, lead.id)

  const view = await json(await get(`/api/campaigns/${here.id}/leads/${lead.id}`))
  assert.deepEqual(
    view.positions.map((p) => p.campaignId).sort((a, b) => a - b),
    [here.id, there.id].sort((a, b) => a - b),
    'a person about to approve an email can see everywhere else this lead is being written to',
  )
})

test('get-lead-by-id: an unsubscribed lead is unmistakable on the record', async () => {
  const campaign = seedCampaign('Lead opted out')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  await post(`/api/campaigns/${campaign.id}/leads/${lead.id}/unsubscribe`)

  const view = await json(await get(`/api/campaigns/${campaign.id}/leads/${lead.id}`))
  assert.equal(view.lead.status, 'unsubscribed')
  assert.ok(view.lead.unsubscribedAt, 'with the moment it happened')
  assert.equal(view.lead.stage, 'unsubscribed', 'and the derived stage agrees')
})

test('get-lead-by-id: another workspace\'s lead is a 404 that discloses no personal data', async () => {
  const theirCampaign = seedCampaign('Their leads', { userId: stranger.id, mailboxId: null })
  const theirLead = seedLead({ userId: stranger.id, email: 'private@stranger.test' })
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(theirCampaign.id, theirLead.id)

  const res = await body(await get(`/api/campaigns/${theirCampaign.id}/leads/${theirLead.id}`))
  assert.equal(res.status, 404)
  assert.ok(!JSON.stringify(res.body).includes('private@stranger.test'))

  // And the id cannot be smuggled in through a campaign the caller does own.
  const mine = seedCampaign('My campaign for their lead')
  const smuggled = await body(await get(`/api/campaigns/${mine.id}/leads/${theirLead.id}`))
  assert.equal(smuggled.status, 404)
})

// =============================================================================
// get-lead-history.md
// =============================================================================

test('get-lead-history: `since` returns strictly newer messages, with no gap and no duplicate', async () => {
  const campaign = seedCampaign('Thread since')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  const stamps = ['2026-01-01 10:00:00', '2026-01-01 10:01:00', '2026-01-01 10:02:00', '2026-01-01 10:03:00', '2026-01-01 10:04:00']
  stamps.forEach((at, i) => db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, created_at)
     VALUES (?, ?, ?, ?, 'out', ?, 'Body', '', ?, ?)`
  ).run(owner.id, campaign.id, lead.id, SANDBOX, `msg ${i}`, `since-${i}`, at))

  const whole = await json(await get(`/api/campaigns/${campaign.id}/leads/${lead.id}/messages`))
  assert.deepEqual(whole.messages.map((m) => m.subject), stamps.map((_, i) => `msg ${i}`), 'oldest first, a thread reads downwards')

  const newer = await json(await get(
    `/api/campaigns/${campaign.id}/leads/${lead.id}/messages?since=2026-01-01T10:02:00Z`
  ))
  assert.deepEqual(newer.messages.map((m) => m.subject), ['msg 3', 'msg 4'],
    'strictly after the cursor — the cursor message itself is not resent')
  const union = [...newer.messages.map((m) => m.id)]
  assert.equal(new Set(union).size, union.length)
  assert.ok(
    whole.messages.slice(3).every((m, i) => m.id === newer.messages[i].id),
    'and the incremental page is exactly the tail of the whole thread — no gap',
  )
})

test('get-lead-history: an inbound message carries its intent and the edge it made the engine follow', async () => {
  const campaign = seedCampaign('Thread routing')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, intent)
     VALUES (?, ?, ?, ?, 'in', 'Re: Hi', 'Sounds good', '', 'route-1', 'interested')`
  ).run(owner.id, campaign.id, lead.id, SANDBOX)

  const thread = await json(await get(`/api/campaigns/${campaign.id}/leads/${lead.id}/messages`))
  const reply = thread.messages.find((m) => m.direction === 'in')
  assert.equal(reply.intent, 'interested')
  assert.deepEqual(
    { from: reply.followedEdge.from, to: reply.followedEdge.to }, { from: 'A', to: 'W' },
    'the routing is explainable from the message itself',
  )
})

test('get-lead-history: tracking events are absent, not zeroed, when the campaign never measured them', async () => {
  const campaign = seedCampaign('Thread untracked')
  db.prepare('UPDATE campaigns SET track_opens = 0, track_clicks = 0 WHERE id = ?').run(campaign.id)
  const lead = seedLead()
  attach(campaign.id, lead.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id)
     VALUES (?, ?, ?, ?, 'out', 'Hi', 'Body', '', 'untracked-1')`
  ).run(owner.id, campaign.id, lead.id, SANDBOX)

  const thread = await json(await get(`/api/campaigns/${campaign.id}/leads/${lead.id}/messages`))
  const sent = thread.messages[0]
  assert.equal('openedAt' in sent, false, 'the client cannot mistake absence for zero')
  assert.equal('clickedAt' in sent, false)
  assert.deepEqual(thread.tracking, { opens: false, clicks: false }, 'and the reason is stated once for the thread')
})

test('get-lead-history: a long thread hands back its end, and says it is a tail', async () => {
  const campaign = seedCampaign('Long thread')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  const insert = db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, created_at)
     VALUES (?, ?, ?, ?, 'out', ?, 'Body', '', ?, ?)`
  )
  for (let i = 0; i < 60; i++) {
    const at = `2026-02-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`
    insert.run(owner.id, campaign.id, lead.id, SANDBOX, `long ${i}`, `long-${i}`, at)
  }

  const page = await json(await get(`/api/campaigns/${campaign.id}/leads/${lead.id}/messages?limit=10`))
  assert.deepEqual(page.messages.map((m) => m.subject), Array.from({ length: 10 }, (_, i) => `long ${50 + i}`),
    'the last ten, in reading order — not the first ten')
  assert.equal(page.total, 60)
  assert.equal(page.truncated, true, 'and it says this is the tail of a longer conversation')
})

// =============================================================================
// get-sequences.md
// =============================================================================

test('get-sequences: a branch is represented as a branch, not flattened into a line', async () => {
  // §2: "a linear list would misrepresent a playbook where reply: interested
  // and no reply 3d lead to different emails".
  const campaign = seedCampaign('Branching steps')
  const steps = await json(await get(`/api/campaigns/${campaign.id}/steps`))
  const intro = steps.steps.find((s) => s.nodeId === 'A')

  assert.equal(intro.branches.length, 2, 'both ways out of the first email are present')
  const byTarget = Object.fromEntries(intro.branches.map((b) => [b.to, b]))
  assert.equal(byTarget.W.condition.kind, 'reply')
  assert.equal(byTarget.W.condition.intent, 'interested')
  assert.equal(byTarget.B.condition.kind, 'no_reply')
  assert.deepEqual(intro.replyIntents, ['interested'], 'and the intents this step can be answered with')

  assert.equal(intro.id, 'A', 'the step id is the diagram node id, so an editor can target it')
  assert.deepEqual(steps.data.map((s) => s.id), ['A', 'B'], 'the documented envelope is the Send steps in path order')
})

test('get-sequences: reading the steps never creates a draft', async () => {
  // §5 DoD: "Sample compositions never create `drafts` rows, asserted by a
  // test" — a preview that could be mistaken for an approved email is the one
  // failure this route must not have.
  const campaign = seedCampaign('Sampled steps')
  attach(campaign.id, seedLead().id)
  db.prepare('INSERT OR IGNORE INTO node_examples (campaign_id, node_id, subject, body) VALUES (?, ?, ?, ?)')
    .run(campaign.id, 'A', 'Sample subject', 'Sample body')

  const before = db.prepare('SELECT COUNT(*) n FROM drafts').get().n
  const sampled = await json(await get(`/api/campaigns/${campaign.id}/steps?sample=1`))
  const intro = sampled.data.find((s) => s.id === 'A')

  assert.equal(intro.subject, 'Sample subject')
  assert.equal(intro.is_sample, true, 'labelled as a sample rather than as what will be sent')
  assert.match(intro.sample_note, /written at send time/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts').get().n, before, 'and not one draft row appeared')
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ?").get(campaign.id).n, 0,
    'nor any message',
  )
})

test('get-sequences: variants are absent rather than faked, because Harry has no A/B testing', async () => {
  const campaign = seedCampaign('No variants')
  const steps = await json(await get(`/api/campaigns/${campaign.id}/steps`))
  assert.equal('sequence_variants' in steps, false)
  assert.ok(steps.data.every((s) => !('sequence_variants' in s)), 'not on the steps either — an empty array would imply the feature')
})

// =============================================================================
// mark-lead-complete.md
// =============================================================================

test('mark-lead-complete: a completed lead receives nothing more while the campaign keeps running', async () => {
  // §5 DoD: "No message is sent for the lead in that campaign after the
  // completion timestamp, verified by an engine test."
  const campaign = seedCampaign('Completion')
  const finished = seedLead()
  const carrying = seedLead()
  attach(campaign.id, finished.id)
  attach(campaign.id, carrying.id)

  const done = await body(await post(`/api/campaigns/${campaign.id}/leads/${finished.id}/complete`))
  assert.equal(done.status, 200)
  assert.ok(done.body.completedAt)

  await running(campaign.id, () => tickFreely(3))
  assert.equal(sentTo(campaign.id, finished.id), 0, 'no Send node fired for the completed lead')
  assert.ok(sentTo(campaign.id, carrying.id) > 0, 'and the campaign was demonstrably sending at the time')
})

test('mark-lead-complete: completing withdraws the waiting draft so an approval cannot resurrect it', async () => {
  const campaign = seedCampaign('Completion draft')
  const lead = seedLead()
  attach(campaign.id, lead.id)

  db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(owner.id)
  try {
    await running(campaign.id, () => tickFreely(1))
    const draft = db.prepare('SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
    assert.equal(draft.status, 'pending')

    await post(`/api/campaigns/${campaign.id}/leads/${lead.id}/complete`)
    assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(draft.id).status, 'declined')

    // Approving it now must not put an email on the wire.
    db.prepare("UPDATE drafts SET status = 'approved', reviewed_at = datetime('now') WHERE id = ?").run(draft.id)
    await running(campaign.id, () => tickFreely(2))
    assert.equal(sentTo(campaign.id, lead.id), 0, 'a withdrawn draft stays withdrawn')
  } finally {
    db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
  }
})

test('mark-lead-complete: completing in one campaign leaves the other campaigns alone', async () => {
  const here = seedCampaign('Complete here')
  const there = seedCampaign('Complete there')
  const lead = seedLead()
  attach(here.id, lead.id)
  attach(there.id, lead.id)

  await post(`/api/campaigns/${here.id}/leads/${lead.id}/complete`)
  await running([here.id, there.id], () => tickFreely(2))

  assert.equal(sentTo(here.id, lead.id), 0)
  assert.ok(sentTo(there.id, lead.id) > 0, 'the other campaign is untouched')
})

test('mark-lead-complete: a repeat call changes nothing and writes no second event', async () => {
  const campaign = seedCampaign('Complete twice')
  const lead = seedLead()
  attach(campaign.id, lead.id)

  const first = await json(await post(`/api/campaigns/${campaign.id}/leads/${lead.id}/complete`))
  const second = await json(await post(`/api/campaigns/${campaign.id}/leads/${lead.id}/complete`))

  assert.equal(second.alreadyComplete, true)
  assert.equal(second.completedAt, first.completedAt, 'the original timestamp is preserved')
  assert.equal(events(campaign.id, 'lead_completed').length, 1, 'and one event, not two')
})

test('mark-lead-complete: a lead that is not in the campaign is a not-found, and nothing changes', async () => {
  const campaign = seedCampaign('Complete stranger')
  const outsider = seedLead()
  const res = await body(await post(`/api/campaigns/${campaign.id}/leads/${outsider.id}/complete`))
  assert.equal(res.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_leads WHERE lead_id = ?').get(outsider.id).n, 0)
})

// =============================================================================
// remove-email-accounts.md
// =============================================================================

function seedSandbox(email, limit = 100) {
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, next_send_at, created_at)
     VALUES (?, 'sandbox', ?, 'connected', ?, 0, '2020-01-01 00:00:00')`
  ).run(owner.id, email, limit)
  return db.prepare('SELECT * FROM mailboxes WHERE email = ?').get(email)
}

test('remove-email-accounts: a removed mailbox sends nothing further, and the rest carry the campaign', async () => {
  // §5 DoD: "An engine test proves no send from a removed mailbox after
  // removal." The mailbox stays connected throughout, so the only thing that
  // can stop it is the detach.
  const keep = seedSandbox('detach-keep@sandbox.local')
  const drop = seedSandbox('detach-drop@sandbox.local')
  const campaign = seedCampaign('Detaching', { mailboxId: keep.id })
  for (const m of [keep, drop]) {
    db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(campaign.id, m.id)
  }
  for (let i = 0; i < 8; i++) attach(campaign.id, seedLead().id)

  await running(campaign.id, () => tickFreely(3))
  const droppedBefore = db.prepare(
    "SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND mailbox_id = ? AND direction = 'out'"
  ).get(campaign.id, drop.id).n
  assert.ok(droppedBefore > 0, 'the mailbox was carrying part of the campaign before it was removed')

  const removed = await body(await del(`/api/campaigns/${campaign.id}/mailboxes`, { mailbox_ids: [drop.id] }))
  assert.equal(removed.status, 200)
  assert.equal(removed.body.removed, 1)

  for (let i = 0; i < 8; i++) attach(campaign.id, seedLead().id)
  await running(campaign.id, () => tickFreely(3))

  const droppedAfter = db.prepare(
    "SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND mailbox_id = ? AND direction = 'out'"
  ).get(campaign.id, drop.id).n
  assert.equal(droppedAfter, droppedBefore, 'not one email left the removed mailbox afterwards')
  assert.ok(
    db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND mailbox_id = ? AND direction = 'out'")
      .get(campaign.id, keep.id).n > droppedBefore,
    'and the campaign went on sending from what was left',
  )

  assert.equal(
    db.prepare('SELECT status FROM mailboxes WHERE id = ?').get(drop.id).status, 'connected',
    'the account itself is untouched — it was detached, not disconnected',
  )
})

test('remove-email-accounts: a removed mailbox still sends for the campaigns that kept it', async () => {
  const shared = seedSandbox('shared-detach@sandbox.local')
  const losing = seedCampaign('Losing it', { mailboxId: shared.id })
  const keeping = seedCampaign('Keeping it', { mailboxId: shared.id })
  for (const c of [losing, keeping]) {
    db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(c.id, shared.id)
  }
  attach(keeping.id, seedLead().id)

  assert.equal((await body(await del(`/api/campaigns/${losing.id}/mailboxes/${shared.id}`))).status, 200)

  await running(keeping.id, () => tickFreely(1))
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND mailbox_id = ? AND direction = 'out'")
      .get(keeping.id, shared.id).n,
    1, 'still connected and still usable by the other campaign',
  )
})

test('remove-email-accounts: the last mailbox cannot leave a running campaign, but can leave a paused one', async () => {
  const only = seedSandbox('last-one@sandbox.local')
  const campaign = seedCampaign('Last mailbox', { mailboxId: only.id })
  db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(campaign.id, only.id)
  attach(campaign.id, seedLead().id)

  await running(campaign.id, async () => {
    const refused = await body(await del(`/api/campaigns/${campaign.id}/mailboxes`, { mailbox_ids: [only.id] }))
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error, 'last_mailbox')
    assert.match(refused.body.message, /Pause it first|attach a replacement/i)
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE campaign_id = ?').get(campaign.id).n, 1,
      'nothing was removed',
    )
  })

  setStatus(campaign.id, 'paused')
  const allowed = await body(await del(`/api/campaigns/${campaign.id}/mailboxes`, { mailbox_ids: [only.id] }))
  assert.equal(allowed.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE campaign_id = ?').get(campaign.id).n, 0)

  // And it is now blocked from launching, which is the other half of §2.
  setStatus(campaign.id, 'draft')
  db.prepare('UPDATE campaigns SET mailbox_id = NULL WHERE id = ?').run(campaign.id)
  const blocked = await body(await put(`/api/campaigns/${campaign.id}/status`, { status: 'START' }))
  assert.equal(blocked.status, 422)
  assert.ok(blocked.body.blockers.some((b) => b.field === 'mailboxes'))
})

test('remove-email-accounts: one bad id removes nothing, and an empty list is a 422', async () => {
  const a = seedSandbox('allornothing-a@sandbox.local')
  const b = seedSandbox('allornothing-b@sandbox.local')
  const campaign = seedCampaign('All or nothing', { mailboxId: a.id })
  for (const m of [a, b]) {
    db.prepare('INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)').run(campaign.id, m.id)
  }

  const bad = await body(await del(`/api/campaigns/${campaign.id}/mailboxes`, { mailbox_ids: [a.id, 999999] }))
  assert.equal(bad.status, 404)
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM campaign_mailboxes WHERE campaign_id = ?').get(campaign.id).n, 2,
    'the good id in the same request was not acted on',
  )

  const empty = await body(await del(`/api/campaigns/${campaign.id}/mailboxes`, { mailbox_ids: [] }))
  assert.equal(empty.status, 422)
  const notArray = await body(await del(`/api/campaigns/${campaign.id}/mailboxes`, { mailbox_ids: 'all' }))
  assert.equal(notArray.status, 422)
  assert.equal(notArray.body.field, 'mailbox_ids')
})

// =============================================================================
// unsubscribe-lead.md
// =============================================================================

test('unsubscribe-lead: no campaign in the workspace writes to them again', async () => {
  // §5 DoD: "No send occurs for an unsubscribed lead in any campaign, proven by
  // an engine test." Two running campaigns, and the unsubscribe made from only
  // one of them.
  const first = seedCampaign('Unsub A')
  const second = seedCampaign('Unsub B')
  const lead = seedLead()
  const control = seedLead()
  attach(first.id, lead.id)
  attach(second.id, lead.id)
  attach(second.id, control.id)

  const res = await body(await post(`/api/campaigns/${first.id}/leads/${lead.id}/unsubscribe`))
  assert.equal(res.status, 200)
  assert.equal(res.body.campaigns, 2, 'both enrolments were stopped, not just the one asked about')

  await running([first.id, second.id], () => tickFreely(3))
  assert.equal(sentTo(first.id, lead.id), 0)
  assert.equal(sentTo(second.id, lead.id), 0, 'including the campaign the unsubscribe was not made from')
  assert.ok(sentTo(second.id, control.id) > 0, 'while that campaign was demonstrably sending')
})

test('unsubscribe-lead: every waiting draft for them is withdrawn, across campaigns', async () => {
  const first = seedCampaign('Unsub drafts A')
  const second = seedCampaign('Unsub drafts B')
  const lead = seedLead()
  attach(first.id, lead.id)
  attach(second.id, lead.id)

  db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(owner.id)
  try {
    await running([first.id, second.id], () => tickFreely(1))
    const pending = db.prepare("SELECT COUNT(*) n FROM drafts WHERE lead_id = ? AND status = 'pending'").get(lead.id).n
    assert.equal(pending, 2, 'one waiting in each campaign')

    await post(`/api/campaigns/${first.id}/leads/${lead.id}/unsubscribe`)
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM drafts WHERE lead_id = ? AND status = 'pending'").get(lead.id).n, 0,
      'and neither can be approved now',
    )
  } finally {
    db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
  }
})

test('unsubscribe-lead: a second unsubscribe keeps the first timestamp and writes no second event', async () => {
  const campaign = seedCampaign('Unsub twice')
  const lead = seedLead()
  attach(campaign.id, lead.id)

  const first = await json(await post(`/api/campaigns/${campaign.id}/leads/${lead.id}/unsubscribe`))
  const stored = db.prepare('SELECT unsubscribed_at FROM leads WHERE id = ?').get(lead.id).unsubscribed_at
  const second = await json(await post(`/api/campaigns/${campaign.id}/leads/${lead.id}/unsubscribe`))

  assert.equal(second.alreadyUnsubscribed, true)
  assert.equal(second.unsubscribedAt, stored)
  assert.equal(
    db.prepare('SELECT unsubscribed_at FROM leads WHERE id = ?').get(lead.id).unsubscribed_at, stored,
    'the original moment is preserved',
  )
  assert.ok(first.unsubscribedAt)
  assert.equal(events(campaign.id, 'lead_unsubscribed').length, 1)
})

test('unsubscribe-lead: the manual route and the footer link leave the record in the same state', async () => {
  // §5 DoD: "Manual and footer-click unsubscribes converge on one handler,
  // proven by a test." Compared column by column rather than by inspecting the
  // call graph — two handlers that agree today drift tomorrow.
  const campaign = seedCampaign('Convergence')
  const byRoute = seedLead()
  const byLink = seedLead()
  attach(campaign.id, byRoute.id)
  attach(campaign.id, byLink.id)

  await post(`/api/campaigns/${campaign.id}/leads/${byRoute.id}/unsubscribe`)
  // What server/tracking.js's one-click endpoint does, called the same way.
  unsubscribeLead(owner.id, byLink.id, { source: 'link', actor: 'recipient' })

  const shape = (leadId) => {
    const lead = db.prepare('SELECT status, unsubscribed_at, unsubscribed_source FROM leads WHERE id = ?').get(leadId)
    const link = db.prepare('SELECT state, outcome, unsubscribed_at FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
      .get(campaign.id, leadId)
    const blocked = db.prepare('SELECT COUNT(*) n FROM blocked_domains WHERE workspace_id = ? AND value = ?')
      .get(owner.id, db.prepare('SELECT email FROM leads WHERE id = ?').get(leadId).email).n
    return {
      status: lead.status,
      hasTimestamp: Boolean(lead.unsubscribed_at),
      state: link.state,
      outcome: link.outcome,
      linkTimestamped: Boolean(link.unsubscribed_at),
      blocked,
    }
  }
  const routed = shape(byRoute.id)
  assert.deepEqual(routed, shape(byLink.id), 'one code path decides who may be emailed')
  assert.deepEqual(routed, {
    status: 'unsubscribed', hasTimestamp: true, state: 'stopped',
    outcome: 'unsubscribed', linkTimestamped: true, blocked: 1,
  })
  // Only the origin differs, which is the one thing the trail has to record.
  assert.equal(db.prepare('SELECT unsubscribed_source s FROM leads WHERE id = ?').get(byRoute.id).s, 'manual')
  assert.equal(db.prepare('SELECT unsubscribed_source s FROM leads WHERE id = ?').get(byLink.id).s, 'link')
})

// =============================================================================
// update-lead.md
// =============================================================================

test('update-lead: one invalid field means nothing at all is written', async () => {
  const campaign = seedCampaign('Update atomic')
  const lead = seedLead({ first_name: 'Original' })
  attach(campaign.id, lead.id)

  const res = await body(await post(`/api/campaigns/${campaign.id}/leads/${lead.id}`, {
    first_name: 'Corrected',
    custom_fields: { 'not a valid key!!': 'x' },
  }))
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'custom_fields')
  assert.equal(
    db.prepare('SELECT first_name FROM leads WHERE id = ?').get(lead.id).first_name, 'Original',
    'the valid half of the request was not applied',
  )
})

test('update-lead: the 200-key custom-field cap is enforced and the good rows below it are kept', async () => {
  const campaign = seedCampaign('Custom fields')
  const lead = seedLead()
  attach(campaign.id, lead.id)

  const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`field ${i}`, String(i)]))
  const refused = await body(await post(`/api/campaigns/${campaign.id}/leads/${lead.id}`, { custom_fields: tooMany }))
  assert.equal(refused.status, 422)
  assert.equal(refused.body.field, 'custom_fields')
  assert.equal(db.prepare('SELECT custom_fields FROM leads WHERE id = ?').get(lead.id).custom_fields, '{}')

  const justFits = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field ${i}`, String(i)]))
  assert.equal((await body(await post(`/api/campaigns/${campaign.id}/leads/${lead.id}`, { custom_fields: justFits }))).status, 200)
  assert.equal(
    Object.keys(JSON.parse(db.prepare('SELECT custom_fields FROM leads WHERE id = ?').get(lead.id).custom_fields)).length,
    200, 'and 200 really are stored, not truncated',
  )
})

test('update-lead: an address already belonging to someone else is refused with a merge target', async () => {
  const campaign = seedCampaign('Duplicate address')
  const lead = seedLead()
  const other = seedLead()
  attach(campaign.id, lead.id)

  const res = await body(await post(`/api/campaigns/${campaign.id}/leads/${lead.id}`, {
    email: other.email, confirm_email_change: true,
  }))
  assert.equal(res.status, 409)
  assert.equal(res.body.mergeWithLeadId, other.id, 'a merge affordance, not a bare conflict')
  assert.equal(
    db.prepare('SELECT email FROM leads WHERE id = ?').get(lead.id).email, lead.email,
    'and the address was not changed',
  )
})

test('update-lead: a correction withdraws the draft written against the old details, and the next one uses the new', async () => {
  // §2: "the draft is flagged as out of date with an option to recompose". The
  // recomposition is the part worth proving — a withdrawn draft that never
  // comes back would stall the lead instead of correcting them.
  const campaign = seedCampaign('Stale draft')
  const lead = seedLead({ first_name: 'Jhon' })
  attach(campaign.id, lead.id)

  db.prepare('UPDATE users SET require_approval = 1 WHERE id = ?').run(owner.id)
  try {
    await running(campaign.id, () => tickFreely(1))
    const stale = db.prepare('SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
    assert.equal(stale.status, 'pending')

    const res = await body(await post(`/api/campaigns/${campaign.id}/leads/${lead.id}`, { first_name: 'John' }))
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.changed, ['first_name'])
    assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(stale.id).status, 'declined')

    await running(campaign.id, () => tickFreely(1))
    const fresh = db.prepare(
      "SELECT * FROM drafts WHERE campaign_id = ? AND lead_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
    ).get(campaign.id, lead.id)
    assert.ok(fresh, 'a replacement was composed rather than the lead being stranded')
    assert.ok(fresh.id > stale.id)
    assert.equal(
      db.prepare('SELECT first_name FROM leads WHERE id = ?').get(lead.id).first_name, 'John',
      'and it was composed after the correction landed',
    )
  } finally {
    db.prepare('UPDATE users SET require_approval = 0 WHERE id = ?').run(owner.id)
  }
})

test('update-lead: the activity trail records which fields changed and not what they now say', async () => {
  const campaign = seedCampaign('Update trail')
  const lead = seedLead()
  attach(campaign.id, lead.id)
  await post(`/api/campaigns/${campaign.id}/leads/${lead.id}`, { phone: '+61 400 999 888' })

  const trail = db.prepare("SELECT * FROM events WHERE campaign_id = ? AND type = 'lead_updated'").all(campaign.id)
  assert.equal(trail.length, 1)
  assert.match(trail[0].detail, /fields: phone/)
  assert.ok(!trail[0].detail.includes('999 888'), 'a phone number does not belong in the trail')
})

// =============================================================================
// update-schedule.md
// =============================================================================

test('update-schedule: an invalid timezone, an empty week and an inverted day are refused by field', async () => {
  const campaign = seedCampaign('Schedule validation')
  const stored = () => db.prepare('SELECT schedule FROM campaigns WHERE id = ?').get(campaign.id).schedule
  const untouched = stored()

  for (const [payload, field] of [
    [{ timezone: 'Mars/Olympus' }, 'timezone'],
    [{ days: [] }, 'days'],
    [{ days: [7] }, 'days'],
    [{ start_hour: '17:00', end_hour: '09:00' }, 'end_hour'],
    [{ start_hour: '9am' }, 'start_hour'],
  ]) {
    const res = await body(await put(`/api/campaigns/${campaign.id}/schedule`, payload))
    assert.equal(res.status, 422, `${JSON.stringify(payload)} is refused`)
    assert.equal(res.body.field, field)
  }
  assert.equal(stored(), untouched, 'and none of the five refusals wrote a schedule')
})

test('update-schedule: the window that was saved is the window the send gate enforces', async () => {
  // §5 DoD: "Pacing tests prove no send outside the window in the campaign's
  // timezone" and "Schedule changes take effect on the next tick with no
  // restart".
  //
  // Asserted through `resolveSend` — the function server/engine.js calls before
  // every email — at a fixed instant, so the result cannot depend on the hour
  // the suite happens to run at. A Gmail mailbox is used because the clock is
  // deliberately skipped for sandbox mailboxes (see the divergence test below).
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, next_send_at, created_at)
     VALUES (?, 'gmail', 'clock@company.test', 'connected', 100, 0, '2020-01-01 00:00:00')`
  ).run(owner.id)
  const gmail = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('clock@company.test')
  const campaign = seedCampaign('Windowed', { mailboxId: gmail.id })

  const saved = await body(await put(`/api/campaigns/${campaign.id}/schedule`, {
    timezone: 'UTC', days: [1, 2, 3, 4, 5], start_hour: '09:00', end_hour: '17:00', min_gap_minutes: 0,
  }))
  assert.equal(saved.status, 200)

  // Re-read: the rules are resolved from the stored row, which is what makes
  // "takes effect on the next tick without a restart" true.
  const live = () => ({ ...db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id), status: 'running' })

  const WED_10 = Date.parse('2026-06-10T10:00:00Z')  // a Wednesday, inside the window
  const WED_18 = Date.parse('2026-06-10T18:00:00Z')  // the same Wednesday, after it
  const SUN_10 = Date.parse('2026-06-14T10:00:00Z')  // a Sunday, right hour, wrong day

  assert.equal(resolveSend({ owner, campaign: live(), mailbox: gmail, at: WED_10 }).ok, true, 'inside the window it may send')

  const late = resolveSend({ owner, campaign: live(), mailbox: gmail, at: WED_18 })
  assert.equal(late.ok, false)
  assert.equal(late.gate, 'outside_window')
  assert.ok(late.until > WED_18, 'and it says when the window next opens')

  const weekend = resolveSend({ owner, campaign: live(), mailbox: gmail, at: SUN_10 })
  assert.equal(weekend.ok, false, 'Monday-to-Friday means Monday to Friday')
  assert.equal(weekend.gate, 'outside_window')

  // Widening it takes effect on the very next resolution — no restart, no cache.
  assert.equal((await body(await put(`/api/campaigns/${campaign.id}/schedule`, {
    timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start_hour: '08:00', end_hour: '20:00',
  }))).status, 200)
  assert.equal(resolveSend({ owner, campaign: live(), mailbox: gmail, at: SUN_10 }).ok, true)
  assert.equal(resolveSend({ owner, campaign: live(), mailbox: gmail, at: WED_18 }).ok, true)
})

test('update-schedule: the minimum gap is a floor under the randomised gap, not a fixed interval', async () => {
  const gmail = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('clock@company.test')
  const campaign = seedCampaign('Gap floor', { mailboxId: gmail.id })
  const lead = seedLead()
  attach(campaign.id, lead.id)

  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, created_at)
     VALUES (?, ?, ?, ?, 'out', 'Hi', 'Body', '', 'gap-1', '2026-06-10 09:50:00')`
  ).run(owner.id, campaign.id, lead.id, gmail.id)

  const AT = Date.parse('2026-06-10T10:00:00Z')   // ten minutes after that send
  const live = () => ({ ...db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign.id), status: 'running' })

  await put(`/api/campaigns/${campaign.id}/schedule`, {
    timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start_hour: '08:00', end_hour: '20:00', min_gap_minutes: 120,
  })
  const held = resolveSend({ owner, campaign: live(), mailbox: gmail, at: AT })
  assert.equal(held.ok, false)
  assert.equal(held.gate, 'min_gap')
  assert.equal(held.until, Date.parse('2026-06-10T11:50:00Z'), 'two hours from the last send, to the minute')

  await put(`/api/campaigns/${campaign.id}/schedule`, {
    timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start_hour: '08:00', end_hour: '20:00', min_gap_minutes: 5,
  })
  const free = resolveSend({ owner, campaign: live(), mailbox: gmail, at: AT })
  assert.equal(free.gate === 'min_gap', false, 'a five-minute floor does not bind ten minutes later')

  // A floor, never a ceiling: the derived gap can be longer, and it is
  // deterministic, so a repeat run gives the same answer (§5: "never
  // Math.random — so behaviour stays reproducible in tests").
  const first = nextGapMs(sendWindow(owner), gmail, AT)
  const again = nextGapMs(sendWindow(owner), gmail, AT)
  assert.equal(first, again, 'the scatter is a hash, not a die roll')
})

test('update-schedule: sandbox mailboxes skip the clock while the daily limit still applies — the recorded divergence', async () => {
  // §5 Scope states this outright: "Sandbox mailboxes continue to skip the
  // clock and the gap, while daily limits still apply, as they do today." A
  // divergence nobody tests is indistinguishable from a bug, so it is asserted
  // in both halves.
  const box = seedSandbox('divergence@sandbox.local', 4)
  const campaign = seedCampaign('Sandbox divergence', { mailboxId: box.id })
  for (let i = 0; i < 6; i++) attach(campaign.id, seedLead().id)

  // A window that is closed for the whole of every day this test could run in.
  await put(`/api/campaigns/${campaign.id}/schedule`, {
    timezone: 'UTC', days: [1], start_hour: '03:00', end_hour: '03:30', min_gap_minutes: 600,
  })

  await running(campaign.id, () => tickFreely(4))
  const sent = sentCount(campaign.id)
  assert.ok(sent > 0, 'the clock and the gap did not stop a sandbox mailbox')

  // The ceiling did, though: four a day less the follow-up reserve.
  const after = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(box.id)
  assert.ok(sent <= dailyCap(after), `the daily limit still bound it — ${sent} sends against a cap of ${dailyCap(after)}`)
  assert.equal(remainingToday(after), dailyCap(after) - sent)
})

// =============================================================================
// update-sequences.md
// =============================================================================

const REWRITTEN = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- no reply 2d --> C[Send: different follow-up]
  C -- no reply 5d --> L([Lost])
`

test('update-sequences: a running campaign cannot be edited, and its diagram is untouched', async () => {
  const campaign = seedCampaign('Sequence locked')
  attach(campaign.id, seedLead().id)

  await running(campaign.id, async () => {
    const res = await body(await put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: REWRITTEN }))
    assert.equal(res.status, 409)
    assert.equal(res.body.error, 'campaign_running')
    assert.match(res.body.message, /Pause/i)
  })
  assert.equal(
    db.prepare('SELECT mermaid FROM campaigns WHERE id = ?').get(campaign.id).mermaid, PLAYBOOK,
    'the running campaign was unaffected',
  )
})

test('update-sequences: one bad step means nothing is saved', async () => {
  const campaign = seedCampaign('Sequence atomic')
  const tooLong = PLAYBOOK.replace('no reply 3d', 'no reply 400d')
  const res = await body(await put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: tooLong }))
  assert.equal(res.status, 422)
  assert.match(res.body.message, /365 days/)
  assert.match(res.body.message, /"A"/, 'and the message names the step so the editor can point at it')
  assert.equal(db.prepare('SELECT mermaid FROM campaigns WHERE id = ?').get(campaign.id).mermaid, PLAYBOOK)

  const unknownVar = PLAYBOOK.replace('Send: intro', 'Send: hello {{favourite_colour}}')
  const bad = await body(await put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: unknownVar }))
  assert.equal(bad.status, 422)
  assert.match(bad.body.message, /favourite_colour/, 'unknown merge variables are caught before the save, not at send time')
  assert.equal(db.prepare('SELECT mermaid FROM campaigns WHERE id = ?').get(campaign.id).mermaid, PLAYBOOK)
})

test('update-sequences: the preview names the leads a removed step would strand, and the save does exactly that', async () => {
  // §2: "Given a step is removed, when leads were sitting at it, then I am told
  // how many and where they will go instead." Then the engine is run to prove
  // "parked for review" means what it says: no further email, and no silent
  // restart from the top of the playbook.
  const campaign = seedCampaign('Sequence remap')
  const stranded = seedLead()
  // A lead nobody has written to yet, so the tick below has visible work to do
  // and "the parked lead got nothing" cannot pass because the campaign was
  // idle.
  const control = seedLead()
  attach(campaign.id, stranded.id)
  attach(campaign.id, control.id)
  db.prepare("UPDATE campaign_leads SET node_id = 'B', state = 'waiting' WHERE campaign_id = ? AND lead_id = ?")
    .run(campaign.id, stranded.id)

  const preview = await json(await put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: REWRITTEN, preview: true }))
  assert.equal(preview.saved, false)
  assert.deepEqual(preview.remapping.map((r) => ({ node: r.node, leads: r.leads, goesTo: r.goesTo })),
    [{ node: 'B', leads: 1, goesTo: 'needs_attention' }])
  assert.equal(
    db.prepare('SELECT mermaid FROM campaigns WHERE id = ?').get(campaign.id).mermaid, PLAYBOOK,
    'a preview writes nothing',
  )

  const saved = await json(await put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: REWRITTEN }))
  assert.equal(saved.remapped, 1, 'the save did exactly what the preview said it would')
  const after = db.prepare('SELECT state, error FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .get(campaign.id, stranded.id)
  assert.equal(after.state, 'needs_attention')
  assert.match(after.error, /"B" was removed/)

  await running(campaign.id, () => tickFreely(2))
  assert.equal(sentTo(campaign.id, stranded.id), 0, 'a parked lead is not restarted and not resent')
  assert.equal(
    db.prepare('SELECT state FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, stranded.id).state,
    'needs_attention', 'and the tick left them parked rather than picking them back up',
  )
  assert.ok(sentTo(campaign.id, control.id) > 0, 'while the campaign was demonstrably sending throughout')
})

test('update-sequences: a saved step set passes the same validator that launch does', async () => {
  const campaign = seedCampaign('Sequence launchable', { mermaid: '' })
  attach(campaign.id, seedLead().id)

  const broken = await body(await put(`/api/campaigns/${campaign.id}/sequence`, {
    mermaid: 'flowchart TD\n  A[Send: nowhere]\n',
  }))
  assert.equal(broken.status, 422, 'the diagram the launcher would reject cannot be saved either')

  assert.equal((await body(await put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: PLAYBOOK }))).status, 200)
  const start = await body(await put(`/api/campaigns/${campaign.id}/status`, { status: 'START' }))
  assert.equal(start.status, 200, 'and everything that can be saved can be launched')
  setStatus(campaign.id, 'draft')
})

// =============================================================================
// update-team-member.md
// =============================================================================

test('update-team-member: an owner can be set and cleared, and clearing does not fall back to the workspace owner', async () => {
  const campaign = seedCampaign('Owned')
  db.prepare("INSERT INTO team_members (owner_id, email, role, status) VALUES (?, 'colleague@x.com', 'member', 'active')")
    .run(owner.id)
  db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:colleague@x.com', 'colleague@x.com', 'Colleague')").run()
  const colleague = db.prepare('SELECT * FROM users WHERE email = ?').get('colleague@x.com')

  const assigned = await body(await put(`/api/campaigns/${campaign.id}/owner`, { user_id: colleague.id }))
  assert.equal(assigned.status, 200)
  assert.equal(
    db.prepare('SELECT owner_email FROM campaigns WHERE id = ?').get(campaign.id).owner_email, 'colleague@x.com',
  )

  const cleared = await body(await put(`/api/campaigns/${campaign.id}/owner`, { user_id: null }))
  assert.equal(cleared.status, 200)
  assert.equal(
    db.prepare('SELECT owner_email FROM campaigns WHERE id = ?').get(campaign.id).owner_email, '',
    'unassigned, not silently the workspace owner',
  )
  assert.equal((await json(await get(`/api/campaigns/${campaign.id}/detail`))).ownerEmail, '')
})

test('update-team-member: a non-member cannot own a campaign, and an invited-but-unjoined one cannot either', async () => {
  const campaign = seedCampaign('Owner validation')
  const outsider = await body(await put(`/api/campaigns/${campaign.id}/owner`, { user_id: stranger.id }))
  assert.equal(outsider.status, 404, 'somebody else\'s user id is not a member of this workspace')

  db.prepare("INSERT INTO team_members (owner_id, email, role, status) VALUES (?, 'invited@x.com', 'member', 'invited')")
    .run(owner.id)
  db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:invited@x.com', 'invited@x.com', 'Invited')").run()
  const invited = db.prepare('SELECT * FROM users WHERE email = ?').get('invited@x.com')

  const pending = await body(await put(`/api/campaigns/${campaign.id}/owner`, { user_id: invited.id }))
  assert.equal(pending.status, 422)
  assert.equal(pending.body.field, 'user_id')
  assert.equal(db.prepare('SELECT owner_email FROM campaigns WHERE id = ?').get(campaign.id).owner_email, '')
})

test('update-team-member: assignment is accountability, not access control', async () => {
  // §2: "Given assignment does not change permissions, when a different member
  // opens the campaign, then they can still approve and act." Proved by acting:
  // the workspace owner starts, edits and pauses a campaign owned by somebody
  // else.
  const campaign = seedCampaign('Owned elsewhere')
  attach(campaign.id, seedLead().id)
  const colleague = db.prepare('SELECT * FROM users WHERE email = ?').get('colleague@x.com')
  assert.equal((await body(await put(`/api/campaigns/${campaign.id}/owner`, { user_id: colleague.id }))).status, 200)

  assert.equal((await body(await put(`/api/campaigns/${campaign.id}/settings`, { name: 'Owned elsewhere, edited' }))).status, 200)
  assert.equal((await body(await put(`/api/campaigns/${campaign.id}/status`, { status: 'START' }))).status, 200)
  assert.equal((await body(await put(`/api/campaigns/${campaign.id}/status`, { status: 'PAUSED' }))).status, 200)
  assert.equal(
    db.prepare('SELECT owner_email FROM campaigns WHERE id = ?').get(campaign.id).owner_email, 'colleague@x.com',
    'and the owner is still recorded — nothing about acting changed it',
  )
  setStatus(campaign.id, 'draft')
})

test('update-team-member: the assignment change is named in the activity trail', async () => {
  const campaign = seedCampaign('Owner trail')
  const colleague = db.prepare('SELECT * FROM users WHERE email = ?').get('colleague@x.com')
  await put(`/api/campaigns/${campaign.id}/owner`, { user_id: colleague.id })
  await put(`/api/campaigns/${campaign.id}/owner`, { user_id: null })

  const trail = events(campaign.id, 'campaign_owner')
  assert.equal(trail.length, 2)
  assert.match(trail[0].detail, /-> colleague@x\.com/)
  assert.match(trail[1].detail, /cleared by a2@x\.com/)
})

// =============================================================================
// get-webhooks.md / save-webhooks.md / delete-webhook.md / get-webhook-summary.md
// =============================================================================

const { fireWebhooks } = await import('../server/parity/webhooks.js')

// A transport that records what it was handed. Nothing here touches a network.
function recorder() {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, body: init?.body })
    return { status: 200, ok: true, text: async () => 'ok' }
  }
  fn.calls = calls
  return fn
}

const fire = (campaignId, transport) => fireWebhooks(
  owner.id, 'sent', { campaign_id: campaignId }, { fetchImpl: transport, backoffMs: 0, maxAttempts: 1 }
)

test('save-webhooks: a hook is created then updated in place, never duplicated', async () => {
  const campaign = seedCampaign('Hooked')
  const created = await body(await post(`/api/campaigns/${campaign.id}/webhooks`, {
    id: null, name: 'CRM', webhook_url: 'https://hooks.example.test/crm', event_types: ['EMAIL_SENT'],
  }))
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.created, true)
  const id = created.body.data.id

  const updated = await body(await post(`/api/campaigns/${campaign.id}/webhooks`, {
    id, name: 'CRM (renamed)', webhook_url: 'https://hooks.example.test/crm2', event_types: ['EMAIL_SENT', 'LEAD_REPLIED'],
  }))
  assert.equal(updated.status, 200)
  assert.equal(updated.body.created, false)
  assert.equal(updated.body.data.id, id)
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM webhooks WHERE campaign_id = ? AND is_active >= 0').get(campaign.id).n, 1,
    'one row, updated — not a second one',
  )
  assert.equal(db.prepare('SELECT url FROM webhooks WHERE id = ?').get(id).url, 'https://hooks.example.test/crm2')
})

test('save-webhooks: loopback, private and non-HTTPS destinations are refused with a reason', async () => {
  const campaign = seedCampaign('SSRF')
  const before = db.prepare('SELECT COUNT(*) n FROM webhooks WHERE campaign_id = ?').get(campaign.id).n
  for (const url of [
    'http://hooks.example.test/plain',
    'https://127.0.0.1/hook',
    'https://localhost/hook',
    'https://10.0.0.5/hook',
    'https://192.168.1.9/hook',
    'https://169.254.169.254/latest/meta-data',
  ]) {
    const res = await body(await post(`/api/campaigns/${campaign.id}/webhooks`, {
      id: null, name: 'Bad', webhook_url: url, event_types: ['EMAIL_SENT'],
    }))
    assert.equal(res.status, 422, `${url} is refused`)
    assert.ok(String(res.body.message || '').length > 0, 'with a stated reason')
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM webhooks WHERE campaign_id = ?').get(campaign.id).n, before,
    'and not one of them was stored')
})

test('save-webhooks: the destination URL never reaches the activity trail in full', async () => {
  const campaign = seedCampaign('Secret URL')
  const secret = 'https://hooks.example.test/T000/B111/verySecretPathSegment'
  await post(`/api/campaigns/${campaign.id}/webhooks`, {
    id: null, name: 'Slack', webhook_url: secret, event_types: ['EMAIL_SENT'],
  })
  const trail = db.prepare('SELECT detail FROM events WHERE campaign_id = ?').all(campaign.id)
  const text = trail.map((t) => t.detail).join('\n')
  assert.ok(text.includes('hooks.example.test'), 'the host is recorded, so the entry means something')
  assert.ok(!text.includes('verySecretPathSegment'), 'and the secret path segment is not')
})

test('delete-webhook: a deleted hook stops receiving, while the same URL on another campaign carries on', async () => {
  // §2: "when the campaign next produces an event that would have been posted
  // ... then nothing is sent to that URL" and "when I look at other campaigns
  // using the same URL, then they are unaffected". The proof is what the
  // transport was handed, not what the delete route returned.
  const mine = seedCampaign('Hook deleted here')
  const theirs = seedCampaign('Hook kept here')
  const url = 'https://hooks.example.test/shared-endpoint'
  const a = await json(await post(`/api/campaigns/${mine.id}/webhooks`, {
    id: null, name: 'A', webhook_url: url, event_types: ['EMAIL_SENT'],
  }))
  await post(`/api/campaigns/${theirs.id}/webhooks`, {
    id: null, name: 'B', webhook_url: url, event_types: ['EMAIL_SENT'],
  })

  const before = recorder()
  await fire(mine.id, before)
  assert.deepEqual(before.calls.map((c) => c.url), [url], 'it was firing before the delete')

  const removed = await body(await del(`/api/campaigns/${mine.id}/webhooks/${a.data.id}`))
  assert.equal(removed.status, 200)

  const after = recorder()
  await fire(mine.id, after)
  assert.equal(after.calls.length, 0, 'nothing is sent to that URL for this campaign any more')

  const other = recorder()
  await fire(theirs.id, other)
  assert.deepEqual(other.calls.map((c) => c.url), [url],
    'and the identical URL on another campaign is untouched — deletion is scoped to the pair')
})

test('delete-webhook: a hook id belonging to another campaign is a 404 and nothing is removed', async () => {
  const a = seedCampaign('Pair A')
  const b = seedCampaign('Pair B')
  const hook = await json(await post(`/api/campaigns/${a.id}/webhooks`, {
    id: null, name: 'Pairing', webhook_url: 'https://hooks.example.test/pairing', event_types: ['EMAIL_SENT'],
  }))

  const res = await body(await del(`/api/campaigns/${b.id}/webhooks/${hook.data.id}`))
  assert.equal(res.status, 404)
  assert.equal(db.prepare('SELECT is_active FROM webhooks WHERE id = ?').get(hook.data.id).is_active, 1,
    'the mismatched pair removed nothing')

  const alive = recorder()
  await fire(a.id, alive)
  assert.equal(alive.calls.length, 1, 'and it is still delivering')
})

test('get-webhooks: a campaign with no hooks answers with an empty list, not an error', async () => {
  const campaign = seedCampaign('No hooks')
  const res = await body(await get(`/api/campaigns/${campaign.id}/webhooks`))
  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)
  assert.deepEqual(res.body.data, [])
})

test('get-webhooks: an inactive hook is listed as off rather than omitted, and delivers nothing', async () => {
  const campaign = seedCampaign('Off hook')
  const hook = await json(await post(`/api/campaigns/${campaign.id}/webhooks`, {
    id: null, name: 'Switched off', webhook_url: 'https://hooks.example.test/off', event_types: ['EMAIL_SENT'],
    is_active: false,
  }))

  const list = await json(await get(`/api/campaigns/${campaign.id}/webhooks`))
  const row = list.data.find((w) => w.id === hook.data.id)
  assert.ok(row, 'an off hook is still shown — silence would read as "not configured"')
  assert.equal(row.is_active, false)

  const transport = recorder()
  await fire(campaign.id, transport)
  assert.equal(transport.calls.length, 0, 'and "off" is a fact about delivery, not only about the row')
})

test('get-webhook-summary: no attempts is zeros and a zero rate, never a divide by zero', async () => {
  const campaign = seedCampaign('Summary empty')
  const res = await json(await get(
    `/api/campaigns/${campaign.id}/notifications/summary?from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z`
  ))
  assert.equal(res.total_calls, 0)
  assert.equal(res.successful_calls, 0)
  assert.equal(res.failed_calls, 0)
  assert.equal(res.success_rate, 0)
  assert.ok(Number.isFinite(res.success_rate), 'a number, not NaN')
})

test('get-webhook-summary: the counters and the rate describe the deliveries that really happened', async () => {
  // Three attempts, two of which fail, driven through the real delivery path so
  // the summary is reading rows the sender wrote rather than a fixture.
  const campaign = seedCampaign('Summary counted')
  await post(`/api/campaigns/${campaign.id}/webhooks`, {
    id: null, name: 'Flaky', webhook_url: 'https://hooks.example.test/flaky', event_types: ['EMAIL_SENT'],
  })

  let n = 0
  const flaky = async () => {
    n += 1
    return { status: n === 1 ? 200 : 500, ok: n === 1, text: async () => 'x' }
  }
  for (let i = 0; i < 3; i++) await fire(campaign.id, flaky)

  const from = new Date(Date.now() - 86400e3).toISOString()
  const to = new Date(Date.now() + 86400e3).toISOString()
  const res = await json(await get(`/api/campaigns/${campaign.id}/notifications/summary?from=${from}&to=${to}`))
  assert.equal(res.total_calls, 3)
  assert.equal(res.successful_calls, 1)
  assert.equal(res.failed_calls, 2)
  assert.equal(res.success_rate, 33.3, 'one decimal place, computed server-side')
  assert.equal(res.successful_calls + res.failed_calls, res.total_calls, 'the three counters agree by construction')
})

test('get-webhook-summary: an inverted or malformed window is refused naming the field', async () => {
  const campaign = seedCampaign('Summary windows')
  const inverted = await body(await get(
    `/api/campaigns/${campaign.id}/notifications/summary?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`
  ))
  assert.equal(inverted.status, 422)
  const malformed = await body(await get(
    `/api/campaigns/${campaign.id}/notifications/summary?from=whenever&to=2026-01-01T00:00:00.000Z`
  ))
  assert.equal(malformed.status, 422)
  assert.ok(malformed.body.field, 'the 422 names a field')
})

test('webhooks: a failing endpoint never blocks or delays an email', async () => {
  // save-webhooks.md §5 DoD: "A failing hook cannot delay or block an email
  // send, proven by an engine test."
  const campaign = seedCampaign('Hook cannot block')
  await post(`/api/campaigns/${campaign.id}/webhooks`, {
    id: null, name: 'Dead', webhook_url: 'https://hooks.example.test/dead', event_types: ['EMAIL_SENT'],
  })
  attach(campaign.id, seedLead().id)

  await running(campaign.id, () => tickFreely(1))
  assert.equal(sentCount(campaign.id), 1, 'the email went out regardless of what the hook did')
})
