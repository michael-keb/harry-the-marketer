// Replies that arrived in a connected mailbox and matched no lead.
//
// The rule this list exists to keep: a reply is never silently dropped. A human
// either attaches it to a lead — where it joins the thread and may advance the
// playbook — or dismisses it, and either way who did it stays on the record.
// Dismissing hides; it never deletes, and it never touches the mailbox.

import { useEffect, useState } from 'react'
import { api, qs } from '../api.js'
import { LoadMore, usePagedList, Confirm } from '../parity-ui.jsx'
import { EmptyState, Modal, timeAgo, useToast } from '../ui.jsx'
import { Banner, FieldError, Marker, SkeletonRows, absolute } from './common.jsx'

const STATUSES = [['new', 'Needs a decision'], ['attached', 'Attached'], ['dismissed', 'Dismissed'], ['all', 'All']]

export default function Unmatched({ refs, announce }) {
  const [status, setStatus] = useState('new')
  const [from, setFrom] = useState('')
  const [subject, setSubject] = useState('')
  const list = usePagedList('/api/inbox/unmatched', { status, from, subject, limit: 25 })
  const [attaching, setAttaching] = useState(null)
  const [dismissing, setDismissing] = useState(null)

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">
        These replies reached a connected mailbox but matched no lead in any campaign. Nothing here has been thrown
        away — attach it to a lead, or dismiss it once you have read it.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">
          Status
          <select className="input mt-1 !w-auto !py-1.5" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-600">
          From
          <input className="input mt-1 !w-48 !py-1.5" value={from} placeholder="sender address" onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs text-slate-600">
          Subject
          <input className="input mt-1 !w-48 !py-1.5" value={subject} placeholder="subject contains" onChange={(e) => setSubject(e.target.value)} />
        </label>
      </div>

      {list.error && <Banner error={list.error} onRetry={list.reload} />}
      {list.loading && list.items.length === 0 && <SkeletonRows rows={4} label="Loading unmatched replies…" />}

      {!list.loading && !list.error && list.items.length === 0 && (
        <EmptyState
          icon="mail"
          title={status === 'new' ? 'Nothing unmatched — every reply found its campaign.' : 'Nothing here'}
          hint={status === 'new'
            ? 'When a reply arrives that Harry cannot match to a lead, it waits here instead of disappearing.'
            : 'No replies with that status match these filters.'}
        />
      )}

      {list.items.length > 0 && (
        <ul className="card divide-y divide-slate-200">
          {list.items.map((row) => (
            <UnmatchedRow
              key={row.id}
              row={row}
              status={status}
              refs={refs}
              onAttach={() => setAttaching(row)}
              onDismiss={() => setDismissing(row)}
            />
          ))}
        </ul>
      )}

      <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />

      {attaching && (
        <AttachDialog
          row={attaching}
          refs={refs}
          onClose={() => setAttaching(null)}
          onDone={() => { setAttaching(null); announce?.('Reply attached to a lead'); list.reload() }}
        />
      )}
      {dismissing && (
        <Confirm
          title="Dismiss this reply?"
          body={`The reply from ${dismissing.from_email} disappears from this list and will not come back on the next mailbox sync. Nothing is deleted: the record stays, and the message in the mailbox itself is untouched.`}
          confirmLabel="Dismiss"
          onClose={() => setDismissing(null)}
          onConfirm={async () => {
            await api.post(`/api/inbox/unmatched/${dismissing.id}/dismiss`)
            setDismissing(null)
            announce?.('Reply dismissed')
            list.reload()
          }}
        />
      )}
    </div>
  )
}

