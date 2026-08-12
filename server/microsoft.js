// Microsoft OAuth + Outlook / Microsoft 365 via Graph API (plain fetch).
import crypto from 'node:crypto'
import express from 'express'
import { db, logEvent } from './db.js'
import { env, microsoftConfigured } from './env.js'
import { requireUser, workspace } from './auth.js'
import { suppressionFor, SuppressedError } from './suppression.js'
import { REVIVE_MAILBOX_SQL } from './parity/schema.js'

const SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.Send',
  'Mail.Read',
].join(' ')

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const GRAPH = 'https://graph.microsoft.com/v1.0'

const redirectUri = () => `${env.APP_URL}/api/microsoft/callback`

function isActiveMailbox(row) {
  return Boolean(row && row.deleted_at == null && row.status === 'connected' && row.refresh_token)
}

export async function freshAccessToken(mailbox) {
  if (mailbox.token_expiry > Date.now() + 60_000) return mailbox.access_token
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      refresh_token: mailbox.refresh_token,
      grant_type: 'refresh_token',
      scope: SCOPES,
    }),
  })
  if (!res.ok) {
    const detail = await res.text()
    // Same classification as Gmail: only a revoked grant disables the mailbox and
    // asks for a reconnect. A transient 5xx/429 from the token endpoint leaves it
    // connected so the next tick retries rather than parking a healthy account.
    const permanent = /invalid_grant|invalid_client/i.test(detail)
    if (permanent) {
      db.prepare("UPDATE mailboxes SET status = 'error', needs_reconnect = 1, last_error = ? WHERE id = ?")
        .run(`Reconnect required: ${detail.slice(0, 300)}`, mailbox.id)
      const err = new Error(`outlook token refresh revoked for ${mailbox.email} — reconnect required`)
      err.permanent = true
      throw err
    }
    db.prepare("UPDATE mailboxes SET last_error = ? WHERE id = ?")
      .run(`Token refresh failed (transient ${res.status}): ${detail.slice(0, 260)}`, mailbox.id)
    const err = new Error(`outlook token refresh failed for ${mailbox.email} (transient ${res.status})`)
    err.transient = true
    throw err
  }
  const tokens = await res.json()
  const expiry = Date.now() + (tokens.expires_in || 3600) * 1000
  db.prepare(
    "UPDATE mailboxes SET access_token = ?, token_expiry = ?, status = 'connected', last_error = '', needs_reconnect = 0 WHERE id = ?"
  ).run(tokens.access_token, expiry, mailbox.id)
  if (tokens.refresh_token) {
    db.prepare('UPDATE mailboxes SET refresh_token = ? WHERE id = ?').run(tokens.refresh_token, mailbox.id)
  }
  mailbox.access_token = tokens.access_token
  mailbox.token_expiry = expiry
  return tokens.access_token
}

