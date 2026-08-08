// Sending infrastructure: suppliers, domains you own, and the orders that
// bought them.
//
// The whole section is gated on a commercial arrangement Harry may not have.
// When it does not, nothing here is faked: the panel says which environment
// variables are missing and everything Harry stores itself still renders.

import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { ErrorState, NotConnected } from '../parity-ui.jsx'
import Orders from './Orders.jsx'
import SenderFlow from './SenderFlow.jsx'
import { Section, Skeleton, plural } from './common.jsx'

const ENV_VARS = ['SENDERS_API_URL', 'SENDERS_API_KEY']

export default function Senders({ seedDomain, onConnect }) {
  const [vendors, setVendors] = useState(null)
  const [domains, setDomains] = useState(null)
  const [error, setError] = useState(null)
  const [flowOpen, setFlowOpen] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [v, d] = await Promise.all([
        api.get('/api/senders/vendors'),
        api.get('/api/senders/domains'),
      ])
      setVendors(v)
      setDomains(d)
    } catch (err) {
      setError(err)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!vendors || !domains) return <Skeleton rows={3} className="h-20" />

  const configured = Boolean(vendors.configured)
  const domainRows = domains.data || []

  return (
    <div className="space-y-4">
      <NotConnected status={{ configured, envVars: ENV_VARS }} what="The sending-infrastructure supplier" />

      <Section
        id="senders-buy"
        title="Get more mailboxes"
        hint="Buy a lookalike domain and mailboxes on it from a supplier. Harry never handles the payment — you pay at the supplier's own checkout — and it keeps only the order reference."
        action={configured && !flowOpen && (
          <button className="btn-primary cursor-pointer" onClick={() => setFlowOpen(true)}>
            Start
          </button>
        )}
      >
        {!configured ? (
          <p className="text-xs text-slate-600">
            Buying is unavailable until a marketplace provider is connected. Connecting Gmail and adding
            sandbox mailboxes are unaffected.
          </p>
        ) : !flowOpen ? (
          <p className="text-xs text-slate-600">
            {(vendors.data || []).length
              ? `${plural(vendors.data.length, 'supplier')} available${vendors.live ? '' : ' (from Harry’s last copy — the supplier did not answer just now)'}.`
              : 'No supplier is available for this workspace. That is usually regional.'}
          </p>
        ) : null}

        {configured && flowOpen && (
          <div className="mt-3">
            <SenderFlow
              vendors={vendors.data || []}
              billingOnFile={Boolean(vendors.billing_on_file)}
              billingStorageAvailable={Boolean(vendors.billing_storage_available)}
              seedDomain={seedDomain}
              onClose={() => setFlowOpen(false)}
              onPlaced={() => load()}
            />
          </div>
        )}
      </Section>

      {/* domain-list.md: absent without marketplace access and at least one
          domain, rather than shown empty. */}
      {configured && domainRows.length > 0 && (
        <Section
          id="senders-domains"
          title="Purchased domains"
          hint={domains.stale
            ? `The supplier did not answer, so this is Harry's stored copy${domains.as_of ? ` as of ${domains.as_of}` : ''}.`
            : 'Domains this workspace owns, with the mailboxes running on each.'}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-xs">
              <caption className="sr-only">Domains purchased through a sending-infrastructure supplier</caption>
              <thead className="text-slate-500">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">Domain</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Mailboxes here</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Status</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Expires</th>
                  <th scope="col" className="py-1 font-medium"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {domainRows.map((d) => (
                  <tr key={d.domain} className="border-t border-slate-200">
                    <th scope="row" className="py-2 pr-3 font-normal text-ink-900">{d.domain}</th>
                    <td className="py-2 pr-3">
                      {d.mailbox_count}
                      {d.unused && <span className="ml-2 text-amber-700">not used yet</span>}
                    </td>
                    <td className="py-2 pr-3">{d.status || 'purchased'}{d.expired ? ' · expired' : ''}</td>
                    <td className="py-2 pr-3">{d.expires_at || '—'}</td>
                    <td className="py-2">
                      <button
                        className="btn-ghost px-2 py-1 text-xs cursor-pointer"
                        onClick={() => onConnect?.(d.domain)}
                        aria-label={`Connect a mailbox on ${d.domain}`}
                      >
                        Connect a mailbox
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Orders domains={domainRows} onConnect={onConnect} />
    </div>
  )
}
