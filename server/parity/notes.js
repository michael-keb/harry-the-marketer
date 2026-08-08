// Lead notes and lead tasks — Docs/lead-notes/* and Docs/lead-tasks/*.
//
// This is the one place in Harry where a human writes about a lead. The
// research profile is the agent's work and the activity trail is a log; neither
// is somewhere a person can say "called Priya, she wants pricing for 50 seats".
// That is what `lead_notes` is for, and `lead_tasks` is the off-email work a
// reply creates.
//
// Two rules run through the whole module:
//
//   1. A note is organisation, not instruction. Nothing here is read by the
//      composer, the engine or the mailer — a note must never silently steer
//      what the AI writes to a prospect, and a task never gates a send
//      (Docs/lead-tasks/create.md §5: "A task never blocks the engine").
//      The only consumers are the notes panel, the tasks panel and the Action
//      Center, all of which are read paths.
//   2. Note bodies never reach `events` or telemetry. The activity trail says
//      that a note was added, by whom, on which lead — and stops there
//      (Docs/lead-notes/create.md §5).
//
// Notes are soft-deleted (`deleted_at`) and editable only by their author, so
// attribution survives and a colleague cannot rewrite what someone else wrote.
// Tasks are shared work: any workspace member may complete or reassign one.
//
// Priority (Docs/lead-tasks/create.md) is low/medium/high, stored on the row.
// It is a tie-breaker, not the primary sort: due date decides what is urgent,
// and priority only separates two tasks due at the same time. Sorting by
// priority first would let a "low" task that is a week overdue sit under a
// "high" one due next month.

import { db } from '../db.js'
import {
  HttpError, handler, invalid, notFound, forbidden,
  str, int, oneOf, email as emailField, isoDate,
  page, paged, owned, tx, nowIso, audit, meter,
} from './http.js'

// Stated server-side so the composer's character counter has a source of truth
// rather than discovering the limit by being rejected.
const NOTE_MAX = 4000
const TITLE_MAX = 200
const TASK_BODY_MAX = 4000
const PRIORITIES = ['low', 'medium', 'high']
const TASK_STATUSES = ['open', 'done', 'cancelled']

// A retry after a timeout must not double-post. The schema carries no
// idempotency column, so a repeat is recognised by the client key plus an
// identical payload from the same author inside this window.
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000

// ---- workspace roster -------------------------------------------------------

// Who is currently in the workspace. Used for two things: refusing to assign a
// task to someone outside it, and flagging a note or task whose person has since
// left — the specs are explicit that attribution survives membership changes,
// so a departed author is marked, never rewritten or removed.
function roster(wsId) {
  const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(wsId)
  const members = db.prepare('SELECT email FROM team_members WHERE owner_id = ?').all(wsId)
  const set = new Set()
  if (owner?.email) set.add(owner.email.toLowerCase())
  for (const m of members) if (m.email) set.add(String(m.email).toLowerCase())
  return { ownerEmail: owner?.email || '', members: set }
}

function person(address, name, current) {
  if (!address) return null
  const member = current.members.has(String(address).toLowerCase())
  return {
    email: address,
    name: name || address,
    member,
    // Rendered as "former member" rather than dropped: a note nobody can
    // attribute is worse than a note whose author has gone.
    formerMember: !member,
  }
}

// ---- shared lookups ---------------------------------------------------------

// Non-numeric ids are a 422 naming the parameter, not a 404 — TC-4 of both
// get-all specs. A well-formed id that belongs to someone else is a 404 that
// says nothing about the record (`owned`).
function leadParam(req, field = 'leadId') {
  const raw = req.params[field]
  if (!/^\d+$/.test(String(raw ?? ''))) throw invalid(field, `${field} must be a numeric lead id`)
  return owned('leads', raw, req.wsId, 'lead')
}

