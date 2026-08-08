// Prospect discovery and contact enrichment — Docs/smart-prospect/*.
//
// Twenty-six upstream endpoints collapse into one job: describe an audience,
// look at who is in it, and pay to turn some of them into leads. Three things
// in that job are easy to get wrong, so each is written down once here:
//
//   1. The provider key is server-side only. Nothing the browser holds is a
//      provider concept — no `scroll_id`, no `filter_id`. A search's cursor is
//      an opaque token this module minted, and every id in a path is a row in
//      Harry's own `prospect_searches` / `prospect_fetches` table, scoped to the
//      workspace that created it. A stranger's id is a 404, not a leak.
//   2. `fetch-contacts` answers a credit failure with **HTTP 200 and
//      `success: false`**. The naive `res.ok` check is wrong for that endpoint,
//      so the branch is explicit (`classifyFetch`), the fetch row is stored as
//      `insufficient_credits`, and no lead is created. It is a first-class
//      outcome, not an error.
//   3. Search translation is ONE mapping table (`SEARCH_MAP`). Every documented
//      field is in it and nothing else is ever sent — `translateSearch` is
//      exported so a test can assert exactly that, key by key.
//
// Errors are keyed on status code and never on message text: this category's
// search endpoint says `"API key is required"` where its siblings say
// `"User not authenticated"` for the same 401, and its find-emails endpoint
// uses a third shape again. `server/parity/providers.js` owns that rule.
//
// With no provider configured every route below still exists, still validates,
// still reads and writes Harry's own rows, and reports `configured: false` with
// the environment variables that are missing — the same honest degradation
// `server/google.js` gives an unconnected Google account. Nothing is invented.

import { db } from '../db.js'
import {
  invalid, notFound, forbidden, handler,
  str, int, bool, oneOf, page, tx, audit, meter, nowIso,
} from './http.js'
import { configured, call, unconfigured } from './providers.js'

const ENV_VARS = ['PROSPECT_API_URL', 'PROSPECT_API_KEY']
const BASE = '/api/v1/search-email-leads'

// The one indirection between this module and the network. It exists so the
// branches that must be proven — a 200 carrying `success: false`, a cached
// vocabulary that does not call twice — can be exercised without a socket.
// Production reads straight through to the env-gated adapter.
export const upstream = {
  configured: () => configured('prospects'),
  call: (path, opts = {}) => call('prospects', path, opts),
}

function notConfigured(extra = {}) {
  return { ...unconfigured('prospects', ENV_VARS), ...extra }
}

// ---- ceilings ----------------------------------------------------------------
// Every one of these is enforced before an upstream call, and every 422 names
// both the field and the number, because "invalid request" tells a user nothing
// about which paste to shorten.

const MAX_SEARCH_LIMIT = 500        // search-contacts: documented 1–500
const MAX_CRITERIA_ITEMS = 2000     // search-contacts: per-array maximum
const MAX_SAVE_LIMIT = 10000        // save-search: documented 1–10000
const MAX_FETCH_COUNT = 10000       // fetch-contacts: 1–10000 (30000 by account)
const MAX_ADAPT_IDS = 200           // get-contacts: at most 200 ids
const MAX_FETCH_ADAPT_IDS = 1000    // fetch-contacts selects from one screen
const MAX_VISUAL_LIMIT = 1000       // fetch-contacts: visual_limit cap
const MAX_CONTACT_LIMIT = 1000      // get-contacts: limit 1–1000
const MAX_VOCAB_LIMIT = 100         // every filter lookup: documented 1–100
const MAX_SEARCH_TEXT = 255         // every filter lookup: `search` cap
const MAX_NAME = 255                // rename endpoints: search_string 1–255
const MAX_RECONCILE = 1000          // paste-a-list flows
const MAX_FIND_EMAIL_LEADS = 500    // one job's worth of leads
const FIND_EMAIL_BATCH = 10         // find-emails: at most 10 contacts per call
const MAX_COUNTRY_PARAM = 255       // states: assembled `country` string cap

const VERIFICATION_STATUSES = ['valid', 'catch_all', 'invalid']
const CATCH_ALL_STATUSES = [
  'catch_all_verified', 'catch_all_soft_bounced', 'catch_all_hard_bounced',
  'catch_all_unknown', 'catch_all_bounced',
]

// ---- the search mapping table ------------------------------------------------
//
// Harry's filter names on the left, the provider's documented field on the
// right. This table is the ONLY place a provider field name appears for a
// search, which is what makes "no undocumented key is ever sent" a property a
// test can check rather than a habit reviewers have to police.
//
// `array` fields are always emitted as arrays even for a single value — the
// docs are explicit that a bare string is not accepted. `boolean` fields pass
// through as booleans.

export const SEARCH_MAP = {
  fullName: { key: 'name', kind: 'array' },
  firstName: { key: 'firstName', kind: 'array' },
  lastName: { key: 'lastName', kind: 'array' },
  title: { key: 'title', kind: 'array' },
  includeTitles: { key: 'includeTitle', kind: 'array' },
  excludeTitles: { key: 'excludeTitle', kind: 'array' },
  includeCompanies: { key: 'includeCompany', kind: 'array' },
  excludeCompanies: { key: 'excludeCompany', kind: 'array' },
  includeCompanyDomains: { key: 'includeCompanyDomain', kind: 'array' },
  excludeCompanyDomains: { key: 'excludeCompanyDomain', kind: 'array' },
  departmentIds: { key: 'department', kind: 'array' },
  levelIds: { key: 'level', kind: 'array' },
  companyNames: { key: 'companyName', kind: 'array' },
  companyDomains: { key: 'companyDomain', kind: 'array' },
  companyKeywords: { key: 'companyKeyword', kind: 'array' },
  headCountIds: { key: 'companyHeadCount', kind: 'array' },
  revenueIds: { key: 'companyRevenue', kind: 'array' },
  industryIds: { key: 'companyIndustry', kind: 'array' },
  subIndustries: { key: 'companySubIndustry', kind: 'array' },
  cities: { key: 'city', kind: 'array' },
  states: { key: 'state', kind: 'array' },
  countries: { key: 'country', kind: 'array' },
  hideOwnedContacts: { key: 'dontDisplayOwnedContact', kind: 'boolean' },
  exactTitleMatch: { key: 'titleExactMatch', kind: 'boolean' },
  exactCompanyMatch: { key: 'companyExactMatch', kind: 'boolean' },
  exactCompanyDomainMatch: { key: 'companyDomainExactMatch', kind: 'boolean' },
}

// The complete set of keys this module is ever allowed to put in a search or
// save body. `limit` and `scroll_id` are transport rather than criteria;
// `search_string` is the saved search's human-readable name.
export const ALLOWED_PROVIDER_KEYS = new Set([
  ...Object.values(SEARCH_MAP).map((m) => m.key),
  'limit', 'scroll_id', 'search_string',
])

// Include/exclude pairs that cannot name the same value. Rejected before the
// call with a 422 naming BOTH fields, because a search that contradicts itself
// silently returns nothing and looks like a provider fault.
const CONFLICT_PAIRS = [
  ['includeTitles', 'excludeTitles'],
  ['includeCompanies', 'excludeCompanies'],
  ['includeCompanyDomains', 'excludeCompanyDomains'],
]

// Keys Harry sent that the mapping table does not know. Reported to the client
// rather than dropped in silence, so a stale UI field is visible instead of
// quietly ineffective.
export function unknownFilterKeys(filters = {}) {
  return Object.keys(filters || {}).filter((k) => !SEARCH_MAP[k])
}

function toArray(value) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (item === undefined || item === null || item === '') continue
    const v = String(item).trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

// Harry's filter object → the documented provider body. Nothing outside
// SEARCH_MAP can survive this function, which is the whole point of it.
export function translateSearch(filters = {}, { limit = null, scrollId = null, searchString = null } = {}) {
  const body = {}
  for (const [field, spec] of Object.entries(SEARCH_MAP)) {
    const raw = filters?.[field]
    if (raw === undefined || raw === null || raw === '') continue
    if (spec.kind === 'boolean') {
      const value = typeof raw === 'boolean' ? raw : ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())
      if (value) body[spec.key] = true
      continue
    }
    const values = toArray(raw)
    if (!values.length) continue
    if (values.length > MAX_CRITERIA_ITEMS) {
      throw invalid(field, `${field} may contain at most ${MAX_CRITERIA_ITEMS} items`)
    }
    body[spec.key] = values
  }

  for (const [a, b] of CONFLICT_PAIRS) {
    const left = toArray(filters?.[a]).map((v) => v.toLowerCase())
    const right = new Set(toArray(filters?.[b]).map((v) => v.toLowerCase()))
    const clash = left.find((v) => right.has(v))
    if (clash) {
      throw invalid(`${a},${b}`, `"${clash}" cannot be in both ${a} and ${b}`)
    }
  }

  if (searchString !== null) body.search_string = searchString
  if (limit !== null) body.limit = limit
  if (scrollId) body.scroll_id = scrollId
  return body
}

