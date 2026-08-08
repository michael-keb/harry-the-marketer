// Optional providers — `GET /api/integrations/status`.
//
// Three categories of the backlog cannot work from Harry's own data: inbox
// placement testing, prospect discovery, and buying sending infrastructure.
// Each is env-gated in server/parity/providers.js, and each surface that
// depends on one still renders, still validates, and still shows whatever Harry
// stores itself — it just says honestly that nothing is connected.
//
// This section is that statement in one place, so the answer to "why is this
// page empty?" is one scroll away rather than a support ticket. The banner
// itself is `NotConnected` from the shared kit, which is what those surfaces
// use, so the same fact looks the same everywhere.

import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { NotConnected, Spinner, ErrorState } from '../parity-ui.jsx'
import { StatusPill } from './common.jsx'

const PROVIDERS = [
  {
    key: 'deliverability',
    what: 'Inbox placement testing',
    where: 'Monitoring — spam-filter, SPF, DKIM and blacklist reports for a seed send.',
  },
  {
    key: 'prospects',
    what: 'Prospect discovery',
    where: 'Leads — searching for contacts by company, title, industry and location, and finding their addresses.',
  },
  {
    key: 'senders',
    what: 'Sending infrastructure',
    where: 'Mailboxes — buying domains and auto-generating mailboxes on them.',
  },
]

export default function IntegrationsSection() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setError(null)
    api.get('/api/integrations/status').then(setStatus).catch(setError)
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="font-semibold text-ink-900">Optional providers</h2>
        <p className="mt-1 text-sm text-slate-600">
          Three parts of Harry reach outside your own data. None of them is required, and nothing here is faked —
          with no credentials set, those pages still work and still show what Harry has stored; they simply say so
          rather than inventing numbers.
        </p>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !status ? (
        <Spinner label="Checking providers…" />
      ) : (
        <ul className="space-y-4">
          {PROVIDERS.map((provider) => {
            const state = status[provider.key]
            const envVars = state?.envVars || []
            return (
              <li key={provider.key}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium text-ink-900">{provider.what}</h3>
                  <StatusPill tone={state?.configured ? 'good' : 'neutral'}>
                    {state?.configured ? 'Connected' : 'Not connected'}
                  </StatusPill>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">{provider.where}</p>

                {state?.configured ? (
                  <p className="mt-1.5 text-xs text-slate-500">
                    Configured from {envVars.join(' and ')}.
                  </p>
                ) : (
                  <div className="mt-2">
                    <NotConnected status={state} what={provider.what} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        Set these in the server’s environment (a <code className="font-mono">.env</code> file in development) and
        restart it. Harry never asks for a provider key in the browser, and never stores one in the workspace.
      </p>
    </section>
  )
}
