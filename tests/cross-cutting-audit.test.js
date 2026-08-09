// Two guarantees that belong to no single category, and which no per-category
// test file would ever check, tested across the whole `/api` surface at once.
//
//   1. Workspace isolation. `req.wsId` scopes every route. A row belonging to
//      another workspace must be a 404 — never a 200 carrying someone else's
//      data, and never a fragment of it inside an aggregate.
//   2. Secret hygiene. No response body anywhere may contain a webhook signing
//      secret, an OAuth refresh or access token, an encrypted billing blob, a
//      hashed client API key, or the server's own session-signing secret.
//
// The method is deliberately mechanical rather than curated: the route table is
// read from the real router (the same source `scripts/routes.mjs` reads), so a
// route added tomorrow is swept tomorrow without anyone remembering to add it
// here. Every foreign row is written with a marker string in every text column,
// so "did this leak?" is one substring test against the raw response body
// rather than a guess about which field would have carried it.
//
// This drives the real `server/routes.js` router behind the real `requireUser`
// and `workspace` middleware. A test that injected `req.wsId` itself would be
// asserting against its own stub.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser } from './helpers/parity-harness.js'

setup('crosscut')                  // MUST precede any ../server import
process.env.DEV_LOGIN = '1'        // the router's real sign-in, not a fake session

const { db } = await import('../server/db.js')
const express = (await import('express')).default
const { api } = await import('../server/routes.js')
const { authRouter } = await import('../server/auth.js')

// Anything with this in it belongs to the other workspace. If it appears in a
// response to us, something leaked.
const MARK = 'zzforeignmarkerzz'
// Our own rows get a different one, so the sweep can tell "returned nothing"
// from "returned only what it should".
const MINE_MARK = 'zzourownmarkerzz'

// Secrets seeded into OUR OWN workspace. These are the dangerous ones: a route
// that returns our own rows is *supposed* to answer, so the only thing standing
// between the secret and the wire is the projection.
const SECRETS = {
  webhook_secret: 'zzsecret-webhook-signingzz',
  refresh_token: 'zzsecret-oauth-refreshzz',
  access_token: 'zzsecret-oauth-accesszz',
  billing_blob: 'zzsecret-billing-encryptedzz',
}

// ---- the app ----------------------------------------------------------------

const app = express()
app.use((req, _res, next) => {
  req.cookies = {}
  const header = req.headers.cookie
  if (header) {
    for (const pair of header.split(';')) {
      const i = pair.indexOf('=')
      if (i > 0) req.cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim())
    }
  }
  next()
})
app.use(authRouter)
app.use('/api', api)

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => new Promise((r) => server.close(r)))

const mine = seedUser(db, 'mine@crosscut.test')
const theirs = seedUser(db, 'theirs@crosscut.test')

async function signIn(email) {
  const res = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const cookie = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('htm_session'))?.split(';')[0]
  assert.ok(cookie, `signed in as ${email}`)
  return cookie
}

const myCookie = await signIn(mine.email)

