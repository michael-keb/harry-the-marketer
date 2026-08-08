// Lead lists, called segments in the UI — Docs/lead-lists/*.
//
// A segment is a reusable bag of leads that outlives any one campaign. The
// panel sits beneath the stage strip on the Leads page rather than becoming a
// screen of its own, and every write it offers is one the backend already has:
// create, rename, soft-delete, label, import, transfer and push.
//
// Two rules are structural rather than cosmetic:
//
//   * The push picker never offers to create a campaign. A Harry campaign
//     cannot launch without a valid playbook and a mailbox, so a campaign
//     conjured from a typed name would be born broken — the route 422s on
//     `campaignName` and this UI has no field that could send one.
//   * Deleting a segment is a grouping change, never a loss of people. The
//     confirmation says so using the count the server hands back.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, qs } from '../api.js'
import { Spinner, EmptyState, ErrorState, Badge, useToast } from '../ui.jsx'
import { TagChip, Confirm, LiveRegion } from '../parity-ui.jsx'
import { LabelPicker } from './labels.jsx'
import { ColumnMapper, ImportSummary, SEGMENT_FIELDS, guessMapping, mapRows, parseCsv } from './csv.jsx'
import { Field, FieldError, FormError, Sheet, fmt, shortWhen } from './shared.jsx'

const BULK_TAG_MAX = 10

// ---- the panel ---------------------------------------------------------------

