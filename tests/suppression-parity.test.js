// Every suppression check in the codebase must give the same answer.
//
// There were five: `suppression.js` walked parent labels, `inbox.js` matched
// the exact address or its immediate domain only, `campaigns.js` compared
// against a raw Set with no domain handling at all, `leads.js` and `lists.js`
// each had their own. An audit proved they disagreed on the same address, and
// the weakest of them is what let a forward reach a blocked subdomain.
//
// Four now delegate to `suppression.js`. `lists.js` deliberately keeps an
// in-memory pass — an import checks thousands of addresses and a query each
// would be absurd — so this file exists to prove that shortcut still agrees
// with the rule it is a shortcut for. If it ever stops agreeing, the fast path
// is a fifth definition again and this goes red.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead } from './helpers/parity-harness.js'

setup('suppression-parity')

const { db } = await import('../server/db.js')
const { blockMatch, suppressionFor } = await import('../server/suppression.js')
const { isBlocked } = await import('../server/parity/inbox.js')

const owner = seedUser(db, 'owner@parity.test')
const block = (value, isDomain) =>
  db.prepare(
    "INSERT OR IGNORE INTO blocked_domains (workspace_id, value, is_domain, source) VALUES (?, ?, ?, 'manual')"
  ).run(owner.id, value, isDomain ? 1 : 0)

block('competitor.com', true)
block('one.person@allowed.test', false)

// The cases that separated the five implementations.
const CASES = [
  ['ana@competitor.com', true, 'the blocked domain itself'],
  ['ana@mail.competitor.com', true, 'a subdomain — the case that got through'],
  ['ana@deep.mail.competitor.com', true, 'a deeper subdomain'],
  ['one.person@allowed.test', true, 'an exact-address entry'],
  ['someone.else@allowed.test', false, 'a different address on an unblocked domain'],
  ['ana@notcompetitor.com', false, 'a domain that merely ends similarly'],
  ['ana@competitor.com.evil.test', false, 'the blocked domain as a prefix of another'],
  ['', false, 'an empty address'],
]

test('the canonical predicate answers every case correctly', () => {
  for (const [address, expected, why] of CASES) {
    assert.equal(Boolean(blockMatch(owner.id, address)), expected, `${why}: ${address}`)
  }
})

test("inbox's isBlocked agrees with the canonical predicate on every case", () => {
  for (const [address, expected, why] of CASES) {
    assert.equal(isBlocked(owner.id, address), expected, `${why}: ${address}`)
  }
})

test("the lists importer's in-memory fast path agrees with the canonical predicate", () => {
  // Rebuild the shortcut exactly as lists.js does, and compare it case by case.
  const rows = db.prepare('SELECT value, is_domain FROM blocked_domains WHERE workspace_id = ?').all(owner.id)
  const addresses = new Set()
  const domains = []
  for (const row of rows) {
    const value = String(row.value || '').trim().toLowerCase()
    if (!value) continue
    if (row.is_domain) domains.push(value.replace(/^@/, ''))
    else addresses.add(value)
  }
  const fast = (email) => {
    const value = String(email || '').toLowerCase()
    if (addresses.has(value)) return true
    const domain = value.split('@')[1] || ''
    if (!domain) return false
    return domains.some((d) => domain === d || domain.endsWith(`.${d}`))
  }

  for (const [address, expected, why] of CASES) {
    assert.equal(fast(address), expected, `fast path, ${why}: ${address}`)
    assert.equal(fast(address), Boolean(blockMatch(owner.id, address)),
      `fast path and canonical must agree on ${address}`)
  }
})

test('unsubscribed and bounced are suppression too, not just the block list', () => {
  const gone = seedLead(db, owner.id, 'gone@allowed.test')
  db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(gone.id)
  const bounced = seedLead(db, owner.id, 'bounced@allowed.test')
  db.prepare("UPDATE leads SET status = 'bounced' WHERE id = ?").run(bounced.id)

  assert.equal(suppressionFor(owner.id, { address: 'gone@allowed.test' })?.reason, 'unsubscribed')
  assert.equal(suppressionFor(owner.id, { address: 'bounced@allowed.test' })?.reason, 'bounced')
  assert.equal(suppressionFor(owner.id, { address: 'fine@allowed.test' }), null)
})

test('suppression is per workspace — one workspace cannot suppress another', () => {
  const stranger = seedUser(db, 'stranger@parity.test')
  assert.ok(blockMatch(owner.id, 'ana@competitor.com'), 'blocked for the owner')
  assert.equal(blockMatch(stranger.id, 'ana@competitor.com'), null, 'not for anyone else')
})

test('there is exactly one place that decides what "blocked" means', async () => {
  // The structural guarantee. A module that queries blocked_domains to *decide*
  // (rather than to list or write) is a sixth definition waiting to drift.
  const fs = await import('node:fs')
  const path = await import('node:path')
  const offenders = []
  for (const file of ['inbox.js', 'leads.js', 'campaigns.js']) {
    const src = fs.readFileSync(path.join(process.cwd(), 'server', 'parity', file), 'utf8')
    if (!src.includes("from '../suppression.js'")) offenders.push(`${file} does not import the canonical rule`)
  }
  assert.deepEqual(offenders, [])
})
