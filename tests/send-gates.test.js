// The send controls: the levers, how they narrow, and the order they fire in.
//
// The order is the part worth guarding. Every gate is easy to get right on its
// own; what breaks silently is a change that lets "outside your sending hours"
// answer for a mailbox that has actually been stopped for bouncing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-gates-'))
process.env.AI_MODE = 'off'
process.env.NODE_ENV = 'test'

const { db } = await import('../server/db.js')
const {
  intersectWindows, clampWindows, isOpen, nextOpen, describeWindows, blackoutOn,
} = await import('../server/schedule.js')
const {
  narrow, validate, workspaceRules, effectiveRules, saveRules, WORKSPACE_DEFAULTS, QUIET_FLOOR,
} = await import('../server/send-rules.js')
const { resolveSend, brakeReason, recipientZone } = await import('../server/gates.js')
const { placeHold, releaseHold } = await import('../server/holds.js')
const { recordTouch, companyKey } = await import('../server/touches.js')

// ---- fixtures ---------------------------------------------------------------

db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, paced, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:o@x.com', 'o@x.com', 'O', 0, 1, '09:00', '17:00', 'weekdays', 'Australia/Sydney')`
).run()
db.prepare(
  `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, created_at)
   VALUES (1, 'gmail', 'me@work.com', 'connected', 50, '2020-01-01 00:00:00')`
).run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Plan', 'running', 1, '')").run()
db.prepare("INSERT INTO leads (user_id, email, first_name, company) VALUES (1, 'ana@acme.com', 'Ana', 'Acme')").run()

const owner = () => db.prepare('SELECT * FROM users WHERE id = 1').get()
const mailbox = (over = {}) => ({ ...db.prepare('SELECT * FROM mailboxes WHERE id = 1').get(), ...over })
const campaign = (over = {}) => ({ ...db.prepare('SELECT * FROM campaigns WHERE id = 1').get(), ...over })
const lead = (over = {}) => ({ ...db.prepare('SELECT * FROM leads WHERE id = 1').get(), ...over })

// Sydney is UTC+11 in January.
const thu10am = Date.parse('2026-01-14T23:30:00Z')  // Thu 10:30 Sydney
const thu2am = Date.parse('2026-01-14T15:00:00Z')   // Thu 02:00 Sydney
const saturday = Date.parse('2026-01-17T02:00:00Z') // Sat 13:00 Sydney

// A clean slate between cases. Without it a failed assertion leaves its touches
// behind and every later test fails for a reason that has nothing to do with it.
test.beforeEach(() => {
  db.prepare('DELETE FROM touches').run()
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM send_holds').run()
  db.prepare('DELETE FROM send_rules').run()
  db.prepare("UPDATE campaigns SET schedule = '{}' WHERE id = 1").run()
})

// Resolve with everything defaulted, so each test states only what it changes.
function decide(over = {}) {
  const c = over.campaign === null ? null : (over.campaign || campaign())
  const m = over.mailbox === null ? null : (over.mailbox || mailbox())
  return resolveSend({
    owner: owner(), campaign: c, mailbox: m,
    lead: over.lead === null ? null : (over.lead || lead()),
    draft: over.draft || null,
    channel: over.channel || 'email',
    rules: over.rules || effectiveRules({ owner: owner(), campaign: c, mailbox: m }),
    at: over.at || thu10am,
  })
}

// ---- window maths -----------------------------------------------------------

test('intersecting windows keeps only the time both sides allow', () => {
  const workspace = [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }]
  const plan = [{ days: [1, 2, 3], from: '08:00', to: '12:00' }]
  const both = intersectWindows(workspace, plan)
  assert.deepEqual(both, [{ days: [1, 2, 3], from: '09:00', to: '12:00' }])
})

test('a plan cannot buy itself hours the workspace does not have', () => {
  const workspace = [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }]
  const greedy = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '06:00', to: '23:00' }]
  const both = intersectWindows(workspace, greedy)
  assert.deepEqual(both, [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }], 'it gets the workspace hours, not its own')
})

test('windows that do not overlap resolve to nothing at all, not to everything', () => {
  const morning = [{ days: [1], from: '09:00', to: '11:00' }]
  const evening = [{ days: [1], from: '18:00', to: '20:00' }]
  assert.deepEqual(intersectWindows(morning, evening), [])
})

