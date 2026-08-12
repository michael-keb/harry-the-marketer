// Coral Marten global defaults + Pike randomized window: preference overlay,
// snapshot freeze, and launch validation.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-send-defaults-'))
process.env.AI_MODE = 'off'
process.env.NODE_ENV = 'test'

const { db } = await import('../server/db.js')
const {
  WORKSPACE_DEFAULTS,
  saveRules,
  workspaceRules,
  effectiveRules,
  snapshotDefaults,
  overlayDefaults,
  validate,
  validateDefaultsForLaunch,
  RuleError,
} = await import('../server/send-rules.js')

db.prepare(
  `INSERT INTO users (sub, email, name, require_approval, paced, send_from, send_to, send_days, send_timezone)
   VALUES ('dev:o@x.com', 'o@x.com', 'O', 0, 1, '09:00', '17:00', 'weekdays', 'Australia/Sydney')`
).run()
db.prepare(
  `INSERT INTO mailboxes (user_id, provider, email, status, daily_limit, created_at)
   VALUES (1, 'gmail', 'me@work.com', 'connected', 50, '2020-01-01 00:00:00')`
).run()
db.prepare("INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (1, 'Plan', 'running', 1, '')").run()

const owner = () => db.prepare('SELECT * FROM users WHERE id = 1').get()
const campaign = (over = {}) => ({ ...db.prepare('SELECT * FROM campaigns WHERE id = 1').get(), ...over })

test.beforeEach(() => {
  db.prepare('DELETE FROM send_rules').run()
  db.prepare('DELETE FROM send_rule_changes').run()
})

test('campaign replyHandling override beats workspace global', () => {
  saveRules(1, 'workspace', 0, validate({
    replyHandling: {
      email: { noReplySwitchTo: 'sms', timeoutMs: 2 * 86400e3 },
      sms: { noReplySwitchTo: 'email', timeoutMs: 4 * 86400e3 },
    },
  }), 'o@x.com')
  // Partial campaign doc (as stored after a narrow edit) — only email overridden.
  saveRules(1, 'campaign', 1, {
    replyHandling: {
      email: { noReplySwitchTo: 'none', timeoutMs: 5 * 86400e3 },
    },
  }, 'o@x.com')

  const rules = effectiveRules({ owner: owner(), campaign: campaign() })
  assert.equal(rules.replyHandling.email.noReplySwitchTo, 'none')
  assert.equal(rules.replyHandling.email.timeoutMs, 5 * 86400e3)
  // Unspecified sms channel still inherits workspace via overlayDefaults.
  assert.equal(rules.replyHandling.sms.noReplySwitchTo, 'email')
  assert.equal(rules.replyHandling.sms.timeoutMs, 4 * 86400e3)
})

test('defaults_snapshot freezes preferences against later workspace edits', () => {
  saveRules(1, 'workspace', 0, validate({
    replyHandling: {
      email: { noReplySwitchTo: 'sms', timeoutMs: 2 * 86400e3 },
      sms: { noReplySwitchTo: 'email', timeoutMs: 2 * 86400e3 },
    },
    randomWindow: { enabled: true, from: '09:00', to: '11:00' },
    defaultDelays: { noReplyMs: 3 * 86400e3, afterMs: 2 * 86400e3 },
  }), 'o@x.com')

  const snap = snapshotDefaults(owner())
  assert.equal(snap.replyHandling.email.timeoutMs, 2 * 86400e3)
  assert.equal(snap.randomWindow.from, '09:00')

  // Live workspace changes after the campaign was snapshotted.
  saveRules(1, 'workspace', 0, validate({
    replyHandling: {
      email: { noReplySwitchTo: 'none', timeoutMs: 9 * 86400e3 },
      sms: { noReplySwitchTo: 'none', timeoutMs: 9 * 86400e3 },
    },
    randomWindow: { enabled: true, from: '14:00', to: '16:00' },
    defaultDelays: { noReplyMs: 1 * 86400e3, afterMs: 1 * 86400e3 },
  }), 'o@x.com')

  const live = workspaceRules(owner())
  assert.equal(live.replyHandling.email.timeoutMs, 9 * 86400e3)
  assert.equal(live.randomWindow.from, '14:00')

  const frozen = effectiveRules({
    owner: owner(),
    campaign: campaign({ defaults_snapshot: snap }),
  })
  assert.equal(frozen.replyHandling.email.timeoutMs, 2 * 86400e3)
  assert.equal(frozen.replyHandling.email.noReplySwitchTo, 'sms')
  assert.equal(frozen.randomWindow.from, '09:00')
  assert.equal(frozen.randomWindow.to, '11:00')
  assert.equal(frozen.defaultDelays.noReplyMs, 3 * 86400e3)
})

