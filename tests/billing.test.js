import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readBillingConfig, getBilling, applyBilling, BillingError, resetBillingCache } from '../server/billing.js'
import { db } from '../server/db.js'

const BASE_ENV = {
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  STRIPE_PAYMENT_LINK_STARTER: '',
  STRIPE_PAYMENT_LINK_GROWTH: '',
  STRIPE_PAYMENT_LINK_SCALE: '',
  APP_URL: 'http://localhost:8131',
}

function withEnv(overrides, fn) {
  const saved = {}
  for (const key of Object.keys({ ...BASE_ENV, ...overrides })) {
    saved[key] = process.env[key]
    const val = overrides[key]
    if (val === undefined || val === '') delete process.env[key]
    else process.env[key] = val
  }
  resetBillingCache()
  try {
    fn()
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    resetBillingCache()
  }
}

function stripeSig(raw, secret, at = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')
  const mac = createHmac('sha256', secret).update(`${at}.`, 'utf8').update(payload).digest('hex')
  return `t=${at},v1=${mac}`
}

describe('billing config', () => {
  it('returns unconfigured when no Stripe vars are set', () => {
    withEnv({}, () => {
      const cfg = readBillingConfig()
      assert.equal(cfg.configured, false)
    })
  })

  it('throws on half configuration', () => {
    withEnv({ STRIPE_SECRET_KEY: 'sk_test_x', APP_URL: 'https://harrythemarketer.com' }, () => {
      assert.throws(
        () => readBillingConfig(),
        (err) => err instanceof BillingError && err.code === 'half_configured'
      )
    })
  })

  it('accepts full test configuration', () => {
    withEnv({
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      STRIPE_PAYMENT_LINK_STARTER: 'https://buy.stripe.com/test_starter',
      APP_URL: 'https://harrythemarketer.com',
    }, () => {
      const cfg = readBillingConfig()
      assert.equal(cfg.configured, true)
      assert.equal(cfg.live, false)
      assert.equal(cfg.links.starter, 'https://buy.stripe.com/test_starter')
    })
  })
})

describe('billing webhook', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    resetBillingCache()
  })

  it('verifies stripe signatures on raw bytes', () => {
    withEnv({
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      STRIPE_PAYMENT_LINK_STARTER: 'https://buy.stripe.com/test_starter',
      APP_URL: 'https://harrythemarketer.com',
    }, () => {
      const billing = getBilling()
      const raw = Buffer.from(JSON.stringify({ id: 'evt_test', type: 'ping' }))
      const sig = stripeSig(raw, 'whsec_test')
      billing.verifySignature(raw, sig)
    })
  })

  it('provisions plan on checkout.session.completed', async () => {
    await new Promise((resolve, reject) => {
      withEnv({
        STRIPE_SECRET_KEY: 'sk_test_x',
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
        STRIPE_PAYMENT_LINK_STARTER: 'https://buy.stripe.com/test_starter',
        APP_URL: 'https://harrythemarketer.com',
      }, () => {
        const billing = getBilling()
        const email = `billing-${Date.now()}@test.local`
        db.prepare('INSERT INTO users (sub, email, name) VALUES (?, ?, ?)').run(`dev:${email}`, email, 'Billing Test')

        const event = {
          type: 'checkout.session.completed',
          data: {
            object: {
              id: 'cs_test',
              customer_details: { email },
              customer: 'cus_test',
              payment_link: 'plink_test_starter',
            },
          },
        }

        global.fetch = async () => ({
          ok: true,
          text: async () => JSON.stringify({
            id: 'cs_test',
            payment_link: 'plink_test_starter',
            metadata: { plan_id: 'starter' },
          }),
        })

        billing.handleWebhook(event).then((result) => {
          try {
            assert.equal(result.handled, true)
            const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
            assert.equal(user.billing_status, 'active')
            assert.equal(user.plan_id, 'starter')
            assert.equal(user.stripe_customer_id, 'cus_test')
            resolve()
          } catch (err) {
            reject(err)
          }
        }).catch(reject)
      })
    })
  })

  it('builds checkout URL with prefilled email', () => {
    withEnv({
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      STRIPE_PAYMENT_LINK_STARTER: 'https://buy.stripe.com/test_starter',
      APP_URL: 'https://harrythemarketer.com',
    }, () => {
      const billing = getBilling()
      const url = billing.checkoutUrl('starter', 'buyer@example.com')
      assert.match(url, /^https:\/\/buy\.stripe\.com\/test_starter/)
      assert.match(url, /prefilled_email=buyer%40example.com/)
    })
  })
})

describe('applyBilling', () => {
  it('updates user billing columns', () => {
    const email = `apply-${Date.now()}@test.local`
    const info = db.prepare('INSERT INTO users (sub, email) VALUES (?, ?)').run(`dev:${email}`, email)
    applyBilling(info.lastInsertRowid, { planId: 'growth', customerId: 'cus_x', status: 'active', detail: 'test' })
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)
    assert.equal(user.plan_id, 'growth')
    assert.equal(user.billing_status, 'active')
    assert.equal(user.stripe_customer_id, 'cus_x')
  })
})