// Which filters were set, by NAME. Telemetry records the names so Monitoring
// can learn which filters correlate with a workable audience size without ever
// storing what a user typed.
function filterNames(filters = {}) {
  return Object.keys(SEARCH_MAP).filter((f) => {
    const raw = filters?.[f]
    if (raw === undefined || raw === null || raw === '') return false
    if (SEARCH_MAP[f].kind === 'boolean') return Boolean(raw)
    return toArray(raw).length > 0
  })
}

// ---- fingerprints and cursors -------------------------------------------------

// FNV-1a over the canonical criteria. Deterministic, so the same filters in a
// different key order produce the same fingerprint and a genuine filter change
// produces a different one.
function fingerprint(body) {
  const criteria = { ...body }
  delete criteria.limit
  delete criteria.scroll_id
  const canonical = JSON.stringify(Object.keys(criteria).sort().map((k) => [k, criteria[k]]))
  let h = 2166136261
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

// The provider's `scroll_id` never leaves this process. The client is handed an
// opaque token bound to (workspace, filter fingerprint); presenting it against
// different filters is refused here and the search restarts from page one, so
// a page of results from one audience can never be appended to another.
const cursors = new Map()
let cursorSeq = 0
const CURSOR_TTL_MS = 30 * 60_000

function mintCursor(wsId, print, scrollId) {
  if (!scrollId) return null
  const token = `c${(++cursorSeq).toString(36)}${print}`
  cursors.set(token, { wsId, print, scrollId, at: Date.now() })
  return token
}

export function resolveCursor(token, wsId, print) {
  if (!token) return { ok: true, scrollId: null, restarted: false }
  const entry = cursors.get(String(token))
  const now = Date.now()
  for (const [k, v] of cursors) if (now - v.at > CURSOR_TTL_MS) cursors.delete(k)
  // Unknown, expired, another workspace's, or minted against other filters:
  // all four mean the same thing to the caller — start again.
  if (!entry || entry.wsId !== wsId || entry.print !== print || now - entry.at > CURSOR_TTL_MS) {
    return { ok: false, scrollId: null, restarted: true }
  }
  return { ok: true, scrollId: entry.scrollId, restarted: false }
}

// ---- filter vocabularies ------------------------------------------------------
//
// Thirteen lookups that feed the search form's pickers. They are reference data,
// not workspace data, so `prospect_filter_cache` is keyed (kind, query) with no
// workspace column — one workspace typing "eng" warms the list for the next.
// The cache is what makes a keystroke free: a repeat query is served from SQLite
// and the provider is not called a second time.

const FILTER_TTL_MS = 6 * 60 * 60_000

const VOCAB = {
  cities: { path: 'cities', shape: (r) => ({ id: r.id, name: r.city_name }) },
  countries: { path: 'countries', shape: (r) => ({ id: r.id, name: r.country_name }) },
  states: { path: 'states', shape: (r) => ({ id: r.id, name: r.state_name }) },
  departments: { path: 'departments', shape: (r) => ({ id: r.id, name: r.department_name }) },
  levels: { path: 'levels', shape: (r) => ({ id: r.id, name: r.level_name }) },
  'head-counts': { path: 'head-counts', shape: (r) => ({ id: r.id, label: r.head_count }) },
  revenue: { path: 'revenue', shape: (r) => ({ id: r.id, label: r.revenue }) },
  industries: {
    path: 'industries',
    shape: (r) => ({
      id: r.id,
      name: r.industry_name,
      // Sub-industries nested here carry a NAME ONLY — no id. The flat
      // sub-industries lookup does return ids. Both shapes are real; the
      // asymmetry is handled explicitly rather than assumed away.
      subIndustries: (r.sub_industry_list || []).map((s) => ({ name: s.sub_industry_name })),
    }),
  },
  'sub-industries': {
    path: 'sub-industries',
    shape: (r) => ({ id: r.id, name: r.sub_industry_name, industryId: r.industry_id ?? null }),
  },
  // The four below document neither an id nor a `pagination` object, so the
  // string itself is the key and `hasMore` is inferred from a full page. This
  // is written down so nobody later copies the pagination shape used by cities.
  companies: { path: 'company', shape: (r) => ({ name: r.company_name }), flat: true },
  domains: { path: 'domain', shape: (r) => ({ domain: r.domain_name }), flat: true },
  'job-titles': { path: 'job-title', shape: (r) => ({ title: r.job_title }), flat: true },
  keywords: { path: 'keywords', shape: (r) => ({ keyword: r.keyword }), flat: true },
}

function cacheKey(params) {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]))
}

function readCache(kind, query) {
  const row = db.prepare('SELECT payload, fetched_at FROM prospect_filter_cache WHERE kind = ? AND query = ?')
    .get(kind, query)
  if (!row) return null
  // SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC; make that explicit rather than
  // letting the host's timezone decide how old a cached list looks.
  const stamp = String(row.fetched_at).includes('T')
    ? String(row.fetched_at)
    : `${String(row.fetched_at).replace(' ', 'T')}Z`
  const age = Date.now() - new Date(stamp).getTime()
  if (Number.isFinite(age) && age > FILTER_TTL_MS) return null
  try { return { rows: JSON.parse(row.payload), fetchedAt: row.fetched_at } } catch { return null }
}

