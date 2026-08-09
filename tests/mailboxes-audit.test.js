// Mailbox capacity, suspension and sender procurement — the behaviour four
// source edits changed and left unproven.
//
// `tests/agent-followup.test.js` already pins the arithmetic of the warm-up
// change: that `pacing.dailyCap` reads `warmup_daily_count`, that a sandbox
// mailbox is exempt, that switching warm-up off restores the limit, and that
// the gate refuses once the count is spent. None of that is repeated here.
//
// What is left is the claim the whole change rests on and nobody has stated:
// **the number the API reports is the number the send path uses.** The old
// defect was not that the cap was wrong — it was that there were two of them.
// `PUT /warmup` computed its own `effectiveDailyCap` and the engine computed a
// different one from the same row, so the product said five and sent fifty. A
// test that checks only that `effectiveDailyCap <= pacingCap` — which is what
// existed — passes just as happily when the setting does nothing at all. So
// every case in section 1 asserts the two numbers are *equal*, against
// `pacing.dailyCap` directly, for combinations where the ramp wins, where the
// warm-up count wins, and where the mailbox's own limit wins.
//
// Sections 3 and 4 are about sending, so they drive `tick()` and read
// `messages`. A route that returns `{ok: true}` is not evidence that anything
// changed about what leaves the building.
//
// Fixture ordering is deliberate and load-bearing: every test that calls
// `tick()` is declared **before** the first connected Gmail mailbox exists.
// `runUpkeep` → `pullUnmatched` polls Google for every connected, unsuspended
// Gmail mailbox in the database, workspace or no workspace, so a Gmail fixture
// created earlier would put a real network call inside a unit test. Sandbox
// mailboxes carry the engine tests; Gmail carries the warm-up tests; the two
// never overlap in time.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedMailbox, mount } from './helpers/parity-harness.js'

setup('mailboxes-audit')            // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { tick } = await import('../server/engine.js')
const { dailyCap, remainingToday, isWarmingUp } = await import('../server/pacing.js')
const { remainingQuota } = await import('../server/mailer.js')
const { register: registerMailboxes } = await import('../server/parity/mailboxes.js')
const { register: registerSenders, __setSupplierForTests } = await import('../server/parity/senders.js')

const owner = seedUser(db, 'owner@example.com')
// Approvals off so the engine sends rather than queueing a draft, and a
// 24-hour every-day window so a clock gate cannot fire ahead of the one under
// test. Sandbox mailboxes skip the clock anyway; this makes the fixture
// independent of the hour the suite runs at.
db.prepare(
  `UPDATE users SET require_approval = 0, send_from = '00:00', send_to = '23:59',
                    send_days = 'everyday', send_timezone = 'UTC' WHERE id = ?`
).run(owner.id)

const client = await mount([registerMailboxes, registerSenders], owner)
test.after(() => client.close())

const DAY = 86_400_000
const today = () => new Date().toISOString().slice(0, 10)
const sqlTime = (daysAgo = 0) =>
  new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 19).replace('T', ' ')

const PLAYBOOK = `flowchart TD
  S([Start]) --> A[Send: intro]
  A -- no reply 3d --> L([Lost])
`

// `tick()` picks up every running campaign in the database, not the one a test
// happens to be thinking about. A fixture declared at module level is therefore
// live during every earlier test's tick — which is how the daily-limit leads
// below first got sent by the suspension tests. Campaigns start as drafts and
// are started explicitly, inside the test that means to drive them.
function draftCampaign(name, mailboxId) {
  const info = db.prepare(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, ?, 'draft', ?, ?)"
  ).run(owner.id, name, mailboxId, PLAYBOOK)
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(info.lastInsertRowid)
}

const start = (campaignId) =>
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId)

function attach(campaignId, address) {
  const lead = seedLead(db, owner.id, address)
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, lead.id)
  return lead
}

// The only column that says what a recipient actually saw.
const sentFrom = (mailboxId) => db.prepare(
  "SELECT COUNT(*) n FROM messages WHERE mailbox_id = ? AND direction = 'out'"
).get(mailboxId).n

const gateReasons = (campaignId) => db.prepare(
  "SELECT detail FROM events WHERE campaign_id = ? AND type = 'send_gated' ORDER BY id"
).all(campaignId).map((r) => r.detail)

