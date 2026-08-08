// Smart delivery — the "Inbox placement and deliverability assurance" category
// of the SmartLead-parity backlog (Docs/smart-delivery/*.md, 28 endpoints).
//
// Four rules run through every route here and are worth stating once rather
// than re-deriving at each handler:
//
//  1. **Local rows are authoritative.** The list, the detail and every report
//     section are served from Harry's own tables. A page load never waits on an
//     upstream round trip: reconciliation is fired on a throttle *after* the
//     response is composed, and a report that has never been fetched is
//     reported as `stale` with a `fetchedAt` of null rather than as zeroes.
//  2. **No provider is a supported state, not an error.** With
//     DELIVERABILITY_API_URL / DELIVERABILITY_API_KEY unset, every route below
//     still exists, still validates, still reads and writes Harry's rows, and
//     answers `configured: false` naming the missing variables. Nothing is
//     faked; nothing 500s.
//  3. **One count, one source.** Blocklist figures on the list, on the batched
//     summary and in the detail view are all derived from `deliverability_blacklist`
//     by the same helper. The `blocklist_count` column on `deliverability_tests`
//     is deliberately never read — a cached integer is exactly how a summary and
//     a detail come to disagree.
//  4. **Every request contract lives in UPSTREAM, below.** Six of these
//     endpoints publish their request body as an empty object and three
//     contradict themselves on HTTP method across their own cURL, Python and
//     JavaScript samples (Docs/README.md, "Read this before scoping anything").
//     Correcting any of them is a one-line change to that table and nothing else.

import { db } from '../db.js'
import {
  HttpError, handler, invalid, notFound,
  str, int, bool, oneOf, idList, page, paged, email as emailField,
  owned, tx, audit, meter, nowIso,
} from './http.js'
import { parsePlaybook } from '../playbook.js'
import { configured, call, unconfigured, shouldReconcile } from './providers.js'
// Creating a test and running one are the same feature; they are in two files
// only because the tick loop lives outside the parity modules. The sender-row
// shape belongs to the runner, so both create routes build run 1 with exactly
// the code that later builds run 7.
import { createRunSenders, runStatusFor, SEED_STATUS } from '../deliverability-runs.js'

// ---------------------------------------------------------------------------
// THE REQUEST-CONTRACT MAPPING TABLE
// ---------------------------------------------------------------------------
//
// One entry per documented upstream endpoint. `verified` says whether the
// method-and-body pair is actually attested by the source documentation, or
// whether it is the best available reading of a page that contradicts itself.
// Nothing outside this table constructs an upstream path, method or body.
//
//   method     — what the adapter sends.
//   altMethod  — retried exactly once on a 405, for the pages whose own samples
//                disagree. `null` where the method is not in doubt.
//   body       — a function of the call's context, or null for a bodiless verb.
//   verified   — false wherever the published contract is an empty object or a
//                self-contradiction. Nine of the twenty-eight are false.
//   note       — what specifically is unknown, so nobody has to re-read the docs.
//
// UNVERIFIED BODY (6): listTests, createAutomated, createManual, deleteTests,
//                      geoReport, providerReport — each publishes `{}`.
// UNVERIFIED METHOD (3): stopTest (PUT vs POST), rdnsReport (GET vs POST),
//                        spamFilterReport (GET vs POST).
//
export const UPSTREAM = {
  // ---- tests -------------------------------------------------------------
  listTests: {
    method: 'POST',
    altMethod: null,
    path: () => '/api/v1/spam-test/report',
    body: () => ({}),
    verified: false,
    note: 'Body published as {} while the prose promises date/type/status filters. Harry filters and pages locally; correct the body here when the provider publishes it.',
  },
  createAutomated: {
    method: 'POST',
    altMethod: null,
    path: () => '/api/v1/spam-test/schedule',
    // Field names are inferred from the documented 200 response, which is the
    // only reliable description of the shape. Confirm before trusting.
    body: (t) => ({
      test_name: t.name,
      test_type: 'automated',
      campaign_id: t.campaignId || null,
      sequence_mapping_id: t.sequenceStepId || null,
      provider_id: t.providerId || null,
      spam_filters: t.spamFilters,
      link_checker: t.linkChecker,
      is_warmup: t.isWarmup,
      test_with_sl_account: t.testWithSlAccount,
      all_email_sent_without_time_gap: t.allEmailSentWithoutTimeGap,
      min_time_btwn_emails: t.minTimeBtwnEmails,
      min_time_unit: t.minTimeUnit,
      schedule_start_time: t.scheduleStartTime,
      test_end_date: t.testEndDate || null,
      every_days: t.everyDays,
      scheduler_cron_value: t.schedulerCronValue,
    }),
    verified: false,
    note: 'Body published as {}; only api_key is documented. Every field above is inferred from the response field names.',
  },
  createManual: {
    method: 'POST',
    altMethod: null,
    path: () => '/api/v1/spam-test/manual',
    body: (t) => ({
      test_name: t.name,
      test_type: 'manual',
      campaign_id: t.campaignId || null,
      sequence_mapping_id: t.sequenceStepId || null,
      provider_id: t.providerId || null,
      spam_filters: t.spamFilters,
      link_checker: t.linkChecker,
      is_warmup: t.isWarmup,
      test_with_sl_account: t.testWithSlAccount,
      all_email_sent_without_time_gap: t.allEmailSentWithoutTimeGap,
      min_time_btwn_emails: t.minTimeBtwnEmails,
      min_time_unit: t.minTimeUnit,
    }),
    verified: false,
    note: 'Body published as {}; fields inferred from the documented 200 response.',
  },
  deleteTests: {
    method: 'POST',
    altMethod: null,
    path: () => '/api/v1/spam-test/delete',
    body: (t) => ({ spam_test_ids: t.providerTestIds }),
    verified: false,
    note: 'Body published as {}. Only the page title suggests it carries a list of ids, and there is no documented per-id result — so the call is treated as all-or-nothing rather than inventing a partial-failure payload.',
  },
  stopTest: {
    method: 'PUT',
    altMethod: 'POST',
    path: (t) => `/api/v1/spam-test/${encodeURIComponent(t.providerTestId)}/stop`,
    body: () => ({}),
    verified: false,
    note: 'METHOD DISAGREEMENT: the page and the cURL/Python samples say PUT, the JavaScript sample says POST. PUT is treated as authoritative; POST is retried once on a 405.',
  },
  testDetails: {
    method: 'GET',
    altMethod: null,
    path: (t) => `/api/v1/spam-test/${encodeURIComponent(t.providerTestId)}`,
    body: null,
    verified: true,
    note: '',
  },

  // ---- folders -----------------------------------------------------------
  createFolder: {
    method: 'POST',
    altMethod: null,
    path: () => '/api/v1/spam-test/folder',
    body: (t) => ({ name: t.name }),
    verified: true,
    note: '',
  },
  getFolders: {
    method: 'GET', altMethod: null, path: () => '/api/v1/spam-test/folder', body: null, verified: true, note: '',
  },
  getFolder: {
    method: 'GET',
    altMethod: null,
    path: (t) => `/api/v1/spam-test/folder/${encodeURIComponent(t.providerFolderId)}`,
    body: null,
    verified: true,
    note: '',
  },
  deleteFolder: {
    method: 'DELETE',
    altMethod: null,
    path: (t) => `/api/v1/spam-test/folder/${encodeURIComponent(t.providerFolderId)}`,
    body: null,
    verified: true,
    note: '',
  },

  // ---- reference data (invisible — no UI of its own) ----------------------
  providerIds: {
    method: 'GET', altMethod: null, path: () => '/api/v1/spam-test/seed/providers', body: null, verified: true,
    note: 'Documented response shows a single North America region object; the normaliser accepts an object or an array.',
  },

  // ---- per-test reports --------------------------------------------------
  blacklist: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/blacklist`,
    body: null, verified: true,
    note: 'Serves both the detail rows and the count. The count is derived locally from the same rows, so nothing depends on an undocumented summary parameter.',
  },
  ipBlacklistCount: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/blacklist`,
    body: null, verified: true,
    note: 'Documented as its own endpoint but shares `blacklist`\'s method and path exactly, and publishes no summary parameter. The count is derived locally from the stored rows, so this entry is never called separately — it is listed so the table has one row per documented endpoint and a divergence upstream is visible here.',
  },
  domainBlacklist: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/domain-blacklist`,
    body: null, verified: true, note: '',
  },
  dkimDetails: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/dkim-details`,
    body: null, verified: true, note: '',
  },
  spfDetails: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/spf-details`,
    body: null, verified: true, note: '',
  },
  rdnsReport: {
    method: 'GET', altMethod: 'POST',
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/rdns-details`,
    body: null, verified: false,
    note: 'METHOD DISAGREEMENT: cURL and Python use GET, the JavaScript sample uses POST, all with an empty body. This is a read, so GET wins; POST is retried once on a 405 and the working method is recorded.',
  },
  spamFilterReport: {
    method: 'GET', altMethod: 'POST',
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/spam-filter-details`,
    body: null, verified: false,
    note: 'METHOD DISAGREEMENT: cURL and Python use GET, the JavaScript sample uses POST. GET wins; POST is retried once on a 405.',
  },
  ipDetails: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/ip-analytics`,
    body: null, verified: true, note: '',
  },
  mailboxCount: {
    method: 'GET', altMethod: null,
    path: () => '/api/v1/spam-test/report/mailboxes-count',
    body: null, verified: true,
    note: 'The documented path carries no test id; the adapter appends it as a query parameter, which is the only way one test\'s counts can be asked for.',
  },
  mailboxSummary: {
    method: 'GET', altMethod: null,
    path: () => '/api/v1/spam-test/report/mailboxes-summary',
    body: null, verified: true,
    note: 'As mailboxCount: the test id is appended as a query parameter.',
  },
  geoReport: {
    method: 'POST', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/groupwise`,
    body: () => ({}),
    verified: false,
    note: 'Body published as {}. Any grouping or filtering argument is unpublished; a 422 is recorded together with the body that caused it so the real contract can be read out of telemetry rather than guessed.',
  },
  providerReport: {
    method: 'POST', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/providerwise`,
    body: () => ({}),
    verified: false,
    note: 'Body published as {}. Same treatment as geoReport: 422s are recorded with the body sent.',
  },
  scheduleHistory: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/schedule-history`,
    body: null, verified: true, note: '',
  },
  senderList: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/sender-accounts`,
    body: null, verified: true, note: '',
  },
  senderReport: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/sender-account-wise`,
    body: null, verified: true, note: '',
  },
  replyHeaders: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/sender-account-wise/${encodeURIComponent(t.replyId)}/email-headers`,
    body: null, verified: true,
    note: 'Fetched on demand and never stored — headers carry routing detail with no ongoing value.',
  },
  emailContent: {
    method: 'GET', altMethod: null,
    path: (t) => `/api/v1/spam-test/report/${encodeURIComponent(t.providerTestId)}/email-content`,
    body: null, verified: true,
    note: 'Fetched on demand and never stored — the campaign playbook already holds the message body.',
  },
}

