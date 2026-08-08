// The fleet: one filtered, paged list rather than a wall of cards.
//
// Every figure on a row comes from the single `/api/mailboxes/fleet` request —
// there is no per-row follow-up call — and every one of them is stated in
// words: health is "sending broken", not a red dot; usage is "12 of 20 today",
// with the bar only repeating the number; a label is its name with a colour
// beside it, never a colour on its own.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, qs } from '../api.js'
import { BulkBar, ErrorState, LiveRegion, LoadMore, TagChip, useToast } from '../parity-ui.jsx'
import { Badge, EmptyState, clockTime } from '../ui.jsx'
import { SuspendDialog } from './Actions.jsx'
import BulkLabels from './BulkLabels.jsx'
import LabelLookup from './LabelLookup.jsx'
import MailboxDrawer from './MailboxDrawer.jsx'
import { PAGE_SIZE, Skeleton, StatusWord, UsageBar, fetchFleetAll, plural, useAnnounce } from './common.jsx'

const EMPTY = { q: '', provider: '', tagId: '', health: '', suspended: '', warmup: '' }

// The filter strip's vocabulary, mapped onto what the endpoint actually takes.
const HEALTH = {
  '': {},
  sendable: { sendable: true },
  attention: { isSmtpSuccess: false },
  noread: { isImapSuccess: false },
  unused: { isInUse: false },
}

function toQuery(f) {
  return {
    q: f.q || undefined,
    provider: f.provider || undefined,
    tagId: f.tagId || undefined,
    warmup: f.warmup || undefined,
    ...(f.suspended ? { isSuspended: f.suspended === 'yes' } : {}),
    ...(HEALTH[f.health] || {}),
  }
}

// Filters live in the URL so a filtered view can be handed to a teammate.
// replaceState only — this never navigates.
function readFilters() {
  const p = new URLSearchParams(window.location.search)
  const out = { ...EMPTY }
  for (const key of Object.keys(EMPTY)) if (p.get(key)) out[key] = p.get(key)
  return out
}

function writeFilters(f) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v)
  const search = p.toString()
  window.history.replaceState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="text-xs text-slate-600">
      <span className="sr-only">{label}</span>
      <select
        className="input w-auto py-1.5 text-xs cursor-pointer"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  )
}

// The two lines a row must always be able to say: can it send, and if not why.
function Sendability({ row }) {
  if (row.sendable) {
    return <StatusWord ok>Sending</StatusWord>
  }
  return (
    <span className="block">
      <StatusWord ok={false}>Not sending</StatusWord>
      <span className="mt-0.5 block text-[11px] text-slate-600">
        {row.sending?.reason || 'no reason given'}
        {row.sending?.until ? ` · next around ${clockTime(row.sending.until)}` : ''}
      </span>
    </span>
  )
}

function Reputation({ row }) {
  const score = row.warmupDetails?.warmupReputation
  if (row.warmupDetails?.appliesTo === false) return <span className="text-[11px] text-slate-500">n/a — sandbox</span>
  if (score === null || score === undefined) return <span className="text-[11px] text-slate-500">Not scored yet</span>
  return (
    <span className="text-xs">
      <span className={score >= 90 ? 'text-emerald-700' : score >= 70 ? 'text-ink-900' : 'text-amber-700'}>{score} / 100</span>
      <span className="block text-[11px] text-slate-500">
        {row.warmupDetails.status === 'ACTIVE' ? 'Warming up' : row.warmupDetails.status === 'PAUSED' ? 'Warm-up paused' : 'Warm-up off'}
      </span>
    </span>
  )
}

function Labels({ row }) {
  if (!row.tags?.length) return <span className="text-[11px] text-slate-500">No labels</span>
  return (
    <span className="flex flex-wrap gap-1">
      {row.tags.map((t) => <TagChip key={t.id} tag={t} />)}
    </span>
  )
}

