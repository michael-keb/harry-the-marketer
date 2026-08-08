// Lead notes and lead tasks — Docs/lead-notes/* and Docs/lead-tasks/*.
//
// Covers, per endpoint: the happy path, the 422 that names its field, the
// cross-workspace 404 that leaks nothing, paging, and the author rules that
// make a soft-deleted note stay attributable.

import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, seedUser, seedLead, seedCampaign, mount } from './helpers/parity-harness.js'

setup('notes')
const { db } = await import('../server/db.js')
const { register } = await import('../server/parity/notes.js')

const owner = seedUser(db, 'owner@example.com')
const stranger = seedUser(db, 'stranger@example.com')
const client = await mount(register, owner)
test.after(() => client.close())

// Fixtures shared by the whole file: one lead in this workspace, one campaign
// it is enrolled in, one campaign it is not, and a lead belonging to somebody
// else entirely.
const lead = seedLead(db, owner.id, 'ada@acme.test')
const otherLead = seedLead(db, owner.id, 'grace@acme.test')
const foreignLead = seedLead(db, stranger.id, 'mallory@elsewhere.test')

const campaign = seedCampaign(db, owner.id, 'Q3 outbound')
const unrelated = seedCampaign(db, owner.id, 'Q4 outbound')
const foreignCampaign = seedCampaign(db, stranger.id, 'Not yours')
db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, lead.id)
db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, otherLead.id)

// A colleague in the same workspace, plus somebody who has since left it.
db.prepare("INSERT INTO team_members (owner_id, email, role, status) VALUES (?, 'colleague@example.com', 'member', 'active')")
  .run(owner.id)

const events = (type) => db.prepare('SELECT * FROM events WHERE user_id = ? AND type = ? ORDER BY id')
  .all(owner.id, type)

// ---------------------------------------------------------------- notes -----

test('POST /leads/:leadId/notes stores the note with its author and campaign', async () => {
  const res = await client.post(`/api/leads/${lead.id}/notes`, {
    campaignId: campaign.id,
    body: 'Called Ada — she wants pricing for 50 seats before any call.',
  })
  assert.equal(res.status, 200)
  const note = res.body.note
  assert.ok(note.id)
  assert.equal(note.leadId, lead.id)
  assert.equal(note.campaignId, campaign.id)
  assert.equal(note.campaign.name, 'Q3 outbound')
  assert.equal(note.body, 'Called Ada — she wants pricing for 50 seats before any call.')
  // The author is the session, never anything the client sent.
  assert.equal(note.author.email, 'owner@example.com')
  assert.equal(note.author.formerMember, false)
  assert.ok(note.createdAt)
  assert.equal(note.edited, false)
  assert.equal(note.mine, true)
})

test('the author is the session even when the client supplies one', async () => {
  const res = await client.post(`/api/leads/${lead.id}/notes`, {
    body: 'Author spoofing attempt',
    authorEmail: 'someone.else@example.com',
    author: 'someone.else@example.com',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.note.author.email, 'owner@example.com')
})

test('a note body is stored verbatim and never interpreted', async () => {
  const payload = '<script>alert(1)</script> use <30 seats'
  const res = await client.post(`/api/leads/${lead.id}/notes`, { body: payload })
  assert.equal(res.status, 200)
  // Escaping is the renderer's job; the store must not mangle what was typed.
  assert.equal(res.body.note.body, payload)
})

test('the activity trail records that a note was added and never its text', async () => {
  const before = events('note_added').length
  await client.post(`/api/leads/${lead.id}/notes`, { body: 'Secret commercial detail: 40% discount' })
  const rows = events('note_added')
  assert.equal(rows.length, before + 1)
  const row = rows[rows.length - 1]
  assert.equal(row.lead_id, lead.id)
  assert.match(row.detail, /owner@example\.com/)
  assert.ok(!row.detail.includes('40%'), 'the note body must not reach the events table')
})

test('an empty or whitespace-only note is a 422 naming the body', async () => {
  for (const body of ['', '   ', undefined]) {
    const res = await client.post(`/api/leads/${lead.id}/notes`, { body })
    assert.equal(res.status, 422)
    assert.equal(res.body.field, 'body')
    assert.match(res.body.message, /required/)
  }
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM lead_notes WHERE body = ?').get('').c,
    0,
    'nothing is written on a rejected save'
  )
})

