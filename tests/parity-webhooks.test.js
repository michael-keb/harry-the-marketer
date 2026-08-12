// Outbound webhooks — Docs/webhooks/* and the five campaign webhook files in
// Docs/campaigns/*. No test here touches the network: the delivery layer takes
// an injected transport, and every assertion about a POST is an assertion about
// what that stub was handed.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { setup, seedUser, seedCampaign, mount } from './helpers/parity-harness.js'

setup('webhooks')                  // MUST precede any ../server import

const { db } = await import('../server/db.js')
const {
  register,
  fireWebhooks,
  signPayload,
  setWebhookTransport,
  WEBHOOK_EVENT_TYPES,
  normalizeEventType,
} = await import('../server/parity/webhooks.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

const ownerCampaign = seedCampaign(db, owner.id, 'Q3 outbound')
const otherCampaign = seedCampaign(db, owner.id, 'Q4 outbound')
const strangerCampaign = seedCampaign(db, stranger.id, "Someone else's")

const HOOK_URL = 'https://hooks.example.test/inbound'

// A transport that records every call and answers from a script.
function stub(script = [{ status: 200 }]) {
  const calls = []
  let i = 0
  const fn = async (url, init) => {
    calls.push({ url, init, headers: init?.headers || {}, body: init?.body })
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    if (step.throw) throw new Error(step.throw)
    return {
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      text: async () => step.text || '',
    }
  }
  fn.calls = calls
  return fn
}

function createWebhook(body) {
  return client.post('/api/webhooks', body)
}

// The shared harness always mounts as the workspace owner; the role gate needs
// a member and a manager acting in the SAME workspace, so this mounts `register`
// with a chosen `wsRole` while keeping wsId on the owner's workspace.
async function mountAs(role) {
  const app = express()
  const api = express.Router()
  api.use(express.json({ limit: '5mb' }))
  api.use((req, _res, next) => {
    req.user = owner
    req.wsId = owner.id
    req.wsRole = role
    req.wsOwnerEmail = owner.email
    next()
  })
  register(api)
  app.use('/api', api)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const send = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
    return { status: res.status, body: parsed }
  }
  return {
    post: (u, b = {}) => send('POST', u, b),
    patch: (u, b = {}) => send('PATCH', u, b),
    del: (u, b) => send('DELETE', u, b),
    close: () => new Promise((r) => server.close(r)),
  }
}

function deliveriesFor(webhookId) {
  return db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id').all(webhookId)
}

// ---------------------------------------------------------------- allow-list

test('the event allow-list is exported and normalises upstream constants', () => {
  assert.ok(Array.isArray(WEBHOOK_EVENT_TYPES) && WEBHOOK_EVENT_TYPES.length > 0)
  assert.ok(WEBHOOK_EVENT_TYPES.includes('reply'))
  assert.equal(normalizeEventType('EMAIL_REPLY'), 'reply')
  assert.equal(normalizeEventType('LEAD_REPLIED'), 'reply')
  assert.equal(normalizeEventType('reply'), 'reply')
  assert.equal(normalizeEventType('EMAIL_TELEPATHY'), null)
})

// -------------------------------------------------------------------- create