const rowOf = (id) => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id)

// ============================================================================
// 3. Suspension stops the engine, not just the screen
// ============================================================================
//
// `gates.js` refuses on `is_suspended`, and the fleet list has always agreed.
// Neither of those is the engine. Nothing until now drove a tick with a
// suspended mailbox and counted the rows in `messages`, which is the only place
// the question is actually settled.

const suspendBox = seedMailbox(db, owner.id, 'suspend.sender@sandbox.local')
const suspendCampaign = draftCampaign('Suspension audit', suspendBox.id)
attach(suspendCampaign.id, 'suspend-lead@acme.test')

test('a suspended mailbox sends nothing when the engine ticks', async () => {
  const res = await client.put(`/api/mailboxes/${suspendBox.id}/suspend`, { reason: 'Deliverability check' })
  assert.equal(res.status, 200)
  assert.equal(res.body.changed, true)
  assert.equal(rowOf(suspendBox.id).is_suspended, 1)

  start(suspendCampaign.id)

  await tick()

  assert.equal(sentFrom(suspendBox.id), 0, 'the engine sent from a mailbox the user had switched off')
  assert.equal(rowOf(suspendBox.id).sent_today, 0, 'and nothing was counted against its day')

  // The campaign says why it went quiet, in the mailbox's own words, rather
  // than holding silently.
  const reasons = gateReasons(suspendCampaign.id)
  assert.ok(reasons.length, 'the tick recorded no reason for sending nothing')
  assert.match(reasons.join(' | '), /suspended/i)
  assert.match(reasons.join(' | '), /Deliverability check/)
})

test('resuming the mailbox lets the same lead send, from that mailbox', async () => {
  // The other half: without this, "sent nothing" could be true because the
  // fixture never could have sent at all.
  const res = await client.del(`/api/mailboxes/${suspendBox.id}/suspend`)
  assert.equal(res.status, 200)
  assert.equal(rowOf(suspendBox.id).is_suspended, 0)

  await tick()

  assert.equal(sentFrom(suspendBox.id), 1, 'the resumed mailbox sent')
  const sent = db.prepare(
    "SELECT mailbox_id, from_email, to_email FROM messages WHERE mailbox_id = ? AND direction = 'out'"
  ).get(suspendBox.id)
  assert.equal(sent.from_email, 'suspend.sender@sandbox.local')
  assert.equal(sent.to_email, 'suspend-lead@acme.test')
  assert.equal(rowOf(suspendBox.id).sent_today, 1, 'and the send is on its daily count')
})

// ============================================================================
// 4. Lowering the daily limit below today's count stops sending, and un-sends
//    nothing
// ============================================================================
//
// Docs/email-accounts/update.md AC 4 and TC-7. The arithmetic has a floor at
// zero in two separate places (`pacing.remainingToday` and the serialiser), and
// a negative remaining allowance would read as "unlimited" to anything that
// tests `> 0`.

const capBox = seedMailbox(db, owner.id, 'cap.sender@sandbox.local')
const capCampaign = draftCampaign('Daily limit audit', capBox.id)
attach(capCampaign.id, 'cap-lead-1@acme.test')
attach(capCampaign.id, 'cap-lead-2@acme.test')

