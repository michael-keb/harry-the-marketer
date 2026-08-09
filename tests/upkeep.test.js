// The five features that had a full API and screens but nothing driving them.
// These tests are the difference between "the endpoint works" and "the feature
// works", which is exactly the gap this file exists to close.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, seedMailbox, mount } from './helpers/parity-harness.js'

setup('upkeep')

const { db, logEvent, onEvent } = await import('../server/db.js')
const { jobs } = await import('../server/upkeep.js')
const { campaignTotals } = await import('../server/metrics.js')
const { fireWebhooks, normalizeEventType, setWebhookTransport } = await import('../server/parity/webhooks.js')
const { register: deliverability } = await import('../server/parity/deliverability.js')

const owner = seedUser(db, 'owner@upkeep.test')
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()

// The deliverability routes are mounted here rather than in the parity suite
// because the thing under test is the seam between them and the tick: a test
// created through the real route, then sent by the real job.
const api = await mount(deliverability, owner)
test.after(() => api.close())

// ---- webhooks are actually delivered ----------------------------------------

test('a domain event reaches a registered webhook without any explicit dispatch call', async () => {
  const delivered = []
  setWebhookTransport(async (url, init) => {
    delivered.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '' }
  })

  db.prepare(
    `INSERT INTO webhooks (workspace_id, name, url, secret, event_types, is_active)
     VALUES (?, 'Replies', 'https://example.test/hook', 'shh', '["reply"]', 1)`
  ).run(owner.id)

  // This is the wiring server/index.js installs: nothing in the engine calls
  // fireWebhooks, so if this subscription is what makes it fire, the feature
  // works for every event type — including ones added later.
  onEvent(({ workspaceId, campaignId, leadId, type, detail }) => {
    if (!normalizeEventType(type)) return
    return fireWebhooks(workspaceId, type, { campaign_id: campaignId, lead_id: leadId, detail })
  })

  const lead = seedLead(db, owner.id, 'webhook-target@acme.test')
  logEvent(owner.id, { leadId: lead.id, type: 'reply', detail: 'They replied' })

  // fireWebhooks is deliberately fire-and-forget, so let the microtasks drain.
  await new Promise((r) => setTimeout(r, 60))

  assert.equal(delivered.length, 1, 'exactly one delivery')
  assert.equal(delivered[0].url, 'https://example.test/hook')
  assert.equal(delivered[0].body.event_type, 'reply')
  assert.equal(delivered[0].body.lead_id, lead.id)

  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE workspace_id = ? ORDER BY id DESC LIMIT 1').get(owner.id)
  assert.ok(row, 'the attempt is recorded')
  assert.equal(row.ok, 1)
})

test('an event nobody subscribed to delivers nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM webhook_deliveries').get().n
  logEvent(owner.id, { type: 'researched', detail: 'built a profile' })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_deliveries').get().n, before)
})

// ---- reminders ---------------------------------------------------------------

test('a due reminder fires once and is not fired again', async () => {
  const lead = seedLead(db, owner.id, 'reminder@acme.test')
  db.prepare(
    `INSERT INTO lead_reminders (workspace_id, lead_id, thread_id, reminder_at, note, status)
     VALUES (?, ?, 't1', ?, 'Chase the quote', 'pending')`
  ).run(owner.id, lead.id, iso(-60_000))
  // Not yet due — must be left alone.
  db.prepare(
    `INSERT INTO lead_reminders (workspace_id, lead_id, thread_id, reminder_at, note, status)
     VALUES (?, ?, 't2', ?, 'Later', 'pending')`
  ).run(owner.id, lead.id, iso(60 * 60_000))

  const first = await jobs.fireDueReminders()
  assert.match(first.did, /1 reminder/)

  const fired = db.prepare("SELECT COUNT(*) n FROM lead_reminders WHERE status = 'fired'").get().n
  assert.equal(fired, 1)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lead_reminders WHERE status = 'pending'").get().n, 1)

  // Running again must not re-announce it — the claim is the guard.
  const second = await jobs.fireDueReminders()
  assert.ok(!second.did, 'nothing left to fire')
})