test('split windows survive the merge and read back the way they went in', () => {
  const split = [
    { days: [1, 2, 3, 4, 5], from: '08:00', to: '10:30' },
    { days: [1, 2, 3, 4, 5], from: '14:00', to: '16:00' },
  ]
  const kept = intersectWindows(split, [{ days: [1, 2, 3, 4, 5], from: '00:00', to: '23:59' }])
  assert.equal(kept.length, 2)
  assert.match(describeWindows(kept), /Weekdays 08:00–10:30, Weekdays 14:00–16:00/)
})

test('quiet hours clamp a window drawn outside them', () => {
  const allNight = [{ days: [1], from: '00:00', to: '23:00' }]
  assert.deepEqual(clampWindows(allNight, { from: '07:00', to: '20:00' }), [{ days: [1], from: '07:00', to: '20:00' }])
})

test('a window that ends before it starts is a typo, not a window across midnight', () => {
  assert.deepEqual(intersectWindows([{ days: [1], from: '22:00', to: '06:00' }], [{ days: [1], from: '00:00', to: '23:59' }]), [])
})

test('blackout dates are compared as the local calendar dates a person wrote', () => {
  const leave = [{ from: '2026-09-12', to: '2026-09-19', label: 'Annual leave' }]
  assert.ok(blackoutOn(leave, '2026-09-15'))
  assert.ok(blackoutOn(leave, '2026-09-12'), 'the first day is shut')
  assert.ok(blackoutOn(leave, '2026-09-19'), 'and so is the last')
  assert.equal(blackoutOn(leave, '2026-09-20'), null)
})

test('nextOpen steps over a weekend and lands inside the window', () => {
  const schedule = { tz: 'Australia/Sydney', blackouts: [], windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }] }
  const opens = nextOpen(schedule, saturday)
  assert.ok(isOpen(schedule, opens))
  assert.ok(opens - saturday > 24 * 3600_000, 'Saturday afternoon goes to Monday, not Sunday')
})

test('nextOpen returns null rather than a wrong time when nothing ever opens', () => {
  assert.equal(nextOpen({ tz: 'UTC', blackouts: [], windows: [] }, thu10am), null)
})

// ---- narrowing --------------------------------------------------------------

test('narrowing tightens every lever and loosens none', () => {
  const base = { ...WORKSPACE_DEFAULTS, caps: { daily: 100, campaignDaily: 0, hourly: 0 } }
  const wider = narrow(base, {
    caps: { daily: 500, campaignDaily: 40, hourly: 0 },
    frequency: { personDays: 2, companyPerWeek: 99, oneChannelPerDay: false },
    followUpReserve: 10,
  })
  assert.equal(wider.caps.daily, 100, 'a cap can come down, never up')
  assert.equal(wider.caps.campaignDaily, 40, 'a cap that did not exist above can be set below')
  assert.equal(wider.frequency.personDays, 14, 'the longer cooling-off wins')
  assert.equal(wider.frequency.companyPerWeek, 3, 'the smaller company cap wins')
  assert.equal(wider.frequency.oneChannelPerDay, true, 'a protection cannot be switched off from below')
  assert.equal(wider.followUpReserve, 30, 'the larger reserve wins')
})

test('quiet hours can be narrowed, never widened', () => {
  assert.deepEqual(validate({ quietHours: { from: '09:00', to: '18:00' } }).quietHours, { from: '09:00', to: '18:00' })
  assert.throws(() => validate({ quietHours: { from: '03:00', to: '23:00' } }), /never wider/)
  assert.equal(QUIET_FLOOR.from, '06:00')
})

test('the workspace window still comes from the settings a workspace already had', () => {
  const rules = workspaceRules(owner())
  assert.deepEqual(rules.windows, [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }])
  assert.equal(rules.timezone, 'Australia/Sydney')
})

test('a saved workspace rule narrows the legacy columns', () => {
  saveRules(1, 'workspace', 0, { windows: [{ days: [1, 2, 3], from: '10:00', to: '12:00' }] }, 'o@x.com')
  const rules = workspaceRules(owner())
  assert.deepEqual(rules.windows, [{ days: [1, 2, 3], from: '10:00', to: '12:00' }])
})

test('validation names the field it is rejecting', () => {
  assert.throws(() => validate({ windows: [{ days: [1], from: '17:00', to: '09:00' }] }), (err) => err.field === 'windows')
  assert.throws(() => validate({ timezone: 'Mars/Olympus' }), (err) => err.field === 'timezone')
  assert.throws(() => validate({ blackouts: [{ from: 'christmas' }] }), (err) => err.field === 'blackouts')
})