// Raw text, not parsed JSON: a leak inside a stringified blob is still a leak.
async function call(cookie, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? { cookie } : { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

const get = (path) => call(myCookie, 'GET', path)

// ---- fixtures ---------------------------------------------------------------

const run = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid)

// Everything the other workspace owns, with the marker written into every text
// column a route could plausibly render. `ids` collects the primary keys so the
// sweep can try them against every parameterised route.
function seedWorkspace(wsId, tag) {
  const ids = {}
  const stamp = tag === 'theirs' ? MARK : MINE_MARK
  const m = (s) => `${stamp}-${tag}-${s}`

  ids.mailbox = run(
    `INSERT INTO mailboxes (user_id, provider, email, display_name, access_token, refresh_token, last_error)
     VALUES (?, 'sandbox', ?, ?, ?, ?, ?)`,
    wsId, `${m('box')}@example.test`, m('Display'),
    tag === 'theirs' ? m('access') : SECRETS.access_token,
    tag === 'theirs' ? m('refresh') : SECRETS.refresh_token,
    m('last-error'),
  )
  ids.lead = run(
    `INSERT INTO leads (user_id, email, first_name, last_name, company, title, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    wsId, `${m('lead')}@example.test`, m('First'), m('Last'), m('Company'), m('Title'), m('Notes'),
  )
  ids.campaign = run(
    "INSERT INTO campaigns (user_id, name, status, mailbox_id, mermaid) VALUES (?, ?, 'running', ?, ?)",
    wsId, m('Campaign'), ids.mailbox, `flowchart TD\n  A[${m('Step')}]`,
  )
  ids.campaignLead = run(
    "INSERT INTO campaign_leads (campaign_id, lead_id, node_id, state, thread_id, intent, outcome) VALUES (?, ?, 'A', 'waiting', ?, 'interested', ?)",
    ids.campaign, ids.lead, m('thread'), m('outcome'),
  )
  ids.message = run(
    `INSERT INTO messages (user_id, campaign_id, lead_id, mailbox_id, direction, subject, body, from_email, to_email, thread_id, provider_message_id, intent)
     VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, 'interested')`,
    wsId, ids.campaign, ids.lead, ids.mailbox, m('Subject'), m('Body'),
    `${m('from')}@example.test`, `${m('to')}@example.test`, m('thread'), m('pmid'),
  )
  ids.draft = run(
    `INSERT INTO drafts (user_id, campaign_id, lead_id, node_id, subject, body, status)
     VALUES (?, ?, ?, 'A', ?, ?, 'pending')`,
    wsId, ids.campaign, ids.lead, m('Draft subject'), m('Draft body'),
  )
  ids.webhook = run(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories, is_active)
     VALUES (?, NULL, ?, ?, ?, '["sent","reply"]', '[]', 1)`,
    wsId, m('Webhook'), `https://${m('host').replace(/[^a-z0-9-]/g, '')}.example.test/hook`,
    tag === 'theirs' ? m('secret') : SECRETS.webhook_secret,
  )
  ids.delivery = run(
    `INSERT INTO webhook_deliveries (workspace_id, webhook_id, event_type, payload, payload_hash, status_code, ok, attempt, error)
     VALUES (?, ?, 'sent', ?, ?, 500, 0, 1, ?)`,
    wsId, ids.webhook, JSON.stringify({ note: m('payload') }), m('hash'), m('delivery-error'),
  )
  ids.client = run(
    "INSERT INTO clients (workspace_id, name, email, permissions, status) VALUES (?, ?, ?, '[\"leads\"]', 'active')",
    wsId, m('Client'), `${m('client')}@example.test`,
  )
  ids.apiKey = run(
    `INSERT INTO client_api_keys (workspace_id, client_id, key_name, key_prefix, key_hash, scope, status)
     VALUES (?, ?, ?, ?, ?, 'read', 'active')`,
    wsId, ids.client, m('Key'), `htmk_${tag}0000`, m('key-hash'),
  )
  ids.tag = run(
    "INSERT INTO tags (workspace_id, applies_to, name, color) VALUES (?, 'lead', ?, '#8b5cf6')",
    wsId, m('Tag'),
  )
  run('INSERT INTO lead_tags (workspace_id, lead_id, tag_id) VALUES (?, ?, ?)', wsId, ids.lead, ids.tag)
  ids.list = run(
    'INSERT INTO lead_lists (workspace_id, name, description, created_by) VALUES (?, ?, ?, ?)',
    wsId, m('List'), m('List description'), `${m('by')}@example.test`,
  )
  run('INSERT INTO lead_list_leads (list_id, lead_id) VALUES (?, ?)', ids.list, ids.lead)
  ids.note = run(
    'INSERT INTO lead_notes (workspace_id, lead_id, campaign_id, author_email, body) VALUES (?, ?, ?, ?, ?)',
    wsId, ids.lead, ids.campaign, `${m('author')}@example.test`, m('Note body'),
  )
  ids.task = run(
    'INSERT INTO lead_tasks (workspace_id, lead_id, campaign_id, title, body, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    wsId, ids.lead, ids.campaign, m('Task title'), m('Task body'), `${m('by')}@example.test`,
  )
  ids.reminder = run(
    'INSERT INTO lead_reminders (workspace_id, lead_id, reminder_at, note, created_by) VALUES (?, ?, ?, ?, ?)',
    wsId, ids.lead, new Date(Date.now() + 86_400_000).toISOString(), m('Reminder note'), `${m('by')}@example.test`,
  )
  ids.goal = run(
    'INSERT INTO goals (user_id, description, name, metric, target, icp) VALUES (?, ?, ?, ?, 5, ?)',
    wsId, m('Goal description'), m('Goal'), m('metric'), JSON.stringify({ segment: m('icp') }),
  )
  ids.view = run(
    'INSERT INTO inbox_views (workspace_id, name, filters, created_by) VALUES (?, ?, ?, ?)',
    wsId, m('View'), '{}', `${m('by')}@example.test`,
  )
  ids.unmatched = run(
    `INSERT INTO unmatched_messages (workspace_id, mailbox_id, from_email, subject, body, thread_id, provider_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    wsId, ids.mailbox, `${m('unknown')}@example.test`, m('Unmatched subject'), m('Unmatched body'), m('uthread'), m('upmid'),
  )
  ids.blocked = run(
    "INSERT INTO blocked_domains (workspace_id, value, is_domain, source, created_by) VALUES (?, ?, 1, 'manual', ?)",
    wsId, `${m('blocked').replace(/[^a-z0-9-]/g, '')}.example.test`, `${m('by')}@example.test`,
  )
  ids.category = run(
    'INSERT INTO lead_categories (workspace_id, name) VALUES (?, ?)', wsId, m('Category'),
  )
  ids.folder = run(
    'INSERT INTO deliverability_folders (workspace_id, name) VALUES (?, ?)', wsId, m('Folder'),
  )
  ids.test = run(
    "INSERT INTO deliverability_tests (workspace_id, folder_id, name, status) VALUES (?, ?, ?, 'active')",
    wsId, ids.folder, m('Test'),
  )
  ids.search = run(
    'INSERT INTO prospect_searches (workspace_id, name, filters, created_by) VALUES (?, ?, ?, ?)',
    wsId, m('Search'), '{}', `${m('by')}@example.test`,
  )
  ids.fetch = run(
    'INSERT INTO prospect_fetches (workspace_id, search_id, name) VALUES (?, ?, ?)',
    wsId, ids.search, m('Fetch'),
  )
  ids.order = run(
    'INSERT INTO sender_orders (workspace_id, order_ref, idempotency_key, status, forwarding_domain, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    wsId, m('order-ref'), m('idem'), 'pending', `${m('fwd').replace(/[^a-z0-9-]/g, '')}.example.test`,
    `${m('by')}@example.test`,
  )
  ids.hold = run(
    "INSERT INTO send_holds (workspace_id, scope, scope_id, reason, source, created_by) VALUES (?, 'workspace', 0, ?, 'manual', ?)",
    wsId, m('Hold reason'), `${m('by')}@example.test`,
  )
  run('INSERT INTO events (user_id, campaign_id, lead_id, type, detail) VALUES (?, ?, ?, ?, ?)',
    wsId, ids.campaign, ids.lead, 'lead_added', m('Event detail'))
  run('INSERT INTO team_members (owner_id, email, role, status) VALUES (?, ?, ?, ?)',
    wsId, `${m('member')}@example.test`, 'member', 'active')
  run('INSERT INTO sender_billing_details (workspace_id, encrypted) VALUES (?, ?)',
    wsId, tag === 'theirs' ? m('billing') : SECRETS.billing_blob)

  return ids
}

const foreign = seedWorkspace(theirs.id, 'theirs')
const own = seedWorkspace(mine.id, 'mine')

// Ids are per-table sequences, so the same small number names a different row in
// every table — the foreign workspace's lead is id 1 and so is nearly everything
// else it owns. Probing the whole low range therefore probes every foreign row
// against every route, and the marker (not the status code) decides whether
// anything leaked.
const MAX_SEEDED = Math.max(...Object.values(foreign), ...Object.values(own))
const FOREIGN_IDS = Array.from({ length: MAX_SEEDED }, (_, i) => i + 1)
const OWN_IDS = [...new Set(Object.values(own).map(Number))].sort((a, b) => a - b)

// ---- the route table --------------------------------------------------------

const ROUTES = []
for (const layer of api.stack) {
  if (!layer.route) continue
  for (const method of Object.keys(layer.route.methods)) {
    ROUTES.push({ method: method.toUpperCase(), path: layer.route.path })
  }
}
const GETS = ROUTES.filter((r) => r.method === 'GET')
const PARAM_RE = /:[^/]+/g

// Substituting the same id into every parameter is the point: it means a
// two-parameter route is probed with a pair that really does belong to the
// other workspace, which is the case a pair-verification bug would slip through.
const fill = (path, id) => path.replace(PARAM_RE, String(id))

test('the sweep is actually sweeping something', () => {
  assert.ok(ROUTES.length > 250, `only ${ROUTES.length} routes found — the router did not load`)
  assert.ok(GETS.length > 100, `only ${GETS.length} GET routes found`)
  assert.ok(Object.keys(foreign).length >= 25, 'the foreign workspace was barely seeded')
  // Every row the other workspace owns is reachable by one of the probed ids,
  // so "swept every route" also means "swept every foreign row".
  for (const [fixture, id] of Object.entries(foreign)) {
    assert.ok(FOREIGN_IDS.includes(id), `foreign ${fixture} (id ${id}) is outside the probe range`)
  }
  // The marker really is in the database, so a green sweep means something.
  const planted = db.prepare(
    'SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND email LIKE ?'
  ).get(theirs.id, `%${MARK}%`).n
  assert.equal(planted, 1)
})

// ---- 1. workspace isolation -------------------------------------------------

test('no GET route anywhere returns another workspace\'s data', { timeout: 300_000 }, async () => {
  const leaks = []
  const crashes = []

  // Parameterless routes first: these cannot be probed with an id, so the only
  // thing keeping the other workspace out of them is the WHERE clause.
  for (const route of GETS.filter((r) => !PARAM_RE.test(r.path))) {
    const res = await get(`/api${route.path}`)
    if (res.text.includes(MARK)) leaks.push(`${route.method} /api${route.path} (unscoped query)`)
    if (res.status >= 500) crashes.push(`${route.method} /api${route.path} -> ${res.status}`)
  }

  // Then every parameterised route, once per id the other workspace owns.
  for (const route of GETS.filter((r) => PARAM_RE.test(r.path))) {
    for (const id of FOREIGN_IDS) {
      const path = `/api${fill(route.path, id)}`
      const res = await get(path)
      if (res.text.includes(MARK)) leaks.push(`${route.method} ${path} -> ${res.status}`)
      if (res.status >= 500) crashes.push(`${route.method} ${path} -> ${res.status}`)
    }
  }

  assert.deepEqual(leaks, [], `another workspace's rows reached us:\n${leaks.join('\n')}`)
  assert.deepEqual(crashes, [], `a foreign id crashed a route:\n${crashes.join('\n')}`)
})