test('lowering the daily limit under today’s count leaves nothing to send and nothing negative', async () => {
  // Twenty-five already gone today, out of fifty.
  db.prepare('UPDATE mailboxes SET sent_today = 25, sent_today_date = ?, daily_limit = 50 WHERE id = ?')
    .run(today(), capBox.id)

  // A send from earlier today, so "nothing is un-sent" is a claim about a row
  // that exists rather than about an empty table.
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id)
     VALUES (?, ?, ?, 'out', 'Earlier today', 'Body', 'cap.sender@sandbox.local', 'history@acme.test', 'audit-history-1')`
  ).run(owner.id, capCampaign.id, capBox.id)
  const before = sentFrom(capBox.id)
  assert.equal(before, 1)

  const res = await client.patch(`/api/mailboxes/${capBox.id}`, { max_email_per_day: 20 })
  assert.equal(res.status, 200)

  const row = rowOf(capBox.id)
  assert.equal(row.daily_limit, 20)
  assert.equal(row.message_per_day, 20, 'the sibling column other modules read stayed in step')
  assert.equal(row.sent_today, 25, 'lowering the limit did not rewrite today’s count')

  // The engine's arithmetic: clamped at zero, never below it.
  assert.equal(dailyCap(row), 20)
  assert.equal(remainingToday(row), 0)
  assert.ok(remainingToday(row) >= 0, 'a negative allowance reads as unlimited to anything testing > 0')
  assert.equal(remainingQuota(row), 0, 'and the last guard inside sendEmail agrees')

  // And what the user is shown says the same thing.
  const detail = await client.get(`/api/mailboxes/${capBox.id}`)
  assert.equal(detail.body.data.sending.remainingToday, 0)
  assert.ok(detail.body.data.sending.remainingToday >= 0)
  assert.equal(detail.body.data.sending.cap, dailyCap(row), 'the screen and the send path quote one number')
  assert.equal(detail.body.data.sending.ok, false)
  assert.match(detail.body.data.sending.reason, /daily limit/i)

  // Started only now, so the two leads have had no earlier tick to slip out on
  // and the ceiling is the only thing that can be holding them.
  start(capCampaign.id)
  await tick()

  assert.equal(sentFrom(capBox.id), before, 'the engine sent past a limit the user had just lowered')
  assert.equal(rowOf(capBox.id).sent_today, 25, 'nothing new was counted')
  assert.ok(
    db.prepare("SELECT 1 FROM messages WHERE provider_message_id = 'audit-history-1'").get(),
    'lowering the limit un-sent something already sent',
  )
})

test('raising it again releases exactly the leads that were waiting', async () => {
  const before = sentFrom(capBox.id)
  const res = await client.patch(`/api/mailboxes/${capBox.id}`, { max_email_per_day: 50 })
  assert.equal(res.status, 200)
  assert.equal(dailyCap(rowOf(capBox.id)), 50)

  await tick()

  // Two leads were held; both go now. Asserted exactly, because "more than
  // before" would also pass if the cap had never bound in the first place.
  assert.equal(sentFrom(capBox.id) - before, 2, 'the held leads sent once the ceiling moved')
  assert.equal(rowOf(capBox.id).sent_today, 27)
})

// ============================================================================
// 1. The cap the API reports IS the cap the engine enforces
// ============================================================================
//
// Everything below this line uses Gmail mailboxes, and nothing below this line
// calls `tick()` — see the note at the top of the file.

function seedGmail(address, { daysAgo = 60, limit = 50 } = {}) {
  const info = db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, display_name, daily_limit, created_at, status)
     VALUES (?, 'gmail', ?, ?, ?, ?, 'connected')`
  ).run(owner.id, address, address.split('@')[0], limit, sqlTime(daysAgo))
  return db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(info.lastInsertRowid)
}

// Harry's built-in ramp, restated here so the expectations below are arithmetic
// a reader can check rather than numbers copied out of a passing run.
const rampFloor = (daysAgo) => Math.min(50, 10 + daysAgo * 5)

