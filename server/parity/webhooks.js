// Outbound event notifications — Docs/webhooks/* and the five campaign-scoped
// webhook files in Docs/campaigns/*.
//
// One `webhooks` table serves both scopes the backlog describes: a row with
// `campaign_id IS NULL` is workspace-wide, a row with a campaign id is scoped
// to that campaign. `POST /api/webhooks` and `POST /api/campaigns/:id/webhooks`
// are two doors into the same table, so the UI never has to reconcile two
// registries and scope priority can be decided in exactly one function
// (`selectTargets`).
//
// The standing rule from server/alerts.js governs delivery: a failing
// integration is telemetry, never a blocked send. `fireWebhooks` cannot throw,
// cannot reject, and returns a plain summary — a producer that ignores the
// return value is behaving correctly.
//
// Deliberate divergences, stated because a reader will otherwise assume a bug:
//
//   * Harry's own event vocabulary is canonical. The upstream SmartLead
//     constants (`EMAIL_SENT`, `LEAD_REPLIED`, …) are accepted on the way in
//     and normalised, so an integration ported from SmartLead keeps working,
//     but what is stored and what is sent is what Harry actually emits.
//   * The secret is never returned by any route. It is supplied once at
//     creation (or generated) and thereafter only proves itself by signing.
//   * `webhook_deliveries.webhook_id` is declared ON DELETE CASCADE in
//     server/parity/schema.js and `foreign_keys` is ON, so a hard delete would
//     take the audit trail with it. Deletion therefore writes a tombstone
//     (`is_active = -1`) instead: every read filters `is_active >= 0`, so the
//     row is gone from every surface, deliveries stop immediately including
//     queued retries, and the history the summary reports survives.

import crypto from 'node:crypto'
import { db, logEvent } from '../db.js'
import { recordTelemetry } from '../telemetry.js'
import {
  HttpError, handler, invalid, notFound,
  str, bool, page, paged, tx, nowIso,
} from './http.js'

// ---- the allow-list ---------------------------------------------------------

// Derived from what Harry genuinely produces — the `logEvent` types written by
// server/engine.js, server/mailer.js, server/tracking.js, server/drafts.js,
// server/consent.js and server/routes.js — plus the categories the specs name.
// Exported so Settings can render the checklist without hard-coding constants.
export const WEBHOOK_EVENT_TYPES = Object.freeze([
  'sent',
  'first_sent',
  'opened',
  'clicked',
  'reply',
  'bounced',
  'unsubscribed',
  'classified',
  'reclassified',
  'branched',
  'finished',
  'researched',
  'awaiting_approval',
  'approved',
  'declined',
  'needs_attention',
  'consent_signed',
  'consent_declined',
  'campaign_status_changed',
  'goal_achieved',
  'error',
])

// Harry's own words, so the UI never shows a constant. create.md's frontend
// story is explicit that the constants stay on the server.
export const WEBHOOK_EVENT_LABELS = Object.freeze({
  sent: 'Email sent',
  first_sent: 'First email sent',
  opened: 'Email opened',
  clicked: 'Link clicked',
  reply: 'Lead replied',
  bounced: 'Email bounced',
  unsubscribed: 'Lead unsubscribed',
  classified: 'Reply intent detected',
  reclassified: 'Reply intent changed',
  branched: 'Playbook branched',
  finished: 'Lead finished the playbook',
  researched: 'Lead research completed',
  awaiting_approval: 'Email awaiting approval',
  approved: 'Draft approved',
  declined: 'Draft declined',
  needs_attention: 'Lead needs a decision',
  consent_signed: 'Agreement signed',
  consent_declined: 'Agreement declined',
  campaign_status_changed: 'Campaign status changed',
  goal_achieved: 'Goal achieved',
  error: 'Something went wrong',
})

// Upstream constants and Harry's internal near-synonyms, folded onto the
// canonical name. Everything here is matched case-insensitively.
const EVENT_ALIASES = Object.freeze({
  EMAIL_SENT: 'sent',
  FIRST_EMAIL_SENT: 'first_sent',
  EMAIL_OPEN: 'opened',
  EMAIL_OPENED: 'opened',
  LEAD_OPENED: 'opened',
  EMAIL_LINK_CLICK: 'clicked',
  EMAIL_CLICKED: 'clicked',
  LEAD_CLICKED: 'clicked',
  EMAIL_REPLY: 'reply',
  EMAIL_REPLIED: 'reply',
  LEAD_REPLIED: 'reply',
  EMAIL_BOUNCE: 'bounced',
  EMAIL_BOUNCED: 'bounced',
  LEAD_BOUNCED: 'bounced',
  LEAD_UNSUBSCRIBED: 'unsubscribed',
  UNSUBSCRIBED_LINK: 'unsubscribed',
  LEAD_CATEGORY_UPDATED: 'reclassified',
  MANUAL_STEP_REACHED: 'needs_attention',
  CAMPAIGN_STATUS_CHANGED: 'campaign_status_changed',
  CAMPAIGN_LAUNCHED: 'campaign_status_changed',
  CAMPAIGN_PAUSED: 'campaign_status_changed',
  CAMPAIGN_ARCHIVED: 'campaign_status_changed',
  AGREEMENT_SIGNED: 'consent_signed',
  AGREEMENT_DECLINED: 'consent_declined',
})

