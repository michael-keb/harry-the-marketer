// Backend gaps that block a real UI affordance.
//
// Six routes that exist for one reason each: a screen in the app cannot do the
// thing it visibly offers, because nothing on the server answers the question
// it needs to ask. They are grouped here rather than spread across six modules
// because they were found together, as a set, by walking the UI — but each one
// follows the conventions of the module it extends, and none of them changes a
// line of it.
//
//   1. GET  /api/lead-lists/:id/leads   who is in this segment          (lists)
//   2. GET  /api/workspace/members      who can own a campaign          (team)
//   3. GET  /api/senders/orders         what have we ordered            (senders)
//   4. POST /api/webhooks/:id/test      does this endpoint work         (webhooks)
//   5. POST /api/webhooks/retry         replay failures, workspace-wide (webhooks)
//   6. POST /api/block-list/parse       what will this paste do         (utilities)
//
// Two deliberate divergences from the obvious implementation, stated here
// because a reader will otherwise assume a bug:
//
//   * `fireWebhooks` is the publish path for *real* events, and it deliberately
//     fans out by subscription: it selects every active endpoint listening for
//     the event, applies workspace-over-campaign scope priority, and cannot be
//     addressed at one row. A test event is the opposite — it must reach the one
//     endpoint the operator clicked, must work on an endpoint that is paused
//     (which is exactly when you want to test it) or subscribed to nothing, and
//     must never touch anybody else's integration. So `deliverOnce` below is a
//     single-target delivery that reuses `signPayload` and the same headers,
//     records the same `webhook_deliveries` shape, and goes through the same
//     injectable transport. The retry in (5) needs the same thing for a
//     different reason: it replays a *stored* payload to a *named* endpoint,
//     which `fireWebhooks` cannot express — it would build a fresh envelope and
//     re-select the targets.
//   * A test delivery is recorded with `event_type = 'test'` and is excluded
//     from the retry sweep. A test is a manual act; silently replaying one later
//     as though it were a missed business event would be a lie to the receiver.

import crypto from 'node:crypto'
import { db } from '../db.js'
import {
  HttpError, handler, invalid, notFound,
  str, int, oneOf, page, paged,
  owned, audit, meter, nowIso,
} from './http.js'
import {
  signPayload, setWebhookTransport, webhookUrlProblem,
  WEBHOOK_EVENT_LABELS,
} from './webhooks.js'
import { normaliseBlockValue } from './utilities.js'

// ---- shared ----------------------------------------------------------------

// A non-numeric id in a path is a 422 naming the parameter; a well-formed id
// that is not ours is a 404 that says nothing about the record.
function pathId(req, param = 'id') {
  const raw = req.params[param]
  if (!/^\d+$/.test(String(raw))) throw invalid(param, `${param} must be a positive integer`)
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw invalid(param, `${param} must be a positive integer`)
  return n
}

