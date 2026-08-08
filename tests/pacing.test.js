// Sending rhythm: hours, spacing, and the warm-up ceiling.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-pacing-'))
process.env.AI_MODE = 'off'

const {
  sendWindow, isOpen, nextOpen, dailyCap, isWarmingUp, remainingToday,
  nextGapMs, canSendNow, followUpJitter, hashFraction,
} = await import('../server/pacing.js')

const owner = {
  paced: 1, send_from: '09:00', send_to: '17:00', send_days: 'weekdays', send_timezone: 'Australia/Sydney',
}
const win = sendWindow(owner)

// Fixed instants in Sydney time (UTC+11 in January).
const wedMorning = Date.parse('2026-01-14T23:30:00Z') // Thu 10:30 Sydney
const wedNight = Date.parse('2026-01-14T15:00:00Z')   // Thu 02:00 Sydney
const saturday = Date.parse('2026-01-17T02:00:00Z')   // Sat 13:00 Sydney

const gmail = (over = {}) => ({
  id: 1, provider: 'gmail', daily_limit: 50, sent_today: 0, sent_today_date: '',
  created_at: '2020-01-01 00:00:00', next_send_at: 0, ...over,
})

test('the window is the workspace timezone, not the server one', () => {
  assert.equal(win.tz, 'Australia/Sydney')
  assert.equal(isOpen(win, wedMorning), true)
  assert.equal(isOpen(win, wedNight), false, '2am is not working hours anywhere')
  assert.equal(isOpen(win, saturday), false, 'weekdays means weekdays')
})

test('every day means every day', () => {
  assert.equal(isOpen(sendWindow({ ...owner, send_days: 'everyday' }), saturday), true)
})

test('nextOpen lands inside the window', () => {
  const opens = nextOpen(win, saturday)
  assert.ok(opens > saturday)
  assert.equal(isOpen(win, opens), true)
  // Saturday afternoon → Monday morning, not Sunday.
  assert.ok(opens - saturday > 24 * 3600_000)
})

test('an unknown timezone never wedges a campaign shut', () => {
  assert.equal(isOpen(sendWindow({ ...owner, send_timezone: 'Mars/Olympus' }), wedNight), true)
})

test('a new mailbox works up to its limit instead of starting at full volume', () => {
  const fresh = gmail({ created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') })
  assert.equal(dailyCap(fresh), 10)
  assert.equal(isWarmingUp(fresh), true)
  const weekOld = gmail({ created_at: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 19).replace('T', ' ') })
  assert.equal(dailyCap(weekOld), 45)
  const settled = gmail({ created_at: '2020-01-01 00:00:00' })
  assert.equal(dailyCap(settled), 50)
  assert.equal(isWarmingUp(settled), false)
})

test('the ramp never exceeds the limit the human set', () => {
  const small = gmail({ daily_limit: 5, created_at: '2020-01-01 00:00:00' })
  assert.equal(dailyCap(small), 5)
})

test('sandbox mailboxes ignore the ramp and the clock', () => {
  const sandbox = { ...gmail(), provider: 'sandbox', created_at: new Date().toISOString() }
  assert.equal(dailyCap(sandbox), 50)
  assert.equal(canSendNow(owner, sandbox, wedNight).ok, true, 'testing must not have to wait until Monday')
})

test('gaps are randomised but reproducible, and stay within bounds', () => {
  const a = nextGapMs(win, gmail({ sent_today: 3, sent_today_date: '2026-01-15' }), wedMorning)
  const b = nextGapMs(win, gmail({ sent_today: 3, sent_today_date: '2026-01-15' }), wedMorning)
  const c = nextGapMs(win, gmail({ id: 2, sent_today: 3, sent_today_date: '2026-01-15' }), wedMorning)
  assert.equal(a, b, 'the same situation always gives the same answer')
  assert.notEqual(a, c, 'two mailboxes never fire in lockstep')
  assert.ok(a >= 45_000 && a <= 45 * 60_000)
})

test('a mailbox says why it is holding, and until when', () => {
  assert.equal(canSendNow(owner, gmail(), wedMorning).ok, true)

  const shut = canSendNow(owner, gmail(), wedNight)
  assert.equal(shut.ok, false)
  assert.match(shut.reason, /sending hours/)
  assert.ok(isOpen(win, shut.until))

  const spacing = canSendNow(owner, gmail({ next_send_at: wedMorning + 300_000 }), wedMorning)
  assert.equal(spacing.ok, false)
  assert.match(spacing.reason, /spacing/)
  assert.equal(spacing.until, wedMorning + 300_000)

  const spent = canSendNow(owner, gmail({ sent_today: 50, sent_today_date: new Date(wedMorning).toISOString().slice(0, 10) }), wedMorning)
  assert.equal(spent.ok, false)
  assert.match(spent.reason, /daily limit/)

  const warming = canSendNow(
    owner,
    gmail({ created_at: new Date(wedMorning).toISOString().slice(0, 19).replace('T', ' '), sent_today: 10, sent_today_date: new Date(wedMorning).toISOString().slice(0, 10) }),
    wedMorning
  )
  assert.match(warming.reason, /warming up/)
})

test('turning pacing off still respects the daily limit', () => {
  const off = { ...owner, paced: 0 }
  assert.equal(canSendNow(off, gmail(), wedNight).ok, true, 'the clock no longer applies')
  const spent = gmail({ sent_today: 50, sent_today_date: new Date(wedNight).toISOString().slice(0, 10) })
  assert.equal(canSendNow(off, spent, wedNight).ok, false, 'but the ceiling always does')
})

test('remainingToday resets on a new day', () => {
  const stale = gmail({ sent_today: 50, sent_today_date: '2020-05-05' })
  assert.equal(remainingToday(stale, wedMorning), 50)
})

test('follow-ups are offset per lead, so a hundred are not chased at once', () => {
  const one = followUpJitter(1, 'A')
  const two = followUpJitter(2, 'A')
  assert.equal(one, followUpJitter(1, 'A'), 'stable for a given lead and step')
  assert.notEqual(one, two)
  for (const v of [one, two, followUpJitter(99, 'F')]) assert.ok(v >= 0.85 && v <= 1.15)
})

test('the engine closes the mailbox slot after a send', async () => {
  const { db } = await import('../server/db.js')
  const { tick } = await import('../server/engine.js')
  db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:p@x.com', 'p@x.com', 'P', 0)").run()
  db.prepare("INSERT INTO mailboxes (user_id, provider, email) VALUES (1, 'sandbox', 'p@sandbox.local')").run()
  db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'C', 'running', 1, ?)")
    .run('flowchart TD\n  S([Start]) --> A[Send: hello]\n  A -- no reply 3d --> L([Lost])\n')
  db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'x@example.com', 'X')").run()
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, 1)').run()

  await tick()
  const after = db.prepare('SELECT next_send_at FROM mailboxes WHERE id = 1').get()
  assert.ok(after.next_send_at > Date.now(), 'the slot is closed for a gap')
  assert.ok(after.next_send_at - Date.now() >= 45_000, 'and the gap is a real one')
})

test('hashFraction stays in range for anything thrown at it', () => {
  for (const parts of [['a'], [1, 2, 3], ['', null], ['long'.repeat(500)]]) {
    const v = hashFraction(...parts)
    assert.ok(v >= 0 && v <= 1)
  }
})