test('create: workspace-wide happy path returns the id and never the secret', async () => {
  const res = await createWebhook({
    name: 'CRM Integration',
    webhook_url: HOOK_URL,
    association_type: 'user',
    event_type_map: { EMAIL_REPLY: true, EMAIL_OPEN: true },
    secret: 'super-secret-value',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.ok(res.body.id > 0)
  assert.equal(res.body.webhook_url, HOOK_URL)
  assert.deepEqual(res.body.data.event_types.sort(), ['opened', 'reply'])
  assert.equal(res.body.data.is_active, true)
  assert.equal(res.body.data.scope, 'user')

  // The secret is not in the body under any key or nesting.
  assert.ok(!JSON.stringify(res.body).includes('super-secret-value'))
  assert.equal(res.body.data.secret, undefined)

  // It is stored, though — signing depends on it.
  const stored = db.prepare('SELECT secret FROM webhooks WHERE id = ?').get(res.body.id)
  assert.equal(stored.secret, 'super-secret-value')

  await client.del(`/api/webhooks/${res.body.id}`)
})

test('create: campaign scope requires a campaign id, and 404s on a stranger\'s', async () => {
  const missing = await createWebhook({
    name: 'Scoped', webhook_url: HOOK_URL, association_type: 'campaign', event_types: ['EMAIL_REPLY'],
  })
  assert.equal(missing.status, 422)
  assert.equal(missing.body.field, 'email_campaign_id')

  const cross = await createWebhook({
    name: 'Scoped',
    webhook_url: HOOK_URL,
    association_type: 'campaign',
    email_campaign_id: strangerCampaign.id,
    event_types: ['EMAIL_REPLY'],
  })
  assert.equal(cross.status, 404)
  assert.equal(cross.body.error, 'not_found')
  assert.ok(!JSON.stringify(cross.body).includes("Someone else's"))
})

test('create: an unknown event type is a 422 naming the field and listing the valid values', async () => {
  const res = await createWebhook({
    name: 'Bad events', webhook_url: HOOK_URL, event_types: ['EMAIL_TELEPATHY'],
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'event_types')
  assert.match(res.body.message, /EMAIL_TELEPATHY/)
  assert.match(res.body.message, /reply/)
})

test('create: event_types is required and may not be empty', async () => {
  const none = await createWebhook({ name: 'No events', webhook_url: HOOK_URL })
  assert.equal(none.status, 422)
  assert.equal(none.body.field, 'event_types')

  const empty = await createWebhook({ name: 'No events', webhook_url: HOOK_URL, event_types: [] })
  assert.equal(empty.status, 422)
  assert.equal(empty.body.field, 'event_types')
})

test('create: non-https, private and malformed URLs are all refused naming webhook_url', async () => {
  const cases = [
    'http://hooks.example.test/x',
    'https://localhost:9000/hook',
    'https://127.0.0.1/hook',
    'https://10.0.0.5/hook',
    'https://192.168.1.10/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://internal-box/hook',
    'not-a-url',
  ]
  for (const url of cases) {
    const res = await createWebhook({ name: 'SSRF', webhook_url: url, event_types: ['EMAIL_REPLY'] })
    assert.equal(res.status, 422, `expected 422 for ${url}`)
    assert.equal(res.body.field, 'webhook_url', `expected webhook_url named for ${url}`)
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM webhooks WHERE name = ?').get('SSRF').n, 0)
})

test('create: association_type "client" is refused with a reason', async () => {
  const res = await createWebhook({
    name: 'Agency', webhook_url: HOOK_URL, association_type: 'client', event_types: ['EMAIL_REPLY'],
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'association_type')
})

test('create: a duplicate URL in the same scope needs force_create', async () => {
  const url = 'https://hooks.example.test/dupe'
  const first = await createWebhook({ name: 'One', webhook_url: url, event_types: ['EMAIL_SENT'] })
  assert.equal(first.status, 200)

  const second = await createWebhook({ name: 'Two', webhook_url: url, event_types: ['EMAIL_SENT'] })
  assert.equal(second.status, 409)
  assert.equal(second.body.existing_id, first.body.id)

  const forced = await createWebhook({
    name: 'Two', webhook_url: url, event_types: ['EMAIL_SENT'], force_create: true,
  })
  assert.equal(forced.status, 200)

  await client.del(`/api/webhooks/${first.body.id}`)
  await client.del(`/api/webhooks/${forced.body.id}`)
})

// ---------------------------------------------------------------------- read

test('read: returns a complete event_type_map, recent deliveries and no secret', async () => {
  const created = await createWebhook({
    name: 'Readable', webhook_url: 'https://hooks.example.test/read',
    event_types: ['EMAIL_SENT', 'EMAIL_REPLY'], secret: 'read-secret-xyz',
  })
  const id = created.body.id

  const res = await client.get(`/api/webhooks/${id}`)
  assert.equal(res.status, 200)
  const data = res.body.data
  assert.equal(Object.keys(data.event_type_map).length, WEBHOOK_EVENT_TYPES.length)
  assert.equal(data.event_type_map.sent, true)
  assert.equal(data.event_type_map.reply, true)
  assert.equal(data.event_type_map.clicked, false)   // present and false, not omitted
  assert.deepEqual(data.deliveries, [])
  assert.ok(!JSON.stringify(res.body).includes('read-secret-xyz'))

  await client.del(`/api/webhooks/${id}`)
})

test('read: missing and cross-workspace ids return the same 404', async () => {
  const strangerHook = db.prepare(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories)
     VALUES (?, NULL, 'Theirs', ?, 'x', '["reply"]', '[]')`
  ).run(stranger.id, 'https://hooks.example.test/theirs').lastInsertRowid

  const cross = await client.get(`/api/webhooks/${strangerHook}`)
  const missing = await client.get('/api/webhooks/99999')
  assert.equal(cross.status, 404)
  assert.equal(missing.status, 404)
  assert.deepEqual(cross.body, missing.body)
  assert.ok(!JSON.stringify(cross.body).includes('Theirs'))
})

// -------------------------------------------------------------------- update

test('update: merges partially, normalises both event shapes and never touches the secret', async () => {
  const created = await createWebhook({
    name: 'Before', webhook_url: 'https://hooks.example.test/patch',
    event_types: ['EMAIL_SENT', 'EMAIL_OPEN', 'EMAIL_LINK_CLICK', 'EMAIL_REPLY'],
    secret: 'unchanged-secret',
  })
  const id = created.body.id

  // One field only: everything else survives.
  const renamed = await client.patch(`/api/webhooks/${id}`, { name: 'After' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.data.name, 'After')
  assert.equal(renamed.body.data.event_types.length, 4)
  assert.equal(renamed.body.data.webhook_url, 'https://hooks.example.test/patch')

  // An array replaces the selection wholesale rather than adding to it.
  const narrowed = await client.patch(`/api/webhooks/${id}`, { event_types: ['EMAIL_REPLY'] })
  assert.deepEqual(narrowed.body.data.event_types, ['reply'])

  // The map shape normalises to exactly the same stored value.
  const viaMap = await client.patch(`/api/webhooks/${id}`, { event_type_map: { EMAIL_REPLY: true, EMAIL_SENT: false } })
  assert.deepEqual(viaMap.body.data.event_types, ['reply'])

  // An empty selection is legal on update, and says so plainly.
  const cleared = await client.patch(`/api/webhooks/${id}`, { event_types: [] })
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.body.data.event_types, [])

  // The URL edit revalidates, and the secret is provably untouched throughout.
  const bad = await client.patch(`/api/webhooks/${id}`, { webhook_url: 'https://127.0.0.1/x' })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'webhook_url')

  const moved = await client.patch(`/api/webhooks/${id}`, { webhook_url: 'https://hooks.example.test/moved' })
  assert.equal(moved.status, 200)
  assert.equal(db.prepare('SELECT secret FROM webhooks WHERE id = ?').get(id).secret, 'unchanged-secret')
  assert.ok(!JSON.stringify(moved.body).includes('unchanged-secret'))

  await client.del(`/api/webhooks/${id}`)
})

test('update: a corrective save resumes an auto-paused endpoint', async () => {
  const created = await createWebhook({
    name: 'Paused', webhook_url: 'https://hooks.example.test/paused', event_types: ['EMAIL_SENT'],
  })
  const id = created.body.id
  db.prepare('UPDATE webhooks SET is_active = 0 WHERE id = ?').run(id)

  const resumed = await client.patch(`/api/webhooks/${id}`, { webhook_url: 'https://hooks.example.test/fixed' })
  assert.equal(resumed.body.data.is_active, true)
  assert.ok(resumed.body.changed.includes('resumed'))

  await client.del(`/api/webhooks/${id}`)
})

test('update and delete on a cross-workspace id both 404', async () => {
  const theirs = db.prepare(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories)
     VALUES (?, NULL, 'Theirs2', ?, 'x', '["reply"]', '[]')`
  ).run(stranger.id, 'https://hooks.example.test/theirs2').lastInsertRowid

  assert.equal((await client.patch(`/api/webhooks/${theirs}`, { name: 'Mine now' })).status, 404)
  assert.equal((await client.del(`/api/webhooks/${theirs}`)).status, 404)
  assert.equal(db.prepare('SELECT name FROM webhooks WHERE id = ?').get(theirs).name, 'Theirs2')
})

// -------------------------------------------------------------------- delete

test('delete: 200 then 404, history survives, and delivery stops', async () => {
  const created = await createWebhook({
    name: 'Doomed', webhook_url: 'https://hooks.example.test/doomed', event_types: ['EMAIL_SENT'],
  })
  const id = created.body.id

  const transport = stub([{ status: 200 }])
  await fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id }, { fetchImpl: transport, backoffMs: 0 })
  assert.equal(transport.calls.length, 1)
  assert.equal(deliveriesFor(id).length, 1)

  const first = await client.del(`/api/webhooks/${id}`)
  assert.equal(first.status, 200)
  assert.equal(first.body.success, true)
  const second = await client.del(`/api/webhooks/${id}`)
  assert.equal(second.status, 404)
  assert.equal((await client.get(`/api/webhooks/${id}`)).status, 404)

  // The audit trail outlives the endpoint.
  assert.equal(deliveriesFor(id).length, 1)

  // And nothing is delivered after the deletion.
  const after = stub([{ status: 200 }])
  await fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id }, { fetchImpl: after, backoffMs: 0 })
  assert.equal(after.calls.length, 0)
})

