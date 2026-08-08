// SEO head construction, shared by the Express server (production) and a small
// Vite plugin (development) so both environments serve identical markup.
//
// Crawlers and social scrapers do not run JavaScript. The React site sets these
// tags again on client navigation (web/src/site/seo.js), but the *first* HTML
// response has to carry them already — that is what this module is for.
import { BRAND, PAGE_META, DEFAULT_META, FAQS, PLANS } from './site-content.js'

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function normalizePath(pathname) {
  const path = String(pathname || '/').split('?')[0].split('#')[0]
  return path.replace(/\/+$/, '') || '/'
}

// A path the SPA can actually render something for. Everything under /app is a
// real route (the client router resolves it); the marketing site's routes are
// exactly the keys of PAGE_META. Used by the server to send a real 404 status
// instead of a soft 404.
export function isKnownSpaPath(pathname) {
  const path = normalizePath(pathname)
  return Boolean(PAGE_META[path]) || path === '/app' || path.startsWith('/app/')
}

export function metaFor(pathname) {
  const path = normalizePath(pathname)
  const meta = PAGE_META[path]
  if (meta) return { path, ...meta }
  // Unknown paths under the SPA (including 404s) get the default tags, noindexed.
  return { path, ...DEFAULT_META, noindex: true }
}

// ---- structured data --------------------------------------------------------

function jsonLd(path, origin, nonce) {
  const blocks = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: BRAND.name,
      url: origin,
      description: BRAND.description,
      email: BRAND.supportEmail,
    },
  ]

  if (path === '/' || path === '/pricing') {
    blocks.push({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: BRAND.name,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url: origin,
      description: BRAND.description,
      offers: PLANS.filter((p) => p.monthly !== null).map((p) => ({
        '@type': 'Offer',
        name: p.name,
        price: String(p.monthly),
        priceCurrency: 'USD',
        description: p.tagline,
        url: `${origin}/pricing`,
      })),
    })
  }

  if (path === '/') {
    blocks.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: FAQS.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    })
  }

  // The nonce matches the per-response CSP (server/security.js). Without it the
  // browser refuses the block — script-src applies to ld+json too.
  const nonceAttr = nonce ? ` nonce="${esc(nonce)}"` : ''
  return blocks
    .map(
      (b) =>
        `<script type="application/ld+json"${nonceAttr}>${JSON.stringify(b).replace(/</g, '\\u003c')}</script>`
    )
    .join('\n    ')
}

// ---- head -------------------------------------------------------------------

/**
 * Build the <head> fragment for a given SPA route.
 * @param {string} pathname   request path
 * @param {object} opts       { origin, ogImage, forceNoindex }
 */
export function buildHead(pathname, { origin = BRAND.defaultOrigin, ogImage = '/og-image.svg', forceNoindex = false, nonce = '' } = {}) {
  const meta = metaFor(pathname)
  const canonical = `${origin}${meta.path === '/' ? '' : meta.path}` || origin
  const noindex = forceNoindex || meta.noindex
  const image = ogImage.startsWith('http') ? ogImage : `${origin}${ogImage}`

  return `<title>${esc(meta.title)}</title>
    <meta name="description" content="${esc(meta.description)}" />
    <link rel="canonical" href="${esc(canonical)}" />
    ${noindex ? '<meta name="robots" content="noindex, nofollow" />' : '<meta name="robots" content="index, follow, max-image-preview:large" />'}
    <meta name="theme-color" content="#0b1120" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${esc(BRAND.name)}" />
    <meta property="og:title" content="${esc(meta.title)}" />
    <meta property="og:description" content="${esc(meta.description)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta property="og:image" content="${esc(image)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(meta.title)}" />
    <meta name="twitter:description" content="${esc(meta.description)}" />
    <meta name="twitter:image" content="${esc(image)}" />
    ${jsonLd(meta.path, origin, nonce)}`
}

// index.html carries `<!--seo-->` where the head fragment belongs, plus a
// placeholder <title> so the file is still valid on its own.
const SEO_MARKER = '<!--seo-->'
const TITLE_RE = /<title>[\s\S]*?<\/title>\s*/i

export function injectSeo(html, pathname, opts) {
  const head = buildHead(pathname, opts)
  if (html.includes(SEO_MARKER)) {
    return html.replace(TITLE_RE, '').replace(SEO_MARKER, head)
  }
  // Marker missing (hand-edited index.html): fall back to replacing <title>.
  if (TITLE_RE.test(html)) return html.replace(TITLE_RE, head)
  return html.replace(/<\/head>/i, `  ${head}\n  </head>`)
}

// ---- robots + sitemap -------------------------------------------------------

export function robotsTxt({ origin = BRAND.defaultOrigin, noindex = false } = {}) {
  if (noindex) return 'User-agent: *\nDisallow: /\n'
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /app/',
    'Disallow: /login',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}

export function sitemapXml(routes, { origin = BRAND.defaultOrigin, lastmod } = {}) {
  const urls = routes
    .map(
      (r) => `  <url>
    <loc>${esc(origin)}${r.path === '/' ? '/' : esc(r.path)}</loc>${lastmod ? `\n    <lastmod>${esc(lastmod)}</lastmod>` : ''}
    <changefreq>${esc(r.changefreq || 'monthly')}</changefreq>
    <priority>${esc(r.priority || '0.5')}</priority>
  </url>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}