// ---- overdue tasks -----------------------------------------------------------

test('an overdue task is announced exactly once, however often the tick runs', async () => {
  const lead = seedLead(db, owner.id, 'task@acme.test')
  db.prepare(
    `INSERT INTO lead_tasks (workspace_id, lead_id, title, due_at, status, created_by)
     VALUES (?, ?, 'Send the case study', ?, 'open', 'owner@upkeep.test')`
  ).run(owner.id, lead.id, iso(-86_400_000))

  await jobs.announceOverdueTasks()
  await jobs.announceOverdueTasks()
  await jobs.announceOverdueTasks()

  const announced = db.prepare(
    "SELECT COUNT(*) n FROM events WHERE user_id = ? AND type = 'task_overdue'"
  ).get(owner.id).n
  assert.equal(announced, 1, 'a task must not nag every twenty seconds')
})

test('a task due in the future is not announced', async () => {
  const lead = seedLead(db, owner.id, 'future-task@acme.test')
  db.prepare(
    `INSERT INTO lead_tasks (workspace_id, lead_id, title, due_at, status, created_by)
     VALUES (?, ?, 'Not yet', ?, 'open', 'owner@upkeep.test')`
  ).run(owner.id, lead.id, iso(86_400_000))
  const before = db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'task_overdue'").get().n
  await jobs.announceOverdueTasks()
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'task_overdue'").get().n, before)
})

// ---- warm-up -----------------------------------------------------------------

test('warm-up backs off on spam and never rises above the mailbox daily limit', async () => {
  const mb = seedMailbox(db, owner.id, 'warm@example.com')
  db.prepare(
    `UPDATE mailboxes SET warmup_enabled = 1, warmup_auto_adjust = 1, warmup_ramp_enabled = 1,
       warmup_daily_count = 20, warmup_ramp_step = 2, daily_limit = 22 WHERE id = ?`
  ).run(mb.id)

  const day = (back) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10)
  // A bad week: 12% landing in spam.
  db.prepare('INSERT INTO warmup_stats (mailbox_id, day, sent, spam) VALUES (?, ?, 50, 6)').run(mb.id, day(1))

  await jobs.adjustWarmup()
  const backedOff = db.prepare('SELECT warmup_daily_count FROM mailboxes WHERE id = ?').get(mb.id).warmup_daily_count
  assert.equal(backedOff, 16, 'two ramp steps down')

  // A clean week: it climbs, but the mailbox's own limit is the ceiling.
  db.prepare('DELETE FROM warmup_stats WHERE mailbox_id = ?').run(mb.id)
  db.prepare('INSERT INTO warmup_stats (mailbox_id, day, sent, spam) VALUES (?, ?, 80, 0)').run(mb.id, day(1))
  db.prepare('UPDATE mailboxes SET warmup_daily_count = 21 WHERE id = ?').run(mb.id)

  await jobs.adjustWarmup()
  const climbed = db.prepare('SELECT warmup_daily_count FROM mailboxes WHERE id = ?').get(mb.id).warmup_daily_count
  assert.equal(climbed, 22, 'clamped to daily_limit, not 23')

  const trail = db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'warmup_adjusted'").get().n
  assert.ok(trail >= 2, 'every adjustment is explained in the activity trail')
})

test('warm-up ignores a mailbox with too little evidence to judge', async () => {
  const mb = seedMailbox(db, owner.id, 'quiet@example.com')
  db.prepare(
    `UPDATE mailboxes SET warmup_enabled = 1, warmup_auto_adjust = 1,
       warmup_daily_count = 20, daily_limit = 50 WHERE id = ?`
  ).run(mb.id)
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  db.prepare('INSERT INTO warmup_stats (mailbox_id, day, sent, spam) VALUES (?, ?, 4, 3)').run(mb.id, day)

  await jobs.adjustWarmup()
  assert.equal(
    db.prepare('SELECT warmup_daily_count FROM mailboxes WHERE id = ?').get(mb.id).warmup_daily_count, 20,
    'four sends is not evidence of anything'
  )
})

// ---- scheduled sends ---------------------------------------------------------