function UnmatchedRow({ row, status, onAttach, onDismiss }) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState(row.body || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // The list travels without bodies so a page of fifty is cheap; opening one row
  // asks for that row's body and nothing else.
  const expand = async () => {
    const next = !open
    setOpen(next)
    if (!next || body) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`/api/inbox/unmatched${qs({ status, withBody: 1, cursor: row.id + 1, limit: 1 })}`)
      setBody(res.items?.[0]?.body || '(This reply had no text.)')
    } catch (err) { setError(err) } finally { setLoading(false) }
  }

  return (
    <li className="px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-start gap-2">
        <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" aria-expanded={open} onClick={expand}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-ink-900">{row.from_email}</span>
            <span className="ml-auto shrink-0 text-xs text-slate-500" title={absolute(row.received_at)}>
              {timeAgo(row.received_at)}
              <span className="sr-only"> — {absolute(row.received_at)}</span>
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm text-slate-700">{row.subject || '(no subject)'}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Marker>{row.status === 'new' ? 'Needs a decision' : row.status === 'attached' ? 'Attached to a lead' : 'Dismissed'}</Marker>
            {/* The reason a row is out of the queue is on the row, not hidden in a log. */}
            {row.status !== 'new' && row.resolved_by && <span className="text-[11px] text-slate-500">by {row.resolved_by}</span>}
            {row.status === 'attached' && row.attached_lead_id && <span className="text-[11px] text-slate-500">lead #{row.attached_lead_id}</span>}
            {row.thread_id && <span className="text-[11px] text-slate-400">thread {row.thread_id}</span>}
          </div>
        </button>

        {row.status === 'new' && (
          <div className="flex shrink-0 gap-2">
            <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" onClick={onAttach}>Attach to a lead</button>
            <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" onClick={onDismiss}>Dismiss</button>
          </div>
        )}
      </div>

      {open && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3 text-[13px] text-slate-700">
          {loading && <span className="text-slate-500">Loading the message…</span>}
          {error && <Banner error={error} />}
          {!loading && !error && <div className="whitespace-pre-wrap">{body}</div>}
        </div>
      )}
    </li>
  )
}

function AttachDialog({ row, refs, onClose, onDone }) {
  const toast = useToast()
  const [query, setQuery] = useState(row.from_email || '')
  const [leads, setLeads] = useState(null)
  const [leadId, setLeadId] = useState('')
  const [campaignId, setCampaignId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [searchError, setSearchError] = useState(null)

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      api.get(`/api/leads${qs({ q: query })}`)
        .then((rows) => { if (live) { setLeads(rows.slice(0, 50)); setSearchError(null) } })
        .catch((err) => { if (live) setSearchError(err) })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [query])

  const attach = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/inbox/unmatched/${row.id}/attach`, {
        leadId: Number(leadId),
        campaignId: campaignId ? Number(campaignId) : undefined,
      })
      toast('Reply attached')
      onDone()
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Modal title="Attach this reply to a lead" onClose={onClose} wide>
      <form onSubmit={attach} className="space-y-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3 text-[13px]">
          <div className="text-slate-500">From {row.from_email}</div>
          <div className="text-ink-900">{row.subject || '(no subject)'}</div>
        </div>

        <p className="text-xs text-slate-600">
          Attaching files the reply onto that lead's conversation. It joins the thread and may advance the playbook —
          the classifier reads it on the next tick exactly as it would a reply that matched on its own.
        </p>

        <div>
          <label className="block text-xs text-slate-600" htmlFor="attach-search">Find a lead</label>
          <input id="attach-search" className="input mt-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, email or company" />
        </div>

        {searchError && <Banner error={searchError} />}
        <div>
          <label className="block text-xs text-slate-600" htmlFor="attach-lead">Lead</label>
          <select id="attach-lead" className="input mt-1" size={6} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            {(leads || []).map((lead) => (
              <option key={lead.id} value={lead.id}>
                {[lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email} — {lead.email}
                {lead.company ? ` · ${lead.company}` : ''}
              </option>
            ))}
          </select>
          {leads?.length === 0 && <p className="mt-1 text-[11px] text-slate-500">No leads match that search. This reply may be from someone who was never imported.</p>}
          <FieldError error={error} field="leadId" />
        </div>

        <div>
          <label className="block text-xs text-slate-600" htmlFor="attach-campaign">Campaign (optional)</label>
          <select id="attach-campaign" className="input mt-1" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Leave it outside any campaign</option>
            {refs.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <p className="mt-1 text-[11px] text-slate-500">
            Naming a campaign pairs the lead with it if they are not in it already. It never creates a campaign.
          </p>
          <FieldError error={error} field="campaignId" />
        </div>

        <Banner error={error} handled={['leadId', 'campaignId']} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !leadId}>{busy ? 'Attaching…' : 'Attach reply'}</button>
        </div>
      </form>
    </Modal>
  )
}