// ------------------------------------------------------------ campaign scope

test('campaign webhooks: upsert creates then updates, and lists with is_active', async () => {
  const created = await client.post(`/api/campaigns/${ownerCampaign.id}/webhooks`, {
    id: null, name: 'CRM Integration', webhook_url: 'https://crm.example.test/webhook',
    event_types: ['LEAD_REPLIED', 'LEAD_OPENED'],
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.success, true)
  assert.equal(created.body.created, true)
  assert.ok(created.body.data.id > 0)
  assert.deepEqual(created.body.data.event_types.sort(), ['opened', 'reply'])
  assert.equal(created.body.data.campaign_id, ownerCampaign.id)

  const updated = await client.post(`/api/campaigns/${ownerCampaign.id}/webhooks`, {
    id: created.body.data.id, name: 'CRM Integration v2',
    webhook_url: 'https://crm.example.test/webhook', event_types: ['LEAD_REPLIED'], is_active: false,
  })
  assert.equal(updated.body.created, false)
  assert.equal(updated.body.data.id, created.body.data.id)
  assert.equal(updated.body.data.name, 'CRM Integration v2')
  assert.equal(updated.body.data.is_active, false)

  const list = await client.get(`/api/campaigns/${ownerCampaign.id}/webhooks`)
  assert.equal(list.status, 200)
  assert.equal(list.body.success, true)
  assert.equal(list.body.data.length, 1)
  assert.equal(list.body.data[0].is_active, false)   // explicit "Off", not omission
  assert.ok(!JSON.stringify(list.body).includes('"secret"'))

  await client.del(`/api/campaigns/${ownerCampaign.id}/webhooks/${created.body.data.id}`)
})

test('campaign webhooks: an empty campaign lists data: [] with a 200', async () => {
  const res = await client.get(`/api/campaigns/${otherCampaign.id}/webhooks`)
  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)
  assert.deepEqual(res.body.data, [])
})

