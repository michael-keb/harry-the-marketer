import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolated DB + deterministic heuristics (no API calls).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-mon-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { recordTelemetry, timed, telemetryRecent, telemetryStats, telemetryFailures } = await import('../server/telemetry.js')
const { tick } = await import('../server/engine.js')

// Seed: user, sandbox mailbox, running campaign, one lead.
// require_approval off: this file asserts on send telemetry, not on the gate.
db.prepare("INSERT INTO users (sub, email, name, require_approval) VALUES ('dev:test@x.com', 'test@x.com', 'Test User', 0)").run()
db.prepare("INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (1, 'sandbox', 'sender@sandbox.local', 'Sandbox Sender')").run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Test', 'running', 1, ?)").run(
  `flowchart TD\n  S([Start]) --> A[Send: intro our product]\n  A -- reply --> W([Won])\n  A -- no reply 3d --> L([Lost])\n`
)
db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'alice@example.com', 'Alice')").run()
db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (1, 1)').run()

test('an engine tick records tick and sandbox send telemetry', async () => {
  await tick()
  const ticks = telemetryRecent('tick', 5)
  assert.equal(ticks.length, 1)
  assert.equal(ticks[0].ok, 1)
  assert.match(ticks[0].detail, /1 running campaign/)
  const sends = telemetryRecent('send', 5)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].op, 'sandbox')
  assert.equal(sends[0].ok, 1)
})

test('recordTelemetry stores failures with detail, truncated', () => {
  recordTelemetry('ai_call', { op: 'compose', ok: false, ms: 120, detail: 'x'.repeat(500) })
  const [row] = telemetryFailures(1)
  assert.equal(row.kind, 'ai_call')
  assert.equal(row.op, 'compose')
  assert.equal(row.ok, 0)
  assert.equal(row.detail.length, 300)
})

test('timed records success and passes the result through', async () => {
  const result = await timed('ai_call', 'classify', async () => 'the-answer')
  assert.equal(result, 'the-answer')
  const [row] = telemetryRecent('ai_call', 1)
  assert.equal(row.op, 'classify')
  assert.equal(row.ok, 1)
})

test('timed records the failure and rethrows', async () => {
  await assert.rejects(
    () => timed('send', 'gmail', async () => { throw new Error('quota exceeded') }),
    /quota exceeded/
  )
  const [row] = telemetryFailures(1)
  assert.equal(row.kind, 'send')
  assert.equal(row.op, 'gmail')
  assert.equal(row.detail, 'quota exceeded')
})

test('telemetryStats aggregates totals, errors, and average duration', () => {
  const stats = telemetryStats('ai_call', 24)
  assert.equal(stats.total, 2) // the failed compose + the timed classify
  assert.equal(stats.errors, 1)
  assert.ok(stats.avgMs >= 0)
})
