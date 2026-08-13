// Channel accounts — SMS (SMSFlow) senders for the workspace.
// Settings → Connections. Distinct from email mailboxes.
//
// SMS is a gated feature: when SMS_ALLOWED_EMAILS is set, only listed
// workspace owners can connect senders or send.

import { db } from '../db.js'
import { env, twilioEnvConfigured, smsflowEnvConfigured } from '../env.js'
import { sealSecret } from '../secrets.js'
import {
  handler, invalid, notFound, forbidden, str, int, bool, owned, audit,
} from './http.js'
import { toE164 } from '../channels/phone.js'
import { smsflowWebhookUrl, SMSFLOW_SID } from '../channels/smsflow.js'
import {
  ensureEnvSmsAccount, smsAllowedForWorkspace, smsProviderConfigured, smsProviderSend,
} from '../channels/send.js'

function webhookUrlFor(row) {
  if (row.provider === 'smsflow') return smsflowWebhookUrl(row)
  const base = String(env.APP_URL || '').replace(/\/$/, '')
  return `${base}/api/hooks/twilio/sms`
}

function publicAccount(row) {
  if (!row) return null
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    displayName: row.display_name || '',
    phoneNumber: row.phone_number || '',
    messagingServiceSid: row.messaging_service_sid || '',
    accountSid: row.account_sid ? `${String(row.account_sid).slice(0, 4)}…` : '',
    hasAuthToken: Boolean(row.auth_token),
    status: row.status,
    dailyLimit: row.daily_limit,
    sentToday: row.sent_today_date === new Date().toISOString().slice(0, 10) ? row.sent_today : 0,
    lastError: row.last_error || '',
    lastSyncAt: row.last_sync_at || '',
    isSuspended: Boolean(row.is_suspended),
    createdAt: row.created_at,
    webhookUrl: webhookUrlFor(row),
  }
}

function requireSmsAllowed(wsId) {
  if (!smsAllowedForWorkspace(wsId)) {
    throw forbidden('SMS is not enabled for this workspace — ask the operator to add you to the SMS allowlist')
  }
}

