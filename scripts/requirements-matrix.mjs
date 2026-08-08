// Generate Docs/REQUIREMENTS-MATRIX.md — one row per endpoint spec, with the
// mechanical facts derived rather than typed.
//
//   node scripts/requirements-matrix.mjs
//
// Why generated: a hand-maintained matrix over 210 specs is wrong within a
// week, and a matrix nobody trusts is worse than none. Everything here that a
// machine can know, a machine works out: which Harry routes the spec asks for,
// whether those routes are actually registered, how many acceptance criteria
// and test cases the spec carries, and which module and page own it.
//
// The one column a machine cannot know is the verdict — whether the *intent*
// was met. That is the `Status` and `Notes` pair, and both are PRESERVED across
// regenerations by reading the existing file back in. Edit them freely; re-run
// this whenever the code or the specs move.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = path.join(ROOT, 'Docs')
const OUT = path.join(DOCS, 'REQUIREMENTS-MATRIX.md')

// ---- the live route table ---------------------------------------------------

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-matrix-'))
process.env.AI_MODE = 'off'
const { api } = await import('../server/routes.js')

const liveRoutes = []
for (const layer of api.stack) {
  if (!layer.route) continue
  for (const method of Object.keys(layer.route.methods)) {
    liveRoutes.push({ method: method.toUpperCase(), path: layer.route.path })
  }
}

// `/leads/:id` and `/leads/:leadId` are the same route wearing different
// parameter names, and a spec is free to call it either. Compare on shape.
const shape = (p) => p.replace(/:[^/]+/g, ':x').replace(/\/+$/, '') || '/'
const liveSet = new Set(liveRoutes.map((r) => `${r.method} ${shape(r.path)}`))

function isLive(method, apiPath) {
  const p = apiPath.replace(/^\/api/, '').split('?')[0]
  return liveSet.has(`${method} ${shape(p)}`)
}

// ---- is it actually wired into a screen? ------------------------------------

// The route existing proves the endpoint is reachable, not that anybody can
// reach it. §4 of every spec describes a surface, and a route no page calls is
// a feature only curl can use. So: does any file under web/src actually request
// this path? Crude but honest — it cannot tell you the screen is *good*, only
// that the wiring exists at all.
const WEB = path.join(ROOT, 'web', 'src')
let webText = ''
;(function readWeb(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) readWeb(full)
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) webText += fs.readFileSync(full, 'utf8')
  }
})(WEB)

// Match on the literal prefix before the first parameter, which is what a
// template literal in the client actually contains: `/api/campaigns/${id}/steps`
// shares the prefix `/api/campaigns/` and the tail `/steps`.
function calledFromWeb(apiPath) {
  const clean = apiPath.split('?')[0].replace(/\/+$/, '')
  const segments = clean.split('/').filter(Boolean)
  const literal = []
  for (const seg of segments) {
    if (seg.startsWith(':')) break
    literal.push(seg)
  }
  const prefix = '/' + literal.join('/')
  if (!webText.includes(prefix)) return false
  // If the route has a tail after the parameter, require that too, so
  // /campaigns/:id/steps is not satisfied by a call to /campaigns/:id.
  const tail = segments.slice(literal.length).filter((x) => !x.startsWith(':'))
  return tail.every((t) => webText.includes('/' + t))
}

// ---- parse the specs --------------------------------------------------------

const categories = fs.readdirSync(DOCS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'Research')
  .map((d) => d.name)
  .sort()

