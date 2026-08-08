// Telemetry: lightweight instrumentation for every hop of the pipeline
// (engine ticks, AI calls, provider sends, inbound syncs), read back by the
// Monitoring page. Recording never throws — monitoring must not break sending.
import { db } from './db.js'

export function recordTelemetry(kind, { op = '', ok = true, ms = 0, detail = '' } = {}) {
  try {
    const info = db.prepare('INSERT INTO telemetry (kind, op, ok, ms, detail) VALUES (?, ?, ?, ?, ?)')
      .run(kind, op, ok ? 1 : 0, Math.max(0, Math.round(ms)), String(detail).slice(0, 300))
    // Self-prune: every 500th insert, drop everything beyond the last 5000 rows.
    if (info.lastInsertRowid % 500 === 0) {
      db.prepare('DELETE FROM telemetry WHERE id <= ?').run(info.lastInsertRowid - 5000)
    }
  } catch (err) {
    console.warn('[telemetry] record failed:', err.message)
  }
}

// Run fn, record how it went, and pass the result (or the throw) straight through.
export async function timed(kind, op, fn) {
  const t0 = Date.now()
  try {
    const result = await fn()
    recordTelemetry(kind, { op, ok: true, ms: Date.now() - t0 })
    return result
  } catch (err) {
    recordTelemetry(kind, { op, ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
    throw err
  }
}

export function telemetryRecent(kind, limit = 25) {
  return db.prepare('SELECT * FROM telemetry WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, limit)
}

export function telemetryStats(kind, hours = 24) {
  const row = db.prepare(
    `SELECT COUNT(*) total, COALESCE(SUM(ok = 0), 0) errors, COALESCE(ROUND(AVG(ms)), 0) avgMs
     FROM telemetry WHERE kind = ? AND created_at >= datetime('now', ?)`
  ).get(kind, `-${hours} hours`)
  return { total: row.total, errors: row.errors, avgMs: row.avgMs }
}

export function telemetryFailures(limit = 30) {
  return db.prepare('SELECT * FROM telemetry WHERE ok = 0 ORDER BY id DESC LIMIT ?').all(limit)
}