// A note or task may be general (no campaign) or scoped to one campaign-and-lead
// pairing. A campaign from another workspace is a 404; a campaign this lead is
// not enrolled in is a 400, because the request is coherent but wrong — the spec
// asks for "a message that the lead is not in that campaign" rather than an
// orphaned record.
function resolveCampaign(req, leadId) {
  const raw = req.body?.campaignId
  if (raw === undefined || raw === null || raw === '') return null
  const campaignId = int(req.body, 'campaignId', { required: true, min: 1 })
  owned('campaigns', campaignId, req.wsId, 'campaign')
  const pairing = db.prepare('SELECT id FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .get(campaignId, leadId)
  if (!pairing) {
    throw new HttpError(400, {
      error: 'lead_not_in_campaign',
      field: 'campaignId',
      message: 'That lead is not in that campaign',
    })
  }
  return campaignId
}

function idempotencyKey(body) {
  return str(body, 'idempotencyKey', { max: 200, fallback: '' })
}

function withinWindow(createdAt) {
  const t = Date.parse(String(createdAt || '').replace(' ', 'T') + (String(createdAt || '').includes('Z') ? '' : 'Z'))
  if (!Number.isFinite(t)) return false
  return Date.now() - t <= IDEMPOTENCY_WINDOW_MS
}

// ---- notes ------------------------------------------------------------------

const NOTE_COLUMNS = `
  n.*,
  (SELECT name FROM users WHERE email = n.author_email LIMIT 1) AS author_name,
  (SELECT name FROM campaigns WHERE id = n.campaign_id LIMIT 1) AS campaign_name`

const LIVE_NOTE = `(n.deleted_at IS NULL OR n.deleted_at = '')`

function shapeNote(row, ctx) {
  return {
    id: row.id,
    leadId: row.lead_id,
    campaignId: row.campaign_id,
    // Labelled rather than merged: a promise made in one campaign must not read
    // as context for another. Campaign-less notes are "general".
    campaign: row.campaign_id ? { id: row.campaign_id, name: row.campaign_name || '' } : null,
    body: row.body,
    author: person(row.author_email, row.author_name, ctx.roster),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: row.updated_at !== row.created_at,
    // Only the author may edit or delete; the UI reads this rather than
    // comparing emails itself.
    mine: ctx.viewer === row.author_email,
  }
}

function readNote(req, id) {
  const row = db.prepare(`SELECT ${NOTE_COLUMNS} FROM lead_notes n WHERE n.id = ? AND n.workspace_id = ? AND ${LIVE_NOTE}`)
    .get(Number(id) || 0, req.wsId)
  if (!row) throw notFound('note')
  return row
}

// ---- tasks ------------------------------------------------------------------

const TASK_COLUMNS = `
  t.*,
  (SELECT name FROM users WHERE email = t.created_by LIMIT 1) AS creator_name,
  (SELECT name FROM users WHERE email = t.assigned_email LIMIT 1) AS assignee_name,
  (SELECT name FROM campaigns WHERE id = t.campaign_id LIMIT 1) AS campaign_name`

// One ordering, used by the lead panel and the Action Center alike, so the two
// never disagree about what is at the top: open work first, then overdue and
// soonest-due, then the undated tail — which sorts last and is never treated as
// overdue — tie-broken by id so paging is stable.
const TASK_ORDER = `
  ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END,
           CASE WHEN t.due_at IS NULL OR t.due_at = '' THEN 1 ELSE 0 END,
           t.due_at ASC,
           CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           t.id ASC`

function shapeTask(row, ctx) {
  const due = row.due_at || ''
  return {
    id: row.id,
    leadId: row.lead_id,
    campaignId: row.campaign_id,
    campaign: row.campaign_id ? { id: row.campaign_id, name: row.campaign_name || '' } : null,
    title: row.title,
    body: row.body,
    dueAt: due || null,
    status: row.status,
    priority: row.priority || 'medium',
    // Stated as a boolean the UI can render in words. An undated task is never
    // overdue, and neither is a closed one.
    overdue: row.status === 'open' && !!due && due < ctx.now,
    assignedEmail: row.assigned_email || '',
    assignee: person(row.assigned_email, row.assignee_name, ctx.roster),
    createdBy: row.created_by || '',
    creator: person(row.created_by, row.creator_name, ctx.roster),
    // Nobody currently in the workspace is carrying this task, so it can be
    // picked up rather than quietly lost when someone leaves.
    unowned: row.status === 'open' && !(row.assigned_email
      ? ctx.roster.members.has(String(row.assigned_email).toLowerCase())
      : ctx.roster.members.has(String(row.created_by || '').toLowerCase())),
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function taskCounts(wsId, now) {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN status = 'open' AND due_at IS NOT NULL AND due_at != '' AND due_at < ? THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
     FROM lead_tasks WHERE workspace_id = ?`
  ).get(now, wsId)
  return { open: row?.open || 0, overdue: row?.overdue || 0, done: row?.done || 0 }
}

// Both task list routes run through here so they cannot drift on ordering,
// filtering or shape.
function listTasks(req, { leadId = null } = {}) {
  const started = Date.now()
  const now = nowIso()
  const { limit, offset } = page(req.query, { defaultLimit: 50, maxLimit: 200 })
  const status = oneOf(req.query, 'status', [...TASK_STATUSES, 'all'], { fallback: 'open' })
  const due = oneOf(req.query, 'due', ['overdue', 'today', 'week', 'any'], { fallback: 'any' })
  const assignedTo = req.query.assignedTo === 'me'
    ? req.user.email
    : emailField(req.query, 'assignedTo', { fallback: '' })

  const where = ['t.workspace_id = ?']
  const args = [req.wsId]
  if (leadId) { where.push('t.lead_id = ?'); args.push(leadId) }
  if (status !== 'all') { where.push('t.status = ?'); args.push(status) }
  if (assignedTo) { where.push('LOWER(t.assigned_email) = ?'); args.push(assignedTo.toLowerCase()) }
  if (req.query.campaignId !== undefined && req.query.campaignId !== '') {
    const campaignId = int(req.query, 'campaignId', { required: true, min: 1 })
    owned('campaigns', campaignId, req.wsId, 'campaign')
    where.push('t.campaign_id = ?')
    args.push(campaignId)
  }
  if (due !== 'any') {
    // Undated tasks are excluded from every date filter — an undated task is
    // not overdue and is not due today, it is simply undated.
    where.push("t.due_at IS NOT NULL AND t.due_at != ''")
    if (due === 'overdue') { where.push("t.status = 'open' AND t.due_at < ?"); args.push(now) }
    if (due === 'today') { where.push('t.due_at <= ?'); args.push(endOfDay(0)) }
    if (due === 'week') { where.push('t.due_at <= ?'); args.push(endOfDay(7)) }
  }

  const rows = db.prepare(
    `SELECT ${TASK_COLUMNS} FROM lead_tasks t WHERE ${where.join(' AND ')} ${TASK_ORDER} LIMIT ? OFFSET ?`
  ).all(...args, limit + 1, offset)

  const ctx = { roster: roster(req.wsId), now, viewer: req.user.email }
  const { items, hasMore } = paged(rows.map((r) => shapeTask(r, ctx)), limit)
  const counts = taskCounts(req.wsId, now)
  // Telemetry carries counts only, never task text.
  meter('tasks_list', Date.now() - started, true, `open=${counts.open} overdue=${counts.overdue}`)
  return { items, hasMore, nextOffset: hasMore ? offset + limit : null, counts }
}

function endOfDay(daysAhead) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + daysAhead)
  d.setUTCHours(23, 59, 59, 999)
  return d.toISOString()
}

// An assignee has to be someone who can actually pick the work up, so an
// address from outside the workspace is a 422 rather than a task nobody sees.
function assignee(wsId, body, field = 'assignedEmail') {
  const address = emailField(body, field, { fallback: '' })
  if (!address) return ''
  const { members } = roster(wsId)
  if (!members.has(address.toLowerCase())) {
    throw invalid(field, `${field} must be a member of this workspace`)
  }
  return address
}

// ---- routes -----------------------------------------------------------------

export function register(api) {
  // -- notes ------------------------------------------------------------------

  // Docs/lead-notes/create.md §5. The author is the authenticated user and is
  // never client-supplied; the body is stored verbatim as plain text and is
  // escaped by the renderer, never interpreted here and never sent anywhere.
  api.post('/leads/:leadId/notes', handler((req) => {
    const lead = leadParam(req)
    const body = str(req.body, 'body', { required: true, max: NOTE_MAX })
    const campaignId = resolveCampaign(req, lead.id)
    const key = idempotencyKey(req.body)

    if (key) {
      const prior = db.prepare(
        `SELECT ${NOTE_COLUMNS} FROM lead_notes n
          WHERE n.workspace_id = ? AND n.lead_id = ? AND n.author_email = ? AND n.body = ?
            AND (n.campaign_id IS ? OR n.campaign_id = ?) AND ${LIVE_NOTE}
          ORDER BY n.id DESC LIMIT 1`
      ).get(req.wsId, lead.id, req.user.email, body, campaignId, campaignId)
      if (prior && withinWindow(prior.created_at)) {
        const ctx = { roster: roster(req.wsId), viewer: req.user.email }
        return { note: shapeNote(prior, ctx), deduped: true }
      }
    }

    const row = tx(() => {
      // Timestamps are written explicitly in ISO with milliseconds rather than
      // left to SQLite's second-granularity default, so "edited" is a real
      // comparison and two notes written in the same second still order.
      const at = nowIso()
      const info = db.prepare(
        `INSERT INTO lead_notes (workspace_id, lead_id, campaign_id, author_email, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(req.wsId, lead.id, campaignId, req.user.email, body, at, at)
      // The trail records that a note exists, by whom — deliberately not what
      // it says.
      audit(req, {
        leadId: lead.id,
        campaignId,
        type: 'note_added',
        detail: `note added by ${req.user.email}`,
      })
      return db.prepare(`SELECT ${NOTE_COLUMNS} FROM lead_notes n WHERE n.id = ?`).get(info.lastInsertRowid)
    })

    const ctx = { roster: roster(req.wsId), viewer: req.user.email }
    return { note: shapeNote(row, ctx), deduped: false }
  }))

  // Docs/lead-notes/get-all.md §5. Newest first, keyset paged on id so the list
  // is stable while colleagues write more, and deterministic when two notes
  // share a timestamp.
  api.get('/leads/:leadId/notes', handler((req) => {
    const started = Date.now()
    const lead = leadParam(req)
    const { limit, cursor } = page(req.query, { defaultLimit: 10, maxLimit: 200 })
    const before = req.query.before !== undefined && req.query.before !== ''
      ? int(req.query, 'before', { min: 1, fallback: 0 })
      : cursor

    const where = [`n.workspace_id = ?`, `n.lead_id = ?`, LIVE_NOTE]
    const args = [req.wsId, lead.id]
    if (req.query.campaignId !== undefined && req.query.campaignId !== '') {
      const campaignId = int(req.query, 'campaignId', { required: true, min: 1 })
      owned('campaigns', campaignId, req.wsId, 'campaign')
      where.push('n.campaign_id = ?')
      args.push(campaignId)
    }
    if (before) { where.push('n.id < ?'); args.push(before) }

    const rows = db.prepare(
      `SELECT ${NOTE_COLUMNS} FROM lead_notes n
        WHERE ${where.join(' AND ')}
        ORDER BY n.created_at DESC, n.id DESC LIMIT ?`
    ).all(...args, limit + 1)

    const ctx = { roster: roster(req.wsId), viewer: req.user.email }
    const out = paged(rows.map((r) => shapeNote(r, ctx)), limit)
    // Reading a note is not an act on the lead: latency only, no events row.
    meter('notes_list', Date.now() - started, true, `n=${out.items.length}`)
    return { ...out, leadId: lead.id, maxLength: NOTE_MAX }
  }))

  // Editable by its author alone. A colleague correcting someone else's record
  // of a call would make attribution meaningless.
  api.patch('/notes/:id', handler((req) => {
    const existing = readNote(req, req.params.id)
    if (existing.author_email !== req.user.email) {
      throw forbidden('Only the author can edit a note')
    }
    const body = str(req.body, 'body', { required: true, max: NOTE_MAX })

    const row = tx(() => {
      db.prepare('UPDATE lead_notes SET body = ?, updated_at = ? WHERE id = ?')
        .run(body, nowIso(), existing.id)
      audit(req, {
        leadId: existing.lead_id,
        campaignId: existing.campaign_id,
        type: 'note_edited',
        detail: `note edited by ${req.user.email}`,
      })
      return db.prepare(`SELECT ${NOTE_COLUMNS} FROM lead_notes n WHERE n.id = ?`).get(existing.id)
    })
    return { note: shapeNote(row, { roster: roster(req.wsId), viewer: req.user.email }) }
  }))

  // Soft delete: the row survives with `deleted_at` set, so the trail of what
  // was known stays intact even though the panel stops showing it.
  api.delete('/notes/:id', handler((req) => {
    const existing = readNote(req, req.params.id)
    if (existing.author_email !== req.user.email) {
      throw forbidden('Only the author can delete a note')
    }
    tx(() => {
      const at = nowIso()
      db.prepare('UPDATE lead_notes SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(at, at, existing.id)
      audit(req, {
        leadId: existing.lead_id,
        campaignId: existing.campaign_id,
        type: 'note_deleted',
        detail: `note deleted by ${req.user.email}`,
      })
    })
    return { id: existing.id, deleted: true }
  }))

  // -- tasks ------------------------------------------------------------------

  // Docs/lead-tasks/create.md §5. A past due date is accepted and shown as
  // overdue rather than rejected — the work is late, not invalid.
  api.post('/leads/:leadId/tasks', handler((req) => {
    const lead = leadParam(req)
    // `name` and `description` are the source API's spelling; the columns are
    // title and body. Both are accepted, one is canonical.
    const src = { ...req.body }
    if (src.title === undefined && src.name !== undefined) src.title = src.name
    if (src.body === undefined && src.description !== undefined) src.body = src.description
    if (src.dueAt === undefined && src.dueDate !== undefined) src.dueAt = src.dueDate

    const title = str(src, 'title', { required: true, max: TITLE_MAX })
    const body = str(src, 'body', { max: TASK_BODY_MAX, fallback: '' })
    const dueAt = isoDate(src, 'dueAt', '')
    const priority = oneOf(src, 'priority', PRIORITIES, { fallback: 'medium' })
    const status = oneOf(req.body, 'status', TASK_STATUSES, { fallback: 'open' })
    const assignedEmail = assignee(req.wsId, req.body)
    const campaignId = resolveCampaign(req, lead.id)
    const key = idempotencyKey(req.body)

    if (key) {
      const prior = db.prepare(
        `SELECT ${TASK_COLUMNS} FROM lead_tasks t
          WHERE t.workspace_id = ? AND t.lead_id = ? AND t.created_by = ? AND t.title = ?
            AND (t.campaign_id IS ? OR t.campaign_id = ?)
          ORDER BY t.id DESC LIMIT 1`
      ).get(req.wsId, lead.id, req.user.email, title, campaignId, campaignId)
      if (prior && withinWindow(prior.created_at)) {
        const ctx = { roster: roster(req.wsId), now: nowIso(), viewer: req.user.email }
        return { task: shapeTask(prior, ctx), deduped: true }
      }
    }

    const row = tx(() => {
      const at = nowIso()
      const info = db.prepare(
        `INSERT INTO lead_tasks (workspace_id, lead_id, campaign_id, title, body, due_at, status, assigned_email, priority, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(req.wsId, lead.id, campaignId, title, body, dueAt, status, assignedEmail, priority, req.user.email, at, at)
      // A task name is a label, not private prose, so the trail names it.
      audit(req, {
        leadId: lead.id,
        campaignId,
        type: 'task_created',
        detail: `${req.user.email} added task "${title}"`,
      })
      return db.prepare(`SELECT ${TASK_COLUMNS} FROM lead_tasks t WHERE t.id = ?`).get(info.lastInsertRowid)
    })

    const ctx = { roster: roster(req.wsId), now: nowIso(), viewer: req.user.email }
    return { task: shapeTask(row, ctx), deduped: false }
  }))

  // The Action Center: every piece of human work in the workspace, one query,
  // one ordering. Registered before the parameterised lead route in the router
  // it shares, and distinct from it, so neither shadows the other.
  api.get('/tasks', handler((req) => listTasks(req)))

  // The same rows filtered to one lead, for the panel beside the notes.
  api.get('/leads/:leadId/tasks', handler((req) => {
    const lead = leadParam(req)
    return { ...listTasks(req, { leadId: lead.id }), leadId: lead.id }
  }))

  // Completing, reassigning or re-dating a task. Unlike a note this is not
  // author-restricted: a task is work the workspace owns, and the spec asks for
  // an unowned task to be pick-up-able.
  api.patch('/tasks/:id', handler((req) => {
    const existing = owned('lead_tasks', req.params.id, req.wsId, 'task')
    const src = { ...req.body }
    if (src.title === undefined && src.name !== undefined) src.title = src.name
    if (src.body === undefined && src.description !== undefined) src.body = src.description
    if (src.dueAt === undefined && src.dueDate !== undefined) src.dueAt = src.dueDate

    const sets = []
    const args = []
    let newStatus = existing.status

    if (src.status !== undefined && src.status !== '') {
      newStatus = oneOf(src, 'status', TASK_STATUSES, { required: true })
      sets.push('status = ?')
      args.push(newStatus)
      // Closed tasks are kept, never deleted, so what was promised survives.
      if (newStatus === 'open') {
        sets.push("completed_at = ''")
      } else if (existing.status === 'open') {
        sets.push('completed_at = ?')
        args.push(nowIso())
      }
    }
    if (src.title !== undefined && src.title !== '') {
      sets.push('title = ?')
      args.push(str(src, 'title', { required: true, max: TITLE_MAX }))
    }
    if (src.body !== undefined) {
      sets.push('body = ?')
      args.push(str(src, 'body', { max: TASK_BODY_MAX, fallback: '' }))
    }
    if (src.dueAt !== undefined) {
      sets.push('due_at = ?')
      args.push(src.dueAt === null || src.dueAt === '' ? '' : isoDate(src, 'dueAt', ''))
    }
    if (src.assignedEmail !== undefined) {
      sets.push('assigned_email = ?')
      args.push(src.assignedEmail === null || src.assignedEmail === '' ? '' : assignee(req.wsId, src))
    }
    if (src.priority !== undefined && src.priority !== '') {
      sets.push('priority = ?')
      args.push(oneOf(src, 'priority', PRIORITIES, { required: true }))
    }
    if (sets.length === 0) {
      throw invalid('update', 'supply at least one of: status, title, body, dueAt, assignedEmail, priority')
    }

    const row = tx(() => {
      db.prepare(`UPDATE lead_tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...args, nowIso(), existing.id)
      audit(req, {
        leadId: existing.lead_id,
        campaignId: existing.campaign_id,
        type: newStatus !== existing.status && newStatus !== 'open' ? 'task_closed' : 'task_updated',
        detail: `${req.user.email} updated task "${existing.title}"`,
      })
      return db.prepare(`SELECT ${TASK_COLUMNS} FROM lead_tasks t WHERE t.id = ?`).get(existing.id)
    })

    return { task: shapeTask(row, { roster: roster(req.wsId), now: nowIso(), viewer: req.user.email }) }
  }))
}
