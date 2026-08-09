// clients — agency client workspaces (Docs/clients/*.md, 4 endpoints).
//
// This is one of the three surfaces the backlog says Harry genuinely lacks.
// Harry's Team model (server/db.js `resolveWorkspace`) deliberately shares one
// workspace: invite someone and they see every lead, campaign and reply the
// owner sees. An agency client is the opposite — a *partition* inside that one
// workspace, so a brand's rows can be handed to that brand without handing over
// the rest. The partition is the nullable `client_id` column the parity schema
// added to campaigns, leads and mailboxes: a row with `client_id IS NULL`
// belongs to the agency itself, which is why a single-brand workspace is
// unaffected by every line of this file.
//
// Two rules run through the whole module:
//
//   1. No credential handling. `password` is rejected with 422 rather than
//      ignored, so nobody builds the habit of sending one. Sign-in stays with
//      Auth0 for clients exactly as it does for team members.
//   2. An API key's plaintext exists only in the response that mints it. The
//      table stores a prefix (a public handle) and a SHA-256 hash. Nothing
//      lists, logs, audits or errors with the value.

import crypto from 'node:crypto'
import { db, kvGet, kvSet } from '../db.js'
import {
  HttpError, invalid, notFound, handler,
  str, int, bool, oneOf, idList, email as emailField,
  page, paged, owned, ownedAll, tx, audit, meter,
} from './http.js'

// ---- permissions ------------------------------------------------------------

// Harry's real areas, not SmartLead's strings. The mapping happens here so the
// UI can offer "Mailboxes" while an API caller may still send the source's
// `email_accounts`, as clients/create.md §4 requires.
const AREAS = ['campaigns', 'mailboxes', 'leads', 'inbox', 'reports']
const AREA_ALIASES = {
  campaigns: 'campaigns',
  campaign: 'campaigns',
  mailboxes: 'mailboxes',
  mailbox: 'mailboxes',
  email_accounts: 'mailboxes',
  'email-accounts': 'mailboxes',
  leads: 'leads',
  lead: 'leads',
  inbox: 'inbox',
  master_inbox: 'inbox',
  'master-inbox': 'inbox',
  reports: 'reports',
  analytics: 'reports',
}

// Returns null when the caller said nothing about permissions, so a PATCH can
// tell "leave them alone" apart from "set them to none".
function parsePermissions(body) {
  const field = body?.permission !== undefined ? 'permission' : 'permissions'
  const raw = body?.[field]
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) throw invalid(field, `${field} must be an array of areas`)
  const out = []
  for (const item of raw) {
    const key = String(item ?? '').trim().toLowerCase()
    const mapped = AREA_ALIASES[key]
    if (!mapped) {
      throw invalid(field, `${field} contains an unknown area: ${item}. Valid areas are: ${AREAS.join(', ')}`)
    }
    if (!out.includes(mapped)) out.push(mapped)
  }
  return out
}

// ---- credentials ------------------------------------------------------------

// The one divergence the README states in full: the source API accepts a
// password on client save. Harry rejects it, names the field, and says why.
// The value is never read, never hashed, never logged — only its presence.
const CREDENTIAL_FIELDS = ['password', 'passwordConfirmation', 'password_confirmation', 'new_password', 'newPassword']

function rejectCredentials(body) {
  for (const field of CREDENTIAL_FIELDS) {
    if (body && Object.prototype.hasOwnProperty.call(body, field)) {
      throw invalid(
        field,
        `Harry never accepts or stores a ${field}. A client's people sign in through Auth0 with their own identity, exactly as team members do — invite the contact by email instead.`
      )
    }
  }
}

// ---- branding ---------------------------------------------------------------

const LOGO_MAX_CHARS = 200_000 // ~150 KB of image once decoded

