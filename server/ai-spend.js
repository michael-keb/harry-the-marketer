// Per-workspace monthly AI spend cap.
//
// PRODUCT.md marks this blocking: without a budget the engine researches every
// lead before its first email and can burn hundreds of dollars on a $39 plan.
// Spend is tracked in cents against a monthly allowance that depends on the
// workspace's billing plan. Research is the expensive op; compose/classify are
// cheap. When the allowance is exhausted, research is skipped, compose falls
// through to the template path, and classify uses the heuristic — the product
// keeps working, it just stops paying the model.
//
// The meter is shown on Monitoring, not in the operator's face on every send.
// A provider outage refunds the charge so retries cannot drain a month's
// allowance producing nothing (model refusal is not refunded).

import { db } from './db.js'

// Approximate provider cost in cents per op. Research uses web search and is
// an order of magnitude more expensive than a short compose.
export const AI_COST_CENTS = {
  research: 40,
  compose: 3,
  classify: 1,
  purpose: 1,
  qualify: 2,
  plan: 5,
  other: 2,
}

// callModel uses human-readable op labels; normalise them onto the cost table.
const OP_ALIASES = {
  'plan goal': 'plan',
  'generate playbook': 'plan',
  'compose sms': 'compose',
  research: 'research',
  compose: 'compose',
  classify: 'classify',
  purpose: 'purpose',
  qualify: 'qualify',
  plan: 'plan',
  other: 'other',
}

export function normaliseAiOp(op) {
  const key = String(op || 'other').toLowerCase().trim()
  return OP_ALIASES[key] || (AI_COST_CENTS[key] ? key : 'other')
}

export function costOf(op) {
  return AI_COST_CENTS[normaliseAiOp(op)] ?? AI_COST_CENTS.other
}

// Monthly allowances (cents) by plan_id. Trial / unpaid get a small ceiling so
// a forgotten AI_MODE=on local workspace cannot run away; paid plans scale up.
// MUST match the Stripe Payment Link plan ids written by billing.js — a mismatch
// silently drops the workspace to the $5 trial ceiling.
export const ALLOWANCE_CENTS = {
  '': 500,       // trial / unset — $5
  trial: 500,
  starter: 1500, // $15
  growth: 4000,  // $40
  scale: 10000,  // $100
}

function monthKey(at = new Date()) {
  const y = at.getUTCFullYear()
  const m = String(at.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function planOf(wsId) {
  const row = db.prepare('SELECT plan_id, billing_status FROM users WHERE id = ?').get(wsId)
  if (!row) return ''
  // A cancelled / past_due workspace falls back to the trial ceiling.
  if (row.billing_status && !['active', 'trialing', 'trial'].includes(row.billing_status)) {
    return 'trial'
  }
  return row.plan_id || 'trial'
}

export function monthlyAllowanceCents(wsId) {
  const plan = planOf(wsId)
  return ALLOWANCE_CENTS[plan] ?? ALLOWANCE_CENTS.trial
}

function ensureRow(wsId, month = monthKey()) {
  db.prepare(
    `INSERT INTO ai_spend (workspace_id, month, cents_used, updated_at)
     VALUES (?, ?, 0, datetime('now'))
     ON CONFLICT(workspace_id, month) DO NOTHING`
  ).run(wsId, month)
  return db.prepare(
    'SELECT cents_used FROM ai_spend WHERE workspace_id = ? AND month = ?'
  ).get(wsId, month)
}

export function spendStatus(wsId) {
  const month = monthKey()
  const row = ensureRow(wsId, month)
  const allowance = monthlyAllowanceCents(wsId)
  const used = Number(row?.cents_used || 0)
  return {
    month,
    usedCents: used,
    allowanceCents: allowance,
    remainingCents: Math.max(0, allowance - used),
    exhausted: used >= allowance,
    planId: planOf(wsId) || null,
  }
}

/** True when the workspace can afford `op` (or an explicit cent cost). */
export function canAfford(wsId, opOrCents) {
  if (wsId == null) return true
  const cost = typeof opOrCents === 'number' ? opOrCents : costOf(opOrCents)
  const status = spendStatus(wsId)
  return status.usedCents + cost <= status.allowanceCents
}

/**
 * Charge the workspace for an AI op. Returns false when the allowance would be
 * exceeded (and does not charge). Callers must check the return and fall back.
 */
export function chargeAi(wsId, op, { detail = '' } = {}) {
  if (wsId == null) return true
  const normalised = normaliseAiOp(op)
  const cost = costOf(normalised)
  const month = monthKey()
  const allowance = monthlyAllowanceCents(wsId)
  ensureRow(wsId, month)
  // Atomic check-and-charge so two concurrent ticks cannot both slip under the
  // ceiling. The WHERE clause is the gate; allowance is resolved in JS from the
  // same plan table the status readout uses.
  const info = db.prepare(
    `UPDATE ai_spend
        SET cents_used = cents_used + ?,
            updated_at = datetime('now')
      WHERE workspace_id = ? AND month = ?
        AND cents_used + ? <= ?`
  ).run(cost, wsId, month, cost, allowance)
  if (info.changes === 0) return false
  if (detail) {
    try {
      db.prepare(
        'INSERT INTO events (user_id, type, detail) VALUES (?, ?, ?)'
      ).run(wsId, 'ai_spend', `${normalised}:${cost}c ${detail}`.slice(0, 240))
    } catch { /* events table always exists; ignore */ }
  }
  return true
}

/**
 * Refund a prior charge after a provider outage. Never drops below zero.
 * Model refusals / bad outputs are NOT refunded — only transport failures.
 */
export function refundAi(wsId, op, { detail = '' } = {}) {
  if (wsId == null) return
  const normalised = normaliseAiOp(op)
  const cost = costOf(normalised)
  const month = monthKey()
  ensureRow(wsId, month)
  db.prepare(
    `UPDATE ai_spend
        SET cents_used = MAX(0, cents_used - ?),
            updated_at = datetime('now')
      WHERE workspace_id = ? AND month = ?`
  ).run(cost, wsId, month)
  try {
    db.prepare(
      'INSERT INTO events (user_id, type, detail) VALUES (?, ?, ?)'
    ).run(wsId, 'ai_spend_refund', `${normalised}:${cost}c ${detail}`.slice(0, 240))
  } catch { /* ignore */ }
}

/** Thrown (and caught by compose/classify) when a paid call is refused. */
export class AiBudgetError extends Error {
  constructor(message = 'Monthly AI allowance exhausted') {
    super(message)
    this.name = 'AiBudgetError'
    this.code = 'ai_budget_exhausted'
  }
}
