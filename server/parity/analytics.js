// Analytics + campaign statistics — the 28-endpoint reporting half of the
// SmartLead-parity backlog (Docs/analytics/*, Docs/campaign-statistics/*).
//
// Three rules shape everything below.
//
// 1. One definition of a rate. `GET /analytics` in server/routes.js already
//    decides what "reply rate" means for this product: distinct leads that
//    replied over distinct leads contacted, as a percentage rounded to one
//    decimal, and zero — never null, NaN or Infinity — when nothing was
//    contacted. Several spec files ask instead for `null` on a zero
//    denominator. Harry wins: two pages disagreeing about a week is the exact
//    failure this category exists to prevent. Every divergence is marked
//    HARRY-OVER-SPEC below.
//
// 2. One window parser. Nearly every route in both categories takes the same
//    `from` / `to` / `timezone` / `campaign_ids` quartet (the campaign-statistics
//    files spell them `start_date` / `end_date` / `time_zone`). `readWindow`
//    parses and validates all of it once, so an inverted range or an unknown
//    IANA zone produces the same field-naming 422 everywhere.
//
// 3. Nothing here writes. These are reads: no `events` rows, no mutation. The
//    only side effect is a `telemetry` row per call via `meter()`, which is
//    what Monitoring watches when reporting queries get slow.

import { db } from '../db.js'
import { REAL_SEND } from '../metrics.js'
import { parsePlaybook } from '../playbook.js'
import { sendWindow, isOpen } from '../pacing.js'
import { leadStages } from '../stages.js'
import { handler, invalid, notFound, int, meter } from './http.js'

// ---------------------------------------------------------------- numbers ---

// The house rate: percentage to one decimal, and 0 on an empty denominator.
// HARRY-OVER-SPEC: identical to `pct` in the existing GET /analytics handler.
// The specs ask for `null` here; returning 0 keeps this route and that one
// numerically identical, and satisfies the "never NaN or Infinity" rule.
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0)

// A ratio (not a percentage) to two decimals, 0 on an empty denominator.
const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 100) / 100 : 0)

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

// ------------------------------------------------------------- timezones ----

const ZONE_CACHE = new Map()

function validZone(tz) {
  if (ZONE_CACHE.has(tz)) return ZONE_CACHE.get(tz)
  let ok = false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    ok = true
  } catch { ok = false }
  ZONE_CACHE.set(tz, ok)
  return ok
}

const DAY_FMT = new Map()
function dayFormatter(tz) {
  if (!DAY_FMT.has(tz)) {
    DAY_FMT.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }))
  }
  return DAY_FMT.get(tz)
}

// SQLite writes `datetime('now')`, which is UTC without a marker. Node's Date
// would read "2026-08-07 09:00:00" as *local* time, which silently shifts every
// bucket by the host's offset. Normalise once, here, and nowhere else.
export function toDate(stamp) {
  if (!stamp) return null
  const s = String(stamp)
  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

// YYYY-MM-DD for an instant, as seen from `tz`.
function dayKey(tz, stamp) {
  const d = toDate(stamp)
  return d ? dayFormatter(tz).format(d) : ''
}

// Offset (local − UTC) in ms that `tz` was at the given instant.
function offsetAt(tz, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  )
  return asUtc - date.getTime()
}

// A wall-clock moment in `tz` as a UTC instant. Two passes so a boundary that
// lands inside a daylight-saving shift resolves to the offset actually in
// force, rather than the one an hour either side of it.
function zonedInstant(tz, y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss, ms)
  const first = guess - offsetAt(tz, new Date(guess))
  return new Date(guess - offsetAt(tz, new Date(first)))
}

// SQLite-comparable UTC stamp: the exact shape `datetime(col)` returns.
function sqlStamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

// ------------------------------------------------------------- date input ---

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function readDate(query, field) {
  const raw = query?.[field]
  if (raw === undefined || raw === null || raw === '') return null
  const text = String(raw).trim().slice(0, 10)
  const m = DATE_RE.exec(text)
  if (!m) throw invalid(field, `${field} must be a date in YYYY-MM-DD form`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw invalid(field, `${field} is not a real calendar date`)
  }
  return { y, m: mo, d, key: text }
}

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + n))
  return next.toISOString().slice(0, 10)
}

function daysBetween(fromKey, toKey) {
  const a = Date.parse(`${fromKey}T00:00:00Z`)
  const b = Date.parse(`${toKey}T00:00:00Z`)
  return Math.round((b - a) / 86400000) + 1
}

const MAX_RANGE_DAYS = 400
const DEFAULT_RANGE_DAYS = 30

// The one place a reporting window is parsed. `fromField`/`toField`/`tzField`
// let the campaign-statistics routes keep their documented parameter names
// while sharing the validation, so the 422 names the field the caller sent.
function readWindow(req, {
  fromField = 'from', toField = 'to', tzField = 'timezone',
  requireDates = false, requireZone = false, allowPartial = true,
} = {}) {
  const q = req.query || {}
  const tzRaw = q[tzField] ?? q.timezone ?? q.time_zone ?? ''
  const tz = String(tzRaw || '').trim() || 'UTC'
  if (!validZone(tz)) throw invalid(tzField, `${tzField} must be a known IANA time zone`)
  if (requireZone && !String(tzRaw || '').trim()) {
    throw invalid(tzField, `${tzField} is required for this axis`)
  }

  const from = readDate(q, fromField)
  const to = readDate(q, toField)
  if (requireDates && !from) throw invalid(fromField, `${fromField} is required`)
  if (requireDates && !to) throw invalid(toField, `${toField} is required`)
  if (!allowPartial && Boolean(from) !== Boolean(to)) {
    throw invalid(from ? toField : fromField, `${fromField} and ${toField} must be supplied together`)
  }

  const todayKey = dayFormatter(tz).format(new Date())
  const toKey = to ? to.key : todayKey
  const fromKey = from ? from.key : addDays(toKey, -(DEFAULT_RANGE_DAYS - 1))
  if (fromKey > toKey) {
    // HARRY-OVER-SPEC: the campaign-statistics files say 400 here; http.js's
    // `invalid` is 422 everywhere else in the parity surface, so 422 it is.
    throw invalid(fromField, `${fromField} must not be after ${toField}`)
  }
  const days = daysBetween(fromKey, toKey)
  if (days > MAX_RANGE_DAYS) {
    throw invalid(toField, `range must be ${MAX_RANGE_DAYS} days or fewer (asked for ${days})`)
  }

  const [fy, fm, fd] = fromKey.split('-').map(Number)
  const nextKey = addDays(toKey, 1)
  const [ty, tm, td] = nextKey.split('-').map(Number)
  return {
    tz,
    from: fromKey,
    to: toKey,
    days,
    explicit: Boolean(from || to),
    // Half-open [start, end) in UTC, so a send at 23:59:59.9 local is inside.
    start: sqlStamp(zonedInstant(tz, fy, fm, fd)),
    end: sqlStamp(zonedInstant(tz, ty, tm, td)),
  }
}

// Every day in the window, so a chart never lies by omission.
function denseDays(win) {
  const out = []
  for (let key = win.from; key <= win.to; key = addDays(key, 1)) out.push(key)
  return out
}

// --------------------------------------------------------- campaign filter --

function parseIdList(query, field) {
  const raw = query?.[field]
  if (raw === undefined || raw === null || raw === '') return null
  const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((p) => String(p).trim()).filter(Boolean)
  if (!parts.length) return null
  const ids = []
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n <= 0) throw invalid(field, `${field} contains an invalid id: ${part}`)
    if (!ids.includes(n)) ids.push(n)
  }
  if (ids.length > 500) throw invalid(field, `${field} may contain at most 500 ids`)
  return ids
}

// `campaign_ids` naming a campaign in another workspace 404s rather than
// quietly returning that campaign's numbers as zeros.
function readCampaignIds(req, field = 'campaign_ids') {
  const ids = parseIdList(req.query, field)
  if (!ids) return null
  for (const id of ids) {
    const row = db.prepare('SELECT id FROM campaigns WHERE id = ? AND user_id = ?').get(id, req.wsId)
    if (!row) throw notFound('campaign')
  }
  return ids
}

// `{ sql, params }` for "…AND <alias>.campaign_id IN (…)", or a no-op.
function campaignClause(ids, column = 'campaign_id') {
  if (!ids || !ids.length) return { sql: '', params: [] }
  return { sql: ` AND ${column} IN (${ids.map(() => '?').join(',')})`, params: ids }
}

// ------------------------------------------------------------------ paging --

// The backlog's standing rule: an unbounded request is rejected. Every
// list-shaped response here is sliced server-side and says so in its envelope.
function readPage(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = int(query, 'limit', { min: 1, max: maxLimit, fallback: defaultLimit })
  const offset = int(query, 'offset', { min: 0, fallback: 0 })
  return { limit, offset }
}

function slicePage(rows, { limit, offset }) {
  const items = rows.slice(offset, offset + limit)
  return { items, limit, offset, total: rows.length, hasMore: offset + items.length < rows.length }
}

// ------------------------------------------------------------- sentiment ----

// One intent-to-sentiment map, shared by the response-stats route and anything
// else that needs the three buckets. Harry's intents are free-form edge labels,
// so anything unrecognised is surfaced rather than folded into "neutral".
export const SENTIMENT = {
  interested: 'positive',
  'not interested': 'negative',
  unsubscribe: 'negative',
  unsubscribed: 'negative',
  question: 'neutral',
  'not now': 'neutral',
  'out of office': 'neutral',
}

export function sentimentOf(intent) {
  const key = String(intent || '').trim().toLowerCase()
  if (!key) return 'uncategorised'
  return SENTIMENT[key] || 'uncategorised'
}

