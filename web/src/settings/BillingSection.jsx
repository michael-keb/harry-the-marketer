// Plan + Stripe checkout — Harry never takes a card; Stripe's hosted page does.
//
// Subscribe opens a Payment Link (single Stripe checkout page, promo codes on).
// Manage opens the Customer Portal after the first successful checkout.

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { useToast, Badge } from '../ui.jsx'
import { Spinner, ErrorState } from '../parity-ui.jsx'
import { StatusPill } from './common.jsx'

const PROMO_CODES = [
  { code: 'Squadinstitlute', label: '10% off' },
  { code: 'BISM1', label: '100% off' },
  { code: 'HARRYFREE', label: '100% off (general)' },
]

export default function BillingSection({ user }) {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [config, setConfig] = useState(null)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(() => {
    setError(null)
    Promise.all([
      api.get('/api/billing/config'),
      api.get('/api/billing/status'),
    ])
      .then(([cfg, st]) => {
        setConfig(cfg)
        setStatus(st)
      })
      .catch(setError)
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (params.get('billing') !== 'success') return
    toast('Payment received — refreshing your plan…')
    load()
    const next = new URLSearchParams(params)
    next.delete('billing')
    next.delete('plan')
    setParams(next, { replace: true })
  }, [params, setParams, load, toast])

  const checkout = async (planId) => {
    setBusy(planId)
    try {
      const { url } = await api.post('/api/billing/checkout', { plan: planId })
      window.location.href = url
    } catch (err) {
      toast(err.message || 'Could not open checkout', 'error')
      setBusy(null)
    }
  }

  const openPortal = async () => {
    setBusy('portal')
    try {
      const { url } = await api.post('/api/billing/portal', {})
      window.location.href = url
    } catch (err) {
      toast(err.message || 'Could not open billing portal', 'error')
      setBusy(null)
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!config || !status) return <Spinner label="Loading billing…" />

  const planLabel = status.planId
    ? status.planId.charAt(0).toUpperCase() + status.planId.slice(1)
    : 'No plan yet'
  const statusTone =
    status.status === 'active' ? 'good'
      : status.status === 'canceled' ? 'bad'
        : 'neutral'

  return (
    <section className="card space-y-5 p-5">
      <div>
        <h2 className="font-semibold text-ink-900">Billing</h2>
        <p className="mt-1 text-sm text-slate-600">
          Subscribe on Stripe’s hosted checkout — Harry never sees your card.
          Promo codes at checkout:
        </p>
        <ul className="mt-2 space-y-1 text-sm text-slate-600">
          {PROMO_CODES.map(({ code, label }) => (
            <li key={code}>
              <span className="font-mono text-ink-900">{code}</span>
              <span className="text-slate-500"> — {label}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-600">Signed in as</span>
        <span className="text-sm text-ink-900">{user.email}</span>
        <StatusPill tone={statusTone}>{status.status || 'trial'}</StatusPill>
        {status.planId && <Badge value={planLabel} />}
        {!config.configured && (
          <StatusPill tone="neutral">Stripe not configured</StatusPill>
        )}
        {config.configured && !config.live && (
          <StatusPill tone="neutral">Test mode</StatusPill>
        )}
      </div>

      {config.configured ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {config.plans
            .filter((p) => p.monthly != null)
            .map((plan) => {
              const current = status.planId === plan.id && status.status === 'active'
              return (
                <li key={plan.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-medium text-ink-900">{plan.name}</h3>
                    <p className="text-sm text-slate-600">
                      ${plan.monthly}<span className="text-xs">/mo</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary mt-3 w-full"
                    disabled={!plan.checkout || busy != null || current}
                    onClick={() => checkout(plan.id)}
                  >
                    {busy === plan.id
                      ? 'Opening Stripe…'
                      : current
                        ? 'Current plan'
                        : `Subscribe to ${plan.name}`}
                  </button>
                </li>
              )
            })}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">
          Stripe env vars are not set on this server, so checkout stays disabled.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
        <button
          type="button"
          className="btn"
          disabled={!status.stripeCustomerId || busy != null}
          onClick={openPortal}
        >
          {busy === 'portal' ? 'Opening portal…' : 'Manage subscription on Stripe'}
        </button>
        <p className="text-xs text-slate-500">
          Update card, download invoices, or cancel — Stripe’s customer portal.
          {!status.stripeCustomerId && ' Available after your first checkout.'}
        </p>
      </div>
    </section>
  )
}
