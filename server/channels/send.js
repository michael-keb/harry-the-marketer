// Multi-channel send façade. Email still goes through mailer.sendEmail; SMS
// (and later WA/Telegram) go through their adapters. Every path checks
// suppression / opt-in, records messages + touches, and bumps daily quota.

import { db, logEvent } from '../db.js'
import { env, twilioEnvConfigured } from '../env.js'
import { sendEmail, SuppressedError } from '../mailer.js'
import { recordTouch } from '../touches.js'
import { recordTelemetry } from '../telemetry.js'
import { suppressionFor } from '../suppression.js'
import { toE164 } from './phone.js'
import { twilioSendSms, smsThreadId, twilioConfigured } from './twilio.js'

export { SuppressedError }

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function bumpChannelQuota(account) {
  if (!account?.id) return
  const today = todayStr()
  if (account.sent_today_date === today) {
    db.prepare('UPDATE channel_accounts SET sent_today = sent_today + 1 WHERE id = ?').run(account.id)
  } else {
    db.prepare('UPDATE channel_accounts SET sent_today = 1, sent_today_date = ? WHERE id = ?').run(today, account.id)
  }
}

function remainingChannelQuota(account) {
  const today = todayStr()
  const used = account.sent_today_date === today ? (account.sent_today || 0) : 0
  return Math.max(0, (account.daily_limit || 0) - used)
}

/** SMS may send only with explicit opt-in and no opt-out / suppression. */
export function smsEligibility(wsId, lead) {
  if (!lead) return { ok: false, reason: 'no_lead', message: 'No lead' }
  const phone = toE164(lead.phone)
  if (!phone) return { ok: false, reason: 'no_phone', message: 'Lead has no valid phone number' }
  if (lead.status === 'unsubscribed' || lead.sms_opt_out_at) {
    return { ok: false, reason: 'opted_out', message: `${phone} has opted out of SMS` }
  }
  if (!lead.sms_opt_in_at) {
    return { ok: false, reason: 'no_opt_in', message: `${phone} has not opted in to SMS` }
  }
  // Phone on never-contact list (exact match, is_domain = 0).
  const blocked = db.prepare(
    'SELECT * FROM blocked_domains WHERE workspace_id = ? AND value = ? AND is_domain = 0'
  ).get(wsId, phone.toLowerCase())
  if (blocked) {
    return { ok: false, reason: 'blocked', message: `${phone} is on the never-contact list` }
  }
  // Email-level unsubscribe still blocks SMS for that lead record.
  const emailSuppressed = suppressionFor(wsId, { address: lead.email, lead })
  if (emailSuppressed?.reason === 'unsubscribed') {
    return { ok: false, reason: 'unsubscribed', message: emailSuppressed.message }
  }
  return { ok: true, phone }
}