// A representative slice across every module, asserting the specific contract:
// not merely "no leak" but "404", and the foreign row untouched afterwards.
const ISOLATION_CASES = [
  ['GET', '/api/leads/:id', 'lead'],
  ['PATCH', '/api/leads/:id', 'lead', { first_name: 'Taken' }],
  ['DELETE', '/api/leads/:id', 'lead'],
  ['GET', '/api/leads/:id/activities', 'lead'],
  ['POST', '/api/leads/:leadId/notes', 'lead', { body: 'hello' }],
  ['GET', '/api/campaigns/:id', 'campaign'],
  ['PUT', '/api/campaigns/:id/status', 'campaign', { status: 'paused' }],
  ['DELETE', '/api/campaigns/:id', 'campaign'],
  ['GET', '/api/campaigns/:id/statistics', 'campaign'],
  ['GET', '/api/campaigns/:id/webhooks', 'campaign'],
  ['GET', '/api/campaigns/:id/notifications/summary', 'campaign'],
  ['GET', '/api/mailboxes/:id', 'mailbox'],
  ['PATCH', '/api/mailboxes/:id', 'mailbox', { display_name: 'Taken' }],
  ['DELETE', '/api/mailboxes/:id', 'mailbox'],
  ['GET', '/api/webhooks/:id', 'webhook'],
  ['PATCH', '/api/webhooks/:id', 'webhook', { name: 'Taken' }],
  ['DELETE', '/api/webhooks/:id', 'webhook'],
  ['POST', '/api/webhooks/:id/test', 'webhook'],
  ['GET', '/api/clients/:id', 'client'],
  ['PATCH', '/api/clients/:id', 'client', { name: 'Taken' }],
  ['DELETE', '/api/clients/:id', 'client'],
  ['GET', '/api/clients/:clientId/api-keys', 'client'],
  ['DELETE', '/api/api-keys/:id', 'apiKey'],
  ['GET', '/api/lead-lists/:id', 'list'],
  ['PUT', '/api/lead-lists/:id', 'list', { name: 'Taken' }],
  ['DELETE', '/api/lead-lists/:id', 'list'],
  ['PATCH', '/api/notes/:id', 'note', { body: 'Taken' }],
  ['DELETE', '/api/notes/:id', 'note'],
  ['PATCH', '/api/tasks/:id', 'task', { title: 'Taken' }],
  ['PATCH', '/api/reminders/:id', 'reminder', { note: 'Taken' }],
  ['DELETE', '/api/reminders/:id', 'reminder'],
  ['DELETE', '/api/goals/:id', 'goal'],
  ['GET', '/api/inbox/threads/:id', 'message'],
  ['PATCH', '/api/inbox/views/:id', 'view', { name: 'Taken' }],
  ['DELETE', '/api/inbox/views/:id', 'view'],
  ['POST', '/api/inbox/unmatched/:id/dismiss', 'unmatched'],
  ['POST', '/api/drafts/:id/approve', 'draft'],
  ['POST', '/api/drafts/:id/decline', 'draft'],
  ['DELETE', '/api/block-list/:id', 'blocked'],
  ['DELETE', '/api/blocked-domains/:id', 'blocked'],
  ['PUT', '/api/tags/:id', 'tag', { name: 'Taken' }],
  ['DELETE', '/api/tags/:id', 'tag'],
  ['PATCH', '/api/lead-categories/:id', 'category', { name: 'Taken' }],
  ['DELETE', '/api/lead-categories/:id', 'category'],
  ['GET', '/api/deliverability/tests/:testId', 'test'],
  ['GET', '/api/deliverability/folders/:folderId', 'folder'],
  ['PUT', '/api/prospects/searches/:id/name', 'search', { name: 'Taken' }],
  ['PUT', '/api/prospects/fetches/:id/name', 'fetch', { name: 'Taken' }],
  ['GET', '/api/messages/:messageId/status', 'message'],
  ['POST', '/api/queue/:id/send-now', 'draft'],
]

