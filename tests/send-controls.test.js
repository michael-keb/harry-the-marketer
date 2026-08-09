// The send controls over HTTP: setting levers, placing holds, and the preview
// that makes all of it checkable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, mount } from './helpers/parity-harness.js'

setup('send-controls')

const { db } = await import('../server/db.js')
const { registerSendControls } = await import('../server/send-controls.js')

const user = seedUser(db, 'owner@example.com')
db.prepare(
  `UPDATE users SET send_from = '09:00', send_to = '17:00', send_days = 'weekdays',
   send_timezone = 'Australia/Sydney' WHERE id = ?`
).run(user.id)
db.prepare(
  `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, created_at)
   VALUES (?, 'gmail', 'me@work.com', 'connected', 50, '2020-01-01 00:00:00')`
).run(user.id)
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, 'Plan', 'running', 1, '')").run(user.id)
db.prepare("INSERT INTO leads (user_id, email) VALUES (?, 'ana@acme.com')").run(user.id)

const api = await mount(registerSendControls, db.prepare('SELECT * FROM users WHERE id = ?').get(user.id))
test.after(() => api.close())

test.beforeEach(() => {
  db.prepare('DELETE FROM send_rules').run()
  db.prepare('DELETE FROM send_holds').run()
  db.prepare("UPDATE campaigns SET schedule = '{}' WHERE id = 1").run()
})

test('the workspace rules come back with what is set, what is in force, and the floor', async () => {
  const { status, body } = await api.get('/api/send-rules?scope=workspace')
  assert.equal(status, 200)
  assert.deepEqual(body.effective.windows, [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }])
  assert.equal(body.describes, 'Weekdays 09:00–17:00')
  assert.deepEqual(body.quietFloor, { from: '06:00', to: '21:00' })
  assert.match(body.note, /never looser/)
})

test('a plan can narrow the workspace hours', async () => {
  const { status, body } = await api.put('/api/send-rules', {
    scope: 'campaign', id: 1,
    rules: { windows: [{ days: [1, 2, 3], from: '08:00', to: '11:00' }] },
  })
  assert.equal(status, 200)
  assert.deepEqual(body.effective.windows, [{ days: [1, 2, 3], from: '09:00', to: '11:00' }],
    'the 08:00 start is not granted — the workspace opens at 09:00')
})

test('a plan that narrows to nothing is saved, and says so plainly', async () => {
  const { body } = await api.put('/api/send-rules', {
    scope: 'campaign', id: 1,
    rules: { windows: [{ days: [6], from: '19:00', to: '20:00' }] },
  })
  assert.deepEqual(body.effective.windows, [])
  assert.match(body.warning, /nothing can send/)
  await api.put('/api/send-rules', { scope: 'campaign', id: 1, rules: { windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }] } })
})

test('quiet hours outside the floor are refused, with the field named', async () => {
  const { status, body } = await api.put('/api/send-rules', {
    scope: 'workspace', rules: { quietHours: { from: '04:00', to: '23:00' } },
  })
  assert.equal(status, 400)
  assert.equal(body.field, 'quietHours')
})

test('every change to a lever is on the record', async () => {
  const { body } = await api.get('/api/send-rules/history')
  assert.ok(body.length >= 2)
  assert.equal(body[0].changed_by, 'owner@example.com')
})

test('holding everything stops sending and names who did it', async () => {
  const placed = await api.post('/api/send-holds', { scope: 'workspace', reason: 'checking the list' })
  assert.equal(placed.status, 200)
  assert.match(placed.body.describes, /checking the list/)

  const status = await api.get('/api/send-status')
  assert.equal(status.body.ok, false)
  assert.equal(status.body.gate, 'hold')

  const lifted = await api.del('/api/send-holds/workspace/0')
  assert.equal(lifted.status, 200)
  // Not "it sends now" — whether it does depends on the hour this test runs.
  // What lifting a hold guarantees is that the hold is no longer the answer.
  assert.notEqual((await api.get('/api/send-status')).body.gate, 'hold')
})