const rows = []
for (const category of categories) {
  const dir = path.join(DOCS, category)
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const rel = `${category}/${file}`
    const text = fs.readFileSync(path.join(dir, file), 'utf8')

    // Only files carrying an Endpoint row are endpoint specs. This is what
    // keeps Docs/Research out without naming it twice.
    const endpoint = text.match(/^\|\s*\*\*Endpoint\*\*\s*\|\s*`([A-Z]+)\s+([^`]+)`/m)
    if (!endpoint) continue

    const title = (text.match(/^#\s+(.+)$/m) || [])[1]?.trim() || file.replace(/\.md$/, '')
    const upstream = endpoint[2].replace(/^https?:\/\/[^/]+/, '')
    const verdict = (text.match(/^\*\*Verdict:\*\*\s*(.+)$/m) || [])[1]?.trim() || ''

    // What the spec asks Harry itself to expose (§5 names them as `GET /api/…`).
    const asked = [...text.matchAll(/`(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^`\s]*)/g)]
      .map((m) => ({ method: m[1], path: m[2] }))
    const uniqueAsked = []
    for (const a of asked) {
      const key = `${a.method} ${a.path}`
      if (!uniqueAsked.some((u) => `${u.method} ${u.path}` === key)) uniqueAsked.push(a)
    }
    const present = uniqueAsked.filter((a) => isLive(a.method, a.path))
    const wired = uniqueAsked.filter((a) => calledFromWeb(a.path))

    rows.push({
      rel,
      category,
      title,
      method: endpoint[1],
      upstream,
      verdict,
      criteria: (text.match(/^- \[[ x]\]/gm) || []).length,
      testCases: (text.match(/^\|\s*TC-\d+/gm) || []).length,
      asked: uniqueAsked,
      present: present.length,
      wired: wired.length,
    })
  }
}

// ---- which module and which page own each category --------------------------

const OWNERS = {
  analytics: ['server/parity/analytics.js', 'Reports'],
  'campaign-statistics': ['server/parity/analytics.js', 'Reports'],
  campaigns: ['server/parity/campaigns.js', 'Campaigns'],
  clients: ['server/parity/clients.js', 'Settings'],
  'email-account-tags': ['server/parity/tags.js', 'Mailboxes'],
  'email-accounts': ['server/parity/mailboxes.js', 'Mailboxes'],
  inbox: ['server/parity/inbox.js', 'Inbox'],
  'lead-lists': ['server/parity/lists.js', 'Leads'],
  'lead-notes': ['server/parity/notes.js', 'Leads'],
  'lead-tags': ['server/parity/tags.js', 'Leads'],
  'lead-tasks': ['server/parity/notes.js', 'Leads / Dashboard'],
  leads: ['server/parity/leads.js', 'Leads'],
  'smart-delivery': ['server/parity/deliverability.js', 'Monitoring'],
  'smart-prospect': ['server/parity/prospects.js', 'Leads → Find prospects'],
  'smart-senders': ['server/parity/senders.js', 'Mailboxes'],
  utilities: ['server/parity/utilities.js', 'Settings'],
  webhooks: ['server/parity/webhooks.js', 'Settings'],
}

// ---- preserve the human columns --------------------------------------------

// Status and Notes are judgement, not fact, so they survive regeneration. They
// are keyed on the spec path, which is the one stable identifier here.
const keep = new Map()
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*\[[^\]]*\]\(([^)]+)\)\s*\|/)
    if (!m) continue
    const cells = line.split('|').map((c) => c.trim())
    // …| Status | Notes |  → the last two cells before the trailing empty one.
    const notes = cells[cells.length - 2] || ''
    const status = cells[cells.length - 3] || ''
    keep.set(m[1].replace(/^\.\//, ''), { status, notes })
  }
}

const STATUS_DEFAULT = 'Not reviewed'

// ---- emit -------------------------------------------------------------------

const esc = (s) => String(s).replace(/\|/g, '\\|')
const totals = {
  specs: rows.length,
  criteria: rows.reduce((n, r) => n + r.criteria, 0),
  testCases: rows.reduce((n, r) => n + r.testCases, 0),
  asked: rows.reduce((n, r) => n + r.asked.length, 0),
  present: rows.reduce((n, r) => n + r.present, 0),
  fullyRouted: rows.filter((r) => r.asked.length > 0 && r.present === r.asked.length).length,
  wired: rows.reduce((n, r) => n + r.wired, 0),
  fullyWired: rows.filter((r) => r.asked.length > 0 && r.wired === r.asked.length).length,
  noUiAtAll: rows.filter((r) => r.asked.length > 0 && r.wired === 0).length,
  noRoutesNamed: rows.filter((r) => r.asked.length === 0).length,
}

let md = `# Requirements matrix

One row per endpoint spec in this folder. **Generated** — run \`npm run matrix\`
after changing the specs or the code. The \`Status\` and \`Notes\` columns are
yours: they are read back in and preserved on every regeneration, so write in
them freely.

The mechanical columns are derived, not typed:

- **Routes** — how many of the Harry routes the spec's §5 asks for are actually
  registered right now, out of how many it names. \`0/0\` means the spec names no
  \`/api/…\` route of its own (usually because it is served by a sibling
  endpoint's route, or the backlog marks it "Invisible — no UI").
A full \`Routes\` count means the endpoint is *reachable*. It does **not** mean
every acceptance criterion is met — that is what \`Status\` is for, and it is
deliberately \`${STATUS_DEFAULT}\` until a human has read the spec against the code.

## Totals

| | |
|---|---|
| Endpoint specs (excludes \`Research/\`) | ${totals.specs} |
| Acceptance criteria | ${totals.criteria.toLocaleString()} |
| Test cases | ${totals.testCases.toLocaleString()} |
| Harry routes named by specs | ${totals.asked} |
| …of those, registered | ${totals.present} |
| Specs whose named routes are all live | ${totals.fullyRouted} |
| Specs naming no route of their own | ${totals.noRoutesNamed} |
| …of those routes, called from \`web/src\` | ${totals.wired} |
| Specs whose routes are all called by a screen | ${totals.fullyWired} |
| **Specs with a live route no screen calls** | **${totals.noUiAtAll}** |

`

for (const category of categories) {
  const set = rows.filter((r) => r.category === category)
  if (!set.length) continue
  const [module, surface] = OWNERS[category] || ['—', '—']
  md += `## ${category}\n\n`
  md += `Backend \`${module}\` · Surface **${surface}** · ${set.length} endpoint${set.length === 1 ? '' : 's'}\n\n`
  md += '| Spec | Endpoint | UI impact | Routes | UI | AC | TC | Status | Notes |\n'
  md += '|---|---|---|---|---|---|---|---|---|\n'
  for (const r of set) {
    const held = keep.get(r.rel) || {}
    const routes = `${r.present}/${r.asked.length}`
    md += `| [${esc(r.title)}](./${r.rel}) | \`${r.method} ${esc(r.upstream)}\` | ${esc(r.verdict)} | ${routes} | ${r.wired}/${r.asked.length} | ${r.criteria} | ${r.testCases} | ${esc(held.status || STATUS_DEFAULT)} | ${esc(held.notes || '')} |\n`
  }
  md += '\n'
}

md += `---

Regenerate with \`npm run matrix\`. Route data comes from the live Express
router, so a route that stops being registered shows up here as a dropped count
rather than as prose that quietly went out of date.
`

fs.writeFileSync(OUT, md)
console.log(`Wrote ${path.relative(ROOT, OUT)}`)
console.log(`  ${totals.specs} specs · ${totals.criteria} acceptance criteria · ${totals.testCases} test cases`)
console.log(`  ${totals.present}/${totals.asked} named routes registered · ${totals.fullyRouted} specs fully routed · ${totals.noRoutesNamed} name no route`)
if (keep.size) console.log(`  preserved Status/Notes for ${keep.size} row(s)`)