// ---- the campaign window, which used to be decoration ------------------------

test('the campaign sending window is enforced, not just stored', () => {
  // The bug this whole stack starts from: `campaigns.schedule` was saved by the
  // Settings page, returned by the API, and read by nothing.
  db.prepare('UPDATE campaigns SET schedule = ? WHERE id = 1').run(
    JSON.stringify({ days: [1, 2, 3, 4, 5], start_hour: '09:00', end_hour: '10:00', timezone: 'Australia/Sydney' })
  )
  const inside = decide({ at: Date.parse('2026-01-14T22:30:00Z') })   // Thu 09:30 Sydney
  assert.equal(inside.ok, true)

  const outside = decide({ at: thu10am })                              // Thu 10:30 Sydney
  assert.equal(outside.ok, false)
  assert.equal(outside.gate, 'outside_window')
  assert.match(outside.reason, /09:00–10:00/, 'and it says which hours are actually in force')
})

test('a campaign window that misses the workspace window stops sending and says so', () => {
  db.prepare('UPDATE campaigns SET schedule = ? WHERE id = 1').run(
    JSON.stringify({ days: [1, 2, 3, 4, 5], start_hour: '19:00', end_hour: '21:00' })
  )
  const out = decide()
  assert.equal(out.gate, 'no_window')
  assert.equal(out.needs, 'human', 'nothing but a person changing a setting can clear this')
})

// ---- precedence -------------------------------------------------------------

test('a hold answers before anything else, including the clock', () => {
  placeHold(1, { scope: 'workspace', reason: 'reviewing the list', by: 'o@x.com' })
  const held = decide({ at: thu2am })  // also outside hours, also a weekday night
  assert.equal(held.gate, 'hold')
  assert.match(held.reason, /reviewing the list/)
  releaseHold(1, { scope: 'workspace' })
  assert.equal(decide().ok, true)
})

test('a workspace hold outranks a mailbox hold, because it is the wider truth', () => {
  placeHold(1, { scope: 'mailbox', id: 1, reason: 'mailbox paused' })
  placeHold(1, { scope: 'workspace', reason: 'everything paused' })
  assert.match(decide().reason, /everything paused/)
  releaseHold(1, { scope: 'workspace' })
  assert.match(decide().reason, /mailbox paused/)
  releaseHold(1, { scope: 'mailbox', id: 1 })
})

test('an automatic hold never overwrites the reason a person gave', () => {
  placeHold(1, { scope: 'mailbox', id: 1, reason: 'I am rewriting the copy', source: 'manual' })
  placeHold(1, { scope: 'mailbox', id: 1, reason: 'bounces', source: 'bounce_brake' })
  assert.match(decide().reason, /rewriting the copy/)
  releaseHold(1, { scope: 'mailbox', id: 1 })
})

test('a hold with a release time reports it, one without asks for a person', () => {
  placeHold(1, { scope: 'workspace', reason: 'back tomorrow', releaseAt: thu10am + 86_400_000 })
  const timed = decide()
  assert.equal(timed.until, thu10am + 86_400_000)
  assert.equal(timed.needs, null)
  releaseHold(1, { scope: 'workspace' })
})

test('a broken mailbox asks to be reconnected rather than blaming the clock', () => {
  const out = decide({ mailbox: mailbox({ status: 'error' }), at: thu2am })
  assert.equal(out.gate, 'mailbox_health')
  assert.equal(out.needs, 'reconnect')
})

test('a plan that is not running says so', () => {
  assert.equal(decide({ campaign: campaign({ status: 'paused' }) }).gate, 'campaign_stopped')
})

// ---- consent ----------------------------------------------------------------

const draftRow = (over = {}) => ({
  id: 1, status: 'approved', reviewed_at: '2026-01-14 00:00:00', send_after: 0,
  campaign_id: 1, lead_id: 1, ...over,
})

test('an approval that has gone stale goes back to a person', () => {
  const out = decide({ draft: draftRow({ reviewed_at: '2025-12-01 09:00:00' }) })
  assert.equal(out.gate, 'stale_approval')
  assert.equal(out.needs, 'human')
})

