// Campaigns — the paged, filtered list.
//
// `GET /api/campaign-list` pages server-side: the source API returns every
// campaign and tells the client to slice it, and Docs/README.md rejects that
// ("Unbounded requests are rejected"). So this page never asks for everything —
// it asks for a page, says how many there are, and fetches the next one when
// you ask for it.
//
// A campaign is never created implicitly anywhere in Harry, so the only way one
// appears is the button on this page: `POST /api/campaigns/create`.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, qs } from '../api.js'
import { Spinner, EmptyState, ErrorState, Modal, PageHeader, useToast, timeAgo } from '../ui.jsx'
import { LiveRegion } from '../parity-ui.jsx'
import { Field, StateChip, messageOf, errorFor, nfmt, pct } from '../campaigns/shared.jsx'

const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'draft', label: 'Draft' },
  { value: 'running', label: 'Running' },
  { value: 'paused', label: 'Paused' },
  { value: 'archived', label: 'Archived' },
]

const PAGE = 24

export default function Campaigns() {
  const toast = useToast()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const status = params.get('status') || ''
  const parentCampaignId = params.get('parentCampaignId') || ''
  const includeArchived = params.get('includeArchived') === '1'
  const urlQuery = params.get('q') || ''

  // The box is local so typing is instant; the request is debounced.
  const [queryText, setQueryText] = useState(urlQuery)
  const [q, setQ] = useState(urlQuery)
  useEffect(() => {
    const timer = setTimeout(() => setQ(queryText.trim()), 300)
    return () => clearTimeout(timer)
  }, [queryText])

  const [rows, setRows] = useState(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)

  const filters = useMemo(
    () => ({ status, q, includeArchived: includeArchived ? 1 : undefined, parentCampaignId: parentCampaignId || undefined }),
    [status, q, includeArchived, parentCampaignId]
  )

  const fetchPage = useCallback(async (offset) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`/api/campaign-list${qs({ ...filters, limit: PAGE, offset })}`)
      setRows((prev) => (offset ? [...(prev || []), ...res.campaigns] : res.campaigns))
      setTotal(res.total || 0)
    } catch (err) {
      setError(err)
      if (!offset) setRows(null)
    } finally { setLoading(false) }
  }, [filters])

  useEffect(() => { fetchPage(0) }, [fetchPage])

  const setParam = (key, value) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    if (value) next.set(key, value); else next.delete(key)
    return next
  }, { replace: true })

  return (
    <div className="space-y-5">
      <PageHeader
        title="Campaigns"
        lead="Every playbook you are running, and how each one is doing."
        actions={<button className="btn-primary" onClick={() => setCreating(true)}>New campaign</button>}
      />

      <div className="card flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-48 flex-1">
          <label className="block text-xs text-slate-600" htmlFor="campaign-search">Search by name</label>
          <input
            id="campaign-search"
            className="input mt-1"
            type="search"
            placeholder="Q3 outbound…"
            value={queryText}
            onChange={(e) => { setQueryText(e.target.value); setParam('q', e.target.value.trim()) }}
          />
        </div>
        <div>
          <label className="block text-xs text-slate-600" htmlFor="campaign-status">Status</label>
          <select
            id="campaign-status"
            className="input mt-1 w-auto"
            value={status}
            onChange={(e) => setParam('status', e.target.value)}
          >
            {STATUSES.map((s) => <option key={s.value || 'any'} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <label className="flex cursor-pointer items-center gap-2 py-2 text-sm text-slate-600">
          <input
            type="checkbox"
            className="accent-accent-500"
            checked={includeArchived}
            disabled={Boolean(status)}
            onChange={(e) => setParam('includeArchived', e.target.checked ? '1' : '')}
          />
          Include archived
        </label>
        {parentCampaignId && (
          <button
            className="btn-ghost cursor-pointer py-1.5"
            onClick={() => setParam('parentCampaignId', '')}
          >
            Clear subsequence filter
          </button>
        )}
      </div>

      {parentCampaignId && (
        <p className="text-sm text-slate-600">
          Showing subsequences of{' '}
          <Link className="text-accent-700 hover:underline" to={`/app/campaigns/${parentCampaignId}`}>
            campaign #{parentCampaignId}
          </Link>.
        </p>
      )}

      <LiveRegion message={rows ? `${total} campaign${total === 1 ? ' matches' : 's match'} your filters` : ''} />

      {error && !rows ? (
        <ErrorState error={error} onRetry={() => fetchPage(0)} />
      ) : rows === null ? (
        <Spinner label="Loading campaigns…" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="campaigns"
          title={status || q || parentCampaignId ? 'No campaigns match those filters' : 'No campaigns yet'}
          hint={
            status || q || parentCampaignId
              ? 'Clear the search or pick another status. Archived campaigns are hidden unless you ask for them.'
              : "A campaign is a Mermaid diagram: Send nodes, reply branches, timeouts, and Won/Lost endings. The AI agent walks every lead through it."
          }
          action={
            status || q || parentCampaignId
              ? <button className="btn-ghost cursor-pointer" onClick={() => setParams({}, { replace: true })}>Clear filters</button>
              : <button className="btn-primary cursor-pointer" onClick={() => setCreating(true)}>Create your first campaign</button>
          }
        />
      ) : (
        <>
          <p className="text-xs text-slate-500">
            Showing {nfmt(rows.length)} of {nfmt(total)}
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((c) => <li key={c.id} className="min-w-0"><CampaignCard campaign={c} /></li>)}
          </ul>
          {error && (
            <p className="text-sm text-red-700" role="alert">{messageOf(error)}</p>
          )}
          {rows.length < total && (
            <div className="flex justify-center py-2">
              <button className="btn-ghost cursor-pointer" disabled={loading} onClick={() => fetchPage(rows.length)}>
                {loading ? 'Loading…' : `Load more (${nfmt(total - rows.length)} left)`}
              </button>
            </div>
          )}
        </>
      )}

      {creating && (
        <CreateCampaignModal
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            toast(c.deduplicated ? 'That campaign already exists — opening it' : 'Campaign created — draw your playbook')
            navigate(`/app/campaigns/${c.id}`)
          }}
        />
      )}
    </div>
  )
}

