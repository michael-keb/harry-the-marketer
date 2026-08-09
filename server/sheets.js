// Google Sheet sync.
//
// One button: "Create my Google Sheet". Harry makes the spreadsheet, owns it,
// and keeps it filled in — so there is no sheet ID to find, no tab to name and
// no permissions dialog to reason about. That also means the only Google scope
// we need is `drive.file`, which covers files this app created and nothing else.
//
// The sync is one-way (Harry → Sheet). Typing in the sheet is safe: it gets
// overwritten on the next push, and nothing you type there changes a campaign.
import { db } from './db.js'
import { freshAccessToken } from './google.js'
import { recordTelemetry } from './telemetry.js'
import { leadStages } from './stages.js'

const TAB = 'Prospects'
const RANGE = `${TAB}!A1:H2000`
const MAX_ROWS = 1999
// Don't hammer the API from the engine tick; a push at most every 2 minutes is
// plenty for a page someone glances at.
const MIN_INTERVAL_MS = 120_000

export function sheetMailbox(wsId) {
  return db.prepare(
    "SELECT * FROM mailboxes WHERE user_id = ? AND deleted_at IS NULL AND provider = 'gmail' AND status = 'connected' ORDER BY id LIMIT 1"
  ).get(wsId)
}

async function sheetsFetch(mailbox, path, options = {}) {
  const token = await freshAccessToken(mailbox)
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    // The one failure worth naming precisely: a mailbox connected before this
    // feature existed has a token without the drive.file scope.
    if (res.status === 403 && /insufficient|scope|permission/i.test(detail)) {
      throw new Error('Google has not granted sheet access yet — reconnect your Gmail account on the Mailboxes page and try again')
    }
    throw new Error(`Google Sheets ${res.status}: ${detail}`)
  }
  return res.json()
}

const HEADER = ['Name', 'Email', 'Company', 'Title', 'Stage', 'Campaign', 'Agreement', 'Last activity']

function rowsFor(wsId) {
  const stages = leadStages(wsId)
  const leads = db.prepare('SELECT * FROM leads WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(wsId, MAX_ROWS)
  const campaigns = Object.fromEntries(
    db.prepare(
      `SELECT cl.lead_id, c.name FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
       WHERE c.user_id = ? ORDER BY cl.id`
    ).all(wsId).map((r) => [r.lead_id, r.name])
  )
  const consents = Object.fromEntries(
    db.prepare('SELECT lead_id, status, signed_name, signed_at FROM consents WHERE user_id = ?').all(wsId)
      .map((r) => [r.lead_id, r])
  )
  const lastActivity = Object.fromEntries(
    db.prepare(
      'SELECT lead_id, MAX(created_at) at FROM messages WHERE user_id = ? GROUP BY lead_id'
    ).all(wsId).map((r) => [r.lead_id, r.at])
  )
  return [
    HEADER,
    ...leads.map((l) => {
      const consent = consents[l.id]
      return [
        [l.first_name, l.last_name].filter(Boolean).join(' '),
        l.email,
        l.company || '',
        l.title || '',
        stages[l.id] || 'not contacted',
        campaigns[l.id] || '',
        consent?.status === 'signed' ? `signed by ${consent.signed_name} on ${(consent.signed_at || '').slice(0, 10)}`
          : consent?.status === 'declined' ? 'declined'
          : consent ? 'link sent' : '',
        lastActivity[l.id] || '',
      ]
    }),
  ]
}

// Create the spreadsheet and remember it on the workspace owner.
export async function createSheet(wsId) {
  const mailbox = sheetMailbox(wsId)
  if (!mailbox) throw new Error('Connect a Gmail account on the Mailboxes page first — the sheet is created in that account')
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(wsId)
  const created = await sheetsFetch(mailbox, '', {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: `Harry — prospects (${owner?.email || 'workspace'})` },
      sheets: [{ properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } }],
    }),
  })
  db.prepare('UPDATE users SET sheet_id = ?, sheet_url = ? WHERE id = ?')
    .run(created.spreadsheetId, created.spreadsheetUrl || '', wsId)
  await pushSheet(wsId, { force: true })
  return { id: created.spreadsheetId, url: created.spreadsheetUrl || '' }
}

export function disconnectSheet(wsId) {
  // We only forget it. Deleting someone's spreadsheet is never our call.
  db.prepare("UPDATE users SET sheet_id = '', sheet_url = '', sheet_synced_at = '' WHERE id = ?").run(wsId)
}

// Push the current state. Returns false when there is nothing to do (no sheet,
// or the last push was recent and this is not a forced/manual sync).
export async function pushSheet(wsId, { force = false } = {}) {
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(wsId)
  if (!owner?.sheet_id) return false
  if (!force && owner.sheet_synced_at) {
    const last = Date.parse(owner.sheet_synced_at.replace(' ', 'T') + 'Z')
    if (last && Date.now() - last < MIN_INTERVAL_MS) return false
  }
  const mailbox = sheetMailbox(wsId)
  if (!mailbox) throw new Error('No connected Gmail account — reconnect one on the Mailboxes page to resume sheet sync')

  const t0 = Date.now()
  try {
    const values = rowsFor(wsId)
    await sheetsFetch(mailbox, `/${owner.sheet_id}/values/${encodeURIComponent(RANGE)}:clear`, { method: 'POST', body: '{}' })
    await sheetsFetch(
      mailbox,
      `/${owner.sheet_id}/values/${encodeURIComponent(`${TAB}!A1`)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values }) }
    )
    db.prepare("UPDATE users SET sheet_synced_at = datetime('now') WHERE id = ?").run(wsId)
    recordTelemetry('sheet_sync', { op: 'push', ok: true, ms: Date.now() - t0, detail: `${values.length - 1} row(s)` })
    return true
  } catch (err) {
    recordTelemetry('sheet_sync', { op: 'push', ok: false, ms: Date.now() - t0, detail: String(err.message || err) })
    throw err
  }
}

// Called from the engine after a tick. Never throws — a broken sheet must not
// stop campaigns from running; the failure shows up in Monitoring instead.
export function syncSheetsQuietly() {
  const owners = db.prepare("SELECT id FROM users WHERE sheet_id != ''").all()
  for (const owner of owners) {
    pushSheet(owner.id).catch((err) => console.warn('[sheets] push failed:', err.message))
  }
}