test('a reply after the approval stops the email that would ignore it', () => {
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, direction, body, created_at)
     VALUES (1, 1, 1, 'in', 'sounds good', '2026-01-14 12:00:00')`
  ).run()
  const out = decide({ draft: draftRow({ reviewed_at: '2026-01-14 09:00:00' }) })
  assert.equal(out.gate, 'replied_since_approval')
})

test('an email held for a chosen time waits for it', () => {
  const out = decide({ draft: draftRow({ send_after: thu10am + 3600_000 }) })
  assert.equal(out.gate, 'snoozed')
  assert.equal(out.until, thu10am + 3600_000)
})

// ---- protecting the recipient -----------------------------------------------

test('a person contacted last week is left alone until the gap has passed', () => {
  recordTouch({ wsId: 1, leadId: 1, email: 'ana@acme.com', channel: 'email', campaignId: 99, at: thu10am - 3 * 86_400_000 })
  const out = decide()
  assert.equal(out.gate, 'person_frequency')
  assert.match(out.reason, /3 days ago/)
  assert.ok(out.until > thu10am, 'and it says when they are approachable again')
})

test('the cap applies to a new approach, never to a follow-up already in flight', () => {
  recordTouch({ wsId: 1, leadId: 1, email: 'ana@acme.com', campaignId: 1, at: thu10am - 86_400_000 })
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, direction, body, created_at)
     VALUES (1, 1, 1, 'out', 'first email', '2026-01-13 23:30:00')`
  ).run()
  assert.equal(decide().ok, true, 'step two of a sequence is not a fresh approach')
})

test('a fourth colleague at the same company waits until next week', () => {
  for (const [id, email] of [[2, 'bo@acme.com'], [3, 'cy@acme.com'], [4, 'di@acme.com']]) {
    db.prepare('INSERT INTO leads (id, user_id, email) VALUES (?, 1, ?)').run(id, email)
    recordTouch({ wsId: 1, leadId: id, email, campaignId: 1, at: thu10am - 86_400_000 })
  }
  const out = decide()
  assert.equal(out.gate, 'company_frequency')
  assert.match(out.reason, /acme\.com/)
})

test('a free mail provider is not a company', () => {
  assert.equal(companyKey('someone@gmail.com'), '')
  assert.equal(companyKey('ana@acme.com'), 'acme.com')
})

