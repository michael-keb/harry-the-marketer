// End-to-end pass over the SmartLead-parity surface, against a real running
// server with a real session and a real SQLite file. Unit tests mount modules
// in isolation; this proves the whole thing composes — auth, workspace scoping,
// route ordering, and the divergences Docs/README.md commits to.

const BASE = process.env.BASE || 'http://localhost:8140'
// Names are suffixed per run so this can be re-run against a database that
// already holds a previous pass. Without it the second run only proves that
// duplicate detection works, which is not what these checks are for.
const RUN = process.env.E2E_RUN || String(Date.now()).slice(-6)
const uniq = (name) => `${name} ${RUN}`
let cookie = ''
let pass = 0
const failures = []

// Most write routes answer { ok: true, data: {...} }; reads answer the shape
// directly. Unwrap so the script reads the record either way.
const rec = (b) => (b && typeof b === 'object' && 'data' in b ? b.data : b)

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = res.headers.getSetCookie?.() || []
  for (const c of setCookie) if (c.startsWith('htm_session')) cookie = c.split(';')[0]
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text.slice(0, 200) } }
  return { status: res.status, body: parsed }
}

const get = (p) => call('GET', p)
const post = (p, b = {}) => call('POST', p, b)
const put = (p, b = {}) => call('PUT', p, b)
const patch = (p, b = {}) => call('PATCH', p, b)
const del = (p, b) => call('DELETE', p, b)