test('campaign webhooks: cross-workspace 404s and a non-numeric id is a 422', async () => {
  assert.equal((await client.get(`/api/campaigns/${strangerCampaign.id}/webhooks`)).status, 404)
  assert.equal((await client.post(`/api/campaigns/${strangerCampaign.id}/webhooks`, {
    name: 'x', webhook_url: HOOK_URL, event_types: ['EMAIL_SENT'],
  })).status, 404)

  const bad = await client.get('/api/campaigns/not-a-number/webhooks')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'id')
})

test('campaign webhooks: delete is pair-verified and idempotent from the client\'s view', async () => {
  const mine = await client.post(`/api/campaigns/${ownerCampaign.id}/webhooks`, {
    name: 'Pairing', webhook_url: 'https://hooks.example.test/pair', event_types: ['EMAIL_SENT'],
  })
  const id = mine.body.data.id

  // Right webhook, wrong campaign.
  const wrongPair = await client.del(`/api/campaigns/${otherCampaign.id}/webhooks/${id}`)
  assert.equal(wrongPair.status, 404)
  assert.equal(db.prepare('SELECT is_active FROM webhooks WHERE id = ?').get(id).is_active, 1)

  const badId = await client.del(`/api/campaigns/${ownerCampaign.id}/webhooks/not-a-number`)
  assert.equal(badId.status, 422)
  assert.equal(badId.body.field, 'webhook_id')

  const ok = await client.del(`/api/campaigns/${ownerCampaign.id}/webhooks/${id}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.message, 'Webhook deleted successfully')
  assert.equal((await client.del(`/api/campaigns/${ownerCampaign.id}/webhooks/${id}`)).status, 404)
})

// ------------------------------------------------------------------ delivery

test('delivery: signs the body, records one row, and the signature verifies', async () => {
  const created = await createWebhook({
    name: 'Signed', webhook_url: 'https://hooks.example.test/signed',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id,
    event_types: ['EMAIL_REPLY'], secret: 'known-secret',
  })
  const id = created.body.id

  const transport = stub([{ status: 200 }])
  const results = await fireWebhooks(
    owner.id, 'EMAIL_REPLY',
    { campaign_id: ownerCampaign.id, from_email: 'lead@acme.test', subject: 'Re: hello' },
    { fetchImpl: transport, backoffMs: 0 }
  )
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, true)
  assert.equal(results[0].attempts, 1)

  const call = transport.calls[0]
  assert.equal(call.url, 'https://hooks.example.test/signed')
  assert.equal(call.headers['X-Harry-Event'], 'reply')
  assert.equal(call.headers['X-Harry-Delivery-Attempt'], '1')
  assert.equal(call.headers['X-Harry-Signature'], signPayload('known-secret', call.body))

  // The signature is a real HMAC of the body, not a placeholder.
  const expected = 'sha256=' + crypto.createHmac('sha256', 'known-secret').update(call.body).digest('hex')
  assert.equal(call.headers['X-Harry-Signature'], expected)

  const sent = JSON.parse(call.body)
  assert.equal(sent.event_type, 'reply')
  assert.equal(sent.campaign_id, ownerCampaign.id)
  assert.equal(sent.from_email, 'lead@acme.test')
  assert.ok(sent.event_id)

  const rows = deliveriesFor(id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ok, 1)
  assert.equal(rows[0].attempt, 1)
  assert.equal(rows[0].status_code, 200)
  assert.equal(rows[0].event_type, 'reply')

  await client.del(`/api/webhooks/${id}`)
})

test('delivery: a 500 is retried with bounded attempts and every attempt is recorded', async () => {
  const created = await createWebhook({
    name: 'Flaky', webhook_url: 'https://hooks.example.test/flaky',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id, event_types: ['EMAIL_SENT'],
  })
  const id = created.body.id

  const transport = stub([{ status: 500, text: 'boom' }])
  const [result] = await fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id }, {
    fetchImpl: transport, backoffMs: 0,
  })
  assert.equal(result.ok, false)
  assert.equal(result.attempts, 3)
  assert.equal(transport.calls.length, 3)

  const rows = deliveriesFor(id)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.attempt), [1, 2, 3])
  assert.deepEqual(rows.map((r) => r.ok), [0, 0, 0])
  assert.ok(rows[0].error.includes('500'))
  assert.deepEqual(JSON.parse(rows[0].payload).event_type, 'sent')

  await client.del(`/api/webhooks/${id}`)
})

test('delivery: a 4xx is recorded once and not retried', async () => {
  const created = await createWebhook({
    name: 'Rejecting', webhook_url: 'https://hooks.example.test/reject',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id, event_types: ['EMAIL_SENT'],
  })
  const id = created.body.id

  const transport = stub([{ status: 400, text: 'nope' }])
  const [result] = await fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id }, {
    fetchImpl: transport, backoffMs: 0,
  })
  assert.equal(result.ok, false)
  assert.equal(transport.calls.length, 1)
  assert.equal(deliveriesFor(id).length, 1)

  await client.del(`/api/webhooks/${id}`)
})

test('delivery: a transport that throws never escapes fireWebhooks', async () => {
  const created = await createWebhook({
    name: 'Exploding', webhook_url: 'https://hooks.example.test/explode',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id, event_types: ['EMAIL_SENT'],
  })
  const id = created.body.id

  const transport = stub([{ throw: 'socket hang up' }])
  const results = await fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id }, {
    fetchImpl: transport, backoffMs: 0,
  })
  assert.equal(results[0].ok, false)
  const rows = deliveriesFor(id)
  assert.equal(rows.length, 3)                       // network errors are retryable
  assert.ok(rows[0].error.includes('socket hang up'))

  await client.del(`/api/webhooks/${id}`)
})

test('delivery: an unknown event type and an unrelated workspace deliver nothing', async () => {
  const created = await createWebhook({
    name: 'Quiet', webhook_url: 'https://hooks.example.test/quiet',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id, event_types: ['EMAIL_SENT'],
  })
  const transport = stub([{ status: 200 }])
  await fireWebhooks(owner.id, 'EMAIL_TELEPATHY', { campaign_id: ownerCampaign.id }, { fetchImpl: transport })
  await fireWebhooks(stranger.id, 'sent', { campaign_id: ownerCampaign.id }, { fetchImpl: transport })
  await fireWebhooks(owner.id, 'sent', { campaign_id: otherCampaign.id }, { fetchImpl: transport })
  assert.equal(transport.calls.length, 0)

  await client.del(`/api/webhooks/${created.body.id}`)
})

test('delivery: a workspace-level endpoint overrides a campaign-level one for the same event', async () => {
  const wide = await createWebhook({
    name: 'Workspace wide', webhook_url: 'https://hooks.example.test/wide',
    association_type: 'user', event_types: ['EMAIL_REPLY'],
  })
  const scoped = await createWebhook({
    name: 'Campaign only', webhook_url: 'https://hooks.example.test/scoped',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id, event_types: ['EMAIL_REPLY'],
  })
  assert.equal(scoped.body.data.overridden, true)

  const transport = stub([{ status: 200 }])
  await fireWebhooks(owner.id, 'reply', { campaign_id: ownerCampaign.id }, { fetchImpl: transport, backoffMs: 0 })
  assert.equal(transport.calls.length, 1)
  assert.equal(transport.calls[0].url, 'https://hooks.example.test/wide')

  // Removing the workspace-level endpoint restores the campaign-level one.
  await client.del(`/api/webhooks/${wide.body.id}`)
  const after = stub([{ status: 200 }])
  await fireWebhooks(owner.id, 'reply', { campaign_id: ownerCampaign.id }, { fetchImpl: after, backoffMs: 0 })
  assert.equal(after.calls.length, 1)
  assert.equal(after.calls[0].url, 'https://hooks.example.test/scoped')

  await client.del(`/api/webhooks/${scoped.body.id}`)
})

test('delivery: the module transport is used when none is injected', async () => {
  const created = await createWebhook({
    name: 'Default transport', webhook_url: 'https://hooks.example.test/default',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id, event_types: ['EMAIL_SENT'],
  })
  const transport = stub([{ status: 200 }])
  setWebhookTransport(transport)
  try {
    await fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id }, { backoffMs: 0 })
    assert.equal(transport.calls.length, 1)
  } finally {
    setWebhookTransport(null)
  }
  await client.del(`/api/webhooks/${created.body.id}`)
})

// ------------------------------------------------------------------- summary

test('summary: counts by outcome and event type, rounded to one decimal', async () => {
  const campaign = seedCampaign(db, owner.id, 'Summary campaign')
  const hook = db.prepare(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories)
     VALUES (?, ?, 'Summary hook', ?, 's', '["sent"]', '[]')`
  ).run(owner.id, campaign.id, 'https://hooks.example.test/summary').lastInsertRowid

  const insert = db.prepare(
    `INSERT INTO webhook_deliveries (workspace_id, webhook_id, event_type, payload, payload_hash, status_code, ok, attempt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  )
  // 3 of 7 successful → 42.9, per the rounding test case.
  for (let i = 0; i < 7; i++) {
    insert.run(owner.id, hook, 'sent', '{}', `h${i}`, i < 3 ? 200 : 500, i < 3 ? 1 : 0, '2024-01-10 12:00:00')
  }
  // Outside the window, and therefore uncounted.
  insert.run(owner.id, hook, 'sent', '{}', 'outside', 200, 1, '2024-03-01 12:00:00')

  const res = await client.get(
    `/api/campaigns/${campaign.id}/notifications/summary?from=2024-01-01T00:00:00.000Z&to=2024-01-31T23:59:59.999Z`
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.total_calls, 7)
  assert.equal(res.body.successful_calls, 3)
  assert.equal(res.body.failed_calls, 4)
  assert.equal(res.body.success_rate, 42.9)
  assert.deepEqual(res.body.by_event_type, [
    { event_type: 'sent', label: 'Email sent', total: 7, successful: 3, failed: 4 },
  ])
})

test('summary: zero attempts return zeros, and a bad or inverted window is a 422', async () => {
  const empty = await client.get(
    `/api/campaigns/${otherCampaign.id}/notifications/summary?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z`
  )
  assert.equal(empty.status, 200)
  assert.equal(empty.body.total_calls, 0)
  assert.equal(empty.body.success_rate, 0)
  assert.deepEqual(empty.body.by_event_type, [])

  const bad = await client.get(`/api/campaigns/${otherCampaign.id}/notifications/summary?fromTime=yesterday&toTime=2024-01-02T00:00:00.000Z`)
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'fromTime')

  const inverted = await client.get(
    `/api/campaigns/${otherCampaign.id}/notifications/summary?from=2024-02-01T00:00:00.000Z&to=2024-01-01T00:00:00.000Z`
  )
  assert.equal(inverted.status, 422)
  assert.equal(inverted.body.field, 'from')

  const missing = await client.get(`/api/campaigns/${otherCampaign.id}/notifications/summary`)
  assert.equal(missing.status, 422)

  assert.equal((await client.get(
    `/api/campaigns/${strangerCampaign.id}/notifications/summary?from=2024-01-01T00:00:00.000Z&to=2024-01-31T00:00:00.000Z`
  )).status, 404)
})

// ----------------------------------------------------------------- retrigger

test('retrigger: replays only failures, leaves successes alone, and is idempotent', async () => {
  const campaign = seedCampaign(db, owner.id, 'Retry campaign')
  const hookId = db.prepare(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories)
     VALUES (?, ?, 'Retry hook', ?, 's', '["sent"]', '[]')`
  ).run(owner.id, campaign.id, 'https://hooks.example.test/retry').lastInsertRowid

  const insert = db.prepare(
    `INSERT INTO webhook_deliveries (workspace_id, webhook_id, event_type, payload, payload_hash, status_code, ok, attempt, created_at)
     VALUES (?, ?, 'sent', ?, ?, ?, ?, 1, '2024-01-10 12:00:00')`
  )
  for (let i = 0; i < 10; i++) {
    const payload = JSON.stringify({ event_id: `ok-${i}`, event_type: 'sent', campaign_id: campaign.id })
    insert.run(owner.id, hookId, payload, `okhash${i}`, 200, 1)
  }
  for (let i = 0; i < 3; i++) {
    const payload = JSON.stringify({ event_id: `bad-${i}`, event_type: 'sent', campaign_id: campaign.id })
    // Two recorded attempts of the same event: one event to replay, not two.
    insert.run(owner.id, hookId, payload, `badhash${i}`, 500, 0)
    insert.run(owner.id, hookId, payload, `badhash${i}`, 500, 0)
  }

  const transport = stub([{ status: 200 }])
  setWebhookTransport(transport)
  try {
    const res = await client.post(`/api/campaigns/${campaign.id}/notifications/retry`, {
      from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T23:59:59.999Z',
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.retriggered_count, 3)
    assert.equal(res.body.delivered_count, 3)
    assert.equal(transport.calls.length, 3)          // the ten successes are untouched
    const bodies = transport.calls.map((c) => JSON.parse(c.body).event_id).sort()
    assert.deepEqual(bodies, ['bad-0', 'bad-1', 'bad-2'])

    // Replaying the same window again delivers nothing: those payloads have
    // since succeeded.
    const again = await client.post(`/api/campaigns/${campaign.id}/notifications/retry`, {
      from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T23:59:59.999Z',
    })
    assert.equal(again.body.retriggered_count, 0)
    assert.equal(again.body.skipped_count, 3)
    assert.equal(again.body.message, 'Nothing to retry in this period')
    assert.equal(transport.calls.length, 3)
  } finally {
    setWebhookTransport(null)
  }
})

test('retrigger: a replay that fails again stays failed, and a deleted hook is skipped', async () => {
  const campaign = seedCampaign(db, owner.id, 'Retry failing campaign')
  const liveHook = db.prepare(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories)
     VALUES (?, ?, 'Still failing', ?, 's', '["sent"]', '[]')`
  ).run(owner.id, campaign.id, 'https://hooks.example.test/still-failing').lastInsertRowid
  const goneHook = db.prepare(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories, is_active)
     VALUES (?, ?, 'Deleted', ?, 's', '["sent"]', '[]', -1)`
  ).run(owner.id, campaign.id, 'https://hooks.example.test/gone').lastInsertRowid

  const insert = db.prepare(
    `INSERT INTO webhook_deliveries (workspace_id, webhook_id, event_type, payload, payload_hash, status_code, ok, attempt, created_at)
     VALUES (?, ?, 'sent', ?, ?, 500, 0, 1, '2024-01-10 12:00:00')`
  )
  insert.run(owner.id, liveHook, JSON.stringify({ event_id: 'live-1', campaign_id: campaign.id }), 'live1')
  insert.run(owner.id, goneHook, JSON.stringify({ event_id: 'gone-1', campaign_id: campaign.id }), 'gone1')

  const transport = stub([{ status: 503, text: 'still down' }])
  setWebhookTransport(transport)
  try {
    const res = await client.post(`/api/campaigns/${campaign.id}/notifications/retry`, {
      from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T23:59:59.999Z',
    })
    assert.equal(res.body.retriggered_count, 1)
    assert.equal(res.body.delivered_count, 0)
    assert.equal(res.body.failed_count, 1)
    assert.equal(res.body.skipped_count, 1)          // the deleted hook, reported separately
    assert.equal(transport.calls.length, 1)          // one attempt per replay, not three
  } finally {
    setWebhookTransport(null)
  }

  const stillFailed = db.prepare(
    'SELECT COUNT(*) n FROM webhook_deliveries WHERE webhook_id = ? AND ok = 1'
  ).get(liveHook).n
  assert.equal(stillFailed, 0)
})

