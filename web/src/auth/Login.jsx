import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { Spinner } from '../ui.jsx'
import AuthLayout from './AuthLayout.jsx'
import GoogleIcon from './GoogleIcon.jsx'
import { useAuthConfig, safeNext } from './useAuthConfig.js'

export default function Login({ onLoggedIn }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { config, configError } = useAuthConfig()

  const next = safeNext(params.get('next'))
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(params.get('error') || configError || '')

  if (!config && !configError) {
    return (
      <AuthLayout title="Sign in">
        <Spinner label="Checking how this workspace signs in…" />
      </AuthLayout>
    )
  }

  const devLogin = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await api.post('/api/auth/dev-login', { email, name, next })
      await onLoggedIn?.()
      navigate(safeNext(result?.redirect || next), { replace: true })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const auth0Href = `/api/auth/login?next=${encodeURIComponent(next)}`

  return (
    <AuthLayout
      title="Welcome back"
      lede="Sign in to your workspace — your campaigns have been ticking away without you."
      footer={
        <>
          No account yet?{' '}
          <Link to={`/signup${next !== '/app' ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="text-accent-700 hover:text-accent-600 font-medium">
            Start a free trial
          </Link>
        </>
      }
    >
      <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-4">
        {(error || configError) && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error || configError}
          </div>
        )}

        {config?.auth0 && (
          <a href={auth0Href} className="btn-primary w-full justify-center text-base py-2.5">
            <GoogleIcon />
            Continue with Google
          </a>
        )}

        {config?.auth0 && config?.devLogin && (
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <div className="h-px flex-1 bg-slate-200" /> or <div className="h-px flex-1 bg-slate-200" />
          </div>
        )}

        {config?.devLogin && (
          <form onSubmit={devLogin} className="space-y-4">
            <div>
              <label className="block text-xs text-slate-600 mb-1.5" htmlFor="login-email">Email</label>
              <input id="login-email" className="input" type="email" required autoComplete="email"
                placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1.5" htmlFor="login-name">Name (optional)</label>
              <input id="login-name" className="input" autoComplete="name" placeholder="Ada Lovelace"
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <button className="btn-primary w-full justify-center py-2.5" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            {!config?.auth0 && (
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Auth0 is not configured on this deployment, so the local development login is active. Set
                AUTH0_DOMAIN, AUTH0_CLIENT_ID, and AUTH0_CLIENT_SECRET to enable real sign-in.
              </p>
            )}
          </form>
        )}

        {config && !config.auth0 && !config.devLogin && (
          <p className="text-sm text-amber-700">
            No sign-in method is enabled on this deployment. Configure Auth0, or set DEV_LOGIN=1 for local
            development.
          </p>
        )}
      </div>

      <p className="mt-5 text-xs text-slate-500 leading-relaxed">
        By signing in you agree to the{' '}
        <a href="/terms" className="text-slate-600 hover:text-accent-700 underline underline-offset-2">Terms of Service</a>{' '}
        and{' '}
        <a href="/privacy" className="text-slate-600 hover:text-accent-700 underline underline-offset-2">Privacy Policy</a>.
      </p>
    </AuthLayout>
  )
}