// Which table each fixture lives in, so "the row is untouched afterwards" can be
// checked against the database rather than against a second response.
const TABLE_OF = {
  lead: 'leads', campaign: 'campaigns', mailbox: 'mailboxes', webhook: 'webhooks',
  client: 'clients', apiKey: 'client_api_keys', list: 'lead_lists', note: 'lead_notes',
  task: 'lead_tasks', reminder: 'lead_reminders', goal: 'goals', message: 'messages',
  view: 'inbox_views', unmatched: 'unmatched_messages', draft: 'drafts',
  blocked: 'blocked_domains', tag: 'tags', category: 'lead_categories',
  test: 'deliverability_tests', folder: 'deliverability_folders',
  search: 'prospect_searches', fetch: 'prospect_fetches',
}

const snapshot = (table, id) =>
  JSON.stringify(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null)

test('a representative route from every module 404s on a foreign id and changes nothing', { timeout: 120_000 }, async () => {
  const wrong = []
  const mutated = []
  const registered = new Set(ROUTES.map((r) => `${r.method} ${r.path}`))

  for (const [method, template, fixture, body] of ISOLATION_CASES) {
    // Guard against the case list rotting silently as routes are renamed.
    assert.ok(
      registered.has(`${method} ${template.replace('/api', '')}`),
      `${method} ${template} is not a registered route — fix this case list`
    )
    const table = TABLE_OF[fixture]
    const id = foreign[fixture]
    assert.ok(id, `no foreign fixture called ${fixture}`)

    const before = snapshot(table, id)
    const res = await call(myCookie, method, template.replace(/:[^/]+/g, String(id)), body)
    const after = snapshot(table, id)

    if (res.status !== 404) wrong.push(`${method} ${template} (${fixture} ${id}) -> ${res.status} ${res.text.slice(0, 120)}`)
    if (res.text.includes(MARK)) wrong.push(`${method} ${template} LEAKED the foreign row`)
    if (before !== after) mutated.push(`${method} ${template} changed ${table}#${id}`)
  }

  assert.deepEqual(mutated, [], `a foreign row was written through a 404:\n${mutated.join('\n')}`)
  assert.deepEqual(wrong, [], `not a clean 404:\n${wrong.join('\n')}`)
})

