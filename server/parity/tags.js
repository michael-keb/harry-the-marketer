// Labels — Docs/lead-tags/* and Docs/email-account-tags/*.
//
// SmartLead ships two tag managers that both funnel create and update through
// one endpoint with a required body `id`, silently upserting on collision. That
// is a footgun in two directions: the client has to invent an id, and a typo in
// it overwrites someone else's label. Harry keeps ONE `tags` table keyed
// (workspace_id, applies_to, name) — so a lead label and a mailbox label may
// share a name without either appearing in the other's picker — and splits the
// upsert into `POST /api/tags` (create) and `PUT /api/tags/:id` (rename and
// recolour). Both answer a name clash with 409 carrying the existing label's id
// rather than writing over it, which is the divergence recorded in Docs/README.
//
// The join rows carry their own primary key, and that key — not the tag id — is
// what removal consumes, mirroring the source API's `tag_mapping_id`. Every
// route that touches more than one record runs in a single transaction, so an
// unknown or cross-workspace id anywhere in a batch leaves nothing applied.

import { db } from '../db.js'
import {
  HttpError, invalid, notFound, handler,
  str, oneOf, int, idList, page, paged,
  owned, ownedAll, tx, audit, meter,
} from './http.js'

const APPLIES_TO = ['lead', 'mailbox', 'lead_list']

// Which join table a label of each kind lives in, and which table owns the
// thing being labelled. One place to look rather than three switch statements.
const MAPPING = {
  lead: { table: 'lead_tags', column: 'lead_id', owner: 'leads', what: 'lead' },
  mailbox: { table: 'mailbox_tag_map', column: 'mailbox_id', owner: 'mailboxes', what: 'mailbox' },
  lead_list: { table: 'lead_list_tags', column: 'list_id', owner: 'lead_lists', what: 'lead list' },
}

// The documented per-request bound on mailbox assignment. The UI chunks above
// this; the cap exists so a 5,000-id request is refused rather than served.
const MAX_MAILBOXES = 25
const MAX_LEADS = 500
const MAX_LOOKUP_EMAILS = 200
const MAX_NAME = 60

// ---- colour ------------------------------------------------------------------

const HEX_RE = /^#[0-9A-Fa-f]{6}$/

// An accessible palette, fixed so a default colour is reproducible in a test.
const PALETTE = [
  '#4f46e5', '#0891b2', '#059669', '#ca8a04',
  '#dc2626', '#db2777', '#7c3aed', '#475569',
]

function hexColor(body, field, { required = false } = {}) {
  const raw = str(body, field, { required, max: 32 })
  if (!raw) return ''
  if (!HEX_RE.test(raw)) {
    throw invalid(field, `${field} must be a six-digit hex colour such as #4CAF50`)
  }
  return raw.toLowerCase()
}

// FNV-1a. `color` is optional precisely so a user need not choose one, so the
// default is derived from the name against the colours already in use — the
// same discipline server/pacing.js uses instead of Math.random, which means the
// same name in the same workspace always yields the same swatch.
function hashName(name) {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function defaultColor(wsId, appliesTo, name) {
  const used = new Set(
    db.prepare('SELECT color FROM tags WHERE workspace_id = ? AND applies_to = ?')
      .all(wsId, appliesTo).map((r) => r.color)
  )
  const start = hashName(name.toLowerCase()) % PALETTE.length
  for (let i = 0; i < PALETTE.length; i++) {
    const candidate = PALETTE[(start + i) % PALETTE.length]
    if (!used.has(candidate)) return candidate
  }
  return PALETTE[start] // every colour taken: repeat rather than refuse
}

// ---- shared lookups ----------------------------------------------------------

function shape(tag, extra = {}) {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    appliesTo: tag.applies_to,
    createdAt: tag.created_at,
    ...extra,
  }
}

function findByName(wsId, appliesTo, name) {
  // The unique index is on the exact stored name; matching is done here
  // case- and whitespace-insensitively so "vip" cannot become a second "VIP".
  return db.prepare(
    'SELECT * FROM tags WHERE workspace_id = ? AND applies_to = ? AND lower(trim(name)) = lower(trim(?))'
  ).get(wsId, appliesTo, name)
}

