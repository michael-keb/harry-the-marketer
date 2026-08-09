// Coverage for behaviour four parallel agents changed and could not finish
// testing before they crashed.
//
// Each agent reported honestly that it had altered behaviour and left it
// unverified. That is the dangerous state: the suite was green throughout,
// because green only ever meant "nothing known was broken" — none of these
// paths had a test at all. This file is the debt being paid, and every case
// below was chosen because getting it wrong is silent.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-followup-'))
process.env.AI_MODE = 'off'
process.env.DEV_LOGIN = '1'

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { dailyCap, remainingToday } = await import('../server/pacing.js')

db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:f@x.com', 'f@x.com', 'Owner', 0)").run()
const owner = db.prepare('SELECT * FROM users WHERE id = 1').get()

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
const login = await fetch(`${base}/api/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: owner.email }),
})
const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
test.after(() => new Promise((r) => server.close(r)))

const get = (p) => fetch(`${base}${p}`, { headers: { cookie } })
const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
})

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const RANGE = `from=${day(-7)}&to=${day(1)}`

// ---------------------------------------------------------------------------
// 1. An empty campaign filter means "no campaigns", not "every campaign"
// ---------------------------------------------------------------------------

// `campaignClause([])` was changed from a no-op to ` AND 1 = 0`. The reasoning
// is right — answering a request for one client's numbers with the whole
// workspace's is worse than an empty table — but it is reachable from roughly
// fifteen routes through the new `client_ids` path, and a mistake here leaks
// one client's figures into another client's report.

db.prepare("INSERT INTO mailboxes (user_id, provider, email, status) VALUES (1, 'sandbox', 'me@sandbox.local', 'connected')").run()
db.prepare("INSERT INTO clients (workspace_id, name, email) VALUES (1, 'Northwind', 'ops@northwind.test')").run()
const client1 = db.prepare('SELECT id FROM clients WHERE name = ?').get('Northwind').id
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, client_id) VALUES (1, 'Northwind outbound', 'running', 1, ?)").run(client1)
const campaign1 = db.prepare('SELECT id FROM campaigns WHERE name = ?').get('Northwind outbound').id

// One real send on that campaign, so "the whole workspace" and "no campaigns"
// are visibly different answers.
db.prepare('INSERT INTO leads (user_id, email) VALUES (1, ?)').run('n1@acme.test')
const lead1 = db.prepare('SELECT id FROM leads WHERE email = ?').get('n1@acme.test').id
db.prepare(
  `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status)
   VALUES (1, ?, ?, 1, 'out', 'Hi', 'Body', 'n1@acme.test', 'fu-1', 'sent')`
).run(campaign1, lead1)

test('a client filter naming a client that owns campaigns returns that client\'s figures', async () => {
  const res = await get(`/api/analytics/overview?${RANGE}&client_ids=${client1}`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok((body.sent ?? body.data?.overall_stats?.sent ?? 0) > 0, 'the send is counted')
})

test('a client filter matching no campaign returns nothing, never the whole workspace', async () => {
  // The failure this guards against is silent and severe: an unknown or
  // empty-handed client id falling back to "no filter" would show one client
  // the entire workspace's numbers.
  const unknown = 999_999
  const res = await get(`/api/analytics/overview?${RANGE}&client_ids=${unknown}`)
  assert.equal(res.status, 200, 'an unknown client is an empty answer, not an error that reveals existence')

  const body = await res.json()
  const sent = body.sent ?? body.data?.overall_stats?.sent ?? 0
  assert.equal(sent, 0, 'no campaigns matched, so nothing is counted')
})

test('the empty-filter rule holds across the campaign-shaped surfaces too', async () => {
  for (const route of ['/api/analytics/campaigns', '/api/analytics/campaigns/performance']) {
    const res = await get(`${route}?${RANGE}&client_ids=999999`)
    assert.equal(res.status, 200, route)
    const body = await res.json()
    const items = body.items || body.data?.campaign_list || body.data?.campaign_wise_performance || []
    assert.equal(items.length, 0, `${route} returned nothing rather than everything`)
  }
})

// ---------------------------------------------------------------------------
// 2. Warm-up actually limits sending
// ---------------------------------------------------------------------------

// `pacing.dailyCap()` was changed so `warmup_daily_count` binds at the send
// path. Before, the setting was stored, echoed back by the API as
// `effectiveDailyCap`, and tuned automatically off bounce telemetry — while the
// engine ignored it entirely. Exactly the shape of the mailbox-pin defect: a
// setting that changed what the product said and nothing about what it did.

// Gmail, not sandbox: `dailyCap` returns the raw limit for every other provider
// before it reaches the warm-up branch. That is right — a sandbox mailbox sends
// nowhere, so a ramp protects no domain — but it means a sandbox fixture cannot
// prove anything here.
test('a warming-up mailbox is capped at its warm-up count, not its daily limit', () => {
  const today = new Date().toISOString().slice(0, 10)
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, warmup_enabled, warmup_daily_count, sent_today, sent_today_date, created_at)
     VALUES (1, 'gmail', 'warming@company.test', 'connected', 50, 1, 5, 5, ?, ?)`
  ).run(today, '2020-01-01 00:00:00')
  const mb = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('warming@company.test')

  assert.equal(dailyCap(mb), 5, 'the warm-up count is the cap')
  assert.equal(remainingToday(mb), 0, 'and five sent means none left — not forty-five')
})