test('aggregates and list routes count only our own rows', async () => {
  // The subtle failure the id sweep cannot see: a route that answers 200 with
  // our own shape but folds the other workspace's rows into a number.
  const lists = [
    ['/api/leads', 1], ['/api/campaigns', 1], ['/api/mailboxes', 1],
    ['/api/webhooks', 1], ['/api/clients', 1], ['/api/lead-lists', 1],
    ['/api/goals', 1], ['/api/tags', 1], ['/api/block-list', 1],
  ]
  for (const [path] of lists) {
    const res = await get(path)
    assert.equal(res.status, 200, `${path} -> ${res.status}`)
    assert.ok(!res.text.includes(MARK), `${path} listed the other workspace`)
    assert.ok(res.text.includes(MINE_MARK),
      `${path} returned nothing at all — the sweep would pass vacuously`)
  }

  // Counting routes: both workspaces hold exactly one campaign, one lead and
  // one live webhook, so any cross-workspace bleed shows up as two.
  const leads = JSON.parse((await get('/api/leads')).text)
  assert.equal(leads.length, 1, 'the lead list counted both workspaces')
  const campaigns = JSON.parse((await get('/api/campaigns')).text)
  assert.equal(campaigns.length, 1, 'the campaign list counted both workspaces')
  const hooks = JSON.parse((await get('/api/webhooks')).text)
  assert.equal(hooks.data.length, 1, 'the webhook list counted both workspaces')
  const dash = await get('/api/dashboard')
  assert.equal(dash.status, 200)
  assert.ok(!dash.text.includes(MARK))
})

