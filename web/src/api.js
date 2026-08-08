// Thin fetch wrapper: JSON in/out, throws Error with server-provided message.
export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

// The client lens, applied in one place.
//
// Only these read routes understand `clientId`, because only campaigns, leads
// and mailboxes carry a `client_id`. Appending it everywhere would be a lie by
// omission — Reports and Monitoring really are workspace-wide, and the sidebar
// says so rather than quietly returning unfiltered numbers under a filter.
//
// Doing it here rather than in each page means a page cannot forget, and the
// lens can be switched off in one edit.
const LENS_AWARE = ['/api/leads', '/api/campaign-list', '/api/mailboxes/fleet']

function withLens(url) {
  if (typeof url !== 'string' || !url.startsWith('/api/')) return url
  const path = url.split('?')[0]
  if (!LENS_AWARE.includes(path)) return url
  // Read lazily: importing the lens at module scope would make api.js depend on
  // React, and this module is deliberately plain.
  const id = globalThis.__harryClientLensId
  if (!id) return url
  return url + (url.includes('?') ? '&' : '?') + `clientId=${encodeURIComponent(id)}`
}

async function request(method, url, body) {
  let res
  if (method === 'GET') url = withLens(url)
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError('Cannot reach the server — is it running?', 0)
  }
  let payload = null
  try { payload = await res.json() } catch { /* non-JSON response */ }
  if (!res.ok) {
    // The parity modules answer a 422 with { error, field, message } where the
    // message is the sentence meant for a person and `error` is the machine
    // code. Prefer the sentence; fall back to the code for older routes.
    throw new ApiError(payload?.message || payload?.error || `Request failed (${res.status})`, res.status, payload)
  }
  return payload
}

// Newline-delimited JSON: calls onLine for each object as it arrives rather
// than waiting for the whole response. An error before the stream starts still
// arrives as a normal JSON error with a status code; once bytes are flowing the
// server reports failures in-band.
export async function stream(url, body, onLine, { signal } = {}) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') return
    throw new ApiError('Cannot reach the server — is it running?', 0)
  }
  if (!res.ok || !res.body) {
    let payload = null
    try { payload = await res.json() } catch { /* non-JSON error body */ }
    throw new ApiError(payload?.error || `Request failed (${res.status})`, res.status, payload)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const drain = (final) => {
    let cut
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (line) onLine(JSON.parse(line))
    }
    if (final && buffer.trim()) onLine(JSON.parse(buffer.trim()))
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      drain(false)
    }
    drain(true)
  } catch (err) {
    if (err?.name === 'AbortError') return
    throw err
  }
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url, body) => request('DELETE', url, body),
  stream,
}

// Build a query string from an object, dropping empty values so a filter that
// is not set never reaches the server as `&campaignId=`. Arrays repeat the key.
export function qs(params = {}) {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const v of value) if (v !== undefined && v !== null && v !== '') out.append(key, String(v))
    } else {
      out.set(key, String(value))
    }
  }
  const str = out.toString()
  return str ? `?${str}` : ''
}
