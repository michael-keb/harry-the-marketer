// smart-senders — sending infrastructure procurement (Docs/smart-senders/*.md,
// 7 endpoints).
//
// This is the only category in the backlog that spends money, and the only one
// whose §5 stories are mostly about restraint. Four rules run through every
// line of this file:
//
//   1. Harry never handles a payment instrument. No route here accepts a card
//      number, a CVV, a token or any other payment credential — a request
//      carrying one is refused with 422 and nothing is written. The supplier's
//      own checkout holds the instrument; Harry stores an order reference.
//      place-order.md §5 is explicit that if the commercial arrangement would
//      require Harry to collect card details directly, "this story does not
//      ship — that is a deliberate stop, not a gap to fill later".
//   2. Ordering is gated on an explicit user action and is idempotent. The
//      idempotency key is generated when the summary screen opens and accepted
//      exactly once; the UNIQUE (workspace_id, idempotency_key) index on
//      sender_orders is the real guard, not the lookup before it.
//   3. Retries are never automatic. The supplier call is made with retries
//      disabled, because providers.js's exponential backoff is right for a read
//      and catastrophic for a purchase. A timeout leaves the order `pending`,
//      to be reconciled by GET /senders/orders/:ref, and never re-posted.
//   4. Secrets pass through or not at all. Billing details are AES-256-GCM at
//      rest and absent from every response and every log line; a one-time code
//      is read once, never stored, never logged, never cached; a supplier
//      mailbox password is stripped before the row is constructed and revealed
//      only on an explicit request.
//
// With no marketplace provider configured (SENDERS_API_URL / SENDERS_API_KEY)
// every route below still exists, still validates, still reads and writes
// Harry's own rows, and says `configured: false`. Nothing is faked.

import crypto from 'node:crypto'
import { db } from '../db.js'
import { configured, call, unconfigured } from './providers.js'
import {
  HttpError, invalid, notFound, handler,
  str, int, page, paged, tx, audit, meter,
} from './http.js'

const ENV_VARS = ['SENDERS_API_URL', 'SENDERS_API_KEY']

// search-domain.md: "results are priced at fifteen dollars or less". Filtered
// server-side as defence in depth so a supplier cannot upsell past the ceiling
// the UI states above the list.
const PRICE_CEILING = 15

// auto-generate.md AC 5: count is bounded "before the request with a message
// naming a sensible range". Ten mailboxes on one new domain is already more
// than the warm-up advice supports.
const MAX_SUGGEST_PER_DOMAIN = 10
const MAX_SUGGEST_DOMAINS = 20

// place-order.md: a purchase is a single explicit decision, so the supplier
// call gets one attempt and a short deadline. Never a retry.
const ORDER_TIMEOUT_MS = 20_000

// ---- payment instruments: refused, never handled ----------------------------

// Anything that smells like a payment instrument. The value is never read,
// never hashed, never logged — only its presence, and only to refuse it. The
// list covers the obvious spellings plus the tokenised forms, because a token
// that can be charged is a payment credential too.
const PAYMENT_FIELDS = new Set([
  'card', 'card_number', 'cardnumber', 'cardno', 'card_no', 'pan',
  'cvv', 'cvc', 'cvv2', 'csc', 'security_code', 'securitycode', 'card_cvc', 'card_cvv',
  'exp_month', 'exp_year', 'expmonth', 'expyear', 'card_expiry', 'cardexpiry', 'expiry',
  'card_holder', 'cardholder', 'card_holder_name', 'cardholdername',
  'payment_method', 'paymentmethod', 'payment_details', 'paymentdetails',
  'payment_token', 'paymenttoken', 'card_token', 'cardtoken', 'stripe_token', 'stripetoken',
  'payment_source', 'paymentsource', 'payment_instrument', 'paymentinstrument',
  'iban', 'bic', 'swift', 'sort_code', 'sortcode',
  'account_number', 'accountnumber', 'routing_number', 'routingnumber',
  'bank_account', 'bankaccount', 'billing_card', 'billingcard',
])

// An exact list is the wrong shape for this job on its own: it has to be
// complete to be safe, and it was not — `credit_card` and `paypal_email` both
// walked straight past it, because the list had `card` and no notion of PayPal
// at all. Nothing leaked (no route reads these fields), but the stated
// invariant is "Harry never handles a payment instrument", and a guard that
// only refuses the spellings someone thought of does not establish it.
//
// So: patterns as well, anchored on the normalised underscore form. `card`
// matches `credit_card` and `card_number` but not `wildcard` or `discard`,
// because those have no separator — which is the false positive worth avoiding,
// since refusing a legitimate field is a broken order rather than a safe one.
const PAYMENT_PATTERNS = [
  /(^|_)(credit|debit|charge|gift|prepaid)_?cards?(_|$)/,
  /(^|_)cards?(_|$)/,
  /paypal/,
  /(^|_)(bank|billing)_?(account|details|info)(_|$)/,
  /(^|_)(iban|bic|swift|pan)(_|$)/,
  /(^|_)(cvv|cvc|csc)\d?(_|$)/,
  /(^|_)(routing|sort)_?(number|code)(_|$)/,
  /(^|_)(payment|payout)_/,
  /_token$/,
]

const PAYMENT_REFUSAL =
  'Harry never accepts, stores or forwards a payment instrument. The supplier\'s own ' +
  'checkout holds the card and Harry keeps only the order reference — remove this field ' +
  'and pay through the supplier.'

// Depth-limited so a deliberately nested body cannot turn validation into a
// stack overflow. Runs before anything is written, so a refused request leaves
// no row behind.
// Exported so the guard can be probed field by field. The invariant it defends
// — Harry never handles a payment instrument — deserves a test that names the
// spellings, not one that posts a single body and calls it covered.
export function rejectPaymentInstruments(value, path = '', depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, i) => rejectPaymentInstruments(item, `${path}[${i}]`, depth + 1))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    const normal = key.toLowerCase().replace(/[\s-]/g, '_')
    if (
      PAYMENT_FIELDS.has(normal) ||
      PAYMENT_FIELDS.has(normal.replace(/_/g, '')) ||
      PAYMENT_PATTERNS.some((re) => re.test(normal))
    ) {
      throw invalid(path ? `${path}.${key}` : key, PAYMENT_REFUSAL)
    }
    rejectPaymentInstruments(child, path ? `${path}.${key}` : key, depth + 1)
  }
}

// ---- billing details: encrypted at rest, never in a response ----------------

// The key is derived once per distinct env value with scrypt, then cached: a
// per-request derivation would put 100ms on every order. Reading the env lazily
// rather than at import time means a deployment can add the key without a code
// change, and a test can decide what it is.
const KEY_CACHE = new Map()
const KEY_SALT = 'harry-the-marketer/sender-billing/v1'