// The reserved bucket for a reply the classifier could not place. A user's own
// edge label could legitimately be the string "needs_attention", so a raw
// intent that collides is disambiguated rather than merged into the reserved key.
const NEEDS_ATTENTION = 'needs_attention'
function categoryKey(intent) {
  const key = String(intent || '').trim().toLowerCase()
  if (!key) return NEEDS_ATTENTION
  return key === NEEDS_ATTENTION ? `${NEEDS_ATTENTION} (intent)` : key
}

// ----------------------------------------------------------- core queries ---

// Rows, not counts: every rollup below buckets these in JS so the day boundary
// is the caller's timezone rather than SQLite's UTC.
function outboundRows(wsId, win, campaignIds) {
  const c = campaignClause(campaignIds, 'm.campaign_id')
  return db.prepare(
    `SELECT m.id, m.lead_id, m.campaign_id, m.mailbox_id, m.node_id, m.sequence_number,
            m.opened_at, m.clicked_at, m.send_status, m.created_at
     FROM messages m
     WHERE m.user_id = ? AND m.direction = 'out' AND ${REAL_SEND}
       AND datetime(m.created_at) >= ? AND datetime(m.created_at) < ?${c.sql}
     ORDER BY m.id`
  ).all(wsId, win.start, win.end, ...c.params)
}

function inboundRows(wsId, win, campaignIds) {
  const c = campaignClause(campaignIds, 'm.campaign_id')
  return db.prepare(
    `SELECT m.id, m.lead_id, m.campaign_id, m.mailbox_id, m.intent, m.created_at
     FROM messages m
     WHERE m.user_id = ? AND m.direction = 'in'
       AND datetime(m.created_at) >= ? AND datetime(m.created_at) < ?${c.sql}
     ORDER BY m.id`
  ).all(wsId, win.start, win.end, ...c.params)
}

// Outcome rows land on the moment they were reached, not on the campaign's
// creation date, so a window means what it says.
function outcomeRows(wsId, win, campaignIds) {
  const c = campaignClause(campaignIds, 'cl.campaign_id')
  return db.prepare(
    `SELECT cl.campaign_id, cl.lead_id, cl.outcome,
            COALESCE(NULLIF(cl.unsubscribed_at, ''), NULLIF(cl.completed_at, ''), cl.updated_at) AS at
     FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
     WHERE c.user_id = ? AND cl.outcome IN ('won','lost','unsubscribed')
       AND datetime(COALESCE(NULLIF(cl.unsubscribed_at, ''), NULLIF(cl.completed_at, ''), cl.updated_at)) >= ?
       AND datetime(COALESCE(NULLIF(cl.unsubscribed_at, ''), NULLIF(cl.completed_at, ''), cl.updated_at)) < ?${c.sql}`
  ).all(wsId, win.start, win.end, ...c.params)
}

const bouncedLeadSet = (wsId) => new Set(
  db.prepare("SELECT id FROM leads WHERE user_id = ? AND status = 'bounced'").all(wsId).map((r) => r.id)
)

// Every count and rate the reporting surfaces share, from one pass over the
// rows. `key` picks the grouping (campaign, client, mailbox, …); `null` means
// the whole workspace.
function emptyBucket() {
  return {
    sent: 0, opened: 0, clicked: 0, bounced: 0,
    replied: 0, positive_replies: 0,
    _leads: new Set(), _openLeads: new Set(), _replyLeads: new Set(),
    _positiveLeads: new Set(), _bouncedLeads: new Set(),
    won: 0, lost: 0, unsubscribed: 0,
  }
}

function finishBucket(b) {
  const unique_lead_count = b._leads.size
  const replied_leads = b._replyLeads.size
  const out = {
    sent: b.sent,
    opened: b.opened,
    clicked: b.clicked,
    bounced: b.bounced,
    replied: b.replied,                       // reply events
    replied_leads,                            // distinct leads that replied
    positive_replied: b._positiveLeads.size,  // distinct leads with a positive reply
    positive_reply_events: b.positive_replies,
    unique_lead_count,                        // distinct leads contacted
    unique_open_count: b._openLeads.size,
    bounced_leads: b._bouncedLeads.size,
    won: b.won,
    lost: b.lost,
    unsubscribed: b.unsubscribed,
  }
  // HARRY-OVER-SPEC: every rate below matches GET /analytics exactly — reply
  // and positive-reply per lead contacted, open and click per email sent.
  out.open_rate = pct(out.opened, out.sent)
  out.click_rate = pct(out.clicked, out.sent)
  out.reply_rate = pct(out.replied_leads, out.unique_lead_count)
  out.positive_reply_rate = pct(out.positive_replied, out.unique_lead_count)
  out.win_rate = pct(out.won, out.unique_lead_count)
  out.unsubscribe_rate = pct(out.unsubscribed, out.unique_lead_count)
  // Two honest bounce figures: per lead contacted (what Monitoring grades) and
  // per email sent (what a mail provider grades).
  out.bounce_rate = pct(out.bounced_leads, out.unique_lead_count)
  out.bounce_share = pct(out.bounced, out.sent)
  // Leads it takes to earn one reply, from the same aggregate as the rate.
  out.leads_per_reply = ratio(out.unique_lead_count, out.replied_leads)
  out.sample_size = out.unique_lead_count
  return out
}

// `groupBy` maps a row to a bucket key (or null to skip). Returns a Map of
// key → finished stat block, plus the workspace total under `__all__`.
function rollup(wsId, win, campaignIds, groupBy) {
  const buckets = new Map()
  const total = emptyBucket()
  const bounced = bouncedLeadSet(wsId)
  const take = (key) => {
    if (key === null || key === undefined) return null
    if (!buckets.has(key)) buckets.set(key, emptyBucket())
    return buckets.get(key)
  }

  for (const row of outboundRows(wsId, win, campaignIds)) {
    const targets = [total, take(groupBy(row, 'out'))].filter(Boolean)
    for (const b of targets) {
      b.sent += 1
      if (row.opened_at) b.opened += 1
      if (row.clicked_at) b.clicked += 1
      if (row.send_status === 'bounced') b.bounced += 1
      if (row.lead_id) {
        b._leads.add(row.lead_id)
        if (row.opened_at) b._openLeads.add(row.lead_id)
        if (bounced.has(row.lead_id)) b._bouncedLeads.add(row.lead_id)
      }
    }
  }
  for (const row of inboundRows(wsId, win, campaignIds)) {
    const targets = [total, take(groupBy(row, 'in'))].filter(Boolean)
    const positive = sentimentOf(row.intent) === 'positive'
    for (const b of targets) {
      b.replied += 1
      if (positive) b.positive_replies += 1
      if (row.lead_id) {
        b._replyLeads.add(row.lead_id)
        if (positive) b._positiveLeads.add(row.lead_id)
      }
    }
  }
  for (const row of outcomeRows(wsId, win, campaignIds)) {
    const targets = [total, take(groupBy(row, 'outcome'))].filter(Boolean)
    for (const b of targets) {
      if (row.outcome === 'won') b.won += 1
      else if (row.outcome === 'lost') b.lost += 1
      else if (row.outcome === 'unsubscribed') b.unsubscribed += 1
    }
  }

  const out = new Map()
  for (const [key, b] of buckets) out.set(key, finishBucket(b))
  return { groups: out, total: finishBucket(total) }
}

// ------------------------------------------------- reply → originating send --

// The out message a given reply is answering: same lead, same campaign, sent
// before it. Replies with no traceable send are reported, never dropped.
function replyOrigins(wsId, campaignIds) {
  const c1 = campaignClause(campaignIds, 'campaign_id')
  const sends = db.prepare(
    `SELECT id, lead_id, campaign_id, node_id, created_at FROM messages
     WHERE user_id = ? AND direction = 'out'${c1.sql} ORDER BY id`
  ).all(wsId, ...c1.params)
  const byLead = new Map()
  for (const s of sends) {
    const key = `${s.lead_id}:${s.campaign_id ?? 0}`
    if (!byLead.has(key)) byLead.set(key, [])
    byLead.get(key).push(s)
  }
  return (reply) => {
    const at = toDate(reply.created_at)?.getTime() ?? 0
    const exact = byLead.get(`${reply.lead_id}:${reply.campaign_id ?? 0}`) || []
    const pool = exact.length ? exact : (byLead.get(`${reply.lead_id}:0`) || [])
    let best = null
    for (const s of pool) {
      const t = toDate(s.created_at)?.getTime() ?? 0
      if (t <= at) best = s
      else break
    }
    return best
  }
}

// ------------------------------------------------------------- workspace -----

const owner = (wsId) => db.prepare('SELECT * FROM users WHERE id = ?').get(wsId) || null

function campaignsOf(wsId, { includeArchived = false } = {}) {
  return db.prepare(
    `SELECT * FROM campaigns WHERE user_id = ?${includeArchived ? '' : " AND status != 'archived'"}
     ORDER BY id`
  ).all(wsId)
}

const remainingToday = (mb) => {
  const today = new Date().toISOString().slice(0, 10)
  const used = mb.sent_today_date === today ? num(mb.sent_today) : 0
  return Math.max(0, num(mb.daily_limit) - used)
}

const domainOf = (address) => {
  const at = String(address || '').lastIndexOf('@')
  return at === -1 ? '' : String(address).slice(at + 1).trim().toLowerCase()
}

// =============================================================== routes ======