test('the warm-up cap the route reports is the one pacing hands the engine', async () => {
  // Six combinations, chosen so each of the three ceilings wins at least once:
  // the user's warm-up count, Harry's connection-age ramp, and the mailbox's
  // own daily limit.
  const cases = [
    { label: 'aged mailbox, count well under the limit', daysAgo: 60, limit: 50, count: 12, expect: 12 },
    { label: 'aged mailbox, count equal to the limit', daysAgo: 60, limit: 50, count: 50, expect: 50 },
    { label: 'mid-ramp, count under the ramp floor', daysAgo: 6, limit: 50, count: 12, expect: 12 },
    { label: 'mid-ramp, count above the ramp floor — the ramp wins', daysAgo: 6, limit: 50, count: 45, expect: rampFloor(6) },
    { label: 'brand new, count far above day one — the ramp wins', daysAgo: 0, limit: 50, count: 30, expect: rampFloor(0) },
    { label: 'aged mailbox, small limit — the limit wins', daysAgo: 60, limit: 8, count: 8, expect: 8 },
  ]

  for (const c of cases) {
    const mailbox = seedGmail(`cap-${c.daysAgo}-${c.count}-${c.limit}@example.com`, c)
    const res = await client.put(`/api/mailboxes/${mailbox.id}/warmup`, {
      warmup_enabled: true, total_warmup_per_day: c.count,
    })
    assert.equal(res.status, 200, `${c.label}: ${JSON.stringify(res.body)}`)

    const fresh = rowOf(mailbox.id)

    // The defect, stated directly: these were two independently computed
    // numbers, and the product showed one while sending the other.
    assert.equal(
      res.body.data.effectiveDailyCap, dailyCap(fresh),
      `${c.label}: the route reported ${res.body.data.effectiveDailyCap}, the send path uses ${dailyCap(fresh)}`,
    )
    assert.equal(res.body.data.pacingCap, dailyCap(fresh), `${c.label}: pacingCap disagrees with pacing`)
    assert.equal(dailyCap(fresh), c.expect, `${c.label}: wrong ceiling won`)

    // The two consumers downstream of `dailyCap` — the gate stack's allowance
    // and the last check inside `sendEmail` — quote the same figure.
    assert.equal(remainingToday(fresh), c.expect, `${c.label}: gate allowance`)
    assert.equal(remainingQuota(fresh), c.expect, `${c.label}: mailer allowance`)

    // And so does the fleet list, which is what the Mailboxes page renders.
    const fleet = await client.get('/api/mailboxes/fleet?limit=100')
    const listed = fleet.body.data.find((r) => r.id === mailbox.id)
    assert.equal(listed.sending.cap, dailyCap(fresh), `${c.label}: the list quotes a third number`)
    assert.equal(listed.remainingToday, c.expect, `${c.label}: the list's remaining allowance`)
  }
})

test('a mid-day change to the warm-up count moves today’s remaining allowance and recounts nothing', async () => {
  // warmup-settings.md AC 7 and TC-10: the change takes effect at the next
  // tick, and what has already gone out today is respected rather than reset.
  const mailbox = seedGmail('midday@example.com', { daysAgo: 60, limit: 50 })
  db.prepare('UPDATE mailboxes SET sent_today = 8, sent_today_date = ? WHERE id = ?').run(today(), mailbox.id)

  const tight = await client.put(`/api/mailboxes/${mailbox.id}/warmup`, {
    warmup_enabled: true, total_warmup_per_day: 10,
  })
  assert.equal(tight.status, 200)
  assert.equal(tight.body.data.sentToday, 8, 'the day’s count was reported, not reset')
  assert.equal(rowOf(mailbox.id).sent_today, 8, 'and not rewritten in the row either')
  assert.equal(dailyCap(rowOf(mailbox.id)), 10)
  assert.equal(remainingToday(rowOf(mailbox.id)), 2, 'two left of the ten chosen')

  const raised = await client.put(`/api/mailboxes/${mailbox.id}/warmup`, { total_warmup_per_day: 30 })
  assert.equal(raised.status, 200)
  assert.equal(raised.body.data.effectiveDailyCap, dailyCap(rowOf(mailbox.id)))
  assert.equal(remainingToday(rowOf(mailbox.id)), 22, 'the allowance grew by the difference')
  assert.equal(rowOf(mailbox.id).sent_today, 8, 'and the eight already sent were not recounted')
})

// ============================================================================
// 2. `isWarmingUp` for a fully-aged mailbox held down by hand
// ============================================================================
//
// This is a genuine change of meaning, not a side effect. `isWarmingUp` is
// `dailyCap < daily_limit`, so a mailbox connected two months ago that its
// owner has deliberately pinned to twelve a day now reports as warming up. That
// is right — it *is* on a reduced allowance, and `gates.js` phrases its refusal
// off exactly this predicate — but it changes the word the Mailboxes page shows
// against a mailbox nobody would previously have called new, so it is pinned
// rather than left to be discovered.

test('an aged mailbox pinned below its limit reads as warming up, and as ACTIVE', async () => {
  const mailbox = seedGmail('aged@example.com', { daysAgo: 60, limit: 50 })

  // Before: two months old, at its full allowance, warm-up never touched.
  assert.equal(dailyCap(rowOf(mailbox.id)), 50)
  assert.equal(isWarmingUp(rowOf(mailbox.id)), false, 'a fully-ramped mailbox is not warming up')
  const off = await client.get(`/api/mailboxes/${mailbox.id}`)
  assert.equal(off.body.data.warmupDetails.status, 'INACTIVE')
  assert.equal(off.body.data.sending.warmingUp, false)

  // After: the owner pins it to twelve a day.
  const res = await client.put(`/api/mailboxes/${mailbox.id}/warmup`, {
    warmup_enabled: true, total_warmup_per_day: 12,
  })
  assert.equal(res.status, 200)

  assert.equal(isWarmingUp(rowOf(mailbox.id)), true, 'a reduced allowance is a warm-up as far as the gates are concerned')
  const on = await client.get(`/api/mailboxes/${mailbox.id}`)
  assert.equal(on.body.data.warmupDetails.status, 'ACTIVE')
  assert.equal(on.body.data.sending.warmingUp, true)
  assert.equal(on.body.data.warmupDetails.dailyCountToday, 12)
})

