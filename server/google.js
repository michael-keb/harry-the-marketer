// Google OAuth + Gmail REST integration (no SDK — plain fetch).
// Scopes: send + read mail, userinfo to identify the connected address, and
// drive.file for the prospect sheet. drive.file only covers files this app
// creates, so it stays a non-sensitive scope and adds nothing to the Gmail
// verification burden (see GOOGLE-OAUTH-VERIFICATION.md).
import crypto from 'node:crypto'
import express from 'express'
import { db, logEvent } from './db.js'
import { env, googleConfigured } from './env.js'
import { requireUser, workspace } from './auth.js'
import { suppressionFor, SuppressedError } from './suppression.js'
import { REVIVE_MAILBOX_SQL } from './parity/schema.js'
import { sealSecret, withOpenTokens } from './secrets.js'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/drive.file',
].join(' ')

const redirectUri = () => `${env.APP_URL}/api/google/callback`

function isActiveMailbox(row) {
  return Boolean(row && row.deleted_at == null && row.status === 'connected' && row.refresh_token)
}

// ---- token management -------------------------------------------------------

export async function freshAccessToken(mailbox) {
  // Tokens may be AES-GCM sealed at rest — open them for the provider call.
  mailbox = withOpenTokens(mailbox)
  if (mailbox.token_expiry > Date.now() + 60_000) return mailbox.access_token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: mailbox.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const detail = await res.text()
    // Only a genuinely revoked grant (invalid_grant / invalid_client) is a
    // reason to disable the mailbox and ask for a reconnect. A transient 5xx or
    // 429 from Google's token endpoint used to set status='error' too, which
    // pulled the mailbox out of ALL polling until a human reconnected an account
    // that was never actually broken. Classify: permanent → terminal, needs
    // reconnect; transient → leave it connected and let the next tick retry.
    const permanent = /invalid_grant|invalid_client/i.test(detail)
    if (permanent) {
      db.prepare("UPDATE mailboxes SET status = 'error', needs_reconnect = 1, last_error = ? WHERE id = ?")
        .run(`Reconnect required: ${detail.slice(0, 300)}`, mailbox.id)
      const err = new Error(`gmail token refresh revoked for ${mailbox.email} — reconnect required`)
      err.permanent = true
      throw err
    }
    db.prepare("UPDATE mailboxes SET last_error = ? WHERE id = ?")
      .run(`Token refresh failed (transient ${res.status}): ${detail.slice(0, 260)}`, mailbox.id)
    const err = new Error(`gmail token refresh failed for ${mailbox.email} (transient ${res.status})`)
    err.transient = true
    throw err
  }
  const tokens = await res.json()
  const expiry = Date.now() + (tokens.expires_in || 3600) * 1000
  db.prepare("UPDATE mailboxes SET access_token = ?, token_expiry = ?, status = 'connected', last_error = '', needs_reconnect = 0 WHERE id = ?")
    .run(sealSecret(tokens.access_token), expiry, mailbox.id)
  mailbox.access_token = tokens.access_token
  mailbox.token_expiry = expiry
  return tokens.access_token
}

