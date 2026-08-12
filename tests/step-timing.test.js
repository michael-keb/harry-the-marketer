import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-step-timing-'))
process.env.AI_MODE = 'off'
process.env.NODE_ENV = 'test'

const { db } = await import('../server/db.js')
const {
  parseClock, validateRandomWindow, pickRandomInWindow,
  getOrCreateStepSlot, scheduleStepTime,
} = await import('../server/step-timing.js')
const { localAt } = await import('../server/schedule.js')

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:t@x.com', 't@x.com', 'T')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mermaid) VALUES (1, 'Plan', 'draft', '')").run()
db.prepare("INSERT INTO leads (user_id, email) VALUES (1, 'a@acme.com')").run()

test.beforeEach(() => {
  db.prepare('DELETE FROM step_send_slots').run()
})

test('parseClock accepts HH:MM and rejects junk', () => {
  assert.equal(parseClock('09:30'), 9 * 60 + 30)
  assert.equal(parseClock('9:05'), 9 * 60 + 5)
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('nope'), null)
})

test('validateRandomWindow is inclusive and requires to >= from', () => {
  assert.equal(validateRandomWindow({ from: '09:00', to: '11:00' }).ok, true)
  assert.equal(validateRandomWindow({ from: '09:00', to: '09:00' }).ok, true, 'one-minute slot')
  assert.equal(validateRandomWindow({ from: '11:00', to: '09:00' }).ok, false)
  assert.equal(validateRandomWindow({ from: 'xx', to: '11:00' }).ok, false)
})

test('pickRandomInWindow is stable for the same identity', () => {
  const args = {
    campaignId: 1, leadId: 1, nodeId: 'A',
    from: '09:00', to: '11:00',
    timezone: 'UTC', dayKey: '2026-03-10',
  }
  const a = pickRandomInWindow(args)
  const b = pickRandomInWindow(args)
  assert.equal(a, b)
  assert.ok(a >= 9 * 60 && a <= 11 * 60)
})

test('getOrCreateStepSlot reuses the persisted choice on retry', () => {
  const baseMs = Date.parse('2026-03-10T08:00:00Z')
  const first = getOrCreateStepSlot({
    campaignId: 1, leadId: 1, nodeId: 'F1',
    window: { from: '09:00', to: '11:00' },
    timezone: 'UTC',
    baseMs,
  })
  assert.equal(first.reused, false)
  const local = localAt('UTC', first.at)
  assert.ok(local.minutes >= 9 * 60 && local.minutes <= 11 * 60)

  const second = getOrCreateStepSlot({
    campaignId: 1, leadId: 1, nodeId: 'F1',
    window: { from: '09:00', to: '11:00' },
    timezone: 'UTC',
    baseMs: baseMs + 3600e3,
  })
  assert.equal(second.reused, true)
  assert.equal(second.at, first.at)
})

test('exactTime wins over delay for the clock; delay still shifts the day', () => {
  // fromMs = Mon 10:00 UTC; delay 3d → Thu; exact 09:30 → Thu 09:30 UTC.
  const fromMs = Date.parse('2026-03-09T10:00:00Z')
  const result = scheduleStepTime({
    delayMs: 3 * 86400e3,
    exactTime: '09:30',
    timezone: 'UTC',
    fromMs,
  })
  assert.equal(result.at, Date.parse('2026-03-12T09:30:00Z'))
  assert.equal(result.exactTime, '09:30')
  assert.equal(result.reused, false)
})

test('exactTime wins over randomWindow for the clock', () => {
  const fromMs = Date.parse('2026-03-10T08:00:00Z')
  const result = scheduleStepTime({
    delayMs: 0,
    exactTime: '14:00',
    randomWindow: { from: '09:00', to: '11:00' },
    timezone: 'UTC',
    fromMs,
    campaignId: 1, leadId: 1, nodeId: 'X',
  })
  assert.equal(result.at, Date.parse('2026-03-10T14:00:00Z'))
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM step_send_slots WHERE node_id = ?').get('X').n,
    0,
    'exact path must not write a random slot',
  )
})

test('invalid window is rejected', () => {
  assert.throws(
    () => getOrCreateStepSlot({
      campaignId: 1, leadId: 1, nodeId: 'bad',
      window: { from: '15:00', to: '09:00' },
      timezone: 'UTC',
      baseMs: Date.now(),
    }),
    /end must be at or after start/,
  )
})
