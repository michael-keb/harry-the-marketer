import { useEffect, useState } from 'react'
import { api } from '../api.js'

/**
 * Which sign-in methods this deployment actually offers.
 *
 * Auth0 when configured; the local dev login only while Auth0 is not (or when
 * DEV_LOGIN is forced on). Both pages branch on this rather than assuming.
 */
export function useAuthConfig() {
  const [config, setConfig] = useState(null)
  const [configError, setConfigError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.get('/api/auth/config')
      .then((c) => { if (!cancelled) setConfig(c) })
      .catch((err) => { if (!cancelled) setConfigError(err.message) })
    return () => { cancelled = true }
  }, [])

  return { config, configError }
}

// Auth0 rejects an open redirect the same way we do, but the check belongs on
// both sides of the boundary.
export function safeNext(value, fallback = '/app') {
  const next = String(value || '')
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  if (next.startsWith('/api/')) return fallback
  return next
}