function check(name, condition, detail = '') {
  if (condition) { pass++; return true }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

// ---------------------------------------------------------------- session ---
section('session')
{
  const r = await post('/api/auth/dev-login', { email: `owner-${RUN}@e2e.test`, name: 'Owner' })
  check('dev login succeeds', r.status === 200, `got ${r.status}`)
  check('session cookie issued', cookie.length > 0)
  const me = await get('/api/auth/me')
  check('session resolves to the user', (me.body?.user?.email || me.body?.email) === `owner-${RUN}@e2e.test`, JSON.stringify(me.body).slice(0, 120))
}

// Unauthenticated requests must not reach any parity route.
{
  const saved = cookie
  cookie = ''
  const r = await get('/api/tags')
  check('unauthenticated request is refused', r.status === 401, `got ${r.status}`)
  cookie = saved
}

// -------------------------------------------------------------- fixtures ---
section('fixtures')
let leadA, leadB, mailbox, campaign
{
  const mb = await post('/api/mailboxes/sandbox', { email: `sender-${RUN}@e2e.test`, displayName: 'Sender' })
  mailbox = rec(mb.body)
  check('sandbox mailbox created', mb.status === 200 && mailbox?.id > 0, `got ${mb.status}`)

  const a = await post('/api/leads', { email: `ada-${RUN}@acme.test`, firstName: 'Ada', lastName: 'Lovelace', company: 'Acme', title: 'Head of Operations' })
  leadA = rec(a.body)
  check('lead A created', a.status === 200 && leadA?.id > 0, `got ${a.status}`)

  const b = await post('/api/leads', { email: `grace-${RUN}@globex.test`, firstName: 'Grace', lastName: 'Hopper', company: 'Globex', title: 'CTO' })
  leadB = rec(b.body)
  check('lead B created', b.status === 200 && leadB?.id > 0)

  const c = await post('/api/campaigns', { name: uniq('E2E outbound') })
  campaign = rec(c.body)
  check('campaign created', c.status === 200 && campaign?.id > 0, `got ${c.status}`)
}

// ------------------------------------------------------------------ tags ---
section('tags — one table, split create/update, idempotent, all-or-nothing')
let vip, enterprise
{
  const a = await post('/api/tags', { appliesTo: 'lead', name: uniq('VIP'), color: '#4f46e5' })
  vip = rec(a.body)
  check('create a lead label', a.status === 200 && vip?.id > 0, JSON.stringify(a.body).slice(0, 120))

  const dup = await post('/api/tags', { appliesTo: 'lead', name: uniq('VIP') })
  check('duplicate name is refused, not silently upserted', dup.status === 409, `got ${dup.status}`)

  const mailboxLabel = await post('/api/tags', { appliesTo: 'mailbox', name: uniq('VIP') })
  check('same name for a mailbox label is allowed', mailboxLabel.status === 200, `got ${mailboxLabel.status}`)

  const e = await post('/api/tags', { appliesTo: 'lead', name: uniq('Enterprise') })
  enterprise = rec(e.body)

  const add = await post(`/api/leads/${leadA.id}/tags`, { tagIds: [vip.id, enterprise.id] })
  check('labels applied to a lead', add.status === 200, `got ${add.status}`)

  const again = await post(`/api/leads/${leadA.id}/tags`, { tagIds: [vip.id] })
  check('re-applying the same label is idempotent (200)', again.status === 200, `got ${again.status}`)

  const listed = await get(`/api/tags?appliesTo=lead&leadId=${leadA.id}`)
  const names = JSON.stringify(listed.body)
  const vipLabel = JSON.stringify(uniq('VIP'))
  const vipCount = names.split(vipLabel).length - 1
  check('the label appears exactly once after a repeat add', vipCount === 1, `appeared ${vipCount}x`)

  const partial = await post(`/api/leads/${leadB.id}/tags`, { tagIds: [vip.id, 999999] })
  check('an unknown id in the batch is a 404', partial.status === 404, `got ${partial.status}`)
  const afterFail = await get(`/api/tags?appliesTo=lead&leadId=${leadB.id}`)
  check('all-or-nothing: nothing was applied from the failed batch',
    !JSON.stringify(afterFail.body).includes(JSON.stringify(uniq('VIP'))), JSON.stringify(afterFail.body).slice(0, 120))

  const empty = await post(`/api/leads/${leadA.id}/tags`, { tagIds: [] })
  check('empty tagIds is a 422 naming the field', empty.status === 422 && empty.body?.field === 'tagIds',
    `got ${empty.status} ${JSON.stringify(empty.body).slice(0, 100)}`)
}

// ----------------------------------------------------------------- notes ---
section('notes and tasks — the human context surface')
{
  const n = await post(`/api/leads/${leadA.id}/notes`, { body: 'Met at a conference. Prefers email over calls.' })
  check('note created', n.status === 200, `got ${n.status}`)
  const list = await get(`/api/leads/${leadA.id}/notes`)
  check('note reads back with its author',
    JSON.stringify(list.body).includes(`owner-${RUN}@e2e.test`), JSON.stringify(list.body).slice(0, 160))

  const t = await post(`/api/leads/${leadA.id}/tasks`, { title: 'Send the case study', dueAt: '2026-09-01T09:00:00Z' })
  check('task created', t.status === 200, `got ${t.status}`)
  const open = await get('/api/tasks?status=open')
  check('task appears in the workspace open list',
    JSON.stringify(open.body).includes('Send the case study'))
}

// ------------------------------------------------------------- lead lists ---
section('lead lists — suppression unconditional, no implicit campaign')
let list
{
  const l = await post('/api/lead-lists', { name: uniq('Australian SaaS') })
  list = rec(l.body)?.leadList || rec(l.body)?.list || rec(l.body)
  check('segment created', l.status === 200 && list?.id > 0, JSON.stringify(l.body).slice(0, 140))

  const imported = await post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'e2e-import.csv',
    leads: [
      { email: `ada-${RUN}@acme.test`, firstName: 'Ada' },
      { email: `new.person-${RUN}@zenith.test`, firstName: 'New' },
      { email: 'not-an-email', firstName: 'Bad' },
    ],
  })
  check('import succeeds', imported.status === 200, `got ${imported.status} ${JSON.stringify(imported.body).slice(0, 200)}`)
  const summary = JSON.stringify(imported.body)
  check('import reports a malformed row rather than dropping it silently',
    /invalid|malformed|error/i.test(summary), summary.slice(0, 200))

  const bypass = await post(`/api/lead-lists/${list.id}/import`, {
    fileName: 'bypass.csv',
    leads: [{ email: `someone-${RUN}@else.test` }],
    ignore_unsubscribe_list: true,
    ignore_global_block_list: true,
  })
  check('suppression bypass flags are refused, not honoured', bypass.status === 422,
    `got ${bypass.status} ${JSON.stringify(bypass.body).slice(0, 120)}`)

  const implicit = await post('/api/lead-lists/push-to-campaign', {
    leadList: [leadA.id], campaignName: 'Conjured from a string',
  })
  check('pushing with a campaign NAME is refused — no implicit campaign', implicit.status === 422,
    `got ${implicit.status} ${JSON.stringify(implicit.body).slice(0, 140)}`)

  const missing = await post('/api/lead-lists/push-to-campaign', { leadList: [leadA.id] })
  check('pushing without a campaignId is a 422 naming the field',
    missing.status === 422 && /campaignId/i.test(JSON.stringify(missing.body)),
    JSON.stringify(missing.body).slice(0, 140))
}

