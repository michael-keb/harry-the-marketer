// Capture the product, surface by surface, into Docs/<category>/verification/.
//
//   node scripts/gallery.mjs            capture against http://localhost:8140
//   BASE=http://localhost:8131 npm run gallery
//
// Why a script rather than a folder of one-off screenshots: a screenshot taken
// by hand is out of date the moment the page changes, and nobody can tell
// whether it still reflects reality. This re-runs, so "is it working?" has an
// answer you can regenerate in a minute rather than a picture you have to
// trust.
//
// It captures full-page desktop shots, a mobile shot for the surfaces where
// layout is the risk, and — where a flow only exists in motion — a short
// sequence of frames with the interaction driven in between.
//
// It reads nothing from the real database. Point BASE at a throwaway instance
// seeded with `scripts/seed-demo.mjs`; pointing it at a live workspace would
// write real prospect names and addresses into a documentation folder.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = path.join(ROOT, 'Docs')
const BASE = process.env.BASE || 'http://localhost:8140'
const EMAIL = process.env.DEMO_EMAIL || 'demo@harry.test'

// Which category folder each capture belongs to. A surface usually serves
// several categories — the Inbox screen is the evidence for all 25 inbox specs
// — so one capture is written into each folder that claims it.
const SHOTS = [
  {
    name: 'dashboard-needs-you',
    title: 'Dashboard — the one "Needs you" queue',
    path: '/app',
    categories: ['lead-tasks', 'lead-notes'],
    note: 'Approvals, parked decisions, open tasks and due reminders in one list, ordered by urgency.',
  },
  {
    name: 'inbox-states',
    title: 'Inbox — ten states, one list',
    path: '/app/inbox',
    categories: ['inbox'],
    note: 'SmartLead ships ten near-identical inbox screens; this is one list with a state selector. "Needs your OK" stays first.',
  },
  {
    name: 'leads',
    title: 'Leads — labels, segments, tasks, prospect search',
    path: '/app/leads',
    categories: ['leads', 'lead-tags', 'lead-lists', 'lead-notes', 'lead-tasks', 'smart-prospect'],
    note: 'Segments sidebar, derived stage strip, labels, and the Find-prospects pane.',
    mobile: true,
  },
  {
    name: 'campaigns-list',
    title: 'Campaigns — server-paged and filtered',
    path: '/app/campaigns',
    categories: ['campaigns'],
    note: 'The unbounded fetch is gone; filters and paging are server-side.',
  },
  {
    name: 'campaign-detail',
    title: 'Campaign — the playbook IS the campaign',
    path: '/app/campaigns/1',
    categories: ['campaigns', 'campaign-statistics'],
    note: 'Mermaid editor with live render, launch checklist, and START/PAUSE/STOP — never ACTIVE.',
    mobile: true,
  },
  {
    name: 'reports',
    title: 'Reports — 28 analytics endpoints across eight tabs',
    path: '/app/reports',
    categories: ['analytics', 'campaign-statistics'],
    note: 'Every rate now reads server/metrics.js, so this and the campaign header cannot disagree.',
  },
  {
    name: 'monitoring',
    title: 'Monitoring — inbox placement in one section',
    path: '/app/monitoring',
    categories: ['smart-delivery'],
    note: 'The 28-endpoint deliverability category as one Monitoring section, with the 9 unverified upstream contracts stated openly.',
  },
  {
    name: 'mailboxes',
    title: 'Mailboxes — fleet, warm-up and sending infrastructure',
    path: '/app/mailboxes',
    categories: ['email-accounts', 'email-account-tags', 'smart-senders'],
    note: 'Sendability with its reason, usage against the effective cap, and the senders procurement flow.',
  },
  {
    name: 'settings',
    title: 'Settings — clients, webhooks, suppression, providers',
    path: '/app/settings',
    categories: ['clients', 'webhooks', 'utilities'],
    note: 'Never-contact list, webhook registry with its delivery log, agency clients, and the honest provider status.',
    mobile: true,
  },
]

