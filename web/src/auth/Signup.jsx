import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { Spinner } from '../ui.jsx'
import { PLANS } from '../../../shared/site-content.js'
import AuthLayout from './AuthLayout.jsx'
import GoogleIcon from './GoogleIcon.jsx'
import { useAuthConfig, safeNext } from './useAuthConfig.js'

const ASIDE = {
  title: 'What you get immediately',
  points: [
    'A working default playbook — you are not starting at a blank canvas.',
    'A sandbox mailbox: run a whole campaign, simulate replies, connect nothing.',
    'The full editor with live diagram rendering and server-side validation.',
    'Reply classification routing leads down the branches you drew.',
    'One-click unsubscribe and conservative send limits on by default.',
  ],
  footnote:
    'No card required, and nothing sends until you say so. Connect Gmail whenever you are ready — or never, if the sandbox is all you need.',
}

export default function Signup({ onLoggedIn }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { config, configError } = useAuthConfig()

  const next = safeNext(params.get('next'))
  const requestedPlan = PLANS.find((p) => p.id === params.get('plan'))

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(params.get('error') || '')

  if (!config && !configError) {
    return (
      <AuthLayout title="Create your account" aside={ASIDE}>
        <Spinner label="Checking how this workspace signs up…" />
      </AuthLayout>
    )
  }

  const devSignup = async (e) => {
    e.preventDefault()
    if (!accepted) {
      setError('Please accept the Terms of Service and Privacy Policy to continue')
      return
    }
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

  // screen_hint=signup lands the visitor on Auth0's signup tab rather than its
  // login tab — otherwise "Create account" and "Sign in" go to the same screen.
  const auth0Href = `/api/auth/login?screen_hint=signup&next=${encodeURIComponent(next)}`

  return (
    <AuthLayout
      title="Create your account"
      lede={
        requestedPlan && requestedPlan.monthly
          ? `Starting your ${requestedPlan.name} trial. You will not be charged today — set up your workspace first and add billing when you are ready.`
          : 'Your trial starts now. A sandbox mailbox and a campaign you can run end to end today, before any card.'
      }
      aside={ASIDE}
      footer={
        <>
          Already have an account?{' '}
          <Link to={`/login${next !== '/app' ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="text-accent-700 hover:text-accent-600 font-medium">
            Sign in
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
          <>
            <a href={auth0Href} className="btn-primary w-full justify-center text-base py-2.5">
              <GoogleIcon />
              Sign up with Google
            </a>
            <p className="text-[11px] text-slate-500 text-center">
              By continuing you agree to the{' '}
              <a href="/terms" className="text-slate-600 hover:text-accent-700 underline underline-offset-2">Terms</a> and{' '}
              <a href="/privacy" className="text-slate-600 hover:text-accent-700 underline underline-offset-2">Privacy Policy</a>.
            </p>
          </>
        )}

        {config?.auth0 && config?.devLogin && (
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <div className="h-px flex-1 bg-slate-200" /> or <div className="h-px flex-1 bg-slate-200" />
          </div>
        )}

        {config?.devLogin && (
          <form onSubmit={devSignup} className="space-y-4">
            <div>
              <label className="block text-xs text-slate-600 mb-1.5" htmlFor="signup-email">Work email</label>
              <input id="signup-email" className="input" type="email" required autoComplete="email"
                placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1.5" htmlFor="signup-name">Your name (optional)</label>
              <input id="signup-name" className="input" autoComplete="name" placeholder="Ada Lovelace"
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <label className="flex items-start gap-2.5 text-xs text-slate-600 leading-relaxed cursor-pointer">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 rounded border-slate-300 bg-white accent-accent-500 cursor-pointer" />
              <span>
                I agree to the{' '}
                <a href="/terms" className="text-accent-700 hover:text-accent-600 underline underline-offset-2">Terms of Service</a>,{' '}
                <a href="/privacy" className="text-accent-700 hover:text-accent-600 underline underline-offset-2">Privacy Policy</a>, and{' '}
                <a href="/acceptable-use" className="text-accent-700 hover:text-accent-600 underline underline-offset-2">Acceptable Use Policy</a> —
                including that I am responsible for having a lawful basis to contact the people I upload.
              </span>
            </label>

            <button className="btn-primary w-full justify-center py-2.5" disabled={busy}>
              {busy ? 'Creating your workspace…' : 'Create account'}
            </button>

            {!config?.auth0 && (
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Auth0 is not configured on this deployment, so accounts are created with the local development
                login. Configure Auth0 before inviting anyone real.
              </p>
            )}
          </form>
        )}

        {config && !config.auth0 && !config.devLogin && (
          <p className="text-sm text-amber-700">
            Signup is unavailable: no authentication method is configured on this deployment.
          </p>
        )}
      </div>

      {/* The reassurance panel is hidden on small screens — this is its stand-in. */}
      <ul className="mt-6 space-y-2 lg:hidden">
        {ASIDE.points.slice(0, 3).map((p) => (
          <li key={p} className="text-xs text-slate-500 leading-relaxed">· {p}</li>
        ))}
      </ul>
    </AuthLayout>
  )
}
