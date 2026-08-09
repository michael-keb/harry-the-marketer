// Per-campaign send controls: scoped rules, schedule sync, holds and grid.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, mount } from './helpers/parity-harness.js'

setup('campaign-send-controls')

const { db } = await import('../server/db.js')
const { registerSendControls } = await import('../server/send-controls.js')
const { register: registerCampaigns } = await import('../server/parity/campaigns.js')
const {
  storedRules, effectiveRules, legacyScheduleToStoredRules, syncCampaignScheduleColumn, saveRules,
} = await import('../server/send-rules.js')

const user = seedUser(db, 'owner@example.com')
db.prepare(
  `UPDATE users SET send_from = '09:00', send_to = '17:00', send_days = 'weekdays',
   send_timezone = 'Australia/Sydney' WHERE id = ?`
).run(user.id)
db.prepare(
  `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, created_at)
   VALUES (?, 'gmail', 'me@work.com', 'connected', 50, '2020-01-01 00:00:00')`
).run(user.id)
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, 'Plan A', 'running', 1, '')").run(user.id)
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, 'Plan B', 'running', 1, '')").run(user.id)

const owner = () => db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
const campaign = (id = 1) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id)

const sendApi = await mount(registerSendControls, owner())
const campApi = await mount(registerCampaigns, owner())
test.after(() => { sendApi.close(); campApi.close() })

test.beforeEach(() => {
  db.prepare('DELETE FROM send_rules').run()
  db.prepare('DELETE FROM send_holds').run()
  db.prepare("UPDATE campaigns SET schedule = '{}' WHERE id IN (1, 2)").run()
})

test('two campaigns can have different sending windows', async () => {
  await sendApi.put('/api/send-rules', {
    scope: 'campaign', id: 1,
    rules: { windows: [{ days: [1, 2, 3], from: '10:00', to: '12:00' }] },
  })
  await sendApi.put('/api/send-rules', {
    scope: 'campaign', id: 2,
    rules: { windows: [{ days: [4, 5], from: '14:00', to: '16:00' }] },
  })

  const a = await sendApi.get('/api/send-rules?scope=campaign&id=1')
  const b = await sendApi.get('/api/send-rules?scope=campaign&id=2')
  assert.deepEqual(a.body.effective.windows, [{ days: [1, 2, 3], from: '10:00', to: '12:00' }])
  assert.deepEqual(b.body.effective.windows, [{ days: [4, 5], from: '14:00', to: '16:00' }])
})

test('campaign send-rules sync the legacy schedule column', async () => {
  await sendApi.put('/api/send-rules', {
    scope: 'campaign', id: 1,
    rules: {
      timezone: 'Europe/London',
      windows: [{ days: [1, 2, 3, 4, 5], from: '10:00', to: '15:00' }],
      minGapMinutes: 12,
    },
  })
  const schedule = JSON.parse(campaign(1).schedule)
  assert.equal(schedule.timezone, 'Europe/London')
  assert.deepEqual(schedule.days, [1, 2, 3, 4, 5])
  assert.equal(schedule.start_hour, '10:00')
  assert.equal(schedule.end_hour, '15:00')
  assert.equal(schedule.min_gap_minutes, 12)
})

test('legacy schedule PUT syncs into send_rules', async () => {
  const { status } = await campApi.put('/api/campaigns/1/schedule', {
    timezone: 'America/New_York',
    days: [2, 3, 4],
    start_hour: '11:00',
    end_hour: '16:00',
    min_gap_minutes: 5,
  })
  assert.equal(status, 200)
  const stored = storedRules(user.id, 'campaign', 1)
  assert.deepEqual(stored.windows, [{ days: [2, 3, 4], from: '11:00', to: '16:00' }])
  assert.equal(stored.timezone, 'America/New_York')
  assert.equal(stored.minGapMinutes, 5)
})

test('a campaign hold pauses one plan without stopping another', async () => {
  await sendApi.post('/api/send-holds', { scope: 'campaign', id: 1, reason: 'checking copy' })
  const held = await sendApi.get('/api/send-status?campaignId=1')
  const clear = await sendApi.get('/api/send-status?campaignId=2')
  assert.equal(held.body.ok, false)
  assert.equal(held.body.gate, 'hold')
  assert.notEqual(clear.body.gate, 'hold', 'the other campaign is not held')
  await sendApi.del('/api/send-holds/campaign/1')
})

test('send-schedule returns windows and markers for a campaign', async () => {
  await sendApi.put('/api/send-rules', {
    scope: 'campaign', id: 1,
    rules: { windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }] },
  })
  const { status, body } = await sendApi.get('/api/send-schedule?campaignId=1&limit=10')
  assert.equal(status, 200)
  assert.equal(body.mailbox.email, 'me@work.com')
  assert.equal(body.hours, 'Weekdays 09:00–17:00')
  assert.ok(Array.isArray(body.markers))
  assert.ok(body.markers.some((m) => m.kind === 'projected'))
})

test('duplicate copies campaign send_rules to the new campaign', async () => {
  await sendApi.put('/api/send-rules', {
    scope: 'campaign', id: 1,
    rules: {
      windows: [{ days: [1], from: '10:00', to: '11:00' }],
      caps: { campaignDaily: 25 },
    },
  })
  const dup = await campApi.post('/api/campaigns/1/duplicate', { name: 'Plan A copy' })
  assert.equal(dup.status, 200)
  const copied = storedRules(user.id, 'campaign', dup.body.id)
  assert.deepEqual(copied.windows, [{ days: [1], from: '10:00', to: '11:00' }])
  assert.equal(copied.caps.campaignDaily, 25)
})

test('sync helpers round-trip schedule and rules', () => {
  const schedule = { timezone: 'UTC', days: [1, 2], start_hour: '08:00', end_hour: '09:30', min_gap_minutes: 3 }
  const rules = legacyScheduleToStoredRules(schedule)
  assert.deepEqual(rules.windows, [{ days: [1, 2], from: '08:00', to: '09:30' }])
  syncCampaignScheduleColumn(1, { ...rules, timezone: 'UTC', minGapMinutes: 3 })
  const row = JSON.parse(campaign(1).schedule)
  assert.equal(row.start_hour, '08:00')
  assert.equal(row.min_gap_minutes, 3)
})

test('effective rules merge workspace ceiling with campaign narrowing', () => {
  saveRules(user.id, 'campaign', 1, {
    windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '11:00' }],
  }, 'test')
  const rules = effectiveRules({ owner: owner(), campaign: campaign(1) })
  assert.deepEqual(rules.windows, [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '11:00' }],
    '08:00 start is not granted — workspace opens at 09:00')
})