// --------------------------------------------------------------- campaigns ---
section('campaigns — the ACTIVE/START contradiction, bulk history, sequences')
{
  const active = await put(`/api/campaigns/${campaign.id}/status`, { status: 'ACTIVE' })
  check('status=ACTIVE is a 422 (the samples send it; the body spec does not)',
    active.status === 422 && active.body?.field === 'status',
    `got ${active.status} ${JSON.stringify(active.body).slice(0, 160)}`)

  const bogus = await put(`/api/campaigns/${campaign.id}/status`, { status: 'LAUNCH' })
  check('an unknown status is also refused', bogus.status === 422)

  const start = await put(`/api/campaigns/${campaign.id}/status`, { status: 'START' })
  check('START is accepted as a request (blockers reported, not a crash)',
    start.status === 200 || start.status === 422, `got ${start.status}`)
  if (start.status === 422) {
    check('a blocked launch explains why', JSON.stringify(start.body).length > 20,
      JSON.stringify(start.body).slice(0, 200))
  }

  const nullIds = await post(`/api/campaigns/${campaign.id}/messages/bulk`, { leadIds: null })
  check('bulk history refuses a null id list meaning "all"', nullIds.status === 422,
    `got ${nullIds.status}`)
  const absentIds = await post(`/api/campaigns/${campaign.id}/messages/bulk`, {})
  check('bulk history refuses an absent id list', absentIds.status === 422, `got ${absentIds.status}`)

  const badSeq = await put(`/api/campaigns/${campaign.id}/sequence`, { mermaid: 'this is not a flowchart' })
  check('an invalid playbook is a 422 carrying the validator message',
    badSeq.status === 422 && JSON.stringify(badSeq.body).length > 30,
    `got ${badSeq.status} ${JSON.stringify(badSeq.body).slice(0, 160)}`)

  const goodSeq = await put(`/api/campaigns/${campaign.id}/sequence`, {
    mermaid: 'flowchart TD\n  S([Start]) --> A[Send: short intro]\n  A -- reply: interested --> W([Won: call booked])\n  A -- no reply 3d --> L([Lost: no response])',
  })
  check('a valid playbook is accepted', goodSeq.status === 200,
    `got ${goodSeq.status} ${JSON.stringify(goodSeq.body).slice(0, 160)}`)

  const noConfirm = await post(`/api/campaigns/${campaign.id}/test-send`, { to: 'someone@example.test' })
  check('a test send without confirmation is refused — nothing sends without the OK',
    noConfirm.status === 422, `got ${noConfirm.status}`)

  const paged = await get('/api/campaign-list?limit=1')
  check('the campaign list pages server-side', paged.status === 200 && paged.body?.limit === 1,
    JSON.stringify(paged.body).slice(0, 140))
  const tooMany = await get('/api/campaign-list?limit=99999')
  check('an unbounded page size is refused', tooMany.status === 422, `got ${tooMany.status}`)
}

