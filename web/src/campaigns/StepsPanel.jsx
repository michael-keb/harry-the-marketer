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

const STEP_KIND = {
  send: { label: 'Send', rail: 'bg-sky-500', pill: 'bg-sky-50 text-sky-700 ring-sky-200' },
  wait: { label: 'Wait', rail: 'bg-amber-400', pill: 'bg-amber-50 text-amber-800 ring-amber-200' },
  terminal: { label: 'Finish', rail: 'bg-slate-400', pill: 'bg-slate-100 text-slate-600 ring-slate-200' },
  decision: { label: 'Branch', rail: 'bg-indigo-500', pill: 'bg-indigo-50 text-indigo-700 ring-indigo-200' },
  start: { label: 'Start', rail: 'bg-accent-500', pill: 'bg-accent-50 text-accent-700 ring-accent-200' },
}

function terminalKind(step) {
  if (step.type !== 'terminal') return null
  if (step.outcome === 'won') return { label: 'Won', rail: 'bg-emerald-500', pill: 'bg-emerald-50 text-emerald-700 ring-emerald-200' }
  if (step.outcome === 'lost') return { label: 'Lost', rail: 'bg-red-400', pill: 'bg-red-50 text-red-700 ring-red-200' }
  if (step.outcome === 'unsubscribed') return { label: 'Unsubscribed', rail: 'bg-slate-400', pill: 'bg-slate-100 text-slate-600 ring-slate-200' }
  return STEP_KIND.terminal
}

function stepKind(step) {
  return terminalKind(step) || STEP_KIND[step.type] || STEP_KIND.decision
}

function stepTitle(step) {
  if (step.instruction) return step.instruction
  const label = String(step.label || '').replace(/^(send|wait)\s*[:=]?\s*/i, '').trim()
  return label || step.label || step.nodeId
}

function branchSummary(branch) {
  const cond = branch.condition || {}
  if (cond.kind === 'reply') return cond.intent ? `Reply: “${cond.intent}”` : 'Any reply'
  if (cond.kind === 'no_reply') {
    const wait = cond.ms ? waitText(cond.ms) : ''
    return wait ? `No reply · ${wait}` : 'No reply'
  }
  if (cond.kind === 'after') return cond.ms ? `After ${waitText(cond.ms)}` : 'Then'
  if (cond.kind === 'always') return 'Then'
  return branch.label || 'Then'
}

function StepCard({ step, selected, onSelect, onTestSend }) {
  const kind = stepKind(step)
  const selectedCls = selected ? 'border-accent-500 ring-2 ring-accent-500/20 shadow-sm' : 'border-slate-200 hover:border-slate-300'

  return (
    <article
      className={`relative overflow-hidden rounded-xl border bg-white transition-colors ${selectedCls}`}
      aria-label={`Step ${step.position + 1}: ${step.label}`}
    >
      <div className={`absolute inset-y-0 left-0 w-1 ${kind.rail}`} aria-hidden />

      <div className="pl-4 pr-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer text-left"
            aria-pressed={selected}
            onClick={() => onSelect?.(selected ? '' : step.nodeId)}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold tabular-nums text-slate-600">
                {step.position + 1}
              </span>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1 ring-inset ${kind.pill}`}>
                {kind.label}
              </span>
              {step.type === 'send' && (
                <span className="inline-flex items-center rounded-full bg-slate-50 px-2 py-0.5 text-[11.5px] font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
                  {String(step.channel || 'email').toLowerCase() === 'sms' ? 'SMS' : 'Email'}
                </span>
              )}
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-accent-700">
                {step.nodeId}
              </span>
            </div>

            <h3 className="mt-2 text-base leading-snug text-ink-900 text-wrap-pretty">
              {stepTitle(step)}
            </h3>

            {step.type === 'wait' && step.waitMs && (
              <p className="mt-1.5 text-sm text-amber-800">
                Pauses for <span className="font-medium">{waitText(step.waitMs)}</span>, then continues
              </p>
            )}

            {step.type === 'terminal' && (
              <p className="mt-1.5 text-sm text-slate-500">This path ends here — no further emails.</p>
            )}
          </button>

          <div className="flex shrink-0 flex-col items-end gap-2 text-right">
            <span className="text-xs tabular-nums text-slate-500">
              <span className="font-medium text-slate-700">{nfmt(step.sent)}</span> sent
            </span>
            {step.type === 'send' && onTestSend && (
              <button
                type="button"
                className="btn-ghost cursor-pointer px-3 py-1.5 text-xs"
                aria-label={`Send me a test of ${step.label}`}
                onClick={() => onTestSend(step.nodeId)}
              >
                Send me a test
              </button>
            )}
          </div>
        </div>

        {step.branches?.length > 0 && (
          <ul className="mt-3 space-y-1.5" aria-label="What happens next">
            {step.branches.map((b, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-md bg-slate-50 px-2 py-1 text-slate-600 ring-1 ring-slate-200 ring-inset">
                  {branchSummary(b)}
                </span>
                <span className="text-slate-400" aria-hidden>→</span>
                <span className="rounded-md bg-accent-50 px-2 py-1 font-mono text-xs font-medium text-accent-700 ring-1 ring-accent-200 ring-inset">
                  {b.to}
                </span>
              </li>
            ))}
          </ul>
        )}

        {step.sample && (
          <details className="group mt-3 rounded-lg border border-slate-200 bg-slate-50/60">
            <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-slate-600 marker:content-none [&::-webkit-details-marker]:hidden">
              <span className="flex items-center justify-between gap-2">
                Sample email copy
                <span className="text-xs font-normal text-slate-400 group-open:hidden">Show</span>
                <span className="hidden text-xs font-normal text-slate-400 group-open:inline">Hide</span>
              </span>
            </summary>
            <section className="border-t border-slate-200 px-3 py-2.5" aria-label={`Sample copy for step ${step.nodeId}`}>
              <p className="text-xs text-slate-500">
                An example for a stand-in lead — the real email is written at send time.
              </p>
              <p className="mt-2 text-sm font-medium text-slate-700">{step.sample.subject}</p>
              <pre className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-slate-600">
                {step.sample.body}
              </pre>
            </section>
          </details>
        )}
      </div>
    </article>
  )
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
        <div className="space-y-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
          ))}
        </div>
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
        <ol className="relative space-y-0">
          {data.steps.map((s, i) => (
            <li key={s.nodeId} className="relative pb-3 last:pb-0">
              {i < data.steps.length - 1 && (
                <span
                  className="absolute left-[1.6875rem] top-10 bottom-0 w-px bg-slate-200"
                  aria-hidden
                />
              )}
              <StepCard
                step={s}
                selected={selectedNode === s.nodeId}
                onSelect={onSelectNode}
                onTestSend={onTestSend}
              />
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