function billingKey() {
  const raw = process.env.SENDERS_BILLING_KEY || ''
  if (!raw) return null
  let key = KEY_CACHE.get(raw)
  if (!key) {
    key = crypto.scryptSync(raw, KEY_SALT, 32)
    KEY_CACHE.set(raw, key)
  }
  return key
}

// AES-256-GCM. The authentication tag travels with the ciphertext, so a
// tampered or truncated blob fails to decrypt rather than yielding rubbish.
function encryptBilling(details) {
  const key = billingKey()
  if (!key) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(details), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.')
}

function decryptBilling(blob) {
  const key = billingKey()
  if (!key || !blob) return null
  const parts = String(blob).split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'))
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'))
    const out = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()])
    return JSON.parse(out.toString('utf8'))
  } catch {
    // A key rotation makes old rows unreadable. That is the correct failure:
    // the user is asked for their details again rather than shown a 500.
    return null
  }
}

function billingOnFile(wsId) {
  const row = db.prepare('SELECT encrypted FROM sender_billing_details WHERE workspace_id = ?').get(wsId)
  return Boolean(row && row.encrypted)
}

function readBilling(wsId) {
  const row = db.prepare('SELECT encrypted FROM sender_billing_details WHERE workspace_id = ?').get(wsId)
  return row ? decryptBilling(row.encrypted) : null
}

// Refuses to store rather than storing in the clear, and says so. The order is
// not blocked by it — the details still reach the supplier for this one order,
// they are simply not kept for the next one.
function storeBilling(wsId, details) {
  const encrypted = encryptBilling(details)
  if (!encrypted) {
    return {
      stored: false,
      reason: 'SENDERS_BILLING_KEY is not set, so Harry will not store your billing details — ' +
        'storing them unencrypted is not an option it offers. They were used for this order only ' +
        'and the next order will ask again.',
    }
  }
  db.prepare(
    `INSERT INTO sender_billing_details (workspace_id, encrypted) VALUES (?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET encrypted = excluded.encrypted, updated_at = datetime('now')`
  ).run(wsId, encrypted)
  return { stored: true, reason: '' }
}

// ---- rate limiting ----------------------------------------------------------

// Fixed windows in memory. Enough for the two things the specs actually ask
// for: a typing user must not hammer a third party, and a one-time-code route
// must not become an oracle someone can probe.
const windows = new Map()

function hit(key, { max, windowMs }) {
  const now = Date.now()
  if (windows.size > 2000) {
    for (const [k, v] of windows) if (now - v.start >= v.windowMs) windows.delete(k)
  }
  const rec = windows.get(key)
  if (!rec || now - rec.start >= rec.windowMs) {
    windows.set(key, { start: now, n: 1, windowMs })
    return { allowed: true, count: 1, retryAfter: 0 }
  }
  rec.n += 1
  const retryAfter = Math.max(1, Math.ceil((rec.start + rec.windowMs - now) / 1000))
  return { allowed: rec.n <= max, count: rec.n, retryAfter }
}

function limit(key, opts, message) {
  const out = hit(key, opts)
  if (!out.allowed) {
    throw new HttpError(429, {
      error: 'rate_limited',
      message,
      retry_after_seconds: out.retryAfter,
      recent_requests: out.count,
    })
  }
  return out
}

// ---- small helpers ----------------------------------------------------------

function safeJson(raw, fallback) {
  try { const v = JSON.parse(raw || ''); return v ?? fallback } catch { return fallback }
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const LOCAL_RE = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/

function domainField(source, field, { required = false, fallback = '' } = {}) {
  const raw = str(source, field, { required, max: 253, fallback })
  if (!raw) return fallback
  const value = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
  if (!DOMAIN_RE.test(value)) throw invalid(field, `${field} must be a domain such as example.com`)
  return value
}

// A required field inside a nested structure, reported by its full path. `str`
// names the key it was handed, which is right for a flat body and useless for
// `domains[0].mailbox_details[1]` — the whole point of naming the field is to
// let the UI mark the offending row. The first spelling in `keys` is the
// canonical one; the rest are accepted aliases.
function requiredField(source, prefix, keys, max = 320) {
  const canonical = `${prefix}.${keys[0]}`
  const found = keys.find((k) => source?.[k] !== undefined && source?.[k] !== null && source?.[k] !== '')
  if (!found) throw invalid(canonical, `${canonical} is required`)
  const value = String(source[found]).trim()
  if (!value) throw invalid(canonical, `${canonical} is required`)
  if (value.length > max) throw invalid(canonical, `${canonical} must be ${max} characters or fewer`)
  return value
}

function esc(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`)
}

// The mailbox-count join, case-insensitive and subdomain-aware: a mailbox at
// news.acme.com counts towards acme.com (domain-list.md §5 DoD).
function mailboxCount(wsId, domain) {
  const d = esc(String(domain).toLowerCase())
  return db.prepare(
    `SELECT COUNT(*) AS n FROM mailboxes
      WHERE user_id = ? AND deleted_at IS NULL
        AND (lower(email) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\')`
  ).get(wsId, `%@${d}`, `%.${d}`).n
}

function ownerOf(wsId) {
  return db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(wsId) || { email: '', name: '' }
}

// ---- "as of" ----------------------------------------------------------------

// domain-list.md AC 7: when the supplier is unreachable the stored list is
// shown "with an 'as of' time rather than an empty panel". That time has to be
// when Harry last heard from the supplier. It used to be the `created_at` of
// the most recently inserted domain row, which answers a different question
// entirely — a workspace that bought a domain in March and lost its supplier in
// August was told its ownership data was "as of March", and a workspace whose
// rows all came from an order rather than a sync was given a date on which no
// sync had ever happened. Neither is a refresh time, and a stale-data notice
// that lies about its own age is worse than none.
const SYNC_KEY = (wsId) => `sender_domains_synced_at:${wsId}`

function markDomainSync(wsId) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SYNC_KEY(wsId), new Date().toISOString())
}

function lastDomainSync(wsId) {
  return db.prepare('SELECT value FROM kv WHERE key = ?').get(SYNC_KEY(wsId))?.value || null
}

// ---- the supplier seam ------------------------------------------------------

// Every marketplace call in this module goes through one of these, so the
// timeout and no-retry rules are stated once. `attempt` never throws: a
// supplier failure is data, not an exception, because in this category the
// difference between "it failed" and "we do not know" is the whole story.
const supplier = {
  async attempt(path, options) {
    if (!configured('senders')) return { ok: false, reason: 'unconfigured', payload: null }
    const started = Date.now()
    try {
      const payload = await call('senders', path, options)
      meter('senders.supplier', Date.now() - started, true, path)
      return { ok: true, reason: '', payload }
    } catch (err) {
      const reason = err?.code === 'timeout' ? 'timeout' : 'error'
      meter('senders.supplier', Date.now() - started, false, `${path}: ${reason}`)
      return { ok: false, reason, payload: null, status: err?.status || 0 }
    }
  },
}

