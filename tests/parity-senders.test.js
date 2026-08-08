// smart-senders — the money-touching category, tested with no provider
// configured and no network call anywhere.
//
// The behaviours worth a test here are not the happy paths. They are: the same
// idempotency key cannot buy twice, a payment instrument is refused outright,
// billing details are unreadable at rest, a timeout leaves one pending order
// and no retry, and one workspace cannot read another's order.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedMailbox, mount } from './helpers/parity-harness.js'

setup('senders')                   // MUST precede any ../server import

const { db } = await import('../server/db.js')
const { register, __setSupplierForTests } = await import('../server/parity/senders.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
const other = await mount(register, stranger)
test.after(() => Promise.all([client.close(), other.close()]))

// ---- fixtures ---------------------------------------------------------------

// Deliberately distinct from every mailbox name in the fixtures below, so an
// assertion that a billing value did not leak cannot pass or fail by accident
// on a value the user typed into the mailbox rows instead.
const BILLING = {
  email: 'registrant-9f3a@example.test',
  firstName: 'Grace',
  lastName: 'Hopperton',
  company: 'Registrant Holdings Ltd',
  country: 'GB',
  city: 'Winchesterfield',
  addressLineOne: '12 Analytical Way',
  postalCode: 'EC1A 1BB',
  phoneCc: '+44',
  phone: '2079460123',
  state: 'Hampshireton',
  languagePreference: 'en',
}

// The values that must never appear in a response, a row, a log line or a
// telemetry row. `country` and `languagePreference` are excluded from the
// substring check only because "GB" and "en" occur in ordinary English words —
// they are covered by the encrypted-blob assertion instead.
const BILLING_SECRETS = [
  BILLING.email, BILLING.firstName, BILLING.lastName, BILLING.company,
  BILLING.city, BILLING.addressLineOne, BILLING.postalCode, BILLING.phone, BILLING.state,
]

let keyCounter = 0
function newKey(label = 'k') {
  return `idem-${label}-${++keyCounter}-${'x'.repeat(8)}`
}

function order(overrides = {}) {
  return {
    vendor_id: '2',
    forwarding_domain: 'example.com',
    idempotency_key: newKey(),
    total: 45,
    currency: 'USD',
    user_details: { ...BILLING },
    domains: [{
      domain_name: 'sales-outreach.com',
      mailbox_details: [
        { mailbox: 'ada', first_name: 'Ada', last_name: 'Lovelace' },
        { mailbox: 'ada.l@sales-outreach.com', first_name: 'Ada', last_name: 'Lovelace' },
      ],
    }],
    ...overrides,
  }
}

const countOrders = () => db.prepare('SELECT COUNT(*) n FROM sender_orders').get().n
const events = () => db.prepare('SELECT * FROM events ORDER BY id').all()
const telemetry = () => db.prepare('SELECT * FROM telemetry ORDER BY id').all()

// Everything Harry has written down, as one string, so "this value appears
// nowhere" can be asserted against the whole database rather than a guess at
// which column it might have leaked into.
function databaseDump() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  let dump = ''
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM ${name}`).all()) dump += JSON.stringify(row)
  }
  return dump
}

// ---- unconfigured: every route exists, validates, and says so ---------------

test('with no provider configured every route answers honestly', async () => {
  const vendors = await client.get('/api/senders/vendors')
  assert.equal(vendors.status, 200)
  assert.equal(vendors.body.ok, true)
  assert.deepEqual(vendors.body.data, [])
  assert.equal(vendors.body.configured, false)
  assert.match(vendors.body.message, /SENDERS_API_URL/)

  const domains = await client.get('/api/senders/domains')
  assert.equal(domains.status, 200)
  assert.equal(domains.body.configured, false)
  assert.deepEqual(domains.body.data, [])

  const search = await client.get('/api/senders/domains/search?vendor_id=1&q=techbuilddemo')
  assert.equal(search.status, 200)
  assert.equal(search.body.configured, false)
  assert.deepEqual(search.body.data, [])
  assert.equal(search.body.price_ceiling, 15)
})

// ---- search validation ------------------------------------------------------

test('search names the field it refuses', async () => {
  const noVendor = await client.get('/api/senders/domains/search?q=techbuilddemo')
  assert.equal(noVendor.status, 422)
  assert.equal(noVendor.body.field, 'vendor_id')

  const shortQuery = await client.get('/api/senders/domains/search?vendor_id=1&q=a')
  assert.equal(shortQuery.status, 422)
  assert.equal(shortQuery.body.field, 'q')

  const noQuery = await client.get('/api/senders/domains/search?vendor_id=1')
  assert.equal(noQuery.status, 422)
  assert.equal(noQuery.body.field, 'domain_name')
})

// ---- purchased domains join -------------------------------------------------

test('purchased domains join to Harry mailboxes, subdomains included', async () => {
  db.prepare("INSERT INTO sender_domains (workspace_id, vendor_id, domain, status) VALUES (?, '2', 'used-domain.com', 'purchased')").run(owner.id)
  db.prepare("INSERT INTO sender_domains (workspace_id, vendor_id, domain, status) VALUES (?, '2', 'idle-domain.com', 'purchased')").run(owner.id)
  db.prepare("INSERT INTO sender_domains (workspace_id, vendor_id, domain, status) VALUES (?, '2', 'not-yours.com', 'purchased')").run(stranger.id)
  seedMailbox(db, owner.id, 'ada@USED-domain.com')
  seedMailbox(db, owner.id, 'ada@news.used-domain.com')

  const res = await client.get('/api/senders/domains')
  assert.equal(res.status, 200)
  const byName = Object.fromEntries(res.body.data.map((d) => [d.domain, d]))
  assert.equal(res.body.data.length, 2, 'another workspace\'s domain is invisible')
  assert.equal(byName['used-domain.com'].mailbox_count, 2, 'case-insensitive, and a subdomain counts')
  assert.equal(byName['used-domain.com'].unused, false)
  assert.equal(byName['idle-domain.com'].mailbox_count, 0)
  assert.equal(byName['idle-domain.com'].unused, true)
})

// ---- suggestion: pure, bounded, honest about who is writing -----------------

test('mailbox suggestion is bounded, grouped and free of side effects', async () => {
  const before = { orders: countOrders(), events: events().length }

  const missing = await client.post('/api/senders/mailboxes/suggest', { vendor_id: '1' })
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'domains')

  const zero = await client.post('/api/senders/mailboxes/suggest', {
    vendor_id: '1', domains: { 'example.com': { count: 0 } },
  })
  assert.equal(zero.status, 422)
  assert.match(zero.body.message, /at least 1/)

  const absurd = await client.post('/api/senders/mailboxes/suggest', {
    vendor_id: '1', domains: { 'example.com': { count: 5000 } },
  })
  assert.equal(absurd.status, 422)
  assert.match(absurd.body.message, /at most 10/)

  const res = await client.post('/api/senders/mailboxes/suggest', {
    vendor_id: '1',
    domains: { 'example.com': { count: 3 }, 'second.com': { count: 1 } },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.length, 2, 'suggestions stay grouped per domain')
  const first = res.body.data.find((d) => d.domain === 'example.com')
  assert.equal(first.suggestions.length, 3)
  assert.ok(first.suggestions.every((s) => s.mailbox.endsWith('@example.com')), 'never off-domain')
  assert.equal(new Set(first.suggestions.map((s) => s.mailbox)).size, 3, 'no duplicates')
  // Nothing invented: the names lean on a real person already in the workspace.
  assert.equal(first.suggestions[0].first_name, 'owner')
  assert.equal(res.body.data.find((d) => d.domain === 'second.com').suggestions.length, 1)
  assert.equal(res.body.configured, false)
  assert.equal(res.body.data[0].source, 'harry', 'a local suggestion says it is local')

  assert.equal(countOrders(), before.orders, 'suggestion writes no order')
  assert.equal(events().length, before.events, 'suggestion is not an auditable act')
})

// ---- no payment instrument, ever -------------------------------------------

test('a request carrying a payment instrument is refused and writes nothing', async () => {
  const before = countOrders()

  for (const [label, body] of [
    ['top level', order({ card_number: '4242424242424242' })],
    ['nested in user_details', order({ user_details: { ...BILLING, cvv: '123' } })],
    ['tokenised', order({ payment_method: 'pm_1234' })],
    ['camelCase', order({ cardNumber: '4242424242424242' })],
    ['deep inside a domain row', order({
      domains: [{
        domain_name: 'sales-outreach.com',
        mailbox_details: [{ mailbox: 'ada', first_name: 'Ada', last_name: 'Lovelace', stripe_token: 'tok_1' }],
      }],
    })],
  ]) {
    const res = await client.post('/api/senders/orders', body)
    assert.equal(res.status, 422, `${label} must be refused`)
    assert.match(res.body.message, /never accepts, stores or forwards a payment instrument/)
    assert.ok(res.body.field, `${label} names the offending field`)
  }

  assert.equal(countOrders(), before, 'a refused request leaves no order behind')

  // And the value never reaches the database, the log or telemetry.
  const dump = databaseDump() + JSON.stringify(events()) + JSON.stringify(telemetry())
  assert.equal(dump.includes('4242424242424242'), false)
  assert.equal(dump.includes('pm_1234'), false)
  assert.equal(dump.includes('tok_1'), false)

  // The suggestion route refuses one too — no route in this module accepts one.
  const suggest = await client.post('/api/senders/mailboxes/suggest', {
    vendor_id: '1', domains: { 'example.com': { count: 1 } }, card: '4111111111111111',
  })
  assert.equal(suggest.status, 422)
  assert.equal(suggest.body.field, 'card')
})

// ---- ordering: explicit, validated, idempotent ------------------------------

test('an order without an idempotency key is a 422 naming the field', async () => {
  const body = order()
  delete body.idempotency_key
  const res = await client.post('/api/senders/orders', body)
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'idempotency_key')
  assert.match(res.body.message, /summary/)
})

test('order validation names the offending field and orders nothing', async () => {
  const before = countOrders()
  const cases = [
    [order({ forwarding_domain: undefined }), 'forwarding_domain'],
    [order({ forwarding_domain: 'not a domain' }), 'forwarding_domain'],
    [order({ vendor_id: undefined }), 'vendor_id'],
    [order({ domains: [] }), 'domains'],
    [order({
      domains: [{ domain_name: 'sales-outreach.com', mailbox_details: [{ mailbox: 'ada', last_name: 'Lovelace' }] }],
    }), 'domains[0].mailbox_details[0].first_name'],
    [order({
      domains: [{
        domain_name: 'sales-outreach.com',
        mailbox_details: [{ mailbox: 'ada@elsewhere.com', first_name: 'Ada', last_name: 'Lovelace' }],
      }],
    }), 'domains[0].mailbox_details[0].mailbox'],
  ]
  for (const [body, field] of cases) {
    const res = await client.post('/api/senders/orders', body)
    assert.equal(res.status, 422, `expected 422 for ${field}`)
    assert.equal(res.body.field, field)
  }
  assert.equal(countOrders(), before)
})

test('the same idempotency key cannot create two orders', async () => {
  process.env.SENDERS_BILLING_KEY = 'test-billing-key-please-rotate'
  const key = newKey('once')
  const body = order({ idempotency_key: key })

  const first = await client.post('/api/senders/orders', body)
  assert.equal(first.status, 200)
  assert.equal(first.body.duplicate, false)
  const ref = first.body.data.order_ref
  assert.ok(ref, 'an order reference is returned even though nothing was charged')

  const second = await client.post('/api/senders/orders', body)
  assert.equal(second.status, 200)
  assert.equal(second.body.duplicate, true)
  assert.equal(second.body.data.order_ref, ref, 'the caller is shown the existing reference')

  // A third attempt that changes the order but keeps the key is still one order.
  const third = await client.post('/api/senders/orders', order({
    idempotency_key: key, total: 9999, domains: [{
      domain_name: 'somewhere-else.com',
      mailbox_details: [{ mailbox: 'zed', first_name: 'Zed', last_name: 'Smith' }],
    }],
  }))
  assert.equal(third.status, 200)
  assert.equal(third.body.duplicate, true)
  assert.equal(third.body.data.order_ref, ref)
  assert.equal(third.body.data.total, 45, 'the first order is authoritative')

  const rows = db.prepare('SELECT * FROM sender_orders WHERE workspace_id = ? AND idempotency_key = ?')
    .all(owner.id, key)
  assert.equal(rows.length, 1, 'exactly one row, enforced by the unique index')

  // One events row for the order, carrying the reference, the domains and the
  // total — and no billing detail at all.
  const placed = events().filter((e) => e.type === 'sender_order_placed' && e.detail.includes(ref))
  assert.equal(placed.length, 1, 'the duplicate does not log a second order')
  assert.match(placed[0].detail, /sales-outreach\.com/)
  assert.match(placed[0].detail, /45\.00 USD/)
  for (const value of BILLING_SECRETS) {
    assert.equal(placed[0].detail.includes(value), false, `${value} must not be in the activity trail`)
  }
})

// ---- billing details: encrypted at rest, absent from responses --------------

test('billing details are encrypted at rest and never echoed', async () => {
  process.env.SENDERS_BILLING_KEY = 'test-billing-key-please-rotate'
  const res = await client.post('/api/senders/orders', order())
  assert.equal(res.status, 200)
  assert.equal(res.body.billing_details_stored, true)

  // Not in the response body, in any form.
  const serialised = JSON.stringify(res.body)
  for (const value of BILLING_SECRETS) {
    assert.equal(serialised.includes(value), false, `${value} must not be echoed`)
  }

  const row = db.prepare('SELECT * FROM sender_billing_details WHERE workspace_id = ?').get(owner.id)
  assert.ok(row && row.encrypted)
  assert.match(row.encrypted, /^v1\./)
  // BILLING_SECRETS, not every field: "GB" and "en" are two characters, and a
  // base64 ciphertext contains almost any two characters by chance. Asserting
  // on them tests the random nonce, not the encryption — this failed roughly
  // one run in three. The short fields are covered by the blob being AES-GCM
  // ciphertext at all, which the `^v1.` match above establishes.
  for (const value of BILLING_SECRETS) {
    assert.equal(row.encrypted.includes(value), false, `${value} must not be readable at rest`)
  }

  // Nor anywhere else Harry writes: not a row, not a log line, not telemetry.
  const dump = databaseDump() + JSON.stringify(events()) + JSON.stringify(telemetry())
  for (const value of BILLING_SECRETS) {
    assert.equal(dump.includes(value), false, `${value} must not be stored or logged in the clear`)
  }

  // Collected once: a second order needs no user_details.
  const body = order()
  delete body.user_details
  const reuse = await client.post('/api/senders/orders', body)
  assert.equal(reuse.status, 200)
  assert.equal(reuse.body.billing_details_stored, true)
})

test('without an encryption key Harry refuses to store billing details', async () => {
  const previous = process.env.SENDERS_BILLING_KEY
  delete process.env.SENDERS_BILLING_KEY
  db.prepare('DELETE FROM sender_billing_details').run()
  try {
    const res = await client.post('/api/senders/orders', order())
    assert.equal(res.status, 200, 'the order is not blocked by it')
    assert.equal(res.body.billing_details_stored, false)
    assert.match(res.body.billing_notice, /SENDERS_BILLING_KEY/)
    const row = db.prepare('SELECT * FROM sender_billing_details WHERE workspace_id = ?').get(owner.id)
    assert.equal(row, undefined, 'nothing is stored in the clear')

    // And with nothing on file the next order must ask again rather than
    // silently proceeding without a registrant.
    const body = order()
    delete body.user_details
    const missing = await client.post('/api/senders/orders', body)
    assert.equal(missing.status, 422)
    assert.equal(missing.body.field, 'user_details')
  } finally {
    if (previous) process.env.SENDERS_BILLING_KEY = previous
  }
})

// ---- timeouts: one pending order, no automatic retry ------------------------

test('a supplier timeout leaves exactly one pending order and no retry', async () => {
  process.env.SENDERS_BILLING_KEY = 'test-billing-key-please-rotate'
  const calls = []
  __setSupplierForTests(async (path) => {
    calls.push(path)
    return { ok: false, reason: 'timeout', payload: null }
  })
  try {
    const key = newKey('timeout')
    const res = await client.post('/api/senders/orders', order({ idempotency_key: key }))
    assert.equal(res.status, 200)
    assert.equal(res.body.data.status, 'pending')
    assert.equal(res.body.auto_retry, false)
    assert.equal(res.body.retried, false)
    assert.match(res.body.pending_reason, /NOT been/)
    assert.match(res.body.pending_reason, /pending/)

    assert.equal(calls.length, 1, 'the supplier is asked exactly once — never re-posted')

    const rows = db.prepare("SELECT * FROM sender_orders WHERE workspace_id = ? AND idempotency_key = ?")
      .all(owner.id, key)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'pending')

    // Reconciliation is a read. Opening the order details asks the supplier for
    // status and never posts the order again.
    const before = calls.length
    const detail = await client.get(`/api/senders/orders/${res.body.data.order_ref}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.data.status, 'pending')
    assert.equal(detail.body.auto_retry, false)
    assert.equal(calls.length, before + 1)
    assert.match(calls[calls.length - 1], /order-details/, 'the reconciliation call is a lookup, not a place-order')
    assert.equal(calls.filter((p) => p.includes('place-order')).length, 1, 'place-order is posted once and once only')
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM sender_orders WHERE workspace_id = ? AND idempotency_key = ?").get(owner.id, key).n,
      1,
      'still exactly one order after reconciliation'
    )
  } finally {
    __setSupplierForTests(null)
  }
})

