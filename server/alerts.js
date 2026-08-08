// Slack / Teams alerts.
//
// One field in Settings: paste a webhook URL. We work out which service it is
// from the URL and send the shape that service expects — there is nothing to
// choose and nothing to configure per event. Alerts never block or break a
// send: failures are recorded as telemetry and surface in Monitoring.
import { db } from './db.js'
import { env } from './env.js'
import { recordTelemetry } from './telemetry.js'

const TIMEOUT_MS = 5000

// Slack: hooks.slack.com. Teams: the Power Automate / connector hosts.
export function webhookKind(url) {
  const value = String(url || '')
  if (!/^https:\/\//i.test(value)) return null
  if (/hooks\.slack\.com/i.test(value)) return 'slack'
  if (/(webhook|outlook)\.office\.com|office365\.com|logic\.azure\.com|powerplatform|azure-api\.net/i.test(value)) return 'teams'
  return null
}

export function isSupportedWebhook(url) {
  return webhookKind(url) !== null
}

function payloadFor(kind, { title, text, link }) {
  const url = link ? `${env.APP_URL.replace(/\/$/, '')}${link}` : ''
  if (kind === 'teams') {
    // MessageCard is understood by both the classic connector and Power Automate.
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: title,
      themeColor: '17A583',
      title,
      text,
      ...(url ? { potentialAction: [{ '@type': 'OpenUri', name: 'Open in Harry', targets: [{ os: 'default', uri: url }] }] } : {}),
    }
  }
  return {
    text: `*${title}*\n${text}${url ? `\n<${url}|Open in Harry>` : ''}`,
  }
}

// Fire-and-forget: callers must never await a chat webhook on the send path.
export function notify(userId, { title, text = '', link = '' }) {
  let url = ''
  try {
    url = db.prepare('SELECT alert_webhook FROM users WHERE id = ?').get(userId)?.alert_webhook || ''
  } catch { /* alerts must never break the caller */ }
  const kind = webhookKind(url)
  if (!kind) return Promise.resolve(false)
  return post(url, kind, { title, text, link }).catch(() => false)
}

// Used by the "Send test" button, which does want to know whether it worked.
export async function post(url, kind, message) {
  const t0 = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadFor(kind, message)),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
    recordTelemetry('alert', { op: kind, ok: true, ms: Date.now() - t0 })
    return true
  } catch (err) {
    recordTelemetry('alert', { op: kind, ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
    throw err
  } finally {
    clearTimeout(timer)
  }
}