test('retrigger: validates the window and 404s across workspaces', async () => {
  const inverted = await client.post(`/api/campaigns/${otherCampaign.id}/notifications/retry`, {
    fromTime: '2024-02-01T00:00:00.000Z', toTime: '2024-01-01T00:00:00.000Z',
  })
  assert.equal(inverted.status, 422)
  assert.equal(inverted.body.field, 'fromTime')

  const junk = await client.post(`/api/campaigns/${otherCampaign.id}/notifications/retry`, {
    from: 'yesterday', to: '2024-01-01T00:00:00.000Z',
  })
  assert.equal(junk.status, 422)
  assert.equal(junk.body.field, 'from')

  const cross = await client.post(`/api/campaigns/${strangerCampaign.id}/notifications/retry`, {
    from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T00:00:00.000Z',
  })
  assert.equal(cross.status, 404)
})

test('retrigger: a second concurrent run for the same campaign is refused', async () => {
  const campaign = seedCampaign(db, owner.id, 'Lock campaign')
  const hookId = db.prepare(
    `INSERT INTO webhooks (workspace_id, campaign_id, name, url, secret, event_types, categories)
     VALUES (?, ?, 'Slow hook', ?, 's', '["sent"]', '[]')`
  ).run(owner.id, campaign.id, 'https://hooks.example.test/slow').lastInsertRowid
  db.prepare(
    `INSERT INTO webhook_deliveries (workspace_id, webhook_id, event_type, payload, payload_hash, status_code, ok, attempt, created_at)
     VALUES (?, ?, 'sent', ?, 'lock1', 500, 0, 1, '2024-01-10 12:00:00')`
  ).run(owner.id, hookId, JSON.stringify({ event_id: 'lock-1', campaign_id: campaign.id }))

  // A transport that holds the first request open long enough for the second
  // retrigger to arrive while the lock is held.
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const calls = []
  setWebhookTransport(async (url, init) => {
    calls.push(url)
    await gate
    return { status: 200, ok: true, text: async () => '' }
  })
  try {
    const window = { from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T23:59:59.999Z' }
    const first = client.post(`/api/campaigns/${campaign.id}/notifications/retry`, window)
    await new Promise((r) => setTimeout(r, 50))
    const second = await client.post(`/api/campaigns/${campaign.id}/notifications/retry`, window)
    assert.equal(second.status, 409)
    assert.equal(second.body.error, 'retry_in_progress')
    release()
    const firstRes = await first
    assert.equal(firstRes.body.retriggered_count, 1)
    assert.equal(calls.length, 1)                    // the event was delivered once
  } finally {
    setWebhookTransport(null)
  }
})

// --------------------------------------------------------------------- lists

test('list: pages, and never exposes a secret', async () => {
  const ids = []
  for (let i = 0; i < 3; i++) {
    const res = await createWebhook({
      name: `Paged ${i}`, webhook_url: `https://hooks.example.test/paged-${i}`, event_types: ['EMAIL_SENT'],
    })
    ids.push(res.body.id)
  }
  const first = await client.get('/api/webhooks?limit=2')
  assert.equal(first.status, 200)
  assert.equal(first.body.data.length, 2)
  assert.equal(first.body.hasMore, true)
  assert.ok(first.body.nextCursor > 0)
  assert.ok(!JSON.stringify(first.body).includes('"secret"'))

  const next = await client.get(`/api/webhooks?limit=50&cursor=${first.body.nextCursor}`)
  assert.ok(next.body.data.every((w) => w.id > first.body.nextCursor))

  for (const id of ids) await client.del(`/api/webhooks/${id}`)
})

// ------------------------------------------------------------------ SSRF (audit)

// Fix 1: an IPv4-mapped IPv6 literal that `new URL()` normalises to hex
// (`[::ffff:a9fe:a9fe]`) used to bypass the dotted-quad regex and be allowed.
test('create: IPv4-mapped and raw internal IPv6 literals are all refused', async () => {
  const bad = [
    'https://[::ffff:169.254.169.254]/latest/meta-data',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:10.0.0.5]/x',
    'https://[::1]/x',
    'https://[fe80::1]/x',
    'https://[fc00::1]/x',
  ]
  for (const url of bad) {
    const res = await createWebhook({ name: 'V6SSRF', webhook_url: url, event_types: ['EMAIL_REPLY'] })
    assert.equal(res.status, 422, `expected 422 for ${url}`)
    assert.equal(res.body.field, 'webhook_url', `expected webhook_url named for ${url}`)
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM webhooks WHERE name = ?').get('V6SSRF').n, 0)

  // A genuinely public IPv6 literal is still allowed.
  const ok = await createWebhook({ name: 'V6OK', webhook_url: 'https://[2606:4700::1111]/hook', event_types: ['EMAIL_REPLY'] })
  assert.equal(ok.status, 200)
  await client.del(`/api/webhooks/${ok.body.id}`)
})

// Fix 2: a 3xx is a delivery outcome, never followed into the internal network,
// and its body is never echoed into the recorded error.
test('delivery: a 3xx is recorded once, not followed, with redirect:manual', async () => {
  const created = await createWebhook({
    name: 'Redirector', webhook_url: 'https://hooks.example.test/redir',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id, event_types: ['EMAIL_SENT'],
  })
  const id = created.body.id
  const transport = stub([{ status: 302, text: 'Location: http://169.254.169.254/' }])
  const [result] = await fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id }, { fetchImpl: transport, backoffMs: 0 })
  assert.equal(result.ok, false)
  assert.equal(transport.calls.length, 1)                   // not followed, not retried
  assert.equal(transport.calls[0].init.redirect, 'manual')
  const rows = deliveriesFor(id)
  assert.equal(rows.length, 1)
  assert.match(rows[0].error, /redirect not followed/)
  assert.ok(!rows[0].error.includes('169.254'), 'the redirect target is never leaked into the error')
  await client.del(`/api/webhooks/${id}`)
})

