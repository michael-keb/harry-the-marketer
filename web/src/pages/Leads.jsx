// The Leads page.
//
// Everything the SmartLead-parity backlog adds to prospects lands inside this
// one page rather than beside it: labels, notes, tasks, segments, the extended
// lead record and prospect search are all tabs, panels or rows on a surface
// that already existed. No new navigation item — the standing rule in
// Docs/README that survived 210 endpoints.
//
// The page owns three things and delegates the rest to web/src/leads/*:
//   * the table, its filters and its selection
//   * the conversation board (same derived stages, laid out as columns)
//   * the CSV import into the workspace (the segment importer is the same
//     component aimed at a list)
//   * which lead the detail drawer is showing

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, qs } from '../api.js'
import { Spinner, EmptyState, ErrorState, Modal, Badge, PageHeader, useToast } from '../ui.jsx'
import { BulkBar, Tabs, LiveRegion } from '../parity-ui.jsx'
import { ColumnMapper, LEAD_FIELDS, guessMapping, mapRows, parseCsv } from '../leads/csv.jsx'
import { BulkLabels } from '../leads/labels.jsx'
import { AddToSegment, PushToCampaign, SegmentsPanel } from '../leads/segments.jsx'
import { OpenTasks } from '../leads/tasks.jsx'
import FindEmails from '../leads/FindEmails.jsx'
import LeadDetail from '../leads/LeadDetail.jsx'
import ProspectSearch from '../leads/ProspectSearch.jsx'
import Board from '../leads/Board.jsx'
import { FieldError, FormError, fmt } from '../leads/shared.jsx'

// The progress tracker: the order a prospect moves through, so the strip above
// the table reads left to right the way the work actually goes.
const STAGE_ORDER = ['not contacted', 'contacted', 'replied', 'interested', 'agreed', 'won', 'lost', 'unsubscribed', 'bounced']
const TABS = ['people', 'board', 'tasks', 'prospects']

