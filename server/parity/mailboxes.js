// Mailbox fleet management and sender health — Docs/email-accounts/*.
//
// Harry already had a Mailboxes page that could connect Gmail, set a daily
// limit and show a status word. This module is that page growing up: one
// filtered fleet list, a per-mailbox detail, a suspension switch that every
// send path respects, configurable warm-up, and a dense day-by-day warm-up
// series. Nothing here invents a second sending rhythm — `server/pacing.js`
// stays the single authority on when a mailbox may send, and every figure this
// module reports is derived from `dailyCap`/`isWarmingUp` rather than
// recomputed, so the API cannot drift from what the engine actually does.
//
// Three things are deliberately different from the source API:
//
//   1. **No credential ever passes through here.** SmartLead's `save` endpoint
//      takes a plaintext SMTP password and its `get-by-id` hands it back
//      base64-encoded. Harry does neither. Gmail stays on OAuth in
//      server/google.js; the SMTP body is validated and then *discarded* — the
//      password is never stored, never logged and never echoed. Every read path
//      selects an explicit column list, so a secret cannot leak by accident
//      even if a new column appears.
//   2. **Cross-workspace is 404, not 400.** suspend/unsuspend document a 400
//      "not found or does not belong to you", which confirms the shape of the
//      failure. Harry answers 404 through `notFound()` like every other parity
//      module, so an id from another workspace is indistinguishable from one
//      that never existed.
//   3. **Warm-up can only tighten the cap, never loosen it.** `dailyCap()` in
//      pacing.js is the binding constraint. A warm-up daily count sits *under*
//      it as an extra user-set ceiling; turning warm-up off does not hand a
//      brand-new mailbox its full allowance on day one.
//
// Routes owned here (`GET /api/mailboxes` and `PUT /api/mailboxes/:id` belong
// to server/routes.js and are not redefined):
//
//   GET    /api/mailboxes/fleet             filtered, paged fleet list
//   GET    /api/mailboxes/tags              mailbox label master list (read-only)
//   POST   /api/mailboxes                   add a mailbox (OAuth / SMTP / sandbox)
//   GET    /api/mailboxes/:id               one mailbox, with warm-up and usage
//   PATCH  /api/mailboxes/:id               partial update of the safe field set
//   POST   /api/mailboxes/:id/test          re-run the connection check
//   PUT    /api/mailboxes/:id/suspend       stop this mailbox sending
//   DELETE /api/mailboxes/:id/suspend       put it back to work, re-checking first
//   PUT    /api/mailboxes/:id/warmup        warm-up settings
//   GET    /api/mailboxes/:id/warmup-stats  dense daily series

import { db } from '../db.js'
import { googleConfigured } from '../env.js'
import { canSendNow, dailyCap, isWarmingUp, sendWindow } from '../pacing.js'
import {
  HttpError, invalid, notFound, handler,
  str, int, bool, oneOf, email as emailField,
  owned, tx, audit, meter,
} from './http.js'

// The documented ceiling on the fleet list. A request above it is refused
// rather than served, per Docs/README "unbounded requests are rejected".
const MAX_LIMIT = 100

// Warm-up ranges, straight from Docs/email-accounts/warmup-settings.md.
const WARMUP_COUNT = { min: 1, max: 50 }
const RAMP_STEP = { min: 5, max: 20 }
const REPLY_RATE = { min: 20, max: 100 }

// Harry's own daily-limit bounds, matching the existing PUT /mailboxes/:id.
const DAILY_LIMIT = { min: 1, max: 2000 }

// Health guidance the warm-up panel states in words rather than leaving the
// user to know what good looks like.
const SPAM_THRESHOLD_PCT = 2
const REPUTATION_TARGET = 90

// Only these columns are ever read. access_token, refresh_token and anything
// else credential-shaped is excluded at the query level, not deleted from an
// object afterwards — the difference matters the day someone adds a column.
const SAFE_COLUMNS = `
  id, user_id, provider, email, display_name, status, daily_limit,
  sent_today, sent_today_date, last_error, last_sync_at, created_at, next_send_at,
  is_suspended, suspended_at, suspended_reason,
  warmup_enabled, warmup_daily_count, warmup_ramp_enabled, warmup_ramp_step,
  warmup_target_reply_rate, warmup_auto_adjust,
  signature, client_id, tracking_domain, message_per_day, token_expiry,
  (refresh_token IS NOT NULL AND refresh_token != '') AS has_refresh_token
`

// A 422 has to name the field the user actually sent, and the source API and
// Harry disagree on spelling for most of them (`max_email_per_day` versus
// `dailyLimit`). This wraps a raw value back into a one-key body so the shared
// validators in http.js report the name that was on the wire.
const as = (field, value) => ({ [field]: value })

// A body field that looks like a credential is refused outright. Changing a
// password is a reconnect, not a settings edit.
const CREDENTIAL_FIELDS = [
  'password', 'imap_password', 'imapPassword', 'smtp_password', 'smtpPassword',
  'app_password', 'appPassword', 'secret', 'client_secret', 'clientSecret',
  'access_token', 'accessToken', 'refresh_token', 'refreshToken', 'token',
  'credentials', 'api_key', 'apiKey',
]

function rejectCredentials(body) {
  for (const field of CREDENTIAL_FIELDS) {
    if (body && Object.prototype.hasOwnProperty.call(body, field)) {
      throw invalid(field, `${field} cannot be set here — reconnect the mailbox instead`)
    }
  }
}

// ---- small shared pieces ----------------------------------------------------

// A non-numeric id is a validation failure, not a missing record: every spec in
// this category has a TC-4 saying "422 with a field-level message, no lookup
// performed". Only once the id is well-formed does ownership decide 404.
function mailboxId(req) {
  const raw = req.params.id
  if (!/^\d+$/.test(String(raw))) throw invalid('id', 'id must be a positive integer')
  return Number(raw)
}

function loadMailbox(req) {
  const id = mailboxId(req)
  const row = db.prepare(`SELECT ${SAFE_COLUMNS} FROM mailboxes WHERE id = ? AND user_id = ?`)
    .get(id, req.wsId)
  if (!row) throw notFound('email account')
  return row
}

function owner(wsId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(wsId)
}

// Day buckets follow the workspace's timezone — the same one pacing.js opens
// and closes the sending window on — so a day never appears twice or vanishes.
function workspaceZone(ownerRow, override = '') {
  const tz = override || ownerRow?.send_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    return tz
  } catch {
    throw invalid('timezone', `timezone is not a recognised IANA zone: ${tz}`)
  }
}

function dayIn(tz, at) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at))
}

function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

// ---- health -----------------------------------------------------------------

