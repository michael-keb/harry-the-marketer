// Lead lists — the "Reusable lead segments" category of the SmartLead-parity
// backlog (Docs/lead-lists/*.md, 9 endpoints).
//
// A segment is a named, workspace-scoped bag of leads that outlives any one
// campaign. Three rules run through every route here and are worth stating once
// rather than re-deriving at each handler:
//
//  1. Membership is derived, never counted into a column. `leadCount` is always
//     an aggregate over `lead_list_leads`, so it cannot drift from the truth.
//  2. Suppression is unconditional. Harry does not offer SmartLead's
//     `ignore_unsubscribe_list` / `ignore_global_block_list` import settings, so
//     no request field anywhere below can smuggle an unsubscribed address or a
//     blocked domain into a segment or onto a campaign. The counts are reported,
//     the override is not offered.
//  3. A campaign is never created implicitly. SmartLead's push accepts a
//     `campaignName` and conjures a campaign from it; a Harry campaign cannot
//     launch without a valid playbook and a mailbox, so that campaign would be
//     born broken. The push takes an existing `campaignId` or it 422s.
//
// A request asking for rule 2 to be waived is refused rather than ignored. An
// ignored field answers 200, and a caller who sent `ignore_unsubscribe_list`
// and got a 200 has every reason to believe the opt-out was bypassed. The list
// carries both the source API's snake_case names and their camelCase forms.
const BYPASS_FIELDS = [
  'ignore_unsubscribe_list', 'ignoreUnsubscribeList',
  'ignore_global_block_list', 'ignoreGlobalBlockList',
  'ignore_duplicate_leads_in_other_campaign', 'ignoreDuplicateLeadsInOtherCampaign',
  'ignoreBlockList', 'force',
]

function refuseBypass(body) {
  for (const field of BYPASS_FIELDS) {
    if (body && Object.prototype.hasOwnProperty.call(body, field)) {
      throw invalid(field, 'Suppression cannot be bypassed — remove this field')
    }
  }
  // csvSettings is where SmartLead nests the same overrides on an upload.
  const nested = body?.csvSettings
  if (nested && typeof nested === 'object') refuseBypass(nested)
}

// Deletion is soft: the `lead_lists` row is stamped with `deleted_at` and its
// label rows are cleared, but `leads` is never written to and the membership
// rows survive, so a deletion is a grouping change and never a data loss — the
// leads that were only in that list remain on the Leads page, ungrouped.

import { db } from '../db.js'
import { blockMatch } from '../suppression.js'
import {
  HttpError, handler, invalid, notFound,
  str, int, idList, page, paged,
  owned, ownedAll, tx, audit, meter, nowIso,
} from './http.js'

const NAME_MAX = 120
const DESC_MAX = 1000
const IMPORT_MAX = 10000
const CHUNK = 400
const TRANSFER_MAX = 10000
const BULK_TAG_MAX = 10
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// ---- shared lookups ---------------------------------------------------------

// A soft-deleted segment is indistinguishable from one that never existed, and
// from one belonging to somebody else. `owned` handles the workspace half.
function ownedList(id, wsId) {
  const row = owned('lead_lists', id, wsId, 'lead list')
  if (String(row.deleted_at || '')) throw notFound('lead list')
  return row
}

function ownedLists(ids, wsId) {
  const rows = ownedAll('lead_lists', ids, wsId, 'lead list')
  for (const row of rows) {
    if (String(row.deleted_at || '')) {
      throw new HttpError(404, { error: 'not_found', message: `No such lead list: ${row.id}`, id: row.id })
    }
  }
  return rows
}

// Labels come from the one shared `tags` table. This module never creates or
// edits a tag — server/parity/tags.js owns that — it only verifies ids and
// writes the `lead_list_tags` join rows.
function ownedListTags(ids, wsId) {
  const rows = []
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM tags WHERE id = ? AND workspace_id = ? AND applies_to = 'lead_list'").get(id, wsId)
    if (!row) throw new HttpError(404, { error: 'not_found', message: `No such lead list tag: ${id}`, id })
    rows.push(row)
  }
  return rows
}

