// Leads in this campaign.
//
// `GET /campaigns/:id/leads` pages server-side and takes the same filter set as
// `GET /campaigns/:id/leads/export`, which is why the export button can honestly
// say it exports what you are looking at: one filter parser on the server serves
// both, so the file and the screen cannot disagree.
//
// Every per-lead action is its own route rather than a status field, because
// pause, resume, complete, unsubscribe, intent and mailbox pinning have
// different consequences and different confirmations. Unsubscribe is
// workspace-wide and irreversible from the UI, so it is separated from the
// reversible actions and says so.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, qs } from '../api.js'
import { BulkBar, Confirm, Drawer, LiveRegion } from '../parity-ui.jsx'
import { Badge, Modal, useToast, timeAgo } from '../ui.jsx'
import { ReplyDialog, ForwardDialog } from './SendDialogs.jsx'
import {
  ENGAGEMENTS, Field, Panel, STAGES, SkeletonRows, TableScroll,
  errorFor, messageOf, nfmt, useOffsetList, useResource,
} from './shared.jsx'

const CORE_INTENTS = ['interested', 'not interested', 'not now', 'question', 'unsubscribe', 'out of office', 'other']

const PAGE = 50

export default function LeadsPanel({ campaign, steps = [], poolMailboxes = [], sandbox = false, onChanged }) {
  const toast = useToast()
  const [filters, setFilters] = useState({ q: '', stage: '', engagement: '', createdAfter: '' })
  const [queryText, setQueryText] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState(null) // { leads: [...] }
  const [openLeadId, setOpenLeadId] = useState(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => ({ ...f, q: queryText.trim() })), 300)
    return () => clearTimeout(timer)
  }, [queryText])

  const params = useMemo(() => ({
    q: filters.q || undefined,
    stage: filters.stage || undefined,
    engagement: filters.engagement || undefined,
    createdAfter: filters.createdAfter ? new Date(`${filters.createdAfter}T00:00:00Z`).toISOString() : undefined,
  }), [filters])

  const list = useOffsetList(`/api/campaigns/${campaign.id}/leads`, params, { pick: 'leads', limit: PAGE })

  const refresh = useCallback(async () => {
    await list.reload()
    await onChanged?.()
  }, [list, onChanged])

  const filtered = Boolean(filters.q || filters.stage || filters.engagement || filters.createdAfter)
  const filterSentence = [
    filters.q && `matching “${filters.q}”`,
    filters.stage && `at stage “${filters.stage}”`,
    filters.engagement && `with engagement “${filters.engagement}”`,
    filters.createdAfter && `added on or after ${filters.createdAfter}`,
  ].filter(Boolean).join(', ')

  const exportUrl = `/api/campaigns/${campaign.id}/leads/export${qs(params)}`

  const selectedRows = list.items.filter((l) => selected.has(l.leadId))

  const runRemove = async (rows, alsoUnsubscribe) => {
    try {
      const res = await api.post(`/api/campaigns/${campaign.id}/leads/remove`, { leadIds: rows.map((r) => r.leadId) })
      if (alsoUnsubscribe) {
        for (const row of rows) {
          await api.post(`/api/campaigns/${campaign.id}/leads/${row.leadId}/unsubscribe`, {})
        }
      }
      setNote(`${res.removed} of ${rows.length} removed from this campaign`)
      toast(`Removed ${res.removed} lead${res.removed === 1 ? '' : 's'}`)
      setSelected(new Set())
      await refresh()
    } catch (err) {
      toast(messageOf(err), 'error')
    } finally { setRemoving(null) }
  }

  return (
    <Panel
      id="leads"
      title="Leads in this campaign"
      note={`${nfmt(list.total)} attached. Each lead starts at the Start node and the agent takes it from there.`}
      actions={
        <>
          <a
            className={`btn-ghost cursor-pointer py-1.5 ${list.total ? '' : 'pointer-events-none opacity-40'}`}
            href={exportUrl}
            aria-disabled={list.total ? undefined : 'true'}
            aria-label={list.total ? `Export ${list.total} leads matching your filters as CSV` : 'No leads to export'}
            download
          >
            {list.total ? `Export ${nfmt(list.total)} leads` : 'No leads to export'}
          </a>
          <button className="btn-ghost cursor-pointer py-1.5" onClick={() => setImporting(true)}>Attach leads</button>
        </>
      }
    >
      <LiveRegion message={note || (list.loading ? '' : `${list.total} leads match your filters`)} />

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-44 flex-1">
          <label className="block text-xs text-slate-600" htmlFor="lp-q">Search</label>
          <input id="lp-q" type="search" className="input mt-1" placeholder="name, email or company"
            value={queryText} onChange={(e) => setQueryText(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs text-slate-600" htmlFor="lp-stage">Stage</label>
          <select id="lp-stage" className="input mt-1 w-auto" value={filters.stage}
            onChange={(e) => setFilters((f) => ({ ...f, stage: e.target.value }))}>
            <option value="">Any stage</option>
            {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-600" htmlFor="lp-eng">Engagement</label>
          <select id="lp-eng" className="input mt-1 w-auto" value={filters.engagement}
            onChange={(e) => setFilters((f) => ({ ...f, engagement: e.target.value }))}>
            <option value="">Any engagement</option>
            {ENGAGEMENTS.map((s) => <option key={s} value={s}>{s === 'none' ? 'no engagement yet' : s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-600" htmlFor="lp-added">Added on or after</label>
          <input id="lp-added" type="date" className="input mt-1 w-auto" value={filters.createdAfter}
            onChange={(e) => setFilters((f) => ({ ...f, createdAfter: e.target.value }))} />
        </div>
        {filtered && (
          <button className="btn-ghost cursor-pointer py-1.5"
            onClick={() => { setQueryText(''); setFilters({ q: '', stage: '', engagement: '', createdAfter: '' }) }}>
            Clear filters
          </button>
        )}
      </div>

      {list.error && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {messageOf(list.error)}
          <button className="ml-2 cursor-pointer underline" onClick={list.reload}>Try again</button>
        </p>
      )}

      {!list.loading && list.items.length === 0 ? (
        filtered ? (
          <p className="text-sm text-slate-500">
            No leads {filterSentence}.{' '}
            <button className="cursor-pointer text-accent-700 underline"
              onClick={() => { setQueryText(''); setFilters({ q: '', stage: '', engagement: '', createdAfter: '' }) }}>
              Clear filters
            </button>
          </p>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm text-amber-800">No leads attached — this campaign cannot launch.</p>
            <button className="btn-primary mt-3 cursor-pointer" onClick={() => setImporting(true)}>Attach leads</button>
          </div>
        )
      ) : (
        <>
          <TableScroll label="Leads in this campaign">
            <table className="w-full min-w-[840px] text-sm">
              <caption className="sr-only">
                {list.total} leads in this campaign{filtered ? `, ${filterSentence}` : ''}
              </caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th scope="col" className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="accent-accent-500"
                      aria-label="Select every lead on this page"
                      checked={list.items.length > 0 && selected.size === list.items.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(list.items.map((l) => l.leadId)) : new Set())}
                    />
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Lead</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Stage</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Step</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">State</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Engagement</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Last activity</th>
                  <th scope="col" className="px-3 py-2.5" />
                </tr>
              </thead>
              {list.loading && !list.items.length ? (
                <SkeletonRows rows={5} cols={8} />
              ) : (
                <tbody>
                  {list.items.map((l) => (
                    <tr key={l.leadId} className="border-b border-slate-200 last:border-0 hover:bg-slate-100/40">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          className="accent-accent-500"
                          aria-label={`Select ${l.email}`}
                          checked={selected.has(l.leadId)}
                          onChange={() => setSelected((prev) => {
                            const next = new Set(prev)
                            if (next.has(l.leadId)) next.delete(l.leadId); else next.add(l.leadId)
                            return next
                          })}
                        />
                      </td>
                      <th scope="row" className="px-3 py-2.5 text-left font-normal">
                        <button className="cursor-pointer text-ink-900 hover:text-accent-700"
                          onClick={() => setOpenLeadId(l.leadId)}>
                          {[l.firstName, l.lastName].filter(Boolean).join(' ') || l.email}
                        </button>
                        <div className="text-xs text-slate-500">{l.email}{l.company ? ` · ${l.company}` : ''}</div>
                        {l.unsubscribedAt && <div className="text-[11px] text-red-700">Unsubscribed — no email may be sent</div>}
                        {l.pausedAt && !l.unsubscribedAt && (
                          <div className="text-[11px] text-amber-700" title={l.pausedAt}>Paused {timeAgo(l.pausedAt)}</div>
                        )}
                      </th>
                      <td className="px-3 py-2.5"><Badge value={l.stage} /></td>
                      <td className="px-3 py-2.5 font-mono text-xs text-accent-700">{l.node || '—'}</td>
                      <td className="px-3 py-2.5">
                        <Badge value={l.state === 'finished' ? l.outcome || 'finished' : l.state} />
                        {l.intent && <div className="mt-1 text-[11px] text-slate-600">said: {l.intent}</div>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">
                        {l.opens || l.clicks || l.replies
                          ? [l.opens && `${l.opens} open${l.opens > 1 ? 's' : ''}`, l.clicks && `${l.clicks} click${l.clicks > 1 ? 's' : ''}`, l.replies && `${l.replies} repl${l.replies > 1 ? 'ies' : 'y'}`]
                            .filter(Boolean).join(', ')
                          : <span className="text-slate-400">none yet</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-500" title={l.lastActivity}>
                        {l.lastActivity ? timeAgo(l.lastActivity) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button className="cursor-pointer text-xs text-slate-600 hover:text-accent-700"
                          aria-label={`Open ${l.email}`} onClick={() => setOpenLeadId(l.leadId)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </TableScroll>

          {list.hasMore && (
            <div className="flex justify-center py-3">
              <button className="btn-ghost cursor-pointer" disabled={list.loading} onClick={list.loadMore}>
                {list.loading ? 'Loading…' : `Load more (${nfmt(list.total - list.items.length)} left)`}
              </button>
            </div>
          )}
        </>
      )}

      <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
        <button className="btn-danger cursor-pointer py-1.5" onClick={() => setRemoving({ rows: selectedRows })}>
          Remove from campaign
        </button>
      </BulkBar>

      {removing && (
        <RemoveLeadsConfirm
          campaignName={campaign.name}
          rows={removing.rows}
          onConfirm={runRemove}
          onClose={() => setRemoving(null)}
        />
      )}

      {importing && (
        <ImportLeadsModal
          campaignId={campaign.id}
          onClose={() => setImporting(false)}
          onDone={async () => { setImporting(false); await refresh() }}
        />
      )}

      {openLeadId && (
        <LeadDrawer
          campaign={campaign}
          leadId={openLeadId}
          steps={steps}
          poolMailboxes={poolMailboxes}
          sandbox={sandbox}
          onClose={() => setOpenLeadId(null)}
          onChanged={refresh}
        />
      )}
    </Panel>
  )
}

// ------------------------------------------------------------- remove ------

function RemoveLeadsConfirm({ campaignName, rows, onConfirm, onClose }) {
  const [alsoUnsubscribe, setAlsoUnsubscribe] = useState(false)
  const [busy, setBusy] = useState(false)
  const who = rows.length === 1
    ? (rows[0].email)
    : `${rows.length} leads`

  return (
    <Modal title={rows.length === 1 ? 'Remove this lead from the campaign?' : `Remove ${rows.length} leads?`} onClose={onClose}>
      <p className="text-sm text-slate-700">
        {who} {rows.length === 1 ? 'stops' : 'stop'} receiving “{campaignName}”. Any email of theirs waiting
        for your OK is declined. They stay in your workspace and in every other campaign, and their history is kept.
      </p>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" className="mt-0.5 accent-accent-500" checked={alsoUnsubscribe}
          onChange={(e) => setAlsoUnsubscribe(e.target.checked)} />
        <span>
          Also unsubscribe {rows.length === 1 ? 'this person' : 'these people'}
          <span className="mt-0.5 block text-[11px] text-amber-700">
            That is workspace-wide and cannot be undone here — they stop receiving email from every campaign.
          </span>
        </span>
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy} autoFocus>Cancel</button>
        <button className="btn-danger cursor-pointer" disabled={busy}
          onClick={async () => { setBusy(true); await onConfirm(rows, alsoUnsubscribe) }}>
          {busy ? 'Removing…' : 'Remove from campaign'}
        </button>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------- import ------

// The backend caps an import at 400 leads per request and validates the whole
// batch before writing any of it, so one bad row means nothing lands.
const IMPORT_MAX = 400

function parseLeadText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return { leads: [], error: '' }
  const first = lines[0].toLowerCase()
  const hasHeader = first.includes('email')
  const columns = hasHeader ? lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')) : ['email']
  const body = hasHeader ? lines.slice(1) : lines
  const allowed = ['email', 'first_name', 'last_name', 'company', 'title', 'phone', 'website', 'linkedin', 'location']
  const leads = []
  for (const line of body) {
    const cells = hasHeader ? line.split(',').map((c) => c.trim()) : [line]
    const row = {}
    columns.forEach((col, i) => { if (allowed.includes(col) && cells[i]) row[col] = cells[i] })
    if (!row.email) continue
    leads.push(row)
  }
  return { leads, error: '' }
}

const SKIP_REASONS = {
  blocked: 'on your blocked list',
  unsubscribed: 'unsubscribed',
  bounced: 'previously bounced',
  in_another_campaign: 'already in another campaign',
  already_in_campaign: 'already in this campaign',
}

// Two ways in — pick from the workspace, or paste a list — reaching the same
// import route and therefore the same summary. Both go through
// `POST /leads/import`, so suppression, the per-reason skips and the 400 cap
// behave identically whichever path was used.
function ImportLeadsModal({ campaignId, onClose, onDone }) {
  const toast = useToast()
  const [mode, setMode] = useState('existing')
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState(() => new Set())
  const [allowElsewhere, setAllowElsewhere] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [result, setResult] = useState(null)
  const [search, setSearch] = useState('')

  const workspace = useResource('/api/leads', { enabled: mode === 'existing' })
  const available = useMemo(() => {
    const all = Array.isArray(workspace.data) ? workspace.data : workspace.data?.leads || []
    const q = search.trim().toLowerCase()
    return all.filter((l) => l.status === 'active')
      .filter((l) => !q || `${l.email} ${l.first_name || ''} ${l.last_name || ''} ${l.company || ''}`.toLowerCase().includes(q))
  }, [workspace.data, search])

  const parsed = useMemo(() => parseLeadText(text), [text])
  const payload = mode === 'paste'
    ? parsed.leads
    : (Array.isArray(workspace.data) ? workspace.data : workspace.data?.leads || [])
      .filter((l) => chosen.has(l.id)).map((l) => ({ email: l.email }))
  const tooMany = payload.length > IMPORT_MAX

  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await api.post(`/api/campaigns/${campaignId}/leads/import`, {
        leads: payload,
        settings: { allowLeadsInOtherCampaigns: allowElsewhere },
      })
      setResult(res)
      toast(`Attached ${res.addedCount} lead${res.addedCount === 1 ? '' : 's'}`)
    } catch (error) {
      setErr(error)
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Attach leads" onClose={onClose} wide>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-900" role="status">
            {nfmt(result.addedCount)} added, {nfmt(result.skippedCount)} skipped.
          </p>
          {result.skippedCount > 0 && (
            <ul className="space-y-1 text-sm text-slate-600">
              {Object.entries(result.skippedByReason || {}).map(([reason, count]) => (
                <li key={reason}>{nfmt(count)} {SKIP_REASONS[reason] || reason}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-500">
            Suppression is unconditional in Harry: an unsubscribed or blocked address cannot be imported by any route.
          </p>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost cursor-pointer" onClick={() => { setResult(null); setText('') }}>Attach more</button>
            <button className="btn-primary cursor-pointer" onClick={onDone}>Done</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="How to attach leads">
            {[['existing', 'From your leads'], ['paste', 'Paste a list']].map(([id, label]) => (
              <button
                key={id}
                role="tab"
                id={`imp-tab-${id}`}
                aria-controls="imp-panel"
                aria-selected={mode === id}
                className={`cursor-pointer border-b-2 px-3 py-2 text-sm ${
                  mode === id ? 'border-accent-500 font-medium text-accent-700' : 'border-transparent text-slate-600 hover:text-ink-900'
                }`}
                onClick={() => setMode(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* The pane is a real tabpanel tied back to whichever tab chose it. */}
          <div role="tabpanel" id="imp-panel" aria-labelledby={`imp-tab-${mode}`}>
          {mode === 'existing' ? (
            <>
              <label className="block text-xs text-slate-600" htmlFor="imp-search">
                Search your leads
                <input id="imp-search" type="search" className="input mt-1" value={search}
                  onChange={(e) => setSearch(e.target.value)} />
              </label>
              {workspace.error ? (
                <p className="text-sm text-red-700" role="alert">
                  {messageOf(workspace.error)} <button className="cursor-pointer underline" onClick={workspace.reload}>Try again</button>
                </p>
              ) : workspace.loading && !workspace.data ? (
                <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-10 rounded bg-slate-100 animate-pulse" />)}</div>
              ) : available.length === 0 ? (
                <p className="text-sm text-slate-500">
                  {search ? `No active leads match “${search}”.` : 'No active leads in this workspace yet — add some on the Leads page, or paste a list.'}
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span>{chosen.size} of {available.length} selected</span>
                    <button className="cursor-pointer hover:text-accent-700"
                      onClick={() => setChosen(chosen.size === available.length ? new Set() : new Set(available.map((l) => l.id)))}>
                      {chosen.size === available.length ? 'Clear all' : 'Select all'}
                    </button>
                  </div>
                  <ul className="max-h-72 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200">
                    {available.map((l) => (
                      <li key={l.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-100/50">
                          <input
                            type="checkbox"
                            className="accent-accent-500"
                            checked={chosen.has(l.id)}
                            onChange={() => setChosen((prev) => {
                              const next = new Set(prev)
                              if (next.has(l.id)) next.delete(l.id); else next.add(l.id)
                              return next
                            })}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-ink-900">
                              {[l.first_name, l.last_name].filter(Boolean).join(' ') || l.email}
                            </span>
                            <span className="block truncate text-xs text-slate-500">{l.email}{l.company ? ` · ${l.company}` : ''}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {errorFor(err, 'leads') && <p className="text-[11px] text-red-700" role="alert">{errorFor(err, 'leads')}</p>}
            </>
          ) : (
            <Field
              label="Paste leads"
              htmlFor="imp-text"
              hint="One email per line, or CSV with a header row using any of: email, first_name, last_name, company, title, phone, website, linkedin, location."
              error={errorFor(err, 'leads')}
            >
              <textarea
                id="imp-text"
                className="input min-h-44 font-mono text-[13px]"
                autoFocus
                spellCheck={false}
                placeholder={'email,first_name,company\npriya@northwind.example,Priya,Northwind'}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          )}
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5 accent-accent-500" checked={allowElsewhere}
              onChange={(e) => setAllowElsewhere(e.target.checked)} />
            <span>
              Allow leads that are already in another campaign
              <span className="mt-0.5 block text-[11px] text-slate-500">
                Off by default, so the same person is not approached twice at once.
              </span>
            </span>
          </label>

          <p className="text-xs text-slate-500">
            {payload.length
              ? `${nfmt(payload.length)} address${payload.length === 1 ? '' : 'es'} ready.`
              : 'Nothing selected yet.'}
            {tooMany && <span className="text-amber-700"> At most {IMPORT_MAX} per import — trim the list and run it again.</span>}
          </p>

          {err && !errorFor(err, 'leads') && <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>}

          <div className="flex justify-end gap-2">
            <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-primary cursor-pointer" disabled={busy || !payload.length || tooMany} onClick={run}>
              {busy ? 'Attaching…' : `Attach ${payload.length || ''}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// --------------------------------------------------------------- drawer ----

function LeadDrawer({ campaign, leadId, steps, poolMailboxes, sandbox, onClose, onChanged }) {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [resumeDays, setResumeDays] = useState(0)
  const [showResumeDelay, setShowResumeDelay] = useState(false)
  const [confirming, setConfirming] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [forwardOf, setForwardOf] = useState(null)
  const [intent, setIntent] = useState('')
  const [intentPause, setIntentPause] = useState(false)
  const [simulating, setSimulating] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try { setData(await api.get(`/api/campaigns/${campaign.id}/leads/${leadId}`)) } catch (err) { setError(err) }
  }, [campaign.id, leadId])

  useEffect(() => { load() }, [load])

  const intents = useMemo(() => {
    const fromPlaybook = steps.flatMap((s) => s.replyIntents || [])
    return [...new Set([...CORE_INTENTS, ...fromPlaybook])].filter(Boolean).sort()
  }, [steps])

  const act = async (label, fn) => {
    setBusy(label)
    try {
      const res = await fn()
      setNote(res?.message || `${label} done`)
      toast(label)
      await load()
      await onChanged?.()
    } catch (err) {
      toast(messageOf(err), 'error')
      setNote(messageOf(err))
    } finally { setBusy(''); setConfirming('') }
  }

  const lead = data?.lead
  const position = data?.position
  const paused = Boolean(position?.pausedAt)
  const resumeDate = resumeDays > 0
    ? new Date(Date.now() + resumeDays * 86400e3).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : ''

  // What the chosen intent would do next, said before it is committed.
  const nextForIntent = useMemo(() => {
    if (!intent || !position?.node) return ''
    if (intent === 'unsubscribe') return 'stops this lead everywhere and marks them unsubscribed'
    const step = steps.find((s) => s.nodeId === position.node)
    const edge = step?.branches?.find((b) => b.condition?.kind === 'reply' && (b.condition.intent === intent || b.condition.intent === null))
    return edge ? `moves them to “${edge.to}”` : 'has no matching edge here, so the lead is flagged for your attention'
  }, [intent, position, steps])

  return (
    <Drawer title={lead ? (lead.email) : 'Lead'} onClose={onClose}>
      <LiveRegion message={note} />
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {messageOf(error)} <button className="cursor-pointer underline" onClick={load}>Try again</button>
        </p>
      ) : !data ? (
        <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded bg-slate-100 animate-pulse" />)}</div>
      ) : (
        <div className="space-y-5">
          <section>
            <h3 className="text-sm font-semibold text-ink-900">
              {[lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email}
            </h3>
            <p className="text-xs text-slate-500">
              {[lead.title, lead.company, lead.location].filter(Boolean).join(' · ') || 'No company details'}
            </p>
            {lead.status === 'unsubscribed' && (
              <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                Unsubscribed{lead.unsubscribedAt ? ` on ${String(lead.unsubscribedAt).slice(0, 10)}` : ''} — no email may be sent to them from any campaign.
              </p>
            )}
            {lead.status === 'bounced' && (
              <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                Their address bounced — nothing more will be sent to it.
              </p>
            )}
          </section>

          <section>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Where they are</h3>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div><dt className="text-xs text-slate-500">Stage</dt><dd><Badge value={lead.stage} /></dd></div>
              <div><dt className="text-xs text-slate-500">State</dt><dd><Badge value={position.state} /></dd></div>
              <div><dt className="text-xs text-slate-500">Step</dt><dd className="font-mono text-xs text-accent-700">{position.node || '—'}</dd></div>
              <div><dt className="text-xs text-slate-500">Last said</dt><dd className="text-slate-700">{position.intent || '—'}</dd></div>
              {position.waitUntil && (
                <div className="col-span-2"><dt className="text-xs text-slate-500">Waiting until</dt><dd className="text-slate-700">{new Date(position.waitUntil).toLocaleString()}</dd></div>
              )}
              {position.resumeAt && (
                <div className="col-span-2"><dt className="text-xs text-slate-500">Scheduled to resume</dt><dd className="text-slate-700">{new Date(position.resumeAt).toLocaleString()}</dd></div>
              )}
            </dl>
            {data.positions?.length > 1 && (
              <p className="mt-2 text-[11px] text-slate-500">
                Also in: {data.positions.filter((p) => p.campaignId !== campaign.id).map((p) => p.campaign).join(', ')}
              </p>
            )}
          </section>

          <section>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Actions</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className="btn-ghost cursor-pointer py-1.5"
                aria-pressed={paused}
                disabled={Boolean(busy) || lead.status === 'unsubscribed'}
                onClick={() => {
                  if (paused) setShowResumeDelay(true)
                  else act('Lead paused', () => api.post(`/api/campaigns/${campaign.id}/leads/${leadId}/pause`, {}))
                }}
              >
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button className="btn-ghost cursor-pointer py-1.5" disabled={Boolean(busy)} onClick={() => setConfirming('complete')}>
                Mark as done
              </button>
              {sandbox && (
                <button className="btn-ghost cursor-pointer py-1.5" disabled={Boolean(busy)} onClick={() => setSimulating(true)}>
                  Simulate a reply
                </button>
              )}
              <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />
              <button className="btn-danger cursor-pointer py-1.5" disabled={Boolean(busy) || lead.status === 'unsubscribed'}
                onClick={() => setConfirming('unsubscribe')}>
                Unsubscribe
              </button>
            </div>
            {paused && (
              <p className="mt-1.5 text-[11px] text-amber-700" title={position.pausedAt}>
                Paused {timeAgo(position.pausedAt)}. Nothing is sent to them in this campaign until you resume.
              </p>
            )}

            {showResumeDelay && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
                <fieldset>
                  <legend className="text-xs text-slate-600">When should the sequence pick back up?</legend>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                      <input type="radio" name="resume-when" className="accent-accent-500" checked={resumeDays === 0}
                        onChange={() => setResumeDays(0)} />
                      Now
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                      <input type="radio" name="resume-when" className="accent-accent-500" checked={resumeDays > 0}
                        onChange={() => setResumeDays(7)} />
                      In
                    </label>
                    {resumeDays > 0 && (
                      <>
                        <label className="text-sm text-slate-700">
                          <span className="sr-only">Number of days before resuming</span>
                          <input type="number" min="1" max="365" className="input w-20" value={resumeDays}
                            onChange={(e) => setResumeDays(Math.max(1, Number(e.target.value) || 1))} />
                        </label>
                        <span className="text-sm text-slate-600">days — that is {resumeDate}</span>
                      </>
                    )}
                  </div>
                </fieldset>
                <div className="mt-3 flex justify-end gap-2">
                  <button className="btn-ghost cursor-pointer py-1.5" onClick={() => setShowResumeDelay(false)}>Cancel</button>
                  <button
                    className="btn-primary cursor-pointer py-1.5"
                    disabled={Boolean(busy)}
                    onClick={async () => {
                      setShowResumeDelay(false)
                      await act('Lead resumed', () => api.post(`/api/campaigns/${campaign.id}/leads/${leadId}/resume`, { delay_days: resumeDays }))
                    }}
                  >
                    {resumeDays > 0 ? `Resume on ${resumeDate}` : 'Resume now'}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">What they said</h3>
            <div className="mt-2 space-y-2">
              <label className="block text-sm">
                <span className="text-xs text-slate-500">Reclassify their reply</span>
                <select className="input mt-1" value={intent} onChange={(e) => setIntent(e.target.value)} aria-label="Reply intent">
                  <option value="">Leave as {position.intent || 'unclassified'}</option>
                  {intents.map((i) => <option key={i} value={i}>{i}</option>)}
                </select>
              </label>
              {intent && <p className="text-[11px] text-slate-600">Choosing “{intent}” {nextForIntent}.</p>}
              {intent === 'unsubscribe' && (
                <p className="text-[11px] text-amber-700">
                  Unsubscribe applies across the whole workspace, not just this campaign.
                </p>
              )}
              <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" className="mt-0.5 accent-accent-500" checked={intentPause}
                  onChange={(e) => setIntentPause(e.target.checked)} />
                Pause this lead too
              </label>
              <button
                className="btn-ghost cursor-pointer py-1.5"
                disabled={!intent || Boolean(busy)}
                onClick={() => act('Reply reclassified', () =>
                  api.post(`/api/campaigns/${campaign.id}/leads/${leadId}/intent`, { intent, pause: intentPause })
                    .then((r) => { setIntent(''); return r }))}
              >
                Apply
              </button>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Send from</h3>
            <label className="mt-2 block text-sm">
              <span className="sr-only">Mailbox this lead is sent from</span>
              <select
                className="input"
                value={position.mailboxId || ''}
                disabled={Boolean(busy)}
                onChange={(e) => {
                  const value = e.target.value
                  act(value ? 'Mailbox pinned' : 'Pin cleared', () =>
                    api.post(`/api/campaigns/${campaign.id}/leads/${leadId}/mailbox`,
                      value ? { mailbox_id: Number(value) } : { mailbox_id: null }))
                }}
              >
                <option value="">Rotation — any mailbox in the pool</option>
                {poolMailboxes.map((m) => (
                  <option key={m.id} value={m.id}>{m.email}{m.remainingToday === 0 ? ' (at its daily cap)' : ''}</option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-[11px] text-slate-500">
              Pinning changes the sender mid-thread if this lead has already been written to.
            </p>
          </section>

          <MessageHistory
            campaignId={campaign.id}
            leadId={leadId}
            initial={data.messages}
            onReply={setReplyTo}
            onForward={setForwardOf}
          />
        </div>
      )}

      {confirming === 'complete' && (
        <Confirm
          title="Mark this lead as done?"
          confirmLabel="Mark as done"
          body={
            `${lead?.email} stops receiving “${campaign.name}”. This is this campaign only — they are NOT `
            + 'unsubscribed, and other campaigns are untouched. Any email of theirs waiting for your OK is declined.'
          }
          onConfirm={() => act('Lead marked done', () => api.post(`/api/campaigns/${campaign.id}/leads/${leadId}/complete`, {}))}
          onClose={() => setConfirming('')}
        />
      )}
      {confirming === 'unsubscribe' && (
        <Confirm
          title="Unsubscribe this person?"
          danger
          confirmLabel="Unsubscribe everywhere"
          body={
            `${[lead?.firstName, lead?.lastName].filter(Boolean).join(' ') || lead?.email} (${lead?.email}) stops `
            + 'receiving email from every campaign in this workspace, now and in future. Queued emails are declined. '
            + 'This cannot be undone from here.'
          }
          onConfirm={() => act('Lead unsubscribed', () => api.post(`/api/campaigns/${campaign.id}/leads/${leadId}/unsubscribe`, {}))}
          onClose={() => setConfirming('')}
        />
      )}

      {replyTo && (
        <ReplyDialog
          campaignId={campaign.id}
          message={replyTo}
          leadEmail={lead?.email}
          onClose={() => setReplyTo(null)}
          onSent={async () => { setReplyTo(null); await load(); await onChanged?.() }}
        />
      )}
      {forwardOf && (
        <ForwardDialog
          campaignId={campaign.id}
          message={forwardOf}
          onClose={() => setForwardOf(null)}
          onSent={async () => { setForwardOf(null); await load() }}
        />
      )}

      {simulating && (
        <SimulateReplyModal
          campaignId={campaign.id}
          leadId={leadId}
          email={lead?.email}
          onClose={() => setSimulating(false)}
          onDone={async () => { setSimulating(false); await load(); await onChanged?.() }}
        />
      )}
    </Drawer>
  )
}

const CANNED_REPLIES = [
  ['Interested', 'This sounds interesting — tell me more. Happy to jump on a call.'],
  ['Question', 'How does this integrate with our existing CRM?'],
  ['Not now', 'Not right now — maybe circle back next quarter.'],
  ['Not interested', 'Thanks, but we’re not interested.'],
  ['Unsubscribe', 'Please unsubscribe me from these emails.'],
]

// Sandbox mailboxes let the whole loop be tested without putting anything on the
// wire, so this is not one of the three dialogs that need a send confirmation.
function SimulateReplyModal({ campaignId, leadId, email, onClose, onDone }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async () => {
    setBusy(true)
    try {
      await api.post(`/api/campaigns/${campaignId}/leads/${leadId}/simulate-reply`, { text })
      await api.post('/api/engine/tick')
      toast('Reply simulated — the agent classified and routed it')
      onDone()
    } catch (err) { toast(messageOf(err), 'error'); setBusy(false) }
  }

  return (
    <Modal title={`Simulate a reply from ${email}`} onClose={onClose}>
      <p className="mb-3 text-xs text-slate-500">
        Sandbox only — nothing is sent or received for real. The agent classifies this text and follows the
        matching edge, exactly as it would a genuine reply.
      </p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {CANNED_REPLIES.map(([label, body]) => (
          <button key={label} className="cursor-pointer rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:border-accent-500"
            onClick={() => setText(body)}>{label}</button>
        ))}
      </div>
      <textarea className="input min-h-28" placeholder="Type the reply the lead would send…" value={text}
        onChange={(e) => setText(e.target.value)} aria-label="Simulated reply text" />
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary cursor-pointer" disabled={!text.trim() || busy} onClick={send}>
          {busy ? 'Routing…' : 'Simulate reply'}
        </button>
      </div>
    </Modal>
  )
}

function MessageHistory({ campaignId, leadId, initial, onReply, onForward }) {
  const [messages, setMessages] = useState(null)
  const [error, setError] = useState(null)
  const [tracking, setTracking] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.get(`/api/campaigns/${campaignId}/leads/${leadId}/messages${qs({ limit: 50 })}`)
      .then((res) => { if (!cancelled) { setMessages(res.messages); setTracking(res.tracking) } })
      .catch((err) => { if (!cancelled) setError(err) })
    return () => { cancelled = true }
  }, [campaignId, leadId])

  const rows = messages ?? initial ?? []

  return (
    <section>
      <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Messages</h3>
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{messageOf(error)}</p>}
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          No messages yet — either nothing has been sent to them, or an email is still waiting for your OK.
        </p>
      ) : (
        <ol className="mt-2 space-y-2">
          {rows.map((m) => (
            <li key={m.id}>
              <article
                className="rounded-lg border border-slate-200 bg-white p-3"
                aria-label={`${m.direction === 'in' ? 'Reply from the lead' : 'Email sent'} — ${m.subject || 'no subject'} — ${m.createdAt}`}
              >
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  <span className={m.direction === 'in' ? 'text-indigo-700' : 'text-slate-600'}>
                    {m.direction === 'in' ? 'Reply received' : 'Email sent'}
                  </span>
                  {m.isTest && <span className="text-amber-700">test — excluded from reports</span>}
                  {m.nodeId && <span className="font-mono text-accent-700">{m.nodeId}</span>}
                  <span title={m.createdAt}>{timeAgo(m.createdAt)}</span>
                  {m.openedAt && <span className="text-emerald-700">opened</span>}
                  {m.clickedAt && <span className="text-emerald-700">clicked</span>}
                  {m.direction === 'out' && tracking && !tracking.opens && <span>opens not tracked</span>}
                </div>
                <div className="mt-1 text-sm text-ink-900">{m.subject || '(no subject)'}</div>
                {m.intent && (
                  <div className="mt-1 text-[11px] text-slate-600">
                    Classified as “{m.intent}”
                    {m.followedEdge && ` — followed the edge to ${m.followedEdge.to}`}
                  </div>
                )}
                {m.body && (
                  <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">
                    {String(m.body).replace(/<[^>]+>/g, '')}
                  </pre>
                )}
                <div className="mt-2 flex gap-3">
                  <button className="cursor-pointer text-xs text-slate-600 hover:text-accent-700"
                    aria-label={`Reply to ${m.subject || 'this message'}`} onClick={() => onReply(m)}>Reply</button>
                  <button className="cursor-pointer text-xs text-slate-600 hover:text-accent-700"
                    aria-label={`Forward ${m.subject || 'this message'}`} onClick={() => onForward(m)}>Forward</button>
                </div>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