export default function FleetList({ onMeta, onAdd }) {
  const toast = useToast()
  const [filters, setFilters] = useState(readFilters)
  const [items, setItems] = useState([])
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tags, setTags] = useState([])
  const [selected, setSelected] = useState([])
  const [openId, setOpenId] = useState(null)
  const [suspendRow, setSuspendRow] = useState(null)
  const [bulkMode, setBulkMode] = useState('')
  const [lookup, setLookup] = useState(false)
  const [fleetAll, setFleetAll] = useState([])
  const [announcement, say] = useAnnounce()

  const query = useMemo(() => toQuery(filters), [filters])
  const queryKey = JSON.stringify(query)

  const load = useCallback(async (offset = 0) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`/api/mailboxes/fleet${qs({ ...JSON.parse(queryKey), withCampaigns: 1, limit: PAGE_SIZE, offset })}`)
      setItems((prev) => (offset ? [...prev, ...(res.data || [])] : (res.data || [])))
      setMeta(res)
      onMeta?.(res)
      if (!offset) say(`${res.total} ${res.total === 1 ? 'mailbox' : 'mailboxes'} listed`)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [queryKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // The whole fleet, kept beside the filtered page so "which campaigns would
  // this leave with nothing" can be answered before a suspend is committed.
  const loadAll = useCallback(() => {
    fetchFleetAll().then(setFleetAll).catch(() => setFleetAll([]))
  }, [])

  useEffect(() => { load(0) }, [load])
  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => { writeFilters(filters) }, [filters])
  useEffect(() => {
    api.get('/api/mailboxes/tags').then((r) => setTags(r.data || [])).catch(() => setTags([]))
  }, [])

  const refresh = () => { load(0); loadAll() }
  const set = (patch) => { setFilters((f) => ({ ...f, ...patch })) }
  const active = Object.entries(filters).filter(([, v]) => v)

  const selectedRows = items.filter((r) => selected.includes(r.id))
  const allOnPage = items.length > 0 && items.every((r) => selected.includes(r.id))

  const toggleRow = (id, on) => setSelected((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)))

  const rowActions = (row) => (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-ghost px-2 py-1 text-xs cursor-pointer"
        onClick={() => setOpenId(row.id)}
        aria-label={`Open details for ${row.fromEmail}`}
      >
        Details
      </button>
      <button
        type="button"
        className="btn-ghost px-2 py-1 text-xs cursor-pointer"
        onClick={() => setSuspendRow(row)}
        aria-label={row.isSuspended ? `Resume ${row.fromEmail}` : `Suspend ${row.fromEmail}`}
      >
        {row.isSuspended ? 'Resume' : 'Suspend'}
      </button>
    </span>
  )

  return (
    <div className="space-y-4">
      <LiveRegion message={announcement} />

      {/* --- filter strip ------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-48 flex-1">
          <span className="sr-only">Filter by address or name</span>
          <input
            className="input py-1.5 text-xs"
            placeholder="Filter by address or sender name…"
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </label>
        <Select label="Provider" value={filters.provider} onChange={(v) => set({ provider: v })}
          options={[['', 'Any provider'], ['gmail', 'Gmail'], ['sandbox', 'Sandbox']]} />
        <Select label="Status" value={filters.health} onChange={(v) => set({ health: v })}
          options={[['', 'Any status'], ['sendable', 'Sending now'], ['attention', 'Needs attention'], ['noread', 'Cannot read replies'], ['unused', 'Not used by a campaign']]} />
        <Select label="Suspension" value={filters.suspended} onChange={(v) => set({ suspended: v })}
          options={[['', 'Suspended or not'], ['yes', 'Suspended'], ['no', 'Not suspended']]} />
        <Select label="Warm-up" value={filters.warmup} onChange={(v) => set({ warmup: v })}
          options={[['', 'Any warm-up'], ['ACTIVE', 'Warming up'], ['INACTIVE', 'Warm-up off'], ['PAUSED', 'Warm-up paused']]} />
        <Select label="Label" value={filters.tagId} onChange={(v) => set({ tagId: v })}
          options={[['', 'Any label'], ...tags.map((t) => [String(t.id), `${t.name} (${t.mailboxCount})`])]} />
        {active.length > 0 && (
          <button type="button" className="btn-ghost px-2 py-1 text-xs cursor-pointer" onClick={() => setFilters({ ...EMPTY })}>
            Clear {active.length} filter{active.length === 1 ? '' : 's'}
          </button>
        )}
        <button type="button" className="btn-ghost px-2 py-1 text-xs cursor-pointer" onClick={() => setLookup(true)}>
          Look up by address
        </button>
      </div>

      {meta && (
        <p className="text-xs text-slate-500">
          {plural(meta.total, 'mailbox', 'mailboxes')}
          {meta.filters?.length ? ` matching ${meta.filters.join(' + ')}` : ''}
          {items.length < meta.total ? ` · showing ${items.length}` : ''}
        </p>
      )}

      {error && <ErrorState error={error} onRetry={() => load(0)} />}
      {loading && !items.length && !error && <Skeleton rows={4} className="h-16" />}

      {!loading && !items.length && !error && (
        active.length
          ? <EmptyState icon="search" title="No mailboxes match these filters"
              hint={meta?.emptyReason || 'Clear a filter to see the rest of the fleet.'}
              action={<button className="btn-ghost cursor-pointer" onClick={() => setFilters({ ...EMPTY })}>Clear filters</button>} />
          : <EmptyState icon="mailboxes" title="No mailboxes connected"
              hint="Campaigns send from a connected mailbox. Connect a Gmail account, or add a sandbox mailbox to run everything locally without sending real email."
              action={<button className="btn-primary cursor-pointer" onClick={onAdd}>Add a mailbox</button>} />
      )}

      {/* --- the list: a real table at width, stacked cards below it ------- */}
      {items.length > 0 && (
        <>
          <div className="hidden md:block overflow-x-auto card">
            <table className="w-full min-w-[60rem] text-left text-sm">
              <caption className="sr-only">Every mailbox in this workspace, with its health, today's usage and labels</caption>
              <thead className="text-xs text-slate-600">
                <tr className="border-b border-slate-200">
                  <th scope="col" className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      className="size-4 accent-emerald-500 cursor-pointer"
                      checked={allOnPage}
                      aria-label="Select every mailbox on this page"
                      onChange={(e) => setSelected(e.target.checked
                        ? [...new Set([...selected, ...items.map((r) => r.id)])]
                        : selected.filter((id) => !items.some((r) => r.id === id)))}
                    />
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">Mailbox</th>
                  <th scope="col" className="px-3 py-2 font-medium">Sendable</th>
                  <th scope="col" className="px-3 py-2 font-medium">Health</th>
                  <th scope="col" className="px-3 py-2 font-medium">Today</th>
                  <th scope="col" className="px-3 py-2 font-medium">Reputation</th>
                  <th scope="col" className="px-3 py-2 font-medium">Labels</th>
                  <th scope="col" className="px-3 py-2 font-medium">Campaigns</th>
                  <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="border-b border-slate-200 last:border-0 align-top">
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        className="size-4 accent-emerald-500 cursor-pointer"
                        checked={selected.includes(row.id)}
                        aria-label={`Select ${row.fromEmail}`}
                        onChange={(e) => toggleRow(row.id, e.target.checked)}
                      />
                    </td>
                    <th scope="row" className="px-3 py-3 font-normal">
                      <button
                        type="button"
                        className="text-left text-ink-950 hover:text-accent-700 cursor-pointer"
                        onClick={() => setOpenId(row.id)}
                      >
                        {row.fromEmail}
                      </button>
                      <span className="block text-[11px] text-slate-500">
                        {row.fromName || 'No display name'} · {row.type === 'GMAIL' ? 'Gmail' : 'Sandbox'}
                      </span>
                      {row.isSuspended && (
                        <span className="mt-1 inline-block"><Badge value="paused" /> <span className="text-[11px] text-amber-700">Suspended{row.suspendedReason ? ` — ${row.suspendedReason}` : ''}</span></span>
                      )}
                    </th>
                    <td className="px-3 py-3"><Sendability row={row} /></td>
                    <td className="px-3 py-3">
                      <StatusWord ok={row.isSmtpSuccess}>{row.isSmtpSuccess ? 'Sending works' : 'Sending broken'}</StatusWord>
                      <span className="block"><StatusWord ok={row.isImapSuccess}>{row.isImapSuccess ? 'Reading works' : 'Cannot read replies'}</StatusWord></span>
                      {!row.isSmtpSuccess && row.smtpFailureError && (
                        <span className="mt-0.5 block text-[11px] text-slate-500">{row.smtpFailureError}</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <UsageBar used={row.sending?.sentToday ?? row.dailySentCount} cap={row.sending?.cap ?? row.messagePerDay} warmingUp={row.sending?.warmingUp} />
                      <span className="mt-0.5 block text-[11px] text-slate-500">limit {row.messagePerDay}</span>
                    </td>
                    <td className="px-3 py-3"><Reputation row={row} /></td>
                    <td className="px-3 py-3"><Labels row={row} /></td>
                    <td className="px-3 py-3 text-xs text-slate-700">{row.campaignCount}</td>
                    <td className="px-3 py-3">{rowActions(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="md:hidden space-y-3">
            {items.map((row) => (
              <li key={row.id} className="card p-3">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-emerald-500 cursor-pointer"
                    checked={selected.includes(row.id)}
                    aria-label={`Select ${row.fromEmail}`}
                    onChange={(e) => toggleRow(row.id, e.target.checked)}
                  />
                  <div className="min-w-0 flex-1">
                    <Sendability row={row} />
                    <button type="button" className="mt-1 block truncate text-left text-sm text-ink-950 hover:text-accent-700 cursor-pointer" onClick={() => setOpenId(row.id)}>
                      {row.fromEmail}
                    </button>
                    <p className="text-[11px] text-slate-500">
                      {row.fromName || 'No display name'} · {row.type === 'GMAIL' ? 'Gmail' : 'Sandbox'} · {plural(row.campaignCount, 'campaign')}
                    </p>
                    {row.isSuspended && <p className="mt-1 text-[11px] text-amber-700">Suspended{row.suspendedReason ? ` — ${row.suspendedReason}` : ''}</p>}
                    <div className="mt-2"><UsageBar used={row.sending?.sentToday ?? row.dailySentCount} cap={row.sending?.cap ?? row.messagePerDay} warmingUp={row.sending?.warmingUp} /></div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                      <StatusWord ok={row.isSmtpSuccess}>{row.isSmtpSuccess ? 'Sending works' : 'Sending broken'}</StatusWord>
                      <StatusWord ok={row.isImapSuccess}>{row.isImapSuccess ? 'Reading works' : 'Cannot read replies'}</StatusWord>
                    </div>
                    <div className="mt-2"><Labels row={row} /></div>
                    <div className="mt-3">{rowActions(row)}</div>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <LoadMore hasMore={Boolean(meta?.hasMore)} loading={loading} onClick={() => load(items.length)} />
        </>
      )}

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <button className="btn-ghost px-2 py-1 text-xs cursor-pointer" onClick={() => setBulkMode('add')}>Add labels</button>
        <button className="btn-ghost px-2 py-1 text-xs cursor-pointer" onClick={() => setBulkMode('remove')}>Remove labels</button>
      </BulkBar>

      {bulkMode && (
        <BulkLabels
          mode={bulkMode}
          rows={selectedRows}
          onClose={() => setBulkMode('')}
          onDone={refresh}
        />
      )}

      {suspendRow && (
        <SuspendDialog
          mailbox={suspendRow}
          fleet={fleetAll.length ? fleetAll : items}
          onClose={() => setSuspendRow(null)}
          onDone={(message, kind) => { toast(message, kind === 'error' ? 'error' : 'success'); say(message); refresh() }}
        />
      )}

      {openId && (
        <MailboxDrawer
          mailboxId={openId}
          fleet={fleetAll.length ? fleetAll : items}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}

      {lookup && <LabelLookup onClose={() => setLookup(false)} onChanged={refresh} />}
    </div>
  )
}
