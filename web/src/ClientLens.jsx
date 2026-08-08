// The client lens.
//
// `client_id` sits on campaigns, leads and mailboxes, so a client is a real
// partition of the workspace's data — not a preference. Putting the switch in
// Settings, where the backlog's "no new navigation item" rule first pushed it,
// made it read like a setting you configure once. It is not: it is the answer
// to "whose work am I looking at", which changes several times an hour in an
// agency and applies to every page at once.
//
// So it lives in the shell, beside the workspace identity, and the chosen
// client rides along as `?clientId=` on the list routes that understand it
// (campaigns, leads, mailbox fleet). It is still not a navigation item.
//
// Two rules make it safe to trust:
//   1. When a client is selected the shell says so loudly and continuously. A
//      filter you cannot see is how someone concludes their leads have vanished.
//   2. Surfaces that are workspace-wide say they are workspace-wide rather than
//      silently ignoring the lens. Honest beats consistent here.

import { useCallback, useEffect, useState } from 'react'
import { api, qs } from './api.js'
import { rowsOf } from './parity-ui.jsx'

const STORAGE_KEY = 'harry.clientLens'

// Read once at module load: the lens must be applied by the first request a
// page makes, not after a re-render, or every page would flash unscoped data.
function stored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

let current = stored()
const listeners = new Set()

export function activeClient() {
  return current
}

// The single place anything asks "what should I append to my query?". Pages
// call this rather than reaching for the client themselves, so turning the lens
// off is one change here rather than a hunt through every page.
export function lensQuery(extra = {}) {
  return qs({ ...extra, clientId: current?.id || undefined })
}

// api.js reads the active client from here to append `?clientId=` to the routes
// that understand it. It is published on globalThis rather than imported so
// that api.js — which is deliberately plain, no React — does not gain a
// dependency on this module just to know one number.
function publish() {
  globalThis.__harryClientLensId = current?.id || null
}
publish()

export function setActiveClient(client) {
  current = client || null
  try {
    if (current) localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* private browsing — the lens just will not persist */ }
  publish()
  for (const fn of listeners) fn(current)
}

export function useClientLens() {
  const [client, setClient] = useState(current)
  useEffect(() => {
    listeners.add(setClient)
    return () => { listeners.delete(setClient) }
  }, [])
  return { client, setActiveClient }
}

// ---------------------------------------------------------------- switcher --

export default function ClientLens() {
  const { client } = useClientLens()
  const [clients, setClients] = useState(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setError(null)
    api.get(`/api/clients${qs({ status: 'active', limit: 100 })}`)
      .then((r) => setClients(rowsOf(r)))
      .catch(setError)
  }, [])

  useEffect(() => { load() }, [load])

  // A workspace running a single brand has no clients and should never see a
  // control for a distinction it does not make.
  if (!error && clients && clients.length === 0 && !client) return null

  const label = client ? client.name : 'All clients'

  return (
    <div className="relative px-5 pb-3">
      <button
        type="button"
        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs cursor-pointer transition-colors ${
          client
            ? 'border-accent-500 bg-accent-500/15 text-accent-300'
            : 'border-ink-800 text-slate-400 hover:border-ink-700 hover:text-slate-100'
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={client ? `Showing ${client.name} only` : 'Showing every client in this workspace'}
      >
        <span className="truncate">
          <span className="text-slate-400">Viewing: </span>
          {label}
        </span>
        <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Said out loud, continuously — a filter you cannot see is how someone
          concludes their leads have disappeared. */}
      {client && (
        <p className="mt-1 text-[11px] leading-snug text-accent-300">
          Campaigns, leads and mailboxes are filtered to this client. Reports and
          Monitoring stay workspace-wide.
        </p>
      )}

      {open && (
        <div className="absolute inset-x-5 z-40 mt-1 max-h-64 overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 py-1 shadow-xl">
          {error && <p className="px-3 py-2 text-xs text-red-300">Could not load clients.</p>}
          {!clients && !error && <p className="px-3 py-2 text-xs text-slate-400">Loading…</p>}
          <ul role="listbox" aria-label="Client">
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!client}
                className="w-full px-3 py-1.5 text-left text-xs text-slate-200 hover:bg-ink-800 cursor-pointer"
                onClick={() => { setActiveClient(null); setOpen(false) }}
              >
                All clients
              </button>
            </li>
            {(clients || []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={client?.id === c.id}
                  className="w-full px-3 py-1.5 text-left text-xs text-slate-200 hover:bg-ink-800 cursor-pointer"
                  onClick={() => { setActiveClient({ id: c.id, name: c.name }); setOpen(false) }}
                >
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
