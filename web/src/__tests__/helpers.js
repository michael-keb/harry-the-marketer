// Test helpers. No test in this suite may reach a real server: api.js talks to
// global `fetch` and nothing else, so stubbing that one global is the whole
// isolation boundary.

import { vi } from 'vitest'

// A promise a test can hold open, so "what does the UI look like while this
// request is still in flight" is an assertion rather than a race.
export function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Replace global fetch with a handler over (path, params).
//
// The handler returns the JSON body the route would have answered with, or
// throws to simulate an unreachable/erroring route — api.js turns a rejected
// fetch into `ApiError('Cannot reach the server…')`, which is the failure mode
// the palette's degraded banner is written for.
//
// Every requested URL is recorded, because "which query string did the client
// actually send" is the assertion for anything lens- or filter-related.
export function stubFetch(handler) {
  const calls = []
  const impl = vi.fn(async (input, init) => {
    const url = String(input)
    const [path, search] = url.split('?')
    calls.push(url)
    const params = new URLSearchParams(search || '')
    const body = await handler({ url, path, params, init })
    return {
      ok: true,
      status: 200,
      json: async () => body,
    }
  })
  vi.stubGlobal('fetch', impl)
  return { calls, fetch: impl }
}