test('validateDefaultsForLaunch fails when required timeouts are missing', () => {
  const blockers = validateDefaultsForLaunch(
    { randomWindow: { enabled: false, from: '09:00', to: '11:00' } },
    {},
  )
  assert.ok(blockers.some((b) => b.includes('replyHandling.email.timeoutMs')))
  assert.ok(blockers.some((b) => b.includes('replyHandling.sms.timeoutMs')))

  const ok = validateDefaultsForLaunch(
    {
      replyHandling: {
        email: { noReplySwitchTo: 'sms', timeoutMs: 2 * 86400e3 },
        sms: { noReplySwitchTo: 'email', timeoutMs: 2 * 86400e3 },
      },
    },
    {},
  )
  assert.deepEqual(ok, [])

  // Campaign override can supply a missing required key.
  const filled = validateDefaultsForLaunch(
    { replyHandling: { email: { timeoutMs: 2 * 86400e3 } } },
    { replyHandling: { sms: { timeoutMs: 4 * 86400e3 } } },
  )
  assert.deepEqual(filled, [])
})

test('randomWindow invalid bounds fail validation', () => {
  assert.throws(
    () => validate({ randomWindow: { enabled: true, from: '11:00', to: '09:00' } }),
    (err) => err instanceof RuleError && err.field === 'randomWindow',
  )
  assert.throws(
    () => validate({ randomWindow: { enabled: true, from: '09:00', to: '09:00' } }),
    (err) => err instanceof RuleError && err.field === 'randomWindow',
  )
  assert.throws(
    () => validate({ randomWindow: { enabled: true, from: '25:00', to: '11:00' } }),
    (err) => err instanceof RuleError && err.field === 'randomWindow',
  )

  const clean = validate({ randomWindow: { enabled: true, from: '09:00', to: '11:00' } })
  assert.deepEqual(clean.randomWindow, { enabled: true, from: '09:00', to: '11:00' })

  const launchBlockers = validateDefaultsForLaunch(
    {
      replyHandling: WORKSPACE_DEFAULTS.replyHandling,
      randomWindow: { enabled: true, from: '15:00', to: '10:00' },
    },
    {},
  )
  assert.ok(launchBlockers.some((b) => /randomWindow/.test(b)))
})

test('overlayDefaults deep-merges preference keys with patch winning', () => {
  const base = {
    replyHandling: {
      email: { noReplySwitchTo: 'sms', timeoutMs: 2 * 86400e3 },
      sms: { noReplySwitchTo: 'email', timeoutMs: 2 * 86400e3 },
    },
    randomWindow: { enabled: false, from: '09:00', to: '11:00' },
    windows: [{ days: [1], from: '08:00', to: '17:00' }],
  }
  const merged = overlayDefaults(base, {
    replyHandling: { email: { timeoutMs: 7 * 86400e3 } },
    randomWindow: { enabled: true },
    windows: [{ days: [5], from: '10:00', to: '12:00' }],
  })
  assert.equal(merged.replyHandling.email.timeoutMs, 7 * 86400e3)
  assert.equal(merged.replyHandling.email.noReplySwitchTo, 'sms')
  assert.equal(merged.randomWindow.enabled, true)
  assert.equal(merged.randomWindow.from, '09:00')
  // Non-preference keys are not touched by overlayDefaults.
  assert.deepEqual(merged.windows, base.windows)
})

test('replyHandling noReplySwitchTo enum is validated', () => {
  assert.throws(
    () => validate({
      replyHandling: {
        email: { noReplySwitchTo: 'carrier-pigeon', timeoutMs: 1000 },
        sms: { noReplySwitchTo: 'email', timeoutMs: 1000 },
      },
    }),
    (err) => err instanceof RuleError && err.field === 'replyHandling',
  )
  const clean = validate({
    replyHandling: {
      email: { noReplySwitchTo: 'none', timeoutMs: 1000 },
      sms: { noReplySwitchTo: 'sms', timeoutMs: 1000 },
    },
  })
  assert.equal(clean.replyHandling.email.noReplySwitchTo, 'none')
})

test('saveRules audit trail includes preference keys', () => {
  const rules = validate({
    replyHandling: WORKSPACE_DEFAULTS.replyHandling,
    randomWindow: { enabled: true, from: '09:00', to: '10:30' },
    defaultDelays: WORKSPACE_DEFAULTS.defaultDelays,
  })
  saveRules(1, 'workspace', 0, rules, 'o@x.com')
  const row = db.prepare(
    'SELECT after_rules FROM send_rule_changes WHERE workspace_id = 1 ORDER BY id DESC LIMIT 1'
  ).get()
  const after = JSON.parse(row.after_rules)
  assert.equal(after.randomWindow.from, '09:00')
  assert.equal(after.replyHandling.email.noReplySwitchTo, 'sms')
  assert.equal(after.defaultDelays.noReplyMs, WORKSPACE_DEFAULTS.defaultDelays.noReplyMs)
})