// Harry has one connection and one `last_error`, not SmartLead's two legs. The
// send leg is the connection; the read leg additionally needs a refresh token,
// because a Gmail mailbox that cannot refresh can send until the hour is out
// and then stops reading replies for good. Reporting them separately is what
// lets a row say "cannot read replies" instead of a bare "error".
function health(m) {
  const connected = m.status === 'connected'
  const canRead = connected && !(m.provider === 'gmail' && !m.has_refresh_token)
  return {
    isSmtpSuccess: connected,
    isImapSuccess: canRead,
    smtpFailureError: connected ? '' : (m.last_error || 'Mailbox is disconnected'),
    imapFailureError: canRead ? ''
      : connected ? 'No refresh token — reconnect so Harry can keep reading replies'
      : (m.last_error || 'Mailbox is disconnected'),
  }
}

// One switch, every path. Suspension beats everything; a broken connection
// beats a healthy-looking flag. Exported because "excluded from every send" has
// to be a thing other code can ask, not a rule written twice.
export function sendableMailboxes(wsId, now = Date.now()) {
  const rows = db.prepare(`SELECT ${SAFE_COLUMNS} FROM mailboxes WHERE user_id = ? ORDER BY id`).all(wsId)
  return rows.filter((m) => isSendable(m, now))
}

export function isSendable(m, now = Date.now()) {
  if (m.is_suspended) return false
  if (m.status !== 'connected') return false
  return dailyCap(m, now) > 0
}

// Why this mailbox is contributing nothing, in the voice pacing.js uses when it
// holds a campaign back. `canSendNow` already explains the clock, the spacing
// and the ceiling; suspension and disconnection are the two it cannot see.
function holdReason(ownerRow, m, now = Date.now()) {
  if (m.is_suspended) {
    return m.suspended_reason
      ? `suspended — ${m.suspended_reason}`
      : 'suspended — switched off by hand'
  }
  if (m.status !== 'connected') return m.last_error ? `reconnect needed — ${m.last_error}` : 'reconnect needed'
  const slot = canSendNow(ownerRow, m, now)
  return slot.ok ? '' : slot.reason
}

function sendingStatus(ownerRow, m, now = Date.now()) {
  const blocked = holdReason(ownerRow, m, now)
  const slot = canSendNow(ownerRow, m, now)
  return {
    ok: !blocked,
    reason: blocked,
    until: slot.until ? new Date(slot.until).toISOString() : null,
    cap: effectiveCap(m, now),
    pacingCap: dailyCap(m, now),
    dailyLimit: m.daily_limit,
    sentToday: sentToday(m, now),
    remainingToday: Math.max(0, effectiveCap(m, now) - sentToday(m, now)),
    warmingUp: isWarmingUp(m, now),
    paced: sendWindow(ownerRow).on && m.provider === 'gmail',
  }
}

// ---- warm-up ----------------------------------------------------------------

// pacing.js counts the day at UTC midnight (mailer keys `sent_today_date` on
// the ISO date), so today's figure is read the same way rather than in the
// workspace's zone — otherwise the number here and the number the engine
// enforces would disagree either side of midnight.
function sentToday(m, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10)
  return m.sent_today_date === today ? m.sent_today : 0
}

// The ceiling that actually binds. pacing.js's ramp always applies; a warm-up
// daily count is an *extra*, tighter ceiling a user may set on top of it. That
// ordering is the whole point: a fragile domain can be slowed down, and no
// setting on this route can turn a mailbox connected an hour ago into a blast.
export function effectiveCap(m, now = Date.now()) {
  const pacing = dailyCap(m, now)
  if (m.provider !== 'gmail') return pacing
  if (!m.warmup_enabled) return pacing
  return Math.max(1, Math.min(pacing, m.warmup_daily_count))
}

// Warm-up does not apply to a sandbox mailbox — it exists to be tested in
// seconds, and zeros pretending to be measurements would be worse than saying so.
const warmupApplies = (m) => m.provider === 'gmail'

function warmupStatus(m, now = Date.now()) {
  if (!warmupApplies(m)) return null
  if (m.is_suspended) return 'PAUSED'
  if (m.warmup_enabled) return 'ACTIVE'
  // Harry's default: a new Gmail mailbox ramps whether or not anyone has ever
  // opened this panel. Reporting that as INACTIVE would be a lie.
  return isWarmingUp(m, now) ? 'ACTIVE' : 'INACTIVE'
}

// The reputation number, written down so support can explain it:
//   60 points for landing in the inbox, 40 for replies at the target rate,
//   minus 2 points for every 1% of sends that were marked spam.
// No sends means no score — null, never a confident-looking zero.
export function reputationScore({ sent, inbox, spam, received }, targetReplyRate = 30) {
  if (!sent) return null
  const delivered = Math.min(1, inbox / sent)
  const replyRate = received / sent
  const target = Math.max(1, targetReplyRate) / 100
  const spamRate = spam / sent
  const raw = 60 * delivered + 40 * Math.min(1, replyRate / target) - 200 * spamRate
  return Math.max(0, Math.min(100, Math.round(raw)))
}

function warmupTotals(mailboxId) {
  return db.prepare(
    `SELECT COALESCE(SUM(sent), 0) sent, COALESCE(SUM(received), 0) received,
            COALESCE(SUM(spam), 0) spam, COALESCE(SUM(inbox), 0) inbox
       FROM warmup_stats WHERE mailbox_id = ?`
  ).get(mailboxId)
}

function warmupDetails(m, now = Date.now()) {
  if (!warmupApplies(m)) {
    return { status: null, appliesTo: false, note: 'Warm-up does not apply to sandbox mailboxes — the daily limit still applies' }
  }
  const totals = warmupTotals(m.id)
  const target = m.warmup_target_reply_rate || REPLY_RATE.min
  const blocked = Boolean(m.is_suspended) || m.status !== 'connected'
  // Ramp floor: what pacing.js would allow on the mailbox's connection day.
  // Derived rather than copied, so the constant can never fall out of step.
  const connectedAt = Date.parse(String(m.created_at || '').replace(' ', 'T') + 'Z') || now
  return {
    status: warmupStatus(m, now),
    appliesTo: true,
    warmupMinCount: dailyCap(m, connectedAt),
    warmupMaxCount: effectiveCapCeiling(m),
    dailyCountToday: effectiveCap(m, now),
    rampEnabled: Boolean(m.warmup_ramp_enabled),
    rampStep: m.warmup_ramp_step,
    autoAdjust: Boolean(m.warmup_auto_adjust),
    targetReplyRate: target,
    replyRate: totals.sent ? Math.round((totals.received / totals.sent) * 1000) / 10 : 0,
    totalSentCount: totals.sent,
    totalSpamCount: totals.spam,
    warmupReputation: reputationScore(totals, target),
    isWarmupBlocked: blocked,
    blockedReason: blocked
      ? (m.is_suspended
        ? (m.suspended_reason || 'Mailbox is suspended')
        : (m.last_error || 'Mailbox is disconnected'))
      : '',
  }
}

