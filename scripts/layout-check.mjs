// Assert that no product page scrolls sideways.
//
//   node scripts/layout-check.mjs           against http://localhost:8140
//   BASE=http://localhost:8131 npm run check:layout
//
// Why this exists as its own check: a page that scrolls horizontally is not a
// failure any unit test can see. jsdom has no layout engine, so `npm run
// test:web` renders the markup and measures nothing — every one of these bugs
// passed a green suite. They are also invisible on a desktop monitor, which is
// where they get written.
//
// Three of them shipped together, all the same shape and none of them obvious:
//
//   * `sr-only` is `position: absolute`, and an absolutely-positioned element is
//     only clipped by an ancestor's `overflow` when that ancestor is itself
//     positioned. Hidden labels inside the Inbox's scrolled folder strip and the
//     Leads table took their coordinates from the page instead, landed ~500px
//     past the right edge, and dragged the whole document with them.
//   * `sr-only` on a `<table>` does nothing, because a table will not size below
//     its min-content width. Two chart data tables stayed 503px wide.
//
// So the check measures the rendered page in a real browser: set a width, load
// the route, and compare the document's scroll width against its client width.
// When they disagree it names the elements sticking out, because "Reports
// overflows by 33px" is not actionable and "this sr-only table is 503px wide"
// is.

import { chromium } from 'playwright-core'

const BASE = process.env.BASE || 'http://localhost:8140'
const EMAIL = process.env.DEMO_EMAIL || 'demo@harry.test'

// The widths worth checking are the ones where the layout changes its mind:
// below `md` the rail is a sheet, at `md` it is static and the page is at its
// most cramped, and `lg` is where the Inbox becomes three panes.
const WIDTHS = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'laptop', width: 1024, height: 800 },
]

const ROUTES = [
  '/app', '/app/goals', '/app/campaigns', '/app/campaigns/1', '/app/inbox',
  '/app/leads', '/app/reports', '/app/monitoring', '/app/mailboxes', '/app/settings',
]

// Runs in the page. Returns the overflow and, when there is one, the widest
// elements crossing the right edge — enough to find the cause without opening
// devtools.
function measure() {
  const doc = document.documentElement
  const over = doc.scrollWidth - doc.clientWidth
  if (over <= 1) return { over: 0, offenders: [] }

  const seen = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.right <= doc.clientWidth + 1) continue
    const cs = getComputedStyle(el)
    if (cs.position === 'fixed') continue

    // Only report an element whose overflow actually escapes: if an ancestor
    // both clips and is positioned, the element is contained and is a red
    // herring — a wide table inside a working scroll wrapper looks identical to
    // one without, and reporting both buries the real cause.
    let contained = false
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p)
      const clips = ps.overflowX === 'auto' || ps.overflowX === 'scroll' || ps.overflowX === 'hidden'
      if (clips && (cs.position !== 'absolute' || ps.position !== 'static')) { contained = true; break }
    }
    if (contained) continue

    seen.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 70),
      position: cs.position,
      right: Math.round(r.right),
      width: Math.round(r.width),
    })
  }
  seen.sort((a, b) => b.right - a.right)
  return { over, offenders: seen.slice(0, 5) }
}

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.evaluate(async (email) => {
  await fetch('/api/auth/dev-login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: 'Demo Owner' }),
  })
}, EMAIL)

const failures = []
for (const size of WIDTHS) {
  await page.setViewportSize({ width: size.width, height: size.height })
  for (const route of ROUTES) {
    await page.goto(BASE + route, { waitUntil: 'networkidle' })
    await page.waitForTimeout(900)
    const { over, offenders } = await page.evaluate(measure)
    if (over > 1) failures.push({ route, size: size.label, width: size.width, over, offenders })
  }
  console.log(`  ${size.label} (${size.width}px) — ${ROUTES.length} routes`)
}

await browser.close()

if (failures.length === 0) {
  console.log(`\nNo horizontal overflow on ${ROUTES.length} routes × ${WIDTHS.length} widths.`)
  process.exit(0)
}

console.error(`\n${failures.length} page/width combination${failures.length === 1 ? '' : 's'} scroll sideways:\n`)
for (const f of failures) {
  console.error(`  ${f.route} at ${f.width}px — overflows by ${f.over}px`)
  for (const o of f.offenders) {
    console.error(`      <${o.tag} class="${o.cls}"> position:${o.position} width:${o.width} right:${o.right}`)
  }
}
process.exit(1)
