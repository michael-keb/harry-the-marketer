// Lead labels — Docs/lead-tags/*.
//
// One picker component serves both the lead detail and the table's bulk action
// bar, which is the "single-lead and bulk tagging use one picker component and
// one request shape" line of the definition of done. The only difference is
// that the bulk case knows three states per label instead of two, so a bulk add
// cannot strip a label from a row that already carries it.
//
// Deliberate divergence from the shared kit: parity-ui's `TagPicker` reads the
// label list as `r.items ?? r.tags ?? r`, and `GET /api/tags` answers
// `{ ok, appliesTo, data, nextCursor, hasMore }` — no `items`, no `tags` — so
// the kit component renders the response object as if it were an array and
// throws. `LabelPicker` below is deliberately prop-compatible with it
// (appliesTo / selected / onToggle / onCreate / busyId) so it can be deleted in
// favour of the kit the moment that read is corrected. `TagChip` is used from
// the kit unchanged.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, qs } from '../api.js'
import { Spinner, ErrorState, useToast } from '../ui.jsx'
import { TagChip, LiveRegion } from '../parity-ui.jsx'
import { useUndo } from '../undo.jsx'
import { Sheet, FieldError, FormError, pool } from './shared.jsx'

// The bulk write routes cap the batch; reading current state for the picker is
// capped lower still, because it is one request per ticked row.
const MAX_BULK_LEADS = 500
const MAX_STATE_READS = 100

export function loadLabels(appliesTo = 'lead') {
  return api.get(`/api/tags${qs({ appliesTo, limit: 200 })}`).then((res) => res.data || [])
}

// ---- picker ------------------------------------------------------------------

// `state` maps a tag id to 'all' | 'some' | 'none'. A single-lead caller passes
// only 'all' and 'none'; the bulk caller passes all three. The state is always
// stated in words in the option's text, never by colour or a glyph alone.
export function LabelPicker({
  appliesTo = 'lead',
  selected = [],
  state = null,
  onToggle,
  onCreate,
  busyId = null,
  total = 1,
}) {
  const [tags, setTags] = useState(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)

  const load = useCallback(() => {
    setError(null)
    loadLabels(appliesTo).then(setTags).catch(setError)
  }, [appliesTo])

  useEffect(() => { load() }, [load])

  const shown = useMemo(() => {
    const list = tags || []
    const q = query.trim().toLowerCase()
    return q ? list.filter((t) => String(t.name).toLowerCase().includes(q)) : list
  }, [tags, query])

  if (error) return <ErrorState error={error} onRetry={load} />
  if (!tags) return <Spinner label="Loading labels…" />

  const stateOf = (tag) => (state ? (state[tag.id] || 'none') : (selected.includes(tag.id) ? 'all' : 'none'))
  const exact = shown.some((t) => String(t.name).toLowerCase() === query.trim().toLowerCase())

  const create = async () => {
    setCreating(true)
    setCreateError(null)
    try {
      await onCreate(query.trim())
      setQuery('')
      load()
    } catch (err) {
      // A 409 hands back the label that already exists rather than writing over
      // it, so the picker says so instead of pretending the create worked.
      setCreateError(err)
      if (err?.status === 409) load()
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <label className="mb-1 block text-xs text-slate-600" htmlFor="label-search">Search labels</label>
      <input
        id="label-search"
        className="input mb-2"
        placeholder="Search labels…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setCreateError(null) }}
      />
      <ul role="listbox" aria-multiselectable="true" aria-label="Labels" className="max-h-64 space-y-1 overflow-y-auto">
        {shown.map((tag) => {
          const value = stateOf(tag)
          const words = value === 'all'
            ? (total > 1 ? `on all ${total}` : 'applied')
            : value === 'some'
              ? `on some of ${total}`
              : 'not applied'
          return (
            <li key={tag.id}>
              <button
                type="button"
                role="option"
                aria-selected={value === 'all'}
                disabled={busyId === tag.id}
                onClick={() => onToggle(tag, value !== 'all')}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              >
                <span
                  aria-hidden
                  className={`flex size-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold ${
                    value === 'all'
                      ? 'border-accent-500 bg-accent-500 text-ink-950'
                      : value === 'some'
                        ? 'border-accent-500 text-accent-700'
                        : 'border-slate-300'
                  }`}
                >
                  {value === 'all' ? '✓' : value === 'some' ? '–' : ''}
                </span>
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: tag.color || '#5d7893' }} aria-hidden />
                <span className="truncate">{tag.name}</span>
                <span className="ml-auto shrink-0 text-[11px] text-slate-500">
                  {busyId === tag.id ? 'working…' : words}
                </span>
              </button>
            </li>
          )
        })}
        {shown.length === 0 && (
          <li className="px-2 py-3 text-sm text-slate-500">
            {tags.length === 0 ? 'This workspace has no labels yet.' : `No labels match “${query}”.`}
          </li>
        )}
      </ul>
      {onCreate && query.trim() && !exact && (
        <button type="button" className="btn-ghost mt-2 w-full justify-center" disabled={creating} onClick={create}>
          {creating ? 'Creating…' : `Create label “${query.trim()}”`}
        </button>
      )}
      {createError && (
        <div className="mt-2">
          <FieldError err={createError} field="name" />
          <FormError err={createError} fields={['name']} />
        </div>
      )}
    </div>
  )
}