test('a timed hold releases itself', async () => {
  await api.post('/api/send-holds', { scope: 'mailbox', id: 1, reason: 'an hour off', hours: 1 })
  const held = await api.get('/api/send-holds')
  assert.equal(held.body.length, 1)
  assert.ok(held.body[0].release_at > Date.now())
  db.prepare('UPDATE send_holds SET release_at = ? WHERE id = ?').run(Date.now() - 1000, held.body[0].id)
  assert.equal((await api.get('/api/send-holds')).body.length, 0, 'swept on the next read')
})

test('the preview says when the next emails actually leave', async () => {
  const { status, body } = await api.get('/api/send-preview?campaignId=1&limit=5')
  assert.equal(status, 200)
  assert.equal(body.sends.length, 5, 'waiting for the window is not a send, and must not eat the count')
  assert.equal(body.hours, 'Weekdays 09:00–17:00')
  assert.ok(Date.parse(body.sends[0].at) >= Date.now() - 1000, 'the first one is now or later, never in the past')
  // Every projected send is inside the hours, in order, and spaced apart.
  const times = body.sends.map((s) => Date.parse(s.at))
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], 'in order')
    assert.ok(times[i] - times[i - 1] >= 45_000, 'and never two in the same breath')
  }
  assert.match(body.note, /projection/)
})

test('the preview stops at a wall rather than inventing times beyond it', async () => {
  await api.post('/api/send-holds', { scope: 'workspace', reason: 'stop' })
  const { body } = await api.get('/api/send-preview?campaignId=1&limit=5')
  assert.equal(body.sends.length, 0)
  assert.equal(body.blocked.gate, 'hold')
  await api.del('/api/send-holds/workspace/0')
})

test('health shows the number that would stop sending before it does', async () => {
  const { body } = await api.get('/api/send-health')
  assert.equal(body.length, 1)
  assert.equal(body[0].email, 'me@work.com')
  assert.equal(body[0].threshold.bounceAbsolute, 2)
})

test('a lead timezone can be set, and a guessable one is offered', async () => {
  const set = await api.put('/api/leads/1/timezone', { timezone: 'Europe/London' })
  assert.equal(set.body.timezone, 'Europe/London')
  const bad = await api.put('/api/leads/1/timezone', { timezone: 'Mars/Olympus' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.field, 'timezone')
})

test('another workspace cannot read or set this one\'s levers', async () => {
  const other = seedUser(db, 'other@example.com')
  const theirs = await mount(registerSendControls, db.prepare('SELECT * FROM users WHERE id = ?').get(other.id))
  assert.equal((await theirs.get('/api/send-rules?scope=campaign&id=1')).status, 404)
  assert.equal((await theirs.put('/api/send-rules', { scope: 'campaign', id: 1, rules: {} })).status, 404)
  assert.equal((await theirs.post('/api/send-holds', { scope: 'campaign', id: 1, reason: 'x' })).status, 404)
  await theirs.close()
})

test('a broken real mailbox is the answer, not a working sandbox one', async () => {
  // The failure this guards: a workspace whose Gmail account has expired but
  // which also has a sandbox mailbox was told "sending is open" — true of the
  // sandbox, useless to the user, and hiding the one thing they had to fix.
  db.prepare("UPDATE mailboxes SET status = 'error', last_error = 'token refresh failed' WHERE id = 1").run()
  db.prepare(
    `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, created_at)
     VALUES (?, 'sandbox', 'demo@sandbox.local', 'connected', 50, '2020-01-01 00:00:00')`
  ).run(user.id)

  const { body } = await api.get('/api/send-status')
  assert.equal(body.mailbox.email, 'me@work.com', 'it asks the real one')
  assert.equal(body.gate, 'mailbox_health')
  assert.equal(body.needs, 'reconnect')

  db.prepare("UPDATE mailboxes SET status = 'connected', last_error = '' WHERE id = 1").run()
  db.prepare("DELETE FROM mailboxes WHERE email = 'demo@sandbox.local'").run()
})
