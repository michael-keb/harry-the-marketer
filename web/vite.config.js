import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectSeo } from '../shared/seo.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

// In production the Express server injects per-route SEO tags into the shell
// (server/site.js). This does the same in dev so what you see locally is what
// crawlers get in production.
// `apply: 'serve'` is load-bearing: at build time the marker must survive into
// dist/index.html so the server can inject per-request. Injecting during the
// build would bake the homepage's tags in and duplicate them on every route.
function seoPlugin() {
  return {
    name: 'harry-seo',
    apply: 'serve',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        return injectSeo(html, ctx?.originalUrl || '/', { origin: 'http://localhost:8131' })
      },
    },
  }
}

// Paths the API server owns even in dev: the public site documents and the
// server-rendered legal pages.
const SERVER_OWNED = [
  '/api',
  '/privacy',
  '/terms',
  '/acceptable-use',
  '/dpa',
  '/sub-processors',
  '/cookies',
  '/robots.txt',
  '/sitemap.xml',
  '/og-image.svg',
  '/favicon.svg',
  '/t/', // open pixel, click redirects, unsubscribe
  '/agree', // the server-rendered agreement page recipients sign
]

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss(), seoPlugin()],
  server: {
    port: 8131,
    // shared/ lives above the Vite root; both the site and the server read it.
    fs: { allow: [repoRoot] },
    proxy: Object.fromEntries(
      SERVER_OWNED.map((p) => [p, { target: 'http://localhost:8130', changeOrigin: false }])
    ),
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Mermaid is deliberately NOT named here: forcing it into a manual chunk
        // makes Rollup treat it as a static import of the entry, which puts a
        // <link modulepreload> for ~3MB on the marketing homepage. Left alone,
        // the dynamic import() in PlaybookDiagram splits it properly.
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react'
          return undefined
        },
      },
    },
  },
})