// Flows that only exist in motion. Each frame is captured after the step runs,
// so the sequence reads as a short filmstrip of the interaction.
const FLOWS = [
  {
    name: 'command-palette',
    title: 'Command palette (⌘K) — searching across every kind of record',
    path: '/app/leads',
    categories: ['leads', 'campaigns', 'clients'],
    note: 'One search over leads, campaigns, segments, clients, labels, mailboxes and placement tests.',
    steps: [
      { label: 'closed', run: async () => {} },
      { label: 'open', run: async (page) => { await page.keyboard.press('Meta+k'); await page.waitForTimeout(400) } },
      { label: 'searching', run: async (page) => { await page.keyboard.type('north'); await page.waitForTimeout(900) } },
    ],
  },
  {
    name: 'inbox-email-trail',
    title: 'Inbox — the whole email trail beside the list',
    path: '/app/inbox',
    categories: ['inbox'],
    note: 'Three panes: folders, a scannable list, and a reading pane holding every message in the conversation oldest-first. Older messages collapse behind an expander; the newest stays open.',
    steps: [
      {
        label: 'folders-and-list',
        // Land on Active rather than the approvals queue: the trail is what
        // this sequence is evidence for, and approvals have their own capture.
        run: async (page) => {
          await page.evaluate(() => {
            const b = [...document.querySelectorAll('nav[aria-label="Mail folders"] button')]
              .find((x) => /^Active/.test(x.innerText))
            b?.click()
          })
          await page.waitForTimeout(1200)
        },
      },
      {
        label: 'conversation-open',
        run: async (page) => {
          await page.evaluate(() => document.querySelector('[data-row-button]')?.click())
          await page.waitForTimeout(1200)
        },
      },
      {
        label: 'trail-expanded',
        // The expander is the point: a long conversation folds its older
        // messages away, and this frame is the proof they are still there.
        run: async (page) => {
          await page.evaluate(() => {
            const b = [...document.querySelectorAll('ol[aria-label^="Email trail"] button')]
              .find((x) => /earlier message/.test(x.innerText))
            b?.click()
          })
          await page.waitForTimeout(1000)
        },
      },
    ],
  },
  {
    name: 'client-lens',
    title: 'Client lens — scoping the product to one client',
    path: '/app/leads',
    categories: ['clients'],
    note: 'client_id is a real partition. Selecting a client filters campaigns, leads and mailboxes, and says so continuously.',
    steps: [
      { label: 'all-clients', run: async () => {} },
      {
        label: 'scoped',
        run: async (page) => {
          await page.evaluate(() => {
            const opts = [...document.querySelectorAll('[role="option"]')]
            const t = opts.find((o) => /Northwind/.test(o.textContent))
            if (t) t.click()
          })
          await page.waitForTimeout(1200)
        },
        before: async (page) => {
          await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find((x) => /Viewing:/.test(x.textContent || ''))
            b?.click()
          })
          await page.waitForTimeout(400)
        },
      },
    ],
  },
]

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 })
  const page = await context.newPage()

  // Sign in once; the session cookie rides the context from here.
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async (email) => {
    await fetch('/api/auth/dev-login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: 'Demo Owner' }),
    })
  }, EMAIL)

  const written = []
  const dirFor = (category) => {
    const dir = path.join(DOCS, category, 'verification')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  const save = async (categories, file, buffer) => {
    for (const category of categories) {
      const target = path.join(dirFor(category), file)
      fs.writeFileSync(target, buffer)
      written.push(path.relative(ROOT, target))
    }
  }

  for (const shot of SHOTS) {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto(BASE + shot.path, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1400)
    await save(shot.categories, `${shot.name}.png`, await page.screenshot({ fullPage: true }))
    if (shot.mobile) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForTimeout(1400)
      await save(shot.categories, `${shot.name}-mobile.png`, await page.screenshot({ fullPage: true }))
    }
    console.log(`  ${shot.name}`)
  }

  for (const flow of FLOWS) {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto(BASE + flow.path, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)
    let i = 0
    for (const step of flow.steps) {
      if (step.before) await step.before(page)
      await step.run(page)
      i += 1
      await save(flow.categories, `${flow.name}-${i}-${slug(step.label)}.png`, await page.screenshot())
    }
    console.log(`  ${flow.name} (${flow.steps.length} frames)`)
  }

  await browser.close()
  return written
}

// ---- the index ---------------------------------------------------------------

