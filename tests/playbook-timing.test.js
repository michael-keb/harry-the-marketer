import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCondition, parsePlaybook, collectTimingIssues,
} from '../server/playbook.js'

test('no reply 3d at 09:30 → ms + exactTime', () => {
  const c = parseCondition('no reply 3d at 09:30')
  assert.equal(c.kind, 'no_reply')
  assert.equal(c.ms, 3 * 86400e3)
  assert.equal(c.exactTime, '09:30')
})

test('after 2h at 14:00 → ms + exactTime', () => {
  const c = parseCondition('after 2h at 14:00')
  assert.equal(c.kind, 'after')
  assert.equal(c.ms, 2 * 3600e3)
  assert.equal(c.exactTime, '14:00')
})

test('no reply 3d window 09:00-11:00 → randomWindow on condition', () => {
  const c = parseCondition('no reply 3d window 09:00-11:00')
  assert.equal(c.kind, 'no_reply')
  assert.equal(c.ms, 3 * 86400e3)
  assert.deepEqual(c.randomWindow, { from: '09:00', to: '11:00' })
  assert.equal(c.exactTime, undefined)
})

test('Send email: intro; window 09:00-11:00 strips window from instruction', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send email: intro; window 09:00-11:00]
    A --> W([Won])
  `)
  assert.deepEqual(g.errors, [])
  assert.equal(g.nodes.A.type, 'send')
  assert.equal(g.nodes.A.channel, 'email')
  assert.equal(g.nodes.A.instruction, 'intro')
  assert.deepEqual(g.nodes.A.randomWindow, { from: '09:00', to: '11:00' })
})

test('Wait: 2d at 09:30 → ms + exactTime', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: hi]
    A --> W[Wait: 2d at 09:30]
    W --> B[Send: next]
    B --> T([Won])
  `)
  assert.deepEqual(g.errors, [])
  assert.equal(g.nodes.W.type, 'wait')
  assert.equal(g.nodes.W.ms, 2 * 86400e3)
  assert.equal(g.nodes.W.exactTime, '09:30')
})

test('collectTimingIssues flags inverted windows', () => {
  const g = parsePlaybook(`flowchart TD
    S([Start]) --> A[Send: hi; window 15:00-09:00]
    A -- no reply 1d window 16:00-10:00 --> L([Lost])
  `)
  const issues = collectTimingIssues(g)
  assert.ok(issues.some((i) => /Node "A"/.test(i.message)))
  assert.ok(issues.some((i) => /Edge A→L/.test(i.message)))
})

test('plain no-reply / after still parse without timing fields', () => {
  assert.deepEqual(parseCondition('no reply 3d'), {
    kind: 'no_reply', ms: 3 * 86400e3, raw: 'no reply 3d',
  })
  assert.deepEqual(parseCondition('after 2h'), {
    kind: 'after', ms: 2 * 3600e3, raw: 'after 2h',
  })
})
