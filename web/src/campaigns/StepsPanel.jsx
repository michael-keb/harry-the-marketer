// Steps, node performance and the emails behind them.
//
// SmartLead's "sequences" are Harry's playbook nodes, so `GET
// /campaigns/:id/steps` is a *projection of the diagram*, not a second model of
// it — which is why this view is strictly read-only. The diagram is the editor;
// a second editable step list would be two sources of truth for one thing.
//
// `GET /campaigns/:id/step-statistics` is the per-node breakdown underneath:
// the same rollup as the metrics strip, plus every individual email with its
// step and its open/click/bounce state. It is collapsed by default because it
// is a long table that most visits do not need.

import { useMemo, useState } from 'react'
import { qs } from '../api.js'
import {
  Panel, SkeletonRows, TableScroll, messageOf, nfmt, useOffsetList, useResource,
} from './shared.jsx'

function waitText(ms) {
  if (!ms) return ''
  const days = ms / 86400e3
  if (days >= 1) return `${Math.round(days * 10) / 10} day${days === 1 ? '' : 's'}`
  const hours = ms / 3600e3
  if (hours >= 1) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`
  return `${Math.round(ms / 60000)} minutes`
}

function conditionText(branch) {
  const cond = branch.condition || {}
  if (cond.kind === 'reply') return cond.intent ? `if they reply “${cond.intent}”` : 'if they reply at all'
  if (cond.kind === 'noreply') return branch.label ? `if they do not reply — ${branch.label}` : 'if they do not reply'
  return branch.label ? `${branch.label}` : 'then'
}

// ------------------------------------------------------------ step list ----

export function StepsList({ campaignId, onTestSend, selectedNode, onSelectNode }) {
  const { data, loading, error, reload } = useResource(`/api/campaigns/${campaignId}/steps${qs({ sample: 1 })}`)

  return (
    <Panel
      id="steps"
      title="Steps"
      note="A read-only reading of the diagram, in the order a lead meets it. To change a step, edit the diagram — this list follows it."
      actions={<button className="btn-ghost cursor-pointer py-1.5 text-xs" onClick={reload} disabled={loading}>Refresh</button>}
    >
      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {messageOf(error)} <button className="cursor-pointer underline" onClick={reload}>Try again</button>
        </p>
      ) : loading && !data ? (
        <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-lg bg-slate-100 animate-pulse" />)}</div>
      ) : data && !data.valid ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">The diagram does not parse, so there are no steps to show yet.</p>
          <ul className="mt-2 space-y-1 text-xs text-red-700">
            {(data.errors || []).map((e, i) => <li key={i}>{e.line ? `Line ${e.line}: ` : ''}{e.message}</li>)}
          </ul>
        </div>
      ) : !data?.steps?.length ? (
        <p className="text-sm text-slate-500">No steps yet — draw a Send node in the diagram, or use Generate with AI.</p>
      ) : (
        <ol className="space-y-2">
          {data.steps.map((s) => (
            <li key={s.nodeId}>
              <article
                className={`rounded-lg border bg-white p-3 ${selectedNode === s.nodeId ? 'border-accent-500' : 'border-slate-200'}`}
                aria-label={`Step ${s.position + 1}: ${s.label}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    className="cursor-pointer text-left"
                    aria-pressed={selectedNode === s.nodeId}
                    onClick={() => onSelectNode?.(selectedNode === s.nodeId ? '' : s.nodeId)}
                  >
                    <span className="text-xs text-slate-500">Step {s.position + 1}</span>{' '}
                    <span className="font-mono text-xs text-accent-700">{s.nodeId}</span>{' '}
                    <span className="text-sm text-ink-900">{s.label}</span>
                  </button>
                  <div className="flex items-center gap-3 text-[11px] text-slate-500">
                    <span>{s.type}</span>
                    {s.waitMs ? <span>waits {waitText(s.waitMs)}</span> : null}
                    <span>{nfmt(s.sent)} sent</span>
                    {s.type === 'send' && onTestSend && (
                      <button className="cursor-pointer text-slate-600 underline hover:text-accent-700"
                        aria-label={`Send me a test of ${s.label}`} onClick={() => onTestSend(s.nodeId)}>
                        Send me a test
                      </button>
                    )}
                  </div>
                </div>

                {s.instruction && <p className="mt-1 text-xs text-slate-600">{s.instruction}</p>}

                {s.branches?.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-[11px] text-slate-500">
                    {s.branches.map((b, i) => (
                      <li key={i}>{conditionText(b)} → <span className="font-mono text-accent-600">{b.to}</span></li>
                    ))}
                  </ul>
                )}

                {s.sample && (
                  <section className="mt-2 rounded border border-slate-200 bg-white p-2" aria-label={`Approved copy for step ${s.nodeId}`}>
                    <div className="text-[11px] text-slate-500">Approved copy — a sample, personalised per lead before it sends</div>
                    <div className="mt-1 text-xs text-slate-700">{s.sample.subject}</div>
                    <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">{s.sample.body}</pre>
                  </section>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
      {data?.warnings?.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-amber-700">
          {data.warnings.map((w, i) => <li key={i}>Warning: {w.message}</li>)}
        </ul>
      )}
    </Panel>
  )
}

