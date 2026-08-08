// Production hardening: security headers, in-memory rate limiting, and gzip.
//
// Deliberately dependency-free — the rest of the server is too, and each of these
// is small enough to read in one sitting.
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { env, isProduction } from './env.js'

// ---- security headers -------------------------------------------------------

// Content-Security-Policy notes:
//  - 'unsafe-inline' for styles is required: Mermaid injects <style> into the SVG
//    it renders, and Vite injects styles inline in development.
//  - Scripts are 'self' plus a per-response nonce, used only by the JSON-LD block
//    in the SEO head. No inline executable script is served.
//  - https: in img-src covers profile pictures returned by Auth0 and Google.
function csp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(isProduction() ? ['upgrade-insecure-requests'] : []),
  ].join('; ')
}

export function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64')
  res.locals.cspNonce = nonce

  res.set('Content-Security-Policy', csp(nonce))
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'DENY')
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()')
  res.set('Cross-Origin-Opener-Policy', 'same-origin')
  res.set('Cross-Origin-Resource-Policy', 'same-origin')
  res.set('X-DNS-Prefetch-Control', 'off')

  // HSTS only once we are genuinely on HTTPS — sending it over http is a footgun
  // that can lock a developer out of localhost.
  const proto = (env.TRUST_PROXY && req.headers['x-forwarded-proto']) || req.protocol
  if (isProduction() && String(proto).split(',')[0] === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  next()
}

// ---- rate limiting ----------------------------------------------------------
//
// Fixed-window counters in process memory. Correct for the single-process
// deployment this app ships as; a multi-instance deployment behind a load
// balancer needs a shared store (Redis) instead.

const buckets = new Map() // `${key}:${ip}` -> { count, resetAt }

// Sweep expired buckets so a long-running process cannot grow unbounded.
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
}, 5 * 60 * 1000)
sweeper.unref?.()

// `by` decides what is being limited. The default is the caller's address,
// which is right for anonymous endpoints and wrong for the product: a whole
// office behind one NAT would share a bucket and throttle each other. Where a
// session exists, limit the session.
export function rateLimit({ windowMs = 60_000, max = 60, key = 'default', message, by = null } = {}) {
  return function rateLimiter(req, res, next) {
    const who = by ? by(req) : null
    const id = `${key}:${who || req.ip || req.socket?.remoteAddress || 'unknown'}`
    const now = Date.now()
    let bucket = buckets.get(id)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(id, bucket)
    }
    bucket.count += 1

    const remaining = Math.max(0, max - bucket.count)
    res.set('RateLimit-Limit', String(max))
    res.set('RateLimit-Remaining', String(remaining))
    res.set('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)))

    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)))
      return res.status(429).json({
        error: message || 'Too many requests — please wait a moment and try again',
      })
    }
    next()
  }
}

// Exposed for tests, which need a clean slate between cases.
export function resetRateLimits() {
  buckets.clear()
}

// ---- compression ------------------------------------------------------------

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript|manifest\+json)|image\/svg\+xml)/i
const MIN_BYTES = 1024
// Responses bigger than this are left alone rather than buffered into memory.
const MAX_BUFFER = 2 * 1024 * 1024

/**
 * gzip for responses this app generates itself: the HTML shell, JSON, XML, and
 * the server-rendered legal pages. Small, buffered, and gzipped in one shot.
 *
 * It deliberately does NOT touch piped responses (static files). Wrapping a pipe
 * means `res.write` returns gzip's backpressure signal while the pipe waits for
 * a `drain` event on `res` that will never arrive — the response hangs forever.
 * Static assets are served pre-compressed instead; see staticGzip().
 */
export function compression(req, res, next) {
  const accepted = String(req.headers['accept-encoding'] || '')
  if (req.method === 'HEAD' || !/\bgzip\b/.test(accepted)) return next()

  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)

  const chunks = []
  let buffered = 0
  let passthrough = false

  const toBuffer = (chunk, encoding) =>
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')

  const shouldCompress = () => {
    if (res.locals.skipCompression) return false
    if (res.getHeader('Content-Encoding')) return false
    if (res.statusCode === 204 || res.statusCode === 304) return false
    return COMPRESSIBLE.test(String(res.getHeader('Content-Type') || ''))
  }

  // Stop buffering and flush what we have — used when a response turns out to
  // be too large, or is not the kind of thing we compress.
  const bail = () => {
    passthrough = true
    for (const c of chunks) originalWrite(c)
    chunks.length = 0
  }

  res.write = (chunk, encoding, cb) => {
    if (passthrough || !chunk) return originalWrite(chunk, encoding, cb)
    if (!shouldCompress()) {
      bail()
      return originalWrite(chunk, encoding, cb)
    }
    const buf = toBuffer(chunk, encoding)
    buffered += buf.length
    if (buffered > MAX_BUFFER) {
      bail()
      return originalWrite(chunk, encoding, cb)
    }
    chunks.push(buf)
    if (typeof encoding === 'function') encoding()
    else if (typeof cb === 'function') cb()
    return true
  }

  res.end = (chunk, encoding, cb) => {
    if (passthrough) return originalEnd(chunk, encoding, cb)
    if (chunk && typeof chunk !== 'function') {
      const buf = toBuffer(chunk, encoding)
      buffered += buf.length
      chunks.push(buf)
    }

    const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered)
    chunks.length = 0

    if (!shouldCompress() || body.length < MIN_BYTES || body.length > MAX_BUFFER) {
      passthrough = true
      return originalEnd(body.length ? body : undefined, typeof chunk === 'function' ? chunk : cb)
    }

    let gzipped
    try {
      gzipped = zlib.gzipSync(body)
    } catch (err) {
      console.error('[compression] gzip failed, sending uncompressed:', err.message)
      passthrough = true
      return originalEnd(body, typeof chunk === 'function' ? chunk : cb)
    }

    passthrough = true
    res.setHeader('Content-Encoding', 'gzip')
    res.setHeader('Content-Length', String(gzipped.length))
    const vary = res.getHeader('Vary')
    res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding')
    return originalEnd(gzipped, typeof chunk === 'function' ? chunk : cb)
  }

  next()
}

/**
 * Serve pre-compressed `<file>.gz` siblings written at build time by
 * scripts/postbuild.mjs, so the big hashed bundles go out gzipped without any
 * per-request CPU cost — and without wrapping a stream.
 *
 * Mount immediately before express.static.
 */
export function staticGzip(dist, { existsSync, extname }) {
  const TYPES = {
    '.js': 'application/javascript; charset=UTF-8',
    '.mjs': 'application/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=UTF-8',
    '.map': 'application/json; charset=UTF-8',
  }
  return function servePrecompressed(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next()

    const ext = extname(req.path)
    const type = TYPES[ext]
    if (!type) return next()

    // Reject anything that escapes the dist directory before touching the disk.
    let decoded
    try {
      decoded = decodeURIComponent(req.path)
    } catch {
      return next()
    }
    if (decoded.includes('\0') || decoded.includes('..')) return next()

    const gzPath = `${dist}${decoded}.gz`
    if (!existsSync(gzPath)) return next()

    res.set('Content-Type', type)
    res.set('Content-Encoding', 'gzip')
    res.set('Vary', 'Accept-Encoding')
    // Static output is buffered by express.static's own sender, not ours.
    res.locals.skipCompression = true
    req.url = `${decoded}.gz`
    next()
  }
}
