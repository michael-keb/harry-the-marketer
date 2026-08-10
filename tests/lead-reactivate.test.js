// Reversing an opt-out is allowed exactly when the opt-out was the machine's.
//
// The classifier once read "ok thanks" above a quoted unsubscribe footer and
// opted the lead out — block-listed, stopped, and with no control anywhere to
// undo it. reactivateLead is that control, scoped tightly: a machine-inferred
// opt-out (source 'reply') can be reversed by a person; the person's own
// footer click (source 'link') cannot, by anyone, ever.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-reactivate-'))
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { unsubscribeLead, reactivateLead, suppressionFor } = await import('../server/suppression.js')

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:o@x.com', 'o@x.com', 'O')").run()
const addLead = db.prepare('INSERT INTO leads (user_id, email, first_name) VALUES (1, ?, ?)')
addLead.run('misread@example.test', 'Misread')   // 1 — classifier opted them out
addLead.run('chose@example.test', 'Chose')       // 2 — clicked the footer link themselves

const lead = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id)
const blockRows = (addr) =>
  db.prepare('SELECT * FROM blocked_domains WHERE workspace_id = 1 AND lower(trim(value)) = ?').all(addr)

test('a machine-inferred unsubscribe can be reversed by a person', () => {
  unsubscribeLead(1, 1, { source: 'reply', actor: 'lead' })
  assert.equal(lead(1).status, 'unsubscribed')
  assert.equal(blockRows('misread@example.test').length, 1)
  assert.ok(suppressionFor(1, { address: 'misread@example.test' }))

  const undo = reactivateLead(1, 1, { actor: 'o@x.com' })
  assert.equal(undo.ok, true)
  assert.equal(undo.unblocked, 1)
  assert.equal(lead(1).status, 'active')
  assert.equal(String(lead(1).unsubscribed_at || ''), '')
  assert.equal(blockRows('misread@example.test').length, 0)
  assert.equal(suppressionFor(1, { address: 'misread@example.test' }), null)
})

test("the person's own footer click stays irreversible", () => {
  unsubscribeLead(1, 2, { source: 'link', actor: 'recipient' })
  const undo = reactivateLead(1, 2, { actor: 'o@x.com' })
  assert.equal(undo.ok, false)
  assert.equal(undo.reason, 'link_optout')
  assert.equal(lead(2).status, 'unsubscribed')
  assert.ok(suppressionFor(1, { address: 'chose@example.test' }))
})

test('a manually added block row survives reactivation', () => {
  // One row per address (UNIQUE on workspace_id + value): a manual block that
  // predates the unsubscribe is the row that exists, and the reversal must not
  // take it — someone chose it.
  db.prepare("UPDATE leads SET status = 'active', unsubscribed_at = '', unsubscribed_source = '' WHERE id = 1").run()
  db.prepare(
    "INSERT INTO blocked_domains (workspace_id, value, is_domain, source, created_by) VALUES (1, 'misread@example.test', 0, 'manual', 'o@x.com')"
  ).run()
  unsubscribeLead(1, 1, { source: 'reply', actor: 'lead' })

  const undo = reactivateLead(1, 1, { actor: 'o@x.com' })
  assert.equal(undo.ok, true)
  const left = blockRows('misread@example.test')
  assert.equal(left.length, 1)
  assert.equal(left[0].source, 'manual')
  // Still suppressed — by the manual row, which is the point.
  assert.ok(suppressionFor(1, { address: 'misread@example.test' }))
})

test('reactivating an already-active lead is a no-op, not an error', () => {
  db.prepare("DELETE FROM blocked_domains WHERE source = 'manual'").run()
  unsubscribeLead(1, 1, { source: 'reply', actor: 'lead' })
  const undo = reactivateLead(1, 1, { actor: 'o@x.com' })
  assert.equal(undo.ok, true)
  assert.equal(undo.changed, 1)
  const again = reactivateLead(1, 1, { actor: 'o@x.com' })
  assert.equal(again.ok, true)
  assert.equal(again.changed, 0)
})