export function register(api) {
  // --- Docs/analytics/campaign-list.md -------------------------------------
  // A picker feed: ids and names, nothing else. Cross-workspace ids in `ids`
  // are filtered out rather than 404ing — this one spec says so explicitly.
  api.get('/analytics/campaigns', handler((req) => {
    const t0 = Date.now()
    const wanted = parseIdList(req.query, 'ids')
    const page = readPage(req.query, { defaultLimit: 100, maxLimit: 500 })
    let rows = campaignsOf(req.wsId, { includeArchived: true })
      .map((c) => ({ id: c.id, name: c.name }))
    if (wanted) rows = rows.filter((r) => wanted.includes(r.id))
    rows.sort((a, b) => (a.name === b.name ? a.id - b.id : a.name.localeCompare(b.name)))
    meter('GET /analytics/campaigns', Date.now() - t0)
    return slicePage(rows, page)
  }))

  // --- Docs/analytics/campaign-performance.md ------------------------------
  // --- Docs/analytics/leads-for-first-reply.md (folded in: leads_per_reply) -
  api.get('/analytics/campaigns/performance', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)
    const page = readPage(req.query, { defaultLimit: 50 })
    const { groups, total } = rollup(req.wsId, win, ids, (row) => row.campaign_id ?? null)

    let campaigns = campaignsOf(req.wsId, { includeArchived: true })
    if (ids) campaigns = campaigns.filter((c) => ids.includes(c.id))
    const rows = campaigns.map((c) => ({
      campaign_id: c.id,
      name: c.name,
      status: c.status,
      client_id: c.client_id ?? null,
      ...(groups.get(c.id) || finishBucket(emptyBucket())),
    }))
    rows.sort((a, b) => (a.name === b.name ? a.campaign_id - b.campaign_id : a.name.localeCompare(b.name)))
    meter('GET /analytics/campaigns/performance', Date.now() - t0, true, `${win.days}d/${rows.length}c`)
    return { range: rangeMeta(win), workspace: total, ...slicePage(rows, page) }
  }))

  // --- Docs/analytics/campaign-response-stats.md ---------------------------
  api.get('/analytics/campaigns/response-stats', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)
    const page = readPage(req.query, { defaultLimit: 50 })

    const byCampaign = new Map()
    const totals = { positive: 0, neutral: 0, negative: 0, uncategorised: 0, total: 0 }
    for (const row of inboundRows(req.wsId, win, ids)) {
      const bucket = sentimentOf(row.intent)
      totals[bucket] += 1
      totals.total += 1
      const key = row.campaign_id ?? 0
      if (!byCampaign.has(key)) {
        byCampaign.set(key, { positive: 0, neutral: 0, negative: 0, uncategorised: 0, total: 0 })
      }
      const b = byCampaign.get(key)
      b[bucket] += 1
      b.total += 1
    }

    let campaigns = campaignsOf(req.wsId, { includeArchived: true })
    if (ids) campaigns = campaigns.filter((c) => ids.includes(c.id))
    const rows = campaigns.map((c) => ({
      campaign_id: c.id,
      name: c.name,
      ...(byCampaign.get(c.id) || { positive: 0, neutral: 0, negative: 0, uncategorised: 0, total: 0 }),
    }))
    rows.sort((a, b) => (a.name === b.name ? a.campaign_id - b.campaign_id : a.name.localeCompare(b.name)))
    meter('GET /analytics/campaigns/response-stats', Date.now() - t0)
    // Stated in the payload so nobody mistakes these for distinct leads.
    return { range: rangeMeta(win), counting: 'reply_events', totals, ...slicePage(rows, page) }
  }))

  // --- Docs/analytics/campaign-status-stats.md -----------------------------
  // "holding" is derived, not stored: a running campaign whose send window is
  // shut right now, exactly as server/pacing.js decides it for the engine.
  api.get('/analytics/campaigns/status-counts', handler((req) => {
    const t0 = Date.now()
    const page = readPage(req.query, { defaultLimit: 50 })
    const win = sendWindow(owner(req.wsId))
    const holding = win.on && !isOpen(win, Date.now())
    const counts = new Map()
    let total = 0
    for (const c of campaignsOf(req.wsId, { includeArchived: true })) {
      const key = c.status === 'running' && holding ? 'holding' : c.status
      counts.set(key, (counts.get(key) || 0) + 1)
      total += 1
    }
    // Zero counts are omitted, so the payload only names states that exist.
    const rows = [...counts].map(([status, count]) => ({ status, count }))
    rows.sort((a, b) => (b.count - a.count) || a.status.localeCompare(b.status))
    meter('GET /analytics/campaigns/status-counts', Date.now() - t0)
    return { campaigns_total: total, ...slicePage(rows, page) }
  }))

  // --- Docs/analytics/client-list.md ---------------------------------------
  // The `clients` table belongs to another parity module; this only reads it.
  api.get('/analytics/clients', handler((req) => {
    const t0 = Date.now()
    const page = readPage(req.query, { defaultLimit: 100, maxLimit: 500 })
    const rows = db.prepare(
      "SELECT id, name FROM clients WHERE workspace_id = ? AND COALESCE(deleted_at,'') = '' ORDER BY name, id"
    ).all(req.wsId)
    meter('GET /analytics/clients', Date.now() - t0)
    return slicePage(rows, page)
  }))

  // --- Docs/analytics/client-performance.md --------------------------------
  api.get('/analytics/clients/performance', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const clientIds = parseIdList(req.query, 'client_ids')
    const page = readPage(req.query, { defaultLimit: 25 })

    const campaignClient = new Map()
    for (const c of campaignsOf(req.wsId, { includeArchived: true })) {
      campaignClient.set(c.id, c.client_id ?? null)
    }
    const { groups, total } = rollup(req.wsId, win, null,
      (row) => (row.campaign_id ? campaignClient.get(row.campaign_id) ?? 0 : 0))

    let clients = db.prepare(
      "SELECT id, name FROM clients WHERE workspace_id = ? AND COALESCE(deleted_at,'') = '' ORDER BY name, id"
    ).all(req.wsId)
    if (clientIds) clients = clients.filter((c) => clientIds.includes(c.id))

    // "campaigns that sent in this range" — distinct campaigns with a real send
    // inside the window, per client. A client whose campaigns all sent last
    // month counts zero, which is the whole point of the caption.
    const campaignsWithSends = new Map()
    for (const row of db.prepare(
      `SELECT c.client_id, COUNT(DISTINCT m.campaign_id) n
         FROM messages m JOIN campaigns c ON c.id = m.campaign_id
        WHERE m.user_id = ? AND m.direction = 'out' AND ${REAL_SEND}
          AND datetime(m.created_at) >= ? AND datetime(m.created_at) < ?
        GROUP BY c.client_id`
    ).all(req.wsId, win.start, win.end)) {
      campaignsWithSends.set(row.client_id ?? 0, row.n)
    }

    const decorate = (stats) => ({
      ...stats,
      // The spec's definition, and the only one: the share of contacted leads
      // who replied positively. This used to be `(sent − bounced) / sent`, the
      // share of sends that did not bounce, which is a deliverability figure —
      // so a client with 40 positive replies across 900 leads read as 100%
      // healthy instead of 4.4%. Two different questions, one label.
      client_health: pct(stats.positive_replied, stats.unique_lead_count),
      client_health_formula: 'positive_replied / unique_lead_count',
      // Kept, under a name that says what it is, because the old number is a
      // real signal — it was only ever wearing the wrong label.
      non_bounce_rate: pct(stats.sent - stats.bounced, stats.sent),
    })
    const rows = clients.map((c) => {
      const stats = decorate(groups.get(c.id) || finishBucket(emptyBucket()))
      return {
        client_id: c.id,
        name: c.name,
        // The documented spellings alongside Harry's, so a client written
        // against client-performance.md and ClientsTab read the same row.
        client_name: c.name,
        total_campaigns_count: campaignsWithSends.get(c.id) || 0,
        campaign_stats: stats,
        ...stats,
      }
    })
    meter('GET /analytics/clients/performance', Date.now() - t0, true, `${win.days}d/${rows.length}cl`)
    const sliced = slicePage(rows, page)
    return {
      range: rangeMeta(win),
      // Campaigns with no client are kept out of `items` so the list stays a
      // list of clients, but the numbers are never hidden.
      unassigned: decorate(groups.get(0) || finishBucket(emptyBucket())),
      workspace: decorate(total),
      ...sliced,
      // The documented envelope. Same array, not a copy of the numbers.
      data: { client_wise_performance: sliced.items },
    }
  }))

  // --- Docs/analytics/month-wise-client-count.md ---------------------------
  api.get('/analytics/clients/monthly-active', handler((req) => {
    const t0 = Date.now()
    const months = int(req.query, 'months', { min: 1, max: 60, fallback: 24 })
    const clientIds = parseIdList(req.query, 'client_ids')
    const tzRaw = String(req.query?.timezone || req.query?.time_zone || '').trim()
    const tz = tzRaw || 'UTC'
    if (!validZone(tz)) throw invalid('timezone', 'timezone must be a known IANA time zone')

    const campaignClient = new Map()
    for (const c of campaignsOf(req.wsId, { includeArchived: true })) {
      if (c.client_id) campaignClient.set(c.id, c.client_id)
    }
    const anyClients = db.prepare(
      "SELECT COUNT(*) n FROM clients WHERE workspace_id = ? AND COALESCE(deleted_at,'') = ''"
    ).get(req.wsId).n
    // An empty workspace gets [], not two years of zeros.
    if (!anyClients) {
      meter('GET /analytics/clients/monthly-active', Date.now() - t0)
      return { months, items: [], total: 0, limit: months, offset: 0, hasMore: false }
    }

    const nowKey = dayFormatter(tz).format(new Date()).slice(0, 7)
    const keys = []
    for (let i = months - 1; i >= 0; i -= 1) {
      const [y, m] = nowKey.split('-').map(Number)
      const d = new Date(Date.UTC(y, m - 1 - i, 1))
      keys.push(d.toISOString().slice(0, 7))
    }
    const first = keys[0]
    const active = new Map(keys.map((k) => [k, new Set()]))
    // Activity means sends, not when the client record was created.
    for (const row of db.prepare(
      "SELECT campaign_id, created_at FROM messages WHERE user_id = ? AND direction = 'out'"
    ).all(req.wsId)) {
      const clientId = campaignClient.get(row.campaign_id)
      if (!clientId) continue
      if (clientIds && !clientIds.includes(clientId)) continue
      const month = dayKey(tz, row.created_at).slice(0, 7)
      if (!month || month < first || !active.has(month)) continue
      active.get(month).add(clientId)
    }
    const items = keys.map((month) => ({ month, count: active.get(month).size }))
    meter('GET /analytics/clients/monthly-active', Date.now() - t0, true, `${months}m`)
    return { months, timezone: tz, items, total: items.length, limit: months, offset: 0, hasMore: false }
  }))

  // --- Docs/analytics/day-wise-stats.md ------------------------------------
  // --- Docs/analytics/day-wise-sent-time.md --------------------------------
  // One route, one aggregation, an `axis` parameter. `event` puts each metric
  // on its own timestamp; `sent` attributes everything to the send that earned
  // it. Two routes would drift; this cannot.
  api.get('/analytics/daily', handler((req) => {
    const t0 = Date.now()
    const axis = String(req.query?.axis || 'event').trim().toLowerCase()
    if (!['event', 'sent'].includes(axis)) throw invalid('axis', 'axis must be one of: event, sent')
    const win = readWindow(req, { requireZone: axis === 'sent' })
    const ids = readCampaignIds(req)

    const days = new Map(denseDays(win).map((d) => [d, {
      day: d, sent: 0, opened: 0, clicked: 0, replied: 0, positive_replied: 0,
      bounced: 0, unsubscribed: 0, _leads: new Set(),
    }]))
    const at = (key) => (key && days.has(key) ? days.get(key) : null)
    let untraceable = 0

    for (const row of outboundRows(req.wsId, win, ids)) {
      const sendDay = at(dayKey(win.tz, row.created_at))
      if (!sendDay) continue
      sendDay.sent += 1
      if (row.send_status === 'bounced') sendDay.bounced += 1
      if (row.lead_id) sendDay._leads.add(row.lead_id)
      // On the event axis an open lands on the day it happened; on the sent
      // axis it lands on the day the email went out.
      if (row.opened_at) {
        const target = axis === 'sent' ? sendDay : at(dayKey(win.tz, row.opened_at))
        if (target) target.opened += 1
      }
      if (row.clicked_at) {
        const target = axis === 'sent' ? sendDay : at(dayKey(win.tz, row.clicked_at))
        if (target) target.clicked += 1
      }
    }

    const originOf = axis === 'sent' ? replyOrigins(req.wsId, ids) : null
    for (const row of inboundRows(req.wsId, win, ids)) {
      let key = dayKey(win.tz, row.created_at)
      if (axis === 'sent') {
        const origin = originOf(row)
        if (!origin) { untraceable += 1; continue }
        key = dayKey(win.tz, origin.created_at)
      }
      const target = at(key)
      if (!target) continue
      target.replied += 1
      if (sentimentOf(row.intent) === 'positive') target.positive_replied += 1
    }

    for (const row of outcomeRows(req.wsId, win, ids)) {
      if (row.outcome !== 'unsubscribed') continue
      const target = at(dayKey(win.tz, row.at))
      if (target) target.unsubscribed += 1
    }

    const items = [...days.values()].map(({ _leads, ...rest }) => ({
      ...rest, unique_lead_reached: _leads.size,
    }))
    meter('GET /analytics/daily', Date.now() - t0, true, `${axis}/${win.days}d`)
    return {
      axis, range: rangeMeta(win), untraceable_replies: untraceable,
      metadata: {
        // Stated so no client sums a column it must not sum.
        additive: ['sent', 'opened', 'clicked', 'replied', 'positive_replied', 'bounced', 'unsubscribed'],
        non_additive: ['unique_lead_reached'],
        axis_note: axis === 'sent'
          ? 'Every metric is attributed to the date its originating email was sent.'
          : 'Each metric sits on its own event date: sends on send time, opens on open time, replies on reply time.',
      },
      items,
      total: items.length,
      limit: items.length,
      offset: 0,
      hasMore: false,
    }
  }))

  // --- Docs/analytics/day-wise-positive-reply.md ---------------------------
  // --- Docs/analytics/day-wise-positive-sent-time.md -----------------------
  api.get('/analytics/positive-replies/daily', handler((req) => {
    const t0 = Date.now()
    const axis = String(req.query?.axis || 'reply').trim().toLowerCase()
    if (!['reply', 'sent'].includes(axis)) throw invalid('axis', 'axis must be one of: reply, sent')
    const win = readWindow(req, { requireZone: axis === 'sent' })
    const ids = readCampaignIds(req)

    const days = new Map(denseDays(win).map((d) => [d, new Set()]))
    const events = new Map(denseDays(win).map((d) => [d, 0]))
    const originOf = axis === 'sent' ? replyOrigins(req.wsId, ids) : null
    let untraceable = 0
    const leads = new Set()

    for (const row of inboundRows(req.wsId, win, ids)) {
      if (sentimentOf(row.intent) !== 'positive') continue
      let key = dayKey(win.tz, row.created_at)
      if (axis === 'sent') {
        const origin = originOf(row)
        if (!origin) { untraceable += 1; continue }
        key = dayKey(win.tz, origin.created_at)
      }
      if (!days.has(key)) continue
      if (row.lead_id) { days.get(key).add(row.lead_id); leads.add(row.lead_id) }
      events.set(key, events.get(key) + 1)
    }

    const items = denseDays(win).map((day) => ({
      day, count: days.get(day).size, reply_events: events.get(day),
    }))
    meter('GET /analytics/positive-replies/daily', Date.now() - t0, true, `${axis}/${win.days}d`)
    return {
      axis, range: rangeMeta(win),
      counting: 'distinct_leads',
      // Dropped rather than mis-attributed — and counted, so it is never silent.
      untraceable_replies: untraceable,
      // Distinct leads across the range, which is not the sum of the days.
      range_total: leads.size,
      items, total: items.length, limit: items.length, offset: 0, hasMore: false,
    }
  }))

  // --- Docs/analytics/mailboxes: domain-wise-health.md ---------------------
  api.get('/analytics/mailboxes/domains', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)
    const page = readPage(req.query, { defaultLimit: 50 })

    const mailboxes = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY id').all(req.wsId)
    const domainOfMailbox = new Map(mailboxes.map((m) => [m.id, domainOf(m.email)]))
    const boxesPerDomain = new Map()
    for (const m of mailboxes) {
      const d = domainOf(m.email)
      boxesPerDomain.set(d, (boxesPerDomain.get(d) || 0) + 1)
    }
    const { groups } = rollup(req.wsId, win, ids,
      (row) => (row.mailbox_id ? domainOfMailbox.get(row.mailbox_id) ?? null : null))

    // Zero-send domains are excluded, not padded with zeros.
    const rows = [...groups].filter(([d, s]) => d && s.sent > 0).map(([domain, s]) => ({
      domain, mailboxes: boxesPerDomain.get(domain) || 0, ...s,
    }))
    rows.sort((a, b) => (b.sent - a.sent) || a.domain.localeCompare(b.domain))
    meter('GET /analytics/mailboxes/domains', Date.now() - t0)
    return { range: rangeMeta(win), ...slicePage(rows, page) }
  }))

  // --- Docs/analytics/email-wise-health.md ---------------------------------
  api.get('/analytics/mailboxes/health', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)
    const page = readPage(req.query, { defaultLimit: 50 })
    const bouncedOnly = req.query?.is_bounced
    let filterBounced = null
    if (bouncedOnly !== undefined && bouncedOnly !== '') {
      const v = String(bouncedOnly).toLowerCase()
      if (['1', 'true', 'yes'].includes(v)) filterBounced = true
      else if (['0', 'false', 'no'].includes(v)) filterBounced = false
      else throw invalid('is_bounced', 'is_bounced must be true or false')
    }

    const { groups } = rollup(req.wsId, win, ids, (row) => row.mailbox_id ?? null)
    // Left-join from the mailbox list, so a silent mailbox is zeros, not absence.
    let rows = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY email, id').all(req.wsId)
      .map((m) => ({
        mailbox_id: m.id,
        email: m.email,
        domain: domainOf(m.email),
        provider: m.provider,
        is_sandbox: m.provider === 'sandbox',
        status: m.status,
        is_suspended: Boolean(m.is_suspended),
        warmup_enabled: Boolean(m.warmup_enabled),
        daily_limit: num(m.daily_limit),
        remaining_today: remainingToday(m),
        ...(groups.get(m.id) || finishBucket(emptyBucket())),
      }))
    // Filters on the range's bounces, not on lifetime ones.
    if (filterBounced !== null) rows = rows.filter((r) => (r.bounced > 0) === filterBounced)
    meter('GET /analytics/mailboxes/health', Date.now() - t0)
    return { range: rangeMeta(win), ...slicePage(rows, page) }
  }))

  // --- Docs/analytics/mailbox-health.md ------------------------------------
  // All four counts derived, never stored, so they cannot drift.
  //
  // The last `disconnected` count seen per workspace, so the route can tell a
  // rise from a steady state. In-process and deliberately not persisted: a
  // restart re-baselines rather than replaying an old incident.
  const DISCONNECTED_SEEN = new Map()
  api.get('/analytics/mailboxes/summary', handler((req) => {
    const t0 = Date.now()
    const mailboxes = db.prepare('SELECT * FROM mailboxes WHERE user_id = ?').all(req.wsId)
    const inUse = new Set()
    for (const c of db.prepare("SELECT id, mailbox_id FROM campaigns WHERE user_id = ? AND status = 'running'").all(req.wsId)) {
      if (c.mailbox_id) inUse.add(c.mailbox_id)
      for (const cm of db.prepare('SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = ?').all(c.id)) {
        inUse.add(cm.mailbox_id)
      }
    }
    // Disconnected = the mailbox says so, or a Gmail box has lost its refresh
    // token — the state server/google.js already tracks.
    const isDisconnected = (m) => m.status === 'disconnected'
      || m.status === 'error'
      || (m.provider === 'gmail' && !m.refresh_token)
    const summary = {
      total: mailboxes.length,
      total_connected: mailboxes.filter((m) => !isDisconnected(m) && !m.is_suspended).length,
      in_use: mailboxes.filter((m) => inUse.has(m.id)).length,
      disconnected: mailboxes.filter(isDisconnected).length,
      suspended: mailboxes.filter((m) => Boolean(m.is_suspended)).length,
      // Sandbox mailboxes exist to be tested in seconds; warmup does not apply,
      // so they are counted separately and excluded from the warmup gap.
      enabled_without_warmup: mailboxes.filter(
        (m) => m.provider !== 'sandbox' && !isDisconnected(m) && !m.warmup_enabled
      ).length,
      sandbox: mailboxes.filter((m) => m.provider === 'sandbox').length,
    }
    // "Log a telemetry row when `disconnected` rises, so the incident feed
    // carries the transition rather than the steady state." A summary that has
    // said "3 disconnected" for a fortnight is not an incident; the fourth one
    // going dark is.
    const previous = DISCONNECTED_SEEN.get(req.wsId)
    if (previous !== undefined && summary.disconnected > previous) {
      meter('mailboxes.disconnected_rose', 0, false,
        `${previous} -> ${summary.disconnected} of ${summary.total}`)
    }
    DISCONNECTED_SEEN.set(req.wsId, summary.disconnected)
    meter('GET /analytics/mailboxes/summary', Date.now() - t0)
    // The documented envelope alongside the flat one MailboxesTab reads.
    return { ...summary, data: { overall_mailbox_stats: summary } }
  }))

  // --- Docs/analytics/provider-performance.md ------------------------------
  api.get('/analytics/mailboxes/providers', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)

    const providerOf = new Map(
      db.prepare('SELECT id, provider FROM mailboxes WHERE user_id = ?').all(req.wsId)
        .map((m) => [m.id, m.provider])
    )
    const campaignName = new Map(
      campaignsOf(req.wsId, { includeArchived: true }).map((c) => [c.id, c.name])
    )
    const { groups } = rollup(req.wsId, win, ids,
      (row) => (row.mailbox_id ? providerOf.get(row.mailbox_id) ?? null : null))
    const pairs = rollup(req.wsId, win, ids, (row) => {
      if (!row.mailbox_id || !row.campaign_id) return null
      const p = providerOf.get(row.mailbox_id)
      return p ? `${p} ${row.campaign_id}` : null
    }).groups

    // Providers with no sends in the range are omitted.
    const overall = [...groups].filter(([p, s]) => p && s.sent > 0).map(([provider, s]) => ({
      provider, is_sandbox: provider === 'sandbox', ...s,
    })).sort((a, b) => b.sent - a.sent)
    const by_campaign = [...pairs].filter(([, s]) => s.sent > 0).map(([key, s]) => {
      const [provider, campaignId] = key.split(' ')
      return {
        provider,
        is_sandbox: provider === 'sandbox',
        campaign_id: Number(campaignId),
        campaign_name: campaignName.get(Number(campaignId)) || '',
        ...s,
      }
    }).sort((a, b) => b.sent - a.sent)

    meter('GET /analytics/mailboxes/providers', Date.now() - t0)
    return { range: rangeMeta(win), overall, by_campaign }
  }))

  // --- Docs/analytics/followup-reply-rate.md -------------------------------
  // A send's kind comes from the playbook edge that reached its node: an edge
  // from Start is a first email, a `no reply Xd` edge is a follow-up, and a
  // `reply:` edge is a conversation reply, which is neither.
  api.get('/analytics/followup-reply-rate', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)

    const kindByCampaignNode = new Map()
    for (const c of campaignsOf(req.wsId, { includeArchived: true })) {
      if (ids && !ids.includes(c.id)) continue
      let graph
      try { graph = parsePlaybook(c.mermaid) } catch { continue }
      for (const node of Object.values(graph.nodes || {})) {
        if (node.type !== 'send') continue
        const incoming = (graph.edges || []).filter((e) => e.to === node.id)
        let kind = 'uncategorised'
        if (incoming.some((e) => e.from === graph.startId)) kind = 'first'
        else if (incoming.some((e) => e.cond?.kind === 'no_reply' || e.cond?.kind === 'after')) kind = 'followup'
        else if (incoming.some((e) => e.cond?.kind === 'reply')) kind = 'conversation'
        kindByCampaignNode.set(`${c.id}:${node.id}`, kind)
      }
    }

    const tally = {
      first_sent: 0, first_replies: 0,
      followups_sent: 0, followup_replies: 0,
      conversation_sent: 0, conversation_replies: 0,
      uncategorised_sent: 0,
    }
    const sends = outboundRows(req.wsId, win, ids)
    const kindOf = (row) => kindByCampaignNode.get(`${row.campaign_id}:${row.node_id}`) || 'uncategorised'
    const sendKind = new Map()
    for (const row of sends) {
      const kind = kindOf(row)
      sendKind.set(row.id, kind)
      if (kind === 'first') tally.first_sent += 1
      else if (kind === 'followup') tally.followups_sent += 1
      else if (kind === 'conversation') tally.conversation_sent += 1
      else tally.uncategorised_sent += 1
    }
    const originOf = replyOrigins(req.wsId, ids)
    for (const row of inboundRows(req.wsId, win, ids)) {
      const origin = originOf(row)
      if (!origin) continue
      const kind = sendKind.get(origin.id) ?? kindOf(origin)
      if (kind === 'first') tally.first_replies += 1
      else if (kind === 'followup') tally.followup_replies += 1
      else if (kind === 'conversation') tally.conversation_replies += 1
    }

    meter('GET /analytics/followup-reply-rate', Date.now() - t0)
    return {
      range: rangeMeta(win),
      ...tally,
      // HARRY-OVER-SPEC: 0 rather than null when nothing was sent.
      rate: pct(tally.followup_replies, tally.followups_sent),
      first_email_rate: pct(tally.first_replies, tally.first_sent),
    }
  }))

  // --- Docs/analytics/lead-category-response.md ----------------------------
  api.get('/analytics/replies/by-category', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)
    const page = readPage(req.query, { defaultLimit: 100 })

    const counts = new Map()
    let total = 0
    for (const row of inboundRows(req.wsId, win, ids)) {
      const key = categoryKey(row.intent)
      counts.set(key, (counts.get(key) || 0) + 1)
      total += 1
    }
    // Raw keys; the UI does the formatting. Empty range returns [], not a
    // zero-filled skeleton.
    const rows = [...counts].map(([category, n]) => ({
      category: category,
      total_response: n,
      share: pct(n, total),
    })).sort((a, b) => (b.total_response - a.total_response) || a.category.localeCompare(b.category))

    meter('GET /analytics/replies/by-category', Date.now() - t0, true,
      `unclassified=${counts.get(NEEDS_ATTENTION) || 0}`)
    return { range: rangeMeta(win), total_replies: total, ...slicePage(rows, page) }
  }))

  // --- Docs/analytics/lead-stats.md ----------------------------------------
  // A lead is "new" in the range when its first message in that campaign falls
  // inside it. Everything else counted is a chase.
  api.get('/analytics/leads/contact-mix', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)

    const c = campaignClause(ids, 'campaign_id')
    const firstEver = new Map()
    for (const row of db.prepare(
      `SELECT lead_id, campaign_id, MIN(datetime(created_at)) AS first_at
       FROM messages WHERE user_id = ? AND direction = 'out'${c.sql}
       GROUP BY lead_id, campaign_id`
    ).all(req.wsId, ...c.params)) {
      firstEver.set(`${row.lead_id}:${row.campaign_id ?? 0}`, row.first_at)
    }

    const seen = new Set()
    let fresh = 0
    let followUp = 0
    for (const row of outboundRows(req.wsId, win, ids)) {
      const key = `${row.lead_id}:${row.campaign_id ?? 0}`
      if (seen.has(key)) continue
      seen.add(key)
      const first = firstEver.get(key)
      if (first && first >= win.start && first < win.end) fresh += 1
      else followUp += 1
    }
    const total = fresh + followUp
    meter('GET /analytics/leads/contact-mix', Date.now() - t0)
    return {
      range: rangeMeta(win),
      total,
      new: fresh,
      follow_up: followUp,
      // HARRY-OVER-SPEC: 0, not null, on an empty range.
      new_share: pct(fresh, total),
      follow_up_share: pct(followUp, total),
    }
  }))

  // --- Docs/analytics/lead-to-reply-time.md --------------------------------
  const BUCKETS = [
    { bucket: '0-1h', from_hours: 0, to_hours: 1 },
    { bucket: '1-6h', from_hours: 1, to_hours: 6 },
    { bucket: '6-24h', from_hours: 6, to_hours: 24 },
    { bucket: '1-3d', from_hours: 24, to_hours: 72 },
    { bucket: '3-7d', from_hours: 72, to_hours: 168 },
    { bucket: '7d+', from_hours: 168, to_hours: null },
  ]

  api.get('/analytics/reply-time-distribution', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)
    const originOf = replyOrigins(req.wsId, ids)

    const counts = BUCKETS.map(() => 0)
    const firstSeen = new Set()
    let untraceable = 0
    let totalHours = 0
    let counted = 0
    for (const row of inboundRows(req.wsId, win, ids)) {
      // Only a lead's first reply counts; the second one is a conversation,
      // not a response time.
      if (!row.lead_id || firstSeen.has(row.lead_id)) continue
      firstSeen.add(row.lead_id)
      const origin = originOf(row)
      if (!origin) { untraceable += 1; continue }
      const hours = ((toDate(row.created_at)?.getTime() ?? 0) - (toDate(origin.created_at)?.getTime() ?? 0)) / 3600000
      if (!Number.isFinite(hours) || hours < 0) { untraceable += 1; continue }
      const idx = BUCKETS.findIndex((b) => b.to_hours === null || hours < b.to_hours)
      counts[idx === -1 ? BUCKETS.length - 1 : idx] += 1
      totalHours += hours
      counted += 1
    }

    // Every bucket comes back, empty or not, with numeric bounds and a stable
    // order, so a client never parses a label to sort it.
    const buckets = BUCKETS.map((b, i) => ({ ...b, count: counts[i] }))
    meter('GET /analytics/reply-time-distribution', Date.now() - t0)
    return {
      range: rangeMeta(win),
      buckets,
      total: counted,
      untraceable_replies: untraceable,
      average_hours: counted > 0 ? Math.round((totalHours / counted) * 100) / 100 : 0,
      // Kept list-shaped for symmetry; the bucket set is fixed at six.
      items: buckets, limit: buckets.length, offset: 0, hasMore: false,
    }
  }))

  // --- Docs/analytics/overview.md ------------------------------------------
  api.get('/analytics/overview', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)
    const { total } = rollup(req.wsId, win, ids, () => null)

    // The documented fallback: with open tracking off there is no unique-open
    // denominator, so the reply rate stays on leads contacted. Harry's reply
    // rate is already per lead contacted, so the fallback is the same number —
    // stated here rather than left implicit.
    const opens_tracked = total.unique_open_count > 0
    meter('GET /analytics/overview', Date.now() - t0, true, `${win.days}d`)
    return {
      range: rangeMeta(win),
      overall_stats: { ...total, opens_tracked },
      // Which timestamp each field sits on, so a client cannot mix the axes.
      axes: {
        sent: 'send_time', opened: 'send_time', clicked: 'send_time',
        bounced: 'send_time', unique_lead_count: 'send_time', unique_open_count: 'send_time',
        replied: 'reply_time', replied_leads: 'reply_time', positive_replied: 'reply_time',
        won: 'outcome_time', lost: 'outcome_time', unsubscribed: 'outcome_time',
      },
      notes: {
        non_additive: ['unique_lead_count', 'unique_open_count', 'positive_replied', 'replied_leads'],
        bounce_rate: 'bounced leads per lead contacted',
        bounce_share: 'bounced emails per email sent',
        rates: 'percentages to one decimal; 0 when the denominator is 0',
      },
    }
  }))

  // --- Docs/analytics/team-board-stats.md ----------------------------------
  api.get('/analytics/team', handler((req) => {
    const t0 = Date.now()
    const win = readWindow(req)
    const ids = readCampaignIds(req)

    const ownerRow = owner(req.wsId)
    const members = [
      { email: ownerRow?.email || req.user?.email || '', role: 'owner', status: 'active' },
      ...db.prepare('SELECT email, role, status FROM team_members WHERE owner_id = ? ORDER BY id').all(req.wsId),
    ]
    const seen = new Set()
    const roster = members.filter((m) => m.email && !seen.has(m.email) && seen.add(m.email))

    const blank = () => ({
      campaigns_created: 0, leads_assigned: 0, approvals: 0, declines: 0,
      notes_written: 0, tasks_created: 0, replies_handled: 0,
      _replySeconds: [],
      // Outcome figures for the leads this member owns. Sets, because a lead
      // that was mailed four times and replied twice is still one lead.
      _leads: new Set(), _openLeads: new Set(), _replyLeads: new Set(), _positiveLeads: new Set(),
    })
    const board = new Map(roster.map((m) => [m.email, blank()]))
    const bump = (email, field, by = 1) => {
      const key = String(email || '').trim()
      if (!key || !board.has(key)) return
      board.get(key)[field] += by
    }
    const inWindow = (stamp) => {
      if (!stamp) return false
      const d = toDate(stamp)
      if (!d) return false
      const s = sqlStamp(d)
      return s >= win.start && s < win.end
    }

    for (const c of campaignsOf(req.wsId, { includeArchived: true })) {
      if (ids && !ids.includes(c.id)) continue
      if (inWindow(c.created_at)) bump(c.owner_email, 'campaigns_created')
    }
    for (const d of db.prepare(
      "SELECT status, reviewed_by, reviewed_at, campaign_id FROM drafts WHERE user_id = ? AND status IN ('approved','declined','sent')"
    ).all(req.wsId)) {
      if (ids && !ids.includes(d.campaign_id)) continue
      if (!inWindow(d.reviewed_at)) continue
      bump(d.reviewed_by, d.status === 'declined' ? 'declines' : 'approvals')
    }
    for (const row of db.prepare(
      `SELECT cl.assigned_email, cl.assigned_at, cl.last_reply_at, cl.campaign_id
       FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE c.user_id = ? AND COALESCE(cl.assigned_email,'') != ''`
    ).all(req.wsId)) {
      if (ids && !ids.includes(row.campaign_id)) continue
      if (inWindow(row.assigned_at)) bump(row.assigned_email, 'leads_assigned')
      if (inWindow(row.last_reply_at)) bump(row.assigned_email, 'replies_handled')
    }
    for (const n of db.prepare('SELECT author_email, created_at, campaign_id FROM lead_notes WHERE workspace_id = ?').all(req.wsId)) {
      if (ids && n.campaign_id && !ids.includes(n.campaign_id)) continue
      if (inWindow(n.created_at)) bump(n.author_email, 'notes_written')
    }
    for (const t of db.prepare('SELECT created_by, created_at, campaign_id FROM lead_tasks WHERE workspace_id = ?').all(req.wsId)) {
      if (ids && t.campaign_id && !ids.includes(t.campaign_id)) continue
      if (inWindow(t.created_at)) bump(t.created_by, 'tasks_created')
    }

    // Who owns which lead in which campaign. Built once, and used both for the
    // outcome columns below and for reply turnaround further down.
    const assignee = new Map()
    for (const row of db.prepare(
      `SELECT cl.lead_id, cl.campaign_id, cl.assigned_email FROM campaign_leads cl
       JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ?`
    ).all(req.wsId)) {
      if (row.assigned_email) assignee.set(`${row.lead_id}:${row.campaign_id}`, row.assigned_email)
    }
    const ownerOfLead = (row) => assignee.get(`${row.lead_id}:${row.campaign_id}`)

    // The outcome columns the spec names — lead_count, unique_open_count,
    // reply_count, positive_reply_count and their rates — attributed by lead
    // assignment, which is the only attribution Harry actually records for a
    // reply. Same window, same REAL_SEND definition, same rate arithmetic as
    // every other rollup in this module.
    for (const row of outboundRows(req.wsId, win, ids)) {
      const who = ownerOfLead(row)
      if (!who || !board.has(who) || !row.lead_id) continue
      const b = board.get(who)
      b._leads.add(row.lead_id)
      if (row.opened_at) b._openLeads.add(row.lead_id)
    }
    for (const row of inboundRows(req.wsId, win, ids)) {
      const who = ownerOfLead(row)
      if (!who || !board.has(who) || !row.lead_id) continue
      const b = board.get(who)
      b._replyLeads.add(row.lead_id)
      if (sentimentOf(row.intent) === 'positive') b._positiveLeads.add(row.lead_id)
    }

    // Reply turnaround: the gap between an inbound reply and the next manual
    // outbound on the same thread, attributed to whoever the lead is assigned to.
    const threads = new Map()
    for (const m of db.prepare(
      `SELECT lead_id, campaign_id, direction, manual_reply, created_at FROM messages
       WHERE user_id = ? ORDER BY id`
    ).all(req.wsId)) {
      const key = `${m.lead_id}:${m.campaign_id}`
      if (m.direction === 'in') { threads.set(key, m.created_at); continue }
      if (!m.manual_reply) continue
      const openedAt = threads.get(key)
      if (!openedAt || !inWindow(m.created_at)) continue
      threads.delete(key)
      const seconds = ((toDate(m.created_at)?.getTime() ?? 0) - (toDate(openedAt)?.getTime() ?? 0)) / 1000
      if (!Number.isFinite(seconds) || seconds < 0) continue
      const who = assignee.get(key)
      if (who && board.has(who)) board.get(who)._replySeconds.push(seconds)
    }

    const humanise = (s) => {
      if (!s) return '—'
      if (s < 3600) return `${Math.round(s / 60)}m`
      if (s < 86400) return `${Math.round((s / 3600) * 10) / 10}h`
      return `${Math.round((s / 86400) * 10) / 10}d`
    }
    // Inactive members are returned with zeros, never omitted.
    const items = roster.map((m) => {
      const b = board.get(m.email)
      const { _replySeconds, _leads, _openLeads, _replyLeads, _positiveLeads, ...rest } = b
      const avg = _replySeconds.length
        ? Math.round(_replySeconds.reduce((a, x) => a + x, 0) / _replySeconds.length)
        : 0
      const leadCount = _leads.size
      const replyCount = _replyLeads.size
      const positiveCount = _positiveLeads.size
      return {
        email: m.email, role: m.role, status: m.status, ...rest,
        // The spec's column set. `lead_count` is leads contacted in the range,
        // which is the denominator the two rates divide by — the same
        // per-lead-contacted definition every other rate in this module uses.
        lead_count: leadCount,
        campaign_count: rest.campaigns_created,
        unique_open_count: _openLeads.size,
        reply_count: replyCount,
        positive_reply_count: positiveCount,
        reply_rate: pct(replyCount, leadCount),
        positive_reply_rate: pct(positiveCount, leadCount),
        average_reply_seconds: avg,
        average_reply_time: humanise(avg),
        // AC: a member with nothing in the range is a zero row with a note, not
        // a missing row.
        no_activity: leadCount === 0 && rest.campaigns_created === 0 && rest.approvals === 0
          && rest.declines === 0 && rest.notes_written === 0 && rest.tasks_created === 0
          && rest.replies_handled === 0,
      }
    })
    meter('GET /analytics/team', Date.now() - t0)
    const page = readPage(req.query, { defaultLimit: 100 })
    const sliced = slicePage(items, page)
    return {
      range: rangeMeta(win),
      // Which rule earned which column. AC2 requires the panel to be able to
      // say this, and it must come from the module that does the attributing.
      attribution: {
        campaign_count: 'the campaign\'s owner_email, on campaigns created inside the range',
        leads_assigned: 'the assignee, on leads assigned inside the range',
        approvals: 'the reviewer who approved or sent the draft',
        declines: 'the reviewer who declined the draft',
        notes_written: 'the note\'s author',
        tasks_created: 'the task\'s creator',
        lead_count: 'the assignee of each lead contacted in the range',
        unique_open_count: 'the assignee of each lead who opened in the range',
        reply_count: 'the assignee of each lead who replied in the range',
        positive_reply_count: 'the assignee of each lead whose reply was positive',
        average_reply_time: 'the assignee of the lead whose thread was answered',
      },
      rates: 'percentages to one decimal; 0 when the denominator is 0',
      ...sliced,
      data: { team_board_stats: sliced.items },
    }
  }))

  // ================= campaign-statistics ====================================

  const ownedCampaign = (req) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw notFound('campaign')
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(id, req.wsId)
    // A campaign in another workspace and a campaign that never existed are
    // indistinguishable from out here, deliberately.
    if (!row) throw notFound('campaign')
    return row
  }

  // --- Docs/campaign-statistics/top-level.md -------------------------------
  // Cheap enough to open a campaign page with. The cache key carries the
  // campaign's newest message and newest lead state, so the next send, reply
  // or outcome invalidates it without anyone remembering to.
  const headlineCache = new Map()

  function campaignHeadline(wsId, campaign, win) {
    const range = win || {
      tz: 'UTC', from: '', to: '', days: 0,
      start: '0000-01-01 00:00:00', end: '9999-12-31 23:59:59',
    }
    const { total } = rollup(wsId, range, [campaign.id], () => null)
    const stages = leadStages(wsId)
    const inCampaign = db.prepare('SELECT lead_id, state FROM campaign_leads WHERE campaign_id = ?').all(campaign.id)
    const byStage = {}
    const byState = {}
    for (const row of inCampaign) {
      const stage = stages[row.lead_id] || 'not contacted'
      byStage[stage] = (byStage[stage] || 0) + 1
      byState[row.state] = (byState[row.state] || 0) + 1
    }
    const revenue = db.prepare(
      'SELECT COALESCE(SUM(revenue_amount), 0) amount FROM campaign_leads WHERE campaign_id = ?'
    ).get(campaign.id).amount
    return {
      campaign_id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      leads_total: inCampaign.length,
      ...total,
      revenue_amount: num(revenue),
      // Derived, never stored — the rule the Leads page already follows.
      by_stage: byStage,
      by_state: byState,
    }
  }

  api.get('/campaigns/:id/analytics', handler((req) => {
    const t0 = Date.now()
    const campaign = ownedCampaign(req)
    const stamp = db.prepare(
      `SELECT (SELECT COALESCE(MAX(id), 0) FROM messages WHERE campaign_id = ?) msg,
              (SELECT COALESCE(MAX(updated_at), '') FROM campaign_leads WHERE campaign_id = ?) leads`
    ).get(campaign.id, campaign.id)
    const key = `${campaign.id}:${stamp.msg}:${stamp.leads}:${campaign.updated_at}`
    const hit = headlineCache.get(campaign.id)
    if (hit && hit.key === key) {
      meter('GET /campaigns/:id/analytics', Date.now() - t0, true, 'cache=hit')
      return { ok: true, data: hit.data, cached: true }
    }
    const data = campaignHeadline(req.wsId, campaign, null)
    headlineCache.set(campaign.id, { key, data })
    meter('GET /campaigns/:id/analytics', Date.now() - t0, true, 'cache=miss')
    return { ok: true, data, cached: false }
  }))

  // --- Docs/campaign-statistics/top-level-by-date.md -----------------------
  // The same aggregation with a date predicate, so "all time" and "the whole
  // campaign's range" are one code path and cannot disagree.
  api.get('/campaigns/:id/top-level-analytics-by-date', handler((req) => {
    const t0 = Date.now()
    const campaign = ownedCampaign(req)
    const win = readWindow(req, {
      fromField: 'start_date', toField: 'end_date', tzField: 'time_zone', requireDates: true,
    })
    const data = campaignHeadline(req.wsId, campaign, win)
    meter('GET /campaigns/:id/top-level-analytics-by-date', Date.now() - t0, true, `${win.days}d`)
    return { ok: true, range: rangeMeta(win), data }
  }))

  // --- Docs/campaign-statistics/get-by-date-range.md -----------------------
  api.get('/campaigns/:id/analytics-by-date', handler((req) => {
    const t0 = Date.now()
    const campaign = ownedCampaign(req)
    const win = readWindow(req, { fromField: 'start_date', toField: 'end_date', tzField: 'time_zone' })

    const days = new Map(denseDays(win).map((d) => [d, {
      date: d, sent: 0, opened: 0, clicked: 0, replied: 0, positive_replied: 0,
      bounced: 0, unsubscribed: 0, _leads: new Set(),
    }]))
    const at = (k) => (k && days.has(k) ? days.get(k) : null)
    for (const row of outboundRows(req.wsId, win, [campaign.id])) {
      const d = at(dayKey(win.tz, row.created_at))
      if (!d) continue
      d.sent += 1
      if (row.send_status === 'bounced') d.bounced += 1
      if (row.lead_id) d._leads.add(row.lead_id)
      const o = at(dayKey(win.tz, row.opened_at))
      if (row.opened_at && o) o.opened += 1
      const cl = at(dayKey(win.tz, row.clicked_at))
      if (row.clicked_at && cl) cl.clicked += 1
    }
    for (const row of inboundRows(req.wsId, win, [campaign.id])) {
      const d = at(dayKey(win.tz, row.created_at))
      if (!d) continue
      d.replied += 1
      if (sentimentOf(row.intent) === 'positive') d.positive_replied += 1
    }
    for (const row of outcomeRows(req.wsId, win, [campaign.id])) {
      if (row.outcome !== 'unsubscribed') continue
      const d = at(dayKey(win.tz, row.at))
      if (d) d.unsubscribed += 1
    }
    // One row per day in range, zero-filled for silent days.
    const data = [...days.values()].map(({ _leads, ...rest }) => ({ ...rest, unique_lead_reached: _leads.size }))
    meter('GET /campaigns/:id/analytics-by-date', Date.now() - t0, true, `${win.days}d/${win.tz}`)
    return { ok: true, range: rangeMeta(win), data, total: data.length, limit: data.length, offset: 0, hasMore: false }
  }))

  // --- Docs/campaign-statistics/get-by-id.md -------------------------------
  // Per-step statistics. The node-to-step map comes from the parsed playbook,
  // so the numbers follow diagram edits; a node deleted after sending still
  // reports its history, flagged `in_playbook: false` rather than vanishing.
  api.get('/campaigns/:id/statistics', handler((req) => {
    const t0 = Date.now()
    const campaign = ownedCampaign(req)
    // HARRY-OVER-SPEC in reverse: everywhere else in this module an over-large
    // `limit` is a 422, but get-by-id.md is explicit that above 1000 is clamped
    // "rather than failing, and the clamp is invisible to the user". The caller
    // still gets a bounded page and the applied limit is echoed, so the house
    // rule that an unbounded request is never served still holds.
    const page = {
      limit: Math.min(int(req.query, 'limit', { min: 1, fallback: 100 }), 1000),
      offset: int(req.query, 'offset', { min: 0, fallback: 0 }),
    }
    const win = readWindow(req, {
      fromField: 'sent_time_start_date', toField: 'sent_time_end_date', tzField: 'time_zone',
    })
    // 1-20 is the documented bound (TC-4 checks both ends), and the message
    // states the whole range rather than only the end that was breached.
    const seqRaw = req.query?.email_sequence_number
    let wantSeq = null
    if (seqRaw !== undefined && seqRaw !== '') {
      const n = Number(seqRaw)
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        throw invalid('email_sequence_number', 'email_sequence_number must be a whole number from 1 to 20')
      }
      wantSeq = n
    }

    // `email_status` used to be compared against `messages.send_status`, whose
    // values are 'sent' / 'bounced' / 'test' / 'scheduled'. None of the four
    // documented statuses is one of those, so `email_status=opened` — and
    // clicked, and replied, and unsubscribed — silently returned zero rows on
    // every campaign. Each one is now an explicit predicate, and a value outside
    // the allow-list is a 422 rather than an empty table.
    const EMAIL_STATUSES = ['opened', 'clicked', 'replied', 'unsubscribed', 'bounced']
    const status = String(req.query?.email_status || '').trim().toLowerCase()
    if (status && !EMAIL_STATUSES.includes(status)) {
      throw invalid('email_status', `email_status must be one of: ${EMAIL_STATUSES.join(', ')}`)
    }

    let graph = { nodes: {}, edges: [], startId: null }
    try { graph = parsePlaybook(campaign.mermaid) } catch { /* keep the empty graph */ }
    // Breadth-first from Start gives a stable, human-obvious step order.
    const order = []
    if (graph.startId) {
      const seen = new Set([graph.startId])
      const queue = [graph.startId]
      while (queue.length) {
        const cur = queue.shift()
        if (graph.nodes[cur]?.type === 'send') order.push(cur)
        for (const e of graph.edges) {
          if (e.from === cur && graph.nodes[e.to] && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to) }
        }
      }
    }
    const seqOf = new Map(order.map((id, i) => [id, i + 1]))

    const steps = new Map()
    const step = (nodeId) => {
      if (!steps.has(nodeId)) {
        steps.set(nodeId, {
          campaign_id: campaign.id,
          node_id: nodeId,
          sequence_number: seqOf.get(nodeId) ?? 0,
          step_label: graph.nodes[nodeId]?.label || '',
          in_playbook: Boolean(graph.nodes[nodeId]),
          sent: 0, opened: 0, clicked: 0, bounced: 0, replied: 0, unsubscribed: 0,
          _leads: new Set(),
        })
      }
      return steps.get(nodeId)
    }
    for (const id of order) step(id)

    // The two per-lead facts the row-level filters need. Both are read once,
    // not per row.
    const originOf = replyOrigins(req.wsId, [campaign.id])
    const inbound = inboundRows(req.wsId, win, [campaign.id])
    const repliedSends = new Set()
    for (const row of inbound) {
      const origin = originOf(row)
      if (origin) repliedSends.add(origin.id)
    }
    const unsubscribedLeads = new Set(db.prepare(
      `SELECT cl.lead_id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
        WHERE cl.campaign_id = ? AND (COALESCE(cl.unsubscribed_at,'') != '' OR l.status = 'unsubscribed')`
    ).all(campaign.id).map((r) => r.lead_id))

    const matchesStatus = (row) => {
      if (!status) return true
      if (status === 'opened') return Boolean(row.opened_at)
      if (status === 'clicked') return Boolean(row.clicked_at)
      if (status === 'bounced') return row.send_status === 'bounced'
      if (status === 'replied') return repliedSends.has(row.id)
      return unsubscribedLeads.has(row.lead_id)   // 'unsubscribed'
    }

    const sends = outboundRows(req.wsId, win, [campaign.id])
    const sendIndex = new Map()
    // An unsubscribe is attributed to the last step that reached the lead —
    // the email they walked away from — so the count never lands on every step
    // the lead ever saw.
    const lastStepOf = new Map()
    for (const row of sends) {
      const seq = num(row.sequence_number) || seqOf.get(row.node_id) || 0
      if (wantSeq !== null && seq !== wantSeq) continue
      if (!matchesStatus(row)) continue
      const s = step(row.node_id || '(unknown)')
      s.sequence_number = s.sequence_number || seq
      s.sent += 1
      if (row.opened_at) s.opened += 1
      if (row.clicked_at) s.clicked += 1
      if (row.send_status === 'bounced') s.bounced += 1
      if (row.lead_id) { s._leads.add(row.lead_id); lastStepOf.set(row.lead_id, row.node_id || '(unknown)') }
      sendIndex.set(row.id, row.node_id || '(unknown)')
    }
    for (const [leadId, nodeId] of lastStepOf) {
      if (unsubscribedLeads.has(leadId)) steps.get(nodeId).unsubscribed += 1
    }
    for (const row of inbound) {
      const origin = originOf(row)
      if (!origin) continue
      const nodeId = sendIndex.get(origin.id)
      if (!nodeId) continue
      steps.get(nodeId).replied += 1
    }

    const rows = [...steps.values()].map(({ _leads, ...rest }) => ({
      ...rest,
      unique_lead_count: _leads.size,
      open_rate: pct(rest.opened, rest.sent),
      click_rate: pct(rest.clicked, rest.sent),
      reply_rate: pct(rest.replied, rest.sent),
      bounce_share: pct(rest.bounced, rest.sent),
      unsubscribe_rate: pct(rest.unsubscribed, rest.sent),
    })).sort((a, b) => (a.sequence_number - b.sequence_number) || a.node_id.localeCompare(b.node_id))

    const sliced = slicePage(rows, page)
    meter('GET /campaigns/:id/statistics', Date.now() - t0, true,
      `rows=${rows.length} seq=${wantSeq ?? 'any'} status=${status || 'any'}`)
    return {
      ok: true, data: sliced.items, offset: sliced.offset, limit: sliced.limit,
      total: sliced.total, hasMore: sliced.hasMore, range: rangeMeta(win),
      filters: { email_sequence_number: wantSeq, email_status: status || null },
    }
  }))

  // --- Docs/campaign-statistics/lead-statistics.md -------------------------
  api.get('/campaigns/:id/leads-statistics', handler((req) => {
    const t0 = Date.now()
    const campaign = ownedCampaign(req)
    const page = readPage(req.query, { defaultLimit: 100, maxLimit: 100 })
    const after = readDate(req.query, 'event_time_gt')

    const stages = leadStages(req.wsId)
    const perLead = new Map()
    for (const row of db.prepare(
      `SELECT lead_id, direction, opened_at, clicked_at, send_status, created_at
       FROM messages WHERE user_id = ? AND campaign_id = ? ORDER BY id`
    ).all(req.wsId, campaign.id)) {
      if (!perLead.has(row.lead_id)) {
        perLead.set(row.lead_id, { sent: 0, opened: 0, clicked: 0, bounced: 0, replied: 0, last: '' })
      }
      const s = perLead.get(row.lead_id)
      if (row.direction === 'out') {
        s.sent += 1
        if (row.opened_at) s.opened += 1
        if (row.clicked_at) s.clicked += 1
        if (row.send_status === 'bounced') s.bounced += 1
      } else s.replied += 1
      const at = toDate(row.created_at)
      if (at) { const stamp = sqlStamp(at); if (stamp > s.last) s.last = stamp }
    }

    let rows = db.prepare(
      `SELECT cl.lead_id, cl.state, cl.intent, cl.outcome, cl.node_id, cl.updated_at,
              cl.revenue_amount, cl.revenue_currency, cl.category_id, cl.assigned_email,
              cl.last_reply_at, cl.unsubscribed_at,
              l.email, l.first_name, l.last_name, l.company, l.title, l.status AS lead_status
       FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ?`
    ).all(campaign.id).map((r) => {
      const s = perLead.get(r.lead_id) || { sent: 0, opened: 0, clicked: 0, bounced: 0, replied: 0, last: '' }
      const lastEvent = s.last || sqlStamp(toDate(r.updated_at) || new Date(0))
      return {
        lead_id: r.lead_id,
        email: r.email,
        first_name: r.first_name,
        last_name: r.last_name,
        company: r.company,
        title: r.title,
        lead_status: r.lead_status,
        // Derived, never stored.
        stage: stages[r.lead_id] || 'not contacted',
        state: r.state,
        node_id: r.node_id,
        intent: r.intent,
        outcome: r.outcome,
        category_id: r.category_id ?? null,
        assigned_email: r.assigned_email || '',
        revenue_amount: num(r.revenue_amount),
        revenue_currency: r.revenue_currency || 'USD',
        last_reply_at: r.last_reply_at || '',
        unsubscribed_at: r.unsubscribed_at || '',
        sent: s.sent, opened: s.opened, clicked: s.clicked, bounced: s.bounced, replied: s.replied,
        open_rate: pct(s.opened, s.sent),
        reply_rate: pct(s.replied, s.sent),
        last_event_at: lastEvent,
      }
    })
    if (after) {
      const bound = `${after.key} 00:00:00`
      rows = rows.filter((r) => r.last_event_at >= bound)
    }
    // Stable order: newest event first, lead id as the tiebreak, so inserting a
    // lead between two page fetches cannot duplicate or drop a row.
    rows.sort((a, b) => (a.last_event_at === b.last_event_at
      ? a.lead_id - b.lead_id
      : (a.last_event_at < b.last_event_at ? 1 : -1)))

    const sliced = slicePage(rows, page)
    // Nothing lead-identifying goes into telemetry.
    meter('GET /campaigns/:id/leads-statistics', Date.now() - t0, true, `rows=${sliced.items.length}`)
    return {
      ok: true, data: sliced.items, offset: sliced.offset, limit: sliced.limit,
      total: sliced.total, hasMore: sliced.hasMore,
    }
  }))

  // --- Docs/campaign-statistics/mailbox-statistics.md ----------------------
  // Smartlead's `client_id` and `private_api_key` have no Harry equivalent and
  // are deliberately not modelled: the session already establishes the workspace.
  api.get('/campaigns/:id/mailbox-statistics', handler((req) => {
    const t0 = Date.now()
    const campaign = ownedCampaign(req)
    const page = readPage(req.query, { defaultLimit: 20, maxLimit: 20 })
    const hasStart = Boolean(String(req.query?.start_date || '').trim())
    const hasEnd = Boolean(String(req.query?.end_date || '').trim())
    // A partial range falls back to the campaign's whole life, and the
    // response says which window was actually applied.
    const partial = hasStart !== hasEnd
    const query = partial ? { ...req.query, start_date: '', end_date: '' } : req.query
    const win = readWindow({ query }, {
      fromField: 'start_date', toField: 'end_date', tzField: 'time_zone',
    })
    const applied = partial ? 'campaign' : (hasStart && hasEnd ? 'requested' : 'default')
    const wide = applied === 'requested'
      ? win
      : { ...win, start: '0000-01-01 00:00:00', end: '9999-12-31 23:59:59' }

    const { groups } = rollup(req.wsId, wide, [campaign.id], (row) => row.mailbox_id ?? null)
    const attached = new Set(db.prepare('SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = ?')
      .all(campaign.id).map((r) => r.mailbox_id))
    if (campaign.mailbox_id) attached.add(campaign.mailbox_id)
    for (const id of groups.keys()) attached.add(id)

    const rows = [...attached].map((id) => {
      // A revoked-token mailbox still reports its history.
      const mb = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').get(id, req.wsId)
      return {
        mailbox_id: id,
        email: mb?.email || '',
        provider: mb?.provider || '',
        status: mb?.status || 'unknown',
        daily_limit: num(mb?.daily_limit),
        remaining_today: mb ? remainingToday(mb) : 0,
        ...(groups.get(id) || finishBucket(emptyBucket())),
      }
    }).filter((r) => r.email)
    rows.sort((a, b) => (b.sent - a.sent) || a.email.localeCompare(b.email))

    const sliced = slicePage(rows, page)
    meter('GET /campaigns/:id/mailbox-statistics', Date.now() - t0, true, `window=${applied}`)
    return {
      ok: true,
      range: { ...rangeMeta(win), applied },
      data: sliced.items, offset: sliced.offset, limit: sliced.limit,
      total: sliced.total, hasMore: sliced.hasMore,
    }
  }))
}

// The window, echoed on every ranged response so a caption never has to guess.
function rangeMeta(win) {
  return { from: win.from, to: win.to, days: win.days, timezone: win.tz }
}