// Returns the canonical name, or null if Harry cannot produce that event.
export function normalizeEventType(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const lower = value.toLowerCase()
  if (WEBHOOK_EVENT_TYPES.includes(lower)) return lower
  return EVENT_ALIASES[value.toUpperCase()] || null
}

// ---- delivery configuration -------------------------------------------------

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000
const TIMEOUT_MS = 5000
const AUTOPAUSE_AFTER = 5        // consecutive failures before an endpoint rests
const RETRY_BATCH_CAP = 500
const MAX_WINDOW_DAYS = 92

// The transport, injectable so a test never touches the network. Production
// leaves this alone and gets global fetch.
let transport = (...args) => globalThis.fetch(...args)
export function setWebhookTransport(fn) {
  transport = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args)
}

// ---- URL validation ---------------------------------------------------------

// SSRF guard. Checked at save time and again immediately before every attempt,
// so a DNS or config change cannot turn a registered endpoint inward.
const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./, /^198\.(1[89])\./, /^255\.255\.255\.255$/,
]

export function webhookUrlProblem(value) {
  let url
  try { url = new URL(String(value)) } catch { return 'must be a valid absolute URL' }
  if (url.protocol !== 'https:') return 'must use https'
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return 'must name a host'
  if (host === 'localhost' || host.endsWith('.localhost')) return 'must not point at localhost'
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return 'must not point at a private network name'
  }
  if (!host.includes('.') && !host.includes(':')) return 'must name a fully qualified public host'
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) {
    return 'must not point at a private or loopback address'
  }
  const v4 = host.startsWith('::ffff:') ? host.slice(7) : host
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4) && PRIVATE_V4.some((re) => re.test(v4))) {
    return 'must not point at a private, loopback or link-local address'
  }
  return ''
}

function requireUrl(body, field) {
  const raw = str(body, field, { required: true, max: 2000 })
  const problem = webhookUrlProblem(raw)
  if (problem) throw invalid(field, `${field} ${problem}`)
  return raw
}

// The URL never reaches the activity trail or a log in full — only its host.
function hostOf(url) {
  try { return new URL(url).host } catch { return 'unknown-host' }
}

// ---- event-selection parsing ------------------------------------------------

// Accepts either shape the specs use: `event_types: [...]` (SmartLead's update
// route, and the campaign save route) or `event_type_map: { NAME: true }`
// (SmartLead's create route). Both normalise to the same stored array.
function parseEvents(body, { required }) {
  const hasArray = Array.isArray(body?.event_types)
  const hasMap = body?.event_type_map && typeof body.event_type_map === 'object' && !Array.isArray(body.event_type_map)
  if (!hasArray && !hasMap) {
    if (required) throw invalid('event_types', 'event_types is required and must list at least one event')
    return null
  }
  const field = hasArray ? 'event_types' : 'event_type_map'
  const raw = hasArray
    ? body.event_types
    : Object.entries(body.event_type_map).filter(([, on]) => on === true || on === 1 || on === 'true').map(([k]) => k)

  const chosen = []
  for (const item of raw) {
    const canonical = normalizeEventType(item)
    if (!canonical) {
      throw invalid(field, `${field} contains an unknown event type: ${String(item).slice(0, 60)}. Valid values: ${WEBHOOK_EVENT_TYPES.join(', ')}`)
    }
    if (!chosen.includes(canonical)) chosen.push(canonical)
  }
  // Create requires a selection; update may deliberately clear it (update.md
  // TC-6: an endpoint listening for nothing is a legitimate, visible state).
  if (required && chosen.length === 0) {
    throw invalid(field, `${field} must contain at least one event type`)
  }
  return chosen
}

// `category_id_map` / `categories` narrows LEAD_CATEGORY_UPDATED (Harry's reply
// intents) to named intents. Empty means every intent, as the spec requires.
function parseCategories(body) {
  const hasArray = Array.isArray(body?.categories)
  const hasMap = body?.category_id_map && typeof body.category_id_map === 'object' && !Array.isArray(body.category_id_map)
  if (!hasArray && !hasMap) return null
  const raw = hasArray
    ? body.categories
    : Object.entries(body.category_id_map).filter(([, on]) => on === true || on === 1 || on === 'true').map(([k]) => k)
  const out = []
  for (const item of raw) {
    const value = String(item ?? '').trim()
    if (!value) continue
    if (value.length > 120) throw invalid('categories', 'categories contains a value that is too long')
    if (!out.includes(value)) out.push(value)
  }
  return out
}