// `%` and `_` in a search box are the characters a person typed, not wildcards.
function likeArg(value) {
  return `%${String(value).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

// ---- 1. segment members -----------------------------------------------------

const LEAD_SEARCH_MAX = 320

// The soft-delete rule from server/parity/lists.js: a deleted segment is
// indistinguishable from one that never existed and from a stranger's.
function ownedList(id, wsId) {
  const row = owned('lead_lists', id, wsId, 'lead list')
  if (String(row.deleted_at || '')) throw notFound('lead list')
  return row
}

// Exactly the columns the Leads table renders, and nothing else. A segment
// member is still a lead, so the field names match server/parity/leads.js.
function shapeMember(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    company: row.company || '',
    title: row.title || '',
    status: row.status,
    addedAt: row.added_at,
  }
}

// ---- 2. workspace people ----------------------------------------------------

const MEMBER_STATUSES = ['active', 'invited', 'all']

// id / email / name / status and nothing else. `users` also holds the business
// context, the profile blob, the alert webhook and the prospecting API key, so
// this projection is built field by field: a column added to `users` later
// cannot leak into a response by default.
function shapePerson(row) {
  return {
    id: row.id,                    // null until they have an account
    email: row.email,
    name: row.name || '',
    role: row.role,                // owner | manager | member
    status: row.status,            // active | invited
    // What `PUT /api/campaigns/:id/owner` refuses on: an invited-but-not-joined
    // address has no users.id to assign and is rejected with that reason.
    hasSignedIn: Boolean(row.id) && row.status === 'active',
    assignable: Boolean(row.id) && row.status === 'active',
  }
}

// ---- 3. sender orders -------------------------------------------------------

const ORDER_STATUSES = ['pending', 'placed', 'failed', 'cancelled']

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '')
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch { return fallback }
}

// Built field by field for the same reason as server/parity/senders.js does it:
// so a column added to `sender_orders` later cannot leak. `sender_billing_details`
// is a different table and is never read here — order history is not billing.
// `mailboxes` is omitted too: the order list is a receipt, not a credential
// store, and GET /senders/orders/:ref already serves the full record.
function shapeOrder(row) {
  const domains = safeJson(row.domains, [])
  return {
    order_ref: row.order_ref,
    vendor_id: row.vendor_id,
    status: row.status,
    domains,
    domain_count: domains.length,
    total: row.total,
    currency: row.currency,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ---- 4 & 5. webhook delivery ------------------------------------------------

const TIMEOUT_MS = 5000
const RETRY_BATCH_CAP = 500
const MAX_WINDOW_DAYS = 92
const TEST_EVENT_TYPE = 'test'

// The transport, injectable so a test never touches the network. Setting it
// here also sets it in server/parity/webhooks.js, so one call in a test covers
// every outbound webhook path rather than leaving half of them live.
let transport = (...args) => globalThis.fetch(...args)
export function setTestTransport(fn) {
  transport = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args)
  setWebhookTransport(fn)
}

// The delivery worker's view of a row: includes the secret, excludes the
// deletion tombstone (`is_active = -1`).
function liveWebhook(id, wsId) {
  return db.prepare('SELECT * FROM webhooks WHERE id = ? AND workspace_id = ? AND is_active >= 0').get(id, wsId) || null
}

// A paused endpoint is still testable — being paused is the reason you test it —
// so `is_active >= 0` is the only filter, matching the read paths in webhooks.js.
function ownedWebhook(id, wsId) {
  const row = liveWebhook(id, wsId)
  if (!row) throw notFound('webhook')
  return row
}

function hashPayload(body) {
  return crypto.createHash('sha256').update(String(body)).digest('hex')
}

// Same insert shape as webhooks.js `recordAttempt`, and best-effort for the same
// reason: the bookkeeping must never become the thing that fails the request.
function recordDelivery(hook, { eventType, body, payloadHash, status, ok, error }) {
  try {
    const info = db.prepare(
      `INSERT INTO webhook_deliveries
         (workspace_id, webhook_id, event_type, payload, payload_hash, status_code, ok, attempt, error, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      hook.workspace_id, hook.id, eventType, body, payloadHash,
      status, ok ? 1 : 0, String(error || '').slice(0, 300), ok ? nowIso() : ''
    )
    return info.lastInsertRowid
  } catch {
    return null
  }
}