function writeCache(kind, query, rows) {
  db.prepare(
    `INSERT INTO prospect_filter_cache (kind, query, payload, fetched_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (kind, query) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).run(kind, query, JSON.stringify(rows))
}

function qs(params) {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    search.set(k, String(v))   // every documented parameter is a string
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

// One lookup: cache first, provider second, honest silence third.
export async function vocabulary(kind, params = {}) {
  const spec = VOCAB[kind]
  if (!spec) throw notFound('filter list')
  const key = cacheKey(params)
  const started = Date.now()

  const cached = readCache(kind, key)
  if (cached) {
    meter(`prospects.filters.${kind}`, Date.now() - started, true, 'cache=hit')
    return { rows: cached.rows, fetchedAt: cached.fetchedAt, cached: true, configured: true }
  }

  if (!upstream.configured()) {
    meter(`prospects.filters.${kind}`, Date.now() - started, true, 'unconfigured')
    return { rows: [], fetchedAt: null, cached: false, configured: false }
  }

  const res = await upstream.call(`${BASE}/${spec.path}${qs(params)}`, { method: 'GET' })
  const rows = Array.isArray(res?.data) ? res.data : []
  writeCache(kind, key, rows)
  meter(`prospects.filters.${kind}`, Date.now() - started, true, `cache=miss rows=${rows.length}`)
  return { rows, fetchedAt: nowIso(), cached: false, configured: true, pagination: res?.pagination || null }
}

// The shared response envelope for a vocabulary route. `pagination` is present
// for the lookups that document one; the flat lookups get `hasMore` derived
// from the page being full, which is the only end-of-list signal they have.
function vocabResponse(kind, out, { limit, offset }, extra = {}) {
  const spec = VOCAB[kind]
  const items = out.rows.map(spec.shape)
  const base = {
    items,
    cached: out.cached,
    fetchedAt: out.fetchedAt,
    ...extra,
  }
  if (spec.flat) base.hasMore = items.length === limit
  else base.pagination = out.pagination || { limit, offset, page: Math.floor(offset / Math.max(limit, 1)) + 1, count: items.length }
  if (!out.configured) return { ...notConfigured(), ...base }
  return { configured: true, ...base }
}

function vocabParams(query, { defaultLimit = MAX_VOCAB_LIMIT } = {}) {
  const limit = int(query, 'limit', { min: 1, max: MAX_VOCAB_LIMIT, fallback: defaultLimit })
  const offset = int(query, 'offset', { min: 0, fallback: 0 })
  const search = str(query, 'search', { max: MAX_SEARCH_TEXT })
  return { limit, offset, search }
}

// ---- normalisation helpers ----------------------------------------------------

// `https://WWW.Acme.com/pricing` and `acme.com` are the same account. Dedupe on
// the normalised form, because domain is the most reliable company key Harry has.
export function normaliseDomain(raw) {
  let v = String(raw || '').trim().toLowerCase()
  if (!v) return ''
  v = v.replace(/^[a-z]+:\/\//, '')
  v = v.split('/')[0].split('?')[0]
  v = v.replace(/^www\./, '')
  v = v.replace(/\.$/, '')
  return v
}

function stringList(body, field, { max = MAX_RECONCILE, required = false } = {}) {
  const raw = body?.[field]
  if (raw === undefined || raw === null) {
    if (required) throw invalid(field, `${field} is required`)
    return []
  }
  if (!Array.isArray(raw)) throw invalid(field, `${field} must be an array`)
  if (required && raw.length === 0) throw invalid(field, `${field} must contain at least one value`)
  if (raw.length > max) throw invalid(field, `${field} may contain at most ${max} items`)
  const out = []
  for (const item of raw) {
    const v = String(item ?? '').trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

// The documented id patterns differ between endpoints and the difference is
// load-bearing: review accepts `^[0-9]+$` while the renames use `^[1-9][0-9]*$`,
// which excludes zero. Two functions rather than one lenient one.
function idParam(params, field, { allowZero = false } = {}) {
  const raw = String(params?.[field] ?? '')
  const re = allowZero ? /^[0-9]+$/ : /^[1-9][0-9]*$/
  if (!re.test(raw)) {
    throw invalid(field, allowZero
      ? `${field} must be a whole number`
      : `${field} must be a positive whole number`)
  }
  return Number(raw)
}

function ownedSearch(id, wsId, { saved = null } = {}) {
  const row = db.prepare('SELECT * FROM prospect_searches WHERE id = ? AND workspace_id = ?').get(id, wsId)
  if (!row) throw notFound('saved search')
  if (saved !== null && Boolean(row.is_saved) !== saved) throw notFound('saved search')
  return row
}

function ownedFetch(id, wsId) {
  const row = db.prepare('SELECT * FROM prospect_fetches WHERE id = ? AND workspace_id = ?').get(id, wsId)
  if (!row) throw notFound('fetched list')
  return row
}

function parseJson(text, fallback) {
  try { return JSON.parse(text) } catch { return fallback }
}

function shapeSearch(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    filters: parseJson(row.filters, {}),
    totalCount: row.total_count,
    isSaved: Boolean(row.is_saved),
    createdBy: row.created_by,
    lastReviewedAt: row.last_reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // provider_filter_id is deliberately absent: the client works in Harry ids.
    linked: Boolean(row.provider_filter_id),
    ...extra,
  }
}

function shapeFetch(row, extra = {}) {
  return {
    id: row.id,
    searchId: row.search_id,
    name: row.name,
    requested: row.requested,
    fetched: row.fetched,
    creditsUsed: row.credits_used,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  }
}

function shapeContact(row, alreadyInLeads) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    title: row.title,
    company: { name: row.company, website: row.domain },
    email: row.email,
    verificationStatus: row.email_verification_status,
    linkedin: row.linkedin,
    location: row.location,
    alreadyInLeads,
    leadId: row.imported_lead_id || null,
  }
}

// ---- fetch outcomes -----------------------------------------------------------

// The branch the whole endpoint turns on. A 200 body carrying `success: false`
// is a credit or limit failure, not an empty result: it is stored as
// `insufficient_credits`, no contact is written, no lead is created, and the
// provider's own message is surfaced. Exported so the behaviour is testable
// without a socket, because `res.ok` would report this as a success.
export function classifyFetch(payload) {
  if (payload && payload.success === false) {
    return {
      ok: false,
      status: 'insufficient_credits',
      message: String(payload.message || 'The prospect provider refused the fetch'),
      contacts: [],
      metrics: {},
    }
  }
  const data = payload?.data || {}
  return {
    ok: true,
    status: 'done',
    message: String(payload?.message || 'Contacts fetched'),
    contacts: Array.isArray(data.list) ? data.list : [],
    metrics: data.metrics || {},
  }
}

// A contact only becomes a lead when it has a usable address. An empty email or
// an unusable status is skipped and counted, never written as a blank address.
function usableContact(c) {
  const email = String(c?.email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return null
  const status = String(c?.verificationStatus || c?.status || '').toLowerCase()
  if (status === 'invalid') return null
  return email
}

// Reuses the workspace's unique (user_id, email) constraint as the dedupe path:
// an existing lead is filled in, never duplicated, and an address a human
// already entered is not overwritten.
function upsertLead(wsId, contact, email, source) {
  const existing = db.prepare('SELECT * FROM leads WHERE user_id = ? AND email = ?').get(wsId, email)
  const verification = String(contact.verificationStatus || contact.status || '')
  if (existing) {
    db.prepare(
      `UPDATE leads SET
         first_name = CASE WHEN first_name = '' THEN ? ELSE first_name END,
         last_name  = CASE WHEN last_name  = '' THEN ? ELSE last_name  END,
         company    = CASE WHEN company    = '' THEN ? ELSE company    END,
         title      = CASE WHEN title      = '' THEN ? ELSE title      END,
         email_verification_status = ?,
         email_source = CASE WHEN email_source = '' THEN ? ELSE email_source END,
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      String(contact.firstName || ''), String(contact.lastName || ''),
      String(contact.company?.name || ''), String(contact.title || ''),
      verification, source, existing.id
    )
    return { id: existing.id, created: false }
  }
  const info = db.prepare(
    `INSERT INTO leads (user_id, email, first_name, last_name, company, title, email_verification_status, email_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(wsId, email, String(contact.firstName || ''), String(contact.lastName || ''),
    String(contact.company?.name || ''), String(contact.title || ''), verification, source)
  return { id: Number(info.lastInsertRowid), created: true }
}

// ---- caches with a lifetime ---------------------------------------------------

// Analytics figures are the provider's account metrics, cached per workspace and
// invalidated by a fetch, because a fetch is exactly what changes them. They are
// never written into Harry's own reporting tables: mixing a provider's counts
// with numbers Harry derives from real Gmail threads would corrupt both.
const analyticsCache = new Map()
const ANALYTICS_TTL_MS = 5 * 60_000
const replyCache = new Map()
const REPLY_TTL_MS = 60 * 60_000

function cacheGet(store, key, ttl) {
  const hit = store.get(key)
  if (!hit || Date.now() - hit.at > ttl) return null
  return hit.value
}

function cacheSet(store, key, value) {
  store.set(key, { value, at: Date.now() })
  return value
}

// Fetches are idempotent within a short window, keyed on everything that
// decides what is charged for. A double click or a retried request returns the
// first result rather than paying twice.
const fetchIdempotency = new Map()
const IDEMPOTENCY_TTL_MS = 60_000

// Reviews are coalesced per (workspace, search) so a double click issues one
// upstream PATCH rather than two.
const reviewsInFlight = new Map()

// ---- routes -------------------------------------------------------------------

export function register(api) {
  // ======================================================= filter vocabularies

  // GET /api/prospects/filters/cities — `country` requires `state`, which is
  // this lookup's own rule and not shared with the states lookup below.
  api.get('/prospects/filters/cities', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const state = str(req.query, 'state', { max: MAX_SEARCH_TEXT })
    const country = str(req.query, 'country', { max: MAX_SEARCH_TEXT })
    if (country && !state) {
      throw invalid('state', 'state is required when country is supplied')
    }
    const params = { search, state, country, limit, offset }
    const out = await vocabulary('cities', params)
    return vocabResponse('cities', out, { limit, offset })
  }))

  // GET /api/prospects/filters/countries — the most static list in the
  // category; the unfiltered page is cached for hours and prefix filtering is
  // served from it, which is the documented starts-with behaviour.
  api.get('/prospects/filters/countries', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    if (search) {
      const full = readCache('countries', cacheKey({ search: '', limit: MAX_VOCAB_LIMIT, offset: 0 }))
      if (full) {
        const needle = search.toLowerCase()
        const rows = full.rows.filter((r) => String(r.country_name || '').toLowerCase().startsWith(needle))
        return vocabResponse('countries', { rows, fetchedAt: full.fetchedAt, cached: true, configured: true },
          { limit, offset })
      }
    }
    const out = await vocabulary('countries', { search, limit, offset })
    return vocabResponse('countries', out, { limit, offset })
  }))

  // GET /api/prospects/filters/states — the two location lookups use different
  // vocabularies: countries returns ids, states filters on country NAMES.
  // Passing an id here silently returns nothing, so ids are resolved to names
  // in one place. A `country` string over 255 characters is split per country
  // and merged rather than truncated.
  api.get('/prospects/filters/states', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const countryIds = str(req.query, 'countryIds', { max: MAX_SEARCH_TEXT })
      .split(',').map((s) => s.trim()).filter(Boolean)

    const cachedCountries = readCache('countries', cacheKey({ search: '', limit: MAX_VOCAB_LIMIT, offset: 0 }))
    const byId = new Map((cachedCountries?.rows || []).map((r) => [String(r.id), r.country_name]))
    const names = []
    const unresolved = []
    for (const id of countryIds) {
      const name = byId.get(String(id))
      if (name) names.push(name)
      else unresolved.push(id)
    }

    // Split into chunks whose assembled comma-separated value fits the
    // documented 255-character cap, then merge the pages.
    const chunks = []
    let current = []
    for (const name of names) {
      const candidate = [...current, name].join(',')
      if (candidate.length > MAX_COUNTRY_PARAM && current.length) {
        chunks.push(current)
        current = [name]
      } else {
        current = [...current, name]
      }
    }
    if (current.length) chunks.push(current)
    if (!chunks.length) chunks.push([])

    const rows = []
    let cached = true
    for (const chunk of chunks) {
      const out = await vocabulary('states', { search, country: chunk.join(','), limit, offset })
      cached = cached && out.cached
      for (const row of out.rows) if (!rows.some((r) => r.id === row.id)) rows.push(row)
    }
    const configuredNow = upstream.configured()
    return vocabResponse('states',
      { rows, fetchedAt: nowIso(), cached, configured: configuredNow },
      { limit, offset },
      { unresolvedCountryIds: unresolved, splitRequests: chunks.length })
  }))

  // GET /api/prospects/filters/departments
  api.get('/prospects/filters/departments', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const out = await vocabulary('departments', { search, limit, offset })
    return vocabResponse('departments', out, { limit, offset })
  }))

  // GET /api/prospects/filters/levels — the seniority ladder is short, so the
  // route asks for the whole thing rather than making the client page a filter.
  api.get('/prospects/filters/levels', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const out = await vocabulary('levels', { search, limit, offset })
    return vocabResponse('levels', out, { limit, offset })
  }))

  // GET /api/prospects/filters/head-counts — bands are strings such as "11-50".
  // They are shown verbatim: parsing them into numbers and inventing a slider
  // would offer values the search does not accept.
  api.get('/prospects/filters/head-counts', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const out = await vocabulary('head-counts', { search, limit, offset })
    return vocabResponse('head-counts', out, { limit, offset })
  }))

  // GET /api/prospects/filters/revenue — documents no limit, offset or search,
  // so none is sent. `staleIds` lets a stored draft ask whether the bands it
  // holds are still active; they are flagged rather than dropped.
  api.get('/prospects/filters/revenue', handler(async (req) => {
    const wanted = str(req.query, 'staleIds', { max: MAX_SEARCH_TEXT })
      .split(',').map((s) => s.trim()).filter(Boolean)
    const out = await vocabulary('revenue', {})
    const live = new Set(out.rows.map((r) => String(r.id)))
    const stale = wanted.filter((id) => !live.has(String(id)))
    const items = out.rows.map(VOCAB.revenue.shape)
    const body = { items, stale, cached: out.cached, fetchedAt: out.fetchedAt }
    return out.configured ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // GET /api/prospects/filters/industries — always asks for the sub-industry
  // tree and pages until exhausted, so the client holds the taxonomy and the
  // provider is called once rather than per keystroke.
  api.get('/prospects/filters/industries', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const withSubIndustry = bool(req.query, 'withSubIndustry', true) ? 'true' : 'false'
    const out = await vocabulary('industries', { search, withSubIndustry, limit, offset })
    return vocabResponse('industries', out, { limit, offset }, { withSubIndustry })
  }))

  // GET /api/prospects/filters/sub-industries — this lookup DOES return an id
  // per row, unlike the nested list on industries. `parentMissing` marks a row
  // whose parent industry is not among the ones currently selected, so the UI
  // can offer to add it instead of leaving two filters contradicting each other.
  api.get('/prospects/filters/sub-industries', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const industryId = req.query.industryId ? idParam(req.query, 'industryId') : null
    const selected = new Set(str(req.query, 'industryIds', { max: MAX_SEARCH_TEXT })
      .split(',').map((s) => s.trim()).filter(Boolean))
    const out = await vocabulary('sub-industries', { search, industry_id: industryId ?? '', limit, offset })
    const items = out.rows.map(VOCAB['sub-industries'].shape).map((item) => ({
      ...item,
      parentMissing: selected.size > 0 && item.industryId !== null && !selected.has(String(item.industryId)),
    }))
    const body = {
      items,
      pagination: out.pagination || { limit, offset, page: Math.floor(offset / limit) + 1, count: items.length },
      cached: out.cached,
      fetchedAt: out.fetchedAt,
    }
    return out.configured ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // GET /api/prospects/filters/companies — no id and no pagination object are
  // documented, so the company name is the key and `hasMore` is derived from
  // the page being full. `alreadyInLeads` is computed here so the browser is
  // never sent the workspace's whole lead list to compare against.
  api.get('/prospects/filters/companies', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const out = await vocabulary('companies', { search, limit, offset })
    const owned = new Set(db.prepare('SELECT DISTINCT lower(trim(company)) AS c FROM leads WHERE user_id = ?')
      .all(req.wsId).map((r) => r.c).filter(Boolean))
    const items = out.rows.map(VOCAB.companies.shape)
      .map((i) => ({ ...i, alreadyInLeads: owned.has(String(i.name || '').trim().toLowerCase()) }))
    const body = { items, hasMore: items.length === limit, cached: out.cached, fetchedAt: out.fetchedAt }
    return out.configured ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // GET /api/prospects/filters/domains
  api.get('/prospects/filters/domains', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const out = await vocabulary('domains', { search, limit, offset })
    const items = out.rows.map(VOCAB.domains.shape)
    const body = { items, hasMore: items.length === limit, cached: out.cached, fetchedAt: out.fetchedAt }
    return out.configured ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // POST /api/prospects/filters/domains/reconcile — a pasted account list is
  // resolved server-side in a few calls rather than hundreds from the browser.
  // Unknown domains are reported back, never dropped, so nobody believes they
  // targeted an account the provider does not cover.
  api.post('/prospects/filters/domains/reconcile', handler(async (req) => {
    const raw = stringList(req.body, 'domains', { max: MAX_RECONCILE, required: true })
    const normalised = []
    for (const item of raw) {
      const d = normaliseDomain(item)
      if (d && !normalised.includes(d)) normalised.push(d)
    }

    const existing = normalised.filter((d) => db.prepare(
      `SELECT 1 FROM leads WHERE user_id = ?
        AND (lower(email) LIKE ? OR lower(trim(website)) LIKE ?)`
    ).get(req.wsId, `%@${d}`, `%${d}%`))

    const matched = []
    const unknown = []
    const remainder = normalised.filter((d) => !existing.includes(d))
    for (const d of remainder) {
      const out = await vocabulary('domains', { search: d, limit: MAX_VOCAB_LIMIT, offset: 0 })
      const hit = out.rows.some((r) => normaliseDomain(r.domain_name) === d)
      if (hit) matched.push(d)
      else unknown.push(d)
    }

    meter('prospects.domains.reconcile', 0, true,
      `size=${normalised.length} matched=${matched.length} unknown=${unknown.length} existing=${existing.length}`)
    const body = { matched, unknown, existing, normalised }
    return upstream.configured() ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // GET /api/prospects/filters/job-titles
  api.get('/prospects/filters/job-titles', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const out = await vocabulary('job-titles', { search, limit, offset })
    const items = out.rows.map(VOCAB['job-titles'].shape)
    const body = { items, hasMore: items.length === limit, cached: out.cached, fetchedAt: out.fetchedAt }
    return out.configured ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // POST /api/prospects/filters/job-titles/reconcile — maps a goal's ICP titles
  // onto the provider's vocabulary once, on the server, and writes an events row
  // so a user can later see why their search targeted the titles it did.
  api.post('/prospects/filters/job-titles/reconcile', handler(async (req) => {
    const titles = stringList(req.body, 'titles', { max: MAX_RECONCILE, required: true })
    const matched = []
    const unmatched = []
    for (const title of titles) {
      const out = await vocabulary('job-titles', { search: title, limit: MAX_VOCAB_LIMIT, offset: 0 })
      const hit = out.rows.find((r) => String(r.job_title || '').trim().toLowerCase() === title.toLowerCase())
      if (hit) matched.push(hit.job_title)
      else unmatched.push(title)
    }
    audit(req, {
      type: 'prospect_titles_reconciled',
      detail: `${req.user.email} reconciled ${titles.length} ICP title(s): ${matched.length} matched, ${unmatched.length} unmatched`,
    })
    const body = { matched, unmatched }
    return upstream.configured() ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // GET /api/prospects/filters/keywords
  api.get('/prospects/filters/keywords', handler(async (req) => {
    const { limit, offset, search } = vocabParams(req.query)
    const out = await vocabulary('keywords', { search, limit, offset })
    const items = out.rows.map(VOCAB.keywords.shape)
    const body = { items, hasMore: items.length === limit, cached: out.cached, fetchedAt: out.fetchedAt }
    return out.configured ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // POST /api/prospects/filters/keywords/reconcile — the signals here are the
  // goal's existing ICP signals, the same values the AI qualification cites in
  // its reasons; this is not a second, duplicate list.
  api.post('/prospects/filters/keywords/reconcile', handler(async (req) => {
    const signals = stringList(req.body, 'signals', { max: MAX_RECONCILE, required: true })
    const matched = []
    const unmatched = []
    for (const signal of signals) {
      const needle = signal.trim().toLowerCase()
      const out = await vocabulary('keywords', { search: needle, limit: MAX_VOCAB_LIMIT, offset: 0 })
      const hit = out.rows.find((r) => String(r.keyword || '').trim().toLowerCase() === needle)
      if (hit) matched.push(hit.keyword)
      else unmatched.push(signal)
    }
    audit(req, {
      type: 'prospect_keywords_reconciled',
      detail: `${req.user.email} reconciled ${signals.length} ICP signal(s): ${matched.length} matched, ${unmatched.length} unmatched`,
    })
    const body = { matched, unmatched }
    return upstream.configured() ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // ================================================================= searching

  // POST /api/prospects/search — the preview. Every ceiling is enforced before
  // anything leaves the server, the cursor is opaque, and NO events row is
  // written: a preview is not an action worth auditing. Telemetry records the
  // latency, the total and which filters were set BY NAME.
  api.post('/prospects/search', handler(async (req) => {
    const limit = int(req.body, 'limit', { required: true, min: 1, max: MAX_SEARCH_LIMIT })
    const filters = req.body?.filters && typeof req.body.filters === 'object' ? req.body.filters : {}
    const ignored = unknownFilterKeys(filters)
    const body = translateSearch(filters, { limit })
    const print = fingerprint(body)
    const started = Date.now()

    // A cursor minted against different filters is refused here rather than
    // sent on, so a page from one audience can never be appended to another.
    const cursorToken = str(req.body, 'cursor', { max: 200 })
    const resolved = resolveCursor(cursorToken, req.wsId, print)
    if (resolved.scrollId) body.scroll_id = resolved.scrollId

    // The preview is recorded as an unsaved row: it is what "recent searches"
    // reads when the provider is not connected, and what a save promotes.
    const searchId = tx(() => {
      const prior = db.prepare(
        'SELECT id FROM prospect_searches WHERE workspace_id = ? AND is_saved = 0 AND filters = ?'
      ).get(req.wsId, JSON.stringify(filters))
      if (prior) {
        db.prepare("UPDATE prospect_searches SET updated_at = datetime('now') WHERE id = ?").run(prior.id)
        return prior.id
      }
      const info = db.prepare(
        `INSERT INTO prospect_searches (workspace_id, name, filters, created_by, is_saved)
         VALUES (?, ?, ?, ?, 0)`
      ).run(req.wsId, summarise(filters), JSON.stringify(filters), req.user.email)
      // Unsaved previews are a rolling window, not a growing table.
      db.prepare(
        `DELETE FROM prospect_searches
          WHERE workspace_id = ? AND is_saved = 0
            AND id NOT IN (SELECT id FROM prospect_searches WHERE workspace_id = ? AND is_saved = 0
                            ORDER BY id DESC LIMIT 50)`
      ).run(req.wsId, req.wsId)
      return Number(info.lastInsertRowid)
    })

    const shared = {
      searchId,
      filters,
      ignoredFilters: ignored,
      cursorRestarted: resolved.restarted,
      appliedFilters: filterNames(filters),
    }

    if (!upstream.configured()) {
      meter('prospects.search', Date.now() - started, true, `unconfigured filters=${filterNames(filters).join('|')}`)
      return { ...notConfigured(), ...shared, items: [], totalCount: 0, cursor: null }
    }

    const res = await upstream.call(`${BASE}/search-contacts`, { method: 'POST', body })
    const data = res?.data || {}
    const list = Array.isArray(data.list) ? data.list : []
    const totalCount = Number(data.total_count || 0)

    if (data.filter_id) {
      db.prepare("UPDATE prospect_searches SET provider_filter_id = ?, total_count = ?, updated_at = datetime('now') WHERE id = ?")
        .run(String(data.filter_id), totalCount, searchId)
    }

    meter('prospects.search', Date.now() - started, true,
      `total=${totalCount} filters=${filterNames(filters).join('|')}`)

    return {
      configured: true,
      ...shared,
      totalCount,
      // `department` is an array while `level`, `industry` and the rest are
      // plain strings. The asymmetry is handled here rather than assumed away.
      items: list.map((c) => ({
        previewId: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        fullName: c.fullName,
        title: c.title,
        company: { name: c.company?.name || '', website: c.company?.website || '' },
        departments: Array.isArray(c.department) ? c.department : toArray(c.department),
        level: c.level ?? '',
        industry: c.industry ?? '',
        subIndustry: c.subIndustry ?? '',
        companyHeadCount: c.companyHeadCount ?? '',
        companyRevenue: c.companyRevenue ?? '',
        country: c.country ?? '',
        state: c.state ?? '',
        city: c.city ?? '',
        address: c.address ?? '',
        linkedin: c.linkedin ?? '',
        // A preview address is not a usable address — fetching is what buys
        // one — so it is labelled rather than presented as contactable.
        emailPreview: c.email ?? '',
        emailIsPreviewOnly: true,
        deliverability: typeof c.emailDeliverability === 'number' ? c.emailDeliverability : null,
      })),
      cursor: mintCursor(req.wsId, print, data.scroll_id),
    }
  }))

  // POST /api/prospects/contacts — `filterId` and `adaptIds` are an exclusive
  // choice; both or neither is a 422 naming both fields. When the provider is
  // not connected this serves the contacts Harry already stored for that fetch,
  // which is real data rather than a placeholder.
  api.post('/prospects/contacts', handler(async (req) => {
    const hasFilter = req.body?.filterId !== undefined && req.body?.filterId !== null && req.body?.filterId !== ''
    const hasIds = Array.isArray(req.body?.adaptIds) && req.body.adaptIds.length > 0
    if (hasFilter === hasIds) {
      throw invalid('filterId,adaptIds', 'Supply exactly one of filterId or adaptIds, never both')
    }
    const adaptIds = hasIds ? stringList(req.body, 'adaptIds', { max: MAX_ADAPT_IDS }) : []
    const limit = int(req.body, 'limit', { min: 1, max: MAX_CONTACT_LIMIT, fallback: 50 })
    const offset = int(req.body, 'offset', { min: 0, fallback: 0 })
    const search = str(req.body, 'search', { max: MAX_SEARCH_TEXT })
    const verificationStatus = oneOf(req.body, 'verificationStatus', VERIFICATION_STATUSES)
    const catchAllStatus = oneOf(req.body, 'catchAllStatus', CATCH_ALL_STATUSES)

    const searchRow = hasFilter ? ownedSearch(idParam(req.body, 'filterId', { allowZero: true }), req.wsId) : null

    // Harry's own rows: contacts already fetched for this search. Each is
    // checked against the workspace `leads` table so the table can mark rows
    // that are already imported and nobody pays for a contact they have.
    const clauses = ['pc.workspace_id = ?']
    const args = [req.wsId]
    if (searchRow) {
      clauses.push('pf.search_id = ?')
      args.push(searchRow.id)
    }
    if (adaptIds.length) {
      clauses.push(`pc.provider_contact_id IN (${adaptIds.map(() => '?').join(',')})`)
      args.push(...adaptIds)
    }
    if (search) {
      clauses.push("(lower(pc.first_name) LIKE ? OR lower(pc.last_name) LIKE ? OR lower(pc.first_name || ' ' || pc.last_name) LIKE ?)")
      const like = `%${search.toLowerCase()}%`
      args.push(like, like, like)
    }
    if (verificationStatus) {
      clauses.push('pc.email_verification_status = ?')
      args.push(verificationStatus)
    }
    if (catchAllStatus) {
      clauses.push('pc.email_verification_status = ?')
      args.push(catchAllStatus)
    }

    const where = clauses.join(' AND ')
    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM prospect_contacts pc
         LEFT JOIN prospect_fetches pf ON pf.id = pc.fetch_id
        WHERE ${where}`
    ).get(...args).n
    const rows = db.prepare(
      `SELECT pc.* FROM prospect_contacts pc
         LEFT JOIN prospect_fetches pf ON pf.id = pc.fetch_id
        WHERE ${where} ORDER BY pc.id LIMIT ? OFFSET ?`
    ).all(...args, limit, offset)

    const owned = new Set(db.prepare('SELECT lower(email) AS e FROM leads WHERE user_id = ?')
      .all(req.wsId).map((r) => r.e))

    const items = rows.map((r) => shapeContact(r, owned.has(String(r.email).toLowerCase())))
    const body = {
      items,
      totalCount: total,
      // `hasMore` is the provider's own signal where there is one; locally it
      // is the honest arithmetic on rows Harry holds.
      pagination: { limit, offset, total, hasMore: offset + items.length < total },
    }
    // Reading a list writes no events row.
    return upstream.configured() ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // ============================================================ saved searches

  // GET /api/prospects/searches/recent — literal path, registered before the
  // parameterised sibling routes so it cannot be captured by one.
  api.get('/prospects/searches/recent', handler(async (req) => {
    const { limit, offset } = page(req.query, { defaultLimit: 10, maxLimit: 200 })
    const total = db.prepare('SELECT COUNT(*) AS n FROM prospect_searches WHERE workspace_id = ?').get(req.wsId).n
    const rows = db.prepare(
      'SELECT * FROM prospect_searches WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?'
    ).all(req.wsId, limit, offset)
    const items = rows.map((r) => shapeSearch(r, { summary: r.name || summarise(parseJson(r.filters, {})) }))
    const body = { items, totalCount: total, pagination: { limit, offset, hasMore: offset + items.length < total } }
    // The count sits at `data.totalCount` upstream, NOT inside a `pagination`
    // object as it does on the filter lookups. Noted so nobody copies the
    // wrong shape into this route later.
    return upstream.configured() ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // GET /api/prospects/searches — saved searches, reconciled in both directions.
  // This route is also the id-resolution step used immediately after a save,
  // because the save response carries no id; that dual role lives here on
  // purpose rather than in a second near-identical route.
  api.get('/prospects/searches', handler(async (req) => {
    const { limit, offset } = page(req.query, { defaultLimit: 10, maxLimit: 200 })
    const total = db.prepare('SELECT COUNT(*) AS n FROM prospect_searches WHERE workspace_id = ? AND is_saved = 1')
      .get(req.wsId).n
    const rows = db.prepare(
      'SELECT * FROM prospect_searches WHERE workspace_id = ? AND is_saved = 1 ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(req.wsId, limit, offset)

    let providerIds = null
    if (upstream.configured()) {
      const res = await upstream.call(`${BASE}/search-filters/saved-searches${qs({ limit, offset })}`, { method: 'GET' })
      const saved = res?.data?.savedSearches || []
      providerIds = new Set(saved.map((s) => String(s.id)))
    }

    const items = rows.map((r) => shapeSearch(r, {
      // A local row the provider has never heard of is orphaned; it is shown
      // and flagged rather than hidden, because a user saved it deliberately.
      orphaned: providerIds ? !(r.provider_filter_id && providerIds.has(String(r.provider_filter_id))) : false,
    }))
    const body = { items, totalCount: total, pagination: { limit, offset, hasMore: offset + items.length < total } }
    return upstream.configured() ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // POST /api/prospects/searches — save. The provider's response carries no id,
  // so the saved-searches listing is the resolution step; if it never resolves
  // the local row is kept in a "not linked yet" state rather than discarded.
  api.post('/prospects/searches', handler(async (req) => {
    const name = str(req.body, 'name', { required: true, max: MAX_NAME })
    const filters = req.body?.filters && typeof req.body.filters === 'object' ? req.body.filters : {}
    const limit = int(req.body, 'limit', { min: 1, max: MAX_SAVE_LIMIT, fallback: 100 })
    const body = translateSearch(filters, { limit, searchString: name })

    const searchId = tx(() => {
      const info = db.prepare(
        `INSERT INTO prospect_searches (workspace_id, name, filters, created_by, is_saved)
         VALUES (?, ?, ?, ?, 1)`
      ).run(req.wsId, name, JSON.stringify(filters), req.user.email)
      return Number(info.lastInsertRowid)
    })

    let linked = false
    if (upstream.configured()) {
      await upstream.call(`${BASE}/search-filters/save-search`, { method: 'POST', body })
      // Resolution: the only documented way to learn the new search's id.
      const res = await upstream.call(`${BASE}/search-filters/saved-searches${qs({ limit: 50, offset: 0 })}`, { method: 'GET' })
      const match = (res?.data?.savedSearches || []).find((s) => String(s.search_string) === name)
      if (match) {
        db.prepare("UPDATE prospect_searches SET provider_filter_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(String(match.id), searchId)
        linked = true
      }
    }

    // A save IS an action worth auditing, unlike a preview.
    audit(req, {
      type: 'prospect_search_saved',
      detail: `${req.user.email} saved prospect search "${name}" (${filterNames(filters).join(', ') || 'no filters'})`,
    })
    const row = db.prepare('SELECT * FROM prospect_searches WHERE id = ?').get(searchId)
    const out = { ...shapeSearch(row), linked, message: 'Search saved successfully' }
    return upstream.configured() ? { configured: true, ...out } : { ...notConfigured(), ...out }
  }))

  // POST /api/prospects/searches/:filterId/fetch — the credit-spending step.
  //
  // The `filterId` in the path is Harry's own `prospect_searches.id`, scoped to
  // the workspace: another workspace's id is a 404 here, so a provider filter id
  // cannot be borrowed across accounts. The provider's id never appears in a URL
  // the browser composes.
  api.post('/prospects/searches/:filterId/fetch', handler(async (req) => {
    const searchRow = ownedSearch(idParam(req.params, 'filterId'), req.wsId)
    const mode = oneOf(req.body, 'mode', ['count', 'selected'], { required: true })
    const hasCount = req.body?.count !== undefined && req.body?.count !== null && req.body?.count !== ''
    const hasIds = Array.isArray(req.body?.adaptIds) && req.body.adaptIds.length > 0
    if (hasCount === hasIds) {
      throw invalid('count,adaptIds', 'Supply exactly one of count or adaptIds, never both')
    }
    if (mode === 'count' && !hasCount) throw invalid('count', 'count is required when mode is count')
    if (mode === 'selected' && !hasIds) throw invalid('adaptIds', 'adaptIds must contain at least one contact')

    const count = hasCount ? int(req.body, 'count', { min: 1, max: MAX_FETCH_COUNT }) : 0
    const adaptIds = hasIds ? stringList(req.body, 'adaptIds', { max: MAX_FETCH_ADAPT_IDS }) : []
    const visualLimit = int(req.body, 'visualLimit', { min: 1, max: MAX_VISUAL_LIMIT, fallback: 10 })
    const visualOffset = int(req.body, 'visualOffset', { min: 0, fallback: 0 })

    // The provider's caps are the guarantee, not the client's. A count over
    // `maxSingleFetchLimit`, or over what is left of today's allowance, is
    // refused here with the cap stated rather than paid for and rejected.
    const snapshot = cacheGet(analyticsCache, `${req.wsId}:`, ANALYTICS_TTL_MS)
    if (hasCount && snapshot?.maxSingleFetchLimit && count > snapshot.maxSingleFetchLimit) {
      throw invalid('count', `count may be at most ${snapshot.maxSingleFetchLimit} in a single fetch`)
    }
    if (hasCount && snapshot?.maxDailyFetchLimit) {
      const remaining = Math.max(0, snapshot.maxDailyFetchLimit - (snapshot.foundToday || 0))
      if (count > remaining) {
        throw invalid('count', `count may be at most ${remaining} — today's remaining fetch allowance`)
      }
    }

    // Idempotency: the same request inside the window returns the first result
    // rather than charging again, which is what makes a double click safe.
    const key = `${req.wsId}:${searchRow.id}:${mode}:${count}:${adaptIds.join(',')}`
    const prior = fetchIdempotency.get(key)
    if (prior && Date.now() - prior.at < IDEMPOTENCY_TTL_MS) {
      return { ...prior.value, idempotent: true }
    }

    const requested = hasCount ? count : adaptIds.length
    const fetchId = tx(() => Number(db.prepare(
      `INSERT INTO prospect_fetches (workspace_id, search_id, provider_filter_id, name, requested, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(req.wsId, searchRow.id, searchRow.provider_filter_id, searchRow.name || 'Fetched list', requested)
      .lastInsertRowid))

    if (!upstream.configured()) {
      const out = {
        ...notConfigured(),
        success: false,
        fetchId,
        searchId: searchRow.id,
        status: 'pending',
        requested,
        fetched: 0,
        leadsCreated: 0,
        leadsUpdated: 0,
        skipped: 0,
        visualLimit,
        visualOffset,
      }
      fetchIdempotency.set(key, { at: Date.now(), value: out })
      return out
    }

    const started = Date.now()
    const payload = await upstream.call(`${BASE}/fetch-contacts`, {
      method: 'POST',
      body: {
        filter_id: searchRow.provider_filter_id,
        ...(hasCount ? { limit: count } : { id: adaptIds }),
        visual_limit: visualLimit,
        visual_offset: visualOffset,
      },
    })

    // *** The branch this endpoint turns on. ***
    const outcome = classifyFetch(payload)
    if (!outcome.ok) {
      tx(() => {
        db.prepare("UPDATE prospect_fetches SET status = 'insufficient_credits', error = ?, updated_at = datetime('now') WHERE id = ?")
          .run(outcome.message, fetchId)
      })
      analyticsCache.delete(`${req.wsId}:`)
      meter('prospects.fetch', Date.now() - started, false, `success=false requested=${requested}`)
      audit(req, {
        type: 'prospect_fetch_refused',
        detail: `${req.user.email} requested ${requested} contact(s) from "${searchRow.name}" — refused: ${outcome.message}`,
      })
      // 200, not an error status: this is a documented outcome of a successful
      // call, and a retry of it would be wrong. Never retried.
      const out = {
        configured: true,
        success: false,
        status: 'insufficient_credits',
        message: outcome.message,
        fetchId,
        searchId: searchRow.id,
        requested,
        fetched: 0,
        leadsCreated: 0,
        leadsUpdated: 0,
        skipped: 0,
      }
      fetchIdempotency.set(key, { at: Date.now(), value: out })
      return out
    }

    const result = tx(() => {
      let created = 0
      let updated = 0
      let skipped = 0
      for (const contact of outcome.contacts) {
        const email = usableContact(contact)
        let leadId = null
        if (email) {
          const lead = upsertLead(req.wsId, contact, email, 'prospect_fetch')
          leadId = lead.id
          if (lead.created) created++
          else updated++
        } else {
          skipped++
        }
        db.prepare(
          `INSERT INTO prospect_contacts
             (workspace_id, fetch_id, provider_contact_id, first_name, last_name, email,
              email_verification_status, title, company, domain, linkedin, location, raw, imported_lead_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(req.wsId, fetchId, String(contact.id ?? ''), String(contact.firstName || ''),
          String(contact.lastName || ''), email || '', String(contact.verificationStatus || contact.status || ''),
          String(contact.title || ''), String(contact.company?.name || ''), String(contact.company?.website || ''),
          String(contact.linkedin || ''), String(contact.location || ''), JSON.stringify(contact), leadId)
      }
      db.prepare(
        `UPDATE prospect_fetches SET status = 'done', fetched = ?, credits_used = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).run(outcome.contacts.length, Number(outcome.metrics?.totalEmails || 0), fetchId)
      return { created, updated, skipped }
    })

    analyticsCache.delete(`${req.wsId}:`)   // a fetch changes the credit balance
    meter('prospects.fetch', Date.now() - started, true,
      `requested=${requested} fetched=${outcome.contacts.length} created=${result.created}`)
    audit(req, {
      type: 'prospect_fetch',
      detail: `${req.user.email} fetched ${outcome.contacts.length} of ${requested} requested from "${searchRow.name}" — ${result.created} new lead(s), ${result.updated} updated, ${result.skipped} skipped`,
    })

    const out = {
      configured: true,
      success: true,
      status: 'done',
      fetchId,
      searchId: searchRow.id,
      requested,
      fetched: outcome.contacts.length,
      leadsCreated: result.created,
      leadsUpdated: result.updated,
      skipped: result.skipped,
      metrics: outcome.metrics,
      visualLimit,
      visualOffset,
    }
    fetchIdempotency.set(key, { at: Date.now(), value: out })
    return out
  }))

  // PUT /api/prospects/searches/:id/name — rename only.
  //
  // The outgoing body carries ONLY `search_string`. This endpoint cannot change
  // a saved search's criteria despite sharing a path with save-search, so
  // sending a filter field would be silently ignored and would mislead the next
  // reader of this code. Its error map has NO permission branch: unlike the
  // fetched-list rename, no 403 is documented here, and the two maps are
  // deliberately not shared.
  api.put('/prospects/searches/:id/name', handler(async (req) => {
    const id = idParam(req.params, 'id')
    const name = str(req.body, 'name', { required: true, max: MAX_NAME })
    const row = ownedSearch(id, req.wsId, { saved: true })
    const previous = row.name

    if (upstream.configured() && row.provider_filter_id) {
      await upstream.call(`${BASE}/search-filters/save-search/${row.provider_filter_id}`, {
        method: 'PUT',
        body: renameBody(name),
      })
    }
    tx(() => {
      db.prepare("UPDATE prospect_searches SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id)
    })
    audit(req, {
      type: 'prospect_search_renamed',
      detail: `${req.user.email} renamed saved search "${previous}" to "${name}"`,
    })
    const out = { id, name, previousName: previous, message: 'Saved search updated successfully' }
    return upstream.configured() ? { configured: true, ...out } : { ...notConfigured(), ...out }
  }))

  // PATCH /api/prospects/searches/:filterId/review — no request body upstream.
  // `filterId` is validated against `^[0-9]+$` (this endpoint's own pattern,
  // which unlike the renames admits zero) before anything is called.
  api.patch('/prospects/searches/:filterId/review', handler(async (req) => {
    const id = idParam(req.params, 'filterId', { allowZero: true })
    const row = ownedSearch(id, req.wsId)

    // A double click issues one upstream PATCH, not two.
    const key = `${req.wsId}:${id}`
    if (reviewsInFlight.has(key)) return reviewsInFlight.get(key)

    const run = (async () => {
      const previousReview = parseJson(row.last_review, {})
      let review = { recordsUpdated: 0, fetchDetails: {} }

      if (upstream.configured() && row.provider_filter_id) {
        const res = await upstream.call(`${BASE}/review-contacts/${row.provider_filter_id}`, { method: 'PATCH' })
        const data = res?.data || {}
        review = { recordsUpdated: Number(data.records_updated || 0), fetchDetails: data.fetch_details || {} }
      }

      // Reconciliation onto existing leads updates the STATUS only. The docs do
      // not say the address itself can change, so the email field is left alone
      // — inventing an address change would be a guess presented as fact.
      let flagged = 0
      tx(() => {
        const contacts = db.prepare(
          `SELECT pc.* FROM prospect_contacts pc
             JOIN prospect_fetches pf ON pf.id = pc.fetch_id
            WHERE pc.workspace_id = ? AND pf.search_id = ? AND pc.imported_lead_id IS NOT NULL`
        ).all(req.wsId, row.id)
        for (const c of contacts) {
          const status = c.email_verification_status || ''
          if (!status) continue
          db.prepare('UPDATE leads SET email_verification_status = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?')
            .run(status, c.imported_lead_id, req.wsId)
          if (status === 'invalid' || String(status).includes('bounced')) flagged++
        }
        db.prepare(
          `UPDATE prospect_searches
              SET last_reviewed_at = datetime('now'), last_review = ?, updated_at = datetime('now')
            WHERE id = ?`
        ).run(JSON.stringify(review), row.id)
      })

      audit(req, {
        type: 'prospect_search_reviewed',
        detail: `${req.user.email} reviewed "${row.name}" — ${review.recordsUpdated} record(s) updated, ${flagged} lead(s) flagged`,
      })
      const body = {
        searchId: row.id,
        recordsUpdated: review.recordsUpdated,
        fetchDetails: review.fetchDetails,
        // The previous figures survive so the UI can show a delta rather than
        // an absolute that means nothing on its own.
        previousReview,
        leadsFlagged: flagged,
        reviewedAt: nowIso(),
      }
      return upstream.configured() ? { configured: true, ...body } : { ...notConfigured(), ...body }
    })()

    reviewsInFlight.set(key, run)
    try { return await run } finally { reviewsInFlight.delete(key) }
  }))

  // ================================================================== fetches

  // GET /api/prospects/fetches — the history. Harry's rows are the spine;
  // provider rows merge onto them where one exists. The upstream count sits at
  // `data.totalCount`, NOT in a `pagination` object.
  api.get('/prospects/fetches', handler(async (req) => {
    const { limit, offset } = page(req.query, { defaultLimit: 10, maxLimit: 200 })
    const total = db.prepare('SELECT COUNT(*) AS n FROM prospect_fetches WHERE workspace_id = ?').get(req.wsId).n
    const rows = db.prepare(
      'SELECT * FROM prospect_fetches WHERE workspace_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(req.wsId, limit, offset)

    let providerRows = new Map()
    if (upstream.configured()) {
      const res = await upstream.call(`${BASE}/search-filters/fetched-searches${qs({ limit, offset })}`, { method: 'GET' })
      providerRows = new Map((res?.data?.fetchedLeads || []).map((r) => [String(r.id), r]))
    }

    const items = rows.map((r) => {
      const leads = db.prepare(
        'SELECT COUNT(*) AS n FROM prospect_contacts WHERE fetch_id = ? AND imported_lead_id IS NOT NULL'
      ).get(r.id).n
      const provider = r.provider_filter_id ? providerRows.get(String(r.provider_filter_id)) : null
      return shapeFetch(r, {
        leadsCreated: leads,
        fetchDetails: provider?.fetch_details || null,
        linked: Boolean(provider),
      })
    })
    const body = { items, totalCount: total, pagination: { limit, offset, hasMore: offset + items.length < total } }
    return upstream.configured() ? { configured: true, ...body } : { ...notConfigured(), ...body }
  }))

  // PUT /api/prospects/fetches/:id/name — this endpoint DOES document a 403, so
  // permission and not-found stay distinct here. The saved-search rename above
  // documents no 403 and its map is deliberately separate; merging the two
  // would invent a message one of the APIs never sends.
  api.put('/prospects/fetches/:id/name', handler(async (req) => {
    const id = idParam(req.params, 'id')
    const name = str(req.body, 'name', { required: true, max: MAX_NAME })
    const row = ownedFetch(id, req.wsId)
    if (req.wsRole === 'viewer') throw forbidden('You do not have permission to rename this list')
    const previous = row.name

    if (upstream.configured() && row.provider_filter_id) {
      await upstream.call(`${BASE}/search-filters/fetched-searches/${row.id}`, {
        method: 'PUT',
        body: renameBody(name),
      })
    }
    tx(() => {
      db.prepare("UPDATE prospect_fetches SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id)
    })
    audit(req, {
      type: 'prospect_fetch_renamed',
      detail: `${req.user.email} renamed fetched list "${previous}" to "${name}"`,
    })
    const out = { id, name, previousName: previous, message: 'Fetched lead updated successfully' }
    return upstream.configured() ? { configured: true, ...out } : { ...notConfigured(), ...out }
  }))

  // ================================================================ analytics

  // GET /api/prospects/analytics — the figures the fetch dialog needs before it
  // can honestly offer a fetch. `percentageChangeText` is passed through
  // untouched: the provider's month boundaries are undocumented, so recomputing
  // it would be a guess. Nothing here is written into Harry's reporting tables.
  api.get('/prospects/analytics', handler(async (req) => {
    const filterId = req.query.filterId ? idParam(req.query, 'filterId', { allowZero: true }) : null
    if (filterId !== null) ownedSearch(filterId, req.wsId)
    const key = `${req.wsId}:${filterId ?? ''}`
    const cached = cacheGet(analyticsCache, key, ANALYTICS_TTL_MS)
    if (cached) return { configured: true, ...cached, cached: true }

    const credits = db.prepare('SELECT * FROM prospect_credits WHERE workspace_id = ?').get(req.wsId)
    if (!upstream.configured()) {
      return {
        ...notConfigured(),
        leadsFound: null,
        emailsFetched: null,
        credits: credits
          ? { available: credits.email_credits, leadCredits: credits.lead_credits, updatedAt: credits.updated_at }
          : null,
        foundToday: null,
        maxDailyFetchLimit: null,
        maxSingleFetchLimit: null,
        filterData: null,
        fetchedAt: nowIso(),
        cached: false,
      }
    }

    const res = await upstream.call(`${BASE}/search-analytics${qs(filterId !== null ? { filter_id: filterId } : {})}`,
      { method: 'GET' })
    const data = res?.data || {}
    const value = {
      leadsFound: data.leadsFound || null,
      emailsFetched: data.emailsFetched || null,
      credits: data.availableCredits || null,
      foundToday: Number(data.leadsFoundToday || 0),
      maxDailyFetchLimit: Number(data.maxDailyFetchLimit || 0) || null,
      maxSingleFetchLimit: Number(data.maxSingleFetchLimit || 0) || null,
      // Meaningless unless a filterId was supplied; the client is told which.
      filterData: filterId !== null ? (data.filterData || null) : null,
      filterId,
      fetchedAt: nowIso(),
    }
    if (value.credits) {
      tx(() => {
        db.prepare(
          `INSERT INTO prospect_credits (workspace_id, email_credits, lead_credits, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT (workspace_id) DO UPDATE SET
             email_credits = excluded.email_credits,
             lead_credits = excluded.lead_credits,
             updated_at = excluded.updated_at`
        ).run(req.wsId, Number(value.credits.available || 0), Number(value.credits.total || 0))
      })
    }
    cacheSet(analyticsCache, key, value)
    meter('prospects.analytics', 0, true, `credits=${value.credits?.available ?? 'unknown'}`)
    return { configured: true, ...value, cached: false }
  }))

  // GET /api/prospects/reply-analytics — parameterless, because none exist
  // upstream. Cached for an hour and never allowed to throw into Reports:
  // a failing provider leaves the rest of the page fully rendered, exactly as
  // Reports already tolerates a missing AI key.
  api.get('/prospects/reply-analytics', handler(async (req) => {
    const cached = cacheGet(replyCache, String(req.wsId), REPLY_TTL_MS)
    if (cached) return { configured: true, ...cached, cached: true }
    if (!upstream.configured()) {
      return {
        ...notConfigured(),
        currentMonth: null, previousMonth: null,
        percentageChange: null, trend: null,
        fetchedAt: nowIso(), cached: false,
      }
    }
    try {
      const res = await upstream.call(`${BASE}/reply-analytics`, { method: 'GET' })
      const data = res?.data || {}
      const value = {
        currentMonth: data.currentMonth || null,
        previousMonth: data.previousMonth || null,
        // Preformatted, with its own sign and percent symbol. Shown verbatim.
        percentageChange: data.percentage_change ?? null,
        trend: data.trend ?? null,
        fetchedAt: nowIso(),
      }
      cacheSet(replyCache, String(req.wsId), value)
      return { configured: true, ...value, cached: false }
    } catch (err) {
      meter('prospects.reply_analytics', 0, false, String(err?.status || err?.message || 'failed'))
      return {
        configured: true, available: false,
        message: 'Prospect reply figures are unavailable right now',
        currentMonth: null, previousMonth: null, percentageChange: null, trend: null,
        fetchedAt: nowIso(), cached: false,
      }
    }
  }))

  // ============================================================== find emails

  // POST /api/leads/find-emails — registered here, and before any module's
  // `/leads/:id`, so the literal segment cannot be swallowed by a parameter.
  //
  // Leads missing a first name, last name or company domain are ineligible and
  // are reported with the field that is missing rather than sent and rejected.
  // Everything eligible is processed in batches of at most ten, which is the
  // documented per-request ceiling.
  api.post('/leads/find-emails', handler(async (req) => {
    const raw = req.body?.leadIds
    if (!Array.isArray(raw)) throw invalid('leadIds', 'leadIds must be an array')
    if (raw.length === 0) throw invalid('leadIds', 'leadIds must contain at least one lead')
    if (raw.length > MAX_FIND_EMAIL_LEADS) {
      throw invalid('leadIds', `leadIds may contain at most ${MAX_FIND_EMAIL_LEADS} leads`)
    }

    const eligible = []
    const ineligible = []
    for (const item of raw) {
      const id = Number(item)
      if (!Number.isInteger(id) || id <= 0) throw invalid('leadIds', `leadIds contains an invalid id: ${item}`)
      const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(id, req.wsId)
      if (!lead) throw notFound('lead')
      const domain = normaliseDomain(lead.website || String(lead.email || '').split('@')[1] || '')
      const missing = []
      if (!lead.first_name) missing.push('firstName')
      if (!lead.last_name) missing.push('lastName')
      if (!domain) missing.push('companyDomain')
      if (missing.length) ineligible.push({ leadId: id, missing })
      else eligible.push({ leadId: id, firstName: lead.first_name, lastName: lead.last_name, companyDomain: domain })
    }

    const batches = []
    for (let i = 0; i < eligible.length; i += FIND_EMAIL_BATCH) {
      batches.push(eligible.slice(i, i + FIND_EMAIL_BATCH))
    }

    const jobId = tx(() => Number(db.prepare(
      `INSERT INTO email_find_jobs (workspace_id, status, requested, payload)
       VALUES (?, 'pending', ?, ?)`
    ).run(req.wsId, eligible.length, JSON.stringify({ eligible, ineligible, batches: batches.length }))
      .lastInsertRowid))

    if (!upstream.configured()) {
      // The job exists and is resumable; nothing is invented in the meantime.
      return {
        ...notConfigured(),
        jobId, status: 'pending',
        requested: eligible.length, batches: batches.length, ineligible,
      }
    }

    tx(() => db.prepare("UPDATE email_find_jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(jobId))
    const results = []
    let found = 0
    try {
      for (const batch of batches) {
        const res = await upstream.call(`${BASE}/search-contacts/find-emails`, {
          method: 'POST',
          body: { contacts: batch.map(({ firstName, lastName, companyDomain }) => ({ firstName, lastName, companyDomain })) },
        })
        const rows = Array.isArray(res?.data) ? res.data : []
        rows.forEach((row, i) => {
          const lead = batch[i]
          if (!lead) return
          const applied = applyFoundEmail(req.wsId, lead.leadId, row)
          if (applied.written) found++
          results.push({ leadId: lead.leadId, ...applied })
        })
      }
    } catch (err) {
      // 402 halts the job and is never retried: more attempts cannot conjure
      // credit. The provider adapter has already decided not to retry it.
      const message = err?.status === 402
        ? 'You are out of email-finding credits'
        : `Email finding failed (status ${err?.status || 'unknown'})`
      tx(() => db.prepare("UPDATE email_find_jobs SET status = 'failed', error = ?, found = ?, result = ?, updated_at = datetime('now') WHERE id = ?")
        .run(message, found, JSON.stringify(results), jobId))
      meter('prospects.find_emails', 0, false, message)
      return { configured: true, jobId, status: 'failed', error: message, requested: eligible.length, found, ineligible, results }
    }

    tx(() => db.prepare("UPDATE email_find_jobs SET status = 'done', found = ?, result = ?, updated_at = datetime('now') WHERE id = ?")
      .run(found, JSON.stringify(results), jobId))
    audit(req, {
      type: 'lead_emails_found',
      detail: `${req.user.email} looked up ${eligible.length} lead(s) — ${found} address(es) found, ${ineligible.length} ineligible`,
    })
    meter('prospects.find_emails', 0, true, `requested=${eligible.length} found=${found} batches=${batches.length}`)
    return { configured: true, jobId, status: 'done', requested: eligible.length, found, ineligible, results }
  }))

  // GET /api/leads/find-emails/:jobId — so a browser refresh does not lose a
  // long job's progress.
  api.get('/leads/find-emails/:jobId', handler(async (req) => {
    const id = idParam(req.params, 'jobId')
    const row = db.prepare('SELECT * FROM email_find_jobs WHERE id = ? AND workspace_id = ?').get(id, req.wsId)
    if (!row) throw notFound('email lookup job')
    const payload = parseJson(row.payload, {})
    return {
      jobId: row.id,
      status: row.status,
      requested: row.requested,
      found: row.found,
      batches: payload.batches ?? 0,
      ineligible: payload.ineligible ?? [],
      results: parseJson(row.result, []),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }))
}

// ---- exported pieces the routes share -----------------------------------------

// The rename body, in one place, because BOTH rename endpoints document exactly
// one field and sending anything else would be silently ignored upstream while
// implying to the next reader that filters can be edited here. They cannot.
export function renameBody(name) {
  return { search_string: name }
}

// `status: "Not Found"` arrives with an empty `email_id`. Writing that onto a
// lead would replace a real address with nothing, so the branch is explicit and
// the write is a fill-in: an address a human already entered is never
// overwritten, only reported as differing.
export function applyFoundEmail(wsId, leadId, row) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(leadId, wsId)
  if (!lead) return { written: false, reason: 'lead_missing' }
  const status = String(row?.status || '')
  const email = String(row?.email_id || '').trim().toLowerCase()
  if (status !== 'Found' || !email) {
    return { written: false, status: status || 'Not Found', email: null, reason: 'not_found' }
  }
  if (lead.email && lead.email.toLowerCase() !== email) {
    // A difference is surfaced, not applied. The verification status is still
    // recorded, because it describes the address the provider checked.
    return { written: false, status, email, reason: 'differs_from_existing', existing: lead.email }
  }
  tx(() => {
    db.prepare(
      `UPDATE leads SET email = ?, email_verification_status = ?, email_source = 'find_emails',
              updated_at = datetime('now') WHERE id = ? AND user_id = ?`
    ).run(email, String(row?.verification_status || ''), leadId, wsId)
  })
  return { written: true, status, email, verificationStatus: row?.verification_status ?? null }
}

// A readable one-line summary of a filter set, used as a search's default name.
// Names only — a summary that quoted values would put a user's paste in an
// events row.
function summarise(filters = {}) {
  const names = filterNames(filters)
  if (!names.length) return 'All contacts'
  return names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4} more` : '')
}