test('a scheduled reply is claimed once, so an overlapping tick cannot send it twice', async () => {
  const mailbox = seedMailbox(db, owner.id, 'sched@example.com')
  const campaign = seedCampaign(db, owner.id, 'Scheduled campaign', mailbox.id)
  const lead = seedLead(db, owner.id, 'scheduled@acme.test')
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, scheduled_at, send_status)
     VALUES (?, ?, ?, ?, 'out', 'Later', 'Body', ?, 'queued')`
  ).run(owner.id, campaign.id, lead.id, mailbox.id, iso(-1000))

  // Two overlapping passes, as a slow tick would produce.
  await Promise.all([jobs.dispatchScheduled(), jobs.dispatchScheduled()])

  // Exactly one row survives, and it is the real dispatched message — not the
  // intent row alongside it, which would show the same email twice in a thread.
  const rows = db.prepare(
    "SELECT * FROM messages WHERE campaign_id = ? AND subject = 'Later'"
  ).all(campaign.id)
  assert.equal(rows.length, 1, `one row per email, got ${rows.length}`)
  assert.notEqual(rows[0].provider_message_id, '', 'the survivor is the dispatched copy')
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND send_status = 'queued'").get(campaign.id).n,
    0, 'nothing left queued'
  )
})

test('a scheduled reply to a suppressed address is cancelled, not sent', async () => {
  const mailbox = seedMailbox(db, owner.id, 'sup@example.com')
  const campaign = seedCampaign(db, owner.id, 'Suppressed campaign', mailbox.id)
  const lead = seedLead(db, owner.id, 'blocked-later@nope.test')
  db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(lead.id)
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, scheduled_at, send_status)
     VALUES (?, ?, ?, ?, 'out', 'Should not go', 'Body', ?, 'queued')`
  ).run(owner.id, campaign.id, lead.id, mailbox.id, iso(-1000))

  await jobs.dispatchScheduled()

  const row = db.prepare("SELECT send_status FROM messages WHERE subject = 'Should not go'").get()
  assert.equal(row.send_status, 'cancelled')
  const trail = db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'send_suppressed'").get().n
  assert.ok(trail >= 1, 'the refusal is on the record')
})

// ---- warm-up statistics ------------------------------------------------------

// `warmup_stats` had two readers and no writer outside test files, so the panel
// reported a running warm-up with a week of zeroes and the ramp below could
// never fire. These prove rows are written from real activity, not that the
// response has the right shape — the old defect passed every shape test there
// was.