function CampaignCard({ campaign: c }) {
  const t = c.totals || {}
  const counts = c.counts || {}
  return (
    <Link
      to={`/app/campaigns/${c.id}`}
      className="card block h-full p-4 transition-colors hover:border-accent-500"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 truncate text-base font-semibold text-ink-900">{c.name}</h2>
        <StateChip state={c.state} />
      </div>
      {c.parentCampaignId && (
        <div className="mt-1 text-[11px] text-slate-500">Subsequence of campaign #{c.parentCampaignId}</div>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        {[
          ['Leads', nfmt(counts.total)],
          ['Sent', nfmt(t.sent)],
          ['Replies', nfmt(t.repliedLeads)],
          ['Won', nfmt(t.won)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-slate-50 px-2 py-2.5">
            <dt className="text-[11.5px] font-medium text-slate-500">{label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-ink-900">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        {counts.needsAttention > 0 && (
          <span className="text-red-600">{nfmt(counts.needsAttention)} need attention</span>
        )}
        {t.sent > 0 && <span>Reply rate {pct(t.repliedLeads, t.sent)}</span>}
        <span>Updated {timeAgo(c.updatedAt)}</span>
      </div>
    </Link>
  )
}

function CreateCampaignModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      onCreated(await api.post('/api/campaigns/create', { name: name.trim() }))
    } catch (error) {
      setErr(error)
      setBusy(false)
    }
  }

  return (
    <Modal title="New campaign" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Campaign name" htmlFor="new-campaign-name" error={errorFor(err, 'name')}>
          <input
            id="new-campaign-name"
            className="input"
            autoFocus
            required
            placeholder="Q3 outbound — ops leaders"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <p className="text-xs text-slate-500">
          It starts as a draft with an empty playbook. Nothing sends until you draw the diagram, attach a
          mailbox and some leads, and start it yourself.
        </p>
        {err && !errorFor(err, 'name') && <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary cursor-pointer" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  )
}
