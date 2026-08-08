// Env-gated provider adapters for the three categories that cannot work from
// Harry's own data: inbox-placement testing, prospect discovery, and sending-
// infrastructure procurement.
//
// This follows the pattern server/google.js already sets: credentials come from
// the environment, nothing is faked, and an unconfigured provider degrades to an
// honest answer rather than an error page. Every route that depends on one of
// these still exists, still validates, still reads and writes Harry's own rows —
// it just reports `configured: false` and serves what it has stored.
//
// Each adapter isolates its request contract in one place on purpose. Six
// smart-delivery endpoints publish their request body as `{}` and three
// disagree with themselves on HTTP method across their own samples, so a
// correction to any of them is a single-file change (Docs/README.md).

import { recordTelemetry } from '../telemetry.js'

const RETRYABLE = new Set([429, 500, 502, 503, 504])

export const providers = {
  deliverability: {
    name: 'deliverability',
    baseUrl: process.env.DELIVERABILITY_API_URL || '',
    apiKey: process.env.DELIVERABILITY_API_KEY || '',
  },
  prospects: {
    name: 'prospects',
    baseUrl: process.env.PROSPECT_API_URL || '',
    apiKey: process.env.PROSPECT_API_KEY || '',
  },
  senders: {
    name: 'senders',
    baseUrl: process.env.SENDERS_API_URL || '',
    apiKey: process.env.SENDERS_API_KEY || '',
  },
}

export function configured(which) {
  const p = providers[which]
  return Boolean(p && p.baseUrl && p.apiKey)
}

// What the UI is told when a provider has no credentials. The surface renders,
// the stored rows show, and the banner says what is missing and why.
export function unconfigured(which, envVars = []) {
  const vars = envVars.length ? envVars : (providerStatus()[which]?.envVars ?? [])
  return {
    configured: false,
    provider: which,
    // Both names on purpose: `envVars` is what the shared NotConnected banner
    // reads, `missingEnv` is what the deliverability module already returned.
    // Returning only the message would make every caller re-derive the list.
    envVars: vars,
    missingEnv: vars,
    message: `No ${which} provider is connected. Set ${vars.join(' and ')} to enable live data.`,
  }
}

// One call, with bounded exponential backoff and jitter on the statuses the
// specs name. Jitter is derived from the attempt rather than Math.random so a
// retry schedule is reproducible in tests — the same rule server/pacing.js
// applies to send timing.
export async function call(which, path, { method = 'GET', body = null, retries = 3, timeoutMs = 15000 } = {}) {
  const p = providers[which]
  if (!configured(which)) {
    const err = new Error(`${which} provider is not configured`)
    err.code = 'not_configured'
    throw err
  }

  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const base = Math.min(2000 * 2 ** (attempt - 1), 8000)
      const jitter = ((attempt * 2654435761) % 500)
      await new Promise((r) => setTimeout(r, base + jitter))
    }

    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(new URL(path, p.baseUrl), {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${p.apiKey}`,
        },
        body: body === null ? undefined : JSON.stringify(body),
      })
      const ms = Date.now() - started

      if (RETRYABLE.has(res.status) && attempt < retries) {
        recordTelemetry('provider', { op: `${which} ${method} ${path}`, ok: false, ms, detail: `retrying ${res.status}` })
        lastError = new Error(`${which} responded ${res.status}`)
        lastError.status = res.status
        continue
      }

      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }

      recordTelemetry('provider', { op: `${which} ${method} ${path}`, ok: res.ok, ms, detail: res.ok ? '' : `status ${res.status}` })

      if (!res.ok) {
        // Errors are keyed on status code, never on message text: one prospect
        // endpoint says "API key is required" where every other says "User not
        // authenticated" for the same 401.
        const err = new Error(`${which} responded ${res.status}`)
        err.status = res.status
        err.payload = json
        throw err
      }
      return json
    } catch (err) {
      clearTimeout(timer)
      if (err.name === 'AbortError') {
        lastError = new Error(`${which} timed out after ${timeoutMs}ms`)
        lastError.code = 'timeout'
        if (attempt < retries) continue
        throw lastError
      }
      if (err.status && !RETRYABLE.has(err.status)) throw err
      lastError = err
      if (attempt >= retries) throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError || new Error(`${which} call failed`)
}

// Reconciliation throttle: stored rows are served immediately and refreshed at
// most once per window per workspace, so a page load never waits on an upstream
// round trip and a busy workspace cannot stampede the provider.
const lastReconciled = new Map()

export function shouldReconcile(which, wsId, windowMs = 60_000) {
  const key = `${which}:${wsId}`
  const last = lastReconciled.get(key) || 0
  const now = Date.now()
  if (now - last < windowMs) return false
  lastReconciled.set(key, now)
  return true
}

export function providerStatus() {
  return {
    deliverability: { configured: configured('deliverability'), envVars: ['DELIVERABILITY_API_URL', 'DELIVERABILITY_API_KEY'] },
    prospects: { configured: configured('prospects'), envVars: ['PROSPECT_API_URL', 'PROSPECT_API_KEY'] },
    senders: { configured: configured('senders'), envVars: ['SENDERS_API_URL', 'SENDERS_API_KEY'] },
  }
}