test('a note over the stated limit is a 422 naming the limit', async () => {
  const res = await client.post(`/api/leads/${lead.id}/notes`, { body: 'x'.repeat(4001) })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'body')
  assert.match(res.body.message, /4000/)
})

test('a non-numeric lead id is a 422 naming the parameter', async () => {
  const res = await client.get('/api/leads/not-a-number/notes')
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'leadId')
})

test('a lead in another workspace 404s and leaks nothing', async () => {
  // Seed a note in the stranger's workspace so there is something to leak.
  db.prepare('INSERT INTO lead_notes (workspace_id, lead_id, author_email, body) VALUES (?, ?, ?, ?)')
    .run(stranger.id, foreignLead.id, 'stranger@example.com', 'Confidential competitor intel')

  const read = await client.get(`/api/leads/${foreignLead.id}/notes`)
  assert.equal(read.status, 404)
  assert.equal(read.body.error, 'not_found')
  assert.ok(!JSON.stringify(read.body).includes('Confidential'))

  const write = await client.post(`/api/leads/${foreignLead.id}/notes`, { body: 'hello' })
  assert.equal(write.status, 404)
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM lead_notes WHERE body = ?').get('hello').c,
    0,
    'no note is created in either workspace'
  )
})

test('a campaign in another workspace 404s', async () => {
  const res = await client.post(`/api/leads/${lead.id}/notes`, {
    campaignId: foreignCampaign.id,
    body: 'nope',
  })
  assert.equal(res.status, 404)
})

test('a lead that is not in the named campaign is a 400, not an orphaned note', async () => {
  const res = await client.post(`/api/leads/${lead.id}/notes`, {
    campaignId: unrelated.id,
    body: 'wrong campaign',
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'lead_not_in_campaign')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lead_notes WHERE body = ?').get('wrong campaign').c, 0)
})

test('an idempotency key makes a retried save return the first note, not a second', async () => {
  const payload = { body: 'Retry me', idempotencyKey: 'key-abc' }
  const first = await client.post(`/api/leads/${otherLead.id}/notes`, payload)
  const second = await client.post(`/api/leads/${otherLead.id}/notes`, payload)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.body.note.id, first.body.note.id)
  assert.equal(second.body.deduped, true)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lead_notes WHERE body = ?').get('Retry me').c, 1)
  // And only one trail entry, because only one note happened.
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM events WHERE user_id = ? AND type = 'note_added' AND lead_id = ?")
      .get(owner.id, otherLead.id).c,
    1
  )
})

test('GET /leads/:leadId/notes returns newest first, tie-broken by id, and pages', async () => {
  const paging = seedLead(db, owner.id, 'paging@acme.test')
  // Identical timestamps on purpose: ordering must still be deterministic.
  const insert = db.prepare(
    "INSERT INTO lead_notes (workspace_id, lead_id, author_email, body, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-01-01 09:00:00', '2026-01-01 09:00:00')"
  )
  for (let i = 1; i <= 25; i++) insert.run(owner.id, paging.id, 'owner@example.com', `note ${i}`)

  const first = await client.get(`/api/leads/${paging.id}/notes?limit=10`)
  assert.equal(first.status, 200)
  assert.equal(first.body.items.length, 10)
  assert.equal(first.body.hasMore, true)
  assert.equal(first.body.maxLength, 4000)
  assert.equal(first.body.items[0].body, 'note 25')
  assert.equal(first.body.items[9].body, 'note 16')
  // Descending ids, stable under identical created_at.
  const ids = first.body.items.map((n) => n.id)
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a))

  const second = await client.get(`/api/leads/${paging.id}/notes?limit=10&cursor=${first.body.nextCursor}`)
  assert.equal(second.body.items[0].body, 'note 15')
  assert.equal(second.body.items.length, 10)

  const last = await client.get(`/api/leads/${paging.id}/notes?limit=10&before=${second.body.nextCursor}`)
  assert.equal(last.body.items.length, 5)
  assert.equal(last.body.hasMore, false)
  assert.equal(last.body.nextCursor, null)
})