// The nine entries a corrected contract would touch, exposed so Monitoring can
// show honestly how much of this category is built on unpublished shapes.
export const UNVERIFIED = Object.entries(UPSTREAM)
  .filter(([, spec]) => !spec.verified)
  .map(([key, spec]) => ({ key, method: spec.method, altMethod: spec.altMethod, note: spec.note }))

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const ENV_VARS = ['DELIVERABILITY_API_URL', 'DELIVERABILITY_API_KEY']

const NAME_MAX = 200
const FOLDER_NAME_MAX = 120
const BULK_DELETE_MAX = 200          // the client chunks beyond this
const SUMMARY_IDS_MAX = 50           // one page of the tests list
const SPAM_FILTER_MAX = 20
const MAILBOX_IDS_MAX = 100
// Sender rows are the cross product of mailboxes and seeds, so both ends are
// capped. Twenty-five inboxes is already more providers than exist.
const SEED_EMAILS_MAX = 25
const RECONCILE_MS = 5 * 60 * 1000   // "once per test per five minutes"
const PROVIDER_CACHE_MS = 10 * 60 * 1000
const MIN_TIME_UNITS = ['seconds', 'minutes', 'hours']
const TEST_STATUSES = ['draft', 'scheduled', 'active', 'completed', 'stopped', 'error']
const TEST_TYPES = ['manual', 'automated']

// Report payload kinds stored in `deliverability_reports`. One cache row per
// (test, run, kind, ref) rather than eleven near-identical tables.
const KIND = {
  dkim: 'dkim',
  spf: 'spf',
  rdns: 'rdns',
  counts: 'counts',
  mailboxes: 'mailboxes',
  providers: 'providers',
  regions: 'regions',
  spamFilters: 'spam_filters',
  ips: 'ips',
  senderReport: 'sender_report',
}

// The cold-outreach inbox benchmark Monitoring already grades against.
const INBOX_BENCHMARK = 0.8

// Reason classification for the spam filter report. Deliberately small and
// keyword-based: an unrecognised reason classifies as `unknown` and renders
// with no link, rather than being given a wrong one. The raw string is always
// returned unchanged alongside the classification.
const REASON_KEYWORDS = [
  [/\b(dkim|spf|dmarc|rdns|reverse dns|authenticat|signature|alignment)\b/i, 'authentication'],
  [/\b(blacklist|blocklist|spamhaus|barracuda|reputation|ip age|domain age|listed)\b/i, 'reputation'],
  [/\b(subject|link|url|spam score|wording|content|html|image|attachment|caps|shout)\b/i, 'content'],
]

// ---------------------------------------------------------------------------
// provider plumbing
// ---------------------------------------------------------------------------

function providerBlock() {
  if (configured('deliverability')) {
    return { configured: true, provider: 'deliverability', missingEnv: [] }
  }
  return {
    ...unconfigured('deliverability', ENV_VARS),
    missingEnv: ENV_VARS.filter((name) => !process.env[name]),
  }
}

// The one place an upstream call is made. Owns the method fallback for the
// three self-contradicting pages and records the body of any 422 so an
// unpublished contract can be read out of telemetry rather than guessed.
async function upstream(key, ctx = {}) {
  const spec = UPSTREAM[key]
  if (!spec) throw new Error(`No upstream contract named ${key}`)
  const path = spec.path(ctx)
  const body = spec.body ? spec.body(ctx) : null
  const started = Date.now()
  try {
    const out = await call('deliverability', path, { method: spec.method, body })
    meter(`deliverability.upstream.${key}`, Date.now() - started, true, spec.method)
    return out
  } catch (err) {
    if (spec.altMethod && err.status === 405) {
      const out = await call('deliverability', path, { method: spec.altMethod, body })
      // Which method actually worked is the whole point of recording this.
      meter(`deliverability.method_fallback.${key}`, Date.now() - started, true, spec.altMethod)
      return out
    }
    if (err.status === 422 && body !== null) {
      meter(`deliverability.rejected_body.${key}`, Date.now() - started, false, safeStringify(body))
    } else {
      meter(`deliverability.upstream.${key}`, Date.now() - started, false, `status ${err.status || err.code || 'error'}`)
    }
    throw err
  }
}

// Reconciliation is fired and forgotten on a throttle, never awaited: a page
// load must not depend on an upstream round trip. With no provider configured
// this is a no-op and no socket is opened.
function reconcile(key, fn) {
  if (!configured('deliverability')) return false
  if (!shouldReconcile('deliverability', key, RECONCILE_MS)) return false
  Promise.resolve()
    .then(fn)
    .catch((err) => meter('deliverability.reconcile', 0, false, `${key}: ${err?.status || err?.code || err?.message || 'failed'}`))
  return true
}

// ---- seed provider groups ---------------------------------------------------

// Reference data, not a surface of its own (Docs marks provider-ids "Invisible
// — no UI"): the create routes consume it to validate a submitted provider id.
const providerCache = new Map() // wsId -> { at, regions }

// Accepts the documented single-region object or an array of them, and
// normalises both to one internal structure.
export function normaliseProviders(payload) {
  const raw = payload && !Array.isArray(payload) && Array.isArray(payload.data) ? payload.data : payload
  const list = raw === null || raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw])
  const regions = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const groupsRaw = Array.isArray(entry.groups) ? entry.groups
      : Array.isArray(entry.provider_groups) ? entry.provider_groups
        : []
    regions.push({
      regionId: String(entry.region_id ?? entry.regionId ?? entry.id ?? '').trim(),
      regionName: String(entry.region_name ?? entry.regionName ?? '').trim(),
      groups: groupsRaw.filter((g) => g && typeof g === 'object').map((g) => ({
        groupId: String(g.group_id ?? g.groupId ?? g.id ?? '').trim(),
        groupName: String(g.group_name ?? g.groupName ?? g.name ?? '').trim(),
        providerCount: Number(g.provider_count ?? g.providerCount ?? 0) || 0,
      })),
    })
  }
  return regions
}

function cachedProviders(wsId) {
  const hit = providerCache.get(wsId)
  if (!hit) return null
  if (Date.now() - hit.at > PROVIDER_CACHE_MS) {
    providerCache.delete(wsId)
    return null
  }
  return hit.regions
}

// Validation on create: a submitted provider id must exist in the currently
// known list. When there is no list — no provider configured, or a cache miss
// during an outage — the route refuses rather than guessing, because a test
// seeded against a group that no longer exists proves nothing.
function assertKnownProvider(wsId, providerId) {
  if (!providerId) return null
  const regions = cachedProviders(wsId)
  if (!regions) {
    throw invalid('providerId', 'The seed provider list is unavailable, so a provider id cannot be verified — create the test without one, or retry when the deliverability provider is connected')
  }
  const match = regions.flatMap((r) => r.groups.map((g) => ({ ...g, regionName: r.regionName }))).find((g) => g.groupId === providerId)
  if (!match) {
    meter('deliverability.unknown_provider', 0, false, providerId)
    throw invalid('providerId', `providerId "${providerId}" is not in the current seed provider list`)
  }
  return match
}

function providerLabel(wsId, providerId) {
  if (!providerId) return { providerId: null, providerLabel: null, reason: null }
  const regions = cachedProviders(wsId)
  if (!regions) return { providerId, providerLabel: null, reason: 'provider list not available' }
  for (const region of regions) {
    for (const group of region.groups) {
      if (group.groupId === providerId) {
        return { providerId, providerLabel: region.regionName ? `${group.groupName}, ${region.regionName}` : group.groupName, reason: null }
      }
    }
  }
  return { providerId, providerLabel: null, reason: 'provider group no longer listed' }
}

// ---------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------

// A test id in a path is either Harry's own numeric id or the provider's opaque
// one. Anything else is malformed and 422s — the specs distinguish "not a
// number" from "not yours", and a 404 must never confirm that an id exists
// somewhere else.
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function ownedTest(req, param = 'testId') {
  const raw = String(req.params[param] ?? '')
  let row = null
  if (/^\d+$/.test(raw)) {
    row = db.prepare('SELECT * FROM deliverability_tests WHERE id = ? AND workspace_id = ?').get(Number(raw), req.wsId)
  } else if (PROVIDER_ID_RE.test(raw)) {
    row = db.prepare("SELECT * FROM deliverability_tests WHERE provider_test_id = ? AND provider_test_id != '' AND workspace_id = ?").get(raw, req.wsId)
  } else {
    throw invalid(param, `${param} is malformed`)
  }
  if (!row || String(row.deleted_at || '')) throw notFound('test')
  return row
}

function ownedFolder(req, param = 'folderId') {
  const raw = String(req.params[param] ?? '')
  if (!/^\d+$/.test(raw)) throw invalid(param, `${param} is malformed`)
  const row = db.prepare('SELECT * FROM deliverability_folders WHERE id = ? AND workspace_id = ?').get(Number(raw), req.wsId)
  if (!row) throw notFound('folder')
  return row
}

function folderById(wsId, id) {
  if (!id) return null
  const row = db.prepare('SELECT * FROM deliverability_folders WHERE id = ? AND workspace_id = ?').get(id, wsId)
  if (!row) throw notFound('folder')
  return row
}

// ---------------------------------------------------------------------------
// report cache helpers
// ---------------------------------------------------------------------------

function cachedReport(testId, runNo, kind, ref = '') {
  return db.prepare(
    'SELECT * FROM deliverability_reports WHERE test_id = ? AND run_no = ? AND kind = ? AND ref = ?'
  ).get(testId, runNo, kind, ref) || null
}

