import { createHmac, timingSafeEqual } from 'node:crypto'
import { db, logEvent } from './db.js'
import { env } from './env.js'

/**
 * Stripe billing via hosted Payment Links — dependency-free, same discipline as
 * wireform/server/billing.js. Harry never handles card numbers; Stripe does.
 *
 * Flow: signed-in user opens a Payment Link (prefilled email) → webhook marks
 * their workspace as paid → they keep using Harry on the plan they bought.
 */

const STRIPE_API = 'https://api.stripe.com/v1'
const SIGNATURE_TOLERANCE_SECONDS = 300

export class BillingError extends Error {
  constructor(status, message, { code = 'billing' } = {}) {
    super(message)
    this.name = 'BillingError'
    this.status = status
    this.code = code
  }
}

const PLAN_LINK_KEYS = {
  starter: 'STRIPE_PAYMENT_LINK_STARTER',
  growth: 'STRIPE_PAYMENT_LINK_GROWTH',
  scale: 'STRIPE_PAYMENT_LINK_SCALE',
}

/** Read Stripe config. Unconfigured is a supported state (local dev, trial). */
export function readBillingConfig(processEnv = process.env) {
  const secretKey = (processEnv.STRIPE_SECRET_KEY || '').trim()
  const webhookSecret = (processEnv.STRIPE_WEBHOOK_SECRET || '').trim()
  const publicUrl = (processEnv.APP_URL || '').trim().replace(/\/+$/, '')

  const links = {}
  for (const [planId, envKey] of Object.entries(PLAN_LINK_KEYS)) {
    const url = (processEnv[envKey] || '').trim()
    if (url) links[planId] = url
  }

  if (!secretKey && !webhookSecret && Object.keys(links).length === 0) {
    return { configured: false, reason: 'Stripe is not configured — billing routes stay disabled' }
  }

  const missing = []
  if (!secretKey) missing.push('STRIPE_SECRET_KEY')
  if (!webhookSecret) missing.push('STRIPE_WEBHOOK_SECRET')
  if (!publicUrl) missing.push('APP_URL')
  if (!Object.keys(links).length) missing.push('STRIPE_PAYMENT_LINK_* (at least one plan link)')
  if (missing.length) {
    throw new BillingError(
      500,
      `Stripe is partly configured — missing ${missing.join(', ')}. Set all of them, or none to disable billing.`,
      { code: 'half_configured' }
    )
  }

  let parsed
  try {
    parsed = new URL(publicUrl)
  } catch {
    parsed = null
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new BillingError(500, 'APP_URL must be an absolute http(s) URL for billing return addresses', {
      code: 'bad_public_url',
    })
  }

  const live = !/^(sk|rk|rkcs)_test_/.test(secretKey)
  if (live && parsed.protocol !== 'https:') {
    throw new BillingError(
      500,
      'A LIVE Stripe key is set but APP_URL is not https — refusing to take real payments over an insecure return URL',
      { code: 'insecure_live' }
    )
  }

  return { configured: true, secretKey, webhookSecret, publicUrl, links, live }
}

function form(params) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    body.append(k, String(v))
  }
  return body
}

async function stripeRequest(config, method, path, params) {
  let response
  try {
    response = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params ? form(params) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    console.error(`[billing] Stripe ${method} ${path} unreachable (${err?.name ?? 'network error'})`)
    throw new BillingError(502, 'Stripe could not be reached — try again in a moment', { code: 'stripe_unreachable' })
  }

  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new BillingError(502, 'Stripe returned a response that was not JSON')
  }

  if (!response.ok) {
    const detail = json?.error?.message ?? 'no message'
    console.error(`[billing] Stripe ${method} ${path} -> ${response.status}:`, detail)
    throw new BillingError(response.status === 429 ? 429 : 502, `Stripe refused the request (${json?.error?.type ?? response.status})`, {
      code: json?.error?.code ?? 'stripe_error',
    })
  }
  return json
}

/** Map a checkout session back to one of our plan ids. */
function planFromSession(session, config) {
  const meta = session?.metadata?.plan_id || session?.metadata?.plan
  if (meta && (config.links[meta] || meta === 'starter' || meta === 'growth' || meta === 'scale')) {
    return meta
  }
  const link = session?.payment_link
  const linkId = typeof link === 'string' ? link : link?.id
  if (linkId) {
    for (const [planId, url] of Object.entries(config.links)) {
      if (url.includes(linkId) || linkId.endsWith(url.split('/').pop())) return planId
    }
  }
  // Default to starter when only one link exists.
  const ids = Object.keys(config.links)
  return ids.length === 1 ? ids[0] : null
}

export function applyBilling(userId, { planId, customerId = '', status = 'active', detail = '' }) {
  db.prepare(
    `UPDATE users SET plan_id = ?, billing_status = ?, stripe_customer_id = COALESCE(?, stripe_customer_id),
                      billing_updated_at = datetime('now') WHERE id = ?`
  ).run(planId || '', status, customerId || null, userId)
  logEvent(userId, { type: 'billing_updated', detail: detail || `${status}${planId ? ` · ${planId}` : ''}` })
}

