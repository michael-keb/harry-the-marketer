// Twilio Messaging API — SMS send + inbound webhook signature check.
// No SDK: plain fetch + HMAC, matching google.js / microsoft.js style.

import crypto from 'node:crypto'
import { env } from '../env.js'
import { toE164 } from './phone.js'
import { openSecret } from '../secrets.js'

export function twilioConfigured(account) {
  if (account?.provider === 'sandbox') return true
  const token = openSecret(account?.auth_token)
  return Boolean(account?.account_sid && token && (account.phone_number || account.messaging_service_sid))
}

function basicAuth(account) {
  const token = openSecret(account.auth_token)
  return Buffer.from(`${account.account_sid}:${token}`).toString('base64')
}

/**
 * Send an SMS. Returns { providerMessageId, threadId, status }.
 * Sandbox accounts record locally without calling Twilio.
 */
export async function twilioSendSms(account, { to, body }) {
  const phone = toE164(to)
  if (!phone) throw new Error('SMS recipient is not a valid phone number')
  const text = String(body || '').trim()
  if (!text) throw new Error('SMS body is empty')
  if (text.length > 1600) throw new Error('SMS body exceeds 1600 characters')

  if (account.provider === 'sandbox') {
    return {
      providerMessageId: `sbx-sms-${crypto.randomBytes(6).toString('hex')}`,
      threadId: smsThreadId(account, phone),
      status: 'sent',
    }
  }

  if (!twilioConfigured(account)) {
    throw new Error('Twilio account is not fully configured')
  }

  const params = new URLSearchParams({ To: phone, Body: text })
  if (account.messaging_service_sid) {
    params.set('MessagingServiceSid', account.messaging_service_sid)
  } else {
    params.set('From', toE164(account.phone_number) || account.phone_number)
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${account.account_sid}/Messages.json`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(account)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
    signal: AbortSignal.timeout(30_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = data.message || data.error_message || JSON.stringify(data).slice(0, 300)
    throw new Error(`Twilio send failed (${res.status}): ${detail}`)
  }
  return {
    providerMessageId: data.sid || '',
    threadId: smsThreadId(account, phone),
    status: data.status || 'queued',
  }
}

export function smsThreadId(account, phoneE164) {
  return `sms:${account.id}:${toE164(phoneE164) || phoneE164}`
}

/**
 * Validate an inbound Twilio request signature.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function verifyTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false
  // Local / CI: allow unsigned when explicitly opted in (never in production).
  if (env.TWILIO_SKIP_SIGNATURE === '1' && env.NODE_ENV !== 'production') return true

  const sorted = Object.keys(params || {})
    .sort()
    .map((k) => `${k}${params[k] ?? ''}`)
    .join('')
  const data = `${url}${sorted}`
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)))
  } catch {
    return false
  }
}

/** STOP / HELP / START keyword handling (case-insensitive, whole message). */
export function smsKeyword(body) {
  const word = String(body || '').trim().toUpperCase().replace(/[^A-Z]/g, '')
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(word)) return 'stop'
  if (['START', 'YES', 'UNSTOP'].includes(word)) return 'start'
  if (['HELP', 'INFO'].includes(word)) return 'help'
  return null
}