function leadCount(listId) {
  return db.prepare('SELECT COUNT(*) n FROM lead_list_leads WHERE list_id = ?').get(listId).n
}

function tagsFor(listId) {
  return db.prepare(
    `SELECT t.id, t.name, t.color FROM lead_list_tags m
     JOIN tags t ON t.id = m.tag_id
     WHERE m.list_id = ? ORDER BY t.name`
  ).all(listId)
}

function lastImport(listId) {
  const row = db.prepare('SELECT * FROM lead_list_imports WHERE list_id = ? ORDER BY id DESC LIMIT 1').get(listId)
  if (!row) return null
  return {
    id: row.id,
    fileName: row.filename,
    requested: row.requested,
    created: row.created,
    updated: row.updated,
    skipped: row.skipped,
    blocked: row.blocked,
    status: row.status,
    createdAt: row.created_at,
  }
}

function shape(row, { withTags = true, withImport = false, count = null } = {}) {
  const out = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    leadCount: count === null ? leadCount(row.id) : count,
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (withTags) out.tags = tagsFor(row.id)
  if (withImport) out.lastImport = lastImport(row.id)
  return out
}

function touchList(id) {
  db.prepare("UPDATE lead_lists SET updated_at = datetime('now') WHERE id = ?").run(id)
}

// Names are unique per workspace, case- and whitespace-insensitively. There is
// no unique index to lean on (the schema is shared and not ours to change), so
// the check runs inside the same transaction as the write.
function nameClash(wsId, name, exceptId = 0) {
  return db.prepare(
    `SELECT id, name FROM lead_lists
     WHERE workspace_id = ? AND COALESCE(deleted_at,'') = ''
       AND lower(trim(name)) = lower(trim(?)) AND id != ?`
  ).get(wsId, name, exceptId)
}

function duplicateName(existing) {
  return new HttpError(409, {
    error: 'duplicate_name',
    field: 'name',
    id: existing.id,
    message: `A lead list named "${existing.name}" already exists — open it instead of creating a second one`,
  })
}

// The id in a path is validated as a number before anything else, because the
// specs distinguish "not a number" (422) from "not yours" (404).
function pathId(req, param = 'id') {
  const raw = req.params[param]
  if (!/^\d+$/.test(String(raw))) throw invalid(param, `${param} must be a number`)
  return Number(raw)
}

// ---- suppression ------------------------------------------------------------

// One pass over the workspace's block list, kept in memory for the duration of
// a request. Domain entries match the address's domain (and any subdomain of
// it); address entries match the whole address.
function suppressor(wsId) {
  const rows = db.prepare('SELECT value, is_domain FROM blocked_domains WHERE workspace_id = ?').all(wsId)
  const addresses = new Set()
  const domains = []
  for (const row of rows) {
    const value = String(row.value || '').trim().toLowerCase()
    if (!value) continue
    if (row.is_domain) domains.push(value.replace(/^@/, ''))
    else addresses.add(value)
  }
  return (emailAddr) => {
    // The in-memory pass stays — an import checks thousands of addresses and a
    // query each would be silly — but the *rule* is server/suppression.js's, so
    // a change there cannot leave this copy behind. Verified equivalent by
    // tests/suppression-parity.test.js.
    const value = String(emailAddr || '').toLowerCase()
    if (addresses.has(value)) return true
    const domain = value.split('@')[1] || ''
    if (!domain) return false
    return domains.some((d) => domain === d || domain.endsWith(`.${d}`))
  }
}

// ---- routes -----------------------------------------------------------------