export function billingStatus(user) {
  return {
    configured: billingConfigured(),
    planId: user.plan_id || null,
    status: user.billing_status || 'trial',
    stripeCustomerId: user.stripe_customer_id || null,
    updatedAt: user.billing_updated_at || null,
  }
}

let cachedConfig = null

export function resetBillingCache() {
  cachedConfig = null
}

export function billingConfigured() {
  try {
    cachedConfig = readBillingConfig()
    return cachedConfig.configured
  } catch {
    return false
  }
}

export function getBilling() {
  if (!cachedConfig?.configured) {
    try {
      cachedConfig = readBillingConfig()
    } catch (err) {
      if (err instanceof BillingError) throw err
      throw new BillingError(500, 'billing configuration error')
    }
  }
  if (!cachedConfig.configured) return null

  const config = cachedConfig

  return {
    config,

    /** Payment Link URL with prefilled email for a signed-in user. */
    checkoutUrl(planId, email) {
      const base = config.links[planId]
      if (!base) throw new BillingError(400, `Unknown plan "${planId}"`, { code: 'unknown_plan' })
      const url = new URL(base)
      if (email) url.searchParams.set('prefilled_email', email)
      return url.toString()
    },

    /**
     * Stripe Customer Portal — one hosted page to update card, invoices, cancel.
     * Requires the user already have a stripe_customer_id (after first checkout).
     */
    async portalUrl(customerId, returnUrl) {
      if (!customerId) {
        throw new BillingError(400, 'No Stripe customer on this account yet — subscribe first', {
          code: 'no_customer',
        })
      }
      const session = await stripeRequest(config, 'POST', '/billing_portal/sessions', {
        customer: customerId,
        return_url: returnUrl || `${config.publicUrl}/app/settings/billing`,
      })
      if (!session?.url) throw new BillingError(502, 'Stripe did not return a portal URL')
      return session.url
    },

    verifySignature(rawBody, signatureHeader, { now = Date.now() } = {}) {
      const header = String(signatureHeader ?? '')
      let timestamp = null
      const candidates = []
      for (const part of header.split(',')) {
        const i = part.indexOf('=')
        if (i === -1) continue
        const key = part.slice(0, i).trim()
        const value = part.slice(i + 1).trim()
        if (key === 't' && timestamp === null) timestamp = value
        else if (key === 'v1') candidates.push(value)
      }
      if (!timestamp || candidates.length === 0) {
        throw new BillingError(400, 'malformed stripe-signature header', { code: 'bad_signature' })
      }

      const age = Math.abs(Math.floor(now / 1000) - Number(timestamp))
      if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
        throw new BillingError(400, 'stripe-signature timestamp is outside the tolerance', { code: 'stale_signature' })
      }

      const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')
      const mac = createHmac('sha256', config.webhookSecret)
      mac.update(`${timestamp}.`, 'utf8')
      mac.update(payload)
      const expected = Buffer.from(mac.digest('hex'), 'utf8')

      let matched = false
      for (const candidate of candidates) {
        const given = Buffer.from(candidate, 'utf8')
        if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true
      }
      if (!matched) {
        throw new BillingError(400, 'stripe-signature did not verify', { code: 'bad_signature' })
      }
      return true
    },

    async handleWebhook(event) {
      const type = event?.type
      const object = event?.data?.object ?? {}

      if (type === 'checkout.session.completed') {
        const email = (
          object.customer_details?.email ||
          object.customer_email ||
          object.metadata?.email ||
          ''
        ).trim().toLowerCase()
        if (!email) {
          console.warn('[billing] checkout.session.completed with no customer email — skipping')
          return { handled: false, reason: 'no_email' }
        }

        let planId = planFromSession(object, config)
        if (!planId && object.id) {
          try {
            const session = await stripeRequest(config, 'GET', `/checkout/sessions/${object.id}`)
            planId = planFromSession(session, config)
          } catch (err) {
            console.warn('[billing] could not retrieve session for plan mapping:', err.message)
          }
        }

        const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? ORDER BY id LIMIT 1').get(email)
        if (!user) {
          console.warn(`[billing] payment from ${email} — no matching user yet (sign up first, then pay)`)
          return { handled: false, reason: 'no_user', email }
        }

        const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id || ''
        applyBilling(user.id, {
          planId: planId || 'starter',
          customerId,
          status: 'active',
          detail: `Stripe checkout completed · ${planId || 'starter'}`,
        })
        return { handled: true, userId: user.id, planId: planId || 'starter' }
      }

      if (type === 'customer.subscription.deleted') {
        const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id
        if (customerId) {
          const user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId)
          if (user) {
            applyBilling(user.id, { planId: user.plan_id, status: 'canceled', detail: 'Stripe subscription canceled' })
            return { handled: true, userId: user.id }
          }
        }
      }

      return { handled: false, reason: 'ignored', type }
    },
  }
}