// ---- lead detail row ---------------------------------------------------------

// "One row under the name; hidden entirely when the workspace has no labels."
// The first label of a workspace's life is therefore created from the table's
// bulk bar, which only exists when rows are ticked and so costs nothing here.
export function LeadLabels({ leadId }) {
  const toast = useToast()
  const [mine, setMine] = useState(null)
  const [workspaceCount, setWorkspaceCount] = useState(null)
  const [error, setError] = useState(null)
  const [picking, setPicking] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [live, setLive] = useState('')

  const readMine = useCallback(
    () => api.get(`/api/tags${qs({ appliesTo: 'lead', leadId, limit: 200 })}`).then((res) => res.data || []),
    [leadId],
  )

  const load = useCallback(async () => {
    setError(null)
    try {
      const [onLead, all] = await Promise.all([readMine(), loadLabels('lead')])
      setMine(onLead)
      setWorkspaceCount(all.length)
    } catch (err) { setError(err) }
  }, [readMine])

  useEffect(() => { load() }, [load])

  if (error) {
    return (
      <p className="text-xs text-red-700" role="alert">
        Labels could not be loaded — {error.message}{' '}
        <button type="button" className="cursor-pointer underline" onClick={load}>Try again</button>
      </p>
    )
  }
  if (mine === null) return <p className="text-xs text-slate-500">Loading labels…</p>
  // The whole row goes when there is nothing to show and nothing to pick from.
  if (mine.length === 0 && !workspaceCount) return null

  const add = async (tag) => {
    // Optimistic, with a pending mark, and visibly reverted if the write fails.
    const pendingKey = `pending-${tag.id}`
    setMine((list) => [...list, { id: tag.id, mappingId: pendingKey, name: tag.name, color: tag.color, pending: true }])
    setBusyId(tag.id)
    try {
      await api.post(`/api/leads/${leadId}/tags`, { tagIds: [tag.id] })
      setMine(await readMine())
      setLive(`Label ${tag.name} added`)
    } catch (err) {
      setMine((list) => list.filter((t) => t.mappingId !== pendingKey))
      setLive(`Label ${tag.name} could not be added — ${err.message}`)
      toast(err.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (tag) => {
    if (String(tag.mappingId).startsWith('pending-')) return
    const before = mine
    setMine((list) => list.filter((t) => t.mappingId !== tag.mappingId))
    try {
      await api.del(`/api/leads/tags/${tag.mappingId}`)
      setLive(`Label ${tag.name} removed`)
    } catch (err) {
      // A second removal 404s, which means it is already gone rather than that
      // something broke.
      if (err?.status === 404) { setLive(`Label ${tag.name} was already removed`); return }
      setMine(before)
      setLive(`Label ${tag.name} could not be removed — ${err.message}`)
      toast(err.message, 'error')
    }
  }

  const toggle = async (tag, on) => {
    if (on) return add(tag)
    const existing = mine.find((t) => t.id === tag.id)
    if (existing) return remove(existing)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="sr-only">Labels on this lead</span>
      {mine.map((tag) => (
        <span key={tag.mappingId} className={tag.pending ? 'opacity-60' : ''}>
          <TagChip tag={tag} onRemove={tag.pending ? undefined : () => remove(tag)} />
          {tag.pending && <span className="sr-only">adding</span>}
        </span>
      ))}
      <button
        type="button"
        className="cursor-pointer rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:border-accent-500 hover:text-accent-700"
        onClick={() => setPicking(true)}
      >
        + Label
      </button>
      <LiveRegion message={live} />
      {picking && (
        <Sheet title="Labels on this lead" onClose={() => { setPicking(false); load() }}>
          <LabelPicker
            appliesTo="lead"
            selected={mine.map((t) => t.id)}
            busyId={busyId}
            onToggle={toggle}
            onCreate={async (name) => {
              const created = await api.post('/api/tags', { appliesTo: 'lead', name })
              await add(created.data)
            }}
          />
        </Sheet>
      )}
    </div>
  )
}

// ---- bulk --------------------------------------------------------------------

// `undo.run` reads the toast's label only once `perform` has resolved, so a
// label that is an element rather than a string can state what the server
// actually wrote instead of what this component predicted before asking. The
// count matters here: a bulk add over rows that already carry the label writes
// nothing, and "added to 12 leads" would be a lie.
function Outcome({ report }) {
  return report.text
}

// Three states, read from the ticked rows before anything is written. There is
// no bulk "labels for these lead ids" read, so the current state is gathered one
// row at a time through a bounded pool; above MAX_STATE_READS rows the picker
// says plainly that it has not checked, and then only ever adds or only ever
// removes — it never guesses.
export function BulkLabels({ leadIds, onClose, onChanged }) {
  const toast = useToast()
  const undo = useUndo()
  // Tag id -> the sampled lead ids that carry it. The tally alone was enough to
  // render three states, but not to undo: putting a bulk add back means removing
  // the label from exactly the rows that gained it, and that needs the ids.
  const [holders, setHolders] = useState(null)
  const [checked, setChecked] = useState(0)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [live, setLive] = useState('')

  const sample = useMemo(() => leadIds.slice(0, MAX_STATE_READS), [leadIds])
  const partial = leadIds.length > sample.length

  const labelsOn = useCallback(
    (leadId) => api.get(`/api/tags${qs({ appliesTo: 'lead', leadId, limit: 200 })}`).then((r) => r.data || []),
    [],
  )

  const read = useCallback(async () => {
    setError(null)
    setHolders(null)
    try {
      const results = await pool(sample, 6, labelsOn)
      const carriers = {}
      results.forEach((list, i) => {
        for (const tag of list) (carriers[tag.id] ||= []).push(sample[i])
      })
      setHolders(carriers)
      setChecked(results.length)
    } catch (err) { setError(err) }
  }, [sample, labelsOn])

  useEffect(() => { read() }, [read])

  const state = useMemo(() => {
    if (!holders) return {}
    const out = {}
    for (const [id, carried] of Object.entries(holders)) {
      // A label nothing carries is 'none', which is the picker's default —
      // saying 'some' of zero rows would be a lie.
      if (!carried.length) continue
      out[id] = checked > 0 && carried.length >= checked ? 'all' : 'some'
    }
    return out
  }, [holders, checked])

  const tooMany = leadIds.length > MAX_BULK_LEADS

  // Which of the selected leads already carry `tag`, for every selected lead
  // rather than only the sampled ones. Opening the sheet reads MAX_STATE_READS
  // rows because that is what the counts need; the undo needs the rest too, so
  // the remainder is read here — on the click, once, for one label — instead of
  // making the sheet cost 500 requests to open. `null` means the read failed and
  // therefore that nothing is known, which is the one answer that must not be
  // confused with "none of them".
  const carriersOf = async (tag) => {
    const carried = new Set(holders?.[tag.id] || [])
    const rest = leadIds.slice(sample.length)
    if (!rest.length) return carried
    try {
      const lists = await pool(rest, 6, labelsOn)
      lists.forEach((list, i) => { if (list.some((t) => t.id === tag.id)) carried.add(rest[i]) })
      return carried
    } catch {
      return null
    }
  }

  // `brandNew` is set only by the create path: a label that did not exist a
  // moment ago cannot be on anybody, so the top-up read above is skipped rather
  // than spending hundreds of requests to confirm a certainty.
  const toggle = async (tag, on, { brandNew = false } = {}) => {
    setBusyId(tag.id)
    const noun = (n) => `${n} lead${n === 1 ? '' : 's'}`
    const report = { text: '', written: null }
    try {
      const before = brandNew ? new Set() : await carriersOf(tag)
      // Both writes are idempotent, so the inverse of this click is NOT "send
      // the opposite request for every id I just sent". The rows that already
      // carried the label were untouched by an add, and stripping them on undo
      // would take away a label the user never applied; the rows that never
      // carried it were untouched by a removal, and re-adding would put a label
      // on people who never had one. The reversible set is the difference.
      const touched = before === null
        ? null
        : (on ? leadIds.filter((id) => !before.has(id)) : leadIds.filter((id) => before.has(id)))

      const perform = async () => {
        const res = on
          ? await api.post('/api/leads/tags', { leadIds, tagIds: [tag.id] })
          : await api.del('/api/leads/tags/bulk', { leadIds, tagIds: [tag.id] })
        // The route counts the join rows it really wrote — `added` is 0 when
        // every selected lead already had the label — so that is the number the
        // toast and the live region both quote.
        const n = (on ? res.added : res.removed) ?? touched?.length ?? leadIds.length
        report.written = n
        report.text = n === 0
          ? `Nothing changed — ${on ? `every selected lead already had ${tag.name}` : `no selected lead had ${tag.name}`}`
          : n === leadIds.length
            ? `${tag.name} ${on ? 'added to' : 'removed from'} ${noun(n)}`
            : `${tag.name} ${on ? 'added to' : 'removed from'} ${n} of ${noun(leadIds.length)}`
        setLive(report.text)
        setHolders((h) => ({ ...(h || {}), [tag.id]: on ? [...sample] : [] }))
        onChanged?.()
        return res
      }

      // Labelling is a grouping change and nothing else: no email moves, the
      // label row itself is never written, and the inverse call restores the
      // exact set of pairings. That is what makes an undo toast the right trade
      // here rather than a confirm dialog in front of it.
      if (!touched || touched.length === 0) {
        // Either the prior state is unknown (the top-up read failed), or every
        // selected lead is already where the click asked for. Offering "Undo"
        // would mean guessing which rows to change back, and this picker does
        // not guess — the write still happens, just without a toast.
        await perform()
      } else {
        await undo.run({
          label: <Outcome report={report} />,
          perform,
          revert: async () => {
            // The prior state was read a moment before the write, not during it.
            // If somebody else labelled these rows in between, the server wrote
            // nothing and there is nothing to take back — reverting anyway would
            // strip a label this click never applied.
            if (report.written === 0) { setLive(`${tag.name} was left as it already was`); return }
            if (on) await api.del('/api/leads/tags/bulk', { leadIds: touched, tagIds: [tag.id] })
            else await api.post('/api/leads/tags', { leadIds: touched, tagIds: [tag.id] })
            setHolders((h) => ({ ...(h || {}), [tag.id]: [...before].filter((id) => sample.includes(id)) }))
            setLive(`${tag.name} put back as it was on ${noun(touched.length)}`)
            onChanged?.()
          },
        })
      }
    } catch (err) {
      setLive(`${tag.name} could not be ${on ? 'added' : 'removed'} — ${err.message}`)
      toast(err.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Sheet title={`Labels on ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'}`} onClose={onClose}>
      <LiveRegion message={live} />
      {tooMany ? (
        <FormError err={{ message: `Labels can be applied to at most ${MAX_BULK_LEADS} leads at a time. Narrow the selection and try again.` }} />
      ) : error ? (
        <ErrorState error={error} onRetry={read} />
      ) : !holders ? (
        <Spinner label={`Reading the labels already on ${sample.length} lead${sample.length === 1 ? '' : 's'}…`} />
      ) : (
        <>
          <p className="mb-3 text-xs text-slate-600">
            Ticking a label adds it to every selected lead. Unticking removes it from every selected lead. A label shown
            as “on some” is left exactly as it is until you click it, so a bulk add never strips a label from a row that
            already has one. Each change offers an undo for a few seconds afterwards, and undoing touches only the rows
            that actually changed.
          </p>
          {partial && (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
              {leadIds.length.toLocaleString()} leads are selected and only the first {sample.length} were checked, so
              the counts below describe that sample. Adding or removing still applies to all {leadIds.length.toLocaleString()};
              the rows outside the sample are read at the moment you click, so the undo still covers every one of them.
            </p>
          )}
          <LabelPicker
            appliesTo="lead"
            state={state}
            total={checked}
            busyId={busyId}
            onToggle={toggle}
            onCreate={async (name) => {
              const created = await api.post('/api/tags', { appliesTo: 'lead', name })
              await toggle(created.data, true, { brandNew: true })
            }}
          />
        </>
      )}
    </Sheet>
  )
}