function nameConflict(existing) {
  // 409 rather than a silent upsert: the client is handed the existing label's
  // id so the picker can offer to open it instead of creating a lookalike.
  return new HttpError(409, {
    error: 'name_taken',
    field: 'name',
    message: `A ${existing.applies_to} label named "${existing.name}" already exists`,
    id: existing.id,
    data: shape(existing),
  })
}

// Every tag id in a batch, verified against the workspace AND the discriminator
// before anything is written. A cross-workspace id 404s naming the id (the
// all-or-nothing rule); a real tag of the wrong kind is a 422 on `tagIds`,
// because the id exists — it is the request that is wrong.
function tagsForBatch(ids, wsId, appliesTo) {
  const rows = ownedAll('tags', ids, wsId, 'tag')
  for (const row of rows) {
    if (row.applies_to !== appliesTo) {
      throw invalid('tagIds', `tag ${row.id} is a ${row.applies_to} label and cannot be applied to a ${appliesTo}`)
    }
  }
  return rows
}

function names(rows) {
  return rows.map((r) => r.name).join(', ')
}

// One insert path for every kind of label, so the bulk route and the
// single-record route cannot drift apart on validation or on idempotency:
// INSERT OR IGNORE against the unique pair makes a repeat add a no-op.
function applyTags(wsId, appliesTo, targetIds, tagIds) {
  const map = MAPPING[appliesTo]
  const targets = ownedAll(map.owner, targetIds, wsId, map.what)
  const tags = tagsForBatch(tagIds, wsId, appliesTo)
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${map.table} (workspace_id, ${map.column}, tag_id) VALUES (?, ?, ?)`
  )
  const added = tx(() => {
    let n = 0
    for (const target of targets) {
      for (const tag of tags) n += insert.run(wsId, target.id, tag.id).changes
    }
    return n
  })
  return { targets, tags, added }
}

function stripTags(wsId, appliesTo, targetIds, tagIds) {
  const map = MAPPING[appliesTo]
  const targets = ownedAll(map.owner, targetIds, wsId, map.what)
  const tags = tagsForBatch(tagIds, wsId, appliesTo)
  const del = db.prepare(
    `DELETE FROM ${map.table} WHERE workspace_id = ? AND ${map.column} = ? AND tag_id = ?`
  )
  // Removal is idempotent: a pairing that was never there deletes zero rows and
  // still succeeds. The `tags` table is never written to by this path, which is
  // what makes "the label itself is kept" structurally true.
  const removed = tx(() => {
    let n = 0
    for (const target of targets) {
      for (const tag of tags) n += del.run(wsId, target.id, tag.id).changes
    }
    return n
  })
  return { targets, tags, removed }
}

// ---- routes ------------------------------------------------------------------

export function register(api) {
  // ---- GET /api/tags -------------------------------------------------------
  // One read route feeds both the chips on a lead and the picker beside them,
  // so the front end has one source of truth and one cache to invalidate.
  api.get('/tags', handler(async (req) => {
    const started = Date.now()
    const appliesTo = oneOf(req.query, 'appliesTo', APPLIES_TO, { fallback: 'lead' })
    const { limit, cursor } = page(req.query, { defaultLimit: 100, maxLimit: 200 })
    const hasLead = req.query.leadId !== undefined && req.query.leadId !== ''

    if (hasLead) {
      const leadId = int(req.query, 'leadId', { required: true, min: 1 })
      const lead = owned('leads', leadId, req.wsId, 'lead')
      // `mappingId` is the lead_tags row id, which is what the removal route
      // consumes. Exposing it here is what makes removal a single call.
      const rows = db.prepare(
        `SELECT t.id AS id, lt.id AS mappingId, t.name AS name, t.color AS color, t.applies_to AS appliesTo
           FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
          WHERE lt.lead_id = ? AND lt.workspace_id = ? AND lt.id > ?
          ORDER BY lt.id LIMIT ?`
      ).all(lead.id, req.wsId, cursor, limit + 1)
      const out = paged(rows, limit, 'mappingId')
      meter('tags.list', Date.now() - started, true, `lead=${lead.id} n=${out.items.length}`)
      return { ok: true, appliesTo: 'lead', leadId: lead.id, data: out.items, nextCursor: out.nextCursor, hasMore: out.hasMore }
    }

    // Workspace-wide: what the picker renders. `usageCount` is what lets the
    // management panel say "0 leads carry this" instead of hiding the label.
    const join = MAPPING[appliesTo]
    const rows = db.prepare(
      `SELECT t.id AS id, t.name AS name, t.color AS color, t.applies_to AS appliesTo, t.created_at AS createdAt,
              (SELECT COUNT(*) FROM ${join.table} m WHERE m.tag_id = t.id) AS usageCount
         FROM tags t
        WHERE t.workspace_id = ? AND t.applies_to = ? AND t.id > ?
        ORDER BY t.id LIMIT ?`
    ).all(req.wsId, appliesTo, cursor, limit + 1)
    const out = paged(rows, limit)
    // Telemetry, not an events row: a read is not an activity-trail entry, but
    // a workspace drowning in labels should show up in Monitoring.
    meter('tags.list', Date.now() - started, true, `appliesTo=${appliesTo} n=${out.items.length}`)
    return { ok: true, appliesTo, data: out.items, nextCursor: out.nextCursor, hasMore: out.hasMore }
  }))

  // ---- POST /api/tags ------------------------------------------------------
  // Create only. `appliesTo` is required and has no default, so a label can
  // never be created without knowing what it labels.
  api.post('/tags', handler(async (req) => {
    const appliesTo = oneOf(req.body, 'appliesTo', APPLIES_TO, { required: true })
    const name = str(req.body, 'name', { required: true, max: MAX_NAME })
    const color = hexColor(req.body, 'color') || defaultColor(req.wsId, appliesTo, name)

    const clash = findByName(req.wsId, appliesTo, name)
    if (clash) throw nameConflict(clash)

    const row = tx(() => {
      const info = db.prepare(
        'INSERT INTO tags (workspace_id, applies_to, name, color) VALUES (?, ?, ?, ?)'
      ).run(req.wsId, appliesTo, name, color)
      return db.prepare('SELECT * FROM tags WHERE id = ?').get(info.lastInsertRowid)
    })
    audit(req, { type: 'tag_created', detail: `${req.user.email} created ${appliesTo} label "${name}" (${color})` })
    return { ok: true, data: shape(row) }
  }))

  // ---- PUT /api/tags/:id ---------------------------------------------------
  // Rename and recolour. Touches the tag row and nothing else, which is exactly
  // why renaming cannot disturb a single mapping.
  api.put('/tags/:id', handler(async (req) => {
    const tag = owned('tags', req.params.id, req.wsId, 'tag')
    // `applies_to` is immutable: a lead label cannot be converted into a
    // mailbox label, and a lead label cannot be edited from the mailbox panel.
    if (req.body?.appliesTo !== undefined && req.body.appliesTo !== '') {
      const claimed = oneOf(req.body, 'appliesTo', APPLIES_TO, { required: true })
      if (claimed !== tag.applies_to) {
        throw invalid('appliesTo', `label ${tag.id} applies to ${tag.applies_to} and cannot be changed`)
      }
    }
    // Both fields are required on update, unlike the mailbox update route's
    // partial semantics — the source contract is explicit about that.
    const name = str(req.body, 'name', { required: true, max: MAX_NAME })
    const color = hexColor(req.body, 'color', { required: true })

    const clash = findByName(req.wsId, tag.applies_to, name)
    if (clash && clash.id !== tag.id) throw nameConflict(clash)

    const updated = tx(() => {
      db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ? AND workspace_id = ?')
        .run(name, color, tag.id, req.wsId)
      return db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id)
    })
    audit(req, {
      type: 'tag_updated',
      detail: `${req.user.email} renamed ${tag.applies_to} label "${tag.name}" (${tag.color}) to "${name}" (${color})`,
    })
    return { ok: true, data: shape(updated) }
  }))

  // ---- POST /api/tags/lookup ----------------------------------------------
  // Address-keyed lookup, so a spreadsheet can be reconciled without exposing
  // internal ids. A POST because the input is a list, not because it writes.
  api.post('/tags/lookup', handler(async (req) => {
    const started = Date.now()
    // Only mailboxes are addressable this way; a lead label is never returned.
    const appliesTo = oneOf(req.body, 'appliesTo', ['mailbox'], { fallback: 'mailbox' })
    const raw = req.body?.emails
    if (!Array.isArray(raw)) throw invalid('emails', 'emails must be an array')
    if (!raw.length) throw invalid('emails', 'emails must contain at least one address')
    if (raw.length > MAX_LOOKUP_EMAILS) {
      throw invalid('emails', `emails may contain at most ${MAX_LOOKUP_EMAILS} addresses`)
    }
    // Addresses come from spreadsheets: trim, lower-case and de-duplicate.
    const wanted = []
    for (const item of raw) {
      const value = String(item ?? '').trim().toLowerCase()
      if (value && !wanted.includes(value)) wanted.push(value)
    }
    if (!wanted.length) throw invalid('emails', 'emails must contain at least one address')

    const find = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? AND deleted_at IS NULL AND lower(trim(email)) = ?')
    const tagsOf = db.prepare(
      `SELECT t.id AS id, t.name AS name, t.color AS color
         FROM mailbox_tag_map m JOIN tags t ON t.id = m.tag_id
        WHERE m.mailbox_id = ? AND t.applies_to = ?
        ORDER BY t.id`
    )
    const data = []
    const missing = []
    for (const address of wanted) {
      const mailbox = find.get(req.wsId, address)
      // A mailbox in another workspace is simply absent — the caller is told
      // "not found here", never that it exists somewhere else.
      if (!mailbox) { missing.push(address); continue }
      // An untagged mailbox is a row with an empty array, not an omitted row,
      // so the caller can tell "untagged" from "unknown".
      data.push({ mailboxId: mailbox.id, fromEmail: mailbox.email, tags: tagsOf.all(mailbox.id, appliesTo) })
    }
    meter('tags.lookup', Date.now() - started, true, `asked=${wanted.length} found=${data.length}`)
    return { ok: true, data, notFound: missing }
  }))

  // ---- POST /api/tags/assign ----------------------------------------------
  // Batch mailbox assignment, capped at the documented 25 ids per request.
  api.post('/tags/assign', handler(async (req) => {
    const appliesTo = oneOf(req.body, 'appliesTo', ['mailbox'], { fallback: 'mailbox' })
    const mailboxIds = idList(req.body, 'mailboxIds', { required: true, max: MAX_MAILBOXES })
    const tagIds = idList(req.body, 'tagIds', { required: true, max: 100 })
    const { targets, tags, added } = applyTags(req.wsId, appliesTo, mailboxIds, tagIds)
    // One events row per batch, not one per pairing, so the trail stays legible.
    audit(req, {
      type: 'mailbox_tagged',
      detail: `${req.user.email} tagged ${targets.length} mailbox(es) with ${names(tags)}`,
    })
    meter('tags.assign', 0, true, `mailboxes=${targets.length} tags=${tags.length}`)
    return { ok: true, message: 'Tags assigned successfully', assigned: added }
  }))

  // ---- DELETE /api/tags/assign --------------------------------------------
  // The mirror of assignment, same shape, same bounds. Deletes join rows only.
  api.delete('/tags/assign', handler(async (req) => {
    const appliesTo = oneOf(req.body, 'appliesTo', ['mailbox'], { fallback: 'mailbox' })
    const mailboxIds = idList(req.body, 'mailboxIds', { required: true, max: MAX_MAILBOXES })
    const tagIds = idList(req.body, 'tagIds', { required: true, max: 100 })
    const { targets, tags, removed } = stripTags(req.wsId, appliesTo, mailboxIds, tagIds)
    audit(req, {
      type: 'mailbox_untagged',
      detail: `${req.user.email} removed ${names(tags)} from ${targets.length} mailbox(es)`,
    })
    return { ok: true, message: 'Tags removed successfully', removed }
  }))

  // ---- DELETE /api/tags/:id ------------------------------------------------
  // Deleting the label itself, deliberately a different route from removing it
  // from a record, so "clean up my mailboxes" can never destroy the scheme.
  // Registered after DELETE /api/tags/assign, which this pattern would
  // otherwise capture as an id of "assign".
  api.delete('/tags/:id', handler(async (req) => {
    const tag = owned('tags', req.params.id, req.wsId, 'tag')
    const join = MAPPING[tag.applies_to]
    const removed = tx(() => {
      // Explicit rather than relying on the cascade, so the count reported is
      // the count actually deleted.
      const info = db.prepare(`DELETE FROM ${join.table} WHERE tag_id = ?`).run(tag.id)
      db.prepare('DELETE FROM tags WHERE id = ? AND workspace_id = ?').run(tag.id, req.wsId)
      return info.changes
    })
    audit(req, {
      type: 'tag_deleted',
      detail: `${req.user.email} deleted ${tag.applies_to} label "${tag.name}" (${removed} mapping(s))`,
    })
    return { ok: true, message: 'Tag deleted', removedMappings: removed }
  }))

  // ---- POST /api/leads/tags ------------------------------------------------
  // Bulk sibling of the single-lead route, sharing its validation and write
  // path. Registered before the parameterised lead routes it resembles.
  api.post('/leads/tags', handler(async (req) => {
    const leadIds = idList(req.body, 'leadIds', { required: true, max: MAX_LEADS })
    const tagIds = idList(req.body, 'tagIds', { required: true, max: 100 })
    const { targets, tags, added } = applyTags(req.wsId, 'lead', leadIds, tagIds)
    audit(req, {
      type: 'lead_tagged',
      detail: `${req.user.email} added ${names(tags)} to ${targets.length} lead(s)`,
    })
    meter('tags.lead_add', 0, true, `leads=${targets.length} tags=${tags.length}`)
    return { ok: true, message: 'Tags added to lead successfully', added, leads: targets.length }
  }))

  // ---- POST /api/leads/:id/tags -------------------------------------------
  api.post('/leads/:id/tags', handler(async (req) => {
    const tagIds = idList(req.body, 'tagIds', { required: true, max: 100 })
    const leadId = int(req.params, 'id', { required: true, min: 1 })
    const { targets, tags, added } = applyTags(req.wsId, 'lead', [leadId], tagIds)
    audit(req, {
      leadId: targets[0].id,
      type: 'lead_tagged',
      detail: `${req.user.email} added ${names(tags)} to ${targets[0].email}`,
    })
    meter('tags.lead_add', 0, true, `leads=1 tags=${tags.length}`)
    return { ok: true, message: 'Tags added to lead successfully', added }
  }))

  // ---- DELETE /api/leads/tags/bulk ----------------------------------------
  // The three-state picker's "untick" path. The backlog names this
  // `DELETE /api/leads/tags`, but `DELETE /api/leads/:id` already exists in
  // server/routes.js and would swallow it, so the literal segment stays.
  // Registered before /leads/tags/:mappingId, which it would otherwise match.
  api.delete('/leads/tags/bulk', handler(async (req) => {
    const leadIds = idList(req.body, 'leadIds', { required: true, max: MAX_LEADS })
    const tagIds = idList(req.body, 'tagIds', { required: true, max: 100 })
    const { targets, tags, removed } = stripTags(req.wsId, 'lead', leadIds, tagIds)
    audit(req, {
      type: 'lead_untagged',
      detail: `${req.user.email} removed ${names(tags)} from ${targets.length} lead(s)`,
    })
    return { ok: true, message: 'Tags removed from leads successfully', removed }
  }))

  // ---- DELETE /api/leads/tags/:mappingId ----------------------------------
  // Keyed on the mapping id, not the pair (leadId, tagId), mirroring the source
  // API's `tag_mapping_id`. The parameter is named `mappingId` everywhere so
  // the confusion with `tagId` is visible at the call site — passing a tag id
  // 404s rather than deleting the wrong row.
  api.delete('/leads/tags/:mappingId', handler(async (req) => {
    const mappingId = int(req.params, 'mappingId', { required: true, min: 1 })
    const row = db.prepare(
      `SELECT lt.*, t.name AS tag_name, l.email AS lead_email
         FROM lead_tags lt
         JOIN tags t ON t.id = lt.tag_id
         JOIN leads l ON l.id = lt.lead_id
        WHERE lt.id = ? AND lt.workspace_id = ? AND l.user_id = ?`
    ).get(mappingId, req.wsId, req.wsId)
    // A second removal of the same mapping is a 404, which the UI reads as
    // already-removed rather than as an error.
    if (!row) throw notFound('tag mapping')

    // Only the join row: the `tags` row and every other lead's mapping survive.
    tx(() => { db.prepare('DELETE FROM lead_tags WHERE id = ?').run(row.id) })
    audit(req, {
      leadId: row.lead_id,
      type: 'lead_untagged',
      detail: `${req.user.email} removed "${row.tag_name}" from ${row.lead_email}`,
    })
    return { ok: true, message: 'Tag removed from lead successfully' }
  }))
}
