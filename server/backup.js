// Daily on-disk backup, run by upkeep rather than an external cron.
//
// The runbook's `npm run backup:db` copies the db file and its WAL sibling —
// fine for a stopped server, not for a live one, where the copy can catch the
// WAL mid-checkpoint. This uses better-sqlite3's online backup API instead,
// which snapshots a consistent database while writes continue.
//
// Scheduled here because no external scheduler exists in this deployment:
// render.yaml runs one web service and nothing else, so "cron will do it"
// meant nobody did it. Upkeep already ticks every 20 seconds; the job gates
// itself to once per UTC day, after 04:00 UTC (~2pm Sydney — mid-afternoon,
// after the morning send window has produced the day's data).
//
// This protects against corruption and bad deploys, not disk loss — the copy
// lives on the same Render disk. Off-site replication remains an operator
// decision (BACKUP-RUNBOOK.md).

import fs from 'node:fs'
import path from 'node:path'
import { db, kvGet, kvSet } from './db.js'

const DATA_DIR = process.env.DATA_DIR || ''
const DB_FILE = 'harry-the-marketer.db'
const KEEP = 14
const AFTER_UTC_HOUR = 4

export async function dailyBackup({ force = false } = {}) {
  if (!DATA_DIR) return {} // dev checkout without a data dir — nothing durable to protect
  const today = new Date().toISOString().slice(0, 10)
  if (!force && kvGet('last_backup_day') === today) return {}
  if (!force && new Date().getUTCHours() < AFTER_UTC_HOUR) return {}

  const backupRoot = path.join(DATA_DIR, 'backups')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = path.join(backupRoot, stamp)
  fs.mkdirSync(dest, { recursive: true })

  await db.backup(path.join(dest, DB_FILE))
  fs.writeFileSync(
    path.join(dest, 'manifest.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), method: 'better-sqlite3 online backup', files: fs.readdirSync(dest) }, null, 2)
  )

  // Prune oldest beyond the retention window (folder names sort by time).
  try {
    const dirs = fs.readdirSync(backupRoot)
      .filter((d) => fs.statSync(path.join(backupRoot, d)).isDirectory())
      .sort()
    while (dirs.length > KEEP) {
      fs.rmSync(path.join(backupRoot, dirs.shift()), { recursive: true, force: true })
    }
  } catch { /* retention is best-effort; the backup itself already landed */ }

  kvSet('last_backup_day', today)
  const size = fs.statSync(path.join(dest, DB_FILE)).size
  // No logEvent: events rows belong to a workspace and a backup belongs to the
  // deployment. The `did` string lands in tick telemetry via upkeep's job().
  console.log(`[backup] daily backup written → ${dest} (${(size / 1024 / 1024).toFixed(1)} MB)`)
  return { did: `daily database backup written (${(size / 1024 / 1024).toFixed(1)} MB)` }
}