// ---- order lookup: scoped, leak-free ----------------------------------------

test('an order reference from another workspace 404s exactly like an unknown one', async () => {
  process.env.SENDERS_BILLING_KEY = 'test-billing-key-please-rotate'
  const mine = await client.post('/api/senders/orders', order())
  const ref = mine.body.data.order_ref

  const ownRead = await client.get(`/api/senders/orders/${ref}`)
  assert.equal(ownRead.status, 200)
  assert.equal(ownRead.body.data.order_ref, ref)

  const crossWorkspace = await other.get(`/api/senders/orders/${ref}`)
  const unknown = await other.get('/api/senders/orders/HTM-ORD-DOESNOTEXIST')
  assert.equal(crossWorkspace.status, 404)
  assert.equal(unknown.status, 404)
  assert.deepEqual(crossWorkspace.body, unknown.body, 'the refusal must not confirm the reference exists')
  assert.equal(JSON.stringify(crossWorkspace.body).includes('sales-outreach.com'), false)
})

test('an order response never carries a credential and no order stores one', async () => {
  process.env.SENDERS_BILLING_KEY = 'test-billing-key-please-rotate'
  const placed = await client.post('/api/senders/orders', order())
  const ref = placed.body.data.order_ref

  // A supplier that returns a password alongside each address: it is stripped
  // before the row is constructed and appears in no stored value.
  __setSupplierForTests(async (path) => {
    if (!path.includes('order-details')) return { ok: false, reason: 'unconfigured', payload: null }
    return {
      ok: true,
      reason: '',
      payload: {
        data: {
          order_id: ref,
          status: 'completed',
          domain: 'sales-outreach.com',
          email_accounts: [
            { address: 'ada@sales-outreach.com', password: 'sup3r-s3cret-pw', first_name: 'Ada' },
          ],
        },
      },
    }
  })
  try {
    const plain = await client.get(`/api/senders/orders/${ref}`)
    assert.equal(plain.status, 200)
    assert.equal(plain.body.data.status, 'placed')
    assert.equal(JSON.stringify(plain.body.data).includes('sup3r-s3cret-pw'), false,
      'the credential is not in the order record')
    assert.equal(plain.body.credentials, undefined, 'not revealed unless asked for')

    const revealed = await client.get(`/api/senders/orders/${ref}?reveal=1`)
    assert.equal(revealed.status, 200)
    assert.equal(revealed.body.credentials[0].credential, 'sup3r-s3cret-pw', 'passed through once')
    assert.match(revealed.body.credential_notice, /does not store/)

    // Passed through and held nowhere: not in the row, the log or telemetry.
    const dump = databaseDump() + JSON.stringify(events()) + JSON.stringify(telemetry())
    assert.equal(dump.includes('sup3r-s3cret-pw'), false)
    // The reveal itself is auditable; the value is not.
    assert.ok(events().some((e) => e.type === 'sender_credential_revealed' && e.detail.includes('ada@sales-outreach.com')))
  } finally {
    __setSupplierForTests(null)
  }
})