test('warm-up set to the mailbox’s own limit is not a warm-up', async () => {
  // The boundary the predicate turns on. Twelve of fifty is a held-back
  // mailbox; fifty of fifty is an ordinary one, and calling it "warming up"
  // would put a misleading badge on a row nothing is holding back.
  const mailbox = seedGmail('atlimit@example.com', { daysAgo: 60, limit: 50 })
  const res = await client.put(`/api/mailboxes/${mailbox.id}/warmup`, {
    warmup_enabled: true, total_warmup_per_day: 50,
  })
  assert.equal(res.status, 200)

  assert.equal(dailyCap(rowOf(mailbox.id)), 50)
  assert.equal(isWarmingUp(rowOf(mailbox.id)), false)
  const detail = await client.get(`/api/mailboxes/${mailbox.id}`)
  assert.equal(detail.body.data.sending.warmingUp, false)
  // The panel still says ACTIVE, because the user did switch warm-up on — the
  // two answer different questions and are allowed to differ here.
  assert.equal(detail.body.data.warmupDetails.status, 'ACTIVE')
})

test('suspending a warming mailbox reports the ramp as PAUSED, not as off', async () => {
  const mailbox = seedGmail('paused@example.com', { daysAgo: 60, limit: 50 })
  await client.put(`/api/mailboxes/${mailbox.id}/warmup`, { warmup_enabled: true, total_warmup_per_day: 12 })
  await client.put(`/api/mailboxes/${mailbox.id}/suspend`, { reason: 'Investigating' })

  const detail = await client.get(`/api/mailboxes/${mailbox.id}`)
  assert.equal(detail.body.data.warmupDetails.status, 'PAUSED')
  assert.equal(detail.body.data.warmupDetails.isWarmupBlocked, true)
  assert.match(detail.body.data.warmupDetails.blockedReason, /Investigating/)
  // Suspension is not a reason to forget the setting.
  assert.equal(rowOf(mailbox.id).warmup_daily_count, 12)
  assert.equal(dailyCap(rowOf(mailbox.id)), 12)
})

// ============================================================================
// 5. An order says when what it bought stops being yours
// ============================================================================
//
// `sender_orders` has no expiry column, so the date is read back from the
// `sender_domains` rows the order created. The risk in a derived field is that
// it derives nothing and returns a constant, so each case below differs only in
// the domain rows behind it.

let orderSeq = 0
function seedOrder(status, domains) {
  orderSeq += 1
  const ref = `HTM-ORD-AUDIT${orderSeq}`
  db.prepare(
    `INSERT INTO sender_orders
       (workspace_id, vendor_id, order_ref, idempotency_key, status, forwarding_domain, domains, mailboxes, total, currency, created_by)
     VALUES (?, '2', ?, ?, ?, 'example.com', ?, '[]', 12.5, 'USD', 'owner@example.com')`
  ).run(owner.id, ref, `audit-key-${orderSeq}`, status,
    JSON.stringify(domains.map((d) => d.domain)))
  for (const d of domains) {
    db.prepare(
      `INSERT INTO sender_domains (workspace_id, vendor_id, domain, status, order_ref, forwarding_domain, expires_at)
       VALUES (?, '2', ?, 'purchased', ?, 'example.com', ?)`
    ).run(owner.id, d.domain, ref, d.expires_at ?? '')
  }
  return ref
}