test('a second channel on the same day is deferred to tomorrow', () => {
  // Inside a conversation, where the cooling-off between fresh approaches does
  // not apply — this is the case channel spacing exists for.
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, direction, body) VALUES (1, 1, 1, 'out', 'first')`
  ).run()
  recordTouch({ wsId: 1, leadId: 1, email: 'ana@acme.com', channel: 'linkedin', campaignId: 1, at: thu10am - 3600_000 })
  const out = decide()
  assert.equal(out.gate, 'channel_spacing')
  assert.match(out.reason, /linkedin/)
})

// ---- the recipient's own clock ----------------------------------------------

test('a domain we can place gives us their timezone; one we cannot stays unknown', () => {
  assert.equal(recipientZone({ email: 'sam@thing.co.uk' }), 'Europe/London')
  assert.equal(recipientZone({ email: 'sam@thing.com.au' }), null, 'a country that spans four zones tells us nothing')
  assert.equal(recipientZone({ email: 'sam@thing.com', timezone: 'Asia/Tokyo' }), 'Asia/Tokyo', 'what we were told wins')
})

test('quiet hours are the recipient\'s, so a Sydney morning does not land at 11pm in London', () => {
  const sam = lead({ id: 9, email: 'sam@thing.com', timezone: 'Europe/London' })
  const out = decide({ lead: sam })
  assert.equal(out.gate, 'recipient_quiet_hours')
  assert.match(out.reason, /where sam@thing.com are/)
  // A Sydney working day *is* the London night. There is no hour that satisfies
  // both windows as written, so the honest answer names the lever that fixes it
  // rather than inventing a time.
  assert.equal(out.until, null)
  assert.equal(out.needs, 'human')
  assert.match(out.reason, /recipient-local sending/)
})

test('where the zones do overlap, it waits for their morning instead of refusing', () => {
  // Kolkata is four and a half hours behind Sydney: 10:30 there is 06:00 here,
  // still inside their quiet hours, and 07:00 there is 11:30 here.
  const out = decide({ lead: lead({ id: 10, email: 'raj@thing.com', timezone: 'Asia/Kolkata' }) })
  assert.equal(out.gate, 'recipient_quiet_hours')
  assert.ok(out.until > thu10am, 'it waits')
  assert.ok(out.until - thu10am < 3 * 3600_000, 'and not for long — their day starts in about an hour')
  assert.equal(out.needs, null)
})

test('turning off the human pace does not unlock the middle of the night', () => {
  // "Send at a human pace" means "do not space my emails across my working
  // hours". It has never meant "you may write to people at 3am", and a toggle
  // on the settings page must not be able to lift the floor.
  const owner = { ...db.prepare('SELECT * FROM users WHERE id = 1').get(), paced: 0 }
  const rules = effectiveRules({ owner, campaign: campaign(), mailbox: mailbox() })
  assert.equal(rules.paced, false)

  const night = resolveSend({
    owner, campaign: campaign(), mailbox: mailbox(), lead: lead(), rules, at: thu2am,
  })
  assert.equal(night.gate, 'recipient_quiet_hours', 'the floor still holds')
  assert.ok(night.until > thu2am)

  const day = resolveSend({
    owner, campaign: campaign(), mailbox: mailbox(), lead: lead(), rules, at: saturday,
  })
  assert.equal(day.ok, true, 'but a Saturday afternoon is fine — that is what the toggle is for')
})

// ---- the calendar -----------------------------------------------------------

test('outside the hours it says which hours, and when they open', () => {
  // A Saturday afternoon: inside anyone's quiet hours, outside the working
  // week. That isolates the window gate — at 2am the honest answer is the
  // quiet hours, and it takes precedence.
  const out = decide({ at: saturday })
  assert.equal(out.gate, 'outside_window')
  assert.match(out.reason, /Weekdays 09:00–17:00/)
  assert.ok(out.until > saturday)
})

test('at 2am the reason is the hour of the night, not the working week', () => {
  const out = decide({ at: thu2am })
  assert.equal(out.gate, 'recipient_quiet_hours')
  assert.match(out.reason, /outside 07:00–20:00/)
  assert.ok(out.until > thu2am)
})

test('a blackout date shuts the day', () => {
  const rules = effectiveRules({ owner: owner(), campaign: campaign(), mailbox: mailbox() })
  rules.blackouts = [{ from: '2026-01-15', to: '2026-01-15', label: 'Public holiday' }]
  const out = decide({ rules })
  assert.equal(out.gate, 'blackout')
  assert.match(out.reason, /Public holiday/)
})

test('start and end dates bound the plan', () => {
  const rules = effectiveRules({ owner: owner(), campaign: campaign(), mailbox: mailbox() })
  assert.equal(decide({ rules: { ...rules, notBefore: '2026-02-01' } }).gate, 'not_before')
  assert.equal(decide({ rules: { ...rules, notAfter: '2026-01-01' } }).gate, 'not_after')
})

// ---- volume -----------------------------------------------------------------

test('the daily ceiling still applies, and says whether it is the ramp', () => {
  const spent = mailbox({ sent_today: 50, sent_today_date: new Date(thu10am).toISOString().slice(0, 10) })
  assert.equal(decide({ mailbox: spent }).gate, 'mailbox_daily_cap')
  const warming = mailbox({
    created_at: new Date(thu10am).toISOString().slice(0, 19).replace('T', ' '),
    sent_today: 10, sent_today_date: new Date(thu10am).toISOString().slice(0, 10),
  })
  assert.match(decide({ mailbox: warming }).reason, /warming up/)
})

test('the follow-up reserve stops new approaches before it stops replies', () => {
  const nearlySpent = mailbox({ sent_today: 36, sent_today_date: new Date(thu10am).toISOString().slice(0, 10) })
  const out = decide({ mailbox: nearlySpent })
  assert.equal(out.gate, 'follow_up_reserve', '14 left of 50, and 15 are reserved')
  assert.match(out.reason, /kept for follow-ups/)

  // The same mailbox will still send step two of a conversation already going.
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, direction, body) VALUES (1, 1, 1, 'out', 'first')`
  ).run()
  assert.equal(decide({ mailbox: nearlySpent }).ok, true)
})