test('warm-up does not apply to a sandbox mailbox, which sends nowhere', () => {
  // Stated as a test so the exemption is a decision on the record rather than
  // an early return nobody noticed.
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, warmup_enabled, warmup_daily_count)
     VALUES (1, 'sandbox', 'sandboxed@sandbox.local', 'connected', 50, 1, 5)`
  ).run()
  const mb = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('sandboxed@sandbox.local')
  assert.equal(dailyCap(mb), 50)
})

test('turning warm-up off restores the full daily limit', () => {
  const mb = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('warming@company.test')
  assert.equal(dailyCap({ ...mb, warmup_enabled: 0 }), 50)
})

test('a warm-up count above the daily limit cannot raise the cap', () => {
  // A setting must not be usable to send more than the mailbox allows.
  const mb = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('warming@company.test')
  assert.equal(dailyCap({ ...mb, warmup_daily_count: 500 }), 50, 'the limit still wins')
})

test('the send gate refuses once the warm-up count is spent, and says so', async () => {
  // The claim that matters: `dailyCap` is arithmetic, and this asserts the gate
  // the engine calls before every send actually consults it. Asserted at the
  // gate rather than by ticking, because warm-up only binds for gmail and a
  // gmail mailbox would try to reach Google — the gate is the last decision
  // point before that call, so it is where the cap has to bite.
  const { resolveSend, sendingContext } = await import('../server/gates.js')
  // A 24-hour, every-day window, so the recipient-quiet-hours gate cannot fire
  // first and mask the one under test. Whichever gate is hit depends on the
  // hour the suite happens to run at otherwise, which is not a property of the
  // cap.
  db.prepare("UPDATE users SET send_from = '00:00', send_to = '23:59', send_days = 'everyday', send_timezone = 'UTC' WHERE id = 1").run()
  const owner = db.prepare('SELECT * FROM users WHERE id = 1').get()
  const today = new Date().toISOString().slice(0, 10)
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, warmup_enabled, warmup_daily_count, sent_today, sent_today_date, created_at, next_send_at)
     VALUES (1, 'gmail', 'ramp@company.test', 'connected', 50, 1, 1, 1, ?, ?, 0)`
  ).run(today, '2020-01-01 00:00:00')
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('ramp@company.test')
  db.prepare(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Ramped', 'running', ?, ?)"
  ).run(mailbox.id, 'flowchart TD\n  S([Start]) --> A[Send: intro]\n')
  const campaign = db.prepare('SELECT * FROM campaigns WHERE name = ?').get('Ramped')
  db.prepare('INSERT INTO leads (user_id, email) VALUES (1, ?)').run('ramped@acme.test')
  const lead = db.prepare('SELECT * FROM leads WHERE email = ?').get('ramped@acme.test')

  const { rules, holds } = sendingContext({ owner, campaign, mailbox })
  const slot = resolveSend({ owner, campaign, mailbox, lead, draft: null, rules, holds })

  assert.equal(slot.ok, false, 'the send is refused')
  assert.equal(slot.gate, 'mailbox_daily_cap')
  assert.match(slot.reason, /warming up/i, 'and the reason names the ramp rather than a bare number')

  // And with warm-up off, the same mailbox is free to send — so the refusal is
  // the cap, not something incidental about the fixture.
  const relaxed = { ...mailbox, warmup_enabled: 0 }
  const open = resolveSend({
    owner, campaign, mailbox: relaxed, lead, draft: null,
    ...sendingContext({ owner, campaign, mailbox: relaxed }),
  })
  assert.equal(open.ok, true, 'not blocked once the ramp is lifted')
})

