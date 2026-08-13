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
const SEND_URL = 'https://api.smsflow.com.au/v2/sms/send'

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