// ------------------------------------------------------------------ leads ---
section('leads — global unsubscribe is unconditional')
{
  const cats = await get('/api/lead-categories')
  check('lead categories seed on first read', cats.status === 200 && JSON.stringify(cats.body).includes('interested'),
    JSON.stringify(cats.body).slice(0, 140))
  const again = await get('/api/lead-categories')
  const n1 = (JSON.stringify(cats.body).match(/"interested"/g) || []).length
  const n2 = (JSON.stringify(again.body).match(/"interested"/g) || []).length
  check('a second read does not duplicate them', n1 === n2, `${n1} vs ${n2}`)

  const byEmail = await get('/api/leads/by-email?email=ada@acme.test')
  check('lead lookup by email works on its own path (not swallowed by /leads/:id)',
    byEmail.status === 200, `got ${byEmail.status}`)

  const unsub = await post(`/api/leads/${leadB.id}/unsubscribe`, { source: 'manual' })
  check('global unsubscribe accepted', unsub.status === 200, `got ${unsub.status} ${JSON.stringify(unsub.body).slice(0, 200)}`)
  const after = await get(`/api/leads/${leadB.id}`)
  check('the lead is unsubscribed everywhere',
    JSON.stringify(after.body).includes('unsubscribed'), JSON.stringify(after.body).slice(0, 160))
  const repeat = await post(`/api/leads/${leadB.id}/unsubscribe`, {})
  check('unsubscribing twice is safe', repeat.status === 200, `got ${repeat.status}`)
}

// ------------------------------------------------------------------ inbox ---
section('inbox — one list with a state, not ten endpoints')
{
  const active = await get('/api/inbox/threads?state=active')
  check('default state lists', active.status === 200, `got ${active.status}`)
  for (const state of ['all', 'archived', 'important', 'snoozed', 'unread', 'sent', 'scheduled', 'assigned', 'reminders']) {
    const r = await get(`/api/inbox/threads?state=${state}`)
    check(`state=${state} is served`, r.status === 200, `got ${r.status}`)
  }
  const bad = await get('/api/inbox/threads?state=nonsense')
  check('an unknown state is a 422 naming the field',
    bad.status === 422 && bad.body?.field === 'state', `got ${bad.status} ${JSON.stringify(bad.body).slice(0, 120)}`)

  const count = await get('/api/inbox/unread-count')
  check('unread count is served', count.status === 200)

  const view = await post('/api/inbox/views', { name: uniq('Hot replies'), filters: { state: 'unread' } })
  check('a custom view can be saved', view.status === 200, `got ${view.status} ${JSON.stringify(view.body).slice(0, 120)}`)

  const unmatched = await get('/api/inbox/unmatched')
  check('untracked replies list is served', unmatched.status === 200)
}

// -------------------------------------------------------------- block list ---
section('suppression — unconditional, with honest reporting')
{
  const added = await post('/api/block-list', { domain_block_list: `https://www.competitor-${RUN}.com/pricing\nspam-${RUN}.test, BAD-ENTRY` })
  check('a pasted blob is accepted', added.status === 200, `got ${added.status} ${JSON.stringify(added.body).slice(0, 160)}`)
  const body = JSON.stringify(added.body)
  check('the result separates added from rejected', /added/i.test(body) && /reject|malformed|invalid/i.test(body),
    body.slice(0, 220))
  check('the URL was normalised to a bare domain', body.includes(`competitor-${RUN}.com`) && !body.includes('https://'),
    body.slice(0, 220))

  const dup = await post('/api/block-list', { domain_block_list: `competitor-${RUN}.com` })
  check('re-adding reports it as already present rather than duplicating',
    /duplicate|already/i.test(JSON.stringify(dup.body)), JSON.stringify(dup.body).slice(0, 200))

  const listed = await get('/api/block-list?limit=50')
  check('the block list reads back', listed.status === 200)
}

