// AI spend cap — Docs/AI-SPEND.md / PRODUCT.md #1 blocking item.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-ai-spend-'))
process.env.NODE_ENV = 'test'
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const {
  spendStatus, canAfford, chargeAi, monthlyAllowanceCents, AI_COST_CENTS,
} = await import('../server/ai-spend.js')
const { researchLead } = await import('../server/ai.js')

const user = db.prepare(
  "INSERT INTO users (sub, email, name, plan_id, billing_status) VALUES ('dev:spend', 'spend@test.local', 'Spend', 'trial', 'trial')"
).run()
const wsId = Number(user.lastInsertRowid)

test('trial allowance is $5 and research costs 40¢', () => {
  assert.equal(monthlyAllowanceCents(wsId), 500)
  assert.equal(AI_COST_CENTS.research, 40)
  const status = spendStatus(wsId)
  assert.equal(status.usedCents, 0)
  assert.equal(status.allowanceCents, 500)
  assert.equal(status.exhausted, false)
})

test('chargeAi accumulates until the ceiling, then refuses', () => {
  // Drain most of the allowance with cheap compose charges.
  let charged = 0
  while (canAfford(wsId, 'compose')) {
    assert.equal(chargeAi(wsId, 'compose'), true)
    charged += AI_COST_CENTS.compose
    if (charged > 600) break // safety
  }
  const status = spendStatus(wsId)
  assert.ok(status.usedCents > 0)
  assert.equal(status.exhausted || !canAfford(wsId, 'research'), true)
  // A research charge that would exceed the allowance is refused (no increment).
  const before = spendStatus(wsId).usedCents
  assert.equal(chargeAi(wsId, 'research'), false)
  assert.equal(spendStatus(wsId).usedCents, before)
})

test('researchLead returns null when the allowance is exhausted (no provider call)', async () => {
  // Force exhausted by setting used = allowance.
  const month = spendStatus(wsId).month
  db.prepare('UPDATE ai_spend SET cents_used = ? WHERE workspace_id = ? AND month = ?')
    .run(monthlyAllowanceCents(wsId), wsId, month)
  process.env.AI_MODE = 'on'
  // Even with a fake key present, the budget gate fires first.
  const prev = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'sk-test-not-real'
  const profile = await researchLead({
    lead: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', company: 'Analytical' },
    businessContext: 'test',
    workspaceId: wsId,
  })
  process.env.OPENAI_API_KEY = prev
  process.env.AI_MODE = 'off'
  assert.equal(profile, null)
})

test('refundAi restores budget after a provider failure', async () => {
  const { refundAi, chargeAi: charge, spendStatus: statusOf } = await import('../server/ai-spend.js')
  // Fresh workspace so the earlier drain does not interfere.
  const info = db.prepare(
    "INSERT INTO users (sub, email, name, plan_id, billing_status) VALUES ('dev:refund', 'refund@test.local', 'Refund', 'starter', 'active')"
  ).run()
  const id = Number(info.lastInsertRowid)
  assert.equal(charge(id, 'research'), true)
  const afterCharge = statusOf(id).usedCents
  assert.equal(afterCharge, 40)
  refundAi(id, 'research', { detail: 'provider 503' })
  assert.equal(statusOf(id).usedCents, 0)
})
