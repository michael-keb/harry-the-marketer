#!/usr/bin/env node
/**
 * Production smoke test — run against a deployed Harry instance.
 *
 *   BASE=https://harrythemarketer.com npm run smoke:prod
 *
 * Checks health, legal pages, auth config, and (optionally) sandbox approval path.
 * Does not require credentials unless SMOKE_DEV_LOGIN=1 (staging only).
 */

const BASE = (process.env.BASE || process.env.APP_URL || 'http://localhost:8131').replace(/\/+$/, '')
const STRICT = process.env.SMOKE_STRICT === '1' || process.env.SMOKE_STRICT === 'true'
const ALLOW_DEV = process.env.SMOKE_DEV_LOGIN === '1'

let pass = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
    return true
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text.slice(0, 200) } }
  return { status: res.status, body, headers: res.headers }
}

async function post(path, body, cookie = '') {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text.slice(0, 200) } }
  const setCookie = res.headers.getSetCookie?.() || []
  let session = cookie
  for (const c of setCookie) if (c.startsWith('htm_session')) session = c.split(';')[0]
  return { status: res.status, body: parsed, cookie: session }
}

console.log(`\nHarry production smoke — ${BASE}\n`)

// ---- public surface ---------------------------------------------------------
console.log('Public surface')
{
  const health = await get('/api/health')
  check('GET /api/health → 200', health.status === 200, `got ${health.status}`)
  check('health.ok === true', health.body?.ok === true)
  if (STRICT) {
    check('Auth0 configured', health.body?.auth0 === true)
    check('dev login disabled', health.body?.devLogin === false)
    check('APP_URL is public', !String(health.body?.appUrl || '').includes('localhost'))
    check('DATA_DIR set', health.body?.dataDir === true)
  }
}

for (const path of ['/privacy', '/terms', '/acceptable-use']) {
  const r = await get(path)
  check(`GET ${path} → 200`, r.status === 200, `got ${r.status}`)
  if (r.status === 200) {
    check(`${path} mentions operator or Harry`, /Harry|Marketer|Privacy|Terms|policy/i.test(String(r.body?.raw || '')))
  }
}

{
  const plans = await get('/api/public/plans')
  check('GET /api/public/plans → 200', plans.status === 200)
  check('plans array present', Array.isArray(plans.body?.plans) && plans.body.plans.length >= 1)
}

{
  const auth = await get('/api/auth/config')
  check('GET /api/auth/config → 200', auth.status === 200)
  if (STRICT) check('auth0 enabled in production', auth.body?.auth0 === true)
}

{
  const billing = await get('/api/billing/config')
  check('GET /api/billing/config → 200', billing.status === 200)
}

// ---- optional authenticated sandbox path ------------------------------------
if (ALLOW_DEV) {
  console.log('\nAuthenticated path (dev login — staging only)')
  let cookie = ''
  {
    const login = await post('/api/auth/dev-login', { email: `smoke-${Date.now()}@e2e.test`, name: 'Smoke' })
    check('dev login succeeds', login.status === 200, `got ${login.status}`)
    cookie = login.cookie
  }
  if (cookie) {
    const meGet = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })
    check('session resolves /api/auth/me', meGet.status === 200, `got ${meGet.status}`)
  }
} else {
  console.log('\nSkipping authenticated path (set SMOKE_DEV_LOGIN=1 on staging to enable)')
}

// ---- summary ----------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  • ${f}`)
  process.exit(1)
}
console.log('\nSmoke test green.\n')