function payloadOf(row, fallback) {
  if (!row) return fallback
  try {
    const parsed = JSON.parse(row.payload || 'null')
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch { return fallback }
}

function isStale(row) {
  if (!row) return true
  const at = Date.parse(String(row.fetched_at || '').replace(' ', 'T') + (String(row.fetched_at || '').endsWith('Z') ? '' : 'Z'))
  if (!Number.isFinite(at)) return true
  return Date.now() - at > RECONCILE_MS
}

// Every report response wears the same jacket, so the client has one rule for
// "is this current?" across eighteen sections.
function reportEnvelope(test, row, extra = {}) {
  return {
    ...providerBlock(),
    testId: test.id,
    runNo: test.current_run_no || 1,
    fetchedAt: row ? row.fetched_at : null,
    stale: isStale(row),
    available: Boolean(row),
    ...extra,
  }
}

const runNoOf = (test) => Math.max(1, Number(test.current_run_no) || 1)

// ---------------------------------------------------------------------------
// blocklist — ONE derivation, used by the list, the batch and the detail
// ---------------------------------------------------------------------------

// A test with no stored rows is *pending*, not clear: reporting zero would read
// as "checked, nothing found". `totalBlacklist` is null in that state.
function blacklistSummaryFrom(rowCount, listedCount) {
  if (!rowCount) return { totalBlacklist: null, state: 'pending' }
  return { totalBlacklist: listedCount, state: listedCount > 0 ? 'listed' : 'clear' }
}

function blacklistSummary(testId, kind = 'ip') {
  const row = db.prepare(
    'SELECT COUNT(*) n, SUM(CASE WHEN listed = 1 THEN 1 ELSE 0 END) listed FROM deliverability_blacklist WHERE test_id = ? AND kind = ?'
  ).get(testId, kind)
  return blacklistSummaryFrom(row.n, row.listed || 0)
}

// ---------------------------------------------------------------------------
// shaping
// ---------------------------------------------------------------------------

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// `client_id` and `user_id` are workspace-internal and never leave the server;
// `blocklist_count` is deliberately absent so nothing can read the stale copy.
function shapeTest(row, { folderName = null, blacklist = null } = {}) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    // A manual test has no cadence. Null, never the string "null".
    everyDays: row.every_days ? row.every_days : null,
    scheduleStartTime: row.schedule_start_time || null,
    testEndDate: row.test_end_date || null,
    currentRunNo: row.current_run_no || 0,
    folderId: row.folder_id || null,
    folderName,
    linkChecker: Boolean(row.link_checker),
    testWithSlAccount: Boolean(row.test_with_sl_account),
    isWarmup: Boolean(row.is_warmup),
    allEmailSentWithoutTimeGap: Boolean(row.all_email_sent_without_time_gap),
    minTimeBtwnEmails: row.min_time_btwn_emails || 0,
    minTimeUnit: row.min_time_unit || 'minutes',
    spamFilters: jsonArray(row.spam_filters),
    mailboxIds: jsonArray(row.mailbox_ids),
    tagIds: jsonArray(row.tag_ids),
    blacklist: blacklist || blacklistSummary(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function shapeFolder(row, testCount) {
  return {
    id: row.id,
    name: row.name,
    testCount,
    createdAt: row.created_at,
    // `deliverability_folders` carries no updated_at; a folder is only ever
    // created, renamed nowhere, and deleted. Reported as the creation time so
    // the documented field is present rather than silently dropped.
    updatedAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// reference resolution for the detail header
// ---------------------------------------------------------------------------

// Each resolution is allowed to fail on its own and returns null with a reason,
// so a test that outlives its campaign still renders.
function resolveReferences(req, test) {
  const out = {
    campaignId: null,
    campaignName: null,
    campaignReason: null,
    sequenceStepId: null,
    sequenceStepLabel: null,
    sequenceStepReason: null,
    folderId: test.folder_id || null,
    folderName: null,
    folderReason: null,
  }

  const meta = payloadOf(cachedReport(test.id, 1, 'setup'), {})
  out.campaignId = meta.campaignId ?? null
  out.sequenceStepId = meta.sequenceStepId ?? null

  if (out.campaignId) {
    const campaign = db.prepare('SELECT id, name, mermaid FROM campaigns WHERE id = ? AND user_id = ?').get(out.campaignId, req.wsId)
    if (!campaign) {
      out.campaignReason = 'that campaign no longer exists'
      meter('deliverability.unresolved_reference', 0, false, `campaign ${out.campaignId}`)
    } else {
      out.campaignName = campaign.name
      if (out.sequenceStepId) {
        try {
          const graph = parsePlaybook(campaign.mermaid || '')
          const node = graph.nodes[out.sequenceStepId]
          if (node) out.sequenceStepLabel = node.label
          else out.sequenceStepReason = 'that step is no longer in the playbook'
        } catch {
          out.sequenceStepReason = 'the playbook could not be read'
        }
      }
    }
  }

  if (out.folderId) {
    const folder = db.prepare('SELECT name FROM deliverability_folders WHERE id = ? AND workspace_id = ?').get(out.folderId, req.wsId)
    if (folder) out.folderName = folder.name
    else out.folderReason = 'that folder no longer exists'
  }

  return out
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function safeStringify(value) {
  try { return JSON.stringify(value).slice(0, 500) } catch { return '[unserialisable]' }
}

function rate(part, whole) {
  const p = Number(part)
  const w = Number(whole)
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return null
  return Math.round((p / w) * 10000) / 10000
}

function isoOrThrow(body, field, { required = false } = {}) {
  const raw = body?.[field]
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw invalid(field, `${field} is required`)
    return ''
  }
  const d = new Date(String(raw))
  if (Number.isNaN(d.getTime())) throw invalid(field, `${field} must be an ISO date`)
  return d.toISOString()
}

function stringList(body, field, { max = 20, itemMax = 120 } = {}) {
  const raw = body?.[field]
  if (raw === undefined || raw === null || raw === '') return []
  if (!Array.isArray(raw)) throw invalid(field, `${field} must be an array`)
  if (raw.length > max) throw invalid(field, `${field} may contain at most ${max} entries`)
  const out = []
  for (const item of raw) {
    const value = String(item ?? '').trim()
    if (!value) throw invalid(field, `${field} contains an empty entry`)
    if (value.length > itemMax) throw invalid(field, `${field} entries must be ${itemMax} characters or fewer`)
    if (!out.includes(value)) out.push(value)
  }
  return out
}

// The inboxes a seed copy is sent TO, supplied by the user.
//
// With no deliverability provider connected there is no seed pool, and the only
// honest way to run a placement test is against inboxes the user already owns
// at the providers they care about. Each is validated as an address here so a
// typo is a 422 with a field name rather than a send that fails at tick time
// with nobody watching.
function emailList(body, field, { max = SEED_EMAILS_MAX } = {}) {
  const raw = body?.[field]
  if (raw === undefined || raw === null || raw === '') return []
  if (!Array.isArray(raw)) throw invalid(field, `${field} must be an array`)
  if (raw.length > max) throw invalid(field, `${field} may contain at most ${max} seed inboxes`)
  const out = []
  for (const item of raw) {
    const value = emailField({ [field]: item }, field, { required: true })
    if (!out.includes(value)) out.push(value)
  }
  return out
}

// A cadence expressed as cron, derived rather than stored — the schema has no
// column for it and two sources of truth for a schedule is one too many.
function cronFor(startIso, everyDays) {
  if (!startIso || !everyDays) return null
  const d = new Date(startIso)
  if (Number.isNaN(d.getTime())) return null
  const m = d.getUTCMinutes()
  const h = d.getUTCHours()
  if (everyDays === 1) return `${m} ${h} * * *`
  if (everyDays === 7) return `${m} ${h} * * ${d.getUTCDay()}`
  return `${m} ${h} */${everyDays} * *`
}

function classifyReason(reason) {
  const text = String(reason ?? '')
  for (const [re, type] of REASON_KEYWORDS) if (re.test(text)) return type
  return 'unknown'
}

// ---------------------------------------------------------------------------
// create — one validated input schema shared by both create routes
// ---------------------------------------------------------------------------

function readTestInput(req, { automated }) {
  const body = req.body || {}
  const name = str(body, 'name', { required: !automated ? false : true, max: NAME_MAX }) ||
    str(body, 'testName', { max: NAME_MAX })
  if (automated && !name) throw invalid('name', 'name is required')

  const folderId = body.folderId === undefined || body.folderId === null || body.folderId === ''
    ? 0
    : int(body, 'folderId', { min: 1 })
  if (folderId) folderById(req.wsId, folderId)

  const campaignId = body.campaignId === undefined || body.campaignId === null || body.campaignId === ''
    ? 0
    : int(body, 'campaignId', { min: 1 })
  if (campaignId) owned('campaigns', campaignId, req.wsId, 'campaign')

  const sequenceStepId = str(body, 'sequenceStepId', { max: 120 })
  if (sequenceStepId && !campaignId) {
    throw invalid('campaignId', 'campaignId is required when a sequenceStepId is given')
  }

  const mailboxIds = idList(body, 'mailboxIds', { max: MAILBOX_IDS_MAX })
  for (const id of mailboxIds) owned('mailboxes', id, req.wsId, 'mailbox')

  const tagIds = idList(body, 'tagIds', { max: MAILBOX_IDS_MAX })
  for (const id of tagIds) {
    const row = db.prepare("SELECT id FROM tags WHERE id = ? AND workspace_id = ? AND applies_to = 'mailbox'").get(id, req.wsId)
    if (!row) throw new HttpError(404, { error: 'not_found', message: `No such mailbox tag: ${id}`, id })
  }

  const providerId = str(body, 'providerId', { max: 64 })
  assertKnownProvider(req.wsId, providerId)

  return {
    name: name || `${automated ? 'Scheduled' : 'Manual'} placement test`,
    folderId,
    campaignId,
    sequenceStepId,
    mailboxIds,
    tagIds,
    providerId,
    seedEmails: emailList(body, 'seedEmails'),
    spamFilters: stringList(body, 'spamFilters', { max: SPAM_FILTER_MAX }),
    linkChecker: bool(body, 'linkChecker', false),
    isWarmup: bool(body, 'isWarmup', false),
    testWithSlAccount: bool(body, 'testWithSlAccount', false),
    allEmailSentWithoutTimeGap: bool(body, 'allEmailSentWithoutTimeGap', false),
    minTimeBtwnEmails: int(body, 'minTimeBtwnEmails', { min: 0, max: 1440, fallback: 0 }),
    minTimeUnit: oneOf(body, 'minTimeUnit', MIN_TIME_UNITS, { fallback: 'minutes' }),
    description: str(body, 'description', { max: 2000 }),
  }
}

// Both create routes write the same row, the same setup cache entry and the
// same seed sender rows; only the cadence differs.
function insertTest(req, input, { type, status, everyDays, scheduleStartTime, testEndDate, runNo }) {
  return tx(() => {
    const info = db.prepare(
      `INSERT INTO deliverability_tests
         (workspace_id, folder_id, name, type, status, schedule_start_time, test_end_date, every_days,
          current_run_no, all_email_sent_without_time_gap, min_time_btwn_emails, min_time_unit,
          is_warmup, test_with_sl_account, link_checker, spam_filters, mailbox_ids, tag_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.wsId, input.folderId || null, input.name, type, status,
      scheduleStartTime || '', testEndDate || '', everyDays, runNo,
      input.allEmailSentWithoutTimeGap ? 1 : 0, input.minTimeBtwnEmails, input.minTimeUnit,
      input.isWarmup ? 1 : 0, input.testWithSlAccount ? 1 : 0, input.linkChecker ? 1 : 0,
      JSON.stringify(input.spamFilters), JSON.stringify(input.mailboxIds), JSON.stringify(input.tagIds),
    )
    const testId = Number(info.lastInsertRowid)

    // The fields the schema has no column for (campaign, step, provider id,
    // description) live in the same cache the reports use, keyed `setup`. They
    // are Harry's own values, not provider data.
    db.prepare(
      "INSERT INTO deliverability_reports (test_id, run_no, kind, ref, payload) VALUES (?, 1, 'setup', '', ?)"
    ).run(testId, JSON.stringify({
      campaignId: input.campaignId || null,
      sequenceStepId: input.sequenceStepId || null,
      providerId: input.providerId || null,
      description: input.description || '',
      createdBy: req.user?.email || '',
      // The seed inboxes ride here for the same reason: the schema has no
      // column, and run 7 of a schedule has to be able to find the same list
      // run 1 used.
      seedEmails: input.seedEmails,
    }))

    // Seed sender rows come from the workspace's own mailboxes, so the sender
    // list and the reply-header lookup are answerable before any upstream call.
    // How many rows, and in what state, is the runner's rule — see
    // server/deliverability-runs.js.
    let queued = 0
    if (runNo) {
      if (input.mailboxIds.length) {
        queued = createRunSenders({
          testId,
          wsId: req.wsId,
          runNo,
          mailboxIds: input.mailboxIds,
          seedEmails: input.seedEmails,
          providerId: input.providerId || '',
        })
      }
      db.prepare(
        'INSERT OR IGNORE INTO deliverability_test_runs (test_id, run_no, status) VALUES (?, ?, ?)'
      ).run(testId, runNo, runStatusFor(queued))
    }

    const row = db.prepare('SELECT * FROM deliverability_tests WHERE id = ?').get(testId)
    // Carried on the row rather than recomputed by each caller, so the number
    // in the response is the number of rows that were actually written.
    row.seedsQueued = queued
    return row
  })
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export function register(api) {
  // ======================================================== reference data ==
  // GET /api/deliverability/providers — provider-ids. Marked "Invisible — no
  // UI" in the backlog: it exists so the create form never constructs a
  // provider id itself, and so the create routes can reject a stale one.
  api.get('/deliverability/providers', handler((req) => {
    const started = Date.now()
    let regions = cachedProviders(req.wsId)
    const cacheHit = regions !== null
    if (!cacheHit) regions = []

    reconcile(`providers:${req.wsId}`, async () => {
      const payload = await upstream('providerIds')
      providerCache.set(req.wsId, { at: Date.now(), regions: normaliseProviders(payload) })
    })

    meter('deliverability.providers', Date.now() - started, true, cacheHit ? 'cache' : 'empty')
    const groupCount = regions.reduce((n, r) => n + r.groups.length, 0)
    return {
      ...providerBlock(),
      regions,
      cached: cacheHit,
      // A test with no seeds proves nothing, so the form is told plainly that
      // it must block creation rather than guess an id.
      canCreateTests: groupCount > 0,
      message: groupCount > 0
        ? ''
        : configured('deliverability')
          ? 'No seed provider groups are available yet — the list is being fetched.'
          : 'No deliverability provider is connected, so no seed inboxes are listed. Tests can still be created and stored without a provider id.',
      contracts: { unverified: UNVERIFIED.length, entries: UNVERIFIED },
    }
  }))

  // ============================================================== folders ===
  // GET /api/deliverability/folders — one grouped query, never one per folder.
  api.get('/deliverability/folders', handler((req) => {
    const started = Date.now()
    const rows = db.prepare(
      `SELECT f.*, COUNT(t.id) AS test_count
         FROM deliverability_folders f
         LEFT JOIN deliverability_tests t
           ON t.folder_id = f.id AND COALESCE(t.deleted_at,'') = ''
        WHERE f.workspace_id = ? AND COALESCE(f.deleted_at,'') = ''
        GROUP BY f.id
        ORDER BY f.created_at DESC, f.id DESC`
    ).all(req.wsId)

    reconcile(`folders:${req.wsId}`, () => upstream('getFolders'))
    meter('deliverability.folders.list', Date.now() - started, true, `${rows.length} folders`)
    return { ...providerBlock(), items: rows.map((r) => shapeFolder(r, r.test_count)), total: rows.length }
  }))

  // POST /api/deliverability/folders — create-folder.
  api.post('/deliverability/folders', handler((req) => {
    const name = str(req.body, 'name', { required: true, max: FOLDER_NAME_MAX })

    const row = tx(() => {
      const clash = db.prepare(
        `SELECT id, name FROM deliverability_folders
          WHERE workspace_id = ? AND COALESCE(deleted_at,'') = '' AND lower(trim(name)) = lower(trim(?))`
      ).get(req.wsId, name)
      if (clash) {
        throw new HttpError(409, {
          error: 'duplicate_name',
          field: 'name',
          id: clash.id,
          message: `A folder named "${clash.name}" already exists — file the test there instead of creating a second one`,
        })
      }
      const info = db.prepare('INSERT INTO deliverability_folders (workspace_id, name) VALUES (?, ?)').run(req.wsId, name)
      return db.prepare('SELECT * FROM deliverability_folders WHERE id = ?').get(info.lastInsertRowid)
    })

    audit(req, { type: 'deliverability_folder_created', detail: `${row.name} (#${row.id})` })
    // The full stored record, so the client needs no follow-up fetch.
    return { ...providerBlock(), ...shapeFolder(row, 0) }
  }))

  // GET /api/deliverability/folders/:folderId — get-folder-by-id.
  api.get('/deliverability/folders/:folderId', handler((req) => {
    const started = Date.now()
    const row = ownedFolder(req)
    const count = db.prepare(
      "SELECT COUNT(*) n FROM deliverability_tests WHERE folder_id = ? AND workspace_id = ? AND COALESCE(deleted_at,'') = ''"
    ).get(row.id, req.wsId).n
    meter('deliverability.folders.get', Date.now() - started)
    return { ...providerBlock(), ...shapeFolder(row, count) }
  }))

  // DELETE /api/deliverability/folders/:folderId — delete-folder. Filing is
  // reversible: deleting a folder never deletes a test.
  api.delete('/deliverability/folders/:folderId', handler((req) => {
    const row = ownedFolder(req)
    const tests = db.prepare(
      "SELECT COUNT(*) n FROM deliverability_tests WHERE folder_id = ? AND COALESCE(deleted_at,'') = ''"
    ).get(row.id).n
    const unfile = bool(req.query, 'unfile', false) || bool(req.body, 'unfile', false)

    if (tests > 0 && !unfile) {
      meter('deliverability.folders.delete_refused', 0, false, `${tests} tests`)
      throw new HttpError(409, {
        error: 'folder_not_empty',
        field: 'folderId',
        testCount: tests,
        message: `"${row.name}" still holds ${tests} test${tests === 1 ? '' : 's'}. Deleting the folder keeps every test — pass unfile=1 to confirm.`,
      })
    }

    const result = tx(() => {
      const unfiled = db.prepare('UPDATE deliverability_tests SET folder_id = NULL WHERE folder_id = ?').run(row.id).changes
      db.prepare('DELETE FROM deliverability_folders WHERE id = ? AND workspace_id = ?').run(row.id, req.wsId)
      return { unfiled }
    })

    audit(req, {
      type: 'deliverability_folder_deleted',
      detail: `${row.name} (#${row.id}); ${result.unfiled} test(s) unfiled, 0 deleted`,
    })
    return {
      ...providerBlock(),
      ok: true,
      id: row.id,
      testsUnfiled: result.unfiled,
      testsDeleted: 0,
      message: `Folder deleted. ${result.unfiled} test${result.unfiled === 1 ? '' : 's'} kept and unfiled.`,
    }
  }))

  // ================================================================ tests ===
  // GET /api/deliverability/tests — list-tests. Served from local rows, paged
  // server-side, blocklist counts derived from the same table as the detail.
  api.get('/deliverability/tests', handler((req) => {
    const started = Date.now()
    const { limit, cursor } = page(req.query, { defaultLimit: 25, maxLimit: 200 })
    const status = req.query.status ? oneOf(req.query, 'status', TEST_STATUSES) : ''
    const type = req.query.type ? oneOf(req.query, 'type', TEST_TYPES) : ''
    const q = str(req.query, 'q', { max: NAME_MAX })
    const hasFolder = req.query.folderId !== undefined && req.query.folderId !== ''
    const folderId = hasFolder ? int(req.query, 'folderId', { min: 0 }) : 0

    const where = ['t.workspace_id = ?', "COALESCE(t.deleted_at,'') = ''"]
    const args = [req.wsId]
    if (status) { where.push('t.status = ?'); args.push(status) }
    if (type) { where.push('t.type = ?'); args.push(type) }
    if (q) { where.push('lower(t.name) LIKE ?'); args.push(`%${q.toLowerCase()}%`) }
    if (hasFolder) {
      if (folderId === 0) where.push('t.folder_id IS NULL')
      else { folderById(req.wsId, folderId); where.push('t.folder_id = ?'); args.push(folderId) }
    }

    const total = db.prepare(`SELECT COUNT(*) n FROM deliverability_tests t WHERE ${where.join(' AND ')}`).get(...args).n

    // Keyset paging on (updated_at, id) descending. A test created mid-scroll
    // sorts above the cursor and so cannot push a row onto a second page, and
    // the id tiebreak keeps ordering deterministic when several rows share a
    // one-second timestamp.
    const keyed = [...where]
    const keyedArgs = [...args]
    if (cursor) {
      const anchor = db.prepare('SELECT updated_at, id FROM deliverability_tests WHERE id = ? AND workspace_id = ?').get(cursor, req.wsId)
      if (anchor) { keyed.push('(t.updated_at, t.id) < (?, ?)'); keyedArgs.push(anchor.updated_at, anchor.id) }
    }

    const rows = db.prepare(
      `SELECT t.*,
              f.name AS folder_name,
              (SELECT COUNT(*) FROM deliverability_blacklist b WHERE b.test_id = t.id AND b.kind = 'ip') AS bl_rows,
              (SELECT COUNT(*) FROM deliverability_blacklist b WHERE b.test_id = t.id AND b.kind = 'ip' AND b.listed = 1) AS bl_listed
         FROM deliverability_tests t
         LEFT JOIN deliverability_folders f ON f.id = t.folder_id
        WHERE ${keyed.join(' AND ')}
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT ?`
    ).all(...keyedArgs, limit + 1)

    const out = paged(rows, limit)
    const active = db.prepare(
      "SELECT COUNT(*) n FROM deliverability_tests WHERE workspace_id = ? AND status = 'active' AND COALESCE(deleted_at,'') = ''"
    ).get(req.wsId).n

    reconcile(`tests:${req.wsId}`, () => upstream('listTests'))
    meter('deliverability.tests.list', Date.now() - started, true, `${out.items.length} of ${total}; ${active} active`)

    return {
      ...providerBlock(),
      items: out.items.map((r) => shapeTest(r, {
        folderName: r.folder_name || null,
        blacklist: blacklistSummaryFrom(r.bl_rows, r.bl_listed),
      })),
      total,
      limit,
      nextCursor: out.nextCursor,
      hasMore: out.hasMore,
      activeCount: active,
      // The list is authoritative locally; this says whether the copy has been
      // refreshed against a provider, so an empty list never reads as "gone".
      servedFrom: 'local',
    }
  }))

  // POST /api/deliverability/tests/schedule — create-automated-test.
  api.post('/deliverability/tests/schedule', handler((req) => {
    const input = readTestInput(req, { automated: true })
    const scheduleStartTime = isoOrThrow(req.body, 'scheduleStartTime', { required: true })
    const testEndDate = isoOrThrow(req.body, 'testEndDate')
    const everyDays = int(req.body, 'everyDays', { required: true, min: 1, max: 365 })

    if (testEndDate) {
      if (testEndDate <= scheduleStartTime) {
        throw invalid('testEndDate', 'testEndDate must be after scheduleStartTime — a schedule that ends before it starts never runs')
      }
      if (Date.parse(testEndDate) < Date.now()) {
        throw invalid('testEndDate', 'testEndDate is in the past — a schedule that has already ended never runs')
      }
    }

    // Informational only: the confirmation lives in the UI, so the route
    // reports the clash rather than refusing a legitimate second schedule.
    const duplicate = input.campaignId
      ? db.prepare(
        `SELECT t.id, t.name FROM deliverability_tests t
          WHERE t.workspace_id = ? AND t.type = 'automated' AND t.every_days = ?
            AND t.status IN ('active','scheduled') AND COALESCE(t.deleted_at,'') = ''
            AND EXISTS (SELECT 1 FROM deliverability_reports r
                         WHERE r.test_id = t.id AND r.kind = 'setup'
                           AND json_extract(r.payload, '$.campaignId') = ?)
          LIMIT 1`
      ).get(req.wsId, everyDays, input.campaignId)
      : null

    const row = insertTest(req, input, {
      type: 'automated',
      status: 'active',
      everyDays,
      scheduleStartTime,
      testEndDate,
      runNo: 0,
    })

    audit(req, {
      campaignId: input.campaignId || null,
      type: 'deliverability_test_scheduled',
      detail: `${row.name} (#${row.id}) every ${everyDays} day(s) from ${scheduleStartTime}`,
    })
    meter('deliverability.tests.schedule', 0, true, `every ${everyDays}d`)

    return {
      ...providerBlock(),
      ...shapeTest(row, { blacklist: { totalBlacklist: null, state: 'pending' } }),
      schedulerCronValue: cronFor(scheduleStartTime, everyDays),
      description: input.description || null,
      campaignId: input.campaignId || null,
      sequenceStepId: input.sequenceStepId || null,
      providerId: input.providerId || null,
      seedEmails: input.seedEmails,
      // A schedule creates no rows until its first run comes due, so there is
      // nothing to count yet — but whether that run will be able to send
      // anything is knowable now, and worth saying before the user walks away.
      awaitingSeeds: input.seedEmails.length === 0,
      nextRunNote: input.seedEmails.length
        ? `The first run opens at ${scheduleStartTime} and sends ${input.seedEmails.length * (input.mailboxIds.length || 1)} seed(s).`
        : 'No seed inboxes were given, so each run will open with nothing to send until `seedEmails` is set or a deliverability provider supplies a seed pool.',
      duplicateOf: duplicate ? { id: duplicate.id, name: duplicate.name } : null,
    }
  }))

  // POST /api/deliverability/tests/manual — create-manual-test.
  api.post('/deliverability/tests/manual', handler((req) => {
    const input = readTestInput(req, { automated: false })
    if (!input.mailboxIds.length) {
      throw invalid('mailboxIds', 'mailboxIds must name at least one mailbox to send the seed emails from')
    }

    const row = insertTest(req, input, {
      type: 'manual',
      status: 'active',
      everyDays: 0,
      scheduleStartTime: nowIso(),
      testEndDate: '',
      runNo: 1,
    })

    audit(req, {
      campaignId: input.campaignId || null,
      type: 'deliverability_test_started',
      detail: `${row.name} (#${row.id}) from ${input.mailboxIds.length} mailbox(es) to ${input.seedEmails.length} seed inbox(es)`,
    })
    meter('deliverability.tests.manual', 0, true, `${row.seedsQueued} seeds`)

    // The honest split. A test with seed inboxes has real work queued and the
    // tick will do it. A test without them has none, and saying "1 seed send
    // queued" for sends no code path can perform is the bug this replaced:
    // `seedsQueued` is now the count of rows a job will actually pick up.
    const awaitingSeeds = row.seedsQueued === 0
    return {
      ...providerBlock(),
      ...shapeTest(row, { blacklist: { totalBlacklist: null, state: 'pending' } }),
      description: input.description || null,
      campaignId: input.campaignId || null,
      sequenceStepId: input.sequenceStepId || null,
      providerId: input.providerId || null,
      seedEmails: input.seedEmails,
      seedsQueued: row.seedsQueued,
      awaitingSeeds,
      message: awaitingSeeds
        ? (configured('deliverability')
          ? 'Test created, but no seed inboxes were given and none have been supplied by the provider yet — nothing will be sent until they are.'
          : 'Test created, but nothing will be sent yet: no deliverability provider is connected, so there is no seed pool. Give `seedEmails` — inboxes you own at the providers you care about — and the seeds will go out through the normal sending rhythm.')
        // Seed sends run through the normal mailer and count against the
        // mailbox's daily allowance; nothing here bypasses the sending rhythm.
        : `Test created. ${row.seedsQueued} seed send(s) queued through the normal sending rhythm.`,
    }
  }))

  // POST /api/deliverability/tests/delete — delete-tests-bulk. All-or-nothing,
  // capped, and one activity-trail row for the whole call.
  api.post('/deliverability/tests/delete', handler((req) => {
    const testIds = idList(req.body, 'testIds', { required: true, max: BULK_DELETE_MAX })

    // Every id is proved to be the caller's before a single row is touched, so
    // a cross-workspace id deletes nothing at all.
    const tests = []
    for (const id of testIds) {
      const row = db.prepare('SELECT * FROM deliverability_tests WHERE id = ? AND workspace_id = ?').get(id, req.wsId)
      if (!row || String(row.deleted_at || '')) {
        throw new HttpError(404, { error: 'not_found', message: `No such test: ${id}`, id })
      }
      tests.push(row)
    }

    const runningAutomated = tests.filter((t) => t.type === 'automated' && ['active', 'scheduled'].includes(t.status))

    const result = tx(() => {
      const counts = { reports: 0, blacklist: 0, senders: 0, runs: 0, tests: 0 }
      const delReports = db.prepare('DELETE FROM deliverability_reports WHERE test_id = ?')
      const delBlacklist = db.prepare('DELETE FROM deliverability_blacklist WHERE test_id = ?')
      const delSenders = db.prepare('DELETE FROM deliverability_test_senders WHERE test_id = ?')
      const delRuns = db.prepare('DELETE FROM deliverability_test_runs WHERE test_id = ?')
      const delTest = db.prepare('DELETE FROM deliverability_tests WHERE id = ? AND workspace_id = ?')
      for (const test of tests) {
        // Deleting a running automated test also stops its schedule: the row
        // that carries the schedule is the row being removed.
        counts.reports += delReports.run(test.id).changes
        counts.blacklist += delBlacklist.run(test.id).changes
        counts.senders += delSenders.run(test.id).changes
        counts.runs += delRuns.run(test.id).changes
        counts.tests += delTest.run(test.id, req.wsId).changes
      }
      return counts
    })

    // One events row for the bulk action, not one per test.
    audit(req, {
      type: 'deliverability_tests_deleted',
      detail: `${result.tests} test(s) deleted (${testIds.join(',')}); ${runningAutomated.length} running schedule(s) stopped`,
    })
    if (runningAutomated.length) {
      meter('deliverability.tests.delete_running', 0, true, `${runningAutomated.length} running`)
    }

    reconcile(`delete:${req.wsId}:${testIds.join('-')}`, () => upstream('deleteTests', {
      providerTestIds: tests.map((t) => t.provider_test_id).filter(Boolean),
    }))

    return {
      ...providerBlock(),
      ok: true,
      requested: testIds.length,
      deleted: result.tests,
      schedulesStopped: runningAutomated.length,
      cachedReportRowsRemoved: result.reports + result.blacklist + result.senders + result.runs,
      message: 'Tests deleted successfully',
    }
  }))

  // GET /api/deliverability/tests/blacklist-summary?testIds=1,2,3 —
  // ip-blacklist-count, batched for the list view. Registered before
  // /tests/:testId so the parameterised route cannot shadow it.
  api.get('/deliverability/tests/blacklist-summary', handler((req) => {
    const started = Date.now()
    const raw = req.query.testIds
    if (raw === undefined || raw === '') throw invalid('testIds', 'testIds is required')
    const parts = Array.isArray(raw) ? raw : String(raw).split(',')
    const ids = []
    for (const part of parts) {
      const n = Number(String(part).trim())
      if (!Number.isInteger(n) || n <= 0) throw invalid('testIds', `testIds contains an invalid id: ${part}`)
      if (!ids.includes(n)) ids.push(n)
    }
    if (!ids.length) throw invalid('testIds', 'testIds must contain at least one id')
    if (ids.length > SUMMARY_IDS_MAX) throw invalid('testIds', `testIds may contain at most ${SUMMARY_IDS_MAX} ids — the client chunks beyond that`)

    const placeholders = ids.map(() => '?').join(',')
    // One query for the whole page: the ownership filter and the grouped count
    // in a single statement, so fifty ids is not fifty round trips.
    const rows = db.prepare(
      `SELECT t.id,
              (SELECT COUNT(*) FROM deliverability_blacklist b WHERE b.test_id = t.id AND b.kind = 'ip') AS bl_rows,
              (SELECT COUNT(*) FROM deliverability_blacklist b WHERE b.test_id = t.id AND b.kind = 'ip' AND b.listed = 1) AS bl_listed
         FROM deliverability_tests t
        WHERE t.id IN (${placeholders}) AND t.workspace_id = ? AND COALESCE(t.deleted_at,'') = ''`
    ).all(...ids, req.wsId)

    const found = new Map(rows.map((r) => [r.id, blacklistSummaryFrom(r.bl_rows, r.bl_listed)]))
    meter('deliverability.blacklist_summary', Date.now() - started, true, `${rows.length}/${ids.length} ids`)

    return {
      ...providerBlock(),
      items: ids.filter((id) => found.has(id)).map((id) => ({ testId: id, ...found.get(id) })),
      // Ids outside the workspace are omitted rather than 404'd — a summary for
      // a page must not fail wholesale — and naming them leaks nothing, because
      // "not yours" is all the caller learns.
      unavailable: ids.filter((id) => !found.has(id)),
    }
  }))

  // GET /api/deliverability/tests/:testId — test-details. Every reference is
  // resolved server-side, so the client makes no follow-up calls.
  api.get('/deliverability/tests/:testId', handler((req) => {
    const started = Date.now()
    const test = ownedTest(req)
    const setup = payloadOf(cachedReport(test.id, 1, 'setup'), {})
    const refs = resolveReferences(req, test)
    const provider = providerLabel(req.wsId, setup.providerId || '')

    reconcile(`test:${test.id}`, () => upstream('testDetails', { providerTestId: test.provider_test_id || String(test.id) }))
    meter('deliverability.tests.get', Date.now() - started)

    return {
      ...providerBlock(),
      ...shapeTest(test, { folderName: refs.folderName }),
      description: setup.description || null,
      schedulerCronValue: cronFor(test.schedule_start_time, test.every_days),
      campaignId: refs.campaignId,
      campaignName: refs.campaignName,
      campaignUnavailableReason: refs.campaignReason,
      sequenceStepId: refs.sequenceStepId,
      sequenceStepLabel: refs.sequenceStepLabel,
      sequenceStepUnavailableReason: refs.sequenceStepReason,
      folderUnavailableReason: refs.folderReason,
      providerId: provider.providerId,
      providerLabel: provider.providerLabel,
      providerUnavailableReason: provider.reason,
      stale: !configured('deliverability'),
    }
  }))

  // PUT /api/deliverability/tests/:testId/stop — stop-automated-test. Stopping
  // deletes nothing: only the status moves.
  api.put('/deliverability/tests/:testId/stop', handler((req) => {
    const test = ownedTest(req)

    const before = {
      runs: db.prepare('SELECT COUNT(*) n FROM deliverability_test_runs WHERE test_id = ?').get(test.id).n,
      reports: db.prepare('SELECT COUNT(*) n FROM deliverability_reports WHERE test_id = ?').get(test.id).n,
    }

    // Already stopped, or finished on its own, is success — the client should
    // never have to distinguish "I stopped it" from "it was already stopped".
    if (['stopped', 'completed'].includes(test.status)) {
      return {
        ...providerBlock(),
        ok: true,
        id: test.id,
        status: test.status,
        changed: false,
        runsKept: before.runs,
        cachedReportRowsKept: before.reports,
        message: `That test is already ${test.status}.`,
      }
    }

    const row = tx(() => {
      db.prepare(
        "UPDATE deliverability_tests SET status = 'stopped', schedule_start_time = '', updated_at = datetime('now') WHERE id = ? AND workspace_id = ?"
      ).run(test.id, req.wsId)
      return db.prepare('SELECT * FROM deliverability_tests WHERE id = ?').get(test.id)
    })

    reconcile(`stop:${test.id}`, () => upstream('stopTest', { providerTestId: test.provider_test_id || String(test.id) }))

    audit(req, { type: 'deliverability_test_stopped', detail: `${test.name} (#${test.id}) stopped at ${nowIso()}` })
    const stillActive = db.prepare(
      "SELECT COUNT(*) n FROM deliverability_tests WHERE workspace_id = ? AND status = 'active' AND COALESCE(deleted_at,'') = ''"
    ).get(req.wsId).n
    meter('deliverability.tests.stop', 0, true, `${stillActive} still active`)

    return {
      ...providerBlock(),
      ok: true,
      id: row.id,
      status: row.status,
      changed: true,
      runsKept: before.runs,
      cachedReportRowsKept: before.reports,
      message: 'Schedule stopped. Every run and every report is kept.',
    }
  }))

  // ====================================================== per-test reports ==

  // GET /api/deliverability/tests/:testId/authentication — the combined read
  // (spf-details ticket): DKIM, SPF and rDNS in one query, one shape.
  api.get('/deliverability/tests/:testId/authentication', handler((req) => {
    const started = Date.now()
    const test = ownedTest(req)
    const runNo = runNoOf(test)
    const rows = db.prepare(
      `SELECT * FROM deliverability_reports
        WHERE test_id = ? AND run_no = ? AND kind IN ('dkim','spf','rdns')`
    ).all(test.id, runNo)

    const byKind = new Map(rows.map((r) => [r.kind, r]))
    const checks = ['dkim', 'spf', 'rdns'].map((check) => {
      const row = byKind.get(check) || null
      return {
        check,
        groups: payloadOf(row, { groups: [] }).groups || [],
        fetchedAt: row ? row.fetched_at : null,
        stale: isStale(row),
        available: Boolean(row),
      }
    })

    reconcile(`auth:${test.id}`, async () => {
      for (const [key, kind] of [['dkimDetails', KIND.dkim], ['spfDetails', KIND.spf], ['rdnsReport', KIND.rdns]]) {
        const payload = await upstream(key, { providerTestId: test.provider_test_id || String(test.id) })
        storeReport(test.id, runNo, kind, '', { groups: Array.isArray(payload) ? payload : (payload?.data ?? []) })
      }
    })

    meter('deliverability.auth', Date.now() - started, true, `${checks.filter((c) => c.available).length}/3 cached`)
    return {
      ...providerBlock(),
      testId: test.id,
      runNo,
      checks,
      // One shape for all three, so one component renders them.
      stale: checks.every((c) => c.stale),
    }
  }))

  // The three per-check routes remain for a targeted refresh.
  for (const [route, kind, contract] of [
    ['dkim', KIND.dkim, 'dkimDetails'],
    ['spf', KIND.spf, 'spfDetails'],
    ['rdns', KIND.rdns, 'rdnsReport'],
  ]) {
    api.get(`/deliverability/tests/:testId/${route}`, handler((req) => {
      const test = ownedTest(req)
      const runNo = runNoOf(test)
      const row = cachedReport(test.id, runNo, kind)
      reconcile(`${kind}:${test.id}`, async () => {
        const payload = await upstream(contract, { providerTestId: test.provider_test_id || String(test.id) })
        storeReport(test.id, runNo, kind, '', { groups: Array.isArray(payload) ? payload : (payload?.data ?? []) })
      })
      // Grouping by from_email is preserved end to end — nothing is flattened.
      return reportEnvelope(test, row, { check: route, groups: payloadOf(row, { groups: [] }).groups || [] })
    }))
  }

  // GET /api/deliverability/tests/:testId/blacklist[?summary=1] — blacklists
  // and ip-blacklist-count. Both answers come from the same rows.
  api.get('/deliverability/tests/:testId/blacklist', handler((req) => {
    const started = Date.now()
    const test = ownedTest(req)
    const summary = blacklistSummary(test.id, 'ip')

    reconcile(`blacklist:${test.id}`, async () => {
      const payload = await upstream('blacklist', { providerTestId: test.provider_test_id || String(test.id) })
      storeBlacklist(test.id, 'ip', payload)
    })

    if (bool(req.query, 'summary', false)) {
      meter('deliverability.blacklist.summary', Date.now() - started, true, summary.state)
      return { ...providerBlock(), testId: test.id, ...summary }
    }

    const rows = db.prepare(
      "SELECT * FROM deliverability_blacklist WHERE test_id = ? AND kind = 'ip' ORDER BY value, provider"
    ).all(test.id)

    // Several seed rows can share one IP; a single listed IP is reported once,
    // not once per seed mailbox.
    const byIp = new Map()
    for (const row of rows) {
      const key = row.value || '(unknown)'
      if (!byIp.has(key)) byIp.set(key, { ip: key, totalBlacklist: 0, listings: [], checkedAt: row.checked_at })
      const group = byIp.get(key)
      if (row.listed) {
        group.totalBlacklist++
        group.listings.push({ blacklistTypeValue: row.provider, details: `Listed on ${row.provider}`, checkedAt: row.checked_at })
      } else {
        group.listings.push({ blacklistTypeValue: row.provider, details: `Not listed on ${row.provider}`, listed: false, checkedAt: row.checked_at })
      }
    }

    meter('deliverability.blacklist', Date.now() - started, true, `${rows.length} rows`)
    return {
      ...providerBlock(),
      testId: test.id,
      ...summary,
      available: rows.length > 0,
      stale: rows.length === 0,
      groups: [...byIp.values()],
    }
  }))

  // GET /api/deliverability/tests/:testId/domain-blacklist — domain-blacklist.
  // The domain rollup is computed once, server-side, from the same table.
  api.get('/deliverability/tests/:testId/domain-blacklist', handler((req) => {
    const test = ownedTest(req)
    const rows = db.prepare(
      "SELECT * FROM deliverability_blacklist WHERE test_id = ? AND kind = 'domain' ORDER BY value, provider"
    ).all(test.id)

    reconcile(`domain-blacklist:${test.id}`, async () => {
      const payload = await upstream('domainBlacklist', { providerTestId: test.provider_test_id || String(test.id) })
      storeBlacklist(test.id, 'domain', payload)
    })

    const byDomain = new Map()
    for (const row of rows) {
      const key = row.value || '(unknown)'
      if (!byDomain.has(key)) byDomain.set(key, { domain: key, blacklisted: false, listings: [], checkedAt: row.checked_at })
      const group = byDomain.get(key)
      if (row.listed) group.blacklisted = true
      group.listings.push({ provider: row.provider, listed: Boolean(row.listed), checkedAt: row.checked_at })
    }

    const summary = blacklistSummary(test.id, 'domain')
    return {
      ...providerBlock(),
      testId: test.id,
      ...summary,
      available: rows.length > 0,
      stale: rows.length === 0,
      groups: [...byDomain.values()],
    }
  }))

  // GET /api/deliverability/tests/:testId/counts — mailbox-count. `inboxRate`
  // is computed once, here, and is null when nothing has been delivered.
  api.get('/deliverability/tests/:testId/counts', handler((req) => {
    const test = ownedTest(req)
    const runNo = runNoOf(test)
    const row = cachedReport(test.id, runNo, KIND.counts)
    const raw = payloadOf(row, {})

    const inboxCount = Number(raw.inboxCount ?? raw.inbox_count ?? 0) || 0
    const spamCount = Number(raw.spamCount ?? raw.spam_count ?? 0) || 0
    const tabCount = Number(raw.tabCount ?? raw.tab_count ?? 0) || 0
    const failedCount = Number(raw.failedCount ?? raw.failed_count ?? 0) || 0
    const totalEmailCount = Number(raw.totalEmailCount ?? raw.total_email_count ?? 0) || 0

    reconcile(`counts:${test.id}`, async () => {
      const payload = await upstream('mailboxCount', { providerTestId: test.provider_test_id || String(test.id) })
      storeReport(test.id, runNo, KIND.counts, '', payload)
    })

    return reportEnvelope(test, row, {
      inboxCount,
      spamCount,
      // A Promotions tab is not an inbox: never folded into the inbox figure.
      tabCount,
      failedCount,
      totalEmailCount,
      inboxRate: rate(inboxCount, totalEmailCount),
      // The difference is shown rather than silently hidden.
      notYetDelivered: Math.max(0, totalEmailCount - (inboxCount + spamCount + tabCount + failedCount)),
      belowBenchmark: totalEmailCount > 0 && rate(inboxCount, totalEmailCount) < INBOX_BENCHMARK,
      benchmark: INBOX_BENCHMARK,
    })
  }))

  // GET /api/deliverability/tests/:testId/mailboxes — mailbox-summary.
  api.get('/deliverability/tests/:testId/mailboxes', handler((req) => {
    const test = ownedTest(req)
    const runNo = runNoOf(test)
    const row = cachedReport(test.id, runNo, KIND.mailboxes)
    const entries = asArray(payloadOf(row, []))

    reconcile(`mailboxes:${test.id}`, async () => {
      const payload = await upstream('mailboxSummary', { providerTestId: test.provider_test_id || String(test.id) })
      storeReport(test.id, runNo, KIND.mailboxes, '', payload)
    })

    // Matching an address to a connected mailbox is allowed to fail: an
    // unmatched address still renders, it just does not flag a mailbox.
    const find = db.prepare('SELECT id FROM mailboxes WHERE user_id = ? AND lower(email) = ?')
    const items = entries.map((entry) => {
      const fromEmail = String(entry.fromEmail ?? entry.from_email ?? '').toLowerCase()
      const match = fromEmail ? find.get(req.wsId, fromEmail) : null
      const total = Number(entry.totalEmailCount ?? entry.total_email_count ?? 0) || 0
      const inbox = Number(entry.inboxCount ?? entry.inbox_count ?? 0) || 0
      return {
        fromEmail: fromEmail || null,
        mailboxId: match ? match.id : null,
        matched: Boolean(match),
        esp: entry.esp ?? null,
        totalEmailCount: total,
        inboxCount: inbox,
        tabCount: Number(entry.tabCount ?? entry.tab_count ?? 0) || 0,
        spamCount: Number(entry.spamCount ?? entry.spam_count ?? 0) || 0,
        failedCount: Number(entry.failedCount ?? entry.failed_count ?? 0) || 0,
        placementScore: entry.placementScore ?? entry.placement_score ?? null,
        inboxRate: rate(inbox, total),
      }
    })

    return reportEnvelope(test, row, {
      items,
      unmatched: items.filter((i) => !i.matched).length,
      benchmark: INBOX_BENCHMARK,
    })
  }))

  // GET /api/deliverability/tests/:testId/providers — provider-report.
  // GET /api/deliverability/tests/:testId/regions   — geo-report.
  // One shape for both, so one component renders them.
  for (const [route, kind, contract, label] of [
    ['providers', KIND.providers, 'providerReport', 'provider'],
    ['regions', KIND.regions, 'geoReport', 'region'],
  ]) {
    api.get(`/deliverability/tests/:testId/${route}`, handler((req) => {
      const test = ownedTest(req)
      const runNo = runNoOf(test)
      const row = cachedReport(test.id, runNo, kind)
      const raw = payloadOf(row, {})

      reconcile(`${kind}:${test.id}`, async () => {
        const payload = await upstream(contract, { providerTestId: test.provider_test_id || String(test.id) })
        storeReport(test.id, runNo, kind, '', payload)
      })

      const status = String(raw.status ?? '')
      const result = asArray(raw.result).map((entry) => ({
        [label]: entry[label] ?? entry.name ?? null,
        // Rates are stored and served as numbers; nothing recomputes them.
        inboxRate: numberOrNull(entry.inboxRate ?? entry.inbox_rate),
        spamRate: numberOrNull(entry.spamRate ?? entry.spam_rate),
        bounceRate: numberOrNull(entry.bounceRate ?? entry.bounce_rate),
        mailboxCount: Number(entry.mailboxCount ?? entry.mailbox_count ?? 0) || 0,
        avgDeliveryTimeSeconds: numberOrNull(entry.avgDeliveryTimeSeconds ?? entry.avg_delivery_time_seconds),
      }))

      return reportEnvelope(test, row, {
        overallTotalCount: Number(raw.overallTotalCount ?? raw.overall_total_count ?? 0) || 0,
        status: status || null,
        // Figures from a test that has not finished are partial, and say so.
        partial: status !== 'completed',
        result,
        belowBenchmark: result.filter((r) => r.inboxRate !== null && r.inboxRate < INBOX_BENCHMARK).map((r) => r[label]),
        benchmark: INBOX_BENCHMARK,
      })
    }))
  }

  // GET /api/deliverability/tests/:testId/spam-filters — spam-filter-report.
  api.get('/deliverability/tests/:testId/spam-filters', handler((req) => {
    const test = ownedTest(req)
    const runNo = runNoOf(test)
    const row = cachedReport(test.id, runNo, KIND.spamFilters)
    const groups = asArray(payloadOf(row, { groups: [] }).groups)

    reconcile(`spam_filters:${test.id}`, async () => {
      const payload = await upstream('spamFilterReport', { providerTestId: test.provider_test_id || String(test.id) })
      storeReport(test.id, runNo, KIND.spamFilters, '', { groups: asArray(Array.isArray(payload) ? payload : payload?.data) })
    })

    let unclassified = 0
    const shaped = groups.map((group) => ({
      fromEmail: group.fromEmail ?? group.from_email ?? null,
      spamFilterDetails: asArray(group.spamFilterDetails ?? group.spam_filter_details).map((detail) => ({
        filter: detail.filter ?? null,
        triggeredCount: Number(detail.triggeredCount ?? detail.triggered_count ?? 0) || 0,
        triggerPercentage: numberOrNull(detail.triggerPercentage ?? detail.trigger_percentage),
        reasons: asArray(detail.reasons).map((reason) => {
          const reasonType = classifyReason(reason)
          if (reasonType === 'unknown') unclassified++
          // The raw string is returned unchanged; the classification sits
          // alongside it and is never a rewrite of it.
          return { reason: String(reason ?? ''), reasonType }
        }),
      })),
    }))

    if (unclassified) meter('deliverability.unclassified_reasons', 0, true, String(unclassified))

    return reportEnvelope(test, row, { groups: shaped, unclassifiedReasons: unclassified })
  }))

  // GET /api/deliverability/tests/:testId/ips — ip-details, with `whois_data`
  // flattened into named fields so a missing sub-field cannot crash rendering.
  api.get('/deliverability/tests/:testId/ips', handler((req) => {
    const test = ownedTest(req)
    const runNo = runNoOf(test)
    const row = cachedReport(test.id, runNo, KIND.ips)
    const entries = asArray(payloadOf(row, []))

    reconcile(`ips:${test.id}`, async () => {
      const payload = await upstream('ipDetails', { providerTestId: test.provider_test_id || String(test.id) })
      storeReport(test.id, runNo, KIND.ips, '', payload)
    })

    const items = entries.map((entry) => {
      const whois = entry.whoisData ?? entry.whois_data ?? {}
      return {
        ip: entry.ip ?? null,
        blacklisted: Boolean(entry.blacklisted),
        // The provider's own sentence is the only human-readable reputation
        // verdict in the payload, so it is served verbatim.
        summary: entry.summary ?? null,
        isp: whois.isp ?? null,
        organization: whois.organization ?? null,
        location: whois.location ?? null,
        reverseDns: whois.reverse_dns ?? whois.reverseDns ?? null,
        createdAt: entry.createdAt ?? entry.created_at ?? null,
      }
    })

    return reportEnvelope(test, row, { items })
  }))

  // GET /api/deliverability/tests/:testId/history — schedule-history, paged by
  // run number descending, with the rate derived once, here.
  api.get('/deliverability/tests/:testId/history', handler((req) => {
    const test = ownedTest(req)
    const { limit } = page(req.query, { defaultLimit: 25, maxLimit: 200 })
    const before = int(req.query, 'before', { min: 1, fallback: 0 })

    const args = [test.id]
    let clause = 'test_id = ?'
    if (before) { clause += ' AND run_no < ?'; args.push(before) }
    const rows = db.prepare(
      `SELECT * FROM deliverability_test_runs WHERE ${clause} ORDER BY run_no DESC LIMIT ?`
    ).all(...args, limit + 1)

    reconcile(`history:${test.id}`, async () => {
      const payload = await upstream('scheduleHistory', { providerTestId: test.provider_test_id || String(test.id) })
      storeRuns(test.id, payload)
    })

    const out = paged(rows, limit, 'run_no')
    const runs = out.items.map((run) => {
      const m = safeObject(run.metrics)
      const adjusted = Number(m.adjustedTotalEmailCount ?? m.adjusted_total_email_count ?? 0) || 0
      return {
        runNo: run.run_no,
        status: run.status,
        inboxCount: Number(m.inboxCount ?? m.inbox_count ?? 0) || 0,
        tabCount: Number(m.tabCount ?? m.tab_count ?? 0) || 0,
        spamCount: Number(m.spamCount ?? m.spam_count ?? 0) || 0,
        adjustedTotalEmailCount: adjusted,
        replyWindowStartHour: numberOrNull(m.replyWindowStartHour ?? m.reply_hour_interval_start),
        replyWindowEndHour: numberOrNull(m.replyWindowEndHour ?? m.reply_hour_interval_end),
        inboxRate: rate(Number(m.inboxCount ?? m.inbox_count ?? 0) || 0, adjusted),
        // What Harry's own tick did, kept in its own key names. A run it sent
        // ten seeds for has `adjustedTotalEmailCount: 0`, so `inboxRate` stays
        // null and the trend ignores it — a run nothing has graded must not be
        // plotted as a 0% inbox rate.
        seedsSent: Number(m.seedsSent ?? 0) || 0,
        seedsFailed: (Number(m.seedsFailed ?? 0) || 0) + (Number(m.seedsSuppressed ?? 0) || 0),
        placementObserved: Number(m.placementObserved ?? 0) || 0,
        placementSource: m.placementSource ?? null,
        // A run that has not completed is labelled partial and left out of the
        // trend; so is a run measured over a different window.
        partial: run.status !== 'completed',
        startedAt: run.started_at,
        finishedAt: run.finished_at || null,
      }
    })

    // The trend is computed over the most recent completed runs sharing one
    // measurement window, because a rate measured over 1 hour is not
    // comparable to one measured over 24.
    const comparable = runs.filter((r) => !r.partial && r.inboxRate !== null)
    const window = comparable.length ? comparable[0].replyWindowEndHour : null
    const sameWindow = comparable.filter((r) => r.replyWindowEndHour === window)
    const trend = sameWindow.length >= 2
      ? Math.round((sameWindow[0].inboxRate - sameWindow[1].inboxRate) * 1000) / 10
      : null

    return {
      ...providerBlock(),
      testId: test.id,
      runs,
      total: db.prepare('SELECT COUNT(*) n FROM deliverability_test_runs WHERE test_id = ?').get(test.id).n,
      limit,
      nextBefore: out.nextCursor,
      hasMore: out.hasMore,
      trendPoints: trend,
      trendBasis: sameWindow.length >= 2 ? [sameWindow[0].runNo, sameWindow[1].runNo] : [],
      stale: runs.length === 0,
    }
  }))

  // GET /api/deliverability/tests/:testId/senders — sender-list. Never
  // `client_id` or `user_id`.
  api.get('/deliverability/tests/:testId/senders', handler((req) => {
    const test = ownedTest(req)
    const rows = db.prepare(
      'SELECT * FROM deliverability_test_senders WHERE test_id = ? ORDER BY run_no DESC, id'
    ).all(test.id)

    reconcile(`senders:${test.id}`, async () => {
      const payload = await upstream('senderList', { providerTestId: test.provider_test_id || String(test.id) })
      storeSenders(req.wsId, test.id, runNoOf(test), payload)
    })

    // The match was made once at fetch time and stored, so a later
    // disconnection does not rewrite history.
    const connected = new Set(db.prepare('SELECT id FROM mailboxes WHERE user_id = ?').all(req.wsId).map((r) => r.id))
    const unmatched = rows.filter((r) => !r.mailbox_id).length
    if (rows.length) meter('deliverability.senders.unmatched', 0, true, `${unmatched}/${rows.length}`)

    return {
      ...providerBlock(),
      testId: test.id,
      items: rows.map((r) => ({
        senderId: r.seed_id || String(r.id),
        id: r.id,
        fromEmail: r.sender_email || null,
        // Which inbox the copy was addressed to. Half of a placement result is
        // the destination, and until now the list only ever showed the source.
        seedEmail: r.seed_email || null,
        mailboxId: r.mailbox_id || null,
        mailboxConnected: Boolean(r.mailbox_id && connected.has(r.mailbox_id)),
        runNo: r.run_no,
        sendStatus: r.send_status,
        placement: r.placement || null,
        createdAt: r.created_at,
        updatedAt: r.created_at,
      })),
      // Sent, but nobody has reported a folder. Stated rather than left for the
      // client to infer from a null, because "we do not know" and "it went
      // missing" are different answers and only one of them is bad news.
      awaitingPlacement: rows.filter((r) => r.send_status === SEED_STATUS.sent && !r.placement).length,
      awaitingSeeds: rows.filter((r) => r.send_status === SEED_STATUS.awaiting).length,
      placementSource: configured('deliverability') ? 'provider' : 'none',
      // An empty sender list is a misconfiguration, not a result.
      misconfigured: rows.length === 0,
      stale: rows.length === 0,
    }
  }))

  // GET /api/deliverability/tests/:testId/senders/report — sender-report.
  // Keyed on the address, so deleting a test never erases a mailbox's record.
  api.get('/deliverability/tests/:testId/senders/report', handler((req) => {
    const test = ownedTest(req)
    const runNo = runNoOf(test)
    const row = cachedReport(test.id, runNo, KIND.senderReport)
    const entries = asArray(payloadOf(row, []))

    reconcile(`sender_report:${test.id}`, async () => {
      const payload = await upstream('senderReport', { providerTestId: test.provider_test_id || String(test.id) })
      storeReport(test.id, runNo, KIND.senderReport, '', payload)
    })

    const find = db.prepare('SELECT id FROM mailboxes WHERE user_id = ? AND lower(email) = ?')
    const items = entries.map((entry) => {
      const fromEmail = String(entry.fromEmail ?? entry.from_email ?? '').toLowerCase()
      const details = entry.details ?? {}
      const match = fromEmail ? find.get(req.wsId, fromEmail) : null
      return {
        fromEmail: fromEmail || null,
        mailboxId: match ? match.id : null,
        senderName: entry.senderName ?? entry.sender_name ?? null,
        testsCount: Number(details.testsCount ?? details.tests_count ?? 0) || 0,
        avgInboxRate: numberOrNull(details.avgInboxRate ?? details.avg_inbox_rate),
        avgSpamRate: numberOrNull(details.avgSpamRate ?? details.avg_spam_rate),
        avgBounceRate: numberOrNull(details.avgBounceRate ?? details.avg_bounce_rate),
        reputationScore: numberOrNull(details.reputationScore ?? details.reputation_score),
        lastTestDate: details.lastTestDate ?? details.last_test_date ?? null,
      }
    })

    return reportEnvelope(test, row, { items })
  }))

  // GET /api/deliverability/tests/:testId/replies/:replyId/headers —
  // reply-headers. Fetched on demand, never stored, never logged.
  api.get('/deliverability/tests/:testId/replies/:replyId/headers', handler(async (req) => {
    const started = Date.now()
    const test = ownedTest(req)
    const replyId = String(req.params.replyId ?? '')
    if (!PROVIDER_ID_RE.test(replyId)) throw invalid('replyId', 'replyId is malformed')

    // When the test has sender rows, the reply must belong to one of them.
    // When it has none there is nothing to check against, so the fetch is
    // allowed and the answer says whether it could be served.
    const senders = db.prepare('SELECT id, seed_id FROM deliverability_test_senders WHERE test_id = ?').all(test.id)
    if (senders.length && !senders.some((s) => String(s.id) === replyId || s.seed_id === replyId)) {
      throw notFound('reply')
    }

    let headers = null
    let error = null
    if (configured('deliverability')) {
      try {
        const payload = await upstream('replyHeaders', {
          providerTestId: test.provider_test_id || String(test.id),
          replyId,
        })
        headers = payload && typeof payload === 'object' ? payload : null
      } catch (err) {
        error = err.status === 429 ? 'rate_limited' : 'unavailable'
      }
    }

    // Only the fact of the fetch, its latency and its status — never a header
    // value, which is why the detail below carries no payload.
    meter('deliverability.reply_headers', Date.now() - started, !error, error || '')

    return {
      ...providerBlock(),
      testId: test.id,
      replyId,
      // Every key present is returned; nothing is filtered to a hardcoded list,
      // because the useful header is often the unexpected one — including the
      // documented misspelling `Reveived-Spf`.
      headers,
      summary: parseAuthResults(headers),
      available: Boolean(headers),
      error,
      cached: false,
      message: headers ? '' : 'Headers are fetched live and are not stored — they are unavailable while no deliverability provider is connected.',
    }
  }))

  // GET /api/deliverability/tests/:testId/content — test-email-content.
  // Fetched on demand, never stored, and served with a strict contract.
  api.get('/deliverability/tests/:testId/content', handler(async (req, res) => {
    const started = Date.now()
    const test = ownedTest(req)

    let content = null
    let error = null
    if (configured('deliverability')) {
      try {
        content = await upstream('emailContent', { providerTestId: test.provider_test_id || String(test.id) })
      } catch (err) {
        error = err.status === 429 ? 'rate_limited' : 'unavailable'
      }
    }

    // Kept out of the app's own CSP scope: the client must render `html` only
    // inside a sandboxed frame, and nothing here may be sniffed into a script.
    res.set('Content-Security-Policy', "sandbox; default-src 'none'")
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Cache-Control', 'no-store')

    meter('deliverability.email_content', Date.now() - started, !error, error || '')

    return {
      ...providerBlock(),
      testId: test.id,
      subject: content?.subject ?? null,
      text: content?.text ?? null,
      html: content?.html ?? null,
      raw: content?.rawEmailContent ?? content?.raw ?? null,
      // Stated on the route, not left to the client to remember.
      htmlIsUntrusted: true,
      renderContract: 'Render `html` only inside a sandboxed iframe with scripts and remote loads blocked. Never inject it into the app document. Links are display-only.',
      available: Boolean(content),
      stored: false,
      error,
      message: content ? '' : 'Email content is fetched live and never stored — it is unavailable while no deliverability provider is connected.',
    }
  }))
}

// ---------------------------------------------------------------------------
// storage of reconciled payloads
// ---------------------------------------------------------------------------

function storeReport(testId, runNo, kind, ref, payload) {
  db.prepare(
    `INSERT INTO deliverability_reports (test_id, run_no, kind, ref, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (test_id, run_no, kind, ref)
     DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).run(testId, runNo, kind, ref, JSON.stringify(payload ?? null))
}

// Blocklist rows are replaced wholesale per kind inside one transaction, and
// deduped on (test, kind, value, provider) so a repeat fetch cannot double a
// count that the list and the detail both read.
function storeBlacklist(testId, kind, payload) {
  const rows = asArray(Array.isArray(payload) ? payload : payload?.data)
  tx(() => {
    db.prepare('DELETE FROM deliverability_blacklist WHERE test_id = ? AND kind = ?').run(testId, kind)
    const seen = new Set()
    const ins = db.prepare(
      "INSERT INTO deliverability_blacklist (test_id, kind, value, provider, listed, checked_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    )
    for (const row of rows) {
      const value = String(kind === 'ip' ? (row.ip ?? '') : (row.domain ?? deriveDomain(row.from_email ?? row.fromEmail))).trim()
      const provider = String(row.blacklist_type_value ?? row.blacklistTypeValue ?? row.provider ?? '').trim()
      const key = `${value}|${provider}`
      if (seen.has(key)) continue
      seen.add(key)
      const listed = kind === 'ip'
        ? (Number(row.total_blacklist ?? row.totalBlacklist ?? 0) > 0 ? 1 : 0)
        : (row.blacklisted ? 1 : 0)
      ins.run(testId, kind, value, provider, listed)
    }
  })
}

// The domain is derived server-side, once, so the rollup is not recomputed in
// two places and cannot drift from the per-address rows.
function deriveDomain(fromEmail) {
  const value = String(fromEmail ?? '').toLowerCase()
  return value.includes('@') ? value.split('@')[1] : ''
}

function storeRuns(testId, payload) {
  const rows = asArray(Array.isArray(payload) ? payload : payload?.data)
  tx(() => {
    // Keyed on (test_id, run_no) so a re-fetch updates rather than duplicates.
    const up = db.prepare(
      `INSERT INTO deliverability_test_runs (test_id, run_no, status, metrics)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (test_id, run_no)
       DO UPDATE SET status = excluded.status, metrics = excluded.metrics`
    )
    for (const row of rows) {
      const runNo = Number(row.test_run_no ?? row.runNo ?? 0)
      if (!Number.isInteger(runNo) || runNo <= 0) continue
      up.run(testId, runNo, String(row.status ?? 'running'), JSON.stringify({
        inboxCount: Number(row.inbox_count ?? 0) || 0,
        tabCount: Number(row.tab_count ?? 0) || 0,
        spamCount: Number(row.spam_count ?? 0) || 0,
        adjustedTotalEmailCount: Number(row.adjusted_total_email_count ?? 0) || 0,
        replyWindowStartHour: Number(row.reply_hour_interval_start ?? 0) || 0,
        replyWindowEndHour: Number(row.reply_hour_interval_end ?? 0) || 0,
      }))
    }
  })
}

function storeSenders(wsId, testId, runNo, payload) {
  const rows = asArray(Array.isArray(payload) ? payload : payload?.data)
  tx(() => {
    const find = db.prepare('SELECT id FROM mailboxes WHERE user_id = ? AND lower(email) = ?')
    const existing = db.prepare('SELECT seed_id FROM deliverability_test_senders WHERE test_id = ? AND run_no = ?').all(testId, runNo)
    const known = new Set(existing.map((r) => r.seed_id).filter(Boolean))
    const ins = db.prepare(
      'INSERT INTO deliverability_test_senders (test_id, run_no, mailbox_id, sender_email, seed_id, send_status) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
      const seedId = String(row.id ?? row.seed_id ?? '').trim()
      if (!seedId || known.has(seedId)) continue
      const fromEmail = String(row.from_email ?? row.fromEmail ?? '').toLowerCase()
      const match = fromEmail ? find.get(wsId, fromEmail) : null
      ins.run(testId, runNo, match ? match.id : null, fromEmail, seedId, 'sent')
    }
  })
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

// Defensive by design: any parse failure yields a null summary rather than an
// error, because the raw block is always the source of truth.
export function parseAuthResults(headers) {
  if (!headers || typeof headers !== 'object') return null
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'authentication-results')
  if (!key) return null
  const raw = Array.isArray(headers[key]) ? headers[key].join(' ') : String(headers[key] ?? '')
  if (!raw) return null
  const verdict = (name) => {
    const m = new RegExp(`\\b${name}=([a-z]+)`, 'i').exec(raw)
    return m ? m[1].toLowerCase() : null
  }
  const summary = { dkim: verdict('dkim'), spf: verdict('spf'), dmarc: verdict('dmarc') }
  return summary.dkim || summary.spf || summary.dmarc ? summary : null
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function safeObject(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}