// Test seam. The timeout branch of place-order is the single most important
// behaviour in this file and it cannot be exercised over a real network in a
// unit test, so it is overridable — and only under NODE_ENV=test, so a
// production process cannot have its supplier replaced from anywhere.
export function __setSupplierForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('supplier override is test-only')
  supplier.attempt = fn || supplier.attempt
}

// ---- presenters -------------------------------------------------------------

// order-details.md §5: the `password` a supplier may return alongside an
// address is stripped here, before a row is ever constructed. What comes out is
// safe to store, safe to log and safe to serialise; what is stripped is handed
// to the caller separately and held nowhere.
const CREDENTIAL_KEYS = ['password', 'passwd', 'pass', 'secret', 'credential', 'credentials', 'token', 'otp', 'auth_secret']

function splitCredentials(accounts) {
  const safe = []
  const credentials = []
  for (const raw of Array.isArray(accounts) ? accounts : []) {
    if (typeof raw === 'string') { safe.push({ address: raw.toLowerCase() }); continue }
    if (!raw || typeof raw !== 'object') continue
    const entry = {}
    let credential = ''
    for (const [key, value] of Object.entries(raw)) {
      if (CREDENTIAL_KEYS.includes(key.toLowerCase())) {
        if (!credential && value) credential = String(value)
        continue
      }
      entry[key] = value
    }
    const address = String(entry.address || entry.email || entry.mailbox || '').toLowerCase()
    if (address) entry.address = address
    safe.push(entry)
    if (credential && address) credentials.push({ address, credential })
  }
  return { safe, credentials }
}

// When the domains an order bought stop being the buyer's.
//
// `sender_orders` has no expiry column of its own and this module may not add
// one, so the date is read back from the `sender_domains` rows the order
// created — which is where reconciliation already writes the supplier's
// `expires_at`. The earliest is the one that matters: an order is only good for
// as long as its first domain lasts. Absent until a supplier has actually said,
// rather than invented from the order date.
function orderExpiry(row) {
  const found = db.prepare(
    `SELECT MIN(NULLIF(expires_at, '')) AS at FROM sender_domains
      WHERE workspace_id = ? AND order_ref = ?`
  ).get(row.workspace_id, row.order_ref)
  return found?.at || null
}

// Built field by field rather than by deleting from the row, so a column added
// to sender_orders later cannot leak into a response by default.
function presentOrder(row) {
  const expiresAt = orderExpiry(row)
  return {
    order_ref: row.order_ref,
    vendor_id: row.vendor_id,
    status: row.status,
    forwarding_domain: row.forwarding_domain,
    domains: safeJson(row.domains, []),
    mailboxes: safeJson(row.mailboxes, []),
    total: row.total,
    currency: row.currency,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // order-details.md AC 1 names `expires_at`, and AC 5 asks the order to read
    // as expired once the date has passed. `null` means the supplier has not
    // told us yet — which is not the same as "does not expire".
    expires_at: expiresAt,
    expired: Boolean(expiresAt && Date.parse(expiresAt) < Date.now()),
  }
}

function presentVendor(row) {
  const payload = safeJson(row.payload, {})
  return {
    vendor_id: row.provider_vendor_id,
    name: row.name || payload.name || row.provider_vendor_id,
    currency: row.currency || 'USD',
    // Unknown fields pass through untouched: get-vendors.md AC 3 requires the
    // client to tolerate a vendor with no price and no description, so the
    // server does not invent either.
    details: payload,
    fetched_at: row.fetched_at,
  }
}

function presentDomain(wsId, row) {
  const count = mailboxCount(wsId, row.domain)
  return {
    domain: row.domain,
    vendor_id: row.vendor_id,
    status: row.status,
    order_ref: row.order_ref,
    forwarding_domain: row.forwarding_domain,
    expires_at: row.expires_at || null,
    expired: Boolean(row.expires_at && Date.parse(row.expires_at) < Date.now()),
    mailbox_count: count,
    // domain-list.md AC 5: a paid domain doing nothing is worth surfacing.
    unused: count === 0,
    details: safeJson(row.payload, {}),
    created_at: row.created_at,
  }
}

// ---- suggestion -------------------------------------------------------------

// auto-generate.md AC 4: Harry's composer is required to say honestly who is
// writing, so suggestions are built from a real person already named in the
// workspace — the owner, or a connected mailbox's display name — and never
// from an invented persona. With no name to work from, the owner's own address
// is the honest fallback.
function senderIdentity(wsId) {
  const owner = ownerOf(wsId)
  const mailbox = db.prepare(
    "SELECT display_name, email FROM mailboxes WHERE user_id = ? AND deleted_at IS NULL AND IFNULL(display_name, '') != '' ORDER BY id LIMIT 1"
  ).get(wsId)
  const name = String(owner.name || mailbox?.display_name || '').trim()
  const parts = name.split(/\s+/).filter(Boolean)
  const first = parts[0] || String(owner.email || '').split('@')[0] || 'hello'
  const last = parts.length > 1 ? parts[parts.length - 1] : ''
  return {
    first_name: first,
    last_name: last,
    source: name ? 'workspace briefing' : 'workspace owner address',
  }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24)
}

function suggestFor(domain, count, identity) {
  const first = slug(identity.first_name) || 'hello'
  const last = slug(identity.last_name)
  const stems = last
    ? [first, `${first}.${last}`, `${first}${last[0]}`, `${first}.${last[0]}`, `${first[0]}${last}`]
    : [first, `${first}.team`, `${first}.outreach`, `${first}1`, `${first}2`]

  const out = []
  const seen = new Set()
  let n = 1
  while (out.length < count) {
    const base = stems[out.length % stems.length]
    let local = out.length < stems.length ? base : `${base}${n++}`
    while (seen.has(local)) local = `${base}${n++}`
    if (!LOCAL_RE.test(local)) { local = `${first}${n++}` ; if (!LOCAL_RE.test(local)) break }
    seen.add(local)
    out.push({
      mailbox: `${local}@${domain}`,
      first_name: identity.first_name,
      last_name: identity.last_name,
    })
  }
  return out
}