function jsonArray(text) {
  try {
    const parsed = JSON.parse(text || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// ---- projection -------------------------------------------------------------

// The secret is not in the SELECT list of any read path, and it is not in this
// projection either. get.md's definition of done asks for both.
const READ_COLUMNS =
  'id, workspace_id, campaign_id, name, url, event_types, categories, is_active, created_at, updated_at'

function present(row, extra = {}) {
  const events = jsonArray(row.event_types)
  return {
    id: row.id,
    name: row.name,
    webhook_url: row.url,
    url: row.url,
    scope: row.campaign_id == null ? 'user' : 'campaign',
    association_type: row.campaign_id == null ? 'user' : 'campaign',
    campaign_id: row.campaign_id ?? null,
    email_campaign_id: row.campaign_id ?? null,
    event_types: events,
    // Always the complete catalogue, so the UI never needs to know it.
    event_type_map: Object.fromEntries(WEBHOOK_EVENT_TYPES.map((t) => [t, events.includes(t)])),
    event_labels: events.map((t) => WEBHOOK_EVENT_LABELS[t] || t),
    categories: jsonArray(row.categories),
    category_id_map: Object.fromEntries(jsonArray(row.categories).map((c) => [c, true])),
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  }
}

// ---- workspace-scoped lookups ----------------------------------------------

// `is_active >= 0` filters the deletion tombstone everywhere, in one predicate.
function findWebhook(id, wsId) {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw notFound('webhook')
  const row = db.prepare(
    `SELECT ${READ_COLUMNS} FROM webhooks WHERE id = ? AND workspace_id = ? AND is_active >= 0`
  ).get(n, wsId)
  if (!row) throw notFound('webhook')
  return row
}

// The delivery worker's view: includes the secret, excludes tombstones. Called
// immediately before every attempt so a deletion cancels a queued retry.
function liveWebhook(id) {
  return db.prepare('SELECT * FROM webhooks WHERE id = ? AND is_active >= 0').get(id) || null
}

// A non-numeric id in the path is a 422 naming the parameter (get-webhooks
// TC-4, delete-webhook TC-4); a well-formed id that is not ours is a 404.
function pathId(value, field) {
  const n = Number(value)
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(n) || n <= 0) {
    throw invalid(field, `${field} must be a positive integer`)
  }
  return n
}

function ownedCampaign(req, field = 'id') {
  const id = pathId(req.params.id, field)
  const row = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(id, req.wsId)
  if (!row) throw notFound('campaign')
  return row
}

// ---- signing ----------------------------------------------------------------

export function signPayload(secret, body) {
  return `sha256=${crypto.createHmac('sha256', String(secret || '')).update(String(body)).digest('hex')}`
}

function hashPayload(body) {
  return crypto.createHash('sha256').update(String(body)).digest('hex')
}

// ---- delivery ---------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 5xx, 429 and transport failures are worth another go; a 4xx means the
// receiver has made up its mind, so it is recorded and left alone.
function retryable(status) {
  return status === 0 || status === 429 || status >= 500
}

function recordAttempt(hook, { eventType, body, payloadHash, attempt, status, ok, error }) {
  try {
    db.prepare(
      `INSERT INTO webhook_deliveries
         (workspace_id, webhook_id, event_type, payload, payload_hash, status_code, ok, attempt, error, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      hook.workspace_id, hook.id, eventType, body, payloadHash,
      status, ok ? 1 : 0, attempt, String(error || '').slice(0, 300), ok ? nowIso() : ''
    )
  } catch (err) {
    // Even the bookkeeping is best-effort: nothing here may reach the caller.
    recordTelemetry('webhook', { op: 'record', ok: false, detail: String(err?.message || err) })
  }
}

async function attemptOnce(hook, body, eventType, eventId, attempt, fetchImpl, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Harry-Event': eventType,
        'X-Harry-Event-Id': eventId,
        'X-Harry-Delivery-Attempt': String(attempt),
        'X-Harry-Timestamp': nowIso(),
        'X-Harry-Signature': signPayload(hook.secret, body),
      },
      body,
      signal: controller.signal,
    })
    const status = Number(res?.status ?? 0) || 0
    const ok = typeof res?.ok === 'boolean' ? res.ok : status >= 200 && status < 300
    let detail = ''
    if (!ok) {
      try { detail = String(await res.text()).slice(0, 200) } catch { detail = '' }
    }
    return { status, ok, error: ok ? '' : `HTTP ${status}${detail ? ` ${detail}` : ''}` }
  } catch (err) {
    return { status: 0, ok: false, error: String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

// An endpoint that has failed its last few attempts is rested rather than
// hammered. A save (PATCH, or the campaign upsert) brings it back.
function maybeAutoPause(hookId) {
  try {
    const recent = db.prepare(
      'SELECT ok FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?'
    ).all(hookId, AUTOPAUSE_AFTER)
    if (recent.length < AUTOPAUSE_AFTER || recent.some((r) => r.ok === 1)) return
    const hook = liveWebhook(hookId)
    if (!hook || hook.is_active !== 1) return
    db.prepare("UPDATE webhooks SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(hookId)
    logEvent(hook.workspace_id, {
      campaignId: hook.campaign_id ?? null,
      type: 'webhook_paused',
      detail: `${hook.name || 'Webhook'} paused after ${AUTOPAUSE_AFTER} consecutive failures (${hostOf(hook.url)})`,
    })
  } catch { /* pausing is housekeeping; it must never surface */ }
}

// One event to one endpoint, with bounded backoff. Records every attempt.
async function deliver(hook, { eventType, body, payloadHash, eventId }, opts) {
  const { fetchImpl, maxAttempts, backoffMs, timeoutMs } = opts
  let attempts = 0
  let last = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Re-read immediately before the attempt: deletion cancels queued retries,
    // and the SSRF guard is re-applied in case the URL changed underneath us.
    const live = liveWebhook(hook.id)
    if (!live) return { webhook_id: hook.id, ok: false, cancelled: true, attempts }
    const problem = webhookUrlProblem(live.url)
    if (problem) {
      attempts = attempt
      recordAttempt(live, { eventType, body, payloadHash, attempt, status: 0, ok: false, error: `refused: url ${problem}` })
      return { webhook_id: hook.id, ok: false, attempts, error: `url ${problem}` }
    }

    const t0 = Date.now()
    const result = await attemptOnce(live, body, eventType, eventId, attempt, fetchImpl, timeoutMs)
    attempts = attempt
    last = result
    recordAttempt(live, { eventType, body, payloadHash, attempt, status: result.status, ok: result.ok, error: result.error })
    recordTelemetry('webhook', {
      op: `deliver:${eventType}`,
      ok: result.ok,
      ms: Date.now() - t0,
      detail: result.ok ? hostOf(live.url) : `${hostOf(live.url)} ${result.error}`,
    })
    if (result.ok) return { webhook_id: hook.id, ok: true, attempts }
    if (!retryable(result.status)) break
    if (attempt < maxAttempts && backoffMs > 0) {
      await sleep(Math.min(backoffMs * 2 ** (attempt - 1), MAX_BACKOFF_MS))
    }
  }
  maybeAutoPause(hook.id)
  return { webhook_id: hook.id, ok: false, attempts, error: last?.error || 'delivery failed' }
}

function deliveryOptions(options = {}) {
  return {
    fetchImpl: options.fetchImpl || ((...args) => transport(...args)),
    maxAttempts: Math.max(1, Math.min(Number(options.maxAttempts) || MAX_ATTEMPTS, 10)),
    backoffMs: options.backoffMs === undefined ? BASE_BACKOFF_MS : Math.max(0, Number(options.backoffMs) || 0),
    timeoutMs: Math.max(100, Number(options.timeoutMs) || TIMEOUT_MS),
  }
}

// Does this hook's category filter admit the payload? An empty filter means
// every intent, which is what the spec says an empty map means.
function categoryAllows(row, payload) {
  const wanted = jsonArray(row.categories)
  if (!wanted.length) return true
  const value = payload?.category ?? payload?.intent ?? payload?.category_id
  if (value === undefined || value === null || value === '') return true
  return wanted.map(String).includes(String(value))
}

// The single place scope priority is decided. A workspace-level endpoint
// subscribed to the event overrides every campaign-level one for that event
// (create.md TC-10), so deleting the workspace-level row restores the
// campaign-level rows automatically — no second code path to keep in step.
export function selectTargets(wsId, eventType, campaignId = null, payload = {}) {
  const rows = db.prepare(
    'SELECT * FROM webhooks WHERE workspace_id = ? AND is_active = 1'
  ).all(wsId)
  const subscribed = rows.filter((r) => jsonArray(r.event_types).includes(eventType) && categoryAllows(r, payload))
  const workspaceLevel = subscribed.filter((r) => r.campaign_id == null)
  if (workspaceLevel.length) return workspaceLevel
  if (campaignId == null) return []
  return subscribed.filter((r) => Number(r.campaign_id) === Number(campaignId))
}

// The one publish call every producer uses.
//
// It never throws and never rejects: a caller on the send path may await it or
// ignore it, and either way a broken endpoint is telemetry. `options.fetchImpl`
// exists so tests inject a transport instead of reaching the network.
export async function fireWebhooks(wsId, eventType, payload = {}, options = {}) {
  try {
    const type = normalizeEventType(eventType)
    if (!type) return []
    const campaignId = payload?.campaign_id ?? payload?.campaignId ?? null
    const targets = selectTargets(wsId, type, campaignId, payload)
    if (!targets.length) return []

    const eventId = String(options.eventId || crypto.randomUUID())
    const envelope = {
      event_id: eventId,
      event_type: type,
      event_label: WEBHOOK_EVENT_LABELS[type] || type,
      occurred_at: nowIso(),
      ...payload,
      campaign_id: campaignId ?? null,
    }
    const body = JSON.stringify(envelope)
    const payloadHash = hashPayload(body)
    const opts = deliveryOptions(options)

    const results = []
    for (const hook of targets) {
      try {
        results.push(await deliver(hook, { eventType: type, body, payloadHash, eventId }, opts))
      } catch (err) {
        recordTelemetry('webhook', { op: `deliver:${type}`, ok: false, detail: String(err?.message || err) })
        results.push({ webhook_id: hook.id, ok: false, attempts: 0, error: String(err?.message || err) })
      }
    }
    return results
  } catch (err) {
    recordTelemetry('webhook', { op: 'fire', ok: false, detail: String(err?.message || err) })
    return []
  }
}

// ---- window parsing ---------------------------------------------------------

// Both the summary and the retrigger take the same window, and both specs are
// explicit about ISO 8601 with milliseconds and about rejecting an inversion.
function readWindow(source, { required = true } = {}) {
  const pick = (a, b) => (source?.[a] !== undefined && source[a] !== '' ? [a, source[a]] : [b, source?.[b]])
  const [fromField, fromRaw] = pick('from', 'fromTime')
  const [toField, toRaw] = pick('to', 'toTime')

  const parse = (field, raw, fallback) => {
    if (raw === undefined || raw === null || raw === '') {
      if (required) throw invalid(field, `${field} is required as an ISO 8601 timestamp, for example 2024-01-01T00:00:00.000Z`)
      return fallback
    }
    const d = new Date(String(raw))
    if (Number.isNaN(d.getTime())) {
      throw invalid(field, `${field} must be an ISO 8601 timestamp, for example 2024-01-01T00:00:00.000Z`)
    }
    return d
  }

  const from = parse(fromField, fromRaw, new Date(Date.now() - 7 * 86400_000))
  const to = parse(toField, toRaw, new Date())
  if (from.getTime() > to.getTime()) {
    throw invalid(fromField, `${fromField} must not be after ${toField}`)
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86400_000) {
    throw invalid(fromField, `the window must be ${MAX_WINDOW_DAYS} days or shorter`)
  }
  return { from: from.toISOString(), to: to.toISOString() }
}

// `webhook_deliveries.created_at` is SQLite's `datetime('now')` ("YYYY-MM-DD
// HH:MM:SS"); the window arrives as ISO with a T and a Z. `datetime()` on both
// sides normalises them, so the comparison is apples to apples.
const WINDOW_SQL = 'datetime(d.created_at) >= datetime(?) AND datetime(d.created_at) <= datetime(?)'

// Deliveries that belong to a campaign: either the endpoint is campaign-scoped,
// or a workspace-wide endpoint carried that campaign's id in the payload.
const CAMPAIGN_SCOPE_SQL = `(
  EXISTS (SELECT 1 FROM webhooks w WHERE w.id = d.webhook_id AND w.campaign_id = ?)
  OR json_extract(d.payload, '$.campaign_id') = ?
)`

// ---- retrigger concurrency --------------------------------------------------

// One replay per campaign at a time (retrigger-webhooks: "the second is refused
// rather than duplicating deliveries").
const retryLocks = new Set()

// ---- routes -----------------------------------------------------------------

export function register(api) {
  // ---------------------------------------------------------------- catalogue
  // The allow-list the create/edit dialog renders. Cheap, and it keeps the
  // constants on the server as the frontend story requires.
  api.get('/webhooks/event-types', handler(async () => ({
    success: true,
    data: WEBHOOK_EVENT_TYPES.map((value) => ({ value, label: WEBHOOK_EVENT_LABELS[value] })),
  })))

  // ------------------------------------------------------- list (paged) -----
  api.get('/webhooks', handler(async (req) => {
    const { limit, cursor } = page(req.query, { defaultLimit: 50, maxLimit: 200 })
    const scope = String(req.query.scope || '').trim()
    const clauses = ['workspace_id = ?', 'is_active >= 0']
    const args = [req.wsId]
    if (scope === 'user') clauses.push('campaign_id IS NULL')
    if (scope === 'campaign') clauses.push('campaign_id IS NOT NULL')
    if (cursor) { clauses.push('id > ?'); args.push(cursor) }
    const rows = db.prepare(
      `SELECT ${READ_COLUMNS} FROM webhooks WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`
    ).all(...args, limit + 1)
    const { items, nextCursor, hasMore } = paged(rows, limit)
    return { success: true, data: items.map((r) => present(r)), nextCursor, hasMore }
  }))

  // ------------------------------------------------------------- create -----
  // Docs/webhooks/create.md §5.
  api.post('/webhooks', handler(async (req) => {
    const body = req.body || {}
    const name = str(body, 'name', { required: true, max: 200 })
    const url = requireUrl(body, body.webhook_url !== undefined ? 'webhook_url' : 'url')

    // Harry has no client model on this surface, so `client` is refused with a
    // reason rather than silently treated as workspace-wide.
    const association = String(body.association_type || (body.email_campaign_id || body.campaign_id ? 'campaign' : 'user')).toLowerCase()
    if (association === 'client') {
      throw invalid('association_type', 'association_type "client" is not supported — use "user" for the whole workspace or "campaign" for one campaign')
    }
    if (!['user', 'campaign'].includes(association)) {
      throw invalid('association_type', 'association_type must be one of: user, campaign')
    }

    let campaignId = null
    if (association === 'campaign') {
      const raw = body.email_campaign_id ?? body.campaign_id
      if (raw === undefined || raw === null || raw === '') {
        throw invalid('email_campaign_id', 'email_campaign_id is required when association_type is "campaign"')
      }
      const id = pathId(raw, 'email_campaign_id')
      const campaign = db.prepare('SELECT id FROM campaigns WHERE id = ? AND user_id = ?').get(id, req.wsId)
      if (!campaign) throw notFound('campaign')
      campaignId = campaign.id
    }

    const events = parseEvents(body, { required: true })
    const categories = parseCategories(body) || []
    const force = bool(body, 'force_create', false)

    // Duplicate URL in the same scope is refused unless the caller insists.
    if (!force) {
      const existing = db.prepare(
        `SELECT id FROM webhooks
          WHERE workspace_id = ? AND url = ? AND is_active >= 0
            AND (campaign_id IS ? OR campaign_id = ?)`
      ).get(req.wsId, url, campaignId, campaignId)
      if (existing) {
        throw new HttpError(409, {
          error: 'duplicate_webhook',
          field: 'webhook_url',
          message: `An endpoint with this URL already exists in this scope (id ${existing.id}). Send force_create to add a second one.`,
          existing_id: existing.id,
        })
      }
    }

    // Supplied once or generated; never returned by any route thereafter.
    const secret = str(body, 'secret', { max: 200 }) || crypto.randomBytes(32).toString('hex')

    const row = tx(() => {
      const info = db.prepare(
        `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(req.wsId, campaignId, name, url, secret, JSON.stringify(events), JSON.stringify(categories))
      return db.prepare(`SELECT ${READ_COLUMNS} FROM webhooks WHERE id = ?`).get(info.lastInsertRowid)
    })

    logEvent(req.wsId, {
      campaignId,
      type: 'webhook_created',
      detail: `${req.user?.email || 'someone'} added "${name}" (${hostOf(url)}) for ${events.length} event(s)`,
    })

    const overridden = campaignId != null && events.some((e) => selectTargets(req.wsId, e, null).length > 0)
    return { ok: true, success: true, id: row.id, webhook_url: row.url, data: present(row, { overridden }) }
  }))

  // ---------------------------------------------------------------- read ----
  // Docs/webhooks/get.md §5 — the row plus its last ten attempts, no secret.
  api.get('/webhooks/:id', handler(async (req) => {
    const row = findWebhook(req.params.id, req.wsId)
    const deliveries = db.prepare(
      `SELECT id, event_type, status_code, ok, attempt, error, delivered_at, created_at
         FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 10`
    ).all(row.id)
    const overridden = row.campaign_id != null
      && jsonArray(row.event_types).some((e) => selectTargets(req.wsId, e, null).length > 0)
    return {
      success: true,
      data: present(row, {
        overridden,
        deliveries: deliveries.map((d) => ({ ...d, ok: d.ok === 1 })),
      }),
    }
  }))

  // -------------------------------------------------------------- update ----
  // Docs/webhooks/update.md §5. Partial merge; the secret is never touched.
  api.patch('/webhooks/:id', handler(async (req) => {
    const existing = findWebhook(req.params.id, req.wsId)
    const body = req.body || {}
    const changed = []

    let name = existing.name
    if (body.name !== undefined) {
      name = str(body, 'name', { required: true, max: 200 })
      if (name !== existing.name) changed.push('name')
    }

    let url = existing.url
    if (body.webhook_url !== undefined || body.url !== undefined) {
      url = requireUrl(body, body.webhook_url !== undefined ? 'webhook_url' : 'url')
      if (url !== existing.url) changed.push('url')
    }

    const parsedEvents = parseEvents(body, { required: false })
    const events = parsedEvents === null ? jsonArray(existing.event_types) : parsedEvents
    if (parsedEvents !== null && JSON.stringify(parsedEvents) !== existing.event_types) changed.push('event_types')

    const parsedCategories = parseCategories(body)
    const categories = parsedCategories === null ? jsonArray(existing.categories) : parsedCategories
    if (parsedCategories !== null && JSON.stringify(parsedCategories) !== existing.categories) changed.push('categories')

    // A corrective save resumes an auto-paused endpoint; an explicit
    // `is_active` in the body always wins.
    let active = existing.is_active === 1 ? 1 : 0
    if (body.is_active !== undefined) {
      active = bool(body, 'is_active', true) ? 1 : 0
      changed.push('is_active')
    } else if (active === 0 && (changed.includes('url') || changed.includes('event_types'))) {
      active = 1
      changed.push('resumed')
    }

    const row = tx(() => {
      db.prepare(
        `UPDATE webhooks
            SET name = ?, url = ?, event_types = ?, categories = ?, is_active = ?, updated_at = datetime('now')
          WHERE id = ? AND workspace_id = ?`
      ).run(name, url, JSON.stringify(events), JSON.stringify(categories), active, existing.id, req.wsId)
      return db.prepare(`SELECT ${READ_COLUMNS} FROM webhooks WHERE id = ?`).get(existing.id)
    })

    logEvent(req.wsId, {
      campaignId: row.campaign_id ?? null,
      type: 'webhook_updated',
      detail: `${req.user?.email || 'someone'} changed ${changed.length ? changed.join(', ') : 'nothing'} on "${row.name}" (${hostOf(existing.url)} → ${hostOf(row.url)})`,
    })

    return { ok: true, success: true, id: row.id, message: 'Webhook saved successfully', changed, data: present(row) }
  }))

  // -------------------------------------------------------------- delete ----
  // Docs/webhooks/delete.md §5. A tombstone, not a hard delete — see the file
  // header: the delivery history is the audit trail and must outlive the row.
  api.delete('/webhooks/:id', handler(async (req) => {
    const row = findWebhook(req.params.id, req.wsId)
    tx(() => {
      db.prepare("UPDATE webhooks SET is_active = -1, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?")
        .run(row.id, req.wsId)
    })
    logEvent(req.wsId, {
      campaignId: row.campaign_id ?? null,
      type: 'webhook_deleted',
      detail: `${req.user?.email || 'someone'} removed "${row.name}" (${hostOf(row.url)})`,
    })
    return { ok: true, success: true, message: 'Webhook deleted successfully' }
  }))

  // ------------------------------------------- campaign-scoped: list --------
  // Docs/campaigns/get-webhooks.md §5.
  api.get('/campaigns/:id/webhooks', handler(async (req) => {
    const campaign = ownedCampaign(req)
    const { limit, cursor } = page(req.query, { defaultLimit: 100, maxLimit: 200 })
    const args = [req.wsId, campaign.id]
    let where = 'workspace_id = ? AND campaign_id = ? AND is_active >= 0'
    if (cursor) { where += ' AND id > ?'; args.push(cursor) }
    const rows = db.prepare(
      `SELECT ${READ_COLUMNS} FROM webhooks WHERE ${where} ORDER BY name COLLATE NOCASE, id LIMIT ?`
    ).all(...args, limit + 1)
    const { items, nextCursor, hasMore } = paged(rows, limit)

    // Workspace-wide endpoints also fire for this campaign and take priority
    // over the campaign's own. Shown, not hidden, so nobody believes both fire.
    const inherited = db.prepare(
      `SELECT ${READ_COLUMNS} FROM webhooks WHERE workspace_id = ? AND campaign_id IS NULL AND is_active >= 0 ORDER BY id`
    ).all(req.wsId)
    const inheritedEvents = new Set(
      inherited.filter((r) => r.is_active === 1).flatMap((r) => jsonArray(r.event_types))
    )

    return {
      success: true,
      data: items.map((r) => present(r, {
        overridden: jsonArray(r.event_types).some((e) => inheritedEvents.has(e)),
      })),
      inherited: inherited.map((r) => present(r)),
      limit,
      nextCursor,
      hasMore,
    }
  }))

  // ------------------------------------------ campaign-scoped: upsert -------
  // Docs/campaigns/save-webhooks.md §5 — one route for create and update.
  api.post('/campaigns/:id/webhooks', handler(async (req) => {
    const campaign = ownedCampaign(req)
    const body = req.body || {}
    const name = str(body, 'name', { required: true, max: 200 })
    const url = requireUrl(body, body.webhook_url !== undefined ? 'webhook_url' : 'url')
    const events = parseEvents(body, { required: true })
    const categories = parseCategories(body) || []
    const active = body.is_active === undefined ? 1 : (bool(body, 'is_active', true) ? 1 : 0)

    const hasId = body.id !== undefined && body.id !== null && body.id !== ''
    let existing = null
    if (hasId) {
      const id = pathId(body.id, 'id')
      existing = db.prepare(
        'SELECT * FROM webhooks WHERE id = ? AND workspace_id = ? AND campaign_id = ? AND is_active >= 0'
      ).get(id, req.wsId, campaign.id)
      if (!existing) throw notFound('webhook')
    }

    const row = tx(() => {
      if (existing) {
        db.prepare(
          `UPDATE webhooks
              SET name = ?, url = ?, event_types = ?, categories = ?, is_active = ?, updated_at = datetime('now')
            WHERE id = ?`
        ).run(name, url, JSON.stringify(events), JSON.stringify(categories), active, existing.id)
        return db.prepare(`SELECT ${READ_COLUMNS} FROM webhooks WHERE id = ?`).get(existing.id)
      }
      const secret = str(body, 'secret', { max: 200 }) || crypto.randomBytes(32).toString('hex')
      const info = db.prepare(
        `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(req.wsId, campaign.id, name, url, secret, JSON.stringify(events), JSON.stringify(categories), active)
      return db.prepare(`SELECT ${READ_COLUMNS} FROM webhooks WHERE id = ?`).get(info.lastInsertRowid)
    })

    logEvent(req.wsId, {
      campaignId: campaign.id,
      type: existing ? 'webhook_updated' : 'webhook_created',
      detail: `${req.user?.email || 'someone'} ${existing ? 'updated' : 'added'} "${name}" (${hostOf(url)}) on this campaign`,
    })

    return { success: true, created: !existing, data: present(row) }
  }))

  // ------------------------------------------ campaign-scoped: delete -------
  // Docs/campaigns/delete-webhook.md §5 — pair-verified, so a valid webhook id
  // under the wrong campaign is a 404 rather than a silent success.
  api.delete('/campaigns/:id/webhooks/:webhookId', handler(async (req) => {
    const campaign = ownedCampaign(req)
    const webhookId = pathId(req.params.webhookId, 'webhook_id')
    const row = db.prepare(
      `SELECT ${READ_COLUMNS} FROM webhooks
        WHERE id = ? AND workspace_id = ? AND campaign_id = ? AND is_active >= 0`
    ).get(webhookId, req.wsId, campaign.id)
    if (!row) throw notFound('webhook')

    tx(() => {
      db.prepare("UPDATE webhooks SET is_active = -1, updated_at = datetime('now') WHERE id = ?").run(row.id)
    })
    logEvent(req.wsId, {
      campaignId: campaign.id,
      type: 'webhook_deleted',
      detail: `${req.user?.email || 'someone'} removed "${row.name}" (${hostOf(row.url)}) from this campaign`,
    })
    return { success: true, message: 'Webhook deleted successfully' }
  }))

  // -------------------------------------------------------------- summary ---
  // Docs/campaigns/get-webhook-summary.md §5.
  api.get('/campaigns/:id/notifications/summary', handler(async (req) => {
    const t0 = Date.now()
    const campaign = ownedCampaign(req)
    const { from, to } = readWindow(req.query)

    const rows = db.prepare(
      `SELECT d.event_type AS event_type, d.ok AS ok, COUNT(*) AS n
         FROM webhook_deliveries d
        WHERE d.workspace_id = ? AND ${WINDOW_SQL} AND ${CAMPAIGN_SCOPE_SQL}
        GROUP BY d.event_type, d.ok`
    ).all(req.wsId, from, to, campaign.id, campaign.id)

    const byType = new Map()
    let successful = 0
    let failed = 0
    for (const r of rows) {
      const entry = byType.get(r.event_type) || { event_type: r.event_type, label: WEBHOOK_EVENT_LABELS[r.event_type] || r.event_type, total: 0, successful: 0, failed: 0 }
      entry.total += r.n
      if (r.ok === 1) { entry.successful += r.n; successful += r.n } else { entry.failed += r.n; failed += r.n }
      byType.set(r.event_type, entry)
    }
    const total = successful + failed
    // One decimal, and never a divide by zero: 3 of 7 is 42.9, not 42.86.
    const successRate = total === 0 ? 0 : Math.round((successful / total) * 1000) / 10

    recordTelemetry('parity', { op: 'GET /campaigns/:id/notifications/summary', ok: true, ms: Date.now() - t0 })
    return {
      success: true,
      from,
      to,
      total_calls: total,
      successful_calls: successful,
      failed_calls: failed,
      success_rate: successRate,
      by_event_type: [...byType.values()].sort((a, b) => a.event_type.localeCompare(b.event_type)),
    }
  }))

  // ------------------------------------------------------------ retrigger ---
  // Docs/campaigns/retrigger-webhooks.md §5. Replays only failures, and only
  // ones with no later success for the same endpoint and payload — so running
  // it twice does not deliver the same event twice.
  api.post('/campaigns/:id/notifications/retry', handler(async (req) => {
    const t0 = Date.now()
    const campaign = ownedCampaign(req)
    const { from, to } = readWindow({ ...(req.body || {}), ...(req.query || {}) })

    const lockKey = `${req.wsId}:${campaign.id}`
    if (retryLocks.has(lockKey)) {
      throw new HttpError(409, {
        error: 'retry_in_progress',
        message: 'A retrigger is already running for this campaign. Wait for it to finish.',
      })
    }
    retryLocks.add(lockKey)
    try {
      const failures = db.prepare(
        `SELECT d.id, d.webhook_id, d.event_type, d.payload, d.payload_hash
           FROM webhook_deliveries d
          WHERE d.workspace_id = ? AND d.ok = 0 AND ${WINDOW_SQL} AND ${CAMPAIGN_SCOPE_SQL}
          ORDER BY d.id
          LIMIT ?`
      ).all(req.wsId, from, to, campaign.id, campaign.id, RETRY_BATCH_CAP)

      // One replay per (endpoint, payload): three failed attempts of the same
      // event are one event to retry, not three.
      const unique = new Map()
      for (const row of failures) {
        const key = `${row.webhook_id}:${row.payload_hash}`
        if (!unique.has(key)) unique.set(key, row)
      }

      const succeededAlready = db.prepare(
        'SELECT 1 FROM webhook_deliveries WHERE webhook_id = ? AND payload_hash = ? AND ok = 1 LIMIT 1'
      )

      const opts = deliveryOptions({
        // A manual replay is itself the retry; layering bounded retries on top
        // would multiply deliveries the operator did not ask for.
        maxAttempts: 1,
        backoffMs: 0,
      })

      let retriggered = 0
      let delivered = 0
      let skipped = 0
      let stillFailing = 0
      for (const row of unique.values()) {
        // "Skip events whose target hook no longer exists and report them
        // separately from retries."
        const hook = liveWebhook(row.webhook_id)
        if (!hook || hook.workspace_id !== req.wsId) { skipped += 1; continue }
        // Idempotency: a payload that has since succeeded is never resent.
        if (succeededAlready.get(row.webhook_id, row.payload_hash)) { skipped += 1; continue }

        retriggered += 1
        let eventId = ''
        try { eventId = JSON.parse(row.payload)?.event_id || '' } catch { eventId = '' }
        const result = await deliver(
          hook,
          { eventType: row.event_type, body: row.payload, payloadHash: row.payload_hash, eventId },
          opts
        )
        if (result.ok) delivered += 1
        else stillFailing += 1
      }

      logEvent(req.wsId, {
        campaignId: campaign.id,
        type: 'webhooks_retriggered',
        detail: `${req.user?.email || 'someone'} replayed ${retriggered} failed notification(s) between ${from} and ${to}: ${delivered} delivered, ${stillFailing} still failing, ${skipped} skipped`,
      })
      recordTelemetry('parity', { op: 'POST /campaigns/:id/notifications/retry', ok: true, ms: Date.now() - t0 })

      return {
        success: true,
        retriggered_count: retriggered,
        delivered_count: delivered,
        failed_count: stillFailing,
        skipped_count: skipped,
        truncated: failures.length >= RETRY_BATCH_CAP,
        message: retriggered === 0
          ? 'Nothing to retry in this period'
          : `Replayed ${retriggered} failed notification(s)`,
      }
    } finally {
      retryLocks.delete(lockKey)
    }
  }))
}
