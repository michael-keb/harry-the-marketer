// The public site's contract: SEO documents, safe redirects, and the shape of
// the content module the pages and the server both render from.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PLANS, PLAN_COMPARISON, PAGE_META, SITEMAP_ROUTES, SITE_NAV, FOOTER_NAV, FAQS, LEGAL_ROUTES,
} from '../shared/site-content.js'
import {
  buildHead, injectSeo, isKnownSpaPath, metaFor, normalizePath, robotsTxt, sitemapXml,
} from '../shared/seo.js'
import { safeNext } from '../server/auth.js'

const ORIGIN = 'https://example.test'

// ---- content integrity ------------------------------------------------------

test('every plan has the fields the pricing page renders', () => {
  for (const plan of PLANS) {
    assert.ok(plan.id, 'plan needs an id')
    assert.ok(plan.name, `${plan.id} needs a name`)
    assert.ok(plan.cta && plan.ctaTo, `${plan.id} needs a call to action`)
    assert.ok(Array.isArray(plan.features) && plan.features.length > 0, `${plan.id} needs features`)
    // null price means "Contact sales"; anything else must be a real number.
    if (plan.monthly !== null) {
      assert.equal(typeof plan.monthly, 'number', `${plan.id} monthly must be numeric`)
      assert.equal(typeof plan.annual, 'number', `${plan.id} annual must be numeric`)
      assert.ok(plan.annual <= plan.monthly, `${plan.id} annual should not cost more than monthly`)
    }
  }
})

test('exactly one plan is featured, so the pricing table has one focal point', () => {
  assert.equal(PLANS.filter((p) => p.featured).length, 1)
})

test('the comparison table covers every plan in every row', () => {
  const ids = PLANS.map((p) => p.id)
  for (const group of PLAN_COMPARISON) {
    for (const row of group.rows) {
      for (const id of ids) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(row.values, id),
          `"${row.label}" is missing a value for the ${id} plan`
        )
      }
    }
  }
})

test('every navigable site route has page metadata', () => {
  for (const item of SITE_NAV) {
    assert.ok(PAGE_META[item.to], `${item.to} is in the nav but has no metadata`)
  }
})

test('footer legal links all point at a served legal document', () => {
  const legalPaths = new Set(LEGAL_ROUTES.map((r) => r.path))
  const legalGroup = FOOTER_NAV.find((g) => g.title === 'Legal')
  for (const link of legalGroup.links) {
    assert.ok(legalPaths.has(link.href), `${link.href} is linked but not in LEGAL_ROUTES`)
  }
})

test('footer internal links resolve to real routes', () => {
  for (const group of FOOTER_NAV) {
    for (const link of group.links) {
      if (!link.to) continue
      const base = link.to.split('#')[0]
      assert.ok(PAGE_META[base], `${link.to} is linked in the footer but has no page`)
    }
  }
})

test('FAQ entries are complete', () => {
  assert.ok(FAQS.length >= 5)
  for (const faq of FAQS) {
    assert.ok(faq.q.endsWith('?'), `"${faq.q}" should be a question`)
    assert.ok(faq.a.length > 40, `answer to "${faq.q}" is too thin to be useful`)
  }
})

// ---- SEO --------------------------------------------------------------------

test('normalizePath strips trailing slashes, queries, and hashes', () => {
  assert.equal(normalizePath('/pricing/'), '/pricing')
  assert.equal(normalizePath('/pricing?plan=growth'), '/pricing')
  assert.equal(normalizePath('/product#engine'), '/product')
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath(''), '/')
})

test('known routes get their own title and description', () => {
  const pricing = metaFor('/pricing')
  assert.match(pricing.title, /Pricing/)
  assert.notEqual(pricing.description, metaFor('/product').description)
})

test('unknown routes fall back to defaults and are noindexed', () => {
  const meta = metaFor('/does-not-exist')
  assert.equal(meta.noindex, true)
})

test('buildHead emits canonical, OG, Twitter, and JSON-LD tags', () => {
  const head = buildHead('/pricing', { origin: ORIGIN })
  assert.match(head, /<link rel="canonical" href="https:\/\/example\.test\/pricing" \/>/)
  assert.match(head, /property="og:title"/)
  assert.match(head, /name="twitter:card" content="summary_large_image"/)
  assert.match(head, /application\/ld\+json/)
  assert.match(head, /"@type":"SoftwareApplication"/)
})