function parseLogo(body, fallback = '') {
  const raw = body?.logo
  if (raw !== undefined && raw !== null && raw !== '') {
    const value = String(raw)
    if (value.length > LOGO_MAX_CHARS) {
      throw invalid('logo', `logo must be ${LOGO_MAX_CHARS} characters of base64 or fewer (about 150 KB)`)
    }
    const b64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value
    if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
      throw invalid('logo', 'logo must be base64-encoded image data, optionally as a data: URL')
    }
    if (value.startsWith('data:')) return value
    const mime = str(body, 'logo_mime', { fallback: 'image/png', max: 64 })
    if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) throw invalid('logo_mime', 'logo_mime must be an image media type')
    return `data:${mime};base64,${b64.replace(/\s+/g, '')}`
  }
  const url = str(body, 'logo_url', { max: 4096, fallback: '' })
  if (!url) return fallback
  if (!/^(https?:\/\/|data:image\/)/i.test(url)) {
    throw invalid('logo_url', 'logo_url must be an http(s) URL or a data:image URL')
  }
  return url
}

function parseColor(body, fallback = '') {
  const value = str(body, 'color', { max: 32, fallback: '' })
  if (!value) return fallback
  if (!/^#[0-9a-fA-F]{3,8}$/.test(value)) throw invalid('color', 'color must be a hex value such as #7c3aed')
  return value
}

// ---- allowances -------------------------------------------------------------

// The parity schema (frozen, and rightly so) gives `clients` no credit columns,
// and smuggling an object into the `permissions` JSON would make that column
// lie about its own shape. Allowances therefore live in the shared `kv` store
// under a client-scoped key: readable, deletable with the client, and honest
// about being a side table rather than part of the record.
const CREDITS_DEFAULT = { assigned: false, email_credits: 0, lead_credits: 0 }
const creditsKey = (clientId) => `client_credits:${clientId}`

function readCredits(clientId) {
  try {
    const parsed = JSON.parse(kvGet(creditsKey(clientId)) || '{}')
    return { ...CREDITS_DEFAULT, ...parsed }
  } catch {
    return { ...CREDITS_DEFAULT }
  }
}

function writeCredits(clientId, credits) {
  kvSet(creditsKey(clientId), JSON.stringify(credits))
}

function parseCredits(body, current = CREDITS_DEFAULT) {
  const assigned = body?.is_credit_assigned === undefined && body?.isCreditAssigned === undefined
    ? current.assigned
    : bool(body, body?.is_credit_assigned === undefined ? 'isCreditAssigned' : 'is_credit_assigned', current.assigned)
  const emails = int(body, 'email_credits', { min: 0, max: 1_000_000_000, fallback: current.email_credits })
  const leads = int(body, 'lead_credits', { min: 0, max: 1_000_000_000, fallback: current.lead_credits })
  // Credits without the flag are ignored rather than half-applied — the client
  // simply draws on the agency pool (create.md TC-11).
  return assigned
    ? { assigned: true, email_credits: emails, lead_credits: leads }
    : { ...CREDITS_DEFAULT }
}

function presentCredits(clientId) {
  const c = readCredits(clientId)
  return c.assigned
    ? { assigned: true, email_credits: c.email_credits, lead_credits: c.lead_credits, source: 'client allowance' }
    : { assigned: false, email_credits: 0, lead_credits: 0, source: 'agency pool', note: 'This client draws on the agency pool.' }
}

// ---- lookups ----------------------------------------------------------------

// `owned` handles the workspace check and the leak-free 404; a soft-deleted
// client is gone as far as every read is concerned.
function clientOf(req, id, what = 'client') {
  const row = owned('clients', id, req.wsId, what)
  if (row.deleted_at) throw notFound(what)
  return row
}

function assertNameFree(wsId, name, exceptId = 0) {
  const clash = db.prepare(
    'SELECT id FROM clients WHERE workspace_id = ? AND lower(name) = lower(?) AND id != ?'
  ).get(wsId, name, exceptId)
  if (clash) {
    throw new HttpError(409, {
      error: 'conflict',
      field: 'name',
      message: 'A client with that name already exists in this workspace',
    })
  }
}

// "already used by another client or member" (create.md AC 2). Members share the
// workspace by design, so a contact email that already belongs to one would be
// ambiguous at sign-in — which scope did they mean?
function assertEmailFree(wsId, value, exceptId = 0) {
  if (!value) return
  const clash = db.prepare(
    "SELECT id FROM clients WHERE workspace_id = ? AND lower(email) = ? AND id != ? AND IFNULL(deleted_at, '') = ''"
  ).get(wsId, value, exceptId)
  if (clash) throw invalid('email', 'email is already in use by another client')
  const member = db.prepare('SELECT id FROM team_members WHERE owner_id = ? AND lower(email) = ?').get(wsId, value)
  if (member) throw invalid('email', 'email is already in use by a team member')
  const owner = db.prepare('SELECT id FROM users WHERE id = ? AND lower(email) = ?').get(wsId, value)
  if (owner) throw invalid('email', 'email is already in use by the agency owner')
}

function presentClient(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    logo_url: row.logo_url,
    color: row.color,
    permissions: safeJson(row.permissions, []),
    status: row.status,
    credits: presentCredits(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// get-all.md is explicit: the list row is exactly four light fields. No
// permissions, credits or branding leak into it.
function presentClientRow(row) {
  return { id: row.id, name: row.name, email: row.email, created_at: row.created_at }
}

function safeJson(raw, fallback) {
  try { return JSON.parse(raw || '') ?? fallback } catch { return fallback }
}

// ---- api keys ---------------------------------------------------------------

const KEY_NAME_RE = /^[A-Za-z0-9 _-]+$/
const KEY_SCOPES = ['read', 'write']
const STALE_DAYS = 90

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

// `htmk_<10 hex>` is the stored, non-secret handle; the 48 hex characters after
// it are the secret. Splitting them means a lookup is an index hit on the
// prefix and the comparison is constant-time on the hash.
function mintKey() {
  const prefix = `htmk_${crypto.randomBytes(5).toString('hex')}`
  const secret = crypto.randomBytes(24).toString('hex')
  const value = `${prefix}_${secret}`
  return { prefix, value, hash: sha256(value) }
}

function parseKeyName(body, { required = true } = {}) {
  const field = body?.keyName !== undefined ? 'keyName' : 'key_name'
  const value = str(body, field, { required, max: 120 })
  if (!value) return ''
  if (!KEY_NAME_RE.test(value)) {
    throw invalid(field, `${field} may contain only letters, numbers, spaces, hyphens and underscores`)
  }
  return value
}

// Built field by field rather than by deleting from the row, so a future column
// cannot leak by default. `key_hash` has no route out of this module.
function presentKey(row) {
  const lastUsed = row.last_used_at || ''
  const staleAfter = Date.now() - STALE_DAYS * 86_400_000
  return {
    id: row.id,
    client_id: row.client_id,
    key_name: row.key_name,
    key_prefix: row.key_prefix,
    scope: row.scope,
    status: row.status,
    last_used_at: lastUsed || null,
    never_used: !lastUsed,
    stale: row.status === 'active' && (!lastUsed || Date.parse(lastUsed) < staleAfter),
    created_at: row.created_at,
    revoked_at: row.revoked_at || null,
  }
}

// Resolution for the future authentication middleware (api-keys.md §5): find by
// prefix, verify the hash in constant time, refuse anything not active, and
// stamp `last_used_at` at most once a minute so a busy key does not turn every
// request into a write. Exported rather than mounted — no route in this module
// ever accepts a key value as input.
const LAST_USED_THROTTLE_MS = 60_000

export function resolveClientApiKey(raw) {
  const value = String(raw || '')
  const cut = value.lastIndexOf('_')
  if (cut <= 0) return null
  const prefix = value.slice(0, cut)
  const row = db.prepare('SELECT * FROM client_api_keys WHERE key_prefix = ?').get(prefix)
  if (!row) return null

  const given = Buffer.from(sha256(value), 'hex')
  const stored = Buffer.from(String(row.key_hash || ''), 'hex')
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return null
  // A revoked key is 401, never 403: it must not confirm it ever existed.
  if (row.status !== 'active') return null

  const client = db.prepare("SELECT * FROM clients WHERE id = ? AND IFNULL(deleted_at, '') = ''").get(row.client_id)
  if (!client || client.status !== 'active') return null

  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0
  if (!last || Date.now() - last > LAST_USED_THROTTLE_MS) {
    db.prepare("UPDATE client_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id)
  }
  return { key: presentKey(row), client, wsId: client.workspace_id, clientId: client.id, scope: row.scope }
}

// ---- client scope -----------------------------------------------------------

// The three tables the parity schema gave a `client_id`. Attaching is how a row
// stops belonging to the agency and starts belonging to one brand.
const SCOPES = {
  campaigns: { table: 'campaigns', what: 'campaign', columns: 'id, name, status, created_at' },
  leads: { table: 'leads', what: 'lead', columns: 'id, email, first_name, last_name, company, status' },
  mailboxes: { table: 'mailboxes', what: 'mailbox', columns: 'id, email, provider, status' },
}
const SCOPE_BODY_FIELD = { campaigns: 'campaignIds', leads: 'leadIds', mailboxes: 'mailboxIds' }

function scopeCounts(wsId, clientId) {
  const counts = {}
  for (const [kind, spec] of Object.entries(SCOPES)) {
    counts[kind] = db.prepare(
      `SELECT COUNT(*) AS n FROM ${spec.table} WHERE user_id = ? AND client_id = ?`
    ).get(wsId, clientId).n
  }
  return counts
}

// ---- routes -----------------------------------------------------------------

export function register(api) {
  // ---------------------------------------------------------------- list ----
  // get-all.md offers no paging upstream, and none is needed below a few
  // hundred clients — but "unbounded requests are rejected" is a standing rule,
  // so the default limit is high enough that the switcher gets everything and
  // an absurd account still cannot ask for the world in one response.
  api.get('/clients', handler(async (req) => {
    const started = Date.now()
    const { limit, cursor } = page(req.query, { defaultLimit: 200, maxLimit: 500 })
    const status = oneOf(req.query, 'status', ['active', 'archived', 'all'], { fallback: 'active' })

    const where = ["IFNULL(c.deleted_at, '') = ''", 'c.workspace_id = ?']
    const args = [req.wsId]
    if (status !== 'all') { where.push('c.status = ?'); args.push(status) }
    if (cursor) { where.push('c.id < ?'); args.push(cursor) }

    const rows = db.prepare(
      `SELECT c.* FROM clients c WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ?`
    ).all(...args, limit + 1)

    const out = paged(rows, limit)
    meter('clients.list', Date.now() - started, true, `${out.items.length} client(s)`)
    return {
      ok: true,
      data: out.items.map(presentClientRow),
      nextCursor: out.nextCursor,
      hasMore: out.hasMore,
    }
  }))

  // A follow-up read of a client from another agency must 404 like every other
  // cross-workspace id (update.md TC-3).
  api.get('/clients/:id', handler(async (req) => {
    return { ok: true, data: presentClient(clientOf(req, req.params.id)) }
  }))

  // -------------------------------------------------------------- create ----
  api.post('/clients', handler(async (req) => {
    const started = Date.now()
    const body = req.body || {}
    rejectCredentials(body)
    // SmartLead reuses one /client/save for create and update. Harry splits
    // them so the audit trail is unambiguous, and says so rather than quietly
    // creating a second client (update.md §5).
    if (body.id !== undefined && body.id !== null && body.id !== '') {
      throw invalid('id', 'id is not accepted on create — use PATCH /api/clients/:id to update an existing client')
    }

    const name = str(body, 'name', { required: true, max: 120 })
    const contact = emailField(body, 'email', { required: true })
    const permissions = parsePermissions(body) ?? []
    const logoUrl = parseLogo(body)
    const color = parseColor(body)
    const credits = parseCredits(body)

    assertNameFree(req.wsId, name)
    assertEmailFree(req.wsId, contact)

    const row = tx(() => {
      let info
      try {
        info = db.prepare(
          'INSERT INTO clients (workspace_id, name, email, logo_url, color, permissions, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(req.wsId, name, contact, logoUrl, color, JSON.stringify(permissions), 'active')
      } catch (err) {
        // The UNIQUE (workspace_id, name) index is the real guard; the check
        // above only makes the common case a friendlier message.
        if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
          throw new HttpError(409, { error: 'conflict', field: 'name', message: 'A client with that name already exists in this workspace' })
        }
        throw err
      }
      writeCredits(info.lastInsertRowid, credits)
      return db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid)
    })

    audit(req, {
      type: 'client_created',
      detail: `${req.user.email} created client "${name}" (${contact}) with ${permissions.length ? permissions.join(', ') : 'no areas'}` +
        (credits.assigned ? `; allowance ${credits.email_credits} emails / ${credits.lead_credits} leads` : '; agency pool'),
    })
    meter('clients.create', Date.now() - started, true, `client ${row.id}`)
    return { ok: true, data: presentClient(row) }
  }))

  // -------------------------------------------------------------- update ----
  api.patch('/clients/:id', handler(async (req) => {
    const body = req.body || {}
    rejectCredentials(body)
    const existing = clientOf(req, req.params.id)

    const name = body.name === undefined ? existing.name : str(body, 'name', { required: true, max: 120 })
    const contact = body.email === undefined ? existing.email : emailField(body, 'email', { required: true })
    const permissions = parsePermissions(body) ?? safeJson(existing.permissions, [])
    const logoUrl = parseLogo(body, existing.logo_url)
    const color = parseColor(body, existing.color)
    const status = oneOf(body, 'status', ['active', 'archived'], { fallback: existing.status })
    const before = readCredits(existing.id)
    const credits = parseCredits(body, before)

    if (name !== existing.name) assertNameFree(req.wsId, name, existing.id)
    if (contact !== existing.email) assertEmailFree(req.wsId, contact, existing.id)

    const previous = safeJson(existing.permissions, [])
    const changes = []
    if (name !== existing.name) changes.push(`name "${existing.name}" → "${name}"`)
    if (contact !== existing.email) changes.push(`email ${existing.email} → ${contact}`)
    if (logoUrl !== existing.logo_url) changes.push('branding')
    if (color !== existing.color) changes.push('colour')
    if (status !== existing.status) changes.push(`status ${existing.status} → ${status}`)
    if (JSON.stringify(permissions) !== JSON.stringify(previous)) {
      const removed = previous.filter((p) => !permissions.includes(p))
      const added = permissions.filter((p) => !previous.includes(p))
      changes.push(`permissions${added.length ? ` +${added.join(',')}` : ''}${removed.length ? ` -${removed.join(',')}` : ''}`)
    }
    if (JSON.stringify(credits) !== JSON.stringify(before)) {
      changes.push(credits.assigned
        ? `allowance ${before.email_credits}/${before.lead_credits} → ${credits.email_credits}/${credits.lead_credits}`
        : 'allowance returned to the agency pool')
    }

    // A save identical to the stored record is a no-op: no write, and no
    // activity-trail entry pretending something happened (update.md TC-6).
    if (!changes.length) {
      return { ok: true, data: presentClient(existing), changed: false }
    }

    const row = tx(() => {
      try {
        db.prepare(
          "UPDATE clients SET name = ?, email = ?, logo_url = ?, color = ?, permissions = ?, status = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?"
        ).run(name, contact, logoUrl, color, JSON.stringify(permissions), status, existing.id, req.wsId)
      } catch (err) {
        if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
          throw new HttpError(409, { error: 'conflict', field: 'name', message: 'A client with that name already exists in this workspace' })
        }
        throw err
      }
      writeCredits(existing.id, credits)
      return db.prepare('SELECT * FROM clients WHERE id = ?').get(existing.id)
    })

    audit(req, { type: 'client_updated', detail: `${req.user.email} updated client "${row.name}": ${changes.join('; ')}` })

    // An allowance below what the client has already used is accepted, not
    // refused — but it is stated, once, on the trail and in the response
    // (update.md AC 4, partially: the pause itself is not built — see
    // `overAllowance` below).
    const over = credits.assigned && overAllowance(req.wsId, existing.id, credits)
    if (over) audit(req, { type: 'client_over_allowance', detail: `Client "${row.name}" is over its allowance: ${over.used} of ${over.allowed} emails used` })

    return { ok: true, data: presentClient(row), changed: true, overAllowance: over || null }
  }))

  // -------------------------------------------------------------- delete ----
  // A soft delete: the client disappears from every list, its keys stop working
  // at once, and its rows return to the agency's own scope rather than being
  // destroyed. Deleting a brand should not delete a year of outreach.
  api.delete('/clients/:id', handler(async (req) => {
    const existing = clientOf(req, req.params.id)
    const released = tx(() => {
      const counts = scopeCounts(req.wsId, existing.id)
      for (const spec of Object.values(SCOPES)) {
        db.prepare(`UPDATE ${spec.table} SET client_id = NULL WHERE user_id = ? AND client_id = ?`).run(req.wsId, existing.id)
      }
      db.prepare(
        "UPDATE client_api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE client_id = ? AND status = 'active'"
      ).run(existing.id)
      db.prepare(
        "UPDATE clients SET status = 'archived', deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND workspace_id = ?"
      ).run(existing.id, req.wsId)
      db.prepare('DELETE FROM kv WHERE key = ?').run(creditsKey(existing.id))
      return counts
    })
    audit(req, {
      type: 'client_deleted',
      detail: `${req.user.email} deleted client "${existing.name}"; released ${released.campaigns} campaign(s), ${released.leads} lead(s), ${released.mailboxes} mailbox(es) to the agency workspace`,
    })
    return { ok: true, deleted: existing.id, released }
  }))

  // ------------------------------------------------------------ api keys ----
  api.get('/clients/:clientId/api-keys', handler(async (req) => {
    const client = clientOf(req, req.params.clientId)
    const { limit, cursor } = page(req.query, { defaultLimit: 100, maxLimit: 200 })
    // The upstream contract says active/inactive; the table says active/revoked.
    // Both spellings are accepted and mean the same row.
    const status = oneOf(req.query, 'status', ['active', 'inactive', 'revoked', 'all'], { fallback: 'active' })
    const nameQuery = str(req.query, req.query?.keyName !== undefined ? 'keyName' : 'key_name', { max: 120 })

    const where = ['workspace_id = ?', 'client_id = ?']
    const args = [req.wsId, client.id]
    if (status !== 'all') { where.push('status = ?'); args.push(status === 'inactive' ? 'revoked' : status) }
    if (nameQuery) { where.push('lower(key_name) LIKE ?'); args.push(`%${nameQuery.toLowerCase()}%`) }
    if (cursor) { where.push('id < ?'); args.push(cursor) }

    const rows = db.prepare(
      `SELECT * FROM client_api_keys WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`
    ).all(...args, limit + 1)

    const out = paged(rows, limit)
    return { ok: true, data: out.items.map(presentKey), nextCursor: out.nextCursor, hasMore: out.hasMore }
  }))

  // The one response in Harry that contains a secret. It is minted here, shown
  // here, and never recoverable afterwards — the row keeps a hash.
  api.post('/clients/:clientId/api-keys', handler(async (req) => {
    const body = req.body || {}
    rejectCredentials(body)
    const client = clientOf(req, req.params.clientId)
    const keyName = parseKeyName(body)
    const scope = oneOf(body, 'scope', KEY_SCOPES, { fallback: 'read' })

    const minted = mintKey()
    const row = tx(() => {
      const info = db.prepare(
        'INSERT INTO client_api_keys (workspace_id, client_id, key_name, key_prefix, key_hash, scope, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(req.wsId, client.id, keyName, minted.prefix, minted.hash, scope, 'active')
      return db.prepare('SELECT * FROM client_api_keys WHERE id = ?').get(info.lastInsertRowid)
    })

    audit(req, {
      type: 'client_api_key_created',
      detail: `${req.user.email} created ${scope} API key "${keyName}" (${minted.prefix}) for client "${client.name}"`,
    })
    return {
      ok: true,
      data: { ...presentKey(row), api_key: minted.value },
      notice: 'This is the only time this value is shown. Store it in your password manager.',
    }
  }))

  // Revocation, not deletion: the row stays so the activity trail and the
  // "which key was that?" question both still have an answer.
  api.delete('/api-keys/:id', handler(async (req) => {
    const key = owned('client_api_keys', req.params.id, req.wsId, 'API key')
    if (key.status === 'revoked') return { ok: true, data: presentKey(key), changed: false }
    const row = tx(() => {
      db.prepare("UPDATE client_api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE id = ? AND workspace_id = ?")
        .run(key.id, req.wsId)
      return db.prepare('SELECT * FROM client_api_keys WHERE id = ?').get(key.id)
    })
    audit(req, {
      type: 'client_api_key_revoked',
      detail: `${req.user.email} revoked API key "${key.key_name}" (${key.key_prefix})`,
    })
    return { ok: true, data: presentKey(row), changed: true }
  }))

  // Same id, same name, same row position — a new secret. The old value stops
  // working on the very next request because the stored hash is replaced.
  api.post('/api-keys/:id/reset', handler(async (req) => {
    const key = owned('client_api_keys', req.params.id, req.wsId, 'API key')
    const minted = mintKey()
    const row = tx(() => {
      db.prepare(
        "UPDATE client_api_keys SET key_prefix = ?, key_hash = ?, status = 'active', revoked_at = '', last_used_at = '' WHERE id = ? AND workspace_id = ?"
      ).run(minted.prefix, minted.hash, key.id, req.wsId)
      return db.prepare('SELECT * FROM client_api_keys WHERE id = ?').get(key.id)
    })
    audit(req, {
      type: 'client_api_key_reset',
      detail: `${req.user.email} reset API key "${key.key_name}" (${key.key_prefix} → ${minted.prefix})`,
    })
    return {
      ok: true,
      data: { ...presentKey(row), api_key: minted.value },
      notice: 'The previous value stopped working immediately. This is the only time the new value is shown.',
    }
  }))

  // ----------------------------------------------------------- the scope ----
  // How a brand's rows actually become the brand's. Campaign, lead and mailbox
  // routes belong to other modules and are left alone: attaching is done from
  // the client's side, which is also the only side that knows what a client is.
  api.get('/clients/:clientId/scope', handler(async (req) => {
    const client = clientOf(req, req.params.clientId)
    return { ok: true, data: { client_id: client.id, name: client.name, counts: scopeCounts(req.wsId, client.id) } }
  }))

  api.get('/clients/:clientId/scope/:kind', handler(async (req) => {
    const client = clientOf(req, req.params.clientId)
    const kind = String(req.params.kind || '')
    const spec = SCOPES[kind]
    if (!spec) throw invalid('kind', `kind must be one of: ${Object.keys(SCOPES).join(', ')}`)
    const { limit, cursor } = page(req.query, { defaultLimit: 50, maxLimit: 200 })
    const args = [req.wsId, client.id]
    let where = 'user_id = ? AND client_id = ?'
    if (cursor) { where += ' AND id < ?'; args.push(cursor) }
    const rows = db.prepare(
      `SELECT ${spec.columns} FROM ${spec.table} WHERE ${where} ORDER BY id DESC LIMIT ?`
    ).all(...args, limit + 1)
    const out = paged(rows, limit)
    return { ok: true, data: out.items, nextCursor: out.nextCursor, hasMore: out.hasMore }
  }))

  api.post('/clients/:clientId/scope', handler(async (req) => {
    const client = clientOf(req, req.params.clientId)
    return moveScope(req, client, client.id)
  }))

  api.delete('/clients/:clientId/scope', handler(async (req) => {
    const client = clientOf(req, req.params.clientId)
    return moveScope(req, client, null)
  }))
}

// Attach (target = client id) or detach (target = null). All-or-nothing: one id
// belonging to another workspace rejects the whole request, and the audit trail
// gets one row for the action rather than one per record.
function moveScope(req, client, target) {
  const body = req.body || {}
  const requested = {}
  let total = 0
  for (const [kind, spec] of Object.entries(SCOPES)) {
    const ids = idList(body, SCOPE_BODY_FIELD[kind], { max: 2000 })
    if (!ids.length) continue
    ownedAll(spec.table, ids, req.wsId, spec.what)
    requested[kind] = ids
    total += ids.length
  }
  if (!total) {
    throw invalid('campaignIds', 'supply at least one of campaignIds, leadIds or mailboxIds')
  }

  const moved = tx(() => {
    const counts = {}
    for (const [kind, ids] of Object.entries(requested)) {
      const spec = SCOPES[kind]
      const stmt = db.prepare(`UPDATE ${spec.table} SET client_id = ? WHERE id = ? AND user_id = ?`)
      for (const id of ids) stmt.run(target, id, req.wsId)
      counts[kind] = ids.length
    }
    return counts
  })

  const summary = Object.entries(moved).map(([kind, n]) => `${n} ${kind}`).join(', ')
  audit(req, {
    type: target === null ? 'client_scope_detached' : 'client_scope_attached',
    detail: target === null
      ? `${req.user.email} returned ${summary} from client "${client.name}" to the agency workspace`
      : `${req.user.email} attached ${summary} to client "${client.name}"`,
  })
  return { ok: true, client_id: client.id, attached: target !== null, moved, counts: scopeCounts(req.wsId, client.id) }
}

// What one client has spent against what it was given.
//
// Exported because the send gate asks it too (server/gates.js, `resolveSend`):
// the number a toast quotes when an allowance is lowered and the number that
// stops an email leaving have to be the same number, counted the same way, or
// the Settings panel and the campaign header would disagree about whether a
// brand is over its limit.
//
// Usage is emails already sent on the client's behalf — from a campaign that
// belongs to the client or from one of its mailboxes — because that is what an
// email allowance is spent on. `assigned: false` means the client draws on the
// agency pool and has no ceiling of its own, so there is nothing to be over.
export function clientAllowance(wsId, clientId, credits = null) {
  const client = db.prepare("SELECT id, name FROM clients WHERE id = ? AND workspace_id = ? AND IFNULL(deleted_at,'') = ''")
    .get(clientId, wsId)
  if (!client) return null
  const limits = credits || readCredits(clientId)
  if (!limits.assigned || !limits.email_credits) return null
  const used = db.prepare(
    `SELECT COUNT(*) AS n FROM messages m
      WHERE m.user_id = ? AND m.direction = 'out'
        AND (m.campaign_id IN (SELECT id FROM campaigns WHERE user_id = ? AND client_id = ?)
             OR m.mailbox_id IN (SELECT id FROM mailboxes WHERE user_id = ? AND client_id = ?))`
  ).get(wsId, wsId, clientId, wsId, clientId).n
  return { name: client.name, used, allowed: limits.email_credits, over: used > limits.email_credits }
}

// Lowering an allowance below usage is accepted and reported, never refused
// (update.md AC 4). What follows the acceptance is a real pause: the send gate
// refuses every email from that client's campaigns until the allowance is
// raised or the client goes back on the agency pool, so this can now say so.
//
// It used to say the opposite, honestly — nothing on the send path read a
// client allowance, so the breach was recorded and surfaced and that was all.
// The gate is `client_allowance` in server/gates.js; the campaign header and
// the approval queue read the same resolver, so the reason shows up wherever a
// user asks why a campaign is holding.
function overAllowance(wsId, clientId, credits) {
  const state = clientAllowance(wsId, clientId, credits)
  if (!state || !state.over) return null
  return {
    used: state.used,
    allowed: state.allowed,
    enforced: true,
    reason: `This client has sent ${state.used} of its ${state.allowed} allowance. Its campaigns will not send again until you raise the allowance or return the client to the agency pool.`,
  }
}
