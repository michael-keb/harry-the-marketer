#!/usr/bin/env node
/**
 * Backup Harry's SQLite database (and WAL/SHM siblings) from DATA_DIR.
 *
 *   DATA_DIR=/var/data node scripts/backup-db.mjs
 *   DATA_DIR=/var/data BACKUP_DIR=/var/backups node scripts/backup-db.mjs
 *
 * Writes a timestamped folder with harry-the-marketer.db + sidecars.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data')
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups')
const DB_FILE = 'harry-the-marketer.db'

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const dest = path.join(BACKUP_DIR, stamp)

if (!fs.existsSync(path.join(DATA_DIR, DB_FILE))) {
  console.error(`[backup] no database at ${path.join(DATA_DIR, DB_FILE)}`)
  process.exit(1)
}

fs.mkdirSync(dest, { recursive: true })

for (const name of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  const src = path.join(DATA_DIR, name)
  if (!fs.existsSync(src)) continue
  fs.copyFileSync(src, path.join(dest, name))
  console.log(`[backup] copied ${name}`)
}

const manifest = {
  createdAt: new Date().toISOString(),
  dataDir: DATA_DIR,
  files: fs.readdirSync(dest),
}
fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2))

console.log(`[backup] done → ${dest}`)

// Keep last 14 daily backups (by folder name sort).
try {
  const dirs = fs.readdirSync(BACKUP_DIR).filter((d) => fs.statSync(path.join(BACKUP_DIR, d)).isDirectory()).sort()
  while (dirs.length > 14) {
    const old = dirs.shift()
    fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true })
    console.log(`[backup] pruned old backup ${old}`)
  }
} catch {
  /* first run */
}
