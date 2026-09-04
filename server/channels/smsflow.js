// SMSFlow SMS API — send + inbound webhook token.
// No SDK: plain fetch + Bearer auth, matching twilio.js / google.js style.
// Docs: https://smsflow.com.au/api
//
// Column mapping on channel_accounts (no schema change):
//   account_sid  → sentinel 'smsflow' (SMSFlow has no username, only an API key)
//   auth_token   → SMSFlow API key, sealed at rest
//   phone_number → dedicated From number or Sender ID (optional)

import crypto from 'node:crypto'
import { toE164 } from './phone.js'
import { env } from '../env.js'
import { openSecret } from '../secrets.js'

export const SMSFLOW_SID = 'smsflow'
const API_BASE = 'https://api.smsflow.com.au/v2'
const SEND_URL = `${API_BASE}/sms/send`

export function smsflowConfigured(account) {
  if (account?.provider === 'sandbox') return true
  return Boolean(openSecret(account?.auth_token))
}

function bearer(account) {
  return openSecret(account.auth_token)
}

function pickMessageId(payload) {
  const data = payload?.data
  const items = Array.isArray(data)
    ? data
    : Array.isArray(data?.messages)
      ? data.messages
      : data && typeof data === 'object'
        ? [data]
        : []
  const first = items[0] || payload || {}
  const attrs = first.attributes && typeof first.attributes === 'object' ? first.attributes : {}
  return String(
    first.message_id || first.id || attrs.message_id || payload?.message_id || ''
  )
}

function pickStatus(payload) {
  const data = payload?.data
  const first = Array.isArray(data) ? data[0] : (data?.messages?.[0] || data || payload || {})
  return String(first.status || payload?.status || '').toLowerCase()
}

/**
 * Send an SMS via SMSFlow. Returns { providerMessageId, threadId, status }.
 * POST https://api.smsflow.com.au/v2/sms/send
 */
export async function smsflowSendSms(account, { to, body }) {
  const phone = toE164(to)
  if (!phone) throw new Error('SMS recipient is not a valid phone number')
  const text = String(body || '').trim()
  if (!text) throw new Error('SMS body is empty')
  if (text.length > 1600) throw new Error('SMS body exceeds 1600 characters')

  if (!smsflowConfigured(account)) {
    throw new Error('SMSFlow account is not fully configured')
  }

  const payload = {
    to: phone,
    body: text,
    reference: 'harry',
  }
  const from = String(account.phone_number || '').trim()
  if (from) payload.from = from

  const hook = smsflowWebhookUrl(account)
  if (hook) payload.callback_url = hook

  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer(account)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await res.json().catch(() => ({}))
  const messageId = pickMessageId(data)
  const status = pickStatus(data)
  const failed = /fail|error|reject|denied|insufficient/.test(status)
  if (!res.ok || failed || !messageId) {
    const detail = data?.error || data?.message || status || JSON.stringify(data).slice(0, 300)
    throw new Error(`SMSFlow send failed (${res.status}): ${detail}`)
  }
  return {
    providerMessageId: messageId,
    threadId: smsflowThreadId(account, phone),
    status: status || 'queued',
  }
}

export function smsflowThreadId(account, phoneE164) {
  return `sms:${account.id}:${toE164(phoneE164) || phoneE164}`
}

/**
 * SMSFlow has a single account-level Webhook URL (Developer Settings), not
 * one per number. The token is derived from the API key alone so every Harry
 * sender that shares that key advertises the same URL. Paste it once.
 */
export function smsflowWebhookTokenFromKey(apiKey) {
  const key = String(apiKey || '')
  if (!key) return ''
  return crypto.createHmac('sha256', key).update('smsflow-webhook').digest('hex').slice(0, 32)
}

export function smsflowWebhookToken(account) {
  return smsflowWebhookTokenFromKey(openSecret(account?.auth_token) || env.SMSFLOW_API_KEY)
}

export function smsflowWebhookUrl(account) {
  const token = account ? smsflowWebhookToken(account) : smsflowWebhookTokenFromKey(env.SMSFLOW_API_KEY)
  const base = String(env.APP_URL || '').replace(/\/$/, '')
  if (!base || !token) return ''
  return `${base}/api/hooks/smsflow/sms?token=${token}`
}

export function verifySmsflowToken(account, token) {
  const expected = smsflowWebhookToken(account)
  if (!expected || !token) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(String(token))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---- read-side API -------------------------------------------------------------

async function smsflowGet(account, path) {
  if (!smsflowConfigured(account) || account?.provider === 'sandbox') {
    throw new Error('SMSFlow account is not fully configured')
  }
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${bearer(account)}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = data?.error || data?.message || JSON.stringify(data).slice(0, 300)
    const err = new Error(`SMSFlow ${res.status}: ${detail}`)
    err.status = res.status
    throw err
  }
  return data
}

/**
 * SMSFlow's free-text delivery status ("Sent and confirmed from carrier",
 * "Failed", "Queued" …) folded into Harry's four-word vocabulary. Shared by
 * the status callback and the poll so both spell a delivery the same way.
 */
export function mapSmsflowStatus(raw) {
  const status = String(raw || '').toLowerCase()
  if (/fail|error|reject|expired|denied|undeliver|bounce/.test(status)) return 'failed'
  if (/deliver|confirm/.test(status)) return 'delivered'
  if (/sent|queued|pending|accepted|scheduled/.test(status)) return 'sent'
  return status.slice(0, 40)
}

/**
 * GET /sms/status/{message_id}. Delivery receipts come by webhook when SMSFlow
 * manages to POST one; this is the pull for when it does not.
 */
export async function smsflowMessageStatus(account, messageId) {
  const id = String(messageId || '').trim()
  if (!id) throw new Error('SMSFlow message id is empty')
  const data = await smsflowGet(account, `/sms/status/${encodeURIComponent(id)}`)
  const body = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data
  const raw = String(body?.status || '')
  return {
    status: raw,
    mapped: mapSmsflowStatus(raw),
    deliveryTime: String(body?.delivery_time || ''),
    creditsUsed: Number(body?.credits_used) || 0,
    destination: String(body?.destination || ''),
  }
}

/** GET /account/balance — pre-paid credits left on the key. */
export async function smsflowBalance(account) {
  const data = await smsflowGet(account, '/account/balance')
  const body = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data
  const credits = Number(body?.credit_balance ?? body?.credits ?? body?.balance)
  return {
    accountId: String(body?.account_id || ''),
    creditBalance: Number.isFinite(credits) ? credits : null,
    lastPurchaseDate: String(body?.last_purchase_date || ''),
  }
}
