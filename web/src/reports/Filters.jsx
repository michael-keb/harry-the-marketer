// The Reports page header controls: one date range, one campaign multi-select
// and — only when the workspace actually has clients — one client select.
//
// Every panel on the page reads the same three values, so changing a filter
// refetches each panel once rather than each panel owning its own control.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DateRange } from '../parity-ui.jsx'
import { useApi, FieldMessage, BROWSER_TZ } from './shared.jsx'

// --- feeds -------------------------------------------------------------------

// Docs/analytics/campaign-list.md — a picker feed, ids and names only.
export function useCampaignList() {
  const { data, error, loading } = useApi('/api/analytics/campaigns', { limit: 500 })
  return { campaigns: data?.items || [], error, loading }
}

// Docs/analytics/client-list.md — the control is absent, not greyed out, when
// the workspace has no clients.
export function useClientList() {
  const { data, error, loading } = useApi('/api/analytics/clients', { limit: 500 })
  return { clients: data?.items || [], error, loading }
}

// --- campaign multi-select ---------------------------------------------------

export function CampaignFilter({ campaigns, loading, error, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? campaigns.filter((c) => c.name.toLowerCase().includes(q)) : campaigns
  }, [campaigns, query])

  const label = loading
    ? 'Loading campaigns…'
    : selected.length === 0
      ? 'All campaigns'
      : `${selected.length} of ${campaigns.length} campaigns`

  const toggle = (id) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  return (
    <div className="relative w-full sm:w-auto" ref={wrapRef}>
      <span id={`${listId}-label`} className="block text-xs text-slate-600 mb-1">Campaigns</span>
      <button
        type="button"
        className="btn-ghost w-full sm:w-56 justify-between"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${listId}-label`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-xs">▾</span>
      </button>
      {error && <p className="mt-1 text-xs text-amber-700">Campaign list unavailable — showing all campaigns.</p>}
      {open && (
        <div className="absolute z-30 mt-1 w-full sm:w-72 rounded-lg border border-slate-300 bg-white p-2 shadow-xl">
          <input
            className="input mb-2"
            placeholder="Search campaigns…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search campaigns"
          />
          <div className="flex items-center justify-between px-1 pb-1.5 text-xs">
            <button type="button" className="cursor-pointer text-slate-600 hover:text-accent-700" onClick={() => onChange([])}>
              All campaigns
            </button>
            <span className="text-slate-500">{selected.length} selected</span>
          </div>
          <ul id={listId} role="listbox" aria-multiselectable="true" className="max-h-64 overflow-y-auto space-y-0.5">
            {shown.map((c) => {
              const on = selected.includes(c.id)
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(c.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 cursor-pointer"
                  >
                    <span className={`flex size-4 shrink-0 items-center justify-center rounded border text-[10px] ${on ? 'border-accent-500 bg-accent-500 text-ink-950' : 'border-slate-300'}`}>
                      {on ? '✓' : ''}
                    </span>
                    <span className="truncate">{c.name}</span>
                  </button>
                </li>
              )
            })}
            {!loading && campaigns.length === 0 && (
              <li className="px-2 py-3 text-sm text-slate-500">
                No campaigns yet. <Link to="/app/campaigns" className="text-accent-700 hover:underline">Create one</Link>.
              </li>
            )}
            {campaigns.length > 0 && shown.length === 0 && (
              <li className="px-2 py-3 text-sm text-slate-500">No campaigns match “{query}”.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

// --- client select -----------------------------------------------------------

export function ClientFilter({ clients, value, onChange }) {
  const id = useId()
  if (!clients.length) return null
  return (
    <div className="w-full sm:w-48">
      <label htmlFor={id} className="block text-xs text-slate-600 mb-1">Client</label>
      <select
        id={id}
        className="input cursor-pointer"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All clients</option>
        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
  )
}

// --- the whole header --------------------------------------------------------

export function ReportsFilters({
  range, onRange, campaigns, campaignsLoading, campaignsError,
  selectedCampaigns, onCampaigns, clients, client, onClient, dateError, busy,
}) {
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <DateRange value={range} onChange={onRange} />
          <FieldMessage error={dateError} />
          <p className="mt-1 text-[11px] text-slate-500">
            Times are bucketed in {BROWSER_TZ}, your browser’s timezone.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <ClientFilter clients={clients} value={client} onChange={onClient} />
          <CampaignFilter
            campaigns={campaigns}
            loading={campaignsLoading}
            error={campaignsError}
            selected={selectedCampaigns}
            onChange={onCampaigns}
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs text-transparent select-none" aria-hidden>.</span>
            <div className="flex gap-1">
              {[[7, '7d'], [30, '30d'], [90, '90d']].map(([days, label]) => (
                <button
                  key={days}
                  type="button"
                  className="btn-ghost px-2.5 py-1.5 text-xs"
                  onClick={() => onRange({
                    from: new Date(Date.now() - (days - 1) * 86400e3).toISOString().slice(0, 10),
                    to: new Date().toISOString().slice(0, 10),
                  })}
                >
                  Last {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {busy && <span className="text-xs text-slate-500">Refreshing…</span>}
      </div>
    </div>
  )
}