test('a lead with no notes returns an empty list, not an error', async () => {
  const empty = seedLead(db, owner.id, 'empty@acme.test')
  const res = await client.get(`/api/leads/${empty.id}/notes`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items, [])
  assert.equal(res.body.hasMore, false)
})

test('notes can be filtered to one campaign and campaign-less notes read as general', async () => {
  const mixed = seedLead(db, owner.id, 'mixed@acme.test')
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, mixed.id)
  await client.post(`/api/leads/${mixed.id}/notes`, { campaignId: campaign.id, body: 'in campaign' })
  await client.post(`/api/leads/${mixed.id}/notes`, { body: 'general' })

  const all = await client.get(`/api/leads/${mixed.id}/notes`)
  assert.equal(all.body.items.length, 2)
  assert.equal(all.body.items[0].campaign, null, 'a campaign-less note is general, not mislabelled')

  const filtered = await client.get(`/api/leads/${mixed.id}/notes?campaignId=${campaign.id}`)
  assert.equal(filtered.body.items.length, 1)
  assert.equal(filtered.body.items[0].campaign.name, 'Q3 outbound')
})

test('a departed author keeps their attribution', async () => {
  const departed = seedLead(db, owner.id, 'departed@acme.test')
  db.prepare('INSERT INTO lead_notes (workspace_id, lead_id, author_email, body) VALUES (?, ?, ?, ?)')
    .run(owner.id, departed.id, 'gone@example.com', 'What I found out before I left')

  const res = await client.get(`/api/leads/${departed.id}/notes`)
  assert.equal(res.body.items.length, 1)
  const author = res.body.items[0].author
  assert.equal(author.email, 'gone@example.com')
  assert.equal(author.formerMember, true, 'flagged as a former member, not erased')
  assert.equal(res.body.items[0].body, 'What I found out before I left')
})

test('only the author may edit a note', async () => {
  const shared = seedLead(db, owner.id, 'shared@acme.test')
  const mine = await client.post(`/api/leads/${shared.id}/notes`, { body: 'mine' })
  const noteId = mine.body.note.id
  db.prepare('INSERT INTO lead_notes (workspace_id, lead_id, author_email, body) VALUES (?, ?, ?, ?)')
    .run(owner.id, shared.id, 'colleague@example.com', 'theirs')
  const theirs = db.prepare("SELECT id FROM lead_notes WHERE body = 'theirs'").get().id

  const edit = await client.patch(`/api/notes/${noteId}`, { body: 'mine, corrected' })
  assert.equal(edit.status, 200)
  assert.equal(edit.body.note.body, 'mine, corrected')
  assert.equal(edit.body.note.edited, true)

  const forbidden = await client.patch(`/api/notes/${theirs}`, { body: 'rewritten by someone else' })
  assert.equal(forbidden.status, 403)
  assert.equal(db.prepare('SELECT body FROM lead_notes WHERE id = ?').get(theirs).body, 'theirs')

  const empty = await client.patch(`/api/notes/${noteId}`, { body: '  ' })
  assert.equal(empty.status, 422)
  assert.equal(empty.body.field, 'body')
})

