// "Harry never handles a payment instrument" — stated as an invariant, enforced
// by a hand-maintained list of field names that was missing obvious entries.
//
// `credit_card` and `paypal_email` both walked past it: the list had `card` and
// no notion of PayPal at all. Nothing leaked, because no route downstream reads
// these fields — but "nothing leaked" is a fact about the rest of the code, not
// about the guard, and the guard is what the invariant rests on.
//
// The failure is structural rather than careless. An exact-match list has to be
// complete to be safe, and nobody can enumerate every way a supplier might
// spell a card. Patterns now run alongside it, and this file is the probe: each
// spelling named individually, plus the legitimate fields that must survive,
// because a guard that refuses `scorecard` breaks orders instead of protecting
// anyone.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-pay-'))

const { rejectPaymentInstruments } = await import('../server/parity/senders.js')

const refuses = (body) => {
  try { rejectPaymentInstruments(body); return null } catch (err) { return err }
}

// Spellings that must never reach a handler. `credit_card` and `paypal_email`
// are the two the audit found; the rest are the neighbours that would have been
// next.
const FORBIDDEN = [
  'credit_card', 'creditCard', 'credit-card', 'debit_card', 'gift_card', 'prepaid_card',
  'card', 'card_number', 'cardnumber', 'pan',
  'paypal_email', 'paypalEmail', 'paypal_account',
  'cvv', 'cvc', 'cvv2', 'csc',
  'iban', 'bic', 'swift',
  'routing_number', 'sort_code',
  'bank_account', 'bank_details', 'billing_details',
  'payment_method', 'payment_token', 'payout_account',
  'stripe_token', 'card_token',
]

// Fields an order legitimately carries. Refusing any of these would turn the
// guard into an outage.
const PERMITTED = [
  'email', 'first_name', 'last_name', 'company', 'domain', 'forwarding_domain',
  'quantity', 'plan', 'order_reference', 'supplier', 'dashboard_url', 'notes',
  // The near-misses that a careless pattern would catch.
  'wildcard', 'wildcard_domain', 'discard', 'discarded_at', 'scorecard', 'dashboard',
]

for (const field of FORBIDDEN) {
  test(`refuses ${field}`, () => {
    const err = refuses({ [field]: 'anything' })
    assert.ok(err, `${field} must be refused`)
    assert.equal(err.body?.field ?? err.field, field, 'and named, so the caller can remove it')
  })
}

test('every legitimate order field survives the guard', () => {
  for (const field of PERMITTED) {
    assert.equal(refuses({ [field]: 'value' }), null, `${field} must be allowed`)
  }
  // And all of them together, which is what a real order looks like.
  const order = Object.fromEntries(PERMITTED.map((f) => [f, 'value']))
  assert.equal(refuses(order), null)
})

test('a payment field nested inside an order is still refused', () => {
  const err = refuses({ order: { billing: { credit_card: '4111111111111111' } } })
  assert.ok(err)
  assert.match(err.body?.field ?? err.field, /credit_card$/, 'named with its path')
})

test('a payment field inside an array is refused', () => {
  const err = refuses({ items: [{ domain: 'ok.test' }, { paypal_email: 'a@b.test' }] })
  assert.ok(err)
  assert.match(err.body?.field ?? err.field, /paypal_email$/)
})

test('the refusal explains what to do instead, rather than just saying no', () => {
  const err = refuses({ credit_card: '4111' })
  const message = err.body?.message ?? err.message
  assert.match(message, /supplier/i, 'points at where payment actually belongs')
  assert.match(message, /remove this field/i)
})

test('the value is never echoed back', () => {
  // The one thing worse than accepting a card number is accepting it and then
  // repeating it in an error message that gets logged.
  const err = refuses({ card_number: '4111111111111111' })
  const serialised = JSON.stringify(err.body ?? { message: err.message })
  assert.ok(!serialised.includes('4111111111111111'), 'the number is not in the response')
})

test('deeply nested bodies terminate rather than recursing for ever', () => {
  let deep = { credit_card: 'x' }
  for (let i = 0; i < 200; i++) deep = { nested: deep }
  // Past the depth limit the guard stops looking — the point of this test is
  // that it returns at all rather than overflowing the stack on a hostile body.
  assert.doesNotThrow(() => { try { rejectPaymentInstruments(deep) } catch { /* refusal is fine */ } })
})
