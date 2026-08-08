import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-team-'))
process.env.AI_MODE = 'off'

const { db, resolveWorkspace } = await import('../server/db.js')

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