test('the homepage canonical has no double slash', () => {
  const head = buildHead('/', { origin: ORIGIN })
  assert.match(head, /<link rel="canonical" href="https:\/\/example\.test" \/>/)
})

test('the login page is noindexed and absent from the sitemap', () => {
  assert.match(buildHead('/login', { origin: ORIGIN }), /noindex, nofollow/)
  assert.ok(!SITEMAP_ROUTES.some((r) => r.path === '/login'))
})

test('SITE_NOINDEX forces noindex on an otherwise indexable page', () => {
  assert.match(buildHead('/', { origin: ORIGIN, forceNoindex: true }), /noindex, nofollow/)
})

test('JSON-LD carries the CSP nonce so the browser does not drop it', () => {
  const head = buildHead('/', { origin: ORIGIN, nonce: 'abc123' })
  assert.match(head, /<script type="application\/ld\+json" nonce="abc123">/)
})

test('injectSeo replaces the placeholder title rather than duplicating it', () => {
  const html = '<!doctype html><html><head><title>Placeholder</title>\n<!--seo--></head><body></body></html>'
  const out = injectSeo(html, '/pricing', { origin: ORIGIN })
  assert.equal(out.match(/<title>/g).length, 1, 'exactly one <title> must survive')
  assert.ok(!out.includes('Placeholder'))
  assert.ok(!out.includes('<!--seo-->'))
})

test('injectSeo still works if the marker was removed by hand', () => {
  const html = '<!doctype html><html><head><title>Placeholder</title></head><body></body></html>'
  const out = injectSeo(html, '/', { origin: ORIGIN })
  assert.equal(out.match(/<title>/g).length, 1)
  assert.match(out, /og:title/)
})

test('robots.txt keeps crawlers out of the API and the signed-in app', () => {
  const txt = robotsTxt({ origin: ORIGIN })
  assert.match(txt, /Disallow: \/api\//)
  assert.match(txt, /Disallow: \/app\//)
  assert.match(txt, /Sitemap: https:\/\/example\.test\/sitemap\.xml/)
})

test('a staging deployment can disallow everything', () => {
  assert.equal(robotsTxt({ origin: ORIGIN, noindex: true }), 'User-agent: *\nDisallow: /\n')
})

test('the sitemap lists every public page including the legal documents', () => {
  const xml = sitemapXml(SITEMAP_ROUTES, { origin: ORIGIN, lastmod: '2026-08-06' })
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  for (const path of ['/', '/product', '/pricing', '/security', '/privacy', '/terms', '/dpa']) {
    const loc = path === '/' ? `${ORIGIN}/` : `${ORIGIN}${path}`
    assert.ok(xml.includes(`<loc>${loc}</loc>`), `sitemap is missing ${path}`)
  }
  assert.ok(!xml.includes(`${ORIGIN}/login`), 'the login page must not be advertised')
})

test('known paths render under 200; unknown ones must be a real 404', () => {
  for (const known of ['/', '/pricing', '/product', '/login', '/signup', '/app', '/app/leads', '/app/campaigns/12']) {
    assert.equal(isKnownSpaPath(known), true, `${known} should be a known route`)
  }
  for (const unknown of ['/nope', '/deep/unknown/path', '/appliances', '/pricing/extra']) {
    assert.equal(isKnownSpaPath(unknown), false, `${unknown} should be a soft-404 candidate`)
  }
})

// ---- redirect safety --------------------------------------------------------

test('safeNext accepts in-app paths', () => {
  assert.equal(safeNext('/app/leads'), '/app/leads')
  assert.equal(safeNext('/app/campaigns/12?tab=leads'), '/app/campaigns/12?tab=leads')
})

test('safeNext refuses open redirects', () => {
  for (const hostile of [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '',
    null,
    undefined,
  ]) {
    assert.equal(safeNext(hostile), '/app', `safeNext must reject ${JSON.stringify(hostile)}`)
  }
})

test('safeNext refuses to bounce a browser into the JSON API', () => {
  assert.equal(safeNext('/api/auth/me'), '/app')
})