// ------------------------------------------------------ node performance ----

export function NodePerformance({ nodeStats = [], selectedNode, onSelectNode }) {
  if (!nodeStats.some((n) => n.sent || n.leadsHere)) return null
  return (
    <Panel
      id="node-performance"
      title="Node performance"
      note="Where the playbook converts, and where leads are standing right now."
    >
      <TableScroll label="Node performance">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th scope="col" className="px-3 py-2.5 font-medium">Node</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Step</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Emails sent</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Leads here now</th>
            </tr>
          </thead>
          <tbody>
            {nodeStats.map((n) => (
              <tr
                key={n.id}
                className={`border-b border-slate-200 last:border-0 ${selectedNode === n.id ? 'bg-slate-100/60' : 'hover:bg-slate-100/40'}`}
              >
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {/* The visible name is the bare node id ("A", "W2"), which says
                      nothing on its own — the label carries what it does. */}
                  <button className="cursor-pointer font-mono text-xs text-accent-700"
                    aria-pressed={selectedNode === n.id}
                    aria-label={`Step ${n.id} — ${n.label}`}
                    onClick={() => onSelectNode?.(selectedNode === n.id ? '' : n.id)}>
                    {n.id}
                  </button>
                </th>
                <td className="max-w-md truncate px-3 py-2 text-slate-700" title={n.label}>{n.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{nfmt(n.sent)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{nfmt(n.leadsHere)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  )
}

// ----------------------------------------------------------- email table ----

const STATUS_FILTERS = ['sent', 'opened', 'clicked', 'replied', 'bounced']

export function EmailsTable({ campaignId, steps = [], step, onStepChange }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })

  const params = useMemo(() => ({
    step: step || undefined,
    status: status || undefined,
    from: range.from && range.to ? new Date(`${range.from}T00:00:00Z`).toISOString() : undefined,
    to: range.from && range.to ? new Date(`${range.to}T23:59:59Z`).toISOString() : undefined,
  }), [step, status, range])

  const list = useOffsetList(`/api/campaigns/${campaignId}/step-statistics`, params, {
    pick: 'rows', limit: 50, enabled: open,
  })

  const filtered = Boolean(step || status || (range.from && range.to))

  return (
    <Panel
      id="emails"
      title="Emails"
      note="Every email this campaign has sent, with the step it came from and what happened to it. Test sends are excluded."
      actions={
        <button className="btn-ghost cursor-pointer py-1.5 text-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide emails' : 'Show emails'}
        </button>
      }
    >
      {!open ? (
        <p className="text-sm text-slate-500">Collapsed — this is a long table, so it only loads when you ask for it.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-slate-600" htmlFor="st-step">Step</label>
              <select id="st-step" className="input mt-1 w-auto" value={step} onChange={(e) => onStepChange?.(e.target.value)}>
                <option value="">Any step</option>
                {steps.map((s) => <option key={s.nodeId} value={s.nodeId}>{s.label || s.nodeId}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-600" htmlFor="st-status">Outcome</label>
              <select id="st-status" className="input mt-1 w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Any outcome</option>
                {STATUS_FILTERS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-600" htmlFor="st-from">Sent from</label>
              <input id="st-from" type="date" className="input mt-1 w-auto" value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs text-slate-600" htmlFor="st-to">Sent to</label>
              <input id="st-to" type="date" className="input mt-1 w-auto" value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </div>
            {filtered && (
              <button className="btn-ghost cursor-pointer py-1.5"
                onClick={() => { onStepChange?.(''); setStatus(''); setRange({ from: '', to: '' }) }}>
                Clear filters
              </button>
            )}
          </div>

          {list.error && (
            <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {messageOf(list.error)} <button className="cursor-pointer underline" onClick={list.reload}>Try again</button>
            </p>
          )}

          {list.meta?.rollup && (
            <p className="mb-2 text-xs text-slate-500">
              {nfmt(list.meta.rollup.sent)} sent · {nfmt(list.meta.rollup.opened)} opened ·
              {' '}{nfmt(list.meta.rollup.clicked)} clicked · {nfmt(list.meta.rollup.replied)} replies ·
              {' '}{nfmt(list.meta.rollup.bounced)} bounced
              {list.meta.rollup.opened === 0 && list.meta.rollup.sent > 0 && (
                <span className="text-amber-700"> — no opens recorded; check open tracking is on before reading that as silence.</span>
              )}
            </p>
          )}

          {!list.loading && list.items.length === 0 ? (
            <p className="text-sm text-slate-500">
              {filtered ? 'No emails match these filters.' : 'No emails sent yet.'}
            </p>
          ) : (
            <>
              <TableScroll label="Emails sent by this campaign">
                <table className="w-full min-w-[720px] text-sm">
                  <caption className="sr-only">{list.total} emails{filtered ? ', filtered' : ''}, newest first</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th scope="col" className="px-3 py-2.5 font-medium">Lead</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Step</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Subject</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Sent</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Outcome</th>
                    </tr>
                  </thead>
                  {list.loading && !list.items.length ? (
                    <SkeletonRows rows={5} cols={5} />
                  ) : (
                    <tbody>
                      {list.items.map((r) => (
                        <tr key={r.messageId} className="border-b border-slate-200 last:border-0 hover:bg-slate-100/40">
                          <th scope="row" className="px-3 py-2 text-left font-normal text-slate-700">{r.email}</th>
                          <td className="px-3 py-2 font-mono text-xs text-accent-700">{r.step || '—'}</td>
                          <td className="max-w-xs truncate px-3 py-2 text-slate-600" title={r.subject}>{r.subject}</td>
                          <td className="px-3 py-2 text-xs text-slate-500" title={r.sentAt}>{r.sentAt?.slice(0, 16).replace('T', ' ')}</td>
                          <td className="px-3 py-2 text-xs">
                            <span className="flex flex-wrap gap-2">
                              {r.bounced && <span className="text-red-700">bounced</span>}
                              {r.openedAt && <span className="text-emerald-700">opened</span>}
                              {r.clickedAt && <span className="text-emerald-700">clicked</span>}
                              {!r.bounced && !r.openedAt && !r.clickedAt && <span className="text-slate-500">delivered</span>}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  )}
                </table>
              </TableScroll>
              <p className="mt-2 text-xs text-slate-500">Showing {nfmt(list.items.length)} of {nfmt(list.total)}</p>
              {list.hasMore && (
                <div className="flex justify-center py-3">
                  <button className="btn-ghost cursor-pointer" disabled={list.loading} onClick={list.loadMore}>
                    {list.loading ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Panel>
  )
}