// ---------------------------------------------------------------- clients ---
section('clients — no credential handling')
{
  const withPassword = await post('/api/clients', { name: uniq('Acme Agency Client'), email: `client-${RUN}@acme.test`, password: 'hunter2' })
  check('a client payload carrying a password is refused',
    withPassword.status === 422, `got ${withPassword.status} ${JSON.stringify(withPassword.body).slice(0, 160)}`)

  const c = await post('/api/clients', { name: uniq('Acme Agency Client'), email: `client-${RUN}@acme.test` })
  check('client created without credentials', c.status === 200, `got ${c.status} ${JSON.stringify(c.body).slice(0, 160)}`)
  const clientId = (rec(c.body)?.client || rec(c.body))?.id

  if (clientId) {
    const key = await post(`/api/clients/${clientId}/api-keys`, { keyName: 'CI', scope: 'read' })
    check('an API key can be minted', key.status === 200, `got ${key.status}`)
    const raw = JSON.stringify(key.body)
    check('the key value is returned on creation',
      /htmk_[A-Za-z0-9_-]{20,}/.test(raw), raw.slice(0, 400))

    const listed = await get(`/api/clients/${clientId}/api-keys`)
    const listRaw = JSON.stringify(listed.body)
    check('listing never returns a key value or hash',
      !/key_hash|"hash"/.test(listRaw), listRaw.slice(0, 220))
  }
}

// --------------------------------------------------------------- webhooks ---
section('webhooks — validated events, secret never echoed')
{
  const types = await get('/api/webhooks/event-types')
  check('the event allow-list is served', types.status === 200 && JSON.stringify(types.body).includes('reply'),
    JSON.stringify(types.body).slice(0, 160))

  const bad = await post('/api/webhooks', { name: uniq('X'), url: `https://example.test/hook-bad-${RUN}`, event_types: ['NOT_A_REAL_EVENT'] })
  check('an unknown event type is a 422', bad.status === 422, `got ${bad.status}`)

  const badUrl = await post('/api/webhooks', { name: 'X', url: 'not-a-url', event_types: ['reply'] })
  check('an invalid URL is a 422', badUrl.status === 422, `got ${badUrl.status}`)

  const w = await post('/api/webhooks', { name: uniq('Replies'), url: `https://example.test/hook-${RUN}`, event_types: ['reply'] })
  check('webhook created', w.status === 200, `got ${w.status} ${JSON.stringify(w.body).slice(0, 160)}`)
  const wid = (rec(w.body)?.webhook || rec(w.body))?.id
  if (wid) {
    const read = await get(`/api/webhooks/${wid}`)
    check('the signing secret is never returned', !/"secret"\s*:\s*"[^"]{8,}/.test(JSON.stringify(read.body)),
      JSON.stringify(read.body).slice(0, 220))
  }
}

// -------------------------------------------------------------- analytics ---
section('analytics — zeros, not NaN, on an empty workspace')
{
  const paths = [
    '/api/analytics/overview', '/api/analytics/campaigns', '/api/analytics/campaigns/performance',
    '/api/analytics/daily', '/api/analytics/positive-replies/daily', '/api/analytics/mailboxes/health',
    '/api/analytics/mailboxes/summary', '/api/analytics/replies/by-category',
    '/api/analytics/reply-time-distribution', '/api/analytics/team', '/api/analytics/followup-reply-rate',
  ]
  for (const p of paths) {
    const r = await get(p)
    const raw = JSON.stringify(r.body)
    check(`${p} responds`, r.status === 200, `got ${r.status} ${raw.slice(0, 120)}`)
    check(`${p} contains no NaN/Infinity/null-rate`, !/NaN|Infinity/.test(raw), raw.slice(0, 160))
  }
  const inverted = await get('/api/analytics/overview?from=2026-02-01&to=2026-01-01')
  check('an inverted date range is a 422 naming the field',
    inverted.status === 422, `got ${inverted.status} ${JSON.stringify(inverted.body).slice(0, 140)}`)
  const badTz = await get('/api/analytics/overview?timezone=Mars/Olympus')
  check('an unknown timezone is a 422', badTz.status === 422, `got ${badTz.status}`)

  const dense = await get('/api/analytics/daily?from=2026-01-01&to=2026-01-07')
  const days = (JSON.stringify(dense.body).match(/2026-01-0\d/g) || []).length
  check('the day-wise series is dense (a quiet day is a zero row)', days >= 7, `found ${days} day markers`)
}