async function graphFetch(mailbox, path, options = {}) {
  const token = await freshAccessToken(mailbox)
  const res = await fetch(`${GRAPH}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`graph ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  if (res.status === 202 || res.status === 204) return null
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function recipients(list) {
  return (Array.isArray(list) ? list : String(list || '').split(','))
    .map((a) => String(a).trim()).filter(Boolean)
    .map((address) => ({ emailAddress: { address } }))
}

export async function outlookSend(mailbox, { to, cc = [], bcc = [], subject, body, html, threadId, inReplyTo, listUnsubscribe, workspaceId }) {
  const wsId = workspaceId ?? mailbox?.user_id
  if (!wsId) throw new Error('outlookSend requires workspaceId')
  for (const address of [...recipients(to), ...recipients(cc), ...recipients(bcc)].map((r) => r.emailAddress.address)) {
    const bare = (address.match(/<([^>]+)>/) || [null, address])[1]
    const blocked = suppressionFor(wsId, { address: bare })
    if (blocked) throw new SuppressedError(blocked)
  }

  const headers = []
  if (inReplyTo) headers.push({ name: 'In-Reply-To', value: inReplyTo }, { name: 'References', value: inReplyTo })
  if (listUnsubscribe) headers.push({ name: 'List-Unsubscribe', value: `<${listUnsubscribe}>` })

  const message = {
    subject: String(subject || '').replace(/[\r\n]/g, ' '),
    body: html
      ? { contentType: 'HTML', content: html }
      : { contentType: 'Text', content: body },
    toRecipients: recipients(to),
    ccRecipients: recipients(cc),
    bccRecipients: recipients(bcc),
    internetMessageHeaders: headers,
  }

  // Create then send so we get ids back for threading.
  const draft = await graphFetch(mailbox, '/me/messages', { method: 'POST', body: JSON.stringify(message) })
  await graphFetch(mailbox, `/me/messages/${draft.id}/send`, { method: 'POST' })
  return {
    messageId: draft.id,
    threadId: threadId || draft.conversationId || '',
  }
}

export async function outlookThread(mailbox, conversationId) {
  const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)
  const data = await graphFetch(mailbox, `/me/messages?$filter=${filter}&$top=50&$orderby=receivedDateTime asc`)
  return (data?.value || []).map((msg) => {
    const fromEmail = (msg.from?.emailAddress?.address || '').toLowerCase()
    return {
      providerMessageId: msg.id,
      messageIdHeader: msg.internetMessageId || '',
      direction: fromEmail === mailbox.email.toLowerCase() ? 'out' : 'in',
      fromEmail,
      toEmail: (msg.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean).join(', '),
      subject: msg.subject || '',
      body: stripHtml(msg.body?.content) || msg.bodyPreview || '',
      internalDate: Date.parse(msg.receivedDateTime || msg.sentDateTime || '') || 0,
    }
  })
}

export async function outlookRecentInbound(mailbox, { withinDays = 2, max = 25, sinceMs = 0 } = {}) {
  // A persisted watermark (`sinceMs`) fetches everything received after it and
  // pages through @odata.nextLink, so a mailbox offline for days or flooded with
  // mail never skips a reply. No watermark yet falls back to the day window.
  const since = sinceMs ? new Date(sinceMs).toISOString() : new Date(Date.now() - withinDays * 86_400_000).toISOString()
  const hardCap = sinceMs ? Math.max(max, 250) : Math.max(1, max)
  const filter = encodeURIComponent(`receivedDateTime ge ${since}`)
  let url = `/me/mailFolders/inbox/messages?$filter=${filter}&$top=${Math.min(100, hardCap)}&$orderby=receivedDateTime desc`
  const out = []
  for (let page = 0; page < 20 && out.length < hardCap && url; page++) {
    const data = await graphFetch(mailbox, url)
    for (const msg of data?.value || []) {
      const fromEmail = (msg.from?.emailAddress?.address || '').toLowerCase()
      if (!fromEmail || fromEmail === mailbox.email.toLowerCase()) continue
      out.push({
        providerMessageId: msg.id,
        threadId: msg.conversationId || '',
        messageIdHeader: msg.internetMessageId || '',
        fromEmail,
        toEmail: (msg.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean).join(', '),
        subject: msg.subject || '',
        body: stripHtml(msg.body?.content) || msg.bodyPreview || '',
        internalDate: Date.parse(msg.receivedDateTime || '') || 0,
        receivedAt: msg.receivedDateTime || '',
      })
    }
    const next = data?.['@odata.nextLink'] || ''
    url = next ? next.replace(GRAPH, '') : ''
  }
  return out
}

export const microsoftRouter = express.Router()
const pendingStates = new Map()

microsoftRouter.get('/api/microsoft/connect', requireUser, workspace, (req, res) => {
  if (!microsoftConfigured()) return res.redirect('/app/connections?error=microsoft_not_configured')

  const hint = String(req.query.email || '').trim().toLowerCase()
  if (hint) {
    const existing = db.prepare(
      "SELECT * FROM mailboxes WHERE user_id = ? AND provider = 'outlook' AND email = ? AND deleted_at IS NULL"
    ).get(req.wsId, hint)
    if (isActiveMailbox(existing)) {
      return res.redirect(`/app/connections?already_connected=1&provider=outlook&email=${encodeURIComponent(hint)}`)
    }
  }

  const state = crypto.randomBytes(16).toString('hex')
  pendingStates.set(state, { userId: req.wsId, expiry: Date.now() + 10 * 60 * 1000 })
  const url = new URL(`${AUTH}/authorize`)
  url.searchParams.set('client_id', env.MICROSOFT_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  if (hint) url.searchParams.set('login_hint', hint)
  res.redirect(url.toString())
})

microsoftRouter.get('/api/microsoft/callback', async (req, res) => {
  try {
    const { code, state, error, error_description: desc } = req.query
    if (error) {
      const msg = error === 'access_denied'
        ? 'Microsoft blocked access — add your account as a test user in Azure, or grant admin consent for your org'
        : String(desc || error)
      return res.redirect(`/app/connections?error=${encodeURIComponent(msg)}`)
    }
    const pending = pendingStates.get(state)
    pendingStates.delete(state)
    for (const [s, p] of pendingStates) if (p.expiry < Date.now()) pendingStates.delete(s)
    if (!pending || pending.expiry < Date.now()) return res.redirect('/app/connections?error=invalid_state')

    const tokenRes = await fetch(`${AUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.MICROSOFT_CLIENT_ID,
        client_secret: env.MICROSOFT_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(),
        scope: SCOPES,
      }),
    })
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`)
    const tokens = await tokenRes.json()

    const infoRes = await fetch(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (!infoRes.ok) throw new Error(`profile failed: ${await infoRes.text()}`)
    const info = await infoRes.json()

    const expiry = Date.now() + (tokens.expires_in || 3600) * 1000
    const email = String(info.mail || info.userPrincipalName || '').toLowerCase()
    const existing = db.prepare("SELECT * FROM mailboxes WHERE user_id = ? AND provider = 'outlook' AND email = ?")
      .get(pending.userId, email)

    if (isActiveMailbox(existing)) {
      return res.redirect(`/app/connections?already_connected=1&provider=outlook&email=${encodeURIComponent(email)}`)
    }

    const displayName = info.displayName || ''
    if (existing) {
      if (String(existing.deleted_at || '') !== '') {
        db.prepare(REVIVE_MAILBOX_SQL).run(displayName || existing.display_name, existing.id)
      }
      db.prepare(
        "UPDATE mailboxes SET access_token = ?, refresh_token = COALESCE(NULLIF(?, ''), refresh_token), token_expiry = ?, status = 'connected', last_error = '', display_name = ? WHERE id = ?"
      ).run(tokens.access_token, tokens.refresh_token || '', expiry, displayName || existing.display_name, existing.id)
    } else {
      db.prepare(
        "INSERT INTO mailboxes (user_id, provider, email, display_name, access_token, refresh_token, token_expiry, deleted_at) VALUES (?, 'outlook', ?, ?, ?, ?, ?, NULL)"
      ).run(pending.userId, email, displayName, tokens.access_token, tokens.refresh_token || '', expiry)
    }
    logEvent(pending.userId, { type: 'mailbox_connected', detail: `outlook:${email}` })
    res.redirect('/app/connections?connected=outlook')
  } catch (err) {
    console.error('[microsoft] callback error', err)
    res.redirect(`/app/connections?error=${encodeURIComponent('Microsoft connection failed — check server logs')}`)
  }
})