// The ceiling warm-up will climb to: the mailbox's own limit, or the tighter
// figure the user chose.
function effectiveCapCeiling(m) {
  if (!m.warmup_enabled) return m.daily_limit
  return Math.max(1, Math.min(m.daily_limit, m.warmup_daily_count))
}

// ---- signature and tracking domain -----------------------------------------

const SIGNATURE_TAGS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'span', 'div', 'hr'])

// Strict allowlist. Anything not on it is dropped rather than escaped, because
// a signature is decoration and a surprise <script> is not worth rendering.
// The opt-out line mailer.js appends is unaffected — this only ever produces a
// smaller string than it was given.
export function sanitizeSignature(html) {
  if (!html) return ''
  let out = String(html)
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*>/gi, '')
  out = out.replace(/<\/?\s*([a-zA-Z0-9]+)([^>]*)>/g, (match, tag, attrs) => {
    const name = tag.toLowerCase()
    if (!SIGNATURE_TAGS.has(name)) return ''
    if (match.startsWith('</')) return `</${name}>`
    if (name === 'a') {
      const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs)
      const url = (href?.[1] ?? href?.[2] ?? '').trim()
      const safe = /^(https?:|mailto:)/i.test(url) ? url.replace(/"/g, '&quot;') : ''
      return safe ? `<a href="${safe}" rel="noopener noreferrer">` : '<a>'
    }
    return `<${name}>`
  })
  return out.trim()
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

function trackingDomain(body, field) {
  const raw = str(body, field, { max: 253 })
  if (!raw) return ''
  const bare = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim()
  if (!HOSTNAME_RE.test(bare)) {
    throw invalid(field, `${field} must be a hostname such as links.example.com`)
  }
  return bare.toLowerCase()
}

// ---- shared fleet queries ---------------------------------------------------
//
// Every one of these runs once per request regardless of fleet size, so the
// list is a constant number of queries and never N+1 per row.

function campaignCounts(wsId) {
  const rows = db.prepare(
    `SELECT mailbox_id, COUNT(*) n FROM (
       SELECT DISTINCT c.id AS cid, c.mailbox_id AS mailbox_id
         FROM campaigns c
        WHERE c.user_id = ? AND c.mailbox_id IS NOT NULL AND COALESCE(c.deleted_at, '') = ''
       UNION
       SELECT DISTINCT cm.campaign_id, cm.mailbox_id
         FROM campaign_mailboxes cm JOIN campaigns c ON c.id = cm.campaign_id
        WHERE c.user_id = ? AND COALESCE(c.deleted_at, '') = ''
     ) GROUP BY mailbox_id`
  ).all(wsId, wsId)
  return new Map(rows.map((r) => [r.mailbox_id, r.n]))
}

function campaignIdsByMailbox(wsId) {
  const rows = db.prepare(
    `SELECT DISTINCT mailbox_id, cid, name, status FROM (
       SELECT c.mailbox_id AS mailbox_id, c.id AS cid, c.name AS name, c.status AS status
         FROM campaigns c
        WHERE c.user_id = ? AND c.mailbox_id IS NOT NULL AND COALESCE(c.deleted_at, '') = ''
       UNION
       SELECT cm.mailbox_id, c.id, c.name, c.status
         FROM campaign_mailboxes cm JOIN campaigns c ON c.id = cm.campaign_id
        WHERE c.user_id = ? AND COALESCE(c.deleted_at, '') = ''
     ) ORDER BY cid`
  ).all(wsId, wsId)
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.mailbox_id)) map.set(r.mailbox_id, [])
    map.get(r.mailbox_id).push({ id: r.cid, name: r.name, status: r.status })
  }
  return map
}

// Labels are read here and only here: tag CRUD lives in server/parity/tags.js.
function tagsByMailbox(wsId) {
  const rows = db.prepare(
    `SELECT mm.mailbox_id AS mailboxId, t.id AS id, t.name AS name, t.color AS color
       FROM mailbox_tag_map mm JOIN tags t ON t.id = mm.tag_id
      WHERE mm.workspace_id = ? AND t.applies_to = 'mailbox'
      ORDER BY t.name`
  ).all(wsId)
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.mailboxId)) map.set(r.mailboxId, [])
    map.get(r.mailboxId).push({ id: r.id, name: r.name, color: r.color })
  }
  return map
}

// ---- serialisation ----------------------------------------------------------

function serialise(ownerRow, m, { tags = [], campaignCount = 0, campaigns = null, now = Date.now() } = {}) {
  const h = health(m)
  return {
    id: m.id,
    fromName: m.display_name || '',
    fromEmail: m.email,
    type: m.provider.toUpperCase(),
    provider: m.provider,
    status: m.status,
    isSuspended: Boolean(m.is_suspended),
    suspendedAt: m.suspended_at || null,
    suspendedReason: m.suspended_reason || '',
    messagePerDay: m.daily_limit,
    dailySentCount: sentToday(m, now),
    remainingToday: Math.max(0, effectiveCap(m, now) - sentToday(m, now)),
    ...h,
    lastSyncAt: m.last_sync_at || null,
    createdAt: m.created_at,
    signature: m.signature || '',
    trackingDomain: m.tracking_domain || '',
    clientId: m.client_id || null,
    campaignCount,
    ...(campaigns ? { campaigns, campaignIds: campaigns.map((c) => c.id) } : {}),
    tags,
    warmupDetails: warmupDetails(m, now),
    sending: sendingStatus(ownerRow, m, now),
    sendable: isSendable(m, now),
  }
}

// ---- connection check -------------------------------------------------------

// What can honestly be checked without a network round trip: the stored state
// of the connection. A Gmail mailbox with no refresh token or an expired access
// token cannot send at the next tick, and saying so before the campaign fails
// is the entire point of the "Reconnect needed" state. When Google is not
// configured at all the check reports that rather than inventing a verdict —
// the same graceful degradation server/google.js already practises.
function connectionCheck(m) {
  const h = health(m)
  const checks = []
  if (m.provider === 'gmail') {
    if (!googleConfigured()) {
      checks.push({
        leg: 'oauth', ok: false, checked: false,
        detail: 'Google OAuth is not configured on this server — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
      })
    } else {
      checks.push({ leg: 'oauth', ok: Boolean(m.has_refresh_token), checked: true,
        detail: m.has_refresh_token ? 'Refresh token present' : 'No refresh token — reconnect required' })
      if (m.token_expiry > 0 && m.token_expiry < Date.now() && !m.has_refresh_token) {
        checks.push({ leg: 'oauth', ok: false, checked: true, detail: 'Access token has expired and cannot be refreshed' })
      }
    }
  } else {
    checks.push({ leg: 'sandbox', ok: true, checked: true, detail: 'Sandbox mailboxes deliver locally' })
  }
  checks.push({ leg: 'send', ok: h.isSmtpSuccess, checked: true, detail: h.smtpFailureError || 'Ready to send' })
  checks.push({ leg: 'read', ok: h.isImapSuccess, checked: true, detail: h.imapFailureError || 'Ready to read replies' })
  return { ok: checks.every((c) => c.ok || !c.checked), checks, ...h }
}