// Fix 3: the hostname is resolved before every attempt and refused if it answers
// with an internal address — DNS rebinding cannot turn a saved endpoint inward.
test('delivery: a hostname resolving to an internal address is refused, a public one delivers', async () => {
  const created = await createWebhook({
    name: 'Rebind', webhook_url: 'https://hooks.example.test/rebind',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id, event_types: ['EMAIL_SENT'],
  })
  const id = created.body.id

  for (const internal of ['169.254.169.254', '127.0.0.1', '10.0.0.5', '::1', 'fd00::1']) {
    const transport = stub([{ status: 200 }])
    const [result] = await fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id },
      { fetchImpl: transport, resolveImpl: async () => [internal], backoffMs: 0 })
    assert.equal(result.ok, false, `expected refusal when resolving to ${internal}`)
    assert.equal(transport.calls.length, 0, `must not connect when resolving to ${internal}`)
    assert.match(result.error, /host/)
  }

  // A public resolution delivers as normal.
  const okTransport = stub([{ status: 200 }])
  const [ok] = await fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id },
    { fetchImpl: okTransport, resolveImpl: async () => ['93.184.216.34'], backoffMs: 0 })
  assert.equal(ok.ok, true)
  assert.equal(okTransport.calls.length, 1)
  await client.del(`/api/webhooks/${id}`)
})

