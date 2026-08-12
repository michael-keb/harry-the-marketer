import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { migrateOutlookProvider } from '../server/parity/schema.js'

// Builds a pre-'outlook' mailboxes table exactly as db.js declared it before the
// provider allow-list gained 'outlook' — with the FK cascade and the status
// CHECK that the old PRAGMA-based rebuild used to silently drop.
function oldSchemaDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT);
    CREATE TABLE mailboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('gmail','sandbox')),
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','disconnected')),
      UNIQUE (user_id, provider, email)
    );
  `)
  db.prepare('INSERT INTO users (id, email) VALUES (1, ?)').run('op@x.com')
  db.prepare("INSERT INTO mailboxes (user_id, provider, email, status) VALUES (1, 'gmail', ?, 'connected')").run('a@x.com')
  return db
}

test('migration widens provider to include outlook and preserves the data', () => {
  const db = oldSchemaDb()
  migrateOutlookProvider(db)
  const row = db.prepare('SELECT provider, email, status FROM mailboxes WHERE email = ?').get('a@x.com')
  assert.deepEqual(row, { provider: 'gmail', email: 'a@x.com', status: 'connected' })
  // outlook is now an accepted provider
  db.prepare("INSERT INTO mailboxes (user_id, provider, email, status) VALUES (1, 'outlook', ?, 'connected')").run('b@x.com')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mailboxes').get().n, 2)
})

test('the status CHECK survives the migration', () => {
  const db = oldSchemaDb()
  migrateOutlookProvider(db)
  assert.throws(
    () => db.prepare("INSERT INTO mailboxes (user_id, provider, email, status) VALUES (1, 'gmail', ?, 'nonsense')").run('c@x.com'),
    /CHECK constraint failed/,
    'a bogus status must still be rejected',
  )
})

test('the user_id ON DELETE CASCADE survives the migration', () => {
  const db = oldSchemaDb()
  migrateOutlookProvider(db)
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM users WHERE id = 1').run()
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM mailboxes').get().n,
    0,
    'deleting the user must cascade to their mailboxes, not orphan them',
  )
})

test('running it again is a no-op once outlook is present', () => {
  const db = oldSchemaDb()
  migrateOutlookProvider(db)
  const ddlBefore = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mailboxes'").get().sql
  migrateOutlookProvider(db)
  const ddlAfter = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mailboxes'").get().sql
  assert.equal(ddlAfter, ddlBefore, 'second run must not rebuild the table')
})