// A message at a fixed hour, so the day it buckets into is the same one in
// every timezone the suite might run in.
function seedSend(mailboxId, campaignId, daysAgo, { status = '', direction = 'out' } = {}) {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10) + ' 12:00:00'
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, mailbox_id, direction, subject, body, send_status, created_at)
     VALUES (?, ?, ?, ?, 'Hello', 'Body', ?, ?)`
  ).run(owner.id, campaignId, mailboxId, direction, status, at)
  return at.slice(0, 10)
}

test('warm-up history is written from what the mailbox actually did, and rewriting it changes nothing', async () => {
  const mb = seedMailbox(db, owner.id, 'rollup@example.com')
  const campaign = seedCampaign(db, owner.id, 'Rollup campaign', mb.id)

  // Yesterday: eight that left, one of them bounced, one cancelled before it
  // ever reached a provider, and two replies.
  let day
  for (let i = 0; i < 7; i += 1) day = seedSend(mb.id, campaign.id, 1)
  seedSend(mb.id, campaign.id, 1, { status: 'bounced' })
  seedSend(mb.id, campaign.id, 1, { status: 'cancelled' })
  seedSend(mb.id, campaign.id, 1, { status: 'queued' })
  seedSend(mb.id, campaign.id, 1, { direction: 'in' })
  seedSend(mb.id, campaign.id, 1, { direction: 'in' })

  const wrote = await jobs.rollUpWarmupStats()
  assert.match(wrote.did, /warm-up history written/)

  const row = db.prepare('SELECT * FROM warmup_stats WHERE mailbox_id = ? AND day = ?').get(mb.id, day)
  assert.ok(row, 'a row exists for a day the mailbox was busy')
  assert.equal(row.sent, 8, 'seven clean sends plus the bounce; the cancelled and queued ones never left')
  assert.equal(row.spam, 1, 'the bounce is the only rejection Harry can actually observe')
  assert.equal(row.inbox, 7, 'delivered is what left minus what came back')
  assert.equal(row.received, 2)
  assert.equal(row.reply_rate, 25)

  // UNIQUE (mailbox_id, day) plus an upsert: a second pass recomputes the same
  // answer rather than doubling it, which a tick that overlaps itself will do.
  await jobs.rollUpWarmupStats()
  await jobs.rollUpWarmupStats()
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM warmup_stats WHERE mailbox_id = ?').get(mb.id).n, 1,
    'three passes, one row'
  )
  assert.equal(db.prepare('SELECT sent FROM warmup_stats WHERE mailbox_id = ?').get(mb.id).sent, 8)
})

test('a day the mailbox did nothing gets no row, so "days of history" means days of evidence', async () => {
  const quiet = seedMailbox(db, owner.id, 'silent@example.com')
  await jobs.rollUpWarmupStats()
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM warmup_stats WHERE mailbox_id = ?').get(quiet.id).n, 0,
    'a zero row is a measurement claim about a day nothing happened'
  )
})

test('the auto-ramp is reachable once real history exists, and still cannot outrun the mailbox limit', async () => {
  const mb = seedMailbox(db, owner.id, 'ramp-from-real@example.com')
  const campaign = seedCampaign(db, owner.id, 'Ramp campaign', mb.id)
  db.prepare(
    `UPDATE mailboxes SET warmup_enabled = 1, warmup_auto_adjust = 1, warmup_ramp_enabled = 1,
       warmup_daily_count = 20, warmup_ramp_step = 2, daily_limit = 21 WHERE id = ?`
  ).run(mb.id)

  // Twelve clean sends yesterday: over the ten the ramp insists on before it
  // will draw a conclusion, which nothing in production had ever supplied.
  for (let i = 0; i < 12; i += 1) seedSend(mb.id, campaign.id, 1)

  await jobs.rollUpWarmupStats()
  const history = db.prepare('SELECT SUM(sent) s FROM warmup_stats WHERE mailbox_id = ?').get(mb.id).s
  assert.equal(history, 12, 'the ramp has something to read')

  await jobs.adjustWarmup()
  assert.equal(
    db.prepare('SELECT warmup_daily_count FROM mailboxes WHERE id = ?').get(mb.id).warmup_daily_count, 21,
    'one step up, clamped to the mailbox\'s own daily limit rather than 22'
  )

  // And it backs off on the evidence just as readily: a bad day of bounces.
  for (let i = 0; i < 4; i += 1) seedSend(mb.id, campaign.id, 2, { status: 'bounced' })
  for (let i = 0; i < 8; i += 1) seedSend(mb.id, campaign.id, 2)
  await jobs.rollUpWarmupStats()
  await jobs.adjustWarmup()
  assert.equal(
    db.prepare('SELECT warmup_daily_count FROM mailboxes WHERE id = ?').get(mb.id).warmup_daily_count, 17,
    'two steps down off a 16.7% rejection rate'
  )
})

// ---- placement tests actually send -------------------------------------------

async function makeManualTest(body) {
  const res = await api.post('/api/deliverability/tests/manual', body)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

const seedMessages = (address) =>
  db.prepare("SELECT * FROM messages WHERE to_email = ? AND direction = 'out'").all(address)

test('a manual placement test really sends its seeds, and they move no campaign figure', async () => {
  const mb = seedMailbox(db, owner.id, 'placement@example.com')
  const campaign = seedCampaign(db, owner.id, 'Placement campaign', mb.id)

  const test1 = await makeManualTest({
    name: 'Where does it land',
    mailboxIds: [mb.id],
    campaignId: campaign.id,
    seedEmails: ['gmail-seed@inbox.test', 'outlook-seed@inbox.test'],
  })
  assert.equal(test1.seedsQueued, 2)

  // Before: the response claimed queued work; nothing had happened yet.
  assert.equal(seedMessages('gmail-seed@inbox.test').length, 0)
  assert.equal(db.prepare('SELECT sent_today FROM mailboxes WHERE id = ?').get(mb.id).sent_today, 0)
  const touchesBefore = db.prepare('SELECT COUNT(*) n FROM touches WHERE workspace_id = ?').get(owner.id).n

  const did = await jobs.dispatchSeedSends()
  assert.match(did.did, /2 placement seed\(s\) sent/)

  // The whole defect, in one assertion: rows in `messages`.
  for (const address of ['gmail-seed@inbox.test', 'outlook-seed@inbox.test']) {
    const rows = seedMessages(address)
    assert.equal(rows.length, 1, `one seed reached ${address}`)
    assert.equal(rows[0].from_email, 'placement@example.com')
    assert.notEqual(rows[0].provider_message_id, '', 'a provider actually accepted it')
    assert.equal(rows[0].send_status, 'test', 'stamped with the status REAL_SEND excludes')
    assert.equal(rows[0].lead_id, null, 'a seed inbox is never a lead')
  }

  // It went through the mailer, so it cost the mailbox its allowance.
  assert.equal(db.prepare('SELECT sent_today FROM mailboxes WHERE id = ?').get(mb.id).sent_today, 2)

  // ...and the touch ledger, which caps how often a *person* is contacted, is
  // untouched: running a placement test must not silence a campaign.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM touches WHERE workspace_id = ?').get(owner.id).n, touchesBefore)

  // Campaign figures are unmoved even though the seeds carry the campaign id.
  const totals = campaignTotals(campaign.id)
  assert.equal(totals.sent, 0, 'a placement test is not outreach')
  assert.equal(totals.contacted, 0)

  const senders = db.prepare(
    'SELECT send_status, placement FROM deliverability_test_senders WHERE test_id = ?'
  ).all(test1.id)
  assert.deepEqual(senders.map((s) => s.send_status), ['sent', 'sent'])
  assert.deepEqual(senders.map((s) => s.placement), ['', ''],
    'the copy left; where it landed is unobserved, and an invented "inbox" would be the same lie again')

  // The run is advanced and closed, with Harry's own key names so the history
  // view cannot plot a 0% inbox rate it never measured.
  const run = db.prepare('SELECT * FROM deliverability_test_runs WHERE test_id = ?').get(test1.id)
  assert.equal(run.status, 'completed')
  assert.notEqual(run.finished_at, '')
  const metrics = JSON.parse(run.metrics)
  assert.equal(metrics.seedsSent, 2)
  assert.equal(metrics.placementObserved, 0)
  assert.equal(metrics.placementSource, 'none')
  assert.equal(metrics.inboxCount, undefined, 'no invented provider figures')

  // A manual test is one run, so the run finishing finishes the test.
  assert.equal(db.prepare('SELECT status FROM deliverability_tests WHERE id = ?').get(test1.id).status, 'completed')
})

test('two overlapping ticks cannot send the same seed twice', async () => {
  const mb = seedMailbox(db, owner.id, 'once-only@example.com')
  await makeManualTest({
    name: 'Exactly once', mailboxIds: [mb.id], seedEmails: ['once@inbox.test'],
  })

  await Promise.all([jobs.dispatchSeedSends(), jobs.dispatchSeedSends()])

  assert.equal(seedMessages('once@inbox.test').length, 1, 'the conditional claim is what makes this one')
  assert.equal(db.prepare('SELECT sent_today FROM mailboxes WHERE id = ?').get(mb.id).sent_today, 1)
})

test('a seedless placement test sends nothing and never pretends otherwise', async () => {
  const mb = seedMailbox(db, owner.id, 'nothing-to-send@example.com')
  const created = await makeManualTest({ name: 'No seeds', mailboxIds: [mb.id] })
  assert.equal(created.seedsQueued, 0)
  assert.equal(created.awaitingSeeds, true)

  const before = db.prepare('SELECT COUNT(*) n FROM messages').get().n
  await jobs.dispatchSeedSends()

  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, before, 'nothing was sent')
  assert.equal(db.prepare('SELECT sent_today FROM mailboxes WHERE id = ?').get(mb.id).sent_today, 0)
  assert.equal(
    db.prepare('SELECT send_status FROM deliverability_test_senders WHERE test_id = ?').get(created.id).send_status,
    'awaiting_seeds'
  )
  // And the run is not closed off as though it had produced a result.
  assert.equal(db.prepare('SELECT status FROM deliverability_test_runs WHERE test_id = ?').get(created.id).status,
    'awaiting_seeds')
})

test('a suppressed seed address is refused by the mailer, not sent', async () => {
  const mb = seedMailbox(db, owner.id, 'suppressed-seed@example.com')
  db.prepare("INSERT INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (?, 'blocked-seed.test', 1, 'manual')")
    .run(owner.id)
  const created = await makeManualTest({
    name: 'Blocked seed', mailboxIds: [mb.id], seedEmails: ['someone@blocked-seed.test'],
  })

  await jobs.dispatchSeedSends()

  assert.equal(seedMessages('someone@blocked-seed.test').length, 0, 'suppression applies to seeds too')
  const sender = db.prepare('SELECT * FROM deliverability_test_senders WHERE test_id = ?').get(created.id)
  assert.equal(sender.send_status, 'suppressed')
  assert.equal(sender.placement, 'missing', 'a copy that never left is missing from every inbox')
})

// ---- automated schedules tick ------------------------------------------------

test('an automated schedule opens exactly one run when it comes due, and again a cadence later', async () => {
  const mb = seedMailbox(db, owner.id, 'scheduled-seeds@example.com')
  const res = await api.post('/api/deliverability/tests/schedule', {
    name: 'Weekly placement check',
    mailboxIds: [mb.id],
    seedEmails: ['weekly@inbox.test'],
    scheduleStartTime: iso(-60_000),
    everyDays: 7,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const created = res.body

  // Created inert, exactly as before: no run, no senders, counter at zero.
  assert.equal(db.prepare('SELECT current_run_no FROM deliverability_tests WHERE id = ?').get(created.id).current_run_no, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_test_runs WHERE test_id = ?').get(created.id).n, 0)

  // Two overlapping ticks, as a slow pass would produce.
  await Promise.all([jobs.openDueRuns(), jobs.openDueRuns()])

  assert.equal(db.prepare('SELECT current_run_no FROM deliverability_tests WHERE id = ?').get(created.id).current_run_no, 1,
    'the counter advanced once, not twice')
  const runs = db.prepare('SELECT * FROM deliverability_test_runs WHERE test_id = ?').all(created.id)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].run_no, 1)
  const senders = db.prepare('SELECT * FROM deliverability_test_senders WHERE test_id = ?').all(created.id)
  assert.equal(senders.length, 1)
  assert.equal(senders[0].seed_email, 'weekly@inbox.test')

  // The seeds this run created are sent by the same job the manual tests use.
  await jobs.dispatchSeedSends()
  assert.equal(seedMessages('weekly@inbox.test').length, 1)
  // An automated test stays active for its next cadence; only its run closes.
  assert.equal(db.prepare('SELECT status FROM deliverability_tests WHERE id = ?').get(created.id).status, 'active')

  // Nothing is due again yet.
  await jobs.openDueRuns()
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_test_runs WHERE test_id = ?').get(created.id).n, 1)

  // A cadence later — and only one run, not one per tick, because due-ness is
  // measured from the last run rather than from the schedule's start.
  db.prepare("UPDATE deliverability_test_runs SET started_at = datetime('now', '-30 days') WHERE test_id = ?").run(created.id)
  await jobs.openDueRuns()
  await jobs.openDueRuns()
  assert.equal(db.prepare('SELECT current_run_no FROM deliverability_tests WHERE id = ?').get(created.id).current_run_no, 2,
    'a month of missed runs is caught up once, not replayed in a storm')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_test_runs WHERE test_id = ?').get(created.id).n, 2)
})

test('a schedule past its end date is retired rather than left running for ever', async () => {
  const mb = seedMailbox(db, owner.id, 'expired-schedule@example.com')
  const created = (await api.post('/api/deliverability/tests/schedule', {
    name: 'Ends soon', mailboxIds: [mb.id], seedEmails: ['ended@inbox.test'],
    scheduleStartTime: iso(-120_000), everyDays: 1,
  })).body
  // The route refuses an end date already in the past, so the clock moves here.
  db.prepare('UPDATE deliverability_tests SET test_end_date = ? WHERE id = ?').run(iso(-60_000), created.id)

  await jobs.openDueRuns()

  assert.equal(db.prepare('SELECT status FROM deliverability_tests WHERE id = ?').get(created.id).status, 'completed')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverability_test_runs WHERE test_id = ?').get(created.id).n, 0,
    'an ended schedule does not get one last run')
})

// ---- inbound attach (the gap that emptied the Inbox) -------------------------

test('a reply from a known lead attaches to the campaign thread instead of vanishing', () => {
  // Campaign primary is mailbox A; the outbound (and therefore the Gmail thread)
  // lives on mailbox B — the rotation case that made per-thread sync miss.
  const primary = seedMailbox(db, owner.id, 'primary-inbox@example.com')
  const sender = seedMailbox(db, owner.id, 'rotated-sender@example.com')
  const lead = seedLead(db, owner.id, 'prospect-replies@acme.test')
  const campaign = seedCampaign(db, owner.id, 'Inbox attach', primary.id)
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id)
  db.prepare(
    "INSERT INTO campaign_leads (campaign_id, lead_id, state, node_id, thread_id) VALUES (?, ?, 'waiting', 'n1', ?)"
  ).run(campaign.id, lead.id, 'gmail-thread-rotated')
  db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, provider_message_id, thread_id)
     VALUES (?, ?, ?, ?, 'out', 'Intro', 'Hi', ?, ?, 'out-1', 'gmail-thread-rotated')`
  ).run(owner.id, campaign.id, lead.id, sender.id, sender.email, lead.email)

  const result = jobs.ingestRecentInbound(sender, {
    providerMessageId: 'in-rotated-1',
    threadId: 'gmail-thread-rotated',
    fromEmail: lead.email,
    toEmail: sender.email,
    subject: 'Re: Intro',
    body: 'Yes, let us talk next week.',
    receivedAt: iso(-1_000),
  })

  assert.equal(result, 'attached')
  const inbound = db.prepare(
    "SELECT * FROM messages WHERE provider_message_id = 'in-rotated-1'"
  ).get()
  assert.ok(inbound, 'reply is stored as a campaign message')
  assert.equal(inbound.direction, 'in')
  assert.equal(inbound.campaign_id, campaign.id)
  assert.equal(inbound.lead_id, lead.id)
  assert.equal(inbound.mailbox_id, sender.id)
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM unmatched_messages WHERE provider_message_id = 'in-rotated-1'").get().n,
    0,
    'a matched reply must not also land in untracked'
  )
})

test('a stranger reply still lands in untracked', () => {
  const mb = seedMailbox(db, owner.id, 'untracked-inbox@example.com')
  const result = jobs.ingestRecentInbound(mb, {
    providerMessageId: 'in-stranger-1',
    threadId: 'thread-x',
    fromEmail: 'nobody-known@elsewhere.test',
    toEmail: mb.email,
    subject: 'Cold pitch',
    body: 'Buy my list',
    receivedAt: iso(-1_000),
  })
  assert.equal(result, 'untracked')
  assert.ok(db.prepare(
    "SELECT 1 FROM unmatched_messages WHERE provider_message_id = 'in-stranger-1'"
  ).get())
})

// ---- the whole pass ----------------------------------------------------------

test('a failing job cannot take down the pass or the tick', async () => {
  const { runUpkeep } = await import('../server/upkeep.js')
  // pullUnmatched reaches for Gmail; with no configured mailbox it must simply
  // do nothing rather than throw into the engine.
  const summary = await runUpkeep()
  assert.ok(Array.isArray(summary))
})
