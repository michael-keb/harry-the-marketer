import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-team-'))
process.env.AI_MODE = 'off'

const { db, resolveWorkspace, acceptInvite, declineInvite } = await import('../server/db.js')
const { canonicalEmail } = await import('../shared/email.js')

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:owner@x.com', 'owner@x.com', 'Owner')").run()
db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:member@x.com', 'member@x.com', 'Member')").run()
db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:solo@x.com', 'solo@x.com', 'Solo')").run()
const owner = db.prepare("SELECT * FROM users WHERE email = 'owner@x.com'").get()
const member = db.prepare("SELECT * FROM users WHERE email = 'member@x.com'").get()
const solo = db.prepare("SELECT * FROM users WHERE email = 'solo@x.com'").get()

test('a user with no invites owns their own workspace', () => {
  const ws = resolveWorkspace(solo)
  assert.equal(ws.wsId, solo.id)
  assert.equal(ws.role, 'owner')
})

test('an invited member resolves to the owner workspace and activates', () => {
  db.prepare("INSERT INTO team_members (owner_id, email) VALUES (?, 'member@x.com')").run(owner.id)
  const ws = resolveWorkspace(member)
  assert.equal(ws.wsId, owner.id)
  assert.equal(ws.role, 'member')
  assert.equal(ws.ownerEmail, 'owner@x.com')
  const row = db.prepare("SELECT status FROM team_members WHERE email = 'member@x.com'").get()
  assert.equal(row.status, 'active')
})

test('the owner keeps their own workspace even if self-listed', () => {
  db.prepare("INSERT INTO team_members (owner_id, email) VALUES (?, 'owner@x.com')").run(owner.id)
  const ws = resolveWorkspace(owner)
  assert.equal(ws.wsId, owner.id)
  assert.equal(ws.role, 'owner')
})

test('an invite for an email with no account yet resolves once they sign up', () => {
  db.prepare("INSERT INTO team_members (owner_id, email) VALUES (?, 'newhire@x.com')").run(owner.id)
  db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:newhire@x.com', 'newhire@x.com', 'New Hire')").run()
  const hire = db.prepare("SELECT * FROM users WHERE email = 'newhire@x.com'").get()
  const ws = resolveWorkspace(hire)
  assert.equal(ws.wsId, owner.id)
  assert.equal(ws.role, 'member')
})

test('canonicalEmail folds Gmail aliases and leaves other domains alone', () => {
  assert.equal(canonicalEmail('Michael.Keb83+00@gmail.com'), 'michaelkeb83@gmail.com')
  assert.equal(canonicalEmail('michael.keb83@googlemail.com'), 'michaelkeb83@gmail.com')
  assert.equal(canonicalEmail('Coach+x@Company.com'), 'coach+x@company.com')
  assert.equal(canonicalEmail(''), '')
})

test('a Gmail plus-alias invite matches the account Google actually signs in', () => {
  db.prepare("INSERT INTO team_members (owner_id, email, canonical_email) VALUES (?, 'michael.keb83+00@gmail.com', ?)")
    .run(owner.id, canonicalEmail('michael.keb83+00@gmail.com'))
  db.prepare("INSERT INTO users (sub, email, name) VALUES ('google|1', 'michael.keb83@gmail.com', 'Michael')").run()
  const michael = db.prepare("SELECT * FROM users WHERE email = 'michael.keb83@gmail.com'").get()
  const ws = resolveWorkspace(michael)
  assert.equal(ws.wsId, owner.id)
  assert.equal(ws.role, 'member')
})

test('an invitee who owns data keeps their workspace and sees the invite as pending until they accept', () => {
  db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:busy@x.com', 'busy@x.com', 'Busy')").run()
  const busy = db.prepare("SELECT * FROM users WHERE email = 'busy@x.com'").get()
  db.prepare("INSERT INTO campaigns (user_id, name, mermaid) VALUES (?, 'Mine', 'flowchart TD')").run(busy.id)
  db.prepare("INSERT INTO team_members (owner_id, email, canonical_email) VALUES (?, 'busy@x.com', 'busy@x.com')").run(owner.id)
  const invite = db.prepare("SELECT * FROM team_members WHERE email = 'busy@x.com'").get()

  let ws = resolveWorkspace(busy)
  assert.equal(ws.wsId, busy.id)
  assert.equal(ws.role, 'owner')
  assert.deepEqual(ws.pendingInvite, { id: invite.id, ownerEmail: 'owner@x.com', ownerName: 'Owner', role: 'member' })
  assert.equal(db.prepare('SELECT status FROM team_members WHERE id = ?').get(invite.id).status, 'invited')

  // Someone else cannot answer an invite that is not theirs.
  assert.equal(acceptInvite(solo, invite.id), null)
  assert.equal(declineInvite(solo, invite.id), null)

  assert.ok(acceptInvite(busy, invite.id))
  ws = resolveWorkspace(busy)
  assert.equal(ws.wsId, owner.id)
  assert.equal(ws.role, 'member')
  assert.equal(ws.pendingInvite, null)
  // Their own campaign is still theirs.
  assert.equal(db.prepare('SELECT count(*) AS n FROM campaigns WHERE user_id = ?').get(busy.id).n, 1)
})

test('declining removes the invite and leaves the invitee in their own workspace', () => {
  db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:nope@x.com', 'nope@x.com', 'Nope')").run()
  const nope = db.prepare("SELECT * FROM users WHERE email = 'nope@x.com'").get()
  db.prepare("INSERT INTO leads (user_id, email) VALUES (?, 'lead@y.com')").run(nope.id)
  db.prepare("INSERT INTO team_members (owner_id, email, canonical_email) VALUES (?, 'nope@x.com', 'nope@x.com')").run(owner.id)
  const invite = db.prepare("SELECT * FROM team_members WHERE email = 'nope@x.com'").get()
  assert.ok(resolveWorkspace(nope).pendingInvite)
  assert.ok(declineInvite(nope, invite.id))
  assert.equal(db.prepare('SELECT count(*) AS n FROM team_members WHERE id = ?').get(invite.id).n, 0)
  const ws = resolveWorkspace(nope)
  assert.equal(ws.wsId, nope.id)
  assert.equal(ws.pendingInvite, null)
})

test('legacy rows without a canonical address are backfilled on boot', () => {
  // The migration ran at import; simulate an older row and re-run the same statement.
  db.prepare("INSERT INTO team_members (owner_id, email, canonical_email) VALUES (?, 'Old.Row+1@gmail.com', '')").run(owner.id)
  for (const row of db.prepare("SELECT id, email FROM team_members WHERE canonical_email = ''").all()) {
    db.prepare('UPDATE team_members SET canonical_email = ? WHERE id = ?').run(canonicalEmail(row.email), row.id)
  }
  assert.equal(db.prepare("SELECT canonical_email FROM team_members WHERE email = 'Old.Row+1@gmail.com'").get().canonical_email, 'oldrow@gmail.com')
})