async function gmailFetch(mailbox, path, options = {}) {
  const token = await freshAccessToken(mailbox)
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`gmail ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

// ---- send -------------------------------------------------------------------

function b64url(str) {
  return Buffer.from(str).toString('base64url')
}

// Suppression lives here, at the transport, and not one layer up.
//
// It used to sit in `mailer.sendEmail`, described as "the one line every send
// passes through". It was not: four call sites reach `gmailSend` directly —
// campaign test-sends, campaign forwards, inbox forwards and the one-off
// sender — so a forward could and did email an address that had asked never to
// be contacted again. An audit proved it: with `competitor.com` blocked, a
// forward to `ana@mail.competitor.com` returned 200 and wrote a message row.
//
// This is the last function before the bytes leave the process, so a check here
// cannot be routed around by adding a fifth caller. `workspaceId` is required
// precisely so that a caller who cannot say whose suppression list applies
// fails loudly at the call site instead of quietly skipping the check.
// MIME headers are ASCII-only (RFC 5322); anything else must ride in an RFC
// 2047 encoded word. Without this, an em dash in a subject went to Gmail as
// raw UTF-8 bytes, Gmail read them as latin-1, and the mojibake round-tripped
// back through reply sync into every "Re:" that followed.
export function encodeHeaderWord(value) {
  const s = String(value || '')
  if (!/[^\x20-\x7E]/.test(s)) return s
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

export async function gmailSend(mailbox, { to, cc = [], bcc = [], subject, body, html, threadId, inReplyTo, listUnsubscribe, workspaceId }) {
  const wsId = workspaceId ?? mailbox?.user_id
  if (!wsId) {
    throw new Error('gmailSend requires workspaceId — refusing to send without a suppression check')
  }
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
    .map((a) => String(a).trim()).filter(Boolean)
  const ccList = list(cc)
  const bccList = list(bcc)

  // `to` may be a comma-joined list (forwards). Every recipient is checked —
  // including cc and bcc, because someone who has asked never to hear from us
  // has not made an exception for being copied. One suppressed address refuses
  // the whole send rather than silently dropping that recipient, because a
  // partial send is a worse surprise than a refused one.
  for (const address of [...list(to), ...ccList, ...bccList]) {
    const bare = (address.match(/<([^>]+)>/) || [null, address])[1]
    const blocked = suppressionFor(wsId, { address: bare })
    if (blocked) throw new SuppressedError(blocked)
  }

  const headers = [
    `From: ${mailbox.display_name ? `${encodeHeaderWord(mailbox.display_name)} <${mailbox.email}>` : mailbox.email}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(subject.replace(/[\r\n]/g, ' '))}`,
    'MIME-Version: 1.0',
  ]
  // Gmail's `messages.send` takes the recipients from the MIME headers and
  // strips `Bcc` from every delivered copy, so both belong here. Sending the
  // blind copies as separate messages instead would duplicate the mail and
  // break threading, which is worse than trusting documented behaviour.
  if (ccList.length) headers.splice(2, 0, `Cc: ${ccList.join(', ')}`)
  if (bccList.length) headers.splice(ccList.length ? 3 : 2, 0, `Bcc: ${bccList.join(', ')}`)
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`)
  }
  if (listUnsubscribe) {
    headers.push(`List-Unsubscribe: <${listUnsubscribe}>`)
    // RFC 8058: tells Gmail/Yahoo the URL accepts a bare POST — required for
    // bulk senders, and what lets the GET stay a harmless confirmation page.
    headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  }
  let mime
  if (html) {
    const boundary = `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    mime =
      headers.join('\r\n') + '\r\n\r\n' +
      `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n` +
      `--${boundary}--`
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8')
    mime = headers.join('\r\n') + '\r\n\r\n' + body
  }
  const raw = b64url(mime)
  const payload = threadId ? { raw, threadId } : { raw }
  const result = await gmailFetch(mailbox, 'messages/send', { method: 'POST', body: JSON.stringify(payload) })
  return { messageId: result.id, threadId: result.threadId }
}

// ---- read -------------------------------------------------------------------

function decodePart(part) {
  if (!part) return ''
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8')
  }
  for (const child of part.parts || []) {
    const text = decodePart(child)
    if (text) return text
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8')
      .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }
  return ''
}

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''

// Fetch a thread and return normalized messages (id, direction, from, subject, body, messageIdHeader).
export async function gmailThread(mailbox, threadId) {
  const thread = await gmailFetch(mailbox, `threads/${threadId}?format=full`)
  return (thread.messages || []).map((msg) => {
    const from = header(msg, 'From')
    const fromEmail = (from.match(/<([^>]+)>/) || [null, from.trim()])[1].toLowerCase()
    return {
      providerMessageId: msg.id,
      messageIdHeader: header(msg, 'Message-ID'),
      direction: fromEmail === mailbox.email.toLowerCase() ? 'out' : 'in',
      fromEmail,
      toEmail: header(msg, 'To'),
      subject: header(msg, 'Subject'),
      body: decodePart(msg.payload) || msg.snippet || '',
      internalDate: Number(msg.internalDate || 0),
    }
  })
}

// Recent inbound mail across the whole mailbox, rather than within one known
// thread. `gmailThread` can only answer "what else is in this conversation",
// which by definition never surfaces a reply that belongs to no conversation
// Harry started — and those are exactly the ones a human needs to see
// (server/upkeep.js turns them into the Inbox's untracked-replies list).
//
// Deliberately bounded: a window in days and a hard cap on messages, so a
// mailbox with ten years of history costs the same as a fresh one. The list
// call is cheap; only the capped detail fetches are not.
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

export async function gmailRecentInbound(mailbox, { withinDays = 2, max = 25, sinceMs = 0 } = {}) {
  // Include spam — a mis-filtered reply is still a reply. Curly-brace OR is the
  // Gmail-search form; `(in:inbox OR in:spam)` is rejected by the API.
  //
  // With a persisted watermark (`sinceMs`, the last-seen internalDate) fetch
  // everything AFTER it via `after:` and PAGE through nextPageToken. The old
  // fixed `newer_than:3d, maxResults:20` lost replies whenever a mailbox was
  // offline for more than three days or received more than twenty messages
  // between sweeps; the watermark closes both gaps. With no watermark yet (a
  // mailbox's first sweep) it falls back to the day window, but still pages.
  const base = sinceMs
    ? `-from:me after:${Math.floor(sinceMs / 1000)} {in:inbox in:spam}`
    : `-from:me newer_than:${Math.max(1, withinDays)}d {in:inbox in:spam}`
  const query = encodeURIComponent(base)
  // A watermark sweep may need to catch up on a large backlog, so raise the cap;
  // a first sweep stays bounded by `max`.
  const hardCap = sinceMs ? Math.max(max, 250) : Math.max(1, max)

  const ids = []
  let pageToken = ''
  for (let page = 0; page < 20 && ids.length < hardCap; page++) {
    const path = `messages?q=${query}&maxResults=${Math.min(100, hardCap)}${pageToken ? `&pageToken=${pageToken}` : ''}`
    const list = await gmailFetch(mailbox, path)
    for (const m of list.messages || []) ids.push(m.id)
    pageToken = list.nextPageToken || ''
    if (!pageToken) break
  }
  const capped = ids.slice(0, hardCap)
  if (!capped.length) return []

  // Full fetches in parallel — sequential was hanging Sync replies for minutes
  // on a busy inbox (and stacking with the Inbox 10s poll).
  const rows = await mapPool(capped, 5, async (id) => {
    try {
      const msg = await gmailFetch(mailbox, `messages/${id}?format=full`)
      const from = header(msg, 'From')
      const fromEmail = (from.match(/<([^>]+)>/) || [null, from.trim()])[1].toLowerCase()
      if (fromEmail === mailbox.email.toLowerCase()) return null
      return {
        providerMessageId: msg.id,
        threadId: msg.threadId || '',
        messageIdHeader: header(msg, 'Message-ID'),
        fromEmail,
        toEmail: header(msg, 'To'),
        subject: header(msg, 'Subject'),
        body: decodePart(msg.payload) || msg.snippet || '',
        // Unix ms — the caller advances the per-mailbox watermark to the newest.
        internalDate: Number(msg.internalDate || 0),
        receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : '',
      }
    } catch {
      return null
    }
  })
  return rows.filter(Boolean)
}

// ---- OAuth routes -----------------------------------------------------------

export const googleRouter = express.Router()
const pendingStates = new Map() // state -> { userId, expiry }

googleRouter.get('/api/google/connect', requireUser, workspace, (req, res) => {
  if (!googleConfigured()) return res.redirect('/app/connections?error=google_not_configured')

  const hint = String(req.query.email || '').trim().toLowerCase()
  if (hint) {
    const existing = db.prepare(
      "SELECT * FROM mailboxes WHERE user_id = ? AND provider = 'gmail' AND email = ? AND deleted_at IS NULL"
    ).get(req.wsId, hint)
    if (isActiveMailbox(existing)) {
      return res.redirect(
        `/app/connections?already_connected=1&email=${encodeURIComponent(hint)}`
      )
    }
  }

  const state = crypto.randomBytes(16).toString('hex')
  pendingStates.set(state, { userId: req.wsId, expiry: Date.now() + 10 * 60 * 1000 })
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent') // always get a refresh token
  url.searchParams.set('state', state)
  if (hint) url.searchParams.set('login_hint', hint)
  res.redirect(url.toString())
})

googleRouter.get('/api/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query
    if (error) {
      const msg = error === 'access_denied'
        ? 'Google blocked access — add your Gmail as a Test user on the OAuth consent screen (or finish Google verification). See GOOGLE-OAUTH-VERIFICATION.md'
        : String(error)
      return res.redirect(`/app/connections?error=${encodeURIComponent(msg)}`)
    }
    const pending = pendingStates.get(state)
    pendingStates.delete(state)
    for (const [s, p] of pendingStates) if (p.expiry < Date.now()) pendingStates.delete(s)
    if (!pending || pending.expiry < Date.now()) return res.redirect('/app/connections?error=invalid_state')

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(),
      }),
    })
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`)
    const tokens = await tokenRes.json()

    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (!infoRes.ok) throw new Error(`userinfo failed: ${await infoRes.text()}`)
    const info = await infoRes.json()

    const expiry = Date.now() + (tokens.expires_in || 3600) * 1000
    const email = info.email.toLowerCase()
    const existing = db.prepare("SELECT * FROM mailboxes WHERE user_id = ? AND provider = 'gmail' AND email = ?")
      .get(pending.userId, email)

    if (isActiveMailbox(existing)) {
      return res.redirect(
        `/app/connections?already_connected=1&email=${encodeURIComponent(email)}`
      )
    }

    if (existing) {
      // A removed mailbox is revived rather than left marked: the row is still
      // there because the delete is soft, and UNIQUE (user_id, provider, email)
      // means reconnecting cannot make a second one. Warm-up restarts from the
      // beginning — Docs/email-accounts/delete.md TC-11.
      if (String(existing.deleted_at || '') !== '') {
        db.prepare(REVIVE_MAILBOX_SQL).run(info.name || existing.display_name, existing.id)
      }
      db.prepare(
        "UPDATE mailboxes SET access_token = ?, refresh_token = COALESCE(NULLIF(?, ''), refresh_token), token_expiry = ?, status = 'connected', last_error = '', display_name = ? WHERE id = ?"
      ).run(sealSecret(tokens.access_token), sealSecret(tokens.refresh_token || ''), expiry, info.name || existing.display_name, existing.id)
    } else {
      db.prepare(
        "INSERT INTO mailboxes (user_id, provider, email, display_name, access_token, refresh_token, token_expiry, deleted_at) VALUES (?, 'gmail', ?, ?, ?, ?, ?, NULL)"
      ).run(pending.userId, email, info.name || '', sealSecret(tokens.access_token), sealSecret(tokens.refresh_token || ''), expiry)
    }
    logEvent(pending.userId, { type: 'mailbox_connected', detail: `gmail:${email}` })
    res.redirect('/app/connections?connected=1')
  } catch (err) {
    console.error('[google] callback error', err)
    res.redirect(`/app/connections?error=${encodeURIComponent('Google connection failed — check server logs')}`)
  }
})
