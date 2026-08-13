// Multi-channel send façade. Email still goes through mailer.sendEmail; SMS
// (and later WA/Telegram) go through their adapters. Every path checks
// suppression / opt-in, records messages + touches, and bumps daily quota.

import { db, logEvent } from '../db.js'
import { env, twilioEnvConfigured, smsflowEnvConfigured, smsAllowedEmails } from '../env.js'
import { sendEmail, SuppressedError } from '../mailer.js'
import { recordTouch } from '../touches.js'
import { recordTelemetry } from '../telemetry.js'
import { suppressionFor } from '../suppression.js'
import { toE164 } from './phone.js'
import { sealSecret } from '../secrets.js'
import { twilioSendSms, smsThreadId, twilioConfigured } from './twilio.js'
import { smsflowSendSms, smsflowConfigured, SMSFLOW_SID } from './smsflow.js'

export { SuppressedError }

/**
 * SMS is a gated feature: when SMS_ALLOWED_EMAILS is set, only the listed
 * workspace owners may configure or send SMS. Unset = open to everyone.
 */
export function smsAllowedForWorkspace(wsId) {
  const allowed = smsAllowedEmails()
  if (!allowed.length) return true
  const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(wsId)
  return allowed.includes(String(owner?.email || '').trim().toLowerCase())
}

/** Provider dispatch — sandbox and legacy Twilio ride the Twilio adapter. */
export function smsProviderConfigured(account) {
  if (account?.provider === 'smsflow') return smsflowConfigured(account)
  return twilioConfigured(account)
}

