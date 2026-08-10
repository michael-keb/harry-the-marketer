// The backup exists to be restored. So the test restores it: a consistent
// snapshot taken while the database is open, reopened as its own database,
// with the data readable — the check the runbook's sign-off box asks for.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-backup-'))
process.env.DATA_DIR = DATA_DIR
process.env.AI_MODE = 'off'

const { db } = await import('../server/db.js')
const { dailyBackup } = await import('../server/backup.js')
const Database = (await import('better-sqlite3')).default

db.prepare("INSERT INTO users (sub, email, name) VALUES ('dev:b@x.com', 'b@x.com', 'B')").run()
db.prepare("INSERT INTO leads (user_id, email, first_name) VALUES (1, 'lead@example.test', 'Lee')").run()

const backupDirs = () => {
  const root = path.join(DATA_DIR, 'backups')
  return fs.existsSync(root)
    ? fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort()
    : []
}

test('a backup is written while the database is live, and restores readable', async () => {
  const result = await dailyBackup({ force: true })
  assert.match(result.did || '', /backup written/)

  const dirs = backupDirs()
  assert.equal(dirs.length, 1)
  const dest = path.join(DATA_DIR, 'backups', dirs[0])
  assert.ok(fs.existsSync(path.join(dest, 'manifest.json')))

  // The restore: open the snapshot as a database of its own and read it.
  const restored = new Database(path.join(dest, 'harry-the-marketer.db'), { readonly: true })
  assert.equal(restored.prepare('SELECT email FROM users WHERE id = 1').get().email, 'b@x.com')
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM leads').get().n, 1)
  restored.close()
})

test('the daily gate runs the job once per day', async () => {
  // force:true above did not stamp the day? It did — kvSet always runs. The
  // ungated call now sees today's stamp and declines to run again.
  const second = await dailyBackup()
  assert.equal(second.did, undefined)
  assert.equal(backupDirs().length, 1, 'no second backup folder appeared')
})

test('retention prunes beyond 14 folders', async () => {
  const root = path.join(DATA_DIR, 'backups')
  for (let i = 0; i < 16; i++) {
    fs.mkdirSync(path.join(root, `2020-01-${String(i + 1).padStart(2, '0')}T00-00-00`), { recursive: true })
  }
  await dailyBackup({ force: true })
  assert.ok(backupDirs().length <= 14, `kept ${backupDirs().length}, expected at most 14`)
})