export function register(api) {
  // ---------------------------------------------------------------- get-all --
  // GET /api/lead-lists?q=&tagIds=&limit=&offset=
  api.get('/lead-lists', handler((req) => {
    const started = Date.now()
    const { limit, cursor, offset } = page(req.query, { defaultLimit: 25, maxLimit: 1000 })
    // The source API calls the search parameter `listName`; Harry's list
    // handlers call it `q`. Both are accepted, `q` wins.
    const q = str(req.query, 'q', { max: NAME_MAX }) || str(req.query, 'listName', { max: NAME_MAX })

    const rawTags = req.query.tagIds
    const tagIds = []
    if (rawTags !== undefined && rawTags !== '') {
      const parts = Array.isArray(rawTags) ? rawTags : String(rawTags).split(',')
      for (const part of parts) {
        const n = Number(String(part).trim())
        if (!Number.isInteger(n) || n <= 0) throw invalid('tagIds', `tagIds contains an invalid id: ${part}`)
        if (!tagIds.includes(n)) tagIds.push(n)
      }
    }

    const where = ["l.workspace_id = ?", "COALESCE(l.deleted_at,'') = ''"]
    const args = [req.wsId]
    if (q) { where.push('lower(l.name) LIKE ?'); args.push(`%${q.toLowerCase()}%`) }
    if (tagIds.length) {
      where.push(`EXISTS (SELECT 1 FROM lead_list_tags m WHERE m.list_id = l.id AND m.tag_id IN (${tagIds.map(() => '?').join(',')}))`)
      args.push(...tagIds)
    }
    // Keyset when a cursor is given, offset otherwise — both sorted by id, so a
    // segment can never appear on two pages.
    const keyed = [...where]
    const keyedArgs = [...args]
    if (cursor) { keyed.push('l.id > ?'); keyedArgs.push(cursor) }

    const total = db.prepare(`SELECT COUNT(*) n FROM lead_lists l WHERE ${where.join(' AND ')}`).get(...args).n
    const rows = db.prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM lead_list_leads m WHERE m.list_id = l.id) AS lead_count
       FROM lead_lists l WHERE ${keyed.join(' AND ')}
       ORDER BY l.id LIMIT ? OFFSET ?`
    ).all(...keyedArgs, limit + 1, cursor ? 0 : offset)

    const out = paged(rows, limit)
    meter('lead_lists.list', Date.now() - started, true, `${out.items.length} of ${total}`)
    return {
      items: out.items.map((r) => shape(r, { count: r.lead_count })),
      total,
      limit,
      offset,
      nextCursor: out.nextCursor,
      hasMore: out.hasMore,
    }
  }))

  // ----------------------------------------------------------------- create --
  // POST /api/lead-lists
  api.post('/lead-lists', handler((req) => {
    const body = { ...req.body, name: req.body?.name ?? req.body?.listName }
    const name = str(body, 'name', { required: true, max: NAME_MAX })
    const description = str(body, 'description', { max: DESC_MAX })

    const row = tx(() => {
      const clash = nameClash(req.wsId, name)
      if (clash) throw duplicateName(clash)
      const info = db.prepare(
        'INSERT INTO lead_lists (workspace_id, name, description, created_by) VALUES (?, ?, ?, ?)'
      ).run(req.wsId, name, description, req.user?.email || '')
      return db.prepare('SELECT * FROM lead_lists WHERE id = ?').get(info.lastInsertRowid)
    })

    audit(req, { type: 'lead_list_created', detail: `${row.name} (#${row.id})` })
    return shape(row, { count: 0 })
  }))

  // --------------------------------------------------------- assign-tags -----
  // POST /api/lead-lists/assign-tags — literal path, registered before /:id so
  // the parameterised routes below cannot shadow it.
  api.post('/lead-lists/assign-tags', handler((req) => {
    const listIds = idList(req.body, 'listIds', { required: true, max: BULK_TAG_MAX })
    const tagIds = idList(req.body, 'tagIds', { required: true, max: BULK_TAG_MAX })
    const removeTagIds = idList(req.body, 'removeTagIds', { max: BULK_TAG_MAX })
    if (listIds.length > BULK_TAG_MAX) throw invalid('listIds', 'listIds must contain between 1 and 10 ids')
    if (tagIds.length > BULK_TAG_MAX) throw invalid('tagIds', 'tagIds must contain between 1 and 10 ids')

    // Every id is proved to belong to the caller before a single row is
    // written: the batch is all-or-nothing, and a rejected id is named.
    const lists = ownedLists(listIds, req.wsId)
    ownedListTags(tagIds, req.wsId)
    if (removeTagIds.length) ownedListTags(removeTagIds, req.wsId)

    const result = tx(() => {
      let added = 0
      let removed = 0
      const del = db.prepare('DELETE FROM lead_list_tags WHERE list_id = ? AND tag_id = ?')
      const ins = db.prepare('INSERT OR IGNORE INTO lead_list_tags (workspace_id, list_id, tag_id) VALUES (?, ?, ?)')
      // Removals run first, so a tag id present in both arrays ends up removed.
      for (const list of lists) {
        for (const tagId of removeTagIds) removed += del.run(list.id, tagId).changes
      }
      for (const list of lists) {
        for (const tagId of tagIds) {
          if (removeTagIds.includes(tagId)) continue
          added += ins.run(req.wsId, list.id, tagId).changes
        }
      }
      for (const list of lists) touchList(list.id)
      return { added, removed }
    })

    // One events row for the bulk action, not one per pair.
    audit(req, {
      type: 'lead_list_tags_assigned',
      detail: `lists ${listIds.join(',')}: +${result.added} -${result.removed}`,
    })
    return { ok: true, message: 'Tags updated successfully', ...result }
  }))

  // ------------------------------------------------------------- transfer ----
  // POST /api/lead-lists/transfer — copy or move membership between segments.
  api.post('/lead-lists/transfer', handler((req) => transfer(req, req.body)))

  // POST /api/leads/:leadId/move — the same operation for exactly one lead, so
  // a drag between two segments in the UI is not a bulk-shaped request.
  api.post('/leads/:leadId/move', handler((req) => {
    const leadId = pathId(req, 'leadId')
    owned('leads', leadId, req.wsId, 'lead')
    if (req.body?.leadIds !== undefined) {
      throw invalid('leadIds', 'leadIds is not accepted here — the lead is taken from the path')
    }
    // The lead comes from the path, so `fromListId` is a source-of-removal
    // rather than a second selection — the ambiguity rule does not apply.
    return transfer(req, { ...req.body, leadIds: [leadId] }, { leadFromPath: true })
  }))

  // ------------------------------------------------------ push-to-campaign ---
  // POST /api/lead-lists/push-to-campaign — the segment-shaped entry point.
  api.post('/lead-lists/push-to-campaign', handler((req) => {
    const body = req.body || {}
    refuseBypass(body)
    // Checked before `campaignId` is even parsed, so the answer to "I gave you
    // a name" is the reason, not a bare missing-field error.
    if (String(body.campaignName ?? '').trim()) {
      throw invalid('campaignName', 'Harry never creates a campaign implicitly — choose an existing campaign by campaignId')
    }
    const campaignId = int(body, 'campaignId', { required: true, min: 1 })
    return pushToCampaign(req, campaignId, body)
  }))

  // POST /api/campaigns/:id/attach-segment — the same push named the way the
  // spec's backend story names it, for a caller already on a campaign.
  api.post('/campaigns/:id/attach-segment', handler((req) => {
    const campaignId = pathId(req, 'id')
    return pushToCampaign(req, campaignId, req.body)
  }))

  // --------------------------------------------------------------- by id -----
  // GET /api/lead-lists/:id
  api.get('/lead-lists/:id', handler((req) => {
    const started = Date.now()
    const row = ownedList(pathId(req), req.wsId)
    meter('lead_lists.get', Date.now() - started)
    return shape(row, { withImport: true })
  }))

  // ----------------------------------------------------------------- update --
  // PUT /api/lead-lists/:id — renames, and nothing else.
  api.put('/lead-lists/:id', handler((req) => {
    const id = pathId(req)
    const body = { ...req.body, name: req.body?.name ?? req.body?.listName }
    const row = ownedList(id, req.wsId)
    const name = str(body, 'name', { required: true, max: NAME_MAX })
    const description = body.description === undefined ? null : str(body, 'description', { max: DESC_MAX })

    // A rename to the identical name is a no-op: no write, no event, and
    // `updated_at` does not move.
    if (name === row.name && (description === null || description === (row.description || ''))) {
      return { id: row.id, name: row.name, description: row.description || '', updatedAt: row.updated_at, changed: false }
    }

    const updated = tx(() => {
      const clash = nameClash(req.wsId, name, id)
      if (clash) throw duplicateName(clash)
      if (description === null) {
        db.prepare("UPDATE lead_lists SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id)
      } else {
        db.prepare("UPDATE lead_lists SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?")
          .run(name, description, id)
      }
      return db.prepare('SELECT * FROM lead_lists WHERE id = ?').get(id)
    })

    audit(req, { type: 'lead_list_renamed', detail: `#${id}: "${row.name}" → "${updated.name}"` })
    return { id: updated.id, name: updated.name, description: updated.description || '', updatedAt: updated.updated_at, changed: true }
  }))

  // ----------------------------------------------------------------- delete --
  // DELETE /api/lead-lists/:id — soft, and it never touches `leads`.
  api.delete('/lead-lists/:id', handler((req) => {
    const id = pathId(req)
    const row = ownedList(id, req.wsId)
    const count = leadCount(id)

    const result = tx(() => {
      // Label assignments go; the labels themselves survive for other lists.
      const labels = db.prepare('DELETE FROM lead_list_tags WHERE list_id = ?').run(id).changes
      db.prepare("UPDATE lead_lists SET deleted_at = ?, updated_at = datetime('now') WHERE id = ?").run(nowIso(), id)
      return { labels }
    })

    audit(req, { type: 'lead_list_deleted', detail: `${row.name} (#${id}) held ${count} lead(s)` })
    return {
      ok: true,
      message: 'Lead list deleted successfully',
      // Said plainly, because it is the question the confirmation dialog has to
      // answer: the grouping is gone, the people are not. A lead that was only
      // in this list stays on the Leads page, ungrouped, with its stage,
      // research profile and campaign attachments untouched.
      leadsKept: count,
      leadsDeleted: 0,
      tagsUnassigned: result.labels,
    }
  }))

  // ----------------------------------------------------------------- import --
  // POST /api/lead-lists/:id/import
  api.post('/lead-lists/:id/import', handler((req) => {
    const started = Date.now()
    const listId = pathId(req)
    const list = ownedList(listId, req.wsId)

    // Import is the one place SmartLead offers a suppression override, so it is
    // the one place a caller is most likely to send one. Refusing is not the
    // same as ignoring: a silently dropped `ignore_unsubscribe_list` returns
    // 200 and lets an integrator believe the opt-out was bypassed. Same rule,
    // same wording, as server/parity/inbox.js.
    refuseBypass(req.body)

    const fileName = str(req.body, 'fileName', { required: true, max: 300 })
    const raw = req.body?.leads ?? req.body?.leadList
    if (raw === undefined || raw === null) throw invalid('leads', 'leads is required')
    if (!Array.isArray(raw)) throw invalid('leads', 'leads must be an array')
    if (raw.length > IMPORT_MAX) throw invalid('leads', `leads may contain at most ${IMPORT_MAX} rows`)

    const shared = req.body?.customFields
    if (shared !== undefined && shared !== null && (typeof shared !== 'object' || Array.isArray(shared))) {
      throw invalid('customFields', 'customFields must be an object')
    }

    const isBlocked = suppressor(req.wsId)
    const summary = {
      totalLeads: raw.length,
      imported: 0,
      duplicates: 0,
      blocked: 0,
      invalid: 0,
      addedToList: 0,
      suppression: { blockedDomain: 0, unsubscribed: 0 },
    }
    const errors = []

    const findLead = db.prepare('SELECT * FROM leads WHERE user_id = ? AND lower(email) = ?')
    const insertLead = db.prepare(
      `INSERT INTO leads (user_id, email, first_name, last_name, company, title, phone, website, linkedin, location, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const addMember = db.prepare('INSERT OR IGNORE INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)')

    // Chunked at 400 rows per transaction, matching the existing importer. A
    // chunk is all-or-nothing; a failure part way through a large file leaves
    // the completed chunks in the segment with an honest summary rather than a
    // silent partial state.
    for (let start = 0; start < raw.length; start += CHUNK) {
      const chunk = raw.slice(start, start + CHUNK)
      tx(() => {
        chunk.forEach((entry, i) => {
          const line = start + i + 1
          const row = entry && typeof entry === 'object' ? entry : {}
          const emailAddr = String(row.email ?? '').trim().toLowerCase()
          if (!emailAddr) {
            summary.invalid++
            errors.push({ row: line, email: '', reason: 'email is required' })
            return
          }
          if (!EMAIL_RE.test(emailAddr)) {
            summary.invalid++
            errors.push({ row: line, email: String(row.email), reason: 'malformed email address' })
            return
          }
          // Suppression runs before any write and cannot be overridden by any
          // request field — Harry has no `ignoreGlobalBlockList`.
          if (isBlocked(emailAddr)) {
            summary.blocked++
            summary.suppression.blockedDomain++
            errors.push({ row: line, email: emailAddr, reason: 'blocked domain' })
            return
          }

          const custom = {
            ...(shared && typeof shared === 'object' ? shared : {}),
            ...(row.customFields && typeof row.customFields === 'object' && !Array.isArray(row.customFields) ? row.customFields : {}),
          }
          const existing = findLead.get(req.wsId, emailAddr)

          if (existing) {
            if (existing.status === 'unsubscribed') {
              summary.blocked++
              summary.suppression.unsubscribed++
              errors.push({ row: line, email: emailAddr, reason: 'unsubscribed — will never be emailed' })
              return
            }
            summary.duplicates++
            // Re-importing updates the person's details rather than creating a
            // second copy of them.
            const merged = { ...safeJson(existing.custom_fields), ...custom }
            db.prepare(
              `UPDATE leads SET first_name = ?, last_name = ?, company = ?, title = ?,
                 phone = ?, website = ?, linkedin = ?, location = ?, custom_fields = ?,
                 updated_at = datetime('now')
               WHERE id = ?`
            ).run(
              pick(row.first_name ?? row.firstName, existing.first_name),
              pick(row.last_name ?? row.lastName, existing.last_name),
              pick(row.company, existing.company),
              pick(row.title, existing.title),
              pick(row.phone, existing.phone),
              pick(row.website, existing.website),
              pick(row.linkedin, existing.linkedin),
              pick(row.location, existing.location),
              JSON.stringify(merged),
              existing.id,
            )
            summary.addedToList += addMember.run(listId, existing.id).changes
            return
          }

          const info = insertLead.run(
            req.wsId, emailAddr,
            text(row.first_name ?? row.firstName), text(row.last_name ?? row.lastName),
            text(row.company), text(row.title), text(row.phone), text(row.website),
            text(row.linkedin), text(row.location), JSON.stringify(custom),
          )
          summary.imported++
          summary.addedToList += addMember.run(listId, info.lastInsertRowid).changes
        })
      })
    }

    const record = tx(() => {
      touchList(listId)
      const info = db.prepare(
        `INSERT INTO lead_list_imports
           (workspace_id, list_id, filename, requested, created, updated, skipped, blocked, errors, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')`
      ).run(req.wsId, listId, fileName, summary.totalLeads, summary.imported, summary.duplicates,
        summary.invalid, summary.blocked, JSON.stringify(errors.slice(0, 500)))
      return info.lastInsertRowid
    })

    audit(req, {
      type: 'lead_list_imported',
      detail: `${list.name} (#${listId}) ← ${fileName}: ${summary.imported} new, ${summary.duplicates} duplicate, ${summary.blocked} blocked, ${summary.invalid} invalid`,
    })
    meter('lead_lists.import', Date.now() - started, true, `${summary.totalLeads} rows`)

    return {
      importId: record,
      fileName,
      ...summary,
      leadCount: leadCount(listId),
      errors: errors.slice(0, 500),
      message: summary.totalLeads === 0
        ? 'Nothing to import'
        : summary.imported === 0
          ? `Nothing new to add — all ${summary.totalLeads} rows are already in this segment or were suppressed`
          : `${summary.imported} lead(s) added`,
    }
  }))
}