// Whatever the supplier proposes is checked to be on one of the domains the
// user is actually buying and to be a syntactically valid address; anything
// else is dropped, so a supplier cannot slip an off-domain address into a list
// the user is about to order (auto-generate.md §5).
function keepOnDomain(rows, domain) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(rows) ? rows : []) {
    const address = String(
      (typeof raw === 'string' ? raw : raw?.mailbox || raw?.address || raw?.email) || ''
    ).toLowerCase().trim()
    if (!address.endsWith(`@${domain}`)) continue
    const local = address.slice(0, -(domain.length + 1))
    if (!LOCAL_RE.test(local) || seen.has(address)) continue
    seen.add(address)
    out.push({
      mailbox: address,
      first_name: String(raw?.first_name || raw?.firstName || '').trim(),
      last_name: String(raw?.last_name || raw?.lastName || '').trim(),
    })
  }
  return out
}

// ---- order parsing ----------------------------------------------------------

// place-order.md AC 3. `state` and `languagePreference` are the two the source
// lists that a real address may honestly lack or not care about: a great many
// countries have no state, and a language preference has a sane default. Every
// other field is required, because they are what the registrant record is made
// of and a half-filled registration is a failed order.
const BILLING_REQUIRED = [
  'email', 'firstName', 'lastName', 'company',
  'country', 'city', 'addressLineOne', 'postalCode', 'phoneCc', 'phone',
]
const BILLING_OPTIONAL = ['state', 'addressLineTwo', 'languagePreference']

function parseBilling(body, wsId) {
  const raw = body?.user_details ?? body?.userDetails
  if (raw === undefined || raw === null) {
    // Collected once and reused, so a second order does not ask again.
    const stored = readBilling(wsId)
    if (stored) return { details: stored, reused: true }
    throw invalid('user_details', 'user_details is required — it is passed to the supplier as the domain registrant')
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('user_details', 'user_details must be an object')
  }
  const details = {}
  for (const field of BILLING_REQUIRED) {
    // Reported as `user_details.postalCode`, not `postalCode`, so the form
    // marks the right input.
    details[field] = requiredField(raw, 'user_details', [field, field.toLowerCase()])
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(details.email)) {
    throw invalid('user_details.email', 'user_details.email must be a valid email address')
  }
  for (const field of BILLING_OPTIONAL) {
    const value = str(raw, field, { max: 320, fallback: '' })
    if (value) details[field] = value
  }
  if (!details.languagePreference) details.languagePreference = 'en'
  return { details, reused: false }
}

function parseDomains(body, wsId) {
  const raw = body?.domains
  if (!Array.isArray(raw)) throw invalid('domains', 'domains must be an array of { domain_name, mailbox_details }')
  if (!raw.length) throw invalid('domains', 'Choose at least one domain')
  if (raw.length > MAX_SUGGEST_DOMAINS) {
    throw invalid('domains', `domains may contain at most ${MAX_SUGGEST_DOMAINS} domains in one order`)
  }

  const out = []
  const seenDomains = new Set()
  const seenAddresses = new Set()
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') throw invalid(`domains[${i}]`, `domains[${i}] must be an object`)
    const name = domainField(
      { v: entry.domain_name ?? entry.domainName ?? entry.domain },
      'v',
      { required: true }
    )
    if (seenDomains.has(name)) throw invalid(`domains[${i}].domain_name`, `${name} appears twice in this order`)
    seenDomains.add(name)

    const rows = entry.mailbox_details ?? entry.mailboxDetails
    if (!Array.isArray(rows) || !rows.length) {
      throw invalid(`domains[${i}].mailbox_details`, `domains[${i}].mailbox_details must list at least one mailbox`)
    }
    if (rows.length > MAX_SUGGEST_PER_DOMAIN) {
      throw invalid(
        `domains[${i}].mailbox_details`,
        `at most ${MAX_SUGGEST_PER_DOMAIN} mailboxes per domain — fewer, well-warmed mailboxes beat many cold ones`
      )
    }

    const mailboxes = rows.map((row, j) => {
      const at = `domains[${i}].mailbox_details[${j}]`
      if (!row || typeof row !== 'object') throw invalid(at, `${at} must be an object`)
      const mailbox = requiredField(row, at, ['mailbox', 'address', 'email']).toLowerCase()
      const firstName = requiredField(row, at, ['first_name', 'firstName'], 120)
      const lastName = requiredField(row, at, ['last_name', 'lastName'], 120)

      const address = mailbox.includes('@') ? mailbox : `${mailbox}@${name}`
      const [local, host] = address.split('@')
      if (host !== name) throw invalid(`${at}.mailbox`, `${address} is not on ${name}`)
      if (!LOCAL_RE.test(local)) throw invalid(`${at}.mailbox`, `${address} is not a valid mailbox address`)
      if (seenAddresses.has(address)) throw invalid(`${at}.mailbox`, `${address} appears twice in this order`)
      seenAddresses.add(address)

      const entryOut = { address, first_name: firstName, last_name: lastName }
      // parent_account_id links a new mailbox to one Harry already has. It is
      // resolved against this workspace's mailboxes so an order cannot claim a
      // link to somebody else's account.
      const parent = row.parent_account_id ?? row.parentAccountId
      if (parent !== undefined && parent !== null && parent !== '') {
        const id = int({ v: parent }, 'v', { required: true, min: 1 })
        const owned = db.prepare('SELECT id FROM mailboxes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, wsId)
        entryOut.parent_account_id = owned ? id : null
        if (!owned) entryOut.parent_account_note = 'unresolved'
      }
      return entryOut
    })

    out.push({ domain_name: name, mailbox_details: mailboxes })
  })
  return out
}

function orderRef() {
  // Harry's own reference, minted before the supplier is called, so a timeout
  // still leaves the user something to quote. A supplier reference, when one
  // arrives, is recorded beside it rather than replacing it.
  return `HTM-ORD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`
}

function findOrder(wsId, ref) {
  const value = String(ref || '').trim()
  if (!value) throw notFound('order')
  const row = db.prepare('SELECT * FROM sender_orders WHERE workspace_id = ? AND order_ref = ?').get(wsId, value)
  if (!row) throw notFound('order')
  return row
}

// Supplier statuses mapped onto the four the schema allows. `completed` is the
// supplier's word for what sender_orders calls `placed`.
function mapStatus(raw, fallback) {
  const value = String(raw || '').toLowerCase()
  if (['completed', 'complete', 'placed', 'success', 'succeeded', 'fulfilled'].includes(value)) return 'placed'
  if (['failed', 'error', 'declined', 'rejected'].includes(value)) return 'failed'
  if (['cancelled', 'canceled', 'refunded'].includes(value)) return 'cancelled'
  if (['pending', 'processing', 'in_progress', 'queued'].includes(value)) return 'pending'
  return fallback
}

// ---- routes -----------------------------------------------------------------