// ---- the one-time code ------------------------------------------------------

test('a sign-in code is scoped to the workspace\'s own orders, logged, and never stored', async () => {
  // An order whose mailbox exists, placed, in this workspace.
  db.prepare(
    `INSERT INTO sender_orders (workspace_id, vendor_id, order_ref, idempotency_key, status, forwarding_domain, domains, mailboxes, total, currency, created_by)
     VALUES (?, '2', 'HTM-ORD-OTPTEST', ?, 'placed', 'example.com', ?, ?, 45, 'USD', 'owner@example.com')`
  ).run(owner.id, newKey('otp'), JSON.stringify(['otp-domain.com']),
    JSON.stringify([{ address: 'admin@otp-domain.com', first_name: 'Ada', last_name: 'Lovelace' }]))

  const own = await client.get('/api/senders/mailboxes/admin@otp-domain.com/code')
  const nobody = await client.get('/api/senders/mailboxes/nobody@nowhere.test/code')
  assert.equal(own.status, 200, 'the owner may ask for a mailbox on its own placed order')
  assert.equal(own.body.data, null, 'with no supplier there is no code, and none is invented')
  assert.equal(nobody.status, 404, 'an address on no order of this workspace is refused')

  const strangerAsk = await other.get('/api/senders/mailboxes/admin@otp-domain.com/code')
  const strangerUnknown = await other.get('/api/senders/mailboxes/who@nowhere.test/code')
  assert.equal(strangerAsk.status, 404)
  assert.deepEqual(strangerAsk.body, strangerUnknown.body, 'out-of-scope reads exactly like unknown')

  // A refusal is recorded; so is a request. Neither carries a code.
  assert.ok(events().some((e) => e.type === 'sender_code_refused'))
  const requested = events().filter((e) => e.type === 'sender_code_requested')
  assert.ok(requested.length >= 1)
  assert.match(requested[0].detail, /admin@otp-domain\.com/)
  assert.match(requested[0].detail, /owner@example\.com/)

  // With a supplier answering, the code is returned once and written nowhere.
  __setSupplierForTests(async (path) => {
    if (!path.includes('auth-secret')) return { ok: false, reason: 'unconfigured', payload: null }
    return { ok: true, reason: '', payload: { data: { otp: '918273', expires_in: 300 } } }
  })
  try {
    const res = await client.get('/api/senders/mailboxes/admin@otp-domain.com/code')
    assert.equal(res.status, 200)
    assert.equal(res.body.data.otp, '918273')
    assert.equal(res.body.data.expires_in, 300)
    assert.equal(res.body.stored, false)

    const dump = databaseDump() + JSON.stringify(events()) + JSON.stringify(telemetry())
    assert.equal(dump.includes('918273'), false, 'the code exists in no row, no log line and no telemetry row')
  } finally {
    __setSupplierForTests(null)
  }

  // Malformed addresses never reach a lookup.
  const malformed = await client.get('/api/senders/mailboxes/not-an-address/code')
  assert.equal(malformed.status, 422)
  assert.equal(malformed.body.field, 'address')
})