export function SegmentsPanel({ selectedId, onSelect, onLeadsChanged }) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [items, setItems] = useState(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState(null) // { kind, segment }
  const [live, setLive] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get(`/api/lead-lists${qs({ q: debounced || undefined, limit: 100 })}`)
      setItems(res.items || [])
      setTotal(res.total ?? (res.items || []).length)
      if (debounced) setLive(`${(res.items || []).length} segment${(res.items || []).length === 1 ? '' : 's'} match`)
    } catch (err) { setError(err) }
  }, [debounced])

  useEffect(() => { load() }, [load])

  const summary = useMemo(() => (items || []).find((s) => s.id === selectedId) || null, [items, selectedId])
  const [detail, setDetail] = useState(null)

  // The list route omits `lastImport` — only GET /api/lead-lists/:id carries it,
  // which is the one thing that lets a year-old segment say where its people
  // came from. It is fetched for the selected segment alone.
  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    let live = true
    api.get(`/api/lead-lists/${selectedId}`)
      .then((res) => { if (live) setDetail(res) })
      .catch(() => { if (live) setDetail(null) })
    return () => { live = false }
  }, [selectedId, items])

  const selected = summary ? { ...summary, ...(detail?.id === selectedId ? detail : {}) } : null

  const close = (changed) => {
    setDialog(null)
    if (changed) { load(); onLeadsChanged?.() }
  }

  const body = (
    <>
      <div className="px-3 pb-2">
        <label className="sr-only" htmlFor="segment-search">Search segments by name</label>
        <input
          id="segment-search"
          className="input"
          placeholder="Search segments…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error ? (
        <div className="px-3 pb-3"><ErrorState error={error} onRetry={load} /></div>
      ) : items === null ? (
        <div className="px-3 pb-3"><Spinner label="Loading segments…" /></div>
      ) : items.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-slate-500">
          {debounced
            ? <>No segments match this search. <button type="button" className="cursor-pointer underline" onClick={() => setQuery('')}>Clear</button></>
            : 'No segments yet — create one to group leads you will reuse.'}
        </p>
      ) : (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto px-2 pb-2">
          {items.map((segment) => (
            <li key={segment.id}>
              <button
                type="button"
                aria-pressed={selectedId === segment.id}
                onClick={() => onSelect(selectedId === segment.id ? null : segment.id)}
                className={`w-full cursor-pointer rounded-lg px-2 py-1.5 text-left transition-colors ${
                  selectedId === segment.id ? 'bg-accent-500/10 text-accent-700' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span className="block truncate text-sm">{segment.name}</span>
                <span className="block text-[11px] text-slate-500">
                  {fmt(segment.leadCount)} lead{segment.leadCount === 1 ? '' : 's'}
                </span>
                {segment.tags?.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {segment.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="border-t border-slate-200 px-3 py-2.5">
          <p className="text-xs font-medium text-ink-900">{selected.name}</p>
          {selected.description && <p className="mt-0.5 text-[11px] text-slate-500">{selected.description}</p>}
          {selected.lastImport && (
            <p className="mt-0.5 text-[11px] text-slate-500">
              Last import: {selected.lastImport.fileName}, {shortWhen(selected.lastImport.createdAt)}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'import', segment: selected })}>Import a CSV</button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'push', segment: selected })}>Push to campaign</button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'transfer', segment: selected })}>Move or copy</button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'labels', segment: selected })}>Labels</button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'rename', segment: selected })}>Rename</button>
            <button type="button" className="btn-danger px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'delete', segment: selected })}>Delete</button>
          </div>
        </div>
      )}

      <div className="border-t border-slate-200 px-3 py-2.5">
        <button type="button" className="btn-ghost w-full justify-center text-xs" onClick={() => setDialog({ kind: 'create' })}>
          + New segment
        </button>
      </div>
    </>
  )

  return (
    <aside className="card w-full shrink-0 py-3 md:w-64">
      <LiveRegion message={live} />
      <div className="flex items-center justify-between px-3 pb-2">
        <h2 className="text-sm font-semibold text-ink-950">
          Segments <span className="font-normal text-slate-500">({fmt(total)})</span>
        </h2>
        <button
          type="button"
          className="cursor-pointer text-xs text-slate-600 hover:text-ink-900 md:hidden"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className={open ? '' : 'hidden md:block'}>{body}</div>

      {dialog?.kind === 'create' && <SegmentForm onClose={close} />}
      {dialog?.kind === 'rename' && <SegmentForm segment={dialog.segment} onClose={close} />}
      {dialog?.kind === 'labels' && <SegmentLabels segment={dialog.segment} onClose={close} />}
      {dialog?.kind === 'import' && <SegmentImport segment={dialog.segment} onClose={close} />}
      {dialog?.kind === 'push' && (
        <PushToCampaign listId={dialog.segment.id} listName={dialog.segment.name} count={dialog.segment.leadCount} onClose={close} />
      )}
      {dialog?.kind === 'transfer' && <TransferDialog from={dialog.segment} segments={items || []} onClose={close} />}
      {dialog?.kind === 'delete' && (
        <DeleteSegment
          segment={dialog.segment}
          onClose={close}
          onDeleted={() => { if (selectedId === dialog.segment.id) onSelect(null); toast('Segment deleted') }}
        />
      )}
    </aside>
  )
}

// ---- create and rename -------------------------------------------------------

function SegmentForm({ segment, onClose }) {
  const toast = useToast()
  const [form, setForm] = useState({ name: segment?.name || '', description: segment?.description || '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (segment) await api.put(`/api/lead-lists/${segment.id}`, form)
      else await api.post('/api/lead-lists', form)
      toast(segment ? 'Segment renamed' : 'Segment created')
      onClose(true)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Sheet title={segment ? `Rename “${segment.name}”` : 'New segment'} onClose={() => onClose(false)}>
      <form onSubmit={submit} className="space-y-3" id="segment-form">
        <Field label="Name *" htmlFor="segment-name">
          <input id="segment-name" className="input" required value={form.name} onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setError(null) }} />
          <FieldError err={error} field="name" />
        </Field>
        <Field label="Description" htmlFor="segment-desc">
          <textarea id="segment-desc" className="input min-h-16" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          <FieldError err={error} field="description" />
        </Field>
        <FormError err={error} fields={['name', 'description']} />
      </form>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => onClose(false)}>Cancel</button>
        <button type="submit" form="segment-form" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Sheet>
  )
}

function DeleteSegment({ segment, onClose, onDeleted }) {
  const toast = useToast()
  return (
    <Confirm
      title={`Delete the segment “${segment.name}”?`}
      body={`The grouping goes; the people do not. All ${fmt(segment.leadCount)} lead(s) stay on the Leads page with their stage, research profile and campaign attachments untouched — a lead that was only in this segment is simply ungrouped afterwards.`}
      confirmLabel="Delete segment"
      danger
      onClose={() => onClose(false)}
      onConfirm={async () => {
        try {
          await api.del(`/api/lead-lists/${segment.id}`)
          onDeleted()
          onClose(true)
        } catch (err) { toast(err.message, 'error') }
      }}
    />
  )
}

// ---- segment labels ----------------------------------------------------------

// Segment labels are their own kind: `appliesTo = 'lead_list'`, so a lead label
// and a segment label may share a name without appearing in each other's picker.
function SegmentLabels({ segment, onClose }) {
  const toast = useToast()
  const [applied, setApplied] = useState((segment.tags || []).map((t) => t.id))
  const [busyId, setBusyId] = useState(null)
  const [live, setLive] = useState('')

  const toggle = async (tag, on) => {
    setBusyId(tag.id)
    const before = applied
    setApplied((list) => (on ? [...list, tag.id] : list.filter((id) => id !== tag.id)))
    try {
      // `tagIds` is required by the route even for a removal, and removals run
      // first — an id in both arrays therefore ends up removed.
      await api.post('/api/lead-lists/assign-tags', {
        listIds: [segment.id],
        tagIds: [tag.id],
        removeTagIds: on ? [] : [tag.id],
      })
      setLive(`${tag.name} ${on ? 'added to' : 'removed from'} ${segment.name}`)
    } catch (err) {
      setApplied(before)
      setLive(`${tag.name} could not be changed — ${err.message}`)
      toast(err.message, 'error')
    } finally { setBusyId(null) }
  }

  return (
    <Sheet title={`Labels on “${segment.name}”`} onClose={() => onClose(true)}>
      <LiveRegion message={live} />
      <p className="mb-3 text-xs text-slate-500">
        Segment labels are separate from lead labels, so “Enterprise” can mean one thing on a person and another on a
        group. At most {BULK_TAG_MAX} can be changed in one request.
      </p>
      <LabelPicker
        appliesTo="lead_list"
        selected={applied}
        busyId={busyId}
        onToggle={toggle}
        onCreate={async (name) => {
          const created = await api.post('/api/tags', { appliesTo: 'lead_list', name })
          await toggle(created.data, true)
        }}
      />
    </Sheet>
  )
}

// ---- import ------------------------------------------------------------------

function SegmentImport({ segment, onClose }) {
  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null) // { fileName, headers, rows, mapping }
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const onFile = async (chosen) => {
    setError(null)
    setResult(null)
    setFile(chosen)
    const text = await chosen.text()
    const rows = parseCsv(text)
    if (rows.length < 2) {
      setError({ message: 'That file needs a header row plus at least one data row.' })
      setParsed(null)
      return
    }
    setParsed({
      fileName: chosen.name,
      headers: rows[0],
      rows: rows.slice(1),
      mapping: guessMapping(rows[0], SEGMENT_FIELDS),
    })
  }

  const run = async () => {
    if (parsed.mapping.email === undefined) {
      setError({ payload: { field: 'email' }, message: 'Map the Email column before importing — it is the only required field.' })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.post(`/api/lead-lists/${segment.id}/import`, {
        fileName: parsed.fileName,
        leads: mapRows(parsed.rows, parsed.mapping),
      })
      setResult(res)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Sheet title={`Import a CSV into “${segment.name}”`} onClose={() => onClose(Boolean(result))} wide>
      {result ? (
        <div className="space-y-4">
          <ImportSummary result={result} title={result.message} />
          <p className="text-xs text-slate-500">
            The segment now holds {fmt(result.leadCount)} lead(s). The filename is kept on the segment so a year-old
            group can still explain where its people came from.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="CSV file" htmlFor="segment-file" hint="Parsed in your browser; only the mapped columns are sent.">
            <input
              id="segment-file"
              type="file"
              accept=".csv,text/csv"
              className="input"
              onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]) }}
            />
          </Field>

          {parsed && (
            <>
              <p className="text-xs text-slate-600" role="status" aria-live="polite">
                {fmt(parsed.rows.length)} row{parsed.rows.length === 1 ? '' : 's'} read from {parsed.fileName}. Nothing is
                written until you press Import.
              </p>
              <ColumnMapper
                headers={parsed.headers}
                fields={SEGMENT_FIELDS}
                mapping={parsed.mapping}
                onChange={(mapping) => { setParsed((p) => ({ ...p, mapping })); setError(null) }}
              />
              <FieldError err={error} field="email" />
              <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                Unsubscribed addresses and blocked domains are refused. Harry offers no setting anywhere that bypasses
                either, so the blocked count below is the whole story.
              </p>
            </>
          )}
          <FormError err={error} fields={['email']} />
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => onClose(Boolean(result))}>{result ? 'Close' : 'Cancel'}</button>
        {!result && (
          <button type="button" className="btn-primary" disabled={!parsed || busy} onClick={run}>
            {busy ? 'Importing…' : parsed ? `Import ${fmt(parsed.rows.length)} row${parsed.rows.length === 1 ? '' : 's'}` : 'Import'}
          </button>
        )}
      </div>
      {file && !parsed && !error && <p className="mt-2 text-xs text-slate-500">Reading {file.name}…</p>}
    </Sheet>
  )
}

// ---- move and copy -----------------------------------------------------------

// One code path on the server; two entry points here — a whole segment, or the
// rows ticked in the table. A move needs a source segment, so a selection of
// rows can only ever be copied.
function TransferDialog({ from, segments, onClose }) {
  const toast = useToast()
  const [toListId, setToListId] = useState('')
  const [action, setAction] = useState('copy')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const destinations = segments.filter((s) => s.id !== from.id)

  const run = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setResult(await api.post('/api/lead-lists/transfer', { fromListId: from.id, toListId: Number(toListId), action }))
      toast(action === 'move' ? 'Leads moved' : 'Leads copied')
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Sheet title={`Move or copy from “${from.name}”`} onClose={() => onClose(Boolean(result))}>
      {result ? (
        <div className="space-y-2 text-sm text-slate-700" role="status" aria-live="polite">
          <p>{result.message}.</p>
          <p className="text-xs text-slate-500">
            {fmt(result.considered)} considered · {fmt(result.transferred)} {result.action === 'move' ? 'moved' : 'copied'} ·{' '}
            {fmt(result.alreadyPresent)} already in the destination.
          </p>
        </div>
      ) : (
        <form onSubmit={run} className="space-y-3" id="transfer-form">
          <Field label="Destination segment *" htmlFor="transfer-to">
            <select id="transfer-to" className="input" required value={toListId} onChange={(e) => { setToListId(e.target.value); setError(null) }}>
              <option value="">Choose a segment…</option>
              {destinations.map((s) => <option key={s.id} value={s.id}>{s.name} ({fmt(s.leadCount)})</option>)}
            </select>
            <FieldError err={error} field="toListId" />
          </Field>
          <fieldset>
            <legend className="mb-1 block text-xs text-slate-600">What happens to “{from.name}”</legend>
            <div className="space-y-1.5">
              {[
                ['copy', 'Copy — the leads stay in both segments'],
                ['move', `Move — the leads leave “${from.name}”`],
              ].map(([value, label]) => (
                <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input type="radio" name="transfer-action" className="cursor-pointer accent-accent-500" value={value} checked={action === value} onChange={() => setAction(value)} />
                  {label}
                </label>
              ))}
            </div>
            <FieldError err={error} field="fromListId" />
          </fieldset>
          <p className="text-xs text-slate-500">
            {fmt(from.leadCount)} lead(s) will be considered. Membership is organisation only — nothing here composes or
            sends an email.
          </p>
          <FormError err={error} fields={['toListId', 'fromListId', 'action']} />
        </form>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => onClose(Boolean(result))}>{result ? 'Close' : 'Cancel'}</button>
        {!result && (
          <button type="submit" form="transfer-form" className="btn-primary" disabled={busy || !toListId}>
            {busy ? 'Working…' : action === 'move' ? `Move ${fmt(from.leadCount)}` : `Copy ${fmt(from.leadCount)}`}
          </button>
        )}
      </div>
    </Sheet>
  )
}

// The bulk-bar entry point: the ticked rows into a segment. Copy only, because a
// selection of rows has no source segment to move out of.
export function AddToSegment({ leadIds, onClose }) {
  const toast = useToast()
  const [segments, setSegments] = useState(null)
  const [toListId, setToListId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  useEffect(() => {
    api.get(`/api/lead-lists${qs({ limit: 100 })}`).then((res) => setSegments(res.items || [])).catch(setError)
  }, [])

  const run = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setResult(await api.post('/api/lead-lists/transfer', { leadIds, toListId: Number(toListId), action: 'copy' }))
      toast('Leads added to the segment')
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <Sheet title={`Add ${fmt(leadIds.length)} lead${leadIds.length === 1 ? '' : 's'} to a segment`} onClose={() => onClose(Boolean(result))}>
      {result ? (
        <p className="text-sm text-slate-700" role="status" aria-live="polite">
          {result.message}. {fmt(result.alreadyPresent)} were already in it.
        </p>
      ) : segments === null && !error ? (
        <Spinner label="Loading segments…" />
      ) : (
        <form onSubmit={run} className="space-y-3" id="add-to-segment">
          <Field label="Segment *" htmlFor="add-segment-to">
            <select id="add-segment-to" className="input" required value={toListId} onChange={(e) => { setToListId(e.target.value); setError(null) }}>
              <option value="">Choose a segment…</option>
              {(segments || []).map((s) => <option key={s.id} value={s.id}>{s.name} ({fmt(s.leadCount)})</option>)}
            </select>
            <FieldError err={error} field="toListId" />
          </Field>
          <FormError err={error} fields={['toListId']} />
        </form>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => onClose(Boolean(result))}>{result ? 'Close' : 'Cancel'}</button>
        {!result && (
          <button type="submit" form="add-to-segment" className="btn-primary" disabled={busy || !toListId}>
            {busy ? 'Adding…' : `Add ${fmt(leadIds.length)}`}
          </button>
        )}
      </div>
    </Sheet>
  )
}

// ---- push to campaign --------------------------------------------------------

// Never offers to create a campaign: there is no name field here, and the route
// 422s on `campaignName` precisely so this stays true if one is ever added.
export function PushToCampaign({ listId, listName, leadIds, leads, count, onClose }) {
  const [campaigns, setCampaigns] = useState(null)
  const [campaignId, setCampaignId] = useState('')
  const [action, setAction] = useState('copy')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  useEffect(() => {
    api.get('/api/campaigns').then((rows) => setCampaigns(Array.isArray(rows) ? rows : [])).catch(setError)
  }, [])

  const total = count ?? leadIds?.length ?? 0

  // When the rows come from the table their status is already known, so the
  // exclusions can be stated before the push rather than only afterwards.
  const preview = useMemo(() => {
    if (!Array.isArray(leads)) return null
    const out = { unsubscribed: 0, bounced: 0 }
    for (const lead of leads) {
      if (lead.status === 'unsubscribed') out.unsubscribed++
      else if (lead.status === 'bounced') out.bounced++
    }
    return out
  }, [leads])

  const run = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const selection = listId ? { listId } : { leadIds }
      setResult(await api.post('/api/lead-lists/push-to-campaign', { campaignId: Number(campaignId), action, selection }))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  const chosen = (campaigns || []).find((c) => String(c.id) === String(campaignId))

  return (
    <Sheet title={listName ? `Push “${listName}” to a campaign` : `Push ${fmt(total)} lead${total === 1 ? '' : 's'} to a campaign`} onClose={() => onClose(Boolean(result))} wide>
      {result ? (
        <div className="space-y-3" role="status" aria-live="polite">
          <p className="text-sm text-ink-900">{result.message}.</p>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Attached', result.pushed],
              ['Already in it', result.duplicates],
              ['Unsubscribed', result.excluded?.unsubscribed],
              ['Bounced or blocked', (result.excluded?.bounced || 0) + (result.excluded?.blocked || 0)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <dt className="text-[11px] text-slate-600">{label}</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums text-ink-950">{fmt(value)}</dd>
              </div>
            ))}
          </dl>
          {result.exclusions?.length > 0 && (
            <details className="rounded-lg border border-slate-200">
              <summary className="cursor-pointer px-3 py-2 text-xs text-slate-700">
                Why {fmt(result.exclusions.length)} were left out
              </summary>
              <ul className="max-h-40 overflow-y-auto border-t border-slate-200 px-3 py-2 text-xs text-slate-600">
                {result.exclusions.map((x) => <li key={x.leadId}>{x.email} — {x.reason}</li>)}
              </ul>
            </details>
          )}
          <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
            Nothing has been sent. The first email for each of these people parks in{' '}
            <Link className="text-accent-700 underline" to="/app/inbox">Inbox → Needs your OK</Link> until you approve it.
          </p>
        </div>
      ) : (
        <form onSubmit={run} className="space-y-3" id="push-form">
          {campaigns === null && !error ? (
            <Spinner label="Loading campaigns…" />
          ) : (campaigns || []).length === 0 ? (
            <EmptyState
              title="No campaigns to push into"
              hint="Harry never creates a campaign from this screen — a campaign cannot launch without a valid playbook and a mailbox. Create one on the Campaigns page first."
            />
          ) : (
            <>
              <Field label="Campaign *" htmlFor="push-campaign" hint="Only campaigns that already exist. Harry never creates one implicitly.">
                <select id="push-campaign" className="input" required value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setError(null) }}>
                  <option value="">Choose a campaign…</option>
                  {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.status}</option>)}
                </select>
                <FieldError err={error} field="campaignId" />
              </Field>
              {chosen && (
                <p className="text-xs text-slate-500">
                  Current status: <Badge value={chosen.status} />. Attaching leads does not start a campaign.
                </p>
              )}
              {listId && (
                <fieldset>
                  <legend className="mb-1 block text-xs text-slate-600">What happens to “{listName}”</legend>
                  <div className="space-y-1.5">
                    {[
                      ['copy', 'Copy — the leads stay in the segment'],
                      ['move', 'Move — the leads leave the segment once attached'],
                    ].map(([value, label]) => (
                      <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                        <input type="radio" name="push-action" className="cursor-pointer accent-accent-500" value={value} checked={action === value} onChange={() => setAction(value)} />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                <p>{fmt(total)} lead(s) will be considered.</p>
                {preview && (
                  <p className="mt-1">
                    Of those, {fmt(preview.unsubscribed)} have unsubscribed and {fmt(preview.bounced)} hard bounced — they
                    will be excluded. Blocked domains are checked on the server and reported once the push runs.
                  </p>
                )}
                {!preview && <p className="mt-1">Unsubscribed, bounced and blocked-domain addresses are excluded automatically and counted for you afterwards.</p>}
              </div>
              <FormError err={error} fields={['campaignId', 'campaignName', 'selection', 'listId']} />
            </>
          )}
        </form>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => onClose(Boolean(result))}>{result ? 'Close' : 'Cancel'}</button>
        {!result && (campaigns || []).length > 0 && (
          <button type="submit" form="push-form" className="btn-primary" disabled={busy || !campaignId}>
            {busy ? 'Pushing…' : `Push ${fmt(total)} lead${total === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </Sheet>
  )
}