test('deleting a note is soft, author-only, and hides it from the panel', async () => {
  const target = seedLead(db, owner.id, 'delete@acme.test')
  const created = await client.post(`/api/leads/${target.id}/notes`, { body: 'to be removed' })
  const noteId = created.body.note.id
  db.prepare('INSERT INTO lead_notes (workspace_id, lead_id, author_email, body) VALUES (?, ?, ?, ?)')
    .run(owner.id, target.id, 'colleague@example.com', 'not yours to remove')
  const theirs = db.prepare("SELECT id FROM lead_notes WHERE body = 'not yours to remove'").get().id

  const refused = await client.del(`/api/notes/${theirs}`)
  assert.equal(refused.status, 403)

  const res = await client.del(`/api/notes/${noteId}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.deleted, true)

  const row = db.prepare('SELECT * FROM lead_notes WHERE id = ?').get(noteId)
  assert.ok(row, 'the row survives a delete')
  assert.ok(row.deleted_at, 'deleted_at is stamped')

  const list = await client.get(`/api/leads/${target.id}/notes`)
  assert.deepEqual(list.body.items.map((n) => n.body), ['not yours to remove'])

  // A deleted note is gone as far as the API is concerned.
  assert.equal((await client.patch(`/api/notes/${noteId}`, { body: 'back' })).status, 404)
  assert.equal((await client.del(`/api/notes/${noteId}`)).status, 404)
})

test('a note in another workspace cannot be edited or deleted', async () => {
  const foreign = db.prepare('SELECT id FROM lead_notes WHERE workspace_id = ?').get(stranger.id).id
  assert.equal((await client.patch(`/api/notes/${foreign}`, { body: 'x' })).status, 404)
  assert.equal((await client.del(`/api/notes/${foreign}`)).status, 404)
  assert.equal(
    db.prepare('SELECT body FROM lead_notes WHERE id = ?').get(foreign).body,
    'Confidential competitor intel'
  )
})

// ---------------------------------------------------------------- tasks -----

test('POST /leads/:leadId/tasks stores name, due date, assignee and status', async () => {
  const res = await client.post(`/api/leads/${lead.id}/tasks`, {
    campaignId: campaign.id,
    name: 'Send 50-seat pricing',
    description: 'Ada asked for it before any call.',
    priority: 'high',
    dueDate: '2030-01-15T09:00:00Z',
    assignedEmail: 'colleague@example.com',
  })
  assert.equal(res.status, 200)
  const task = res.body.task
  assert.ok(task.id)
  assert.equal(task.leadId, lead.id)
  assert.equal(task.campaign.name, 'Q3 outbound')
  assert.equal(task.title, 'Send 50-seat pricing')
  assert.equal(task.body, 'Ada asked for it before any call.')
  assert.equal(task.dueAt, '2030-01-15T09:00:00.000Z')
  assert.equal(task.status, 'open')
  assert.equal(task.overdue, false)
  assert.equal(task.assignedEmail, 'colleague@example.com')
  assert.equal(task.assignee.formerMember, false)
  assert.equal(task.createdBy, 'owner@example.com')
  assert.equal(task.unowned, false)
  assert.equal(task.completedAt, null)
})

test('the activity trail names the actor and the task', async () => {
  const rows = events('task_created')
  assert.ok(rows.length >= 1)
  const row = rows[rows.length - 1]
  assert.equal(row.lead_id, lead.id)
  assert.match(row.detail, /owner@example\.com/)
  assert.match(row.detail, /Send 50-seat pricing/)
})

test('a task with no title is a 422 naming the field', async () => {
  const res = await client.post(`/api/leads/${lead.id}/tasks`, { description: 'only a description' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'title')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lead_tasks WHERE body = ?').get('only a description').c, 0)
})

test('an out-of-range priority is a 422 naming the allowed values', async () => {
  const res = await client.post(`/api/leads/${lead.id}/tasks`, { title: 'Call back', priority: 'urgent' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'priority')
  assert.match(res.body.message, /low, medium, high/)
})

test('a malformed due date is a 422 naming the date', async () => {
  const res = await client.post(`/api/leads/${lead.id}/tasks`, { title: 'Call back', dueDate: 'next tuesday' })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'dueAt')
})

test('a due date round-trips from any timezone as UTC', async () => {
  const res = await client.post(`/api/leads/${otherLead.id}/tasks`, {
    title: 'Timezone check',
    dueAt: '2030-03-01T09:00:00+02:00',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.task.dueAt, '2030-03-01T07:00:00.000Z')
  assert.equal(new Date(res.body.task.dueAt).getTime(), new Date('2030-03-01T09:00:00+02:00').getTime())
})

test('a past due date is accepted and immediately reads as overdue', async () => {
  const res = await client.post(`/api/leads/${otherLead.id}/tasks`, {
    title: 'Chase legal',
    dueAt: '2020-01-01T09:00:00Z',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.task.overdue, true)
})

test('an assignee from outside the workspace is a 422', async () => {
  const res = await client.post(`/api/leads/${lead.id}/tasks`, {
    title: 'Assign to nobody',
    assignedEmail: 'stranger@example.com',
  })
  assert.equal(res.status, 422)
  assert.equal(res.body.field, 'assignedEmail')
})

test('a task on a lead or campaign in another workspace 404s, and a wrong pairing 400s', async () => {
  const foreign = await client.post(`/api/leads/${foreignLead.id}/tasks`, { title: 'not yours' })
  assert.equal(foreign.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lead_tasks WHERE title = ?').get('not yours').c, 0)

  const foreignCampaignTask = await client.post(`/api/leads/${lead.id}/tasks`, {
    title: 'not yours either',
    campaignId: foreignCampaign.id,
  })
  assert.equal(foreignCampaignTask.status, 404)

  const wrongPairing = await client.post(`/api/leads/${lead.id}/tasks`, {
    title: 'wrong campaign',
    campaignId: unrelated.id,
  })
  assert.equal(wrongPairing.status, 400)
  assert.equal(wrongPairing.body.error, 'lead_not_in_campaign')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lead_tasks WHERE title = ?').get('wrong campaign').c, 0)
})

test('a retried task create with the same key does not double-post', async () => {
  const payload = { title: 'Only once', idempotencyKey: 'task-key-1' }
  const first = await client.post(`/api/leads/${otherLead.id}/tasks`, payload)
  const second = await client.post(`/api/leads/${otherLead.id}/tasks`, payload)
  assert.equal(second.body.task.id, first.body.task.id)
  assert.equal(second.body.deduped, true)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lead_tasks WHERE title = ?').get('Only once').c, 1)
})

test('GET /leads/:leadId/tasks orders overdue, then due, then undated, with completed last', async () => {
  const ordered = seedLead(db, owner.id, 'ordered@acme.test')
  const make = (title, dueAt, status) => db.prepare(
    `INSERT INTO lead_tasks (workspace_id, lead_id, title, due_at, status, created_by, completed_at)
     VALUES (?, ?, ?, ?, ?, 'owner@example.com', ?)`
  ).run(owner.id, ordered.id, title, dueAt, status, status === 'done' ? '2026-01-02T00:00:00.000Z' : '')

  make('overdue', '2020-05-05T00:00:00.000Z', 'open')
  make('next week', '2035-01-01T00:00:00.000Z', 'open')
  make('undated', '', 'open')
  make('completed', '2019-01-01T00:00:00.000Z', 'done')

  const res = await client.get(`/api/leads/${ordered.id}/tasks?status=all`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items.map((t) => t.title), ['overdue', 'next week', 'undated', 'completed'])

  const undated = res.body.items.find((t) => t.title === 'undated')
  assert.equal(undated.overdue, false, 'an undated task is never overdue')
  assert.equal(undated.dueAt, null)

  const completed = res.body.items.find((t) => t.title === 'completed')
  assert.equal(completed.overdue, false, 'a closed task is not overdue')
  assert.ok(completed.completedAt, 'completed tasks are kept with their completion time')

  // The default view is the open work only.
  const open = await client.get(`/api/leads/${ordered.id}/tasks`)
  assert.deepEqual(open.body.items.map((t) => t.title), ['overdue', 'next week', 'undated'])
  assert.equal(open.body.leadId, ordered.id)
})

test('GET /tasks filters by status, overdue and assignee, and pages', async () => {
  const busy = seedLead(db, owner.id, 'busy@acme.test')
  const insert = db.prepare(
    `INSERT INTO lead_tasks (workspace_id, lead_id, title, due_at, status, assigned_email, created_by)
     VALUES (?, ?, ?, ?, 'open', ?, 'owner@example.com')`
  )
  for (let i = 1; i <= 12; i++) {
    insert.run(owner.id, busy.id, `bulk ${i}`, `2031-0${(i % 9) + 1}-01T00:00:00.000Z`, i === 1 ? 'colleague@example.com' : '')
  }

  const all = await client.get('/api/tasks?limit=5')
  assert.equal(all.status, 200)
  assert.equal(all.body.items.length, 5)
  assert.equal(all.body.hasMore, true)
  assert.equal(all.body.nextOffset, 5)
  assert.ok(all.body.counts.open >= 12)
  assert.ok(all.body.counts.overdue >= 1)

  const second = await client.get(`/api/tasks?limit=5&offset=${all.body.nextOffset}`)
  assert.equal(second.body.items.length, 5)
  const overlap = all.body.items.map((t) => t.id).filter((id) => second.body.items.some((t) => t.id === id))
  assert.deepEqual(overlap, [], 'pages do not overlap')

  const overdue = await client.get('/api/tasks?due=overdue&limit=200')
  assert.ok(overdue.body.items.length >= 1)
  assert.ok(overdue.body.items.every((t) => t.overdue === true))
  assert.ok(
    overdue.body.items.every((t) => t.dueAt !== null),
    'undated tasks never appear in the overdue filter'
  )

  const assigned = await client.get('/api/tasks?assignedTo=colleague@example.com&limit=200')
  assert.ok(assigned.body.items.length >= 1)
  assert.ok(assigned.body.items.every((t) => t.assignedEmail === 'colleague@example.com'))

  const mine = await client.get('/api/tasks?assignedTo=me&limit=200')
  assert.ok(mine.body.items.every((t) => t.assignedEmail === 'owner@example.com'))

  const bad = await client.get('/api/tasks?status=urgent')
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'status')
})

test('GET /tasks never returns another workspace"s tasks', async () => {
  db.prepare(
    `INSERT INTO lead_tasks (workspace_id, lead_id, title, status, created_by)
     VALUES (?, ?, 'Foreign task', 'open', 'stranger@example.com')`
  ).run(stranger.id, foreignLead.id)

  const res = await client.get('/api/tasks?status=all&limit=200')
  assert.ok(!res.body.items.some((t) => t.title === 'Foreign task'))
  assert.ok(!JSON.stringify(res.body).includes('Foreign task'))

  const direct = await client.get(`/api/leads/${foreignLead.id}/tasks`)
  assert.equal(direct.status, 404)

  const nonNumeric = await client.get('/api/leads/abc/tasks')
  assert.equal(nonNumeric.status, 422)
  assert.equal(nonNumeric.body.field, 'leadId')
})

test('PATCH /tasks/:id completes, reopens and reassigns without deleting anything', async () => {
  const created = await client.post(`/api/leads/${lead.id}/tasks`, {
    title: 'Phone them back',
    dueAt: '2030-06-01T09:00:00Z',
  })
  const id = created.body.task.id

  const done = await client.patch(`/api/tasks/${id}`, { status: 'done' })
  assert.equal(done.status, 200)
  assert.equal(done.body.task.status, 'done')
  assert.ok(done.body.task.completedAt, 'completion is timestamped')
  assert.ok(db.prepare('SELECT id FROM lead_tasks WHERE id = ?').get(id), 'the row is kept, not deleted')

  const reopened = await client.patch(`/api/tasks/${id}`, { status: 'open' })
  assert.equal(reopened.body.task.status, 'open')
  assert.equal(reopened.body.task.completedAt, null)

  const reassigned = await client.patch(`/api/tasks/${id}`, {
    assignedEmail: 'colleague@example.com',
    title: 'Phone them back today',
  })
  assert.equal(reassigned.body.task.assignedEmail, 'colleague@example.com')
  assert.equal(reassigned.body.task.title, 'Phone them back today')

  const unassigned = await client.patch(`/api/tasks/${id}`, { assignedEmail: '' })
  assert.equal(unassigned.body.task.assignedEmail, '')

  const cleared = await client.patch(`/api/tasks/${id}`, { dueAt: '' })
  assert.equal(cleared.body.task.dueAt, null)
  assert.equal(cleared.body.task.overdue, false)
})

test('PATCH /tasks/:id validates its fields and refuses an empty patch', async () => {
  const created = await client.post(`/api/leads/${lead.id}/tasks`, { title: 'Validate me' })
  const id = created.body.task.id

  const badStatus = await client.patch(`/api/tasks/${id}`, { status: 'finished' })
  assert.equal(badStatus.status, 422)
  assert.equal(badStatus.body.field, 'status')

  const badDate = await client.patch(`/api/tasks/${id}`, { dueAt: 'soon' })
  assert.equal(badDate.status, 422)
  assert.equal(badDate.body.field, 'dueAt')

  const badAssignee = await client.patch(`/api/tasks/${id}`, { assignedEmail: 'stranger@example.com' })
  assert.equal(badAssignee.status, 422)
  assert.equal(badAssignee.body.field, 'assignedEmail')

  const nothing = await client.patch(`/api/tasks/${id}`, {})
  assert.equal(nothing.status, 422)
  assert.equal(nothing.body.field, 'update')

  // None of the rejected patches changed anything.
  const row = db.prepare('SELECT * FROM lead_tasks WHERE id = ?').get(id)
  assert.equal(row.title, 'Validate me')
  assert.equal(row.status, 'open')
  assert.equal(row.assigned_email, '')
})

test('a task in another workspace cannot be patched', async () => {
  const foreign = db.prepare("SELECT id FROM lead_tasks WHERE workspace_id = ? AND title = 'Foreign task'")
    .get(stranger.id).id
  const res = await client.patch(`/api/tasks/${foreign}`, { status: 'done' })
  assert.equal(res.status, 404)
  assert.equal(db.prepare('SELECT status FROM lead_tasks WHERE id = ?').get(foreign).status, 'open')
})

test('a task whose people have left the workspace is readable and flagged unowned', async () => {
  const orphan = seedLead(db, owner.id, 'orphan@acme.test')
  db.prepare(
    `INSERT INTO lead_tasks (workspace_id, lead_id, title, status, created_by, assigned_email)
     VALUES (?, ?, 'Left behind', 'open', 'gone@example.com', '')`
  ).run(owner.id, orphan.id)

  const res = await client.get(`/api/leads/${orphan.id}/tasks`)
  assert.equal(res.body.items.length, 1)
  const task = res.body.items[0]
  assert.equal(task.creator.email, 'gone@example.com', 'the name still shows')
  assert.equal(task.creator.formerMember, true)
  assert.equal(task.unowned, true, 'so it can be picked up rather than lost')
})

test('a lead with no tasks returns an empty list with its counts', async () => {
  const quiet = seedLead(db, owner.id, 'quiet@acme.test')
  const res = await client.get(`/api/leads/${quiet.id}/tasks`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.items, [])
  assert.equal(res.body.hasMore, false)
  assert.equal(res.body.nextOffset, null)
  assert.ok(typeof res.body.counts.open === 'number')
})

test('creating a note or a task touches nothing the engine reads', async () => {
  const quiet = seedLead(db, owner.id, 'inert@acme.test')
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.id, quiet.id)
  const before = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .get(campaign.id, quiet.id)
  const draftsBefore = db.prepare('SELECT COUNT(*) c FROM drafts WHERE user_id = ?').get(owner.id).c

  await client.post(`/api/leads/${quiet.id}/notes`, { campaignId: campaign.id, body: 'Do not steer the agent' })
  await client.post(`/api/leads/${quiet.id}/tasks`, { campaignId: campaign.id, title: 'Do not block the send' })

  const after = db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .get(campaign.id, quiet.id)
  assert.deepEqual(after, before, 'scheduling state is untouched')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM drafts WHERE user_id = ?').get(owner.id).c, draftsBefore)
  // A note is context for people, never an instruction to the composer.
  assert.equal(
    db.prepare('SELECT notes FROM leads WHERE id = ?').get(quiet.id).notes,
    '',
    'the lead record the composer reads is not rewritten by a note'
  )
})

test('task priority is stored, returned, and breaks ties on the same due date', async () => {
  const lead = seedLead(db, owner.id, `priority-${Date.now()}@acme.test`)
  const due = '2099-01-01T09:00:00.000Z'

  const low = await client.post(`/api/leads/${lead.id}/tasks`, { title: 'Low first', dueAt: due, priority: 'low' })
  const high = await client.post(`/api/leads/${lead.id}/tasks`, { title: 'High second', dueAt: due, priority: 'high' })
  assert.equal(low.status, 200)
  assert.equal(high.status, 200)
  assert.equal(high.body.task.priority, 'high')

  // It survives a read — the whole point; a validated-but-dropped field would
  // come back as the default here.
  const read = await client.get(`/api/leads/${lead.id}/tasks`)
  const byTitle = Object.fromEntries(read.body.items.map((t) => [t.title, t.priority]))
  assert.equal(byTitle['Low first'], 'low')
  assert.equal(byTitle['High second'], 'high')

  // Same due date, so priority decides — but only as a tie-break.
  const sameDue = read.body.items.filter((t) => t.dueAt === due).map((t) => t.title)
  assert.deepEqual(sameDue, ['High second', 'Low first'])

  const patched = await client.patch(`/api/tasks/${low.body.task.id}`, { priority: 'high' })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.task.priority, 'high')

  const bad = await client.patch(`/api/tasks/${low.body.task.id}`, { priority: 'urgent' })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.field, 'priority')
})