// ---------------------------------------------------------------------------
// 3. Changing a lead's address is confirmed, not silent
// ---------------------------------------------------------------------------

test('changing a lead email without confirmation is refused, and nothing changes', async () => {
  // A new refusal on a path that used to succeed, added with no test. Worth
  // pinning both halves: that it refuses, and that it does not refuse a request
  // which merely repeats the address it already has.
  db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (1, ?, ?)').run('before@acme.test', 'Before')
  const id = db.prepare('SELECT id FROM leads WHERE email = ?').get('before@acme.test').id
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)").run(campaign1, id)

  const res = await post(`/api/campaigns/${campaign1}/leads/${id}`, { email: 'after@acme.test' })
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.match(JSON.stringify(body), /confirm/i, 'the refusal says what is needed')
  assert.equal(
    db.prepare('SELECT email FROM leads WHERE id = ?').get(id).email, 'before@acme.test',
    'the address is untouched',
  )
})

test('confirming the change applies it', async () => {
  const id = db.prepare('SELECT id FROM leads WHERE email = ?').get('before@acme.test').id
  const res = await post(`/api/campaigns/${campaign1}/leads/${id}`, {
    email: 'after@acme.test', confirm_email_change: true,
  })
  assert.equal(res.status, 200, await res.text())
  assert.equal(db.prepare('SELECT email FROM leads WHERE id = ?').get(id).email, 'after@acme.test')
})

test('sending the address it already has is not a change, and needs no confirmation', async () => {
  // Otherwise every ordinary save that happens to include the email field —
  // which is most of them — starts failing.
  const id = db.prepare('SELECT id FROM leads WHERE email = ?').get('after@acme.test').id
  const res = await post(`/api/campaigns/${campaign1}/leads/${id}`, {
    email: 'after@acme.test', first_name: 'Renamed',
  })
  assert.equal(res.status, 200, await res.text())
  assert.equal(db.prepare('SELECT first_name FROM leads WHERE id = ?').get(id).first_name, 'Renamed')
})

// ---------------------------------------------------------------------------
// 4. A long history returns its most recent messages
// ---------------------------------------------------------------------------