test('a workspace cap counts every plan, a plan cap counts only its own', () => {
  const rules = effectiveRules({ owner: owner(), campaign: campaign(), mailbox: mailbox() })
  // Recorded against somebody else, so the cooling-off on this lead does not
  // answer first — this test is about the ceiling, not the frequency cap.
  for (let i = 0; i < 5; i++) {
    recordTouch({ wsId: 1, leadId: 2, email: 'bo@acme.com', campaignId: 2, at: thu10am - 3600_000 })
  }
  assert.equal(decide({ rules: { ...rules, caps: { ...rules.caps, daily: 5 } } }).gate, 'workspace_daily_cap')
  assert.equal(
    decide({ rules: { ...rules, caps: { ...rules.caps, campaignDaily: 5 } } }).ok, true,
    'those five belong to another plan'
  )
})

test('spacing is the last word, not the first', () => {
  const spacing = mailbox({ next_send_at: thu10am + 300_000 })
  const out = decide({ mailbox: spacing })
  assert.equal(out.gate, 'spacing')
  assert.equal(out.until, thu10am + 300_000)
})

test('a sandbox mailbox skips the clock and the caps it exists to test around', () => {
  const sandbox = mailbox({ provider: 'sandbox', next_send_at: thu10am + 300_000 })
  assert.equal(decide({ mailbox: sandbox, at: thu2am }).ok, true)
  // But never the refusals.
  placeHold(1, { scope: 'workspace', reason: 'stop' })
  assert.equal(decide({ mailbox: sandbox, at: thu2am }).ok, false)
  releaseHold(1, { scope: 'workspace' })
})

// ---- the brake --------------------------------------------------------------

test('two bounces in a day stop the mailbox, whatever the rate says', () => {
  const rules = workspaceRules(owner())
  assert.equal(brakeReason(mailbox(), rules), null)

  for (const [id, email] of [[20, 'x@dead.com'], [21, 'y@dead.com']]) {
    db.prepare("INSERT INTO leads (id, user_id, email, status) VALUES (?, 1, ?, 'bounced')").run(id, email)
    db.prepare(
      `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, body, to_email)
       VALUES (1, 1, ?, 1, 'out', 'hi', ?)`
    ).run(id, email)
  }
  const reason = brakeReason(mailbox(), rules)
  assert.match(reason, /2 addresses bounced/)
  assert.match(reason, /so the domain does not take the damage/)
})

test('a rate needs a sample worth believing before it stops anything', () => {
  const strict = { ...workspaceRules(owner()), brakes: { bounceRatePercent: 3, bounceSample: 50, bounceAbsolute: 0 } }
  db.prepare("INSERT INTO leads (id, user_id, email, status) VALUES (30, 1, 'z@dead.com', 'bounced')").run()
  db.prepare(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, body, to_email)
     VALUES (1, 1, 30, 1, 'out', 'hi', 'z@dead.com')`
  ).run()
  assert.equal(brakeReason(mailbox(), strict), null, 'one bounce out of one send is not a 100% problem')
})

// ---- the engine, not just the resolver --------------------------------------

// The gates above are unit-tested against `resolveSend`. This proves the engine
// actually asks it: a workspace hold stops a sandbox send, which nothing else
// in the stack would stop, because a sandbox skips the clock, the gap and the
// frequency caps by design.
test('the engine honours a hold on a mailbox that ignores everything else', async () => {
  const { tick } = await import('../server/engine.js')
  db.prepare(
    `INSERT INTO mailboxes (id, user_id, provider, email, status, daily_limit, created_at)
     VALUES (50, 1, 'sandbox', 'demo@sandbox.local', 'connected', 50, '2020-01-01 00:00:00')`
  ).run()
  db.prepare(
    `INSERT INTO campaigns (id, user_id, name, status, mailbox_id, mermaid)
     VALUES (50, 1, 'Sandbox plan', 'running', 50, ?)`
  ).run('flowchart TD\n  S([Start]) --> A[Send: hello]\n  A -- no reply 3d --> L([Lost])\n')
  db.prepare("INSERT INTO leads (id, user_id, email) VALUES (50, 1, 'sandbox-lead@example.com')").run()
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (50, 50)').run()

  const sent = () => db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = 50 AND direction = 'out'").get().n

  placeHold(1, { scope: 'workspace', reason: 'everything paused' })
  await tick()
  assert.equal(sent(), 0, 'held')

  releaseHold(1, { scope: 'workspace' })
  await tick()
  assert.equal(sent(), 1, 'and away once it is lifted')

  // And the send is on the ledger, which is what the frequency caps read.
  const touch = db.prepare('SELECT * FROM touches WHERE lead_id = 50').get()
  assert.ok(touch, 'every send is recorded as a touch')
  assert.equal(touch.channel, 'email')
})