// Fix 4: auto-pause counts failing EVENTS, not per-attempt rows. Each failing
// event writes MAX_ATTEMPTS (3) rows; the old per-row count paused after ~2
// events. Four failing events must stay live; the fifth pauses.
test('auto-pause: counts failing events (5), not attempts', async () => {
  const created = await createWebhook({
    name: 'FailStreak', webhook_url: 'https://hooks.example.test/failstreak',
    association_type: 'campaign', email_campaign_id: ownerCampaign.id, event_types: ['EMAIL_SENT'],
  })
  const id = created.body.id
  const isActive = () => db.prepare('SELECT is_active FROM webhooks WHERE id = ?').get(id).is_active
  const fireOne = () => fireWebhooks(owner.id, 'sent', { campaign_id: ownerCampaign.id },
    { fetchImpl: stub([{ status: 500, text: 'boom' }]), backoffMs: 0 })

  for (let i = 0; i < 4; i++) await fireOne()
  assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_deliveries WHERE webhook_id = ?').get(id).n, 12)
  assert.equal(isActive(), 1, 'four failing events (12 attempt rows) is below the 5-event threshold')

  await fireOne()
  assert.equal(isActive(), 0, 'the fifth consecutive failing event pauses the endpoint')
})

// Fix 5: a plain member cannot create, edit or delete a webhook — a reply
// subscription would exfiltrate inbound email to an external URL.
test('CRUD role gate: a member is refused, a manager and owner are allowed', async () => {
  const member = await mountAs('member')
  const manager = await mountAs('manager')
  try {
    const denied = await member.post('/api/webhooks', {
      name: 'Sneaky', webhook_url: 'https://hooks.example.test/exfil', event_types: ['EMAIL_REPLY'],
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error, 'forbidden')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM webhooks WHERE name = ?').get('Sneaky').n, 0)

    // A manager may create; the member still cannot edit or delete it.
    const made = await manager.post('/api/webhooks', {
      name: 'Manager made', webhook_url: 'https://hooks.example.test/mgr', event_types: ['EMAIL_REPLY'],
    })
    assert.equal(made.status, 200)
    assert.equal((await member.patch(`/api/webhooks/${made.body.id}`, { name: 'x' })).status, 403)
    assert.equal((await member.del(`/api/webhooks/${made.body.id}`)).status, 403)
    // The campaign-scoped mutations are gated too.
    assert.equal((await member.post(`/api/campaigns/${ownerCampaign.id}/webhooks`, {
      name: 'x', webhook_url: 'https://hooks.example.test/m2', event_types: ['EMAIL_SENT'],
    })).status, 403)

    await client.del(`/api/webhooks/${made.body.id}`)
  } finally {
    await member.close()
    await manager.close()
  }
})