export function register(api) {
  api.get('/channel-accounts', handler((req) => {
    // Prefer .env SMSFlow when present so Settings shows the live sender.
    // (Self-gated: does nothing for workspaces off the SMS allowlist.)
    ensureEnvSmsAccount(req.wsId)
    const channel = str(req.query, 'channel', { max: 20, fallback: '' })
    let rows = db.prepare(
      `SELECT * FROM channel_accounts WHERE workspace_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY id`
    ).all(req.wsId)
    if (channel) rows = rows.filter((r) => r.channel === channel)
    const smsflowRow = rows.find((r) => r.provider === 'smsflow')
    return {
      accounts: rows.map(publicAccount),
      webhookUrl: smsflowWebhookUrl(smsflowRow),
      smsAllowed: smsAllowedForWorkspace(req.wsId),
      twilioEnvConfigured: twilioEnvConfigured(),
      smsflowEnvConfigured: smsflowEnvConfigured(),
    }
  }))

  api.post('/channel-accounts', handler((req) => {
    requireSmsAllowed(req.wsId)
    const channel = str(req.body, 'channel', { required: true, max: 20 }).toLowerCase()
    if (channel !== 'sms') throw invalid('channel', 'Only sms is supported in this release')
    const provider = str(req.body, 'provider', { max: 40, fallback: 'smsflow' }).toLowerCase()
    if (!['smsflow', 'twilio', 'sandbox'].includes(provider)) {
      throw invalid('provider', 'provider must be smsflow, twilio or sandbox')
    }

    const displayName = str(req.body, 'display_name', { max: 120, fallback: '' })
    let phoneNumber = str(req.body, 'phone_number', { max: 32, fallback: '' })
    if (phoneNumber) {
      if (/^\+?\d[\d\s()-]{7,}$/.test(phoneNumber)) {
        const e164 = toE164(phoneNumber)
        if (!e164) throw invalid('phone_number', 'phone_number must be a valid E.164 number')
        phoneNumber = e164
      }
    }
    const messagingServiceSid = str(req.body, 'messaging_service_sid', { max: 64, fallback: '' })
    // account_sid / auth_token: SMSFlow only needs the API key (auth_token).
    const accountSid = str(req.body, 'account_sid', {
      max: 128, fallback: provider === 'smsflow' ? SMSFLOW_SID : env.TWILIO_ACCOUNT_SID,
    })
    const authToken = str(req.body, 'auth_token', {
      max: 128, fallback: provider === 'smsflow' ? env.SMSFLOW_API_KEY : env.TWILIO_AUTH_TOKEN,
    })
    const dailyLimit = int(req.body, 'daily_limit', { min: 1, max: 10_000, fallback: 50 })

    if (provider === 'smsflow') {
      if (!authToken) throw invalid('auth_token', 'SMSFlow API key is required')
    } else if (provider === 'twilio') {
      if (!phoneNumber && !messagingServiceSid) {
        throw invalid('phone_number', 'Provide phone_number or messaging_service_sid')
      }
      if (!accountSid || !authToken) {
        throw invalid('account_sid', 'Twilio Account SID and Auth Token are required')
      }
    } else if (!phoneNumber) {
      phoneNumber = '+15555550100'
    }

    const info = db.prepare(
      `INSERT INTO channel_accounts
         (workspace_id, channel, provider, display_name, phone_number, messaging_service_sid,
          account_sid, auth_token, status, daily_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)`
    ).run(
      req.wsId, channel, provider,
      displayName || phoneNumber || 'SMS',
      phoneNumber, messagingServiceSid, accountSid, sealSecret(authToken), dailyLimit
    )
    const row = db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(info.lastInsertRowid)
    audit(req, { type: 'channel_account_connected', detail: `${provider}:${phoneNumber || messagingServiceSid}` })
    return { account: publicAccount(row) }
  }))

  api.patch('/channel-accounts/:id', handler((req) => {
    const row = owned('channel_accounts', req.params.id, req.wsId, 'channel account')
    if (row.deleted_at) throw notFound('channel account')

    const patch = {}
    if (req.body.display_name !== undefined) patch.display_name = str(req.body, 'display_name', { max: 120 })
    if (req.body.phone_number !== undefined) {
      const e164 = toE164(str(req.body, 'phone_number', { max: 32 }))
      if (!e164) throw invalid('phone_number', 'phone_number must be a valid E.164 number')
      patch.phone_number = e164
    }
    if (req.body.messaging_service_sid !== undefined) {
      patch.messaging_service_sid = str(req.body, 'messaging_service_sid', { max: 64 })
    }
    if (req.body.account_sid !== undefined) patch.account_sid = str(req.body, 'account_sid', { max: 128 })
    if (req.body.auth_token !== undefined) patch.auth_token = sealSecret(str(req.body, 'auth_token', { max: 128 }))
    if (req.body.daily_limit !== undefined) patch.daily_limit = int(req.body, 'daily_limit', { min: 1, max: 10_000 })
    if (req.body.is_suspended !== undefined) {
      patch.is_suspended = bool(req.body, 'is_suspended') ? 1 : 0
      if (patch.is_suspended) patch.status = 'connected'
    }

    const cols = Object.keys(patch)
    if (!cols.length) return { account: publicAccount(row) }
    db.prepare(`UPDATE channel_accounts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => patch[c]), row.id)
    const next = db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(row.id)
    return { account: publicAccount(next) }
  }))

  api.delete('/channel-accounts/:id', handler((req) => {
    const row = owned('channel_accounts', req.params.id, req.wsId, 'channel account')
    db.prepare("UPDATE channel_accounts SET deleted_at = datetime('now'), status = 'deleted' WHERE id = ?").run(row.id)
    audit(req, { type: 'channel_account_deleted', detail: String(row.phone_number || row.id) })
    return { ok: true }
  }))

  // Test send to your own phone — does not require lead opt-in (operator test).
  api.post('/channel-accounts/:id/test-send', handler(async (req) => {
    requireSmsAllowed(req.wsId)
    const row = owned('channel_accounts', req.params.id, req.wsId, 'channel account')
    if (row.deleted_at || row.channel !== 'sms') throw notFound('channel account')
    requireConfirmation(req.body, 'send this test SMS')
    const to = toE164(str(req.body, 'to', { required: true, max: 32 }))
    if (!to) throw invalid('to', 'to must be a valid phone number')
    const body = str(req.body, 'body', { max: 1600, fallback: 'Harry SMS test — reply STOP to opt out.' })
    if (!smsProviderConfigured(row)) throw invalid('account', 'SMS account is not fully configured')

    const result = await smsProviderSend(row, { to, body })
    db.prepare(
      `INSERT INTO messages
         (user_id, campaign_id, lead_id, channel_account_id, channel, direction,
          subject, body, from_email, to_email, provider_message_id, thread_id, node_id, is_read, send_status)
       VALUES (?, NULL, NULL, ?, 'sms', 'out', '', ?, ?, ?, ?, ?, 'test', 1, 'test')`
    ).run(
      req.wsId, row.id, body,
      row.phone_number || row.messaging_service_sid, to,
      result.providerMessageId, result.threadId
    )
    audit(req, { type: 'sms_test_send', detail: `→ ${to}` })
    return { ok: true, to, providerMessageId: result.providerMessageId }
  }))

  // Attach / detach SMS accounts on a campaign.
  api.get('/campaigns/:id/channel-accounts', handler((req) => {
    const c = owned('campaigns', req.params.id, req.wsId, 'campaign')
    const rows = db.prepare(
      `SELECT a.* FROM campaign_channel_accounts cca
         JOIN channel_accounts a ON a.id = cca.channel_account_id
        WHERE cca.campaign_id = ? AND COALESCE(a.deleted_at, '') = '' ORDER BY cca.id`
    ).all(c.id)
    return { accounts: rows.map(publicAccount) }
  }))

  api.post('/campaigns/:id/channel-accounts', handler((req) => {
    const c = owned('campaigns', req.params.id, req.wsId, 'campaign')
    let ids = []
    if (Array.isArray(req.body?.channelAccountIds)) {
      ids = req.body.channelAccountIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n >= 1)
    } else if (req.body?.channel_account_id !== undefined || req.body?.channelAccountId !== undefined) {
      ids = [int(req.body, req.body?.channel_account_id !== undefined ? 'channel_account_id' : 'channelAccountId', {
        required: true, min: 1,
      })]
    }
    if (!ids.length) throw invalid('channelAccountIds', 'Select at least one SMS sender')
    let attached = 0
    for (const accountId of ids) {
      const account = owned('channel_accounts', accountId, req.wsId, 'channel account')
      if (account.deleted_at) throw notFound('channel account')
      if (account.channel !== 'sms') throw invalid('channelAccountIds', 'Only SMS senders can be attached')
      attached += db.prepare(
        'INSERT OR IGNORE INTO campaign_channel_accounts (campaign_id, channel_account_id) VALUES (?, ?)'
      ).run(c.id, account.id).changes
    }
    audit(req, {
      campaignId: c.id,
      type: 'campaign_channel_accounts_added',
      detail: `${attached} attached by ${req.user.email}`,
    })
    return { ok: true, attached }
  }))

  api.delete('/campaigns/:id/channel-accounts/:accountId', handler((req) => {
    const c = owned('campaigns', req.params.id, req.wsId, 'campaign')
    db.prepare(
      'DELETE FROM campaign_channel_accounts WHERE campaign_id = ? AND channel_account_id = ?'
    ).run(c.id, Number(req.params.accountId))
    return { ok: true }
  }))

  // Lead SMS opt-in (manual record for now — import / form later).
  api.post('/leads/:id/sms-opt-in', handler((req) => {
    const lead = owned('leads', req.params.id, req.wsId, 'lead')
    const source = str(req.body, 'source', { max: 80, fallback: 'manual' })
    const phone = toE164(str(req.body, 'phone', { max: 32, fallback: lead.phone }))
    if (!phone) throw invalid('phone', 'A valid phone number is required for SMS opt-in')
    db.prepare(
      `UPDATE leads SET phone = ?, sms_opt_in_at = datetime('now'), sms_opt_in_source = ?,
         sms_opt_out_at = '', updated_at = datetime('now') WHERE id = ?`
    ).run(phone, source, lead.id)
    return {
      ok: true,
      leadId: lead.id,
      phone,
      smsOptInAt: new Date().toISOString(),
    }
  }))
}

function requireConfirmation(body, action) {
  if (!bool(body, 'confirm', false)) {
    throw invalid('confirm', `Pass confirm: true to ${action}`)
  }
}