// ---- transfer ---------------------------------------------------------------

// Copy and move share one code path; the only difference is whether the source
// delete runs. Both run inside a single transaction, so a lead can never be
// missing from both segments at once.
function transfer(req, body, { leadFromPath = false } = {}) {
  const started = Date.now()
  const action = pickAction(body)
  const hasLeadIds = body?.leadIds !== undefined && body?.leadIds !== null
  const hasFrom = body?.fromListId !== undefined && body?.fromListId !== null && body?.fromListId !== ''

  if (hasLeadIds && hasFrom && !leadFromPath) {
    throw invalid('leadIds', 'Give exactly one source: either leadIds or fromListId, not both')
  }
  if (!hasLeadIds && !hasFrom) throw invalid('fromListId', 'A source is required: either leadIds or fromListId')

  const toListId = int(body, 'toListId', { required: true, min: 1 })
  const fromListId = hasFrom ? int(body, 'fromListId', { min: 1 }) : 0
  if (fromListId && fromListId === toListId) {
    throw invalid('toListId', 'Source and destination must be different lead lists')
  }
  if (action === 'move' && !fromListId) {
    throw invalid('fromListId', 'fromListId is required for a move — there is nothing to move out of')
  }

  const to = ownedList(toListId, req.wsId)
  const from = fromListId ? ownedList(fromListId, req.wsId) : null

  let leadIds
  if (hasLeadIds) {
    leadIds = idList(body, 'leadIds', { required: true, max: TRANSFER_MAX })
    // Every id is proved to be the caller's before any write, so a guessed id
    // 404s rather than quietly transferring a stranger's lead.
    ownedAll('leads', leadIds, req.wsId, 'lead')
  } else {
    leadIds = db.prepare('SELECT lead_id FROM lead_list_leads WHERE list_id = ? ORDER BY lead_id').all(from.id).map((r) => r.lead_id)
  }

  const result = tx(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)')
    const del = db.prepare('DELETE FROM lead_list_leads WHERE list_id = ? AND lead_id = ?')
    let transferred = 0
    let alreadyPresent = 0
    for (const leadId of leadIds) {
      const changes = ins.run(to.id, leadId).changes
      if (changes) transferred++
      else alreadyPresent++
      if (action === 'move') del.run(from.id, leadId)
    }
    touchList(to.id)
    if (from) touchList(from.id)
    return { transferred, alreadyPresent }
  })

  audit(req, {
    type: 'lead_list_transfer',
    detail: `${action} ${leadIds.length} lead(s) ${from ? `from #${from.id} ` : ''}to #${to.id}: ${result.transferred} transferred, ${result.alreadyPresent} already present`,
  })
  meter('lead_lists.transfer', Date.now() - started, true, `${leadIds.length} leads`)

  return {
    ok: true,
    action,
    fromListId: from ? from.id : null,
    toListId: to.id,
    considered: leadIds.length,
    transferred: result.transferred,
    alreadyPresent: result.alreadyPresent,
    totalLeadsMoved: result.transferred,
    // Membership is organisation only: nothing here composes or sends an email.
    message: leadIds.length === 0 ? 'Nothing to move' : `${result.transferred} lead(s) ${action === 'move' ? 'moved' : 'copied'}`,
  }
}