export function register(api) {
  // ------------------------------------------------------------- vendors ----
  // Reference data, not workspace data: the table is unscoped and refreshed
  // from the supplier when one is configured. Listing suppliers is not an
  // auditable act, so nothing goes to `events` (get-vendors.md §5).
  api.get('/senders/vendors', handler(async (req) => {
    const started = Date.now()
    const { limit: max, cursor } = page(req.query, { defaultLimit: 50, maxLimit: 200 })
    limit(`senders.vendors:${req.wsId}`, { max: 60, windowMs: 60_000 }, 'Too many supplier lookups. Try again shortly.')

    // Always through the seam: with no credentials it answers "unconfigured"
    // rather than throwing, so there is one code path for "we have no fresh
    // data" whether the cause is a missing key, a timeout or a 500.
    const res = await supplier.attempt('/api/v1/smart-senders/get-vendors', { timeoutMs: 8000 })
    const live = res.ok
    if (res.ok) {
      const rows = Array.isArray(res.payload?.data) ? res.payload.data : []
      tx(() => {
        for (const row of rows) {
          const id = String(row?.id ?? row?.vendor_id ?? row?.vendorId ?? '').trim()
          if (!id) continue
          db.prepare(
            `INSERT INTO sender_vendors (provider_vendor_id, name, currency, payload, fetched_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(provider_vendor_id) DO UPDATE SET
               name = excluded.name, currency = excluded.currency,
               payload = excluded.payload, fetched_at = excluded.fetched_at`
          ).run(id, String(row?.name || ''), String(row?.currency || 'USD'), JSON.stringify(row ?? {}))
        }
      })
    }

    const args = []
    let where = '1 = 1'
    if (cursor) { where += ' AND id < ?'; args.push(cursor) }
    const rows = db.prepare(`SELECT * FROM sender_vendors WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...args, max + 1)
    const out = paged(rows, max)

    meter('senders.vendors', Date.now() - started, true, `${out.items.length} vendor(s)`)
    return {
      ok: true,
      data: out.items.map(presentVendor),
      nextCursor: out.nextCursor,
      hasMore: out.hasMore,
      configured: configured('senders'),
      live,
      // get-vendors.md AC 7: prices may be shown, but nothing in Harry takes a
      // purchase decision on the user's behalf. This is what the UI disables
      // the Buy action on.
      billing_on_file: billingOnFile(req.wsId),
      billing_storage_available: Boolean(billingKey()),
      ...(configured('senders') ? {} : unconfigured('senders', ENV_VARS)),
    }
  }))

  // ----------------------------------------------------- purchased domains ---
  // Harry's own rows are the answer, joined to a count of the mailboxes running
  // on each domain. The supplier is the source of truth for ownership, so a
  // configured workspace refreshes from it and an outage degrades to the stored
  // rows with their timestamp rather than to an empty panel.
  api.get('/senders/domains', handler(async (req) => {
    const started = Date.now()
    const { limit: max, cursor } = page(req.query, { defaultLimit: 50, maxLimit: 200 })
    limit(`senders.domains:${req.wsId}`, { max: 60, windowMs: 60_000 }, 'Too many domain-list requests. Try again shortly.')

    const res = await supplier.attempt('/api/v1/smart-senders/get-domain-list', { timeoutMs: 8000 })
    const stale = !res.ok
    if (res.ok) {
      markDomainSync(req.wsId)
      const rows = Array.isArray(res.payload?.data) ? res.payload.data : []
      tx(() => {
        for (const row of rows) {
          // The mapper reads only the domain name defensively; everything
          // else is passed through untouched and never required.
          const name = String((typeof row === 'string' ? row : row?.domain || row?.domain_name || row?.name) || '')
            .toLowerCase().trim()
          if (!DOMAIN_RE.test(name)) continue
          const existing = db.prepare('SELECT id FROM sender_domains WHERE workspace_id = ? AND lower(domain) = ?')
            .get(req.wsId, name)
          if (existing) {
            db.prepare('UPDATE sender_domains SET status = ?, expires_at = ?, payload = ? WHERE id = ?')
              .run(String(row?.status || 'purchased'), String(row?.expires_at || ''), JSON.stringify(row ?? {}), existing.id)
          } else {
            db.prepare(
              'INSERT INTO sender_domains (workspace_id, vendor_id, domain, status, order_ref, forwarding_domain, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(req.wsId, String(row?.vendor_id || ''), name, String(row?.status || 'purchased'),
              String(row?.order_ref || ''), String(row?.forwarding_domain || ''),
              String(row?.expires_at || ''), JSON.stringify(row ?? {}))
          }
        }
      })
    }

    const args = [req.wsId]
    let where = 'workspace_id = ?'
    if (cursor) { where += ' AND id < ?'; args.push(cursor) }
    const rows = db.prepare(`SELECT * FROM sender_domains WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...args, max + 1)
    const out = paged(rows, max)
    // Null until a supplier has actually answered once — a workspace with no
    // marketplace configured has no "as of" to report, and inventing one would
    // make Harry's own rows look like confirmed ownership data.
    const asOf = lastDomainSync(req.wsId)

    meter('senders.domains', Date.now() - started, true, `${out.items.length} domain(s)`)
    return {
      ok: true,
      data: out.items.map((row) => presentDomain(req.wsId, row)),
      nextCursor: out.nextCursor,
      hasMore: out.hasMore,
      configured: configured('senders'),
      stale,
      as_of: asOf,
      // What `as_of` is the age of, so a client cannot read it as "when this
      // domain was bought".
      as_of_meaning: asOf
        ? 'when Harry last successfully read the domain list from the supplier'
        : 'Harry has never had a successful answer from a supplier for this workspace',
      ...(configured('senders') ? {} : unconfigured('senders', ENV_VARS)),
    }
  }))

  // -------------------------------------------------------- domain search ----
  // Transient: nothing is stored until an order is placed, and nothing is
  // bought at this step. The marketplace key lives in the server environment
  // and never reaches the client.
  api.get('/senders/domains/search', handler(async (req) => {
    const started = Date.now()
    const vendorId = str(req.query, 'vendor_id', { required: true, max: 120 })
    const field = req.query?.q !== undefined ? 'q' : 'domain_name'
    const q = str(req.query, field, { required: true, max: 63 })
    if (q.replace(/[^a-z0-9]/gi, '').length < 2) {
      throw invalid(field, `${field} must be at least two characters`)
    }
    // A typing user must not be able to hammer a third party even if the
    // client's debounce fails.
    limit(`senders.search:${req.wsId}`, { max: 30, windowMs: 60_000 }, 'Too many domain searches. Try again in a moment.')

    const needle = q.toLowerCase().replace(/[^a-z0-9]/g, '')
    let data = []
    const res = await supplier.attempt(
      `/api/v1/smart-senders/search-domain?vendor_id=${encodeURIComponent(vendorId)}&domain_name=${encodeURIComponent(q)}`,
      { timeoutMs: 8000 }
    )
    const live = res.ok
    if (res.ok) {
      const rows = Array.isArray(res.payload?.data) ? res.payload.data : []
      for (const row of rows) {
        const name = String((typeof row === 'string' ? row : row?.domain || row?.domain_name || row?.name) || '')
          .toLowerCase().trim()
        if (!DOMAIN_RE.test(name)) continue
        // Relevance: a supplier may not upsell an unrelated domain into a
        // list the user asked a specific question of.
        if (!name.replace(/[^a-z0-9]/g, '').includes(needle)) continue
        const price = Number(row?.price ?? row?.amount ?? NaN)
        // Ceiling, server-side, as defence in depth. A row with no price at
        // all is kept and labelled — the UI reads "price shown at checkout".
        if (Number.isFinite(price) && price > PRICE_CEILING) continue
        data.push({
          domain: name,
          price: Number.isFinite(price) ? price : null,
          currency: String(row?.currency || 'USD'),
          available: row?.available === undefined ? true : Boolean(row.available),
          details: typeof row === 'object' ? row : {},
        })
      }
      data = data.filter((row) => row.available)
    }

    meter('senders.search', Date.now() - started, true, `${data.length} result(s)`)
    return {
      ok: true,
      data,
      vendor_id: vendorId,
      query: q,
      price_ceiling: PRICE_CEILING,
      currency_note: 'Prices are shown in the currency the supplier quotes; Harry converts nothing.',
      configured: configured('senders'),
      live,
      ...(configured('senders') ? {} : unconfigured('senders', ENV_VARS)),
    }
  }))

  // ---------------------------------------------------- mailbox suggestion ---
  // A pure suggestion: no side effects, nothing sent, nothing stored. It must
  // never be a hard dependency of the flow, so a supplier failure produces the
  // same shape as a genuinely empty result and the client's manual-entry
  // fallback stays the single code path for "no suggestions".
  api.post('/senders/mailboxes/suggest', handler(async (req) => {
    const started = Date.now()
    const body = req.body || {}
    rejectPaymentInstruments(body)
    const vendorId = str(body, 'vendor_id', { max: 120, fallback: '' })

    const raw = body.domains
    if (raw === undefined || raw === null) throw invalid('domains', 'domains is required')
    // The source documents an object keyed by domain; an array of
    // { domain_name, count } is accepted too because that is what the order
    // step already speaks.
    let requested = []
    if (Array.isArray(raw)) {
      requested = raw.map((entry, i) => ({
        domain: domainField({ v: entry?.domain_name ?? entry?.domain }, 'v', { required: true }),
        count: int(entry ?? {}, 'count', { required: true, min: 1, max: MAX_SUGGEST_PER_DOMAIN }),
        at: `domains[${i}]`,
      }))
    } else if (typeof raw === 'object') {
      requested = Object.entries(raw).map(([name, entry]) => ({
        domain: domainField({ v: name }, 'v', { required: true }),
        count: int(entry ?? {}, 'count', { required: true, min: 1, max: MAX_SUGGEST_PER_DOMAIN }),
        at: `domains.${name}`,
      }))
    } else {
      throw invalid('domains', 'domains must be an object keyed by domain, or an array')
    }
    if (!requested.length) throw invalid('domains', 'domains must name at least one domain')
    if (requested.length > MAX_SUGGEST_DOMAINS) {
      throw invalid('domains', `domains may name at most ${MAX_SUGGEST_DOMAINS} domains`)
    }

    const identity = senderIdentity(req.wsId)
    const res = await supplier.attempt('/api/v1/smart-senders/auto-generate-mailboxes', {
      method: 'POST',
      timeoutMs: 8000,
      body: {
        vendor_id: vendorId,
        domains: Object.fromEntries(requested.map((r) => [r.domain, { count: r.count }])),
      },
    })
    // A supplier failure and a genuinely empty result are the same thing here,
    // so the client's manual-entry fallback is one code path rather than two.
    const vendorRows = res.ok ? (Array.isArray(res.payload?.data) ? res.payload.data : []) : null

    const data = requested.map((r) => {
      const fromVendor = vendorRows === null ? [] : keepOnDomain(vendorRows, r.domain).slice(0, r.count)
      const suggestions = fromVendor.length
        ? fromVendor
        : suggestFor(r.domain, r.count, identity)
      return {
        domain: r.domain,
        count: r.count,
        // Never a fabricated supplier response: a locally derived list says so.
        source: fromVendor.length ? 'vendor' : 'harry',
        suggestions,
      }
    })

    // Off-domain rows the supplier proposed and this route dropped. Reported so
    // a supplier misbehaving is visible rather than silently absorbed.
    const dropped = vendorRows === null
      ? 0
      : vendorRows.length - data.reduce((n, d) => n + (d.source === 'vendor' ? d.suggestions.length : 0), 0)

    meter('senders.suggest', Date.now() - started, true, `${data.length} domain(s)`)
    return {
      ok: true,
      data,
      dropped: Math.max(0, dropped),
      identity: { first_name: identity.first_name, last_name: identity.last_name, source: identity.source },
      note: 'Suggestions are a starting point. Edit them freely — what you order is what you type, ' +
        'and fewer, well-warmed mailboxes beat many cold ones.',
      editable: true,
      configured: configured('senders'),
      ...(configured('senders') ? {} : unconfigured('senders', ENV_VARS)),
    }
  }))

  // ---------------------------------------------------------- place order ----
  // The only route in Harry that spends money. Three things make it safe and
  // they are all here: an explicit idempotency key minted when the summary
  // screen opened, a row written before the supplier is called so a timeout can
  // never lose an order, and one attempt with no retry.
  api.post('/senders/orders', handler(async (req) => {
    const started = Date.now()
    const body = req.body || {}

    // First, before anything is parsed or written.
    rejectPaymentInstruments(body)

    const headerKey = req.get ? req.get('idempotency-key') : ''
    const idempotencyKey = str(
      { v: body.idempotency_key ?? body.idempotencyKey ?? headerKey ?? '' },
      'v',
      { required: false, max: 200 }
    )
    if (!idempotencyKey) {
      throw invalid(
        'idempotency_key',
        'idempotency_key is required. Generate one when the order summary opens and send the same value ' +
          'with the confirmation, so a retry can never become a second purchase.'
      )
    }
    if (idempotencyKey.length < 8) {
      throw invalid('idempotency_key', 'idempotency_key must be at least 8 characters of unguessable value')
    }

    const vendorId = str(body, 'vendor_id', { required: true, max: 120 })
    const forwarding = domainField(body, 'forwarding_domain', { required: true })
    // parseDomains resolves parent_account_id against this workspace.
    const domains = parseDomains(body, req.wsId)
    const { details: billing, reused } = parseBilling(body, req.wsId)
    const total = Number(body.total ?? body.total_price ?? 0)
    if (!Number.isFinite(total) || total < 0) throw invalid('total', 'total must be a positive amount')
    const currency = str(body, 'currency', { max: 8, fallback: 'USD' }).toUpperCase()

    const addresses = domains.flatMap((d) => d.mailbox_details.map((m) => m.address))
    const domainNames = domains.map((d) => d.domain_name)

    // Idempotency, decided by the database. A pre-check would still race; the
    // UNIQUE (workspace_id, idempotency_key) index cannot.
    let row
    let created = false
    try {
      const info = db.prepare(
        `INSERT INTO sender_orders
           (workspace_id, vendor_id, order_ref, idempotency_key, status, forwarding_domain, domains, mailboxes, total, currency, created_by)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
      ).run(req.wsId, vendorId, orderRef(), idempotencyKey, forwarding,
        JSON.stringify(domainNames), JSON.stringify(domains.flatMap((d) => d.mailbox_details)),
        total, currency, req.user?.email || '')
      row = db.prepare('SELECT * FROM sender_orders WHERE id = ?').get(info.lastInsertRowid)
      created = true
    } catch (err) {
      if (!String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) throw err
      row = db.prepare('SELECT * FROM sender_orders WHERE workspace_id = ? AND idempotency_key = ?')
        .get(req.wsId, idempotencyKey)
      if (!row) throw err
    }

    // The same key a second time is answered with the first order and nothing
    // else happens: no supplier call, no second events row, no second charge.
    if (!created) {
      meter('senders.order', Date.now() - started, true, `duplicate ${row.order_ref}`)
      return {
        ok: true,
        data: presentOrder(row),
        duplicate: true,
        retried: false,
        message: 'This order was already placed. Its reference is below — nothing was ordered twice.',
        configured: configured('senders'),
      }
    }

    // Billing details are stored after the row exists and before the supplier
    // is called, so the "collected once" promise survives a timeout too.
    const billingResult = reused ? { stored: true, reason: '' } : storeBilling(req.wsId, billing)

    // One attempt. providers.js retries by default and that is exactly wrong
    // here: a retried purchase is a duplicate charge.
    const attempt = await supplier.attempt('/api/v1/smart-senders/place-order', {
      method: 'POST',
      retries: 0,
      timeoutMs: ORDER_TIMEOUT_MS,
      body: {
        vendor_id: vendorId,
        forwarding_domain: forwarding,
        idempotency_key: idempotencyKey,
        user_details: billing,
        domains: domains.map((d) => ({
          domain_name: d.domain_name,
          mailbox_details: d.mailbox_details.map((m) => ({
            mailbox: m.address, first_name: m.first_name, last_name: m.last_name,
            ...(m.parent_account_id ? { parent_account_id: m.parent_account_id } : {}),
          })),
        })),
      },
    })

    let supplierRef = ''
    if (attempt.ok) {
      const payload = attempt.payload?.data ?? attempt.payload ?? {}
      supplierRef = String(payload.order_id || payload.order_ref || payload.id || '')
      const status = mapStatus(payload.status, 'placed')
      db.prepare("UPDATE sender_orders SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, row.id)
      if (supplierRef) {
        db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(`sender_order_supplier_ref:${row.id}`, supplierRef)
      }
      if (status === 'placed') recordDomains(req.wsId, row, domainNames, vendorId, forwarding)
      row = db.prepare('SELECT * FROM sender_orders WHERE id = ?').get(row.id)
    }

    // One events row: who ordered, which domains, at what total, with the
    // reference — and no billing detail of any kind.
    audit(req, {
      type: 'sender_order_placed',
      detail: `${req.user?.email || 'someone'} placed order ${row.order_ref} with vendor ${vendorId} for ` +
        `${domainNames.join(', ')} (${addresses.length} mailbox(es)) at ${total.toFixed(2)} ${currency}` +
        `; status ${row.status}`,
    })

    meter('senders.order', Date.now() - started, attempt.ok, `${row.order_ref} ${row.status}`)

    const pendingReason = attempt.ok ? '' : ({
      unconfigured: 'No marketplace provider is connected, so nothing has been ordered from a supplier. ' +
        'The order is recorded as pending and nothing has been charged.',
      timeout: 'The supplier did not answer in time. The order is recorded as pending and has NOT been ' +
        'retried — re-sending it could buy the same domain twice. Check its status with the reference below.',
      error: 'The supplier refused or failed the request. The order is recorded as pending and has NOT been ' +
        'retried. Check its status with the reference below.',
    }[attempt.reason] || 'The order is pending.')

    return {
      ok: true,
      data: presentOrder(row),
      duplicate: false,
      // Stated in the response because the whole flow depends on the user
      // knowing Harry will not try again by itself.
      retried: false,
      auto_retry: false,
      supplier_reference: supplierRef || null,
      pending_reason: pendingReason || null,
      billing_details_stored: billingResult.stored,
      billing_notice: billingResult.reason || null,
      registrant_notice: 'Your contact details are passed to the supplier as the domain registrant and may ' +
        'appear in public registration records.',
      configured: configured('senders'),
      ...(configured('senders') ? {} : unconfigured('senders', ENV_VARS)),
    }
  }))

  // --------------------------------------------------------- order details ---
  // Also the reconciliation path: a pending order settles itself here, read
  // only, never re-posted. Cross-workspace and unknown references are the same
  // 404, with no hint that the reference exists anywhere else.
  api.get('/senders/orders/:ref', handler(async (req) => {
    const started = Date.now()
    limit(`senders.order-read:${req.wsId}`, { max: 120, windowMs: 60_000 }, 'Too many order lookups. Try again shortly.')
    let row = findOrder(req.wsId, req.params.ref)
    const reveal = ['1', 'true', 'yes'].includes(String(req.query?.reveal || '').toLowerCase())

    let credentials = []
    let reconciled = false
    if (['pending', 'placed'].includes(row.status)) {
      const supplierRef = db.prepare('SELECT value FROM kv WHERE key = ?')
        .get(`sender_order_supplier_ref:${row.id}`)?.value || row.order_ref
      // Read only. Reconciliation resolves a pending order; it never re-posts
      // one, which is what makes an interrupted purchase safe to settle.
      const res = await supplier.attempt(
        `/api/v1/smart-senders/order-details?order_id=${encodeURIComponent(supplierRef)}`,
        { timeoutMs: 8000 }
      )
      if (res.ok) {
        reconciled = true
        const payload = res.payload?.data ?? res.payload ?? {}
        // Credentials are split off before a row is constructed. `safe` is what
        // may be stored; `credentials` is held in this handler and nowhere else.
        const split = splitCredentials(payload.email_accounts ?? payload.mailboxes ?? [])
        credentials = split.credentials
        const status = mapStatus(payload.status, row.status)
        const stored = split.safe.length ? JSON.stringify(split.safe) : row.mailboxes
        if (status !== row.status || stored !== row.mailboxes) {
          db.prepare("UPDATE sender_orders SET status = ?, mailboxes = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?")
            .run(status, stored, row.id, req.wsId)
          if (status !== row.status) {
            audit(req, {
              type: 'sender_order_status',
              detail: `Order ${row.order_ref} moved ${row.status} → ${status}` +
                `${payload.domain ? ` for ${payload.domain}` : ''}`,
            })
          }
        }
        if (status === 'placed') {
          recordDomains(req.wsId, row, safeJson(row.domains, []), row.vendor_id, row.forwarding_domain, payload.expires_at)
        }
        row = db.prepare('SELECT * FROM sender_orders WHERE id = ?').get(row.id)
      }
    }

    if (reveal && credentials.length) {
      // The reveal is an event, not a stored value. The addresses are named;
      // the credentials are not.
      audit(req, {
        type: 'sender_credential_revealed',
        detail: `${req.user?.email || 'someone'} revealed supplier credentials for ` +
          `${credentials.map((c) => c.address).join(', ')} on order ${row.order_ref}`,
      })
    }

    meter('senders.order-details', Date.now() - started, true, `${row.order_ref} ${row.status}`)
    return {
      ok: true,
      data: presentOrder(row),
      reconciled,
      auto_retry: false,
      // Passed straight through, once, and held nowhere. Absent unless asked
      // for, and always absent when the supplier returned none.
      credentials: reveal ? credentials : undefined,
      credential_notice: credentials.length
        ? 'Harry does not store this value and will not show it again. Sign in yourself — Harry never ' +
          'enters credentials into a supplier\'s form on your behalf.'
        : null,
      configured: configured('senders'),
      ...(configured('senders') ? {} : unconfigured('senders', ENV_VARS)),
    }
  }))

  // ------------------------------------------------------------- get otp -----
  // Read once, shown once, stored nowhere. The address must belong to one of
  // this workspace's own orders, so the route cannot become a lookup oracle for
  // an arbitrary mailbox, and the refusals are themselves rate-limited so it
  // cannot be probed for which addresses exist.
  api.get('/senders/mailboxes/:address/code', handler(async (req) => {
    const started = Date.now()
    const address = String(req.params.address || '').toLowerCase().trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      throw invalid('address', 'address must be a valid email address')
    }

    // Per workspace and per address, with a low ceiling: repeated code requests
    // are the shape of an account takeover attempt (get-otp.md AC 7).
    const perWorkspace = limit(
      `senders.otp.ws:${req.wsId}`, { max: 10, windowMs: 5 * 60_000 },
      'Too many sign-in code requests from this workspace. Wait before asking for another.'
    )
    const perAddress = limit(
      `senders.otp.addr:${req.wsId}:${address}`, { max: 3, windowMs: 5 * 60_000 },
      'Too many sign-in code requests for this address. Wait before asking for another.'
    )

    const owned = db.prepare(
      `SELECT order_ref, mailboxes FROM sender_orders
        WHERE workspace_id = ? AND status = 'placed'`
    ).all(req.wsId).find((row) => safeJson(row.mailboxes, [])
      .some((m) => String(m?.address || '').toLowerCase() === address))

    if (!owned) {
      // Probing is throttled separately and harder, and the refusal is logged.
      limit(
        `senders.otp.refused:${req.wsId}`, { max: 5, windowMs: 5 * 60_000 },
        'Too many refused sign-in code requests. Wait before trying again.'
      )
      audit(req, {
        type: 'sender_code_refused',
        detail: `${req.user?.email || 'someone'} requested a sign-in code for ${address}, which is not on any ` +
          'completed order in this workspace',
      })
      meter('senders.otp', Date.now() - started, false, 'refused')
      // Identical to the response for an address that does not exist anywhere.
      throw notFound('mailbox')
    }

    let code = null
    let expiresIn = 0
    {
      const res = await supplier.attempt(
        `/api/v1/smart-senders/auth-secret?email_account=${encodeURIComponent(address)}`,
        { timeoutMs: 8000, retries: 0 }
      )
      if (res.ok) {
        const payload = res.payload?.data ?? res.payload ?? {}
        const value = payload.otp ?? payload.code ?? payload.auth_secret
        if (value !== undefined && value !== null && String(value) !== '') {
          code = String(value)
          expiresIn = Number(payload.expires_in ?? payload.expiresIn ?? 300) || 300
        }
      }
    }

    // The request is logged; the code is not, and never will be. `meter` is
    // given the outcome only.
    audit(req, {
      type: 'sender_code_requested',
      detail: `${req.user?.email || 'someone'} requested a sign-in code for ${address} on order ${owned.order_ref}` +
        ` (${perAddress.count} in the last five minutes)`,
    })
    meter('senders.otp', Date.now() - started, Boolean(code), code ? 'issued' : 'none available')

    return {
      ok: true,
      // Never stored, never cached, never logged. This is the only place the
      // value exists and it exists for one response.
      data: code ? { otp: code, expires_in: expiresIn } : null,
      address,
      order_ref: owned.order_ref,
      recent_requests: perAddress.count,
      workspace_requests: perWorkspace.count,
      stored: false,
      notice: code
        ? 'Type this into the supplier\'s sign-in yourself. Harry shows the code and never completes a ' +
          'sign-in on your behalf, and it is not stored anywhere.'
        : 'No code is available right now. Ask again in a moment.',
      configured: configured('senders'),
      ...(configured('senders') ? {} : unconfigured('senders', ENV_VARS)),
    }
  }))
}

// A placed order's domains become Harry's own rows, so the purchased-domain
// list is answerable without the supplier. Insert-once: a reconciliation pass
// running twice must not double the list.
function recordDomains(wsId, order, domainNames, vendorId, forwarding, expiresAt = '') {
  tx(() => {
    for (const name of domainNames) {
      const domain = String(name || '').toLowerCase()
      if (!DOMAIN_RE.test(domain)) continue
      const existing = db.prepare('SELECT id FROM sender_domains WHERE workspace_id = ? AND lower(domain) = ?')
        .get(wsId, domain)
      if (existing) {
        if (expiresAt) db.prepare('UPDATE sender_domains SET expires_at = ? WHERE id = ?').run(String(expiresAt), existing.id)
        continue
      }
      db.prepare(
        'INSERT INTO sender_domains (workspace_id, vendor_id, domain, status, order_ref, forwarding_domain, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(wsId, vendorId || '', domain, 'purchased', order.order_ref, forwarding || '', String(expiresAt || ''))
    }
  })
}
