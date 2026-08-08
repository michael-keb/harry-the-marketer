// Shared request plumbing for the parity modules.
//
// The backlog specifies the same handful of behaviours in nearly every file:
// a 422 that names the offending field, a 404 that leaks nothing about the
// record it refused, cursor paging that is stable when rows are inserted
// mid-scroll, and writes that are all-or-nothing. Each is written once here so
// eighteen modules cannot drift apart on what a 422 looks like.

import { db, logEvent } from '../db.js'
import { recordTelemetry } from '../telemetry.js'

// ---- error shapes -----------------------------------------------------------

export class HttpError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.message || 'error')
    this.status = status
    this.body = typeof body === 'string' ? { message: body } : body
  }
}

// 422 naming the field, as every spec's validation test case requires.
export function invalid(field, message) {
  return new HttpError(422, { error: 'validation_failed', field, message })
}

// 404 that never echoes the record. Specs are explicit: a cross-workspace id
// must not leak the lead's name, the campaign's name, or its existence.
export function notFound(what = 'record') {
  return new HttpError(404, { error: 'not_found', message: `No such ${what}` })
}

export function forbidden(message = 'Not permitted') {
  return new HttpError(403, { error: 'forbidden', message })
}

// Wraps a handler so thrown HttpErrors become responses and anything else
// becomes a 500 with the detail in telemetry rather than in the body.
export function handler(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res)
      if (out !== undefined && !res.headersSent) res.json(out)
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json(err.body)
      recordTelemetry('api_error', { op: `${req.method} ${req.baseUrl}${req.path}`, ok: false, detail: String(err?.message || err) })
      if (!res.headersSent) res.status(500).json({ error: 'server_error', message: 'Something went wrong' })
    }
  }
}

// ---- validation -------------------------------------------------------------

export function str(body, field, { required = false, max = 5000, fallback = '' } = {}) {
  const raw = body?.[field]
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw invalid(field, `${field} is required`)
    return fallback
  }
  const value = String(raw).trim()
  if (required && !value) throw invalid(field, `${field} is required`)
  if (value.length > max) throw invalid(field, `${field} must be ${max} characters or fewer`)
  return value
}

export function int(body, field, { required = false, min = null, max = null, fallback = 0 } = {}) {
  const raw = body?.[field]
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw invalid(field, `${field} is required`)
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) throw invalid(field, `${field} must be a number`)
  const n = Math.trunc(value)
  if (min !== null && n < min) throw invalid(field, `${field} must be at least ${min}`)
  if (max !== null && n > max) throw invalid(field, `${field} must be at most ${max}`)
  return n
}

export function bool(body, field, fallback = false) {
  const raw = body?.[field]
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())
}

export function oneOf(body, field, allowed, { required = false, fallback = '' } = {}) {
  const value = str(body, field, { required, fallback })
  if (!value) return fallback
  if (!allowed.includes(value)) {
    throw invalid(field, `${field} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

// Every id list in the backlog is capped. An unbounded request is rejected
// rather than served — the same rule that makes campaigns/get-all page.
export function idList(body, field, { required = false, max = 2000 } = {}) {
  const raw = body?.[field]
  if (raw === undefined || raw === null) {
    if (required) throw invalid(field, `${field} is required`)
    return []
  }
  if (!Array.isArray(raw)) throw invalid(field, `${field} must be an array`)
  if (required && raw.length === 0) throw invalid(field, `${field} must contain at least one id`)
  if (raw.length > max) throw invalid(field, `${field} may contain at most ${max} ids`)
  const ids = []
  for (const item of raw) {
    const n = Number(item)
    if (!Number.isInteger(n) || n <= 0) throw invalid(field, `${field} contains an invalid id: ${item}`)
    if (!ids.includes(n)) ids.push(n)
  }
  return ids
}

export function isoDate(query, field, fallback = '') {
  const raw = query?.[field]
  if (!raw) return fallback
  const d = new Date(String(raw))
  if (Number.isNaN(d.getTime())) throw invalid(field, `${field} must be an ISO date`)
  return d.toISOString()
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export function email(body, field, { required = false, fallback = '' } = {}) {
  const value = str(body, field, { required, max: 320, fallback })
  if (!value) return fallback
  if (!EMAIL_RE.test(value)) throw invalid(field, `${field} must be a valid email address`)
  return value.toLowerCase()
}

// ---- paging -----------------------------------------------------------------

// Keyset paging on a monotonic id. Stable when rows are inserted mid-scroll,
// which offset paging is not — several E2E tickets assert exactly that.
export function page(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = int(query, 'limit', { min: 1, max: maxLimit, fallback: defaultLimit })
  const cursor = int(query, 'cursor', { min: 0, fallback: 0 })
  const offset = int(query, 'offset', { min: 0, fallback: 0 })
  return { limit, cursor, offset }
}

// Slices one extra row to decide `nextCursor` without a second COUNT query.
export function paged(rows, limit, key = 'id') {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1][key] : null,
    hasMore,
  }
}

// ---- workspace-scoped lookups ----------------------------------------------

// The one place that decides a record belongs to the caller. Older tables key
// the workspace as `user_id`; newer ones say `workspace_id`. Both are the same
// value, so the column is named per table rather than guessed.
const WS_COLUMN = {
  leads: 'user_id',
  campaigns: 'user_id',
  mailboxes: 'user_id',
  messages: 'user_id',
  goals: 'user_id',
  drafts: 'user_id',
}

export function owned(table, id, wsId, what = table) {
  const col = WS_COLUMN[table] || 'workspace_id'
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw notFound(what)
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND ${col} = ?`).get(n, wsId)
  if (!row) throw notFound(what)
  return row
}

// Verifies every id in one go and reports the first rejected id by number, as
// the "all-or-nothing" acceptance criteria require ("a 404 identifies the
// rejected id and none of the labels in the request are applied").
export function ownedAll(table, ids, wsId, what = table) {
  const col = WS_COLUMN[table] || 'workspace_id'
  const rows = []
  for (const id of ids) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND ${col} = ?`).get(id, wsId)
    if (!row) throw new HttpError(404, { error: 'not_found', message: `No such ${what}: ${id}`, id })
    rows.push(row)
  }
  return rows
}

// ---- writes -----------------------------------------------------------------

// One SQLite transaction, so a partial apply is impossible. better-sqlite3
// transactions are synchronous by design — handlers that need to await should
// do their awaiting outside the callback.
export function tx(fn) {
  return db.transaction(fn)()
}

export function nowIso() {
  return new Date().toISOString()
}

// ---- audit ------------------------------------------------------------------

// A bulk action writes one events row, not one per record — several specs call
// this out explicitly ("one row for a bulk action, not one per lead").
export function audit(req, { campaignId = null, leadId = null, type, detail = '' }) {
  logEvent(req.wsId, { campaignId, leadId, type, detail })
}

export function meter(op, ms, ok = true, detail = '') {
  recordTelemetry('parity', { op, ok, ms, detail })
}