test('lead history returns the newest messages, oldest-first within the page', async () => {
  // The default used to take the oldest N. On a long thread that means the
  // history view shows the opening email and nothing that has happened since,
  // which is the opposite of what anyone opens it for.
  db.prepare('INSERT INTO leads (user_id, email) VALUES (1, ?)').run('chatty@acme.test')
  const id = db.prepare('SELECT id FROM leads WHERE email = ?').get('chatty@acme.test').id
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign1, id)

  for (let i = 1; i <= 12; i++) {
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, to_email, provider_message_id, send_status)
       VALUES (1, ?, ?, 1, 'out', ?, 'Body', 'chatty@acme.test', ?, 'sent')`
    ).run(campaign1, id, `Message ${i}`, `chat-${i}`)
  }

  const res = await get(`/api/campaigns/${campaign1}/leads/${id}/messages?limit=5`)
  assert.equal(res.status, 200)
  const body = await res.json()
  const items = body.items || body.messages || body.data || []
  assert.equal(items.length, 5)

  const subjects = items.map((m) => m.subject)
  assert.deepEqual(subjects, ['Message 8', 'Message 9', 'Message 10', 'Message 11', 'Message 12'],
    'the tail of the conversation, in reading order')
})

// ---------------------------------------------------------------------------
// 5. A filter that cannot work says so
// ---------------------------------------------------------------------------

test('emailStatus is refused on the message folders rather than silently ignored', async () => {
  // It parsed, validated, and then filtered nothing on `state=sent`, because
  // every predicate behind it is written against thread-level aggregates the
  // message query does not compute. A list that looks filtered and is not is
  // the worst of the three possible behaviours.
  const res = await get('/api/inbox/threads?state=sent&emailStatus=Replied')
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.field, 'emailStatus')
  assert.match(body.message, /conversations/i, 'and explains what it does filter')
})

test('emailStatus still works on the conversation folders', async () => {
  const res = await get('/api/inbox/threads?state=all&emailStatus=Replied')
  assert.equal(res.status, 200, 'the filter is unavailable on sent, not broken everywhere')
})

// ---------------------------------------------------------------------------
// 6. A scheduled reply delivers its copies, not just remembers them
// ---------------------------------------------------------------------------

test('cc and bcc survive the wait AND reach the delivered email', async () => {
  // The same defect as the immediate reply path, one layer down, and hidden by
  // a test that asserted the queued row rather than the delivered one. The
  // scheduling route stores the copies "so they survive the wait"; the dispatch
  // job then called sendEmail without them, so a reply scheduled for tomorrow
  // with two colleagues copied went out to the lead alone.
  const { jobs } = await import('../server/upkeep.js')
  const today = new Date().toISOString().slice(0, 10)

  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, sent_today, sent_today_date, next_send_at)
     VALUES (1, 'sandbox', 'sched@sandbox.local', 'connected', 100, 0, ?, 0)`
  ).run(today)
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get('sched@sandbox.local')
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Scheduled', 'running', ?, ?)")
    .run(mailbox.id, 'flowchart TD\n  S([Start]) --> A[Send: intro]\n')
  const campaign = db.prepare("SELECT id FROM campaigns WHERE name = 'Scheduled'").get().id
  db.prepare('INSERT INTO leads (user_id, email) VALUES (1, ?)').run('sched-lead@acme.test')
  const lead = db.prepare('SELECT id FROM leads WHERE email = ?').get('sched-lead@acme.test').id
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state) VALUES (?, ?, 'A', 'waiting')")
    .run(campaign, lead)

  // A reply whose slot has already come round.
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body,
       from_email, to_email, cc_emails, bcc_emails, node_id, is_read, manual_reply, scheduled_at, send_status)
     VALUES (1, ?, ?, ?, 'out', 'Re: later', 'As promised.', ?, 'sched-lead@acme.test',
       'colleague@ours.test, boss@ours.test', 'crm@ours.test', 'manual', 1, 1, ?, 'queued')`
  ).run(campaign, lead, mailbox.id, mailbox.email, new Date(Date.now() - 60_000).toISOString())

  await jobs.dispatchScheduled()

  const delivered = db.prepare(
    `SELECT * FROM messages WHERE lead_id = ? AND direction = 'out'
       AND COALESCE(provider_message_id, '') != '' ORDER BY id DESC LIMIT 1`
  ).get(lead)
  assert.ok(delivered, 'the scheduled reply was actually sent')
  assert.equal(delivered.cc_emails, 'colleague@ours.test, boss@ours.test', 'the copies were delivered, not just stored')
  assert.equal(delivered.bcc_emails, 'crm@ours.test')
})