// Campaigns this mailbox is the last working sender for. A campaign that goes
// quiet must be able to say why, in the same voice pacing.js uses.
function campaignsHeldBy(wsId, m, now = Date.now()) {
  // A mailbox that can send holds nothing back, whatever else is attached.
  if (isSendable(m, now)) return []
  const ownerRow = owner(wsId)
  const campaigns = (campaignIdsByMailbox(wsId).get(m.id) || [])
    .filter((c) => c.status === 'running' || c.status === 'paused')
  const held = []
  for (const c of campaigns) {
    const others = db.prepare(
      `SELECT ${SAFE_COLUMNS} FROM mailboxes
        WHERE user_id = ? AND id != ?
          AND (id IN (SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = ?)
               OR id = (SELECT mailbox_id FROM campaigns WHERE id = ?))`
    ).all(wsId, m.id, c.id, c.id)
    if (others.some((o) => isSendable(o, now))) continue
    held.push({
      campaignId: c.id,
      name: c.name,
      holding: true,
      reason: `holding — ${holdReason(ownerRow, m, now) || 'no mailbox available'} (${m.email})`,
    })
  }
  return held
}

// ---- routes -----------------------------------------------------------------

export function register(api) {
  // ---- GET /api/mailboxes/fleet ---------------------------------------------
  // The fleet list. `GET /api/mailboxes` is server/routes.js's simpler shape and
  // stays exactly as it was; this is the filtered, paged, tag-aware version the
  // Mailboxes page, the campaign mailbox picker and Monitoring all read.
  api.get('/mailboxes/fleet', handler(async (req) => {
    const started = Date.now()
    const now = Date.now()

    // The documented bound, with the documented message. `limit=500` is refused
    // rather than quietly clamped, so a client cannot believe it got everything.
    const rawLimit = req.query.limit
    if (rawLimit !== undefined && rawLimit !== '' && Number(rawLimit) > MAX_LIMIT) {
      throw invalid('limit', `limit must be less than or equal to ${MAX_LIMIT}`)
    }
    const limit = int(req.query, 'limit', { min: 1, max: MAX_LIMIT, fallback: MAX_LIMIT })
    const offset = int(req.query, 'offset', { min: 0, fallback: 0 })

    const provider = oneOf(req.query, 'provider', ['gmail', 'sandbox'], { fallback: '' })
    const esp = oneOf(req.query, 'esp', ['GMAIL', 'SANDBOX'], { fallback: '' })
    const warmup = oneOf(req.query, 'warmup', ['ACTIVE', 'INACTIVE', 'PAUSED'], { fallback: '' })
    const q = str(req.query, 'q', { max: 320 }) || str(req.query, 'username', { max: 320 })
    const tagId = int(req.query, 'tagId', { min: 1, fallback: 0 })
    // The client lens — see the same parameter on the campaigns and leads lists.
    const clientId = int(req.query, 'clientId', { min: 1, fallback: 0 })
    const withCampaigns = bool(req.query, 'withCampaigns', false)
    const has = (field) => req.query[field] !== undefined && req.query[field] !== ''
    const wantSmtp = has('isSmtpSuccess') ? bool(req.query, 'isSmtpSuccess') : null
    const wantImap = has('isImapSuccess') ? bool(req.query, 'isImapSuccess') : null
    const wantInUse = has('isInUse') ? bool(req.query, 'isInUse') : null
    const wantBlocked = has('isWarmupBlocked') ? bool(req.query, 'isWarmupBlocked') : null
    const wantSuspended = has('isSuspended') ? bool(req.query, 'isSuspended') : null
    const wantSendable = has('sendable') ? bool(req.query, 'sendable') : null

    const ownerRow = owner(req.wsId)
    let rows = clientId
      ? db.prepare(`SELECT ${SAFE_COLUMNS} FROM mailboxes WHERE user_id = ? AND client_id = ? ORDER BY id`).all(req.wsId, clientId)
      : db.prepare(`SELECT ${SAFE_COLUMNS} FROM mailboxes WHERE user_id = ? ORDER BY id`).all(req.wsId)
    const counts = campaignCounts(req.wsId)
    const tags = tagsByMailbox(req.wsId)
    // Joined only when asked, so the default response stays small.
    const campaignMap = withCampaigns ? campaignIdsByMailbox(req.wsId) : null

    let items = rows.map((m) => serialise(ownerRow, m, {
      tags: tags.get(m.id) || [],
      campaignCount: counts.get(m.id) || 0,
      campaigns: campaignMap ? (campaignMap.get(m.id) || []) : null,
      now,
    }))

    const applied = []
    const keep = (label, fn) => { applied.push(label); items = items.filter(fn) }
    if (provider) keep(`provider=${provider}`, (r) => r.provider === provider)
    if (esp) keep(`esp=${esp}`, (r) => r.type === esp)
    if (q) keep(`matching "${q}"`, (r) => r.fromEmail.toLowerCase().includes(q.toLowerCase())
      || r.fromName.toLowerCase().includes(q.toLowerCase()))
    if (tagId) keep(`tag ${tagId}`, (r) => r.tags.some((t) => t.id === tagId))
    if (wantSmtp !== null) keep(wantSmtp ? 'sending healthy' : 'needs attention', (r) => r.isSmtpSuccess === wantSmtp)
    if (wantImap !== null) keep(wantImap ? 'reading healthy' : 'cannot read replies', (r) => r.isImapSuccess === wantImap)
    if (wantInUse !== null) keep(wantInUse ? 'in use' : 'unused', (r) => (r.campaignCount > 0) === wantInUse)
    if (wantBlocked !== null) keep(wantBlocked ? 'warm-up blocked' : 'warm-up not blocked',
      (r) => Boolean(r.warmupDetails.isWarmupBlocked) === wantBlocked)
    if (wantSuspended !== null) keep(wantSuspended ? 'suspended' : 'active', (r) => r.isSuspended === wantSuspended)
    if (wantSendable !== null) keep(wantSendable ? 'sendable' : 'not sendable', (r) => r.sendable === wantSendable)
    if (warmup) keep(`warm-up ${warmup}`, (r) => r.warmupDetails.status === warmup)

    const total = items.length
    const pageItems = items.slice(offset, offset + limit)
    meter('mailboxes.fleet', Date.now() - started, true, `n=${pageItems.length}/${total}`)

    return {
      ok: true,
      data: pageItems,
      total,
      offset,
      limit,
      hasMore: offset + pageItems.length < total,
      googleConfigured: googleConfigured(),
      // "Which filter emptied this" is what stops a filtered-empty list looking
      // like a workspace that has never connected anything.
      filters: applied,
      emptyReason: total === 0 && applied.length
        ? `No mailboxes match ${applied.join(' + ')}`
        : total === 0 ? 'No mailboxes connected yet' : '',
    }
  }))

  // ---- GET /api/mailboxes/tags ----------------------------------------------
  // The master list of mailbox labels, so the filter strip, the picker and the
  // row chips all offer the same set with the same colours. Read-only: creating
  // and assigning labels belongs to server/parity/tags.js. Docs marks this
  // "Invisible — no UI"; it exists to serve those three surfaces.
  api.get('/mailboxes/tags', handler(async (req) => {
    const rows = db.prepare(
      `SELECT t.id AS id, t.name AS name, t.color AS color,
              (SELECT COUNT(*) FROM mailbox_tag_map mm WHERE mm.tag_id = t.id) AS mailboxCount
         FROM tags t
        WHERE t.workspace_id = ? AND t.applies_to = 'mailbox'
        ORDER BY t.name`
    ).all(req.wsId)
    // A label attached to nothing is still returned: this is the master list,
    // independent of assignment.
    return { ok: true, appliesTo: 'mailbox', data: rows }
  }))

  // ---- POST /api/mailboxes ---------------------------------------------------
  // Adding a mailbox. Three shapes arrive here and only one of them can be
  // completed by this route, which it says plainly rather than half-doing.
  api.post('/mailboxes', handler(async (req, res) => {
    const body = req.body || {}
    const type = (str(body, 'type', { max: 32 }) || str(body, 'provider', { max: 32 }) || 'GMAIL').toUpperCase()
    if (!['GMAIL', 'OUTLOOK', 'SMTP', 'SANDBOX'].includes(type)) {
      throw invalid('type', 'type must be one of [GMAIL, OUTLOOK, SMTP, SANDBOX]')
    }

    if (type === 'SANDBOX') {
      const name = str(body, 'fromName', { max: 120, fallback: '' }) || str(body, 'from_name', { max: 120, fallback: 'Sandbox Sender' })
      const address = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@sandbox.local`
      const existing = db.prepare("SELECT id FROM mailboxes WHERE user_id = ? AND provider = 'sandbox' AND email = ?")
        .get(req.wsId, address)
      if (existing) throw new HttpError(409, { error: 'conflict', message: 'A sandbox mailbox with that name already exists', id: existing.id })
      const info = tx(() => db.prepare(
        "INSERT INTO mailboxes (user_id, provider, email, display_name) VALUES (?, 'sandbox', ?, ?)"
      ).run(req.wsId, address, name))
      audit(req, { type: 'mailbox_connected', detail: `sandbox:${address}` })
      const row = db.prepare(`SELECT ${SAFE_COLUMNS} FROM mailboxes WHERE id = ?`).get(info.lastInsertRowid)
      return { ok: true, data: serialise(owner(req.wsId), row) }
    }

    if (type === 'GMAIL') {
      // OAuth is never completed by posting tokens at an API. Consent happens on
      // Google's screen and the callback in server/google.js writes the row —
      // that is why no access_token or refresh_token is accepted in this body.
      rejectCredentials(body)
      const address = emailField(body, 'fromEmail', { fallback: '' }) || emailField(body, 'from_email', { fallback: '' })
      if (!googleConfigured()) {
        const missing = []
        if (!process.env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID')
        if (!process.env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET')
        res.status(503)
        return {
          ok: false,
          configured: false,
          errorCode: 'GOOGLE_NOT_CONFIGURED',
          missing,
          message: `Connecting Gmail needs Google OAuth configured on this server — missing ${missing.join(' and ')}. Sandbox mailboxes still work.`,
        }
      }
      // Reconnecting an address that already exists updates that row rather than
      // creating a duplicate, which is what the `id` on the source body is for.
      const existing = address
        ? db.prepare("SELECT id FROM mailboxes WHERE user_id = ? AND provider = 'gmail' AND email = ?").get(req.wsId, address)
        : null
      return {
        ok: true,
        configured: true,
        next: 'consent',
        consentUrl: '/api/google/connect',
        mailboxId: existing?.id || null,
        message: existing
          ? 'That address is already connected — consenting again replaces its tokens and keeps its warm-up progress'
          : 'Complete Google consent to finish connecting this mailbox',
      }
    }

    if (type === 'OUTLOOK') {
      res.status(501)
      return {
        ok: false,
        supported: false,
        errorCode: 'PROVIDER_UNAVAILABLE',
        message: 'Outlook is not a provider this build can send from — the mailboxes table accepts gmail and sandbox only',
      }
    }

    // SMTP. Every field is validated so the form can point at one setting rather
    // than eight, and then the credentials are dropped on the floor: this build
    // has no SMTP/IMAP client and the mailboxes.provider constraint accepts only
    // gmail|sandbox, so there is nowhere honest to put them. The password is
    // never written to the database, to an events row, to telemetry, or to this
    // response — the whole point of validating without persisting.
    const fromName = str(body, 'fromName', { max: 120 }) || str(body, 'from_name', { required: true, max: 120 })
    const fromEmail = emailField(body, 'fromEmail', { fallback: '' }) || emailField(body, 'from_email', { required: true })
    str(body, 'userName', { max: 320 }) || str(body, 'user_name', { required: true, max: 320 })
    const hasPassword = Boolean(body.password || body.smtp_password || body.smtpPassword)
    if (!hasPassword) throw invalid('password', 'password is required')
    const smtpHost = str(body, 'smtpHost', { max: 253 }) || str(body, 'smtp_host', { required: true, max: 253 })
    const imapHost = str(body, 'imapHost', { max: 253 }) || str(body, 'imap_host', { required: true, max: 253 })
    // A port sent as a string is a field-level 422, not a coerced number.
    for (const [field, alias] of [['smtpPort', 'smtp_port'], ['imapPort', 'imap_port']]) {
      const raw = body[field] ?? body[alias]
      if (raw === undefined || raw === null || raw === '') throw invalid(alias, `${alias} is required`)
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw invalid(alias, `${alias} must be a whole number, not a string`)
      if (raw < 1 || raw > 65535) throw invalid(alias, `${alias} must be between 1 and 65535`)
    }
    if (!HOSTNAME_RE.test(smtpHost)) throw invalid('smtp_host', 'smtp_host must be a hostname such as smtp.example.com')
    if (!HOSTNAME_RE.test(imapHost)) throw invalid('imap_host', 'imap_host must be a hostname such as imap.example.com')

    meter('mailboxes.add_smtp', 0, false, 'smtp provider unavailable')
    res.status(501)
    return {
      ok: false,
      supported: false,
      stored: false,
      errorCode: 'SMTP_PROVIDER_UNAVAILABLE',
      fromName,
      fromEmail,
      message: 'The details are valid, but this build cannot send over SMTP: mailboxes.provider accepts gmail and sandbox only and there is no SMTP/IMAP client. Nothing was saved and the password was not stored, logged or echoed.',
    }
  }))

  // ---- GET /api/mailboxes/:id ------------------------------------------------
  // Everything about one mailbox, so a user can judge whether to change it
  // before they change it. `deleteImpact` is what makes "tell me what this
  // breaks first" answerable before the existing DELETE route is called.
  api.get('/mailboxes/:id', handler(async (req) => {
    const started = Date.now()
    const m = loadMailbox(req)
    const ownerRow = owner(req.wsId)
    const withCampaigns = bool(req.query, 'withCampaigns', false)
    const campaigns = withCampaigns ? (campaignIdsByMailbox(req.wsId).get(m.id) || []) : null
    const out = serialise(ownerRow, m, {
      tags: tagsByMailbox(req.wsId).get(m.id) || [],
      campaignCount: campaignCounts(req.wsId).get(m.id) || 0,
      campaigns,
    })
    const draftCount = db.prepare(
      "SELECT COUNT(*) n FROM drafts d JOIN campaigns c ON c.id = d.campaign_id WHERE d.user_id = ? AND c.mailbox_id = ? AND d.status = 'pending'"
    ).get(req.wsId, m.id)?.n ?? 0
    meter('mailboxes.detail', Date.now() - started, true, `id=${m.id}`)
    return {
      ok: true,
      data: {
        ...out,
        connection: connectionCheck(m),
        deleteImpact: {
          campaignsAttached: out.campaignCount,
          draftsWaiting: draftCount,
          wouldHold: campaignsHeldBy(req.wsId, m),
        },
      },
    }
  }))

  // ---- PATCH /api/mailboxes/:id ---------------------------------------------
  // Partial update of the safe field set. `PUT /api/mailboxes/:id` in
  // server/routes.js still does the daily limit on its own; this is the fuller
  // edit, and it is a PATCH precisely because omitted fields must survive.
  api.patch('/mailboxes/:id', handler(async (req) => {
    const body = req.body || {}
    rejectCredentials(body)
    const m = loadMailbox(req)

    // Documented but not storable: mailboxes has no bcc or min_gap_minutes
    // column and this module may not add one. Saying so is better than
    // accepting the value and quietly dropping it.
    for (const field of ['bcc', 'minGapMinutes', 'min_gap_minutes', 'time_to_wait_in_mins']) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        throw invalid(field, `${field} cannot be stored yet — the mailboxes table has no column for it`)
      }
    }

    const updates = []
    const values = []
    const changes = []
    const set = (column, value, before, label) => {
      if (value === before) return
      updates.push(`${column} = ?`)
      values.push(value)
      changes.push(`${label}: ${before === '' ? '(none)' : before} → ${value === '' ? '(none)' : value}`)
    }

    if (body.fromName !== undefined || body.from_name !== undefined) {
      const field = body.fromName !== undefined ? 'fromName' : 'from_name'
      const v = str(as(field, body.fromName ?? body.from_name), field, { max: 120 })
      set('display_name', v, m.display_name || '', 'display name')
    }
    if (body.dailyLimit !== undefined || body.max_email_per_day !== undefined) {
      const field = body.dailyLimit !== undefined ? 'dailyLimit' : 'max_email_per_day'
      const v = int(as(field, body.dailyLimit ?? body.max_email_per_day), field, { required: true, ...DAILY_LIMIT })
      // Raising the limit moves the ramp's ceiling only: effectiveCap is a min
      // against dailyCap(), so today's figure cannot jump. Lowering it never
      // un-sends anything — the mailbox simply has nothing left today.
      set('daily_limit', v, m.daily_limit, 'daily limit')
      // Kept in step so other parity modules reading message_per_day see the
      // same number rather than a second source of truth.
      set('message_per_day', v, m.message_per_day, 'message per day')
    }
    if (body.signature !== undefined) {
      set('signature', sanitizeSignature(str(body, 'signature', { max: 20000 })), m.signature || '', 'signature')
    }
    if (body.trackingDomain !== undefined || body.custom_tracking_url !== undefined) {
      const field = body.trackingDomain !== undefined ? 'trackingDomain' : 'custom_tracking_url'
      const v = trackingDomain(as(field, body.trackingDomain ?? body.custom_tracking_url), field)
      set('tracking_domain', v, m.tracking_domain || '', 'tracking domain')
    }
    if (body.clientId !== undefined) {
      const v = int(body, 'clientId', { min: 1, fallback: 0 })
      if (v) owned('clients', v, req.wsId, 'client')
      set('client_id', v || null, m.client_id ?? null, 'client')
    }
    // One behaviour, two doors: suspending through the update route must land
    // in exactly the same state as the dedicated suspend route.
    if (body.isSuspended !== undefined || body.is_suspended !== undefined) {
      const v = bool(as('isSuspended', body.isSuspended ?? body.is_suspended), 'isSuspended') ? 1 : 0
      if (v !== (m.is_suspended ? 1 : 0)) {
        updates.push('is_suspended = ?', 'suspended_at = ?', 'suspended_reason = ?')
        values.push(v, v ? new Date().toISOString() : '', v ? str(body, 'reason', { max: 300 }) : '')
        changes.push(`suspended: ${Boolean(m.is_suspended)} → ${Boolean(v)}`)
      }
    }

    if (!updates.length) throw invalid('body', 'Nothing to update — send at least one changed field')

    tx(() => {
      db.prepare(`UPDATE mailboxes SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`)
        .run(...values, m.id, req.wsId)
    })
    audit(req, { type: 'mailbox_updated', detail: `${m.email} — ${changes.join('; ')}` })
    meter('mailboxes.update', 0, true, `id=${m.id} fields=${changes.length}`)

    const fresh = db.prepare(`SELECT ${SAFE_COLUMNS} FROM mailboxes WHERE id = ?`).get(m.id)
    return {
      ok: true,
      message: 'Email account updated successfully',
      changed: changes,
      data: serialise(owner(req.wsId), fresh, {
        tags: tagsByMailbox(req.wsId).get(m.id) || [],
        campaignCount: campaignCounts(req.wsId).get(m.id) || 0,
      }),
    }
  }))

  // ---- POST /api/mailboxes/:id/test -----------------------------------------
  api.post('/mailboxes/:id/test', handler(async (req) => {
    const m = loadMailbox(req)
    const check = connectionCheck(m)
    audit(req, { type: 'mailbox_tested', detail: `${m.email} — ${check.ok ? 'ok' : 'failed'}` })
    meter('mailboxes.test', 0, check.ok, m.email)
    return { ok: true, data: { accountId: m.id, ...check } }
  }))

  // ---- PUT /api/mailboxes/:id/suspend ---------------------------------------
  // The one switch. `is_suspended` is read by isSendable() and by the fleet
  // list's `sendable` flag, so a suspended mailbox falls out of every send path
  // at once rather than being checked at each call site.
  api.put('/mailboxes/:id/suspend', handler(async (req) => {
    const m = loadMailbox(req)
    const reason = str(req.body, 'reason', { max: 300 })

    if (m.is_suspended) {
      // Idempotent, and deliberately no second events row: nothing changed, so
      // the activity trail must not claim it did.
      return {
        ok: true, success: true, changed: false,
        data: { accountId: m.id, isSuspended: true, suspendedAt: m.suspended_at || null, reason: m.suspended_reason || '' },
        holding: campaignsHeldBy(req.wsId, m),
      }
    }

    const at = new Date().toISOString()
    tx(() => {
      db.prepare('UPDATE mailboxes SET is_suspended = 1, suspended_at = ?, suspended_reason = ? WHERE id = ? AND user_id = ?')
        .run(at, reason, m.id, req.wsId)
    })
    const fresh = db.prepare(`SELECT ${SAFE_COLUMNS} FROM mailboxes WHERE id = ?`).get(m.id)
    // Suspension does not detach the mailbox from anything: campaigns keep it
    // and explain why it is contributing nothing.
    const holding = campaignsHeldBy(req.wsId, fresh)
    audit(req, {
      type: 'mailbox_suspended',
      detail: `${m.email}${reason ? ` — ${reason}` : ''} (${holding.length} campaign(s) now holding)`,
    })
    meter('mailboxes.suspend', 0, true, m.email)
    return {
      ok: true, success: true, changed: true,
      data: { accountId: m.id, isSuspended: true, suspendedAt: at, reason },
      holding,
    }
  }))

  // ---- DELETE /api/mailboxes/:id/suspend ------------------------------------
  // Resume, and re-check in the same request, so the mailer never picks up a
  // mailbox that cannot actually send. A failed check leaves the mailbox
  // active-but-unhealthy rather than silently suspending it again — the state
  // the user sees is the state they asked for.
  api.delete('/mailboxes/:id/suspend', handler(async (req) => {
    const m = loadMailbox(req)

    if (!m.is_suspended) {
      return {
        ok: true, success: true, changed: false,
        data: { accountId: m.id, isSuspended: false },
        connection: connectionCheck(m),
      }
    }

    tx(() => {
      db.prepare("UPDATE mailboxes SET is_suspended = 0, suspended_at = '', suspended_reason = '' WHERE id = ? AND user_id = ?")
        .run(m.id, req.wsId)
    })
    const fresh = db.prepare(`SELECT ${SAFE_COLUMNS} FROM mailboxes WHERE id = ?`).get(m.id)
    const check = connectionCheck(fresh)
    // The warm-up ramp is computed from the connection date in pacing.js, so it
    // neither restarts at day one nor jumps to the ceiling: it simply carries on
    // from where the calendar says it should be.
    audit(req, { type: 'mailbox_unsuspended', detail: `${m.email} — connection ${check.ok ? 'ok' : 'needs attention'}` })
    meter('mailboxes.unsuspend', 0, check.ok, m.email)
    return {
      ok: true, success: true, changed: true,
      data: { accountId: m.id, isSuspended: false },
      connection: check,
      warmup: warmupDetails(fresh),
      resumed: (campaignIdsByMailbox(req.wsId).get(m.id) || [])
        .filter((c) => c.status === 'running')
        .map((c) => c.id),
    }
  }))

  // ---- PUT /api/mailboxes/:id/warmup ----------------------------------------
  // Overrides for the ramp Harry already runs. Doing nothing keeps today's
  // behaviour exactly — start at 10 a day, climb to the limit over a fortnight
  // — because pacing.js remains the authority and these columns can only make
  // it stricter.
  api.put('/mailboxes/:id/warmup', handler(async (req) => {
    const body = req.body || {}
    rejectCredentials(body)
    const m = loadMailbox(req)

    if (!warmupApplies(m)) {
      throw invalid('warmup', 'Warm-up does not apply to sandbox mailboxes — the daily limit still applies')
    }

    // Each setting arrives under either Harry's name or the source API's, and
    // whichever spelling was used is the one a 422 has to name.
    const pick = (camel, snake) => (body[camel] !== undefined ? camel : body[snake] !== undefined ? snake : '')

    const enabledField = pick('enabled', 'warmup_enabled')
    const isEnabled = enabledField
      ? bool(as(enabledField, body[enabledField]), enabledField)
      : Boolean(m.warmup_enabled)

    const countField = pick('dailyCount', 'total_warmup_per_day')
    const dailyCount = countField
      ? int(as(countField, body[countField]), countField, { required: true, min: WARMUP_COUNT.min, max: WARMUP_COUNT.max })
      : m.warmup_daily_count
    // Warm-up volume can never exceed the mailbox's own daily limit: the cap is
    // the binding constraint and a warm-up setting must not be able to lift it.
    if (isEnabled && dailyCount > m.daily_limit) {
      throw invalid(countField || 'dailyCount',
        `${countField || 'dailyCount'} must not exceed the mailbox's daily limit of ${m.daily_limit}`)
    }

    const stepField = pick('rampStep', 'daily_rampup')
    const rampStep = stepField
      ? int(as(stepField, body[stepField]), stepField, { required: true, min: RAMP_STEP.min, max: RAMP_STEP.max })
      : m.warmup_ramp_step

    const rateField = pick('targetReplyRate', 'reply_rate_percentage')
    const replyRate = rateField
      ? int(as(rateField, body[rateField]), rateField, { required: true, min: REPLY_RATE.min, max: REPLY_RATE.max })
      : m.warmup_target_reply_rate

    const rampField = pick('rampEnabled', 'is_rampup_enabled')
    const rampEnabled = rampField ? bool(as(rampField, body[rampField]), rampField) : Boolean(m.warmup_ramp_enabled)
    const autoField = pick('autoAdjust', 'auto_adjust_warmup')
    const autoAdjust = autoField ? bool(as(autoField, body[autoField]), autoField) : Boolean(m.warmup_auto_adjust)

    const before = `${m.warmup_enabled ? 'on' : 'off'}/${m.warmup_daily_count}/${m.warmup_ramp_step}/${m.warmup_target_reply_rate}`
    const after = `${isEnabled ? 'on' : 'off'}/${dailyCount}/${rampStep}/${replyRate}`

    tx(() => {
      db.prepare(
        `UPDATE mailboxes SET warmup_enabled = ?, warmup_daily_count = ?, warmup_ramp_enabled = ?,
                              warmup_ramp_step = ?, warmup_target_reply_rate = ?, warmup_auto_adjust = ?
          WHERE id = ? AND user_id = ?`
      ).run(isEnabled ? 1 : 0, dailyCount, rampEnabled ? 1 : 0, rampStep, replyRate, autoAdjust ? 1 : 0, m.id, req.wsId)
    })
    audit(req, { type: 'mailbox_warmup_updated', detail: `${m.email} — ${before} → ${after}` })
    meter('mailboxes.warmup', 0, true, `id=${m.id}`)

    const fresh = db.prepare(`SELECT ${SAFE_COLUMNS} FROM mailboxes WHERE id = ?`).get(m.id)
    return {
      ok: true,
      message: 'Warmup settings updated successfully',
      data: {
        accountId: m.id,
        enabled: isEnabled,
        dailyCount,
        rampEnabled,
        rampStep,
        targetReplyRate: replyRate,
        autoAdjust,
        // What actually binds today, so nobody has to guess whether the setting
        // or the ramp won. Today's already-sent count is untouched by this call.
        effectiveDailyCap: effectiveCap(fresh),
        pacingCap: dailyCap(fresh),
        dailyLimit: fresh.daily_limit,
        sentToday: sentToday(fresh),
        note: isEnabled
          ? "Warm-up sits under Harry's own ramp — it can only lower today's cap, never raise it"
          : "Warm-up overrides are off; Harry's built-in ramp in pacing.js still governs a new mailbox",
      },
      warmupDetails: warmupDetails(fresh),
    }
  }))

  // ---- GET /api/mailboxes/:id/warmup-stats ----------------------------------
  // A dense daily series. A day with no activity is a zero row, never a gap:
  // a missing bucket in a chart reads as "something broke", which is a
  // different thing from "nothing happened".
  api.get('/mailboxes/:id/warmup-stats', handler(async (req) => {
    const started = Date.now()
    const m = loadMailbox(req)
    const ownerRow = owner(req.wsId)
    const tz = workspaceZone(ownerRow, str(req.query, 'timezone', { max: 64 }))
    const days = int(req.query, 'days', { min: 1, max: 90, fallback: 7 })

    const status = warmupStatus(m)
    if (!warmupApplies(m)) {
      // Honest empty state, not zeros pretending to be measurements.
      return {
        ok: true, mailboxId: m.id, timezone: tz, warmupRunning: false, status: null,
        message: 'Warm-up does not apply to sandbox mailboxes', dailyStats: [],
      }
    }
    if (status === 'INACTIVE') {
      return {
        ok: true, mailboxId: m.id, timezone: tz, warmupRunning: false, status,
        message: 'Warm-up is not running for this mailbox', dailyStats: [],
      }
    }

    const today = dayIn(tz, Date.now())
    const from = shiftDay(today, -(days - 1))
    const rows = db.prepare(
      'SELECT day, sent, received, spam, inbox, reply_rate FROM warmup_stats WHERE mailbox_id = ? AND day >= ? AND day <= ? ORDER BY day'
    ).all(m.id, from, today)
    const byDay = new Map(rows.map((r) => [r.day, r]))

    // Opens are not part of the warm-up pool; they come from what Harry
    // actually sent, bucketed in the workspace's zone.
    const opens = db.prepare(
      "SELECT opened_at FROM messages WHERE mailbox_id = ? AND direction = 'out' AND COALESCE(opened_at, '') != ''"
    ).all(m.id)
    const opensByDay = new Map()
    for (const o of opens) {
      const key = dayIn(tz, Date.parse(String(o.opened_at).replace(' ', 'T') + 'Z') || Date.now())
      opensByDay.set(key, (opensByDay.get(key) || 0) + 1)
    }

    const dailyStats = []
    for (let i = 0; i < days; i += 1) {
      const date = shiftDay(from, i)
      const r = byDay.get(date)
      const sent = r?.sent ?? 0
      const spam = r?.spam ?? 0
      const delivered = r?.inbox ?? 0
      const replied = r?.received ?? 0
      dailyStats.push({
        date,
        sent,
        delivered,
        spam,
        opened: opensByDay.get(date) || 0,
        replied,
        replyRate: r?.reply_rate ?? (sent ? Math.round((replied / sent) * 1000) / 10 : 0),
      })
    }

    const totals = dailyStats.reduce((a, d) => ({
      sent: a.sent + d.sent, inbox: a.inbox + d.delivered, spam: a.spam + d.spam, received: a.received + d.replied,
    }), { sent: 0, inbox: 0, spam: 0, received: 0 })
    const target = m.warmup_target_reply_rate || REPLY_RATE.min
    const reputation = reputationScore(totals, target)
    const spamRatePct = totals.sent ? Math.round((totals.spam / totals.sent) * 1000) / 10 : 0

    // A verdict needs evidence. `warmup_stats` only ever gets a row for a day
    // something actually happened (server/upkeep.js), so no rows means no
    // activity — and a mailbox that has sent nothing is not "healthy", it is
    // unmeasured. The old code said `healthy: true` off a week of zeroes,
    // which is the same defect as reporting seed sends that never happen: a
    // confident answer assembled from the absence of data.
    const enoughData = rows.length > 0 && totals.sent > 0

    // The thresholds stated in words, so the user is not left to know what good
    // looks like, with the specific next actions the docs name.
    const actions = []
    if (enoughData && spamRatePct > SPAM_THRESHOLD_PCT) {
      actions.push('Lower the daily warm-up count', 'Check SPF, DKIM and DMARC for this domain', 'Review the content of the sequence')
    }
    if (enoughData && reputation !== null && reputation < REPUTATION_TARGET) {
      actions.push('Give the mailbox more days before raising its limit')
    }

    const healthy = enoughData
      ? spamRatePct <= SPAM_THRESHOLD_PCT && (reputation === null || reputation >= REPUTATION_TARGET)
      : null

    meter('mailboxes.warmup_stats', Date.now() - started, true, `id=${m.id} days=${days}`)
    return {
      ok: true,
      mailboxId: m.id,
      timezone: tz,
      warmupRunning: true,
      status,
      connectedAt: m.created_at,
      // A young mailbox has few rows of real history; saying how young it is
      // beats drawing empty columns as though something went wrong.
      daysOfHistory: rows.length,
      enoughData,
      totalSent: totals.sent,
      spamCount: totals.spam,
      // What `spamCount` is actually counting. Harry has no spam-complaint
      // feed; per Docs/email-accounts/warmup-stats.md §5 the signal is bounce
      // telemetry, and a field called `spamCount` that silently means something
      // else is how a support conversation goes wrong.
      spamSource: 'bounces',
      replyRate: totals.sent ? Math.round((totals.received / totals.sent) * 1000) / 10 : 0,
      reputationScore: reputation,
      dailyStats,
      guidance: {
        spamThresholdPct: SPAM_THRESHOLD_PCT,
        spamRatePct,
        reputationTarget: REPUTATION_TARGET,
        enoughData,
        // Null, not false: "we cannot tell yet" is not "this mailbox is
        // unhealthy", and a client that renders a red badge for both is wrong
        // in a way that costs the user a morning.
        healthy,
        verdict: enoughData ? (healthy ? 'healthy' : 'needs_attention') : 'not_enough_data',
        summary: enoughData
          ? `${spamRatePct}% of ${totals.sent} sends from this mailbox bounced or were rejected; keep it under ${SPAM_THRESHOLD_PCT}%`
          : 'Not enough history yet — check back tomorrow',
        actions,
      },
    }
  }))
}