// A folder of PNGs answers "what does it look like". It does not answer "which
// requirement does this show, and is that requirement actually met" — so each
// folder gets a README pairing its captures with the specs they cover and the
// verdict already recorded in Docs/REQUIREMENTS-MATRIX.md. Where the verdict is
// FAILS or Not reviewed, the README says so next to the picture, because a
// screenshot of a screen is not evidence the screen is correct.
function writeIndexes(written) {
  const matrix = fs.readFileSync(path.join(DOCS, 'REQUIREMENTS-MATRIX.md'), 'utf8')
  const verdicts = new Map()
  for (const line of matrix.split('\n')) {
    if (!line.startsWith('| [')) continue
    const cells = line.split('|').map((c) => c.trim())
    const spec = (cells[1].match(/\(\.\/([^)]+)\)/) || [])[1]
    const title = (cells[1].match(/\[([^\]]+)\]/) || [])[1]
    if (spec) verdicts.set(spec, { title, status: cells[8] || 'Not reviewed', notes: cells[9] || '' })
  }

  const byCategory = new Map()
  for (const item of [...SHOTS, ...FLOWS]) {
    for (const category of item.categories) {
      if (!byCategory.has(category)) byCategory.set(category, [])
      byCategory.get(category).push(item)
    }
  }

  const RANK = { FAILS: 0, 'Not reviewed': 1 }
  let top = `# Visual verification\n\nCaptured from the running app by \`npm run gallery\`. Each category folder holds\nits screenshots and a README pairing them with the specs they cover.\n\n**A screenshot shows a surface exists and renders. It is not evidence the\nrequirement behind it is met** — that verdict lives in\n[REQUIREMENTS-MATRIX.md](./REQUIREMENTS-MATRIX.md) and is repeated beside each\ncapture below.\n\n| Category | Captures | Specs | Judged | FAILS | Unreviewed |\n|---|---|---|---|---|---|\n`

  for (const category of [...byCategory.keys()].sort()) {
    const items = byCategory.get(category)
    const dir = path.join(DOCS, category, 'verification')
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : []
    const specs = [...verdicts.entries()].filter(([k]) => k.startsWith(`${category}/`))
    const fails = specs.filter(([, v]) => v.status === 'FAILS').length
    const unrev = specs.filter(([, v]) => v.status === 'Not reviewed').length

    let md = `# ${category} — visual verification\n\n${specs.length} endpoint spec${specs.length === 1 ? '' : 's'}. Regenerate with \`npm run gallery\`.\n\n`
    md += `> A capture proves the surface renders with real data. Whether each spec's\n> acceptance criteria are met is the **Verdict** column, from\n> [../../REQUIREMENTS-MATRIX.md](../../REQUIREMENTS-MATRIX.md).\n\n## Captures\n\n`
    for (const item of items) {
      md += `### ${item.title}\n\n${item.note}\n\n`
      const mine = files.filter((f) => f.startsWith(item.name))
      for (const f of mine) {
        // 'leads.png' -> desktop; 'leads-mobile.png' -> mobile;
        // 'command-palette-2-open.png' -> '2 open'.
        const label = f.replace('.png', '').replace(item.name, '').replace(/^-/, '').replace(/-/g, ' ') || 'desktop'
        md += `**${label}**\n\n![${item.title} — ${label}](./${f})\n\n`
      }
    }
    md += `## What the specs in this category are judged at\n\n| Spec | Verdict | Notes |\n|---|---|---|\n`
    for (const [spec, v] of specs.sort((a, b) => (RANK[a[1].status] ?? 2) - (RANK[b[1].status] ?? 2))) {
      md += `| [${v.title}](../${path.basename(spec)}) | ${v.status} | ${v.notes} |\n`
    }
    fs.writeFileSync(path.join(dir, 'README.md'), md)

    top += `| [${category}](./${category}/verification/) | ${files.length} | ${specs.length} | ${specs.length - unrev} | ${fails} | ${unrev} |\n`
  }
  fs.writeFileSync(path.join(DOCS, 'VERIFICATION.md'), top)
  return byCategory.size
}

const written = await main()
const categories = writeIndexes(written)
console.log(`\nWrote ${written.length} image(s) across ${categories} categories, plus an index per folder.`)
console.log('Top-level index: Docs/VERIFICATION.md')
