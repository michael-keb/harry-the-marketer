// Public Twilio webhooks — inbound SMS + status callbacks.
// Mounted outside the session API so Twilio can POST without Auth0.

import express from 'express'
import { db, logEvent } from '../db.js'
import { env, twilioEnvConfigured } from '../env.js'
import { unsubscribeLead } from '../suppression.js'
import { toE164, samePhone } from './phone.js'
import { verifyTwilioSignature, smsKeyword, smsThreadId } from './twilio.js'
import { ensureEnvSmsAccount } from './send.js'

export const twilioRouter = express.Router()

function twilioXml(message) {
  if (!message) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
  const escaped = String(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`
}

function findAccountByTo(toRaw) {
  const to = toE164(toRaw) || String(toRaw || '').trim()
  if (!to) return null
  const rows = db.prepare(
    `SELECT * FROM channel_accounts
      WHERE channel = 'sms' AND COALESCE(deleted_at, '') = '' AND status = 'connected'`
  ).all()
  const hit = rows.find((a) => samePhone(a.phone_number, to))
  if (hit) return hit
  // .env Twilio number with no Settings row yet — attach only to the workspace
  // that already holds this Account SID. There used to be a fallback to "the
  // first workspace", which meant an inbound STOP on a number nobody had
  // claimed was written into an arbitrary tenant's inbox and block list. An
  // unattributable message is dropped (Twilio gets a 404 and retries) rather
  // than filed under whoever happens to be user id 1.
  if (twilioEnvConfigured() && samePhone(env.TWILIO_FROM_NUMBER, to)) {
    const known = rows.find((a) => a.account_sid === env.TWILIO_ACCOUNT_SID)
    if (known) return ensureEnvSmsAccount(known.workspace_id)
    console.warn('[sms] inbound on env Twilio number but no workspace holds the Account SID — dropped')
  }
  return null
}

function publicWebhookUrl(req) {
  // Prefer configured APP_URL so signature validation matches what Twilio signed.
  const base = String(env.APP_URL || '').replace(/\/$/, '')
  if (base) return `${base}${req.originalUrl.split('?')[0]}`
  return `${req.protocol}://${req.get('host')}${req.originalUrl.split('?')[0]}`
}

// Inbound SMS. Twilio form-encodes the body.
twilioRouter.post('/sms', express.urlencoded({ extended: false }), (req, res) => {
  const params = req.body || {}
  const from = toE164(params.From) || String(params.From || '').trim()
  const to = toE164(params.To) || String(params.To || '').trim()
  const body = String(params.Body || '')
  const sid = String(params.MessageSid || params.SmsSid || '')

  const account = findAccountByTo(to)
  if (!account) {
    res.type('text/xml').status(404).send(twilioXml())
    return
  }

  const signature = req.get('X-Twilio-Signature') || ''
  const ok = verifyTwilioSignature({
    authToken: account.auth_token,
    url: publicWebhookUrl(req),
    params,
    signature,
  })
  if (!ok) {
    res.status(403).type('text/plain').send('Invalid signature')
    return
  }

  if (sid && db.prepare('SELECT 1 FROM messages WHERE provider_message_id = ?').get(sid)) {
    res.type('text/xml').send(twilioXml())
    return
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
      unsubscribeLead(account.workspace_id, matched.id, { source: 'sms_stop', actor: 'twilio' })
      db.prepare(
        "UPDATE leads SET sms_opt_out_at = datetime('now'), sms_opt_in_at = '', sms_opt_in_source = '' WHERE id = ?"
      ).run(matched.id)
    }
    const phoneKey = from.toLowerCase()
    db.prepare(
      `INSERT OR IGNORE INTO blocked_domains (workspace_id, value, is_domain, source, created_by)
       VALUES (?, ?, 0, 'sms_stop', 'twilio')`
    ).run(account.workspace_id, phoneKey)
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
    body.slice(0, 1600), from, to || account.phone_number, sid, threadId
  )

  db.prepare("UPDATE channel_accounts SET last_sync_at = datetime('now') WHERE id = ?").run(account.id)
  if (matched && keyword !== 'stop') {
    logEvent(account.workspace_id, {
      campaignId, leadId: matched.id, type: 'reply',
      detail: `sms: ${body.slice(0, 120)}`,
    })
  }

  res.type('text/xml').send(twilioXml(replyText))
})