export function smsProviderSend(account, msg) {
  if (account?.provider === 'smsflow') return smsflowSendSms(account, msg)
  return twilioSendSms(account, msg)
}

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
  if (!smsAllowedForWorkspace(campaign.user_id)) {
    throw new Error('SMS is not enabled for this workspace — ask the operator to add you to the SMS allowlist')
  }
  const check = smsEligibility(campaign.user_id, lead)
  if (!check.ok) {
    recordTelemetry('send', { op: 'sms_refused', ok: true, detail: check.reason })
    throw new SuppressedError({ reason: check.reason, matched: lead.phone || '', message: check.message })
  }
  if (account.is_suspended || account.status !== 'connected') {
    throw new Error(`SMS account ${account.phone_number || account.id} is not sendable`)
  }
  if (!smsProviderConfigured(account)) throw new Error('SMS account is not configured')
  if (remainingChannelQuota(account) <= 0) {
    // A daily cap is a "come back tomorrow", not a failure — tag it transient so
    // the engine defers the lead to the next window instead of stranding it in a
    // terminal 'error' state. The engine also gates on this quota before it ever
    // reaches here; this is the belt-and-braces at the transport.
    const err = new Error(`Daily SMS limit reached for ${account.phone_number || account.display_name}`)
    err.transient = true
    throw err
  }

  const existing = db.prepare(
    'SELECT thread_id FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?'
  ).get(campaign.id, lead.id)

  const t0 = Date.now()
  let result
  try {
    result = await smsProviderSend(account, { to: check.phone, body })
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
 * A person answering a text from the Inbox. Unlike the campaign path there may
 * be no campaign and even no lead (an inbound text from an unknown number is
 * still a conversation) — so consent is judged on what we know: an opt-out or
 * a blocked number refuses, an unknown-but-inbound number may be answered.
 */
export async function sendManualSms({ wsId, account, lead = null, to, body, threadId = '', campaignId = null }) {
  if (!smsAllowedForWorkspace(wsId)) {
    throw new SuppressedError({
      reason: 'sms_disabled', matched: to,
      message: 'SMS is not enabled for this workspace — ask the operator to add you to the SMS allowlist',
    })
  }
  const phone = toE164(to)
  if (!phone) throw new Error('SMS recipient is not a valid phone number')
  if (lead && (lead.status === 'unsubscribed' || lead.sms_opt_out_at)) {
    throw new SuppressedError({ reason: 'opted_out', matched: phone, message: `${phone} has opted out of SMS` })
  }
  const blocked = db.prepare(
    'SELECT 1 FROM blocked_domains WHERE workspace_id = ? AND value = ? AND is_domain = 0'
  ).get(wsId, phone.toLowerCase())
  if (blocked) {
    throw new SuppressedError({ reason: 'blocked', matched: phone, message: `${phone} is on the never-contact list` })
  }
  if (account.is_suspended || account.status !== 'connected') {
    throw new Error(`SMS account ${account.phone_number || account.id} is not sendable`)
  }
  if (!smsProviderConfigured(account)) throw new Error('SMS account is not configured')
  if (remainingChannelQuota(account) <= 0) {
    throw new Error(`Daily SMS limit reached for ${account.phone_number || account.display_name}`)
  }

  const t0 = Date.now()
  let result
  try {
    result = await smsProviderSend(account, { to: phone, body })
    recordTelemetry('send', { op: `sms_manual_${account.provider}`, ok: true, ms: Date.now() - t0 })
  } catch (err) {
    recordTelemetry('send', { op: `sms_manual_${account.provider}`, ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
    if (account.id) {
      db.prepare('UPDATE channel_accounts SET last_error = ? WHERE id = ?')
        .run(String(err.message || err).slice(0, 300), account.id)
    }
    throw err
  }

  const thread = threadId || result.threadId || smsThreadId(account, phone)
  const from = account.phone_number || account.messaging_service_sid || 'sms'
  const info = db.prepare(
    `INSERT INTO messages
       (user_id, campaign_id, lead_id, mailbox_id, channel_account_id, channel, direction,
        subject, body, from_email, to_email, provider_message_id, thread_id, node_id,
        manual_reply, is_read, read_at, send_status)
     VALUES (?, ?, ?, NULL, ?, 'sms', 'out', '', ?, ?, ?, ?, ?, 'manual', 1, 1, datetime('now'), 'sent')`
  ).run(
    wsId, campaignId, lead?.id || null, account.id || null,
    String(body || '').slice(0, 1600), from, phone,
    result.providerMessageId, thread
  )
  bumpChannelQuota(account)
  if (lead) {
    recordTouch({ wsId, leadId: lead.id, email: lead.email, channel: 'sms', campaignId })
  }
  logEvent(wsId, { campaignId, leadId: lead?.id || null, type: 'sent', detail: `manual sms → ${phone}` })
  return { providerMessageId: result.providerMessageId, threadId: thread, messageId: Number(info.lastInsertRowid), channel: 'sms' }
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
 * When SMSFLOW_* (or legacy TWILIO_*) is in the environment, materialise
 * (or refresh) a workspace SMS account from it so allow-listed workspaces
 * send without a Settings click.
 */
export function ensureEnvSmsAccount(wsId) {
  if (!smsAllowedForWorkspace(wsId)) return null
  if (smsflowEnvConfigured()) return ensureSmsflowEnvAccount(wsId)
  if (twilioEnvConfigured()) return ensureTwilioEnvAccount(wsId)
  return null
}

function ensureSmsflowEnvAccount(wsId) {
  const phone = toE164(env.SMSFLOW_FROM_NUMBER) || env.SMSFLOW_FROM_NUMBER || ''
  const existing = db.prepare(
    `SELECT * FROM channel_accounts
      WHERE workspace_id = ? AND channel = 'sms' AND provider = 'smsflow'
        AND COALESCE(deleted_at, '') = '' AND account_sid = ?
      ORDER BY id LIMIT 1`
  ).get(wsId, SMSFLOW_SID)
  if (existing) {
    db.prepare(
      `UPDATE channel_accounts
          SET auth_token = ?, phone_number = ?,
              status = 'connected', display_name = CASE WHEN display_name = '' THEN ? ELSE display_name END
        WHERE id = ?`
    ).run(
      sealSecret(env.SMSFLOW_API_KEY),
      phone || existing.phone_number,
      phone || 'SMSFlow SMS',
      existing.id,
    )
    return db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(existing.id)
  }
  const info = db.prepare(
    `INSERT INTO channel_accounts
       (workspace_id, channel, provider, display_name, phone_number,
        account_sid, auth_token, status, daily_limit)
     VALUES (?, 'sms', 'smsflow', ?, ?, ?, ?, 'connected', 100)`
  ).run(
    wsId,
    phone || 'SMSFlow (env)',
    phone,
    SMSFLOW_SID,
    sealSecret(env.SMSFLOW_API_KEY),
  )
  return db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(info.lastInsertRowid)
}

function ensureTwilioEnvAccount(wsId) {
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
      sealSecret(env.TWILIO_AUTH_TOKEN),
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
    sealSecret(env.TWILIO_AUTH_TOKEN),
  )
  return db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(info.lastInsertRowid)
}

/** Pick an SMS channel account for a campaign (attached → workspace → .env SMSFlow). */
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