test('an order carries the earliest expiry of the domains it bought, and says when that has passed', async () => {
  const ref = seedOrder('placed', [
    { domain: 'lapsed-audit.com', expires_at: '2020-01-01T00:00:00Z' },
    { domain: 'later-audit.com', expires_at: '2030-01-01T00:00:00Z' },
  ])
  const res = await client.get(`/api/senders/orders/${ref}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.expires_at, '2020-01-01T00:00:00Z', 'an order is only good for as long as its first domain')
  assert.equal(res.body.data.expired, true)
})

test('an order whose domains are all in the future is not expired', async () => {
  const ref = seedOrder('placed', [{ domain: 'fresh-audit.com', expires_at: '2035-06-01T00:00:00Z' }])
  const res = await client.get(`/api/senders/orders/${ref}`)
  assert.equal(res.body.data.expires_at, '2035-06-01T00:00:00Z')
  assert.equal(res.body.data.expired, false)
})

test('an expiry the supplier has never given is null, which is not the same as “does not expire”', async () => {
  const blank = seedOrder('placed', [{ domain: 'unknown-expiry-audit.com', expires_at: '' }])
  const blankRes = await client.get(`/api/senders/orders/${blank}`)
  assert.equal(blankRes.body.data.expires_at, null, 'an empty string was passed off as a date')
  assert.equal(blankRes.body.data.expired, false, 'unknown must never read as expired')

  // And an order with no domain rows at all behaves the same way rather than
  // throwing or inventing the order's own date.
  const none = seedOrder('pending', [])
  const noneRes = await client.get(`/api/senders/orders/${none}`)
  assert.equal(noneRes.status, 200)
  assert.equal(noneRes.body.data.expires_at, null)
  assert.equal(noneRes.body.data.expired, false)
})

// ============================================================================
// 6. "As of" is when the supplier last answered
// ============================================================================
//
// It used to be `created_at` of the most recently inserted domain row, which
// answers a different question: a workspace that bought a domain in 2019 and
// lost its supplier this morning was told its ownership data was "as of 2019".
// A staleness notice that lies about its own age is worse than none.

test('with no supplier ever reached, there is no "as of" — not a domain’s purchase date', async () => {
  db.prepare(
    `INSERT INTO sender_domains (workspace_id, vendor_id, domain, status, created_at)
     VALUES (?, '2', 'never-synced-audit.com', 'purchased', '2019-03-04 05:06:07')`
  ).run(owner.id)

  const res = await client.get('/api/senders/domains')
  assert.equal(res.status, 200)
  assert.ok(res.body.data.length, 'the stored rows are still served')
  assert.equal(res.body.as_of, null)
  assert.notEqual(res.body.as_of, '2019-03-04 05:06:07', 'a domain’s creation date was passed off as a sync time')
  assert.match(res.body.as_of_meaning, /never had a successful answer/i)
})

test('a successful read records the time it happened, and a later failure keeps it', async () => {
  const beforeSync = Date.now()
  __setSupplierForTests(async () => ({
    ok: true, reason: '', payload: { data: [{ domain: 'synced-audit.com', status: 'purchased' }] },
  }))

  const live = await client.get('/api/senders/domains')
  assert.equal(live.status, 200)
  assert.equal(live.body.stale, false)
  const syncedAt = live.body.as_of
  assert.ok(syncedAt, 'a successful read recorded nothing')
  const parsed = Date.parse(syncedAt)
  assert.ok(parsed >= beforeSync - 1000 && parsed <= Date.now() + 1000, `as_of ${syncedAt} is not the time of the read`)
  assert.match(live.body.as_of_meaning, /last successfully read/i)
  assert.ok(live.body.data.some((d) => d.domain === 'synced-audit.com'), 'the supplier’s row was stored')

  // A domain row created *after* the sync, with an id higher than everything
  // else — which is exactly the row the old code would have quoted.
  db.prepare(
    `INSERT INTO sender_domains (workspace_id, vendor_id, domain, status, created_at)
     VALUES (?, '2', 'newest-row-audit.com', 'purchased', '2019-03-04 05:06:07')`
  ).run(owner.id)

  __setSupplierForTests(async () => ({ ok: false, reason: 'timeout', payload: null }))
  const stale = await client.get('/api/senders/domains')
  assert.equal(stale.status, 200)
  assert.equal(stale.body.stale, true, 'a supplier timeout is reported as stale data')
  assert.equal(stale.body.as_of, syncedAt, 'the failed read moved the "as of" it had no business moving')
  assert.notEqual(stale.body.as_of, '2019-03-04 05:06:07', 'the newest row’s date resurfaced as the sync time')
})
