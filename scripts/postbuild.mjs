// Pre-compress the built frontend.
//
// Writes a `<file>.gz` sibling for every compressible asset in web/dist. The
// server serves these directly (server/security.js → staticGzip), so the large
// hashed bundles go out gzipped with zero per-request CPU and without wrapping
// a stream in a transform — which is what deadlocks piped responses.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'web', 'dist')

const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.svg', '.json', '.map'])
const MIN_BYTES = 1024

if (!fs.existsSync(DIST)) {
  console.error('[postbuild] web/dist not found — run the build first')
  process.exit(1)
}

let files = 0
let before = 0
let after = 0

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (entry.name.endsWith('.gz')) continue
    if (!COMPRESSIBLE.has(path.extname(entry.name))) continue

    const source = fs.readFileSync(full)
    if (source.length < MIN_BYTES) continue

    const gzipped = zlib.gzipSync(source, { level: zlib.constants.Z_BEST_COMPRESSION })
    // A .gz bigger than the original would be actively worse to serve.
    if (gzipped.length >= source.length) continue

    fs.writeFileSync(`${full}.gz`, gzipped)
    files += 1
    before += source.length
    after += gzipped.length
  }
}

// Stale .gz files from a previous build would be served against a newer source.
for (const entry of fs.readdirSync(DIST, { recursive: true })) {
  if (String(entry).endsWith('.gz')) fs.rmSync(path.join(DIST, String(entry)), { force: true })
}

walk(DIST)

const pct = before ? Math.round((1 - after / before) * 100) : 0
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`
console.log(`[postbuild] pre-compressed ${files} files: ${mb(before)} → ${mb(after)} (${pct}% smaller)`)