// One attempt at one named endpoint. No backoff and no retry loop: both callers
// are a human pressing a button, and layering automatic retries on top of a
// manual replay would multiply deliveries nobody asked for.
async function deliverOnce(hook, { eventType, body, payloadHash, eventId, test = false }) {
  // The SSRF guard is re-applied immediately before the attempt, exactly as the
  // real delivery path does, so a URL changed underneath us cannot turn inward.
  const problem = webhookUrlProblem(hook.url)
  if (problem) {
    const error = `refused: url ${problem}`
    const id = recordDelivery(hook, { eventType, body, payloadHash, status: 0, ok: false, error })
    return { ok: false, status: 0, error: `url ${problem}`, deliveryId: id }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let result
  try {
    const res = await transport(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Harry-Event': eventType,
        'X-Harry-Event-Id': eventId,
        'X-Harry-Delivery-Attempt': '1',
        'X-Harry-Timestamp': nowIso(),
        'X-Harry-Signature': signPayload(hook.secret, body),
        // Belt and braces: the receiver can reject a test at the header, before
        // it has parsed a byte of the body.
        ...(test ? { 'X-Harry-Test': 'true' } : {}),
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
    result = { status, ok, error: ok ? '' : `HTTP ${status}${detail ? ` ${detail}` : ''}` }
  } catch (err) {
    result = { status: 0, ok: false, error: String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }

  result.deliveryId = recordDelivery(hook, {
    eventType, body, payloadHash, status: result.status, ok: result.ok, error: result.error,
  })
  return result
}

// The same window contract as the campaign summary and retrigger: ISO 8601,
// no inversion, no unbounded scan. Both bounds are optional here — "retry the
// failures" is not a question anybody asks with a date picker open.
function readWindow(source) {
  const parse = (field, fallback) => {
    const raw = source?.[field]
    if (raw === undefined || raw === null || raw === '') return fallback
    const d = new Date(String(raw))
    if (Number.isNaN(d.getTime())) {
      throw invalid(field, `${field} must be an ISO 8601 timestamp, for example 2024-01-01T00:00:00.000Z`)
    }
    return d
  }
  const from = parse('from', new Date(Date.now() - 7 * 86400_000))
  const to = parse('to', new Date())
  if (from.getTime() > to.getTime()) throw invalid('from', 'from must not be after to')
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86400_000) {
    throw invalid('from', `the window must be ${MAX_WINDOW_DAYS} days or shorter`)
  }
  return { from: from.toISOString(), to: to.toISOString() }
}

// `webhook_deliveries.created_at` is SQLite's `datetime('now')`; the window
// arrives as ISO with a T and a Z. `datetime()` on both sides normalises them.
const WINDOW_SQL = 'datetime(d.created_at) >= datetime(?) AND datetime(d.created_at) <= datetime(?)'

// One workspace-wide replay at a time. The campaign-scoped retrigger keeps its
// own lock inside server/parity/webhooks.js and this one cannot see it, so the
// two can in principle overlap — the payload-hash idempotency below is what
// actually prevents a double delivery, and it holds across both.
const retryLocks = new Set()

// ---- 6. block-list line parsing ---------------------------------------------

// Newlines, commas and semicolons ONLY. `server/parity/utilities.js` also splits
// on spaces and tabs, which tears one bad line into several: pasting
// `not a valid entry!!` reports four errors about four fragments instead of one
// error about the line the person actually typed. Whitespace is not a separator
// people use between addresses — they use a newline — so removing it from the
// set costs nothing and makes every error message quotable back at them.
//
// NOTE: `POST /api/block-list` in server/parity/utilities.js should adopt
// `parseBlockEntries` in place of its `parseBlockList` + `SPLIT_RE` pair. That
// file belongs to another change, so this module ships the corrected parser and
// a read-only preview route over it; the writing route is unchanged for now.
const LINE_SPLIT_RE = /[\r\n,;]+/

const MAX_ENTRIES = 1000
const MAX_RAW = 200_000        // one paste, not a file upload

// One line in, one outcome out. Returns every line accounted for — a valid,
// normalised entry or exactly one error quoting the whole line — because a
// paste that silently drops a typo is a paste that quietly fails to block
// somebody.
export function parseBlockEntries(input, field = 'domain_block_list') {
  const lines = []
  if (typeof input === 'string') {
    if (input.length > MAX_RAW) throw invalid(field, `${field} is too long to paste in one go`)
    lines.push(...input.split(LINE_SPLIT_RE))
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item === null || item === undefined) continue
      if (typeof item === 'object') {
        throw invalid(field, `${field} must contain addresses and domains, not objects`)
      }
      // An array element may itself be a pasted block — split it the same way.
      lines.push(...String(item).split(LINE_SPLIT_RE))
    }
  } else {
    throw invalid(field, `${field} must be an array of addresses and domains, or one pasted block of text`)
  }

  const kept = lines.map((l) => l.trim()).filter(Boolean)
  if (kept.length > MAX_ENTRIES) {
    throw invalid(field, `${field} may contain at most ${MAX_ENTRIES} entries in one go`)
  }

  const entries = []
  const errors = []
  kept.forEach((line, i) => {
    // The normalisation itself is the one already agreed in
    // server/parity/utilities.js — scheme, www., path, angle brackets, leading
    // @, lowercase — imported rather than copied so the two cannot drift.
    const norm = normaliseBlockValue(line)
    if (!norm) {
      errors.push({
        line: i + 1,
        input: line,
        reason: 'malformed',
        message: `"${line}" is not an email address or a domain`,
      })
      return
    }
    entries.push({ line: i + 1, input: line, value: norm.value, isDomain: Boolean(norm.isDomain) })
  })

  return { requested: kept.length, entries, errors }
}