// ---- 2. secret hygiene ------------------------------------------------------

test('no response body anywhere contains a webhook secret, an OAuth token or a billing blob', { timeout: 300_000 }, async () => {
  // Prove the needles are really in the database first, so a green sweep is not
  // a sweep for something that was never there.
  assert.equal(
    db.prepare('SELECT secret FROM webhooks WHERE workspace_id = ?').get(mine.id).secret,
    SECRETS.webhook_secret
  )
  assert.equal(
    db.prepare('SELECT refresh_token FROM mailboxes WHERE user_id = ?').get(mine.id).refresh_token,
    SECRETS.refresh_token
  )
  assert.equal(
    db.prepare('SELECT encrypted FROM sender_billing_details WHERE workspace_id = ?').get(mine.id).encrypted,
    SECRETS.billing_blob
  )

  const { sessionSecret } = await import('../server/db.js')
  const needles = {
    ...SECRETS,
    session_signing_secret: sessionSecret(),
    client_api_key_hash: db.prepare('SELECT key_hash FROM client_api_keys WHERE workspace_id = ?').get(mine.id).key_hash,
  }

  const found = []
  const check = (where, text) => {
    for (const [name, needle] of Object.entries(needles)) {
      if (needle && text.includes(needle)) found.push(`${name} in ${where}`)
    }
  }

  // Our own ids, so the routes genuinely return our rows rather than 404ing
  // past the projection that is under test.
  for (const route of GETS) {
    if (!PARAM_RE.test(route.path)) {
      const res = await get(`/api${route.path}`)
      check(`GET /api${route.path}`, res.text)
      continue
    }
    for (const id of OWN_IDS) {
      const path = `/api${fill(route.path, id)}`
      check(`GET ${path}`, (await get(path)).text)
    }
  }

  // The write paths that echo the row back are the other half of the surface.
  const echoes = [
    ['PATCH', `/api/webhooks/${own.webhook}`, { name: 'Renamed' }],
    ['PATCH', `/api/mailboxes/${own.mailbox}`, { display_name: 'Renamed' }],
    ['PUT', `/api/mailboxes/${own.mailbox}`, { dailyLimit: 40 }],
    ['PATCH', `/api/clients/${own.client}`, { color: '#123123' }],
    ['POST', `/api/clients/${own.client}/api-keys`, { key_name: 'Fresh key' }],
  ]
  for (const [method, path, body] of echoes) {
    const res = await call(myCookie, method, path, body)
    check(`${method} ${path}`, res.text)
  }

  assert.deepEqual(found, [], `a secret reached a response body:\n${found.join('\n')}`)
})

test('the activity trail never records a secret either', () => {
  // events is what the UI renders verbatim, so a secret written here is a
  // secret on screen. Checked against the stored rows, not a response.
  const detail = db.prepare('SELECT detail, type FROM events WHERE user_id = ?').all(mine.id)
    .map((e) => `${e.type} ${e.detail}`).join('\n')
  for (const [name, needle] of Object.entries(SECRETS)) {
    assert.ok(!detail.includes(needle), `${name} was written to the activity trail`)
  }
})