// ---- push to campaign -------------------------------------------------------

function pushToCampaign(req, campaignId, body) {
  const started = Date.now()
  const action = pickAction(body)

  // SmartLead creates a campaign from a bare `campaignName`. Harry does not: a
  // campaign without a valid playbook and a mailbox cannot launch, so one
  // conjured from a string would be broken on arrival.
  if (body?.campaignName !== undefined && body?.campaignName !== null && String(body.campaignName).trim()) {
    throw invalid('campaignName', 'Harry never creates a campaign implicitly — choose an existing campaign by campaignId')
  }
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    throw invalid('campaignId', 'campaignId is required and must be an existing campaign')
  }
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(campaignId, req.wsId)
  if (!campaign) throw notFound('campaign')

  const selection = body?.selection ?? body?.leadList ?? body ?? {}
  const hasList = selection.listId !== undefined && selection.listId !== null && selection.listId !== ''
  const hasIds = selection.leadIds !== undefined && selection.leadIds !== null
  const allLeads = selection.allLeads === true || selection.allLeads === 'true'
  const chosen = [hasList, hasIds, allLeads].filter(Boolean).length
  if (chosen === 0) throw invalid('selection', 'Choose exactly one of listId, leadIds or allLeads')
  if (chosen > 1) throw invalid('selection', 'Exactly one selection method is allowed: listId, leadIds or allLeads')
  if (action === 'move' && !hasList) {
    throw invalid('listId', 'A move needs a source segment — supply listId')
  }

  let list = null
  let leads
  if (hasList) {
    list = ownedList(int(selection, 'listId', { required: true, min: 1 }), req.wsId)
    leads = db.prepare(
      `SELECT l.* FROM lead_list_leads m JOIN leads l ON l.id = m.lead_id
       WHERE m.list_id = ? AND l.user_id = ? ORDER BY l.id`
    ).all(list.id, req.wsId)
  } else if (hasIds) {
    const ids = idList(selection, 'leadIds', { required: true, max: TRANSFER_MAX })
    leads = ownedAll('leads', ids, req.wsId, 'lead')
  } else {
    leads = db.prepare('SELECT * FROM leads WHERE user_id = ? ORDER BY id').all(req.wsId)
  }

  const isBlocked = suppressor(req.wsId)
  const excluded = { unsubscribed: 0, bounced: 0, blocked: 0 }
  const reasons = []
  const eligible = []
  for (const lead of leads) {
    if (lead.status === 'unsubscribed') {
      excluded.unsubscribed++
      reasons.push({ leadId: lead.id, email: lead.email, reason: 'unsubscribed' })
      continue
    }
    if (lead.status === 'bounced') {
      excluded.bounced++
      reasons.push({ leadId: lead.id, email: lead.email, reason: 'hard bounced' })
      continue
    }
    if (isBlocked(lead.email)) {
      excluded.blocked++
      reasons.push({ leadId: lead.id, email: lead.email, reason: 'blocked domain' })
      continue
    }
    eligible.push(lead)
  }

  const result = tx(() => {
    // The unique (campaign_id, lead_id) constraint makes the push idempotent
    // and leaves an already-attached lead's playbook position untouched.
    const attach = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)')
    const drop = db.prepare('DELETE FROM lead_list_leads WHERE list_id = ? AND lead_id = ?')
    let pushed = 0
    let duplicates = 0
    for (const lead of eligible) {
      if (attach.run(campaign.id, lead.id).changes) pushed++
      else duplicates++
      if (action === 'move' && list) drop.run(list.id, lead.id)
    }
    if (action === 'move' && list) touchList(list.id)
    return { pushed, duplicates }
  })

  audit(req, {
    campaignId: campaign.id,
    type: 'lead_list_pushed_to_campaign',
    detail: `${action} ${list ? `#${list.id} ` : ''}→ ${campaign.name}: ${result.pushed} pushed, ${result.duplicates} duplicate, ${excluded.unsubscribed + excluded.bounced + excluded.blocked} excluded`,
  })
  meter('lead_lists.push', Date.now() - started, true, `${leads.length} considered`)

  return {
    ok: true,
    campaignId: campaign.id,
    action,
    listId: list ? list.id : null,
    totalLeads: leads.length,
    pushed: result.pushed,
    duplicates: result.duplicates,
    excluded,
    exclusions: reasons.slice(0, 500),
    // Attaching leads never bypasses playbook validation or the launch
    // preconditions: the campaign's own status is untouched by this route, and
    // the first email still parks in Needs your OK.
    campaignStatus: campaign.status,
    message: leads.length === 0 ? 'Nothing to push' : `${result.pushed} lead(s) attached`,
  }
}

// ---- small helpers ----------------------------------------------------------

function pickAction(body) {
  const raw = body?.action
  if (raw === undefined || raw === null || raw === '') return 'copy'
  const value = String(raw).trim().toLowerCase()
  if (!['copy', 'move'].includes(value)) throw invalid('action', 'action must be one of: copy, move')
  return value
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function pick(value, fallback) {
  const next = text(value)
  return next || fallback || ''
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}