test('sign-in codes are throttled per address', async () => {
  db.prepare(
    `INSERT INTO sender_orders (workspace_id, vendor_id, order_ref, idempotency_key, status, forwarding_domain, domains, mailboxes, total, currency, created_by)
     VALUES (?, '2', 'HTM-ORD-THROTTLE', ?, 'placed', 'example.com', ?, ?, 45, 'USD', 'owner@example.com')`
  ).run(owner.id, newKey('throttle'), JSON.stringify(['throttle-domain.com']),
    JSON.stringify([{ address: 'admin@throttle-domain.com' }]))

  const statuses = []
  for (let i = 0; i < 5; i++) {
    const res = await client.get('/api/senders/mailboxes/admin@throttle-domain.com/code')
    statuses.push(res.status)
    if (res.status === 429) {
      assert.equal(res.body.error, 'rate_limited')
      assert.ok(res.body.retry_after_seconds > 0)
    }
  }
  // Repeated code requests for one address are the shape of an account
  // takeover attempt, so the ceiling is low and the refusal states a wait.
  assert.ok(statuses.includes(429), 'repeated code requests are throttled')
  assert.ok(statuses.filter((s) => s === 200).length <= 3, 'at most three codes per address in the window')
  assert.equal(statuses[statuses.length - 1], 429, 'and it stays throttled')
})
