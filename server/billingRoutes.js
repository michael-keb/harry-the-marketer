import express from 'express'
import { BillingError, getBilling, billingStatus, billingConfigured } from './billing.js'
import { requireUser } from './auth.js'
import { PLANS } from '../shared/site-content.js'

const WEBHOOK_MAX_BODY = 256 * 1024

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > limit) {
        finish(reject, Object.assign(new Error('webhook body too large'), { tooLarge: true }))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('error', (err) => finish(reject, err))
    req.on('aborted', () => finish(reject, new Error('client aborted the webhook body')))
    req.on('end', () => finish(resolve, Buffer.concat(chunks)))
  })
}

export const billingRouter = express.Router()

/** Public config: which plans have checkout links (no secrets). */
billingRouter.get('/api/billing/config', (_req, res) => {
  let billing = null
  try {
    billing = getBilling()
  } catch (err) {
    if (err instanceof BillingError && err.code === 'half_configured') {
      return res.status(500).json({ error: err.message, code: err.code })
    }
  }
  res.json({
    configured: Boolean(billing),
    live: billing?.config?.live ?? false,
    plans: PLANS.map(({ id, name, monthly, annual }) => ({
      id,
      name,
      monthly,
      annual,
      checkout: Boolean(billing?.config?.links?.[id]),
    })),
  })
})

billingRouter.get('/api/billing/status', requireUser, (req, res) => {
  res.json(billingStatus(req.user))
})

/** Open a hosted Payment Link for the signed-in user. */
billingRouter.post('/api/billing/checkout', express.json(), requireUser, (req, res) => {
  try {
    const billing = getBilling()
    if (!billing) return res.status(503).json({ error: 'billing_not_configured' })
    const planId = String(req.body?.plan || 'starter').trim()
    if (!billing.config.links[planId]) {
      return res.status(400).json({ error: `No payment link configured for plan "${planId}"` })
    }
    const url = billing.checkoutUrl(planId, req.user.email)
    res.json({ ok: true, url, plan: planId })
  } catch (err) {
    if (err instanceof BillingError) return res.status(err.status).json({ error: err.message, code: err.code })
    console.error('[billing] checkout error:', err)
    res.status(500).json({ error: 'Could not open checkout' })
  }
})

/** Open Stripe Customer Portal (manage card / invoices / cancel). */
billingRouter.post('/api/billing/portal', express.json(), requireUser, async (req, res) => {
  try {
    const billing = getBilling()
    if (!billing) return res.status(503).json({ error: 'billing_not_configured' })
    const customerId = req.user.stripe_customer_id
    const url = await billing.portalUrl(customerId)
    res.json({ ok: true, url })
  } catch (err) {
    if (err instanceof BillingError) return res.status(err.status).json({ error: err.message, code: err.code })
    console.error('[billing] portal error:', err)
    res.status(500).json({ error: 'Could not open billing portal' })
  }
})

/** Stripe webhook — raw body, no session. Mounted before express.json in index.js. */
export async function handleBillingWebhook(req, res) {
  if (req.method !== 'POST' || req.path !== '/api/billing/webhook') return false

  let billing
  try {
    billing = getBilling()
  } catch (err) {
    console.error('[billing] webhook with bad config:', err.message)
    res.status(500).json({ error: 'billing misconfigured' })
    return true
  }
  if (!billing) {
    res.status(503).json({ error: 'billing_not_configured' })
    return true
  }

  let raw
  try {
    raw = await readRawBody(req, WEBHOOK_MAX_BODY)
  } catch (err) {
    const status = err.tooLarge ? 413 : 400
    res.status(status).json({ error: err.message })
    return true
  }

  try {
    billing.verifySignature(raw, req.headers['stripe-signature'])
  } catch (err) {
    const status = err instanceof BillingError ? err.status : 400
    res.status(status).json({ error: err.message, code: err.code })
    return true
  }

  let event
  try {
    event = JSON.parse(raw.toString('utf8'))
  } catch {
    res.status(400).json({ error: 'invalid JSON' })
    return true
  }

  try {
    const result = await billing.handleWebhook(event)
    res.json({ ok: true, received: true, ...result })
  } catch (err) {
    console.error('[billing] webhook handler failed:', err)
    res.status(500).json({ error: 'webhook handler failed' })
  }
  return true
}

export { billingConfigured }