export default function Leads() {
  const toast = useToast()
  const [search, setSearch] = useSearchParams()
  const tab = TABS.includes(search.get('tab')) ? search.get('tab') : 'people'
  const setTab = (next) => {
    setSearch((prev) => {
      const params = new URLSearchParams(prev)
      if (!next || next === 'people') params.delete('tab')
      else params.set('tab', next)
      return params
    }, { replace: true })
  }
  const [leads, setLeads] = useState(null)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState('')
  const [segmentId, setSegmentId] = useState(null)
  const [selected, setSelected] = useState([])
  const [editing, setEditing] = useState(null)          // lead object or 'new'
  const [importState, setImportState] = useState(null)  // { fileName, headers, rows, mapping }
  const [importError, setImportError] = useState(null)
  const [viewingResearch, setViewingResearch] = useState(null)
  const [researchingId, setResearchingId] = useState(null)
  const [detailId, setDetailId] = useState(null)
  const [bulk, setBulk] = useState(null)                // 'labels' | 'segment' | 'push'
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)
  const [live, setLive] = useState('')
  const fileRef = useRef()

  const load = useCallback(async () => {
    setError(null)
    try { setLeads(await api.get('/api/leads')) } catch (err) { setError(err) }
  }, [])
  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const rows = leads || []
    const q = query.trim().toLowerCase()
    return rows.filter((l) => {
      const matches = !q || [l.email, l.first_name, l.last_name, l.company, l.title].join(' ').toLowerCase().includes(q)
      return matches && (!stage || l.stage === stage)
    })
  }, [leads, query, stage])

  const selectedLeads = useMemo(
    () => (leads || []).filter((l) => selected.includes(l.id)),
    [leads, selected],
  )

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!leads) return <Spinner label="Loading leads…" />

  const counts = leads.reduce((acc, l) => ({ ...acc, [l.stage]: (acc[l.stage] || 0) + 1 }), {})
  const stagesPresent = STAGE_ORDER.filter((s) => counts[s])
  const allShownTicked = filtered.length > 0 && filtered.every((l) => selected.includes(l.id))

  const toggleRow = (id, on) =>
    setSelected((list) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id)))

  const toggleAllShown = (on) =>
    setSelected((list) => (on
      ? [...new Set([...list, ...filtered.map((l) => l.id)])]
      : list.filter((id) => !filtered.some((l) => l.id === id))))

  const onFile = async (file) => {
    setImportError(null)
    const text = await file.text()
    const rows = parseCsv(text)
    if (rows.length < 2) return toast('That file needs a header row plus at least one data row', 'error')
    setImportState({
      fileName: file.name,
      headers: rows[0],
      rows: rows.slice(1),
      mapping: guessMapping(rows[0], LEAD_FIELDS),
    })
  }

  const runImport = async () => {
    if (importState.mapping.email === undefined) {
      setImportError({ payload: { field: 'email' }, message: 'Map the Email column first — it is the only required field.' })
      return
    }
    try {
      const result = await api.post('/api/leads/import', { rows: mapRows(importState.rows, importState.mapping) })
      toast(`Imported ${fmt(result.added)} lead${result.added === 1 ? '' : 's'} (${fmt(result.skipped)} skipped${result.errors?.length ? ` — e.g. ${result.errors[0]}` : ''})`)
      setImportState(null)
      load()
    } catch (err) { setImportError(err) }
  }

  // The export is fetched rather than navigated to, so a failure shows in the
  // page instead of arriving as a downloaded file containing an error.
  const exportCsv = async () => {
    setExporting(true)
    setExportError(null)
    setLive('Preparing your export…')
    try {
      const res = await fetch(`/api/leads/export${qs({ q: query.trim() || undefined, stage: stage || undefined })}`)
      if (!res.ok) {
        let payload = null
        try { payload = await res.json() } catch { /* non-JSON error body */ }
        throw new Error(payload?.message || payload?.error || `Export failed (${res.status})`)
      }
      const disposition = res.headers.get('Content-Disposition') || ''
      const named = /filename="([^"]+)"/.exec(disposition)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = named ? named[1] : `leads-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setLive(`Export downloaded as ${anchor.download}`)
    } catch (err) {
      setExportError(err)
      setLive(`Export failed — ${err.message}`)
    } finally { setExporting(false) }
  }

  return (
    <div className="space-y-4">
      <LiveRegion message={live} />

      <PageHeader title="Leads" lead={`${fmt(leads.length)} people the agent can write to.`} />

      <Tabs
        ariaLabel="Leads sections"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'people', label: 'People', count: leads.length },
          { id: 'board', label: 'Board' },
          { id: 'tasks', label: 'Tasks' },
          { id: 'prospects', label: 'Find prospects' },
        ]}
      />

      {tab === 'board' && <Board leads={leads} onOpenLead={setDetailId} />}
      {tab === 'tasks' && <OpenTasks onOpenLead={(id) => { setTab('people'); setDetailId(id) }} />}
      {tab === 'prospects' && <ProspectSearch onImported={() => load()} />}

      {tab === 'people' && (
        <div className="flex flex-col gap-4 md:flex-row">
          <SegmentsPanel selectedId={segmentId} onSelect={setSegmentId} onLeadsChanged={load} />

          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <label className="sr-only" htmlFor="lead-search">Search leads</label>
              <input
                id="lead-search"
                className="input w-full sm:w-56"
                placeholder="Search leads…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="button" className="btn-ghost" onClick={exportCsv} disabled={exporting}>
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => fileRef.current.click()}>Import CSV</button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = '' }}
              />
              <button type="button" className="btn-primary" onClick={() => setEditing('new')}>+ Add lead</button>
            </div>

            {exportError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {exportError.message} — nothing was downloaded.
              </div>
            )}

            <p className="text-xs text-slate-500">
              The CSV is the one-off, offline copy of what you are looking at now; the Google Sheet sync in Settings is
              the live one that keeps updating.
            </p>

            {/* Progress tracker: where everyone is, and a one-click filter to just them. */}
            {stagesPresent.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {stagesPresent.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={stage === s}
                    onClick={() => setStage(stage === s ? '' : s)}
                    className={`cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors ${
                      stage === s ? 'border-accent-500 bg-accent-500/10 text-accent-700' : 'border-slate-300 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {s} <span className="tabular-nums text-slate-500">{counts[s]}</span>
                  </button>
                ))}
              </div>
            )}

            {segmentId && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
                A segment is selected for its actions — import, push, move, label, rename, delete. The table below still
                shows every lead: Harry has no route that lists the people inside a segment, so filtering the table by one
                would be a guess.
              </p>
            )}

            {leads.length === 0 ? (
              <EmptyState
                title="No leads yet"
                hint="Add leads one by one or import a CSV — then attach them to a campaign and let the playbook run."
                action={(
                  <div className="flex gap-2">
                    <button type="button" className="btn-primary" onClick={() => setEditing('new')}>Add your first lead</button>
                    <button type="button" className="btn-ghost" onClick={() => fileRef.current.click()}>Import CSV</button>
                  </div>
                )}
              />
            ) : filtered.length === 0 ? (
              <EmptyState title="No matches" hint={query ? `Nothing matches "${query}".` : `Nobody is at "${stage}" right now.`} />
            ) : (
              <div className="card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th scope="col" className="px-3 py-3">
                        <label className="sr-only" htmlFor="select-all">Select every lead shown</label>
                        <input
                          id="select-all"
                          type="checkbox"
                          className="size-4 cursor-pointer accent-accent-500 p-1 -m-1 box-content"
                          checked={allShownTicked}
                          onChange={(e) => toggleAllShown(e.target.checked)}
                        />
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">Name</th>
                      <th scope="col" className="px-4 py-3 font-medium">Email</th>
                      <th scope="col" className="px-4 py-3 font-medium">Company</th>
                      <th scope="col" className="px-4 py-3 font-medium">Title</th>
                      <th scope="col" className="px-4 py-3 font-medium">Stage</th>
                      <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((lead) => (
                      <tr key={lead.id} className="border-b border-slate-200 last:border-0 hover:bg-slate-100/40">
                        <td className="px-3 py-2.5">
                          <label className="sr-only" htmlFor={`select-${lead.id}`}>Select {lead.email}</label>
                          <input
                            id={`select-${lead.id}`}
                            type="checkbox"
                            className="size-4 cursor-pointer accent-accent-500 p-1 -m-1 box-content"
                            checked={selected.includes(lead.id)}
                            onChange={(e) => toggleRow(lead.id, e.target.checked)}
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <button
                            type="button"
                            className="cursor-pointer text-left text-ink-900 underline decoration-ink-600 underline-offset-2 hover:text-accent-700"
                            onClick={() => setDetailId(lead.id)}
                          >
                            {[lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-slate-700">{lead.email}</td>
                        <td className="px-4 py-2.5">{lead.company || <span className="text-slate-400">—</span>}</td>
                        <td className="px-4 py-2.5">{lead.title || <span className="text-slate-400">—</span>}</td>
                        <td className="px-4 py-2.5">
                          <Badge value={lead.stage} />
                          {lead.consent?.status === 'signed' && (
                            <span
                              className="ml-1.5 text-[11px] text-emerald-700"
                              title={`${lead.consent.signedName} agreed on ${(lead.consent.signedAt || '').slice(0, 10)}`}
                            >
                              signed
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right">
                          {lead.research ? (
                            <button type="button" className="mr-3 inline-flex min-h-6 items-center py-1 cursor-pointer text-xs text-accent-700 hover:text-accent-600" onClick={() => setViewingResearch(lead)}>Profile</button>
                          ) : (
                            <button
                              type="button"
                              className="mr-3 inline-flex min-h-6 items-center py-1 cursor-pointer text-xs text-slate-600 hover:text-accent-700"
                              disabled={researchingId === lead.id}
                              onClick={async () => {
                                setResearchingId(lead.id)
                                try {
                                  await api.post(`/api/leads/${lead.id}/research`)
                                  toast('Research profile built')
                                  load()
                                } catch (err) { toast(err.message, 'error') } finally { setResearchingId(null) }
                              }}
                            >
                              {researchingId === lead.id ? 'Researching…' : 'Research'}
                            </button>
                          )}
                          <button type="button" className="mr-3 inline-flex min-h-6 items-center py-1 cursor-pointer text-xs text-slate-600 hover:text-accent-700" onClick={() => setEditing(lead)}>Edit</button>
                          <button
                            type="button"
                            className="inline-flex min-h-6 items-center py-1 cursor-pointer text-xs text-slate-600 hover:text-red-600"
                            onClick={async () => {
                              if (!confirm(`Delete ${lead.email}? This removes them from all campaigns.`)) return
                              try { await api.del(`/api/leads/${lead.id}`); toast('Lead deleted'); load() } catch (err) { toast(err.message, 'error') }
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <BulkBar count={selected.length} onClear={() => setSelected([])}>
              <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setBulk('labels')}>Labels</button>
              <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setBulk('segment')}>Add to segment</button>
              <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setBulk('push')}>Push to campaign</button>
              <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setBulk('find-emails')}>Find addresses</button>
            </BulkBar>
          </div>
        </div>
      )}

      {bulk === 'labels' && (
        <BulkLabels leadIds={selected} onClose={() => setBulk(null)} onChanged={() => setLive('Labels updated')} />
      )}
      {bulk === 'segment' && (
        <AddToSegment leadIds={selected} onClose={() => setBulk(null)} />
      )}
      {bulk === 'push' && (
        <PushToCampaign leadIds={selected} leads={selectedLeads} count={selected.length} onClose={() => setBulk(null)} />
      )}
      {bulk === 'find-emails' && (
        <FindEmails
          leads={selectedLeads}
          onClose={() => setBulk(null)}
          onChanged={() => { setLive('Lead addresses updated'); load() }}
        />
      )}

      {detailId && (
        <LeadDetail leadId={detailId} onClose={() => setDetailId(null)} onChanged={load} />
      )}

      {editing && (
        <LeadModal
          lead={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}

      {viewingResearch && (
        <Modal title={`Research profile — ${viewingResearch.company || viewingResearch.email}`} onClose={() => setViewingResearch(null)} wide>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white p-4 text-sm text-slate-700">{viewingResearch.research}</pre>
          <p className="mt-3 text-xs text-slate-500">
            Built by the research agent{viewingResearch.researched_at ? ` (${viewingResearch.researched_at} UTC)` : ''}. The composer uses this
            profile to personalize every email to this lead. What a person knows belongs in the Notes tab on the lead
            instead — this panel is the machine's.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                try {
                  await api.post(`/api/leads/${viewingResearch.id}/research`)
                  toast('Profile refreshed')
                  setViewingResearch(null)
                  load()
                } catch (err) { toast(err.message, 'error') }
              }}
            >
              Refresh research
            </button>
            <button type="button" className="btn-primary" onClick={() => setViewingResearch(null)}>Close</button>
          </div>
        </Modal>
      )}

      {importState && (
        <Modal title={`Import ${fmt(importState.rows.length)} rows`} onClose={() => setImportState(null)} wide>
          <p className="mb-4 text-sm text-slate-600">
            Match your CSV columns to lead fields. Email is required; addresses already in your leads are skipped, and
            unsubscribed people are never re-added.
          </p>
          <ColumnMapper
            headers={importState.headers}
            fields={LEAD_FIELDS}
            mapping={importState.mapping}
            onChange={(mapping) => { setImportState((s) => ({ ...s, mapping })); setImportError(null) }}
          />
          <div className="my-4 text-xs text-slate-500">
            Preview: {importState.rows.slice(0, 3).map((r) => r[importState.mapping.email] ?? '(no email)').join(', ')}
            {importState.rows.length > 3 ? '…' : ''}
          </div>
          <FieldError err={importError} field="email" />
          <FormError err={importError} fields={['email']} />
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setImportState(null)}>Cancel</button>
            <button type="button" className="btn-primary" onClick={runImport}>Import</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function LeadModal({ lead, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState({
    email: lead?.email || '', firstName: lead?.first_name || '', lastName: lead?.last_name || '',
    company: lead?.company || '', title: lead?.title || '', notes: lead?.notes || '', status: lead?.status || 'active',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setError(null) }

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      if (lead) await api.put(`/api/leads/${lead.id}`, form)
      else await api.post('/api/leads', form)
      toast(lead ? 'Lead updated' : 'Lead added')
      onSaved()
    } catch (err) { setError(err); toast(err.message, 'error') } finally { setBusy(false) }
  }

  return (
    <Modal title={lead ? `Edit ${lead.email}` : 'Add lead'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-slate-600" htmlFor="new-email">Email *</label>
          <input id="new-email" className="input" type="email" required value={form.email} onChange={set('email')} disabled={Boolean(lead)} />
          <FieldError err={error} field="email" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-slate-600" htmlFor="new-first">First name</label>
            <input id="new-first" className="input" value={form.firstName} onChange={set('firstName')} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-600" htmlFor="new-last">Last name</label>
            <input id="new-last" className="input" value={form.lastName} onChange={set('lastName')} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-slate-600" htmlFor="new-company">Company</label>
            <input id="new-company" className="input" value={form.company} onChange={set('company')} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-600" htmlFor="new-title">Title</label>
            <input id="new-title" className="input" value={form.title} onChange={set('title')} />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-600" htmlFor="new-notes">Notes (the agent uses these for personalization)</label>
          <textarea id="new-notes" className="input min-h-20" value={form.notes} onChange={set('notes')} />
        </div>
        {lead && (
          <div>
            <label className="mb-1 block text-xs text-slate-600" htmlFor="new-status">Status</label>
            <select id="new-status" className="input" value={form.status} onChange={set('status')}>
              <option value="active">active</option>
              <option value="unsubscribed">unsubscribed</option>
              <option value="bounced">bounced</option>
            </select>
          </div>
        )}
        <FormError err={error} fields={['email']} />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