// Blocking your own sending domain breaks reply handling, so the preview says
// so before the write route refuses it. Same query as utilities.js runs.
function ownSendingIdentities(wsId) {
  const rows = db.prepare('SELECT email FROM mailboxes WHERE user_id = ? AND deleted_at IS NULL').all(wsId)
  const addresses = new Set()
  const domains = new Set()
  for (const row of rows) {
    const address = String(row.email || '').trim().toLowerCase()
    if (!address.includes('@')) continue
    addresses.add(address)
    domains.add(address.slice(address.lastIndexOf('@') + 1))
  }
  return { addresses, domains }
}

// ---- routes -----------------------------------------------------------------

export function register(api) {
  // =========================================================== 1. segment ====
  // GET /api/lead-lists/:id/leads?q=&limit=&cursor=&offset=
  //
  // Clicking a segment in the UI could not filter the Leads table because
  // nothing listed its members. Same keyset paging as the other list routes, so
  // a lead added mid-scroll cannot appear on two pages.
  api.get('/lead-lists/:id/leads', handler((req) => {
    const started = Date.now()
    const list = ownedList(pathId(req), req.wsId)
    const { limit, cursor, offset } = page(req.query, { defaultLimit: 50, maxLimit: 200 })
    const q = str(req.query, 'q', { max: LEAD_SEARCH_MAX })

    // Both sides of the join are workspace-scoped: a membership row pointing at
    // a stranger's lead (impossible today, but the query does not rely on that)
    // still cannot surface one.
    const where = ['m.list_id = ?', 'l.user_id = ?']
    const args = [list.id, req.wsId]
    if (q) {
      where.push(
        "(lower(l.email) LIKE ? ESCAPE '\\' OR lower(l.first_name) LIKE ? ESCAPE '\\'"
        + " OR lower(l.last_name) LIKE ? ESCAPE '\\' OR lower(l.company) LIKE ? ESCAPE '\\')"
      )
      const like = likeArg(q)
      args.push(like, like, like, like)
    }

    const total = db.prepare(
      `SELECT COUNT(*) n FROM lead_list_leads m JOIN leads l ON l.id = m.lead_id WHERE ${where.join(' AND ')}`
    ).get(...args).n

    const keyed = [...where]
    const keyedArgs = [...args]
    if (cursor) { keyed.push('l.id > ?'); keyedArgs.push(cursor) }

    const rows = db.prepare(
      `SELECT l.*, m.added_at AS added_at
         FROM lead_list_leads m JOIN leads l ON l.id = m.lead_id
        WHERE ${keyed.join(' AND ')}
        ORDER BY l.id LIMIT ? OFFSET ?`
    ).all(...keyedArgs, limit + 1, cursor ? 0 : offset)

    const out = paged(rows, limit)
    meter('gaps.list_members', Date.now() - started, true, `${out.items.length} of ${total}`)
    return {
      listId: list.id,
      listName: list.name,
      items: out.items.map(shapeMember),
      total,
      limit,
      offset,
      q,
      nextCursor: out.nextCursor,
      hasMore: out.hasMore,
    }
  }))

  // ============================================================ 2. people ====
  // GET /api/workspace/members?status=active|invited|all
  //
  // `PUT /api/campaigns/:id/owner` takes a `users.id` and no route exposed one,
  // so campaign ownership was unassign-only. The owner is always first, then
  // team members by invitation order, so the list is stable under offset paging.
  api.get('/workspace/members', handler((req) => {
    const started = Date.now()
    const { limit, offset } = page(req.query, { defaultLimit: 50, maxLimit: 200 })
    const status = oneOf(req.query, 'status', MEMBER_STATUSES, { fallback: 'active' })

    const owner = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.wsId)
    const people = []
    if (owner) {
      people.push({ id: owner.id, email: owner.email, name: owner.name || '', role: 'owner', status: 'active' })
    }

    // `team_members` holds no name and no id: the account, when there is one, is
    // matched by address — the same join `resolveWorkspace` makes.
    const memberRows = db.prepare(
      'SELECT id, email, role, status FROM team_members WHERE owner_id = ? ORDER BY id'
    ).all(req.wsId)
    const account = db.prepare('SELECT id, email, name FROM users WHERE lower(email) = lower(?)')
    for (const row of memberRows) {
      // The owner may also hold a membership row in their own workspace; they
      // are already listed above and are not listed twice.
      if (owner && String(row.email).toLowerCase() === String(owner.email).toLowerCase()) continue
      if (status !== 'all' && row.status !== status) continue
      const user = account.get(row.email)
      people.push({
        id: user ? user.id : null,
        email: row.email,
        name: user ? (user.name || '') : '',
        role: row.role,
        status: row.status,
      })
    }

    const items = people.slice(offset, offset + limit)
    meter('gaps.members', Date.now() - started, true, `${items.length} of ${people.length}`)
    return {
      ok: true,
      items: items.map(shapePerson),
      total: people.length,
      limit,
      offset,
      status,
      hasMore: offset + items.length < people.length,
      nextOffset: offset + items.length < people.length ? offset + items.length : null,
    }
  }))

  // ============================================================ 3. orders ====
  // GET /api/senders/orders?status=&limit=&cursor=
  //
  // The UI rebuilt order history from localStorage, so it was empty in another
  // browser and on another machine. Newest first with a keyset on a descending
  // id, matching GET /api/senders/vendors. Registered as a literal path, so
  // GET /api/senders/orders/:ref is untouched.
  api.get('/senders/orders', handler((req) => {
    const started = Date.now()
    const { limit, cursor } = page(req.query, { defaultLimit: 25, maxLimit: 200 })
    const status = oneOf(req.query, 'status', ORDER_STATUSES, { fallback: '' })

    const where = ['workspace_id = ?']
    const args = [req.wsId]
    if (status) { where.push('status = ?'); args.push(status) }

    const total = db.prepare(`SELECT COUNT(*) n FROM sender_orders WHERE ${where.join(' AND ')}`).get(...args).n

    const keyed = [...where]
    const keyedArgs = [...args]
    if (cursor) { keyed.push('id < ?'); keyedArgs.push(cursor) }
    const rows = db.prepare(
      `SELECT * FROM sender_orders WHERE ${keyed.join(' AND ')} ORDER BY id DESC LIMIT ?`
    ).all(...keyedArgs, limit + 1)

    const out = paged(rows, limit)
    meter('gaps.orders', Date.now() - started, true, `${out.items.length} of ${total}`)
    return {
      ok: true,
      data: out.items.map(shapeOrder),
      total,
      limit,
      status,
      nextCursor: out.nextCursor,
      hasMore: out.hasMore,
    }
  }))

  // ============================================================= 5. retry ====
  // POST /api/webhooks/retry  { from?, to?, webhookId? }
  //
  // Registered before /webhooks/:id/test purely for readability — the two
  // cannot shadow each other, they have different segment counts.
  //
  // Retry existed only per campaign, so the Settings screen had to ask which
  // campaign a failed notification belonged to, which is not how anyone thinks
  // about a broken integration. Same idempotency discipline as
  // POST /api/campaigns/:id/notifications/retry: one replay per
  // (endpoint, payload), never a payload that has since succeeded, and never an
  // endpoint that has been deleted.
  api.post('/webhooks/retry', handler(async (req) => {
    const started = Date.now()
    const body = { ...(req.query || {}), ...(req.body || {}) }
    const { from, to } = readWindow(body)

    let hook = null
    const rawId = body.webhookId ?? body.webhook_id
    if (rawId !== undefined && rawId !== null && rawId !== '') {
      const id = int({ webhookId: rawId }, 'webhookId', { required: true, min: 1 })
      hook = liveWebhook(id, req.wsId)
      if (!hook) throw notFound('webhook')
    }

    const lockKey = String(req.wsId)
    if (retryLocks.has(lockKey)) {
      throw new HttpError(409, {
        error: 'retry_in_progress',
        message: 'A replay is already running for this workspace. Wait for it to finish.',
      })
    }
    retryLocks.add(lockKey)
    try {
      const where = ['d.workspace_id = ?', 'd.ok = 0', WINDOW_SQL, 'd.event_type != ?']
      const args = [req.wsId, from, to, TEST_EVENT_TYPE]
      if (hook) { where.push('d.webhook_id = ?'); args.push(hook.id) }

      const failures = db.prepare(
        `SELECT d.id, d.webhook_id, d.event_type, d.payload, d.payload_hash
           FROM webhook_deliveries d
          WHERE ${where.join(' AND ')}
          ORDER BY d.id
          LIMIT ?`
      ).all(...args, RETRY_BATCH_CAP)

      // Three failed attempts at the same event are one event to retry, not
      // three.
      const unique = new Map()
      for (const row of failures) {
        const key = `${row.webhook_id}:${row.payload_hash}`
        if (!unique.has(key)) unique.set(key, row)
      }

      const succeededAlready = db.prepare(
        'SELECT 1 FROM webhook_deliveries WHERE webhook_id = ? AND payload_hash = ? AND ok = 1 LIMIT 1'
      )

      let retriggered = 0
      let delivered = 0
      let stillFailing = 0
      let skipped = 0
      for (const row of unique.values()) {
        // A deleted endpoint is reported as skipped rather than retried — the
        // tombstone exists precisely so queued replays stop.
        const target = liveWebhook(row.webhook_id, req.wsId)
        if (!target) { skipped += 1; continue }
        if (succeededAlready.get(row.webhook_id, row.payload_hash)) { skipped += 1; continue }

        retriggered += 1
        let eventId = ''
        try { eventId = JSON.parse(row.payload)?.event_id || '' } catch { eventId = '' }
        const result = await deliverOnce(target, {
          eventType: row.event_type,
          body: row.payload,
          payloadHash: row.payload_hash,
          eventId,
        })
        if (result.ok) delivered += 1
        else stillFailing += 1
      }

      // One events row for the whole sweep, not one per delivery.
      audit(req, {
        type: 'webhooks_retriggered',
        detail: `${req.user?.email || 'someone'} replayed ${retriggered} failed notification(s)`
          + `${hook ? ` for "${hook.name || 'endpoint'}"` : ' across the workspace'}`
          + ` between ${from} and ${to}: ${delivered} delivered, ${stillFailing} still failing, ${skipped} skipped`,
      })
      meter('gaps.webhook_retry', Date.now() - started, true, `${retriggered} replayed`)

      return {
        success: true,
        ok: true,
        from,
        to,
        webhookId: hook ? hook.id : null,
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

  // ============================================================== 4. test ====
  // POST /api/webhooks/:id/test
  //
  // Sends one unmistakably-marked sample to this endpoint and this endpoint
  // only. See the file header for why this does not go through `fireWebhooks`.
  api.post('/webhooks/:id/test', handler(async (req) => {
    const started = Date.now()
    const hook = ownedWebhook(pathId(req), req.wsId)

    const eventId = crypto.randomUUID()
    // Every field a receiver might look at says "test", at the top level, so it
    // cannot be mistaken for a real event by a handler that reads only one of
    // them. The sample body carries no real lead, campaign or address.
    const envelope = {
      test: true,
      is_test: true,
      event_id: eventId,
      event_type: TEST_EVENT_TYPE,
      event_label: 'Test event',
      message: 'THIS IS A TEST. Harry sent it because somebody pressed "Send test" in Settings. '
        + 'It does not describe any real lead, campaign or email — do not act on it.',
      occurred_at: nowIso(),
      webhook: { id: hook.id, name: hook.name || '' },
      triggered_by: req.user?.email || '',
      // A shape-only sample so an integrator can wire their parser up, with
      // values that read as obviously fake at a glance.
      sample: {
        event_type: 'sent',
        event_label: WEBHOOK_EVENT_LABELS.sent,
        campaign_id: null,
        campaign_name: 'Example campaign (test)',
        lead: { id: null, email: 'sample.lead@example.invalid', first_name: 'Sample', last_name: 'Lead' },
      },
      campaign_id: hook.campaign_id ?? null,
    }
    const payload = JSON.stringify(envelope)

    const result = await deliverOnce(hook, {
      eventType: TEST_EVENT_TYPE,
      body: payload,
      payloadHash: hashPayload(payload),
      eventId,
      test: true,
    })

    audit(req, {
      campaignId: hook.campaign_id ?? null,
      type: 'webhook_tested',
      detail: `${req.user?.email || 'someone'} sent a test event to "${hook.name || 'endpoint'}"`
        + ` — ${result.ok ? `delivered (${result.status})` : `failed: ${result.error || 'no response'}`}`,
    })
    meter('gaps.webhook_test', Date.now() - started, result.ok, result.error || '')

    return {
      ok: true,
      success: true,
      data: {
        webhook_id: hook.id,
        delivery_id: result.deliveryId,
        event_id: eventId,
        event_type: TEST_EVENT_TYPE,
        test: true,
        delivered: result.ok,
        status_code: result.status,
        error: result.error || '',
        message: result.ok
          ? `Test event delivered — the endpoint answered ${result.status}`
          : `Test event was not delivered: ${result.error || 'no response'}`,
      },
    }
  }))

  // ============================================================= 6. parse ====
  // POST /api/block-list/parse
  //
  // A dry run of POST /api/block-list: it reads the paste, says what would
  // happen to every line, and writes nothing at all — no `blocked_domains` row,
  // no `events` row. The UI shows this before asking the user to commit.
  api.post('/block-list/parse', handler((req) => {
    const started = Date.now()
    const raw = req.body?.domain_block_list ?? req.body?.domainBlockList
    if (raw === undefined || raw === null) {
      throw invalid('domain_block_list', 'domain_block_list is required')
    }

    const parsed = parseBlockEntries(raw)
    const own = ownSendingIdentities(req.wsId)
    const existing = db.prepare('SELECT 1 FROM blocked_domains WHERE workspace_id = ? AND value = ? LIMIT 1')

    const willAdd = []
    const duplicates = []
    const rejected = parsed.errors.map((e) => ({ ...e }))
    const seen = new Set()

    for (const entry of parsed.entries) {
      const isOwn = entry.isDomain ? own.domains.has(entry.value) : own.addresses.has(entry.value)
      if (isOwn) {
        rejected.push({
          line: entry.line, input: entry.input, value: entry.value, reason: 'own_sending_domain',
          message: `${entry.value} is one of your own sending mailboxes — blocking it would stop your replies arriving`,
        })
        continue
      }
      if (seen.has(entry.value)) {
        duplicates.push({ ...entry, reason: 'duplicate_in_request' })
        continue
      }
      seen.add(entry.value)
      if (existing.get(req.wsId, entry.value)) {
        duplicates.push({ ...entry, reason: 'already_blocked' })
        continue
      }
      willAdd.push(entry)
    }

    // Sorted by line so the preview reads in the order the person typed.
    rejected.sort((a, b) => a.line - b.line)
    meter('gaps.block_parse', Date.now() - started, true,
      `add=${willAdd.length} dupes=${duplicates.length} rejected=${rejected.length}`)

    return {
      ok: true,
      success: true,
      preview: true,
      requested: parsed.requested,
      willAdd,
      willAddCount: willAdd.length,
      duplicates,
      duplicateCount: duplicates.length,
      rejected,
      rejectedCount: rejected.length,
      // The same words the write route will use, so the confirm button and the
      // result banner agree.
      message: willAdd.length === 1
        ? '1 entry will be added to the block list'
        : `${willAdd.length} entries will be added to the block list`,
    }
  }))
}
