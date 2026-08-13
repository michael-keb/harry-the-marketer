// Public SMS webhooks — inbound SMS + status callbacks.
// Mounted outside the session API so providers can POST without Auth0.
//
// Twilio signs its requests (HMAC header); SMSFlow does not, so its webhook
// URL carries a token derived from the account's API key instead.

import express from 'express'
import { db, logEvent } from '../db.js'
import { env, twilioEnvConfigured, smsflowEnvConfigured } from '../env.js'
import { unsubscribeLead } from '../suppression.js'
import { toE164, samePhone } from './phone.js'
import { verifyTwilioSignature, smsKeyword, smsThreadId } from './twilio.js'
import { smsflowSendSms, verifySmsflowToken } from './smsflow.js'
import { ensureEnvSmsAccount } from './send.js'
import { openSecret } from '../secrets.js'

export const twilioRouter = express.Router()
export const smsflowRouter = express.Router()

function twilioXml(message) {
  if (!message) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
  const escaped = String(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`
}

function findAccountByTo(toRaw, provider) {
  const to = toE164(toRaw) || String(toRaw || '').trim()
  if (!to) return null
  const rows = db.prepare(
    `SELECT * FROM channel_accounts
      WHERE channel = 'sms' AND COALESCE(deleted_at, '') = '' AND status = 'connected'`
  ).all()
  // Sandbox accounts answer for either provider — they exist for local drills.
  const hit = rows.find((a) => (a.provider === provider || a.provider === 'sandbox') && samePhone(a.phone_number, to))
  if (hit) return hit
  // .env number with no Settings row yet — attach only to the workspace that
  // already holds these credentials. There used to be a fallback to "the
  // first workspace", which meant an inbound STOP on a number nobody had
  // claimed was written into an arbitrary tenant's inbox and block list. An
  // unattributable message is dropped (the provider gets a 404 and retries)
  // rather than filed under whoever happens to be user id 1.
  if (provider === 'twilio' && twilioEnvConfigured() && samePhone(env.TWILIO_FROM_NUMBER, to)) {
    const known = rows.find((a) => a.account_sid === env.TWILIO_ACCOUNT_SID)
    if (known) return ensureEnvSmsAccount(known.workspace_id)
    console.warn('[sms] inbound on env Twilio number but no workspace holds the Account SID — dropped')
  }
  if (provider === 'smsflow' && smsflowEnvConfigured() && env.SMSFLOW_FROM_NUMBER && samePhone(env.SMSFLOW_FROM_NUMBER, to)) {
    const known = rows.find((a) => a.provider === 'smsflow')
    if (known) return ensureEnvSmsAccount(known.workspace_id)
    console.warn('[sms] inbound on env SMSFlow number but no workspace holds the account — dropped')
  }
  return null
}

function findAccountsBySmsflowToken(token) {
  if (!token) return []
  const rows = db.prepare(
    `SELECT * FROM channel_accounts
      WHERE channel = 'sms' AND COALESCE(deleted_at, '') = '' AND status = 'connected'`
  ).all()
  return rows.filter((a) => (a.provider === 'smsflow' || a.provider === 'sandbox') && verifySmsflowToken(a, token))
}

function pickSmsflowAccount(matches, to) {
  if (!matches.length) return null
  if (matches.length === 1) return matches[0]
  if (to) {
    const byPhone = matches.find((a) => samePhone(a.phone_number, to) || String(a.phone_number || '') === to)
    if (byPhone) return byPhone
  }
  return matches[0]
}

function flattenSmsflowBody(raw) {
  const params = raw && typeof raw === 'object' ? raw : {}
  const nested = params.data && typeof params.data === 'object' && !Array.isArray(params.data)
    ? params.data
    : {}
  const attrs = [params.attributes, nested.attributes].find((v) => v && typeof v === 'object' && !Array.isArray(v)) || {}
  const pick = (...keys) => {
    for (const source of [params, nested, attrs]) {
      for (const key of keys) {
        const value = source?.[key]
        if (value != null && value !== '') return value
      }
    }
    return ''
  }
  return { pick }
}

function looksLikeStatus({ pick, from, body }) {
  const type = String(pick('type', 'event', 'event_type', 'kind')).toLowerCase()
  if (/inbound|reply|mo|receive|received/.test(type)) return false
  if (/status|delivery|dlr/.test(type)) return true
  const status = String(pick('status')).toLowerCase()
  if (status && !from && !body) return true
  if (status && /delivered|sent|failed|queued|expired|rejected|confirmed/.test(status) && !body) return true
  return false
}

function applySmsStatus(sid, status, accountIds = []) {
  if (!sid) return
  const mapped = /fail|error|reject|expired|denied/.test(status) ? 'failed'
    : /deliver|confirm/.test(status) ? 'delivered'
      : /sent|queued/.test(status) ? 'sent'
        : String(status || '').slice(0, 40)
  if (accountIds.length) {
    db.prepare(
      `UPDATE messages SET send_status = ?
        WHERE provider_message_id = ? AND channel = 'sms'
          AND channel_account_id IN (${accountIds.map(() => '?').join(',')})`
    ).run(mapped, sid, ...accountIds)
    return
  }
  db.prepare(
    `UPDATE messages SET send_status = ? WHERE provider_message_id = ? AND channel = 'sms'`
  ).run(mapped, sid)
}

// Every account that could own this From number, not just the first: the
// caller disambiguates (SMSFlow does it by webhook token).
function candidateAccountsByTo(toRaw, provider) {
  const to = toE164(toRaw) || String(toRaw || '').trim()
  if (!to) return []
  const rows = db.prepare(
    `SELECT * FROM channel_accounts
      WHERE channel = 'sms' AND COALESCE(deleted_at, '') = '' AND status = 'connected'`
  ).all()
  return rows.filter((a) => (a.provider === provider || a.provider === 'sandbox') && samePhone(a.phone_number, to))
}

function publicWebhookUrl(req) {
  // Prefer configured APP_URL so signature validation matches what Twilio signed.
  const base = String(env.APP_URL || '').replace(/\/$/, '')
  if (base) return `${base}${req.originalUrl.split('?')[0]}`
  return `${req.protocol}://${req.get('host')}${req.originalUrl.split('?')[0]}`
}

/**
 * Provider-neutral inbound SMS handling: STOP/START/HELP keywords, lead match,
 * conversation attach, message insert. Returns { duplicate, replyText }.
 */
function processInboundSms({ account, from, to, body, sid, actor }) {
  if (sid && db.prepare('SELECT 1 FROM messages WHERE provider_message_id = ?').get(sid)) {
    return { duplicate: true, replyText: '' }
  }

  const keyword = smsKeyword(body)
  const lead = from
    ? db.prepare(
      `SELECT * FROM leads WHERE user_id = ? AND (
         phone = ? OR phone = ? OR replace(replace(replace(phone,' ',''),'-',''),'(','') LIKE ?
       ) ORDER BY id DESC LIMIT 1`
    ).get(account.workspace_id, from, from.replace(/^\+/, ''), `%${from.replace(/\D/g, '').slice(-9)}`)
    : null

  // Prefer matching by phone via E.164 equality in JS when SQL is fuzzy.
  let matched = lead
  if (!matched && from) {
    const candidates = db.prepare('SELECT * FROM leads WHERE user_id = ? AND COALESCE(phone,\'\') != \'\'').all(account.workspace_id)
    matched = candidates.find((l) => samePhone(l.phone, from)) || null
  }

  let replyText = ''
  if (keyword === 'stop') {
    if (matched) {
      unsubscribeLead(account.workspace_id, matched.id, { source: 'sms_stop', actor })
      db.prepare(
        "UPDATE leads SET sms_opt_out_at = datetime('now'), sms_opt_in_at = '', sms_opt_in_source = '' WHERE id = ?"
      ).run(matched.id)
    }
    const phoneKey = from.toLowerCase()
    db.prepare(
      `INSERT OR IGNORE INTO blocked_domains (workspace_id, value, is_domain, source, created_by)
       VALUES (?, ?, 0, 'sms_stop', ?)`
    ).run(account.workspace_id, phoneKey, actor)
    replyText = 'You are unsubscribed from SMS. Reply START to re-subscribe.'
  } else if (keyword === 'start' && matched) {
    db.prepare(
      "UPDATE leads SET sms_opt_in_at = datetime('now'), sms_opt_in_source = 'sms_start', sms_opt_out_at = '', status = CASE WHEN status = 'unsubscribed' THEN 'active' ELSE status END WHERE id = ?"
    ).run(matched.id)
    db.prepare('DELETE FROM blocked_domains WHERE workspace_id = ? AND value = ? AND source = ?')
      .run(account.workspace_id, from.toLowerCase(), 'sms_stop')
    replyText = 'You are re-subscribed to SMS.'
  } else if (keyword === 'help') {
    replyText = 'Harry SMS. Reply STOP to opt out.'
  }

  // Attach to an open campaign conversation when we can; otherwise leave an
  // untracked-style inbound message (campaign_id null) for the inbox.
  let campaignId = null
  let leadId = matched?.id || null
  let threadId = smsThreadId(account, from)
  if (matched) {
    const cl = db.prepare(
      `SELECT cl.* FROM campaign_leads cl
         JOIN campaigns c ON c.id = cl.campaign_id
        WHERE cl.lead_id = ? AND c.user_id = ?
          AND COALESCE(cl.completed_at, '') = ''
          AND cl.state IN ('waiting','active','queued')
        ORDER BY cl.id DESC LIMIT 1`
    ).get(matched.id, account.workspace_id)
    if (cl) {
      campaignId = cl.campaign_id
      threadId = cl.thread_id || threadId
      if (!cl.thread_id) {
        db.prepare('UPDATE campaign_leads SET thread_id = ?, last_reply_at = datetime(\'now\') WHERE id = ?')
          .run(threadId, cl.id)
      } else {
        db.prepare("UPDATE campaign_leads SET last_reply_at = datetime('now') WHERE id = ?").run(cl.id)
      }
    }
  }

  db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, mailbox_id, channel_account_id, channel, direction,
        subject, body, from_email, to_email, provider_message_id, thread_id, intent, is_read, send_status)
     VALUES (?, ?, ?, NULL, ?, 'sms', 'in', '', ?, ?, ?, ?, ?, '', 0, '')`
  ).run(
    account.workspace_id, campaignId, leadId, account.id,
    String(body || '').slice(0, 1600), from, to || account.phone_number, sid, threadId
  )

  db.prepare("UPDATE channel_accounts SET last_sync_at = datetime('now') WHERE id = ?").run(account.id)
  if (matched && keyword !== 'stop') {
    logEvent(account.workspace_id, {
      campaignId, leadId: matched.id, type: 'reply',
      detail: `sms: ${String(body || '').slice(0, 120)}`,
    })
  }

  return { duplicate: false, replyText }
}

// Inbound SMS. Twilio form-encodes the body.
twilioRouter.post('/sms', express.urlencoded({ extended: false }), (req, res) => {
  const params = req.body || {}
  const from = toE164(params.From) || String(params.From || '').trim()
  const to = toE164(params.To) || String(params.To || '').trim()
  const body = String(params.Body || '')
  const sid = String(params.MessageSid || params.SmsSid || '')

  const account = findAccountByTo(to, 'twilio')
  if (!account) {
    res.type('text/xml').status(404).send(twilioXml())
    return
  }

  const signature = req.get('X-Twilio-Signature') || ''
  const ok = verifyTwilioSignature({
    authToken: openSecret(account.auth_token),
    url: publicWebhookUrl(req),
    params,
    signature,
  })
  if (!ok) {
    res.status(403).type('text/plain').send('Invalid signature')
    return
  }

  const { replyText } = processInboundSms({ account, from, to, body, sid, actor: 'twilio' })
  res.type('text/xml').send(twilioXml(replyText))
})

// Inbound SMS + delivery receipts. SMSFlow POSTs JSON (or form) with no
// signature — the token in the webhook URL is the authentication. Paste the
// URL from Connections into SMSFlow Developer Settings → Webhook URL.
smsflowRouter.post(
  '/sms',
  express.urlencoded({ extended: false }),
  express.json(),
  (req, res) => {
    const { pick } = flattenSmsflowBody(req.body || {})
    const fromRaw = pick('from', 'sender', 'source', 'sourceAddress', 'originator', 'number')
    const toRaw = pick('to', 'destination', 'destinationAddress')
    const from = toE164(fromRaw) || String(fromRaw || '').trim()
    const to = toE164(toRaw) || String(toRaw || '').trim()
    const body = String(pick('body', 'message', 'messageContent', 'replyContent', 'moContent') || '')
    const sid = String(pick('message_id', 'id', 'original_message_id', 'original_messageId') || '')

    // One SMSFlow webhook URL for the whole account. The token authenticates
    // the API key; if several Harry senders share that key, `to` picks which.
    const matches = findAccountsBySmsflowToken(req.query.token)
    const fallback = candidateAccountsByTo(to, 'smsflow').find((a) => verifySmsflowToken(a, req.query.token))
    const candidates = fallback && !matches.some((a) => a.id === fallback.id)
      ? [...matches, fallback]
      : matches
    if (!candidates.length) {
      res.status(403).json({ error: 'invalid_token' })
      return
    }

    if (looksLikeStatus({ pick, from, body })) {
      applySmsStatus(sid, String(pick('status') || '').toLowerCase(), candidates.map((a) => a.id))
      res.json({ ok: true })
      return
    }

    const account = pickSmsflowAccount(candidates, to)

    if (!from && !body) {
      res.status(400).json({ error: 'missing_message' })
      return
    }

    const { replyText } = processInboundSms({
      account, from, to: to || account.phone_number, body, sid, actor: 'smsflow',
    })

    // SMSFlow has no TwiML equivalent — a keyword confirmation goes back out
    // through the send API, best-effort: the opt-out is already recorded, and a
    // failed courtesy reply must not make SMSFlow retry (and re-process) the
    // inbound message.
    if (replyText && from) {
      smsflowSendSms(account, { to: from, body: replyText }).catch((err) => {
        console.warn('[sms] SMSFlow keyword reply failed:', err.message)
      })
    }
    res.json({ ok: true })
  }
)