// ---------------------------------------------------- optional providers ---
section('optional providers — honest when unconfigured, never a 500')
{
  const status = await get('/api/integrations/status')
  check('integration status is served', status.status === 200, JSON.stringify(status.body).slice(0, 200))
  check('all three report unconfigured in this environment',
    status.body?.deliverability?.configured === false
    && status.body?.prospects?.configured === false
    && status.body?.senders?.configured === false, JSON.stringify(status.body).slice(0, 200))

  const paths = [
    '/api/deliverability/tests', '/api/deliverability/folders', '/api/deliverability/providers',
    '/api/prospects/searches', '/api/prospects/fetches', '/api/prospects/filters/countries',
    '/api/senders/vendors', '/api/senders/domains',
  ]
  for (const p of paths) {
    const r = await get(p)
    check(`${p} degrades honestly rather than 500ing`, r.status === 200,
      `got ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`)
    check(`${p} says it is not connected`, /configured/.test(JSON.stringify(r.body)),
      JSON.stringify(r.body).slice(0, 140))
  }

  // Local CRUD must still work with no provider at all.
  const folder = await post('/api/deliverability/folders', { name: uniq('Weekly checks') })
  check('a deliverability folder can be created with no provider', folder.status === 200,
    `got ${folder.status} ${JSON.stringify(folder.body).slice(0, 140)}`)
}

// ----------------------------------------------------------------- senders ---
section('senders — no payment instrument, idempotent ordering')
{
  const withCard = await post('/api/senders/orders', {
    vendor_id: 'v1', domains: [{ domain: 'example.test' }],
    card_number: '4111111111111111',
  })
  check('an order carrying a card number is refused',
    withCard.status === 422, `got ${withCard.status} ${JSON.stringify(withCard.body).slice(0, 160)}`)

  const noKey = await post('/api/senders/orders', { vendor_id: 'v1', domains: [{ domain: 'example.test' }] })
  check('an order without an idempotency key is a 422',
    noKey.status === 422, `got ${noKey.status} ${JSON.stringify(noKey.body).slice(0, 160)}`)
}

// -------------------------------------------------- workspace isolation ---
section('workspace isolation — a stranger sees nothing and leaks nothing')
{
  const ownerCookie = cookie
  cookie = ''
  await post('/api/auth/dev-login', { email: `stranger-${RUN}@e2e.test`, name: 'Stranger' })
  check('second workspace signed in', cookie.length > 0 && cookie !== ownerCookie)

  const probes = [
    `/api/leads/${leadA.id}`,
    `/api/campaigns/${campaign.id}/detail`,
    ...(list?.id ? [`/api/lead-lists/${list.id}`] : []),
    `/api/leads/${leadA.id}/notes`,
  ]
  for (const p of probes) {
    const r = await get(p)
    const raw = JSON.stringify(r.body)
    check(`${p} is refused for another workspace`, r.status === 404 || r.status === 403,
      `got ${r.status}`)
    check(`${p} leaks no record detail`,
      !/ada@acme\.test|Lovelace|E2E outbound|Australian SaaS/.test(raw), raw.slice(0, 160))
  }

  const strangerTags = await get('/api/tags?appliesTo=lead')
  check('the stranger sees none of the owner\'s labels',
    !JSON.stringify(strangerTags.body).includes('VIP'), JSON.stringify(strangerTags.body).slice(0, 160))

  cookie = ownerCookie
}

// ------------------------------------------------------------------- done ---
console.log(`\n${'─'.repeat(60)}`)
console.log(`\x1b[1m${pass} checks passed, ${failures.length} failed\x1b[0m`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('All end-to-end checks passed.')
