#!/usr/bin/env node
/**
 * Create Harry promo codes in Stripe (test or live, depending on STRIPE_SECRET_KEY).
 *
 *   node scripts/stripe-promo-codes.mjs
 *   node scripts/stripe-promo-codes.mjs --dry-run
 *
 * Codes:
 *   Squadinstitlute — 10% off forever
 *   BISM1           — 100% off forever
 *   HARRYFREE       — 100% off forever (legacy / general free access)
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

function loadEnv() {
  try {
    const text = readFileSync(resolve(root, '.env'), 'utf8')
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch { /* no .env */ }
}

loadEnv()

const STRIPE_API = 'https://api.stripe.com/v1'
const dryRun = process.argv.includes('--dry-run')

const PROMOS = [
  { code: 'Squadinstitlute', percentOff: 10, name: 'Squad Institute 10% off' },
  { code: 'BISM1', percentOff: 100, name: 'BISM1 — full discount' },
  { code: 'HARRYFREE', percentOff: 100, name: 'Harry free access' },
]

function form(params) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    body.append(k, String(v))
  }
  return body
}

async function stripe(secretKey, method, path, params) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params ? form(params) : undefined,
  })
  const json = await res.json()
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText
    throw new Error(`${method} ${path}: ${msg}`)
  }
  return json
}

async function findPromoCode(secretKey, code) {
  const list = await stripe(secretKey, 'GET', `/promotion_codes?code=${encodeURIComponent(code)}&limit=1`)
  return list.data?.[0] || null
}

async function findCouponByName(secretKey, name) {
  const list = await stripe(secretKey, 'GET', '/coupons?limit=100')
  return list.data?.find((c) => c.name === name && c.valid) || null
}

async function ensurePromo(secretKey, { code, percentOff, name }) {
  const existing = await findPromoCode(secretKey, code)
  if (existing?.active) {
    console.log(`✓ ${code} already exists (${existing.id})`)
    return existing
  }

  if (dryRun) {
    console.log(`[dry-run] would create ${code} — ${percentOff}% off`)
    return null
  }

  let coupon = await findCouponByName(secretKey, name)
  if (!coupon) {
    coupon = await stripe(secretKey, 'POST', '/coupons', {
      name,
      percent_off: percentOff,
      duration: 'forever',
    })
    console.log(`  created coupon ${coupon.id} (${percentOff}% off)`)
  }

  const promo = await stripe(secretKey, 'POST', '/promotion_codes', {
    'promotion[type]': 'coupon',
    'promotion[coupon]': coupon.id,
    code,
    active: true,
  })
  console.log(`✓ created ${code} → ${promo.id}`)
  return promo
}

async function ensurePaymentLinksAllowPromos(secretKey) {
  const linkEnvKeys = [
    'STRIPE_PAYMENT_LINK_STARTER',
    'STRIPE_PAYMENT_LINK_GROWTH',
    'STRIPE_PAYMENT_LINK_SCALE',
  ]
  const urls = linkEnvKeys.map((k) => process.env[k]?.trim()).filter(Boolean)
  if (!urls.length) {
    console.log('— no STRIPE_PAYMENT_LINK_* in env; skip Payment Link check')
    return
  }

  const list = await stripe(secretKey, 'GET', '/payment_links?limit=100&active=true')
  for (const url of urls) {
    const slug = url.split('/').pop()
    const link = list.data?.find((l) => l.url === url || l.url?.endsWith(slug) || l.id === slug)
    if (!link) {
      console.warn(`⚠ could not find Payment Link for ${url} — enable promo codes in Stripe Dashboard manually`)
      continue
    }
    if (link.allow_promotion_codes) {
      console.log(`✓ Payment Link ${link.id} already allows promotion codes`)
      continue
    }
    if (dryRun) {
      console.log(`[dry-run] would enable promotion codes on ${link.id}`)
      continue
    }
    await stripe(secretKey, 'POST', `/payment_links/${link.id}`, { allow_promotion_codes: true })
    console.log(`✓ enabled promotion codes on Payment Link ${link.id}`)
  }
}

async function main() {
  const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim()
  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY is not set — add it to .env first')
    process.exit(1)
  }
  const mode = /^sk_live_/.test(secretKey) ? 'LIVE' : 'TEST'
  console.log(`Stripe ${mode} — ${dryRun ? 'dry run' : 'creating promo codes'}…\n`)

  for (const promo of PROMOS) {
    await ensurePromo(secretKey, promo)
  }

  console.log('')
  await ensurePaymentLinksAllowPromos(secretKey)

  console.log('\nDone. Customers enter codes on Stripe Checkout after clicking Subscribe.')
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