export async function sendSms({ account, user, campaign, lead, nodeId, body }) {
  const check = smsEligibility(campaign.user_id, lead)
  if (!check.ok) {
    recordTelemetry('send', { op: 'sms_refused', ok: true, detail: check.reason })
    throw new SuppressedError({ reason: check.reason, matched: lead.phone || '', message: check.message })
  }
  if (account.is_suspended || account.status !== 'connected') {
    throw new Error(`SMS account ${account.phone_number || account.id} is not sendable`)
  }
  if (!twilioConfigured(account)) throw new Error('SMS account is not configured')
  if (remainingChannelQuota(account) <= 0) {
    throw new Error(`Daily SMS limit reached for ${account.phone_number || account.display_name}`)
  }

  const existing = db.prepare(
    'SELECT thread_id FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?'
  ).get(campaign.id, lead.id)

  const t0 = Date.now()
  let result
  try {
    result = await twilioSendSms(account, { to: check.phone, body })
    recordTelemetry('send', { op: `sms_${account.provider}`, ok: true, ms: Date.now() - t0 })
  } catch (err) {
    recordTelemetry('send', { op: `sms_${account.provider}`, ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
    if (account.id) {
      db.prepare('UPDATE channel_accounts SET last_error = ? WHERE id = ?')
        .run(String(err.message || err).slice(0, 300), account.id)
    }
    throw err
  }

  const threadId = existing?.thread_id || result.threadId || smsThreadId(account, check.phone)
  const from = account.phone_number || account.messaging_service_sid || 'sms'
  db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, mailbox_id, channel_account_id, channel, direction,
        subject, body, from_email, to_email, provider_message_id, thread_id, node_id, is_read, send_status)
     VALUES (?, ?, ?, NULL, ?, 'sms', 'out', '', ?, ?, ?, ?, ?, ?, 1, 'sent')`
  ).run(
    user.id, campaign.id, lead.id, account.id || null,
    String(body || '').slice(0, 1600), from, check.phone,
    result.providerMessageId, threadId, nodeId || ''
  )
  bumpChannelQuota(account)
  recordTouch({
    wsId: campaign.user_id, leadId: lead.id, email: lead.email,
    channel: 'sms', campaignId: campaign.id,
  })
  logEvent(user.id, { campaignId: campaign.id, leadId: lead.id, type: 'sent', detail: `sms → ${check.phone}` })
  return { providerMessageId: result.providerMessageId, threadId, channel: 'sms' }
}

/**
 * Channel-aware send. `channel` defaults to email for backward compatibility.
 * For email, `account` is a mailbox; for sms, a channel_account.
 */
export async function sendMessage({
  channel = 'email',
  account,
  user,
  campaign,
  lead,
  nodeId,
  subject,
  body,
  cc,
  bcc,
}) {
  const ch = String(channel || 'email').toLowerCase()
  if (ch === 'email') {
    return sendEmail({ mailbox: account, user, campaign, lead, nodeId, subject, body, cc, bcc })
  }
  if (ch === 'sms') {
    return sendSms({ account, user, campaign, lead, nodeId, body })
  }
  throw new Error(`Channel "${ch}" is not supported yet`)
}

/**
 * When TWILIO_* is in the environment, materialise (or refresh) a workspace SMS
 * account from it so campaigns send without a Settings click.
 */
export function ensureEnvSmsAccount(wsId) {
  if (!twilioEnvConfigured()) return null
  const phone = toE164(env.TWILIO_FROM_NUMBER) || env.TWILIO_FROM_NUMBER || ''
  const messagingSid = env.TWILIO_MESSAGING_SERVICE_SID || ''
  const existing = db.prepare(
    `SELECT * FROM channel_accounts
      WHERE workspace_id = ? AND channel = 'sms' AND provider = 'twilio'
        AND COALESCE(deleted_at, '') = '' AND account_sid = ?
      ORDER BY id LIMIT 1`
  ).get(wsId, env.TWILIO_ACCOUNT_SID)
  if (existing) {
    db.prepare(
      `UPDATE channel_accounts
          SET auth_token = ?, phone_number = ?, messaging_service_sid = ?,
              status = 'connected', display_name = CASE WHEN display_name = '' THEN ? ELSE display_name END
        WHERE id = ?`
    ).run(
      env.TWILIO_AUTH_TOKEN,
      phone || existing.phone_number,
      messagingSid || existing.messaging_service_sid,
      phone || messagingSid || 'Twilio SMS',
      existing.id,
    )
    return db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(existing.id)
  }
  const info = db.prepare(
    `INSERT INTO channel_accounts
       (workspace_id, channel, provider, display_name, phone_number, messaging_service_sid,
        account_sid, auth_token, status, daily_limit)
     VALUES (?, 'sms', 'twilio', ?, ?, ?, ?, ?, 'connected', 100)`
  ).run(
    wsId,
    phone || messagingSid || 'Twilio (env)',
    phone,
    messagingSid,
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_AUTH_TOKEN,
  )
  return db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(info.lastInsertRowid)
}

/** Pick an SMS channel account for a campaign (attached → workspace → .env Twilio). */
export function smsAccountFor(campaign) {
  // Soft-delete uses empty string (Harry convention), not SQL NULL.
  const attached = db.prepare(
    `SELECT a.* FROM campaign_channel_accounts cca
       JOIN channel_accounts a ON a.id = cca.channel_account_id
      WHERE cca.campaign_id = ? AND a.channel = 'sms' AND COALESCE(a.deleted_at, '') = ''
        AND a.status = 'connected' AND COALESCE(a.is_suspended, 0) = 0
      ORDER BY cca.id LIMIT 1`
  ).get(campaign.id)
  if (attached) return attached
  const workspace = db.prepare(
    `SELECT * FROM channel_accounts
      WHERE workspace_id = ? AND channel = 'sms' AND COALESCE(deleted_at, '') = ''
        AND status = 'connected' AND COALESCE(is_suspended, 0) = 0
      ORDER BY id LIMIT 1`
  ).get(campaign.user_id)
  if (workspace) return workspace
  return ensureEnvSmsAccount(campaign.user_id)
}
