// The report bodies behind the test-detail tabs.
//
// Every one of these is a *panel inside one page*, not a page of its own: the
// whole 28-endpoint smart-delivery category costs one Monitoring section and
// one detail view, and this file is where the eighteen report endpoints render
// beneath the single header that gives that view its identity.
//
// Each tab body is mounted only while its tab is active, so opening the drawer
// fetches the header and nothing else.

import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Modal, Spinner, ErrorState, useToast } from '../parity-ui.jsx'
import {
  Async, Blocklist, Freshness, Nothing, Panel, Scroller, Unverified, Verdict,
  localTime, num, pct, useLoad,
} from './delivery-kit.jsx'

// A seed result's verdict is a string in the provider's own vocabulary. Anything
// unrecognised stays unknown rather than being guessed into a pass.
function verdictOf(entry) {
  const raw = String(
    entry?.status ?? entry?.result ?? entry?.verdict ?? entry?.state ?? entry?.value ?? ''
  ).toLowerCase()
  if (!raw) {
    if (typeof entry?.passed === 'boolean') return entry.passed
    if (typeof entry?.valid === 'boolean') return entry.valid
    return null
  }
  if (/(^|\b)(pass|passed|valid|ok|success|true|verified|aligned)\b/.test(raw)) return true
  if (/(^|\b)(fail|failed|invalid|error|false|missing|none|softfail|permerror)\b/.test(raw)) return false
  return null
}

const addressOf = (g) => g?.fromEmail ?? g?.from_email ?? g?.email ?? g?.sender ?? null
const seedsOf = (g) => {
  for (const key of ['details', 'results', 'seeds', 'providers', 'items', 'esps']) {
    if (Array.isArray(g?.[key])) return g[key]
  }
  return []
}

function durationWords(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s < 0) return null
  if (s < 90) return `about ${Math.round(s)} second${Math.round(s) === 1 ? '' : 's'}`
  const m = Math.round(s / 60)
  if (m < 90) return `about ${m} minute${m === 1 ? '' : 's'}`
  const h = Math.round(s / 3600)
  return `about ${h} hour${h === 1 ? '' : 's'}`
}

const TH = 'py-2 pr-3 text-left text-xs font-medium text-slate-500'
const TD = 'py-2 pr-3 align-top text-slate-700'

// ===========================================================================
// Authentication — DKIM, SPF and rDNS through one component, no divergence
// ===========================================================================

const CHECK_COPY = {
  dkim: {
    title: 'DKIM',
    what: 'DKIM signs each message with a key published in your DNS. A failure means the receiving provider could not prove the message really came from your domain, which is one of the fastest ways into a spam folder.',
    contract: null,
  },
  spf: {
    title: 'SPF',
    what: 'SPF lists which servers may send for your domain. Fixing a failure means editing a DNS record — it is a change at your domain registrar or DNS host, not in Harry.',
    contract: null,
  },
  rdns: {
    title: 'Reverse DNS (rDNS)',
    what: 'Reverse DNS maps the sending IP address back to a hostname. It is almost always set by whoever hosts the sending server — your mailbox or hosting provider — rather than by you.',
    contract: 'rdnsReport',
  },
}

const EMPTY_COPY = { dkim: 'No DKIM results yet for this test.', spf: 'No SPF results yet.', rdns: 'No reverse DNS results yet.' }

export function AuthenticationTab({ testId }) {
  const state = useLoad(`/api/deliverability/tests/${testId}/authentication`)
  return (
    <Async state={state} label="Loading authentication…">
      {(data) => (
        <div className="space-y-3">
          {(data.checks || []).map((check) => (
            <CheckPanel key={check.check} check={check} />
          ))}
        </div>
      )}
    </Async>
  )
}

function CheckPanel({ check }) {
  const copy = CHECK_COPY[check.check] || { title: check.check, what: '' }
  const groups = Array.isArray(check.groups) ? check.groups : []
  return (
    <Panel title={copy.title} right={<Freshness res={check} noun={copy.title} />}>
      <p className="mb-2 text-xs leading-relaxed text-slate-500">{copy.what}</p>
      {copy.contract && <Unverified contract={copy.contract} />}
      {!check.available || groups.length === 0 ? (
        <Nothing>{EMPTY_COPY[check.check] || 'No results yet.'}</Nothing>
      ) : (
        <ul className="space-y-2">
          {groups.map((group, i) => {
            const address = addressOf(group)
            const seeds = seedsOf(group)
            const verdicts = seeds.map(verdictOf)
            const anyFail = verdicts.some((v) => v === false)
            const allPass = verdicts.length > 0 && verdicts.every((v) => v === true)
            return (
              <li key={address || i} className="rounded border border-slate-200 bg-white/40 p-2">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm text-ink-900">
                    <span className="break-all font-medium">{address || 'Sending address not reported'}</span>
                    <Verdict
                      pass={allPass ? true : anyFail ? false : null}
                      passLabel={`${copy.title} pass`}
                      failLabel={`${copy.title} failing`}
                      unknownLabel={`${copy.title} not reported`}
                    />
                    <span className="text-[11px] text-slate-500">
                      {seeds.length} seed result{seeds.length === 1 ? '' : 's'}
                    </span>
                  </summary>
                  {seeds.length === 0 ? (
                    <p className="mt-2 text-xs text-slate-500">No per-provider seed results were returned for this address.</p>
                  ) : (
                    <dl className="mt-2 space-y-1 text-xs">
                      {seeds.map((seed, j) => (
                        <div key={j} className="flex flex-wrap items-center gap-2">
                          <dt className="text-slate-600">
                            {seed.esp ?? seed.provider ?? seed.providerName ?? 'provider not named'}
                            {(seed.email ?? seed.to_email) && (
                              <span className="ml-1 break-all text-slate-400">({seed.email ?? seed.to_email})</span>
                            )}
                          </dt>
                          <dd><Verdict pass={verdictOf(seed)} /></dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </details>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

// ===========================================================================
// Placement — counts, senders, by mailbox, by provider, by region
// ===========================================================================

export function PlacementTab({ testId }) {
  const counts = useLoad(`/api/deliverability/tests/${testId}/counts`)
  const senders = useLoad(`/api/deliverability/tests/${testId}/senders`)
  const mailboxes = useLoad(`/api/deliverability/tests/${testId}/mailboxes`)
  const providers = useLoad(`/api/deliverability/tests/${testId}/providers`)
  const regions = useLoad(`/api/deliverability/tests/${testId}/regions`)
  const senderReport = useLoad(`/api/deliverability/tests/${testId}/senders/report`)

  return (
    <div className="space-y-3">
      <CountsPanel state={counts} />
      <SendersPanel state={senders} testId={testId} />
      <MailboxPanel state={mailboxes} />
      <GroupPanel state={providers} label="provider" title="By provider" contract="providerReport" empty="No provider results yet." />
      <GroupPanel state={regions} label="region" title="By region" contract="geoReport" empty="No regional results yet." />
      <SenderReportPanel state={senderReport} />
    </div>
  )
}

function CountsPanel({ state }) {
  return (
    <Panel title="Where the seed emails landed" right={state.data && <Freshness res={state.data} noun="placement count" />}>
      <Async state={state} label="Loading counts…">
        {(d) => {
          if (!d.available) return <Nothing>Results pending — no placement counts have been recorded for this run.</Nothing>
          const cells = [
            ['Inbox', d.inboxCount], ['Tabs', d.tabCount], ['Spam', d.spamCount],
            ['Failed', d.failedCount], ['Total sent', d.totalEmailCount],
          ]
          return (
            <>
              {/* Inbox, tabs, spam and failed stay four separate figures: folding
                  the Promotions tab into "inbox" is how a tool flatters its user. */}
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {cells.map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-slate-100 p-2.5">
                    <dt className="text-[11px] text-slate-600">{label}</dt>
                    <dd className="text-lg font-semibold tabular-nums text-ink-950">{num(value)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-slate-600">
                {d.totalEmailCount > 0 && d.inboxRate !== null
                  ? <>
                    {pct(d.inboxRate)} of {num(d.totalEmailCount)} seed emails reached the inbox
                    {' — '}
                    <span className={d.belowBenchmark ? 'text-amber-700' : 'text-emerald-700'}>
                      {d.belowBenchmark ? `below the ${pct(d.benchmark, 0)} cold-outreach benchmark` : `at or above the ${pct(d.benchmark, 0)} cold-outreach benchmark`}
                    </span>
                  </>
                  : 'Results pending — no percentage is shown until seed emails have been sent.'}
              </p>
              {d.notYetDelivered > 0 && (
                <p className="mt-1 text-xs text-slate-500">{num(d.notYetDelivered)} not yet delivered — counted in the total but not yet placed anywhere.</p>
              )}
            </>
          )
        }}
      </Async>
    </Panel>
  )
}

function SendersPanel({ state, testId }) {
  const [reply, setReply] = useState(null)
  return (
    <Panel title="Sent from" hint="every seed sender this test used">
      <Async state={state} label="Loading sender accounts…">
        {(d) => {
          const items = d.items || []
          if (!items.length) {
            return (
              <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-sm text-amber-800" role="status">
                This test used no sender accounts — nothing was seeded, so no result below is a measurement. Check the mailboxes chosen when the test was created.
              </p>
            )
          }
          return (
            <ul className="space-y-1.5">
              {items.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="break-all text-ink-900">{s.fromEmail || 'address not reported'}</span>
                  <span className="text-[11px] text-slate-500">run {s.runNo} · {s.sendStatus}</span>
                  {s.placement && <span className="text-[11px] text-slate-600">landed in {s.placement}</span>}
                  {s.mailboxConnected
                    ? <span className="text-[11px] text-emerald-700">connected mailbox</span>
                    : <span className="text-[11px] text-slate-500">not linked — this address is not a mailbox connected to this workspace</span>}
                  <button
                    type="button"
                    className="cursor-pointer text-[11px] text-accent-700 underline underline-offset-2 hover:text-accent-700"
                    onClick={() => setReply(s)}
                  >
                    View headers for {s.fromEmail || `reply ${s.senderId}`}
                  </button>
                </li>
              ))}
            </ul>
          )
        }}
      </Async>
      {reply && <ReplyHeaders testId={testId} sender={reply} onClose={() => setReply(null)} />}
    </Panel>
  )
}

// Headers are fetched live and never stored, so this is its own request and its
// own dialog rather than something the tab preloads.
function ReplyHeaders({ testId, sender, onClose }) {
  const toast = useToast()
  const state = useLoad(`/api/deliverability/tests/${testId}/replies/${encodeURIComponent(sender.senderId)}/headers`)
  const [copied, setCopied] = useState('')

  const raw = state.data?.headers
    ? Object.entries(state.data.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')
    : ''

  return (
    <Modal title={`Headers — ${sender.fromEmail || sender.senderId}`} onClose={onClose} wide>
      {state.loading && !state.data && <Spinner label="Fetching headers…" />}
      {state.error && <ErrorState error={state.error} onRetry={state.reload} />}
      {state.data && (
        <div>
          {/* The conclusion comes before the raw block, so a screen-reader user
              is not made to parse a Received chain to learn the verdict. */}
          {state.data.summary ? (
            <p className="mb-2 flex flex-wrap items-center gap-2 text-sm text-ink-900">
              <Verdict pass={state.data.summary.dkim === 'pass'} passLabel="DKIM pass" failLabel={`DKIM ${state.data.summary.dkim || 'not reported'}`} />
              <Verdict pass={state.data.summary.spf === 'pass'} passLabel="SPF pass" failLabel={`SPF ${state.data.summary.spf || 'not reported'}`} />
              <Verdict pass={state.data.summary.dmarc === 'pass'} passLabel="DMARC pass" failLabel={`DMARC ${state.data.summary.dmarc || 'not reported'}`} />
            </p>
          ) : (
            <p className="mb-2 text-xs text-slate-500">No Authentication-Results header was present, so there is no parsed verdict — the raw block below is the whole answer.</p>
          )}

          {!state.data.available ? (
            <Nothing>{state.data.message || 'No headers captured for this reply.'}</Nothing>
          ) : (
            <>
              <div className="max-h-80 overflow-auto rounded border border-slate-200 bg-white p-2">
                <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-slate-700">{raw}</pre>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  className="btn-ghost cursor-pointer"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(raw)
                      setCopied('All headers copied to the clipboard.')
                      toast?.('Headers copied')
                    } catch {
                      setCopied('The clipboard is not available in this browser — select the block and copy manually.')
                    }
                  }}
                >
                  Copy all headers
                </button>
                <span aria-live="polite" className="text-xs text-slate-500">{copied}</span>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

function MailboxPanel({ state }) {
  return (
    <Panel title="By mailbox" hint="worst inbox rate first" right={state.data && <Freshness res={state.data} noun="per-mailbox" />}>
      <Async state={state} label="Loading per-mailbox results…">
        {(d) => {
          const items = [...(d.items || [])].sort((a, b) => {
            const ar = a.inboxRate === null ? -1 : a.inboxRate
            const br = b.inboxRate === null ? -1 : b.inboxRate
            return ar - br
          })
          if (!items.length) return <Nothing>No per-mailbox results yet.</Nothing>
          return (
            <Scroller label="Placement by mailbox">
              <table className="w-full text-sm">
                <caption className="sr-only">Placement by sending mailbox, ordered worst inbox rate first</caption>
                <thead>
                  <tr className="border-b border-slate-200">
                    <th scope="col" className={TH}>Sending address</th>
                    <th scope="col" className={TH}>Receiving provider</th>
                    <th scope="col" className={TH}>Inbox</th>
                    <th scope="col" className={TH}>Tabs</th>
                    <th scope="col" className={TH}>Spam</th>
                    <th scope="col" className={TH}>Failed</th>
                    <th scope="col" className={TH}>Inbox rate</th>
                    <th scope="col" className={TH}>Placement score</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((m, i) => (
                    <tr key={`${m.fromEmail}-${i}`} className="border-b border-slate-200 last:border-0">
                      <th scope="row" className={`${TD} break-all font-normal`}>
                        {m.fromEmail || 'not reported'}
                        {!m.matched && <span className="block text-[11px] text-slate-500">not a mailbox connected here</span>}
                      </th>
                      <td className={TD}>{m.esp || '—'}</td>
                      <td className={`${TD} tabular-nums`}>{num(m.inboxCount)}</td>
                      <td className={`${TD} tabular-nums`}>{num(m.tabCount)}</td>
                      <td className={`${TD} tabular-nums`}>{num(m.spamCount)}</td>
                      <td className={`${TD} tabular-nums`}>{num(m.failedCount)}</td>
                      <td className={`${TD} tabular-nums`}>
                        {pct(m.inboxRate)} <span className="text-[11px] text-slate-500">of {num(m.totalEmailCount)}</span>
                        {m.inboxRate !== null && m.inboxRate < (d.benchmark ?? 0.8) && (
                          <span className="ml-1 text-[11px] text-amber-700">below benchmark</span>
                        )}
                      </td>
                      <td className={`${TD} tabular-nums`}>
                        {m.placementScore === null || m.placementScore === undefined
                          ? '—'
                          : <>{m.placementScore} <span className="text-[11px] text-slate-500">out of 100</span></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          )
        }}
      </Async>
    </Panel>
  )
}

// By provider and by region are the same shape, so they are the same component.
function GroupPanel({ state, label, title, contract, empty }) {
  return (
    <Panel title={title} right={state.data && <Freshness res={state.data} noun={label} />}>
      <Unverified contract={contract} />
      <Async state={state} label={`Loading ${label} results…`}>
        {(d) => {
          const rows = d.result || []
          if (!d.available || !rows.length) return <Nothing>{empty}</Nothing>
          const rated = rows.filter((r) => r.inboxRate !== null)
          const weakest = rated.length ? rated.reduce((a, b) => (a.inboxRate <= b.inboxRate ? a : b)) : null
          const best = rated.length ? rated.reduce((a, b) => (a.inboxRate >= b.inboxRate ? a : b)) : null
          return (
            <>
              {weakest && (
                <p className="mb-2 text-xs text-slate-600">
                  Weakest {label}: <span className="text-ink-900">{weakest[label] || 'unnamed'}</span> at {pct(weakest.inboxRate)} inbox
                  {best && best !== weakest && <> — {pct(Math.max(0, best.inboxRate - weakest.inboxRate))} behind {best[label] || 'the best'}</>}
                  {' '}<span className="text-slate-500">({num(weakest.mailboxCount)} mailbox{weakest.mailboxCount === 1 ? '' : 'es'} measured)</span>
                </p>
              )}
              {d.partial && (
                <p className="mb-2 text-xs text-amber-700" role="status">
                  Test still running — these figures are partial{d.status ? ` (status: ${d.status})` : ''}.
                </p>
              )}
              <Scroller label={title}>
                <table className="w-full text-sm">
                  <caption className="sr-only">{title}: inbox, spam and bounce rates with the number of mailboxes measured</caption>
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th scope="col" className={TH}>{label === 'region' ? 'Region' : 'Provider'}</th>
                      <th scope="col" className={TH}>Inbox rate</th>
                      <th scope="col" className={TH}>Spam rate</th>
                      <th scope="col" className={TH}>Bounce rate</th>
                      <th scope="col" className={TH}>Mailboxes</th>
                      <th scope="col" className={TH}>Avg delivery time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r[label]}-${i}`} className="border-b border-slate-200 last:border-0">
                        <th scope="row" className={`${TD} font-normal`}>{r[label] || 'unnamed'}</th>
                        <td className={`${TD} tabular-nums`}>
                          {pct(r.inboxRate)}
                          {(d.belowBenchmark || []).includes(r[label]) && <span className="ml-1 text-[11px] text-amber-700">below benchmark</span>}
                        </td>
                        <td className={`${TD} tabular-nums`}>{pct(r.spamRate)}</td>
                        <td className={`${TD} tabular-nums`}>{pct(r.bounceRate)}</td>
                        <td className={`${TD} tabular-nums`}>{num(r.mailboxCount)}</td>
                        <td className={TD}>
                          {r.avgDeliveryTimeSeconds === null
                            ? '—'
                            : <>{durationWords(r.avgDeliveryTimeSeconds)} <span className="text-[11px] text-slate-500">({num(r.avgDeliveryTimeSeconds)}s)</span></>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroller>
              <p className="mt-1.5 text-[11px] text-slate-500">Overall measured: {num(d.overallTotalCount)} seed emails.</p>
            </>
          )
        }}
      </Async>
    </Panel>
  )
}

function SenderReportPanel({ state }) {
  return (
    <Panel title="By sender" hint="reputation across every test this address has run" right={state.data && <Freshness res={state.data} noun="sender" />}>
      <Async state={state} label="Loading sender history…">
        {(d) => {
          const items = d.items || []
          if (!d.available || !items.length) return <Nothing>No sender history yet.</Nothing>
          return (
            <Scroller label="Sender reputation">
              <table className="w-full text-sm">
                <caption className="sr-only">Average placement and reputation per sending address</caption>
                <thead>
                  <tr className="border-b border-slate-200">
                    <th scope="col" className={TH}>Address</th>
                    <th scope="col" className={TH}>Sender name</th>
                    <th scope="col" className={TH}>Tests</th>
                    <th scope="col" className={TH}>Avg inbox</th>
                    <th scope="col" className={TH}>Avg spam</th>
                    <th scope="col" className={TH}>Avg bounce</th>
                    <th scope="col" className={TH}>Reputation</th>
                    <th scope="col" className={TH}>Last test</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((s, i) => (
                    <tr key={`${s.fromEmail}-${i}`} className="border-b border-slate-200 last:border-0">
                      <th scope="row" className={`${TD} break-all font-normal`}>{s.fromEmail || 'not reported'}</th>
                      <td className={TD}>{s.senderName || '—'}</td>
                      <td className={`${TD} tabular-nums`}>{num(s.testsCount)}</td>
                      <td className={`${TD} tabular-nums`}>{pct(s.avgInboxRate)}</td>
                      <td className={`${TD} tabular-nums`}>{pct(s.avgSpamRate)}</td>
                      <td className={`${TD} tabular-nums`}>{pct(s.avgBounceRate)}</td>
                      {/* The scale travels with the number everywhere it is shown. */}
                      <td className={`${TD} tabular-nums`}>
                        {s.reputationScore === null ? '—' : <>{s.reputationScore} <span className="text-[11px] text-slate-500">out of 100</span></>}
                      </td>
                      <td className={TD}>{localTime(s.lastTestDate) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          )
        }}
      </Async>
    </Panel>
  )
}

// ===========================================================================
// Blocklists — IP listings, domain listings and the IP records behind them
// ===========================================================================

export function BlocklistsTab({ testId }) {
  const ip = useLoad(`/api/deliverability/tests/${testId}/blacklist`)
  const domain = useLoad(`/api/deliverability/tests/${testId}/domain-blacklist`)
  const ips = useLoad(`/api/deliverability/tests/${testId}/ips`)

  return (
    <div className="space-y-3">
      <Panel title="IP blocklists" right={ip.data && <Blocklist blacklist={ip.data} />}>
        <Async state={ip} label="Loading blocklist results…">
          {(d) => {
            if (!d.available || !(d.groups || []).length) return <Nothing>No blacklist results yet for this test.</Nothing>
            return (
              <ul className="space-y-2">
                {d.groups.map((g) => (
                  <li key={g.ip} className="rounded border border-slate-200 bg-white/40 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-sm text-ink-900">{g.ip}</span>
                      <Verdict pass={g.totalBlacklist === 0} passLabel="clear" failLabel={`listed on ${g.totalBlacklist}`} />
                      <span className="text-[11px] text-slate-500">checked {localTime(g.checkedAt) || 'time not reported'}</span>
                    </div>
                    <ul className="mt-1.5 space-y-0.5">
                      {(g.listings || []).map((l, i) => (
                        <li key={i} className="text-xs text-slate-600">
                          <span className={l.listed === false ? 'text-slate-500' : 'text-red-700'}>{l.blacklistTypeValue || 'blocklist not named'}</span>
                          {/* Grey-vs-red is the only signal otherwise, so say it in
                              words — as the domain listing below already does. */}
                          <span className="ml-2 text-slate-500">{l.listed === false ? 'not listed' : 'listed'}</span>
                          {/* The provider's own sentence, unparaphrased. */}
                          <span className="ml-2 text-slate-500">{l.details}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )
          }}
        </Async>
      </Panel>

      <Panel title="Domain blocklists" right={domain.data && <Blocklist blacklist={domain.data} />}>
        <Async state={domain} label="Loading domain blocklist results…">
          {(d) => {
            if (!d.available || !(d.groups || []).length) return <Nothing>No domain blocklist results yet.</Nothing>
            return (
              <ul className="space-y-2">
                {d.groups.map((g) => (
                  <li key={g.domain} className="rounded border border-slate-200 bg-white/40 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all text-sm text-ink-900">{g.domain}</span>
                      <Verdict pass={!g.blacklisted} passLabel="domain clear" failLabel="domain listed" />
                    </div>
                    <ul className="mt-1.5 space-y-0.5">
                      {(g.listings || []).map((l, i) => (
                        <li key={i} className="text-xs">
                          <span className={l.listed ? 'text-red-700' : 'text-slate-500'}>{l.provider || 'blocklist not named'}</span>
                          <span className="ml-2 text-slate-500">{l.listed ? 'listed' : 'not listed'} · observed {localTime(l.checkedAt) || 'time not reported'}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )
          }}
        </Async>
      </Panel>

      <Panel title="Sending IPs" right={ips.data && <Freshness res={ips.data} noun="IP" />}>
        <Async state={ips} label="Loading IP details…">
          {(d) => {
            const items = d.items || []
            if (!d.available || !items.length) return <Nothing>No IP information yet for this test.</Nothing>
            return (
              <ul className="grid gap-2 sm:grid-cols-2">
                {items.map((ipRow, i) => (
                  <li key={`${ipRow.ip}-${i}`} className="rounded border border-slate-200 bg-white/40 p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-sm text-ink-900">{ipRow.ip || 'IP not reported'}</span>
                      <Verdict pass={!ipRow.blacklisted} passLabel="not blocklisted" failLabel="blocklisted" />
                    </div>
                    {/* The provider's reputation sentence is a paragraph, verbatim. */}
                    {ipRow.summary && <p className="mt-1 text-xs leading-relaxed text-slate-600">{ipRow.summary}</p>}
                    <dl className="mt-1.5 space-y-0.5 text-[11px]">
                      {[['ISP', ipRow.isp], ['Organisation', ipRow.organization], ['Location', ipRow.location], ['Reverse DNS', ipRow.reverseDns], ['First seen', localTime(ipRow.createdAt)]]
                        .filter(([, v]) => v)
                        .map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <dt className="w-24 shrink-0 text-slate-500">{k}</dt>
                            <dd className="break-all text-slate-700">{v}</dd>
                          </div>
                        ))}
                    </dl>
                  </li>
                ))}
              </ul>
            )
          }}
        </Async>
      </Panel>
    </div>
  )
}

// ===========================================================================
// Spam filters
// ===========================================================================

const REASON_TARGET = {
  authentication: { tab: 'authentication', label: 'Open Authentication' },
  reputation: { tab: 'blocklists', label: 'Open Blocklists' },
  content: { tab: 'content', label: 'Open Tested email' },
}

export function SpamFiltersTab({ testId, onJump }) {
  const state = useLoad(`/api/deliverability/tests/${testId}/spam-filters`)
  return (
    <Panel title="Spam filters" right={state.data && <Freshness res={state.data} noun="spam filter" />}>
      <Unverified contract="spamFilterReport" />
      <Async state={state} label="Loading spam filter results…">
        {(d) => {
          if (!d.available) return <Nothing>No spam filter results yet.</Nothing>
          const groups = d.groups || []
          const triggered = groups.some((g) => (g.spamFilterDetails || []).length > 0)
          if (!triggered) {
            return <p className="text-sm text-emerald-700">No spam filters triggered — every seed message passed the filters that were checked.</p>
          }
          return (
            <div className="space-y-2">
              {groups.map((g, i) => (
                <div key={`${g.fromEmail}-${i}`} className="rounded border border-slate-200 bg-white/40 p-2">
                  <h5 className="break-all text-sm font-medium text-ink-900">{g.fromEmail || 'Sending address not reported'}</h5>
                  {(g.spamFilterDetails || []).length === 0 ? (
                    <p className="mt-1 text-xs text-emerald-700">No spam filters triggered for this address.</p>
                  ) : (
                    <ul className="mt-1.5 space-y-2">
                      {g.spamFilterDetails.map((detail, j) => (
                        <li key={j}>
                          <div className="text-xs text-slate-700">
                            <span className="font-medium">{detail.filter || 'filter not named'}</span>
                            <span className="ml-2 text-slate-500">
                              triggered {num(detail.triggeredCount)} time{detail.triggeredCount === 1 ? '' : 's'}
                              {detail.triggerPercentage !== null && ` · ${pct(detail.triggerPercentage / 100)} of messages`}
                            </span>
                          </div>
                          <ul className="mt-1 space-y-1">
                            {(detail.reasons || []).map((r, k) => {
                              const target = REASON_TARGET[r.reasonType]
                              return (
                                <li key={k} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                                  {/* Every reason string, verbatim and individually. */}
                                  <span className="text-slate-600">{r.reason}</span>
                                  {target ? (
                                    <button type="button" className="cursor-pointer text-accent-700 underline underline-offset-2 hover:text-accent-700" onClick={() => onJump(target.tab)}>
                                      {target.label}
                                    </button>
                                  ) : (
                                    <span className="text-slate-400">not classified — no fix location inferred</span>
                                  )}
                                </li>
                              )
                            })}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {d.unclassifiedReasons > 0 && (
                <p className="text-[11px] text-slate-500">
                  {d.unclassifiedReasons} reason{d.unclassifiedReasons === 1 ? '' : 's'} could not be classified, so no fix location is suggested for {d.unclassifiedReasons === 1 ? 'it' : 'them'}.
                </p>
              )}
            </div>
          )
        }}
      </Async>
    </Panel>
  )
}

// ===========================================================================
// Tested email content — fetched live, never stored, never trusted
// ===========================================================================

export function ContentTab({ testId }) {
  const state = useLoad(`/api/deliverability/tests/${testId}/content`)
  const [view, setView] = useState('text')
  const views = [{ id: 'text', label: 'Text' }, { id: 'html', label: 'HTML' }, { id: 'raw', label: 'Raw source' }]

  return (
    <Panel title="Tested email">
      <Async state={state} label="Loading email content…">
        {(d) => {
          if (!d.available) return <Nothing>{d.message || 'No email content captured for this test.'}</Nothing>
          return (
            <div>
              <h5 className="mb-2 text-sm font-medium text-ink-900">{d.subject || 'No subject was captured'}</h5>
              <div className="mb-2 flex gap-1 border-b border-slate-200" role="tablist" aria-label="Email content view">
                {views.map((v) => (
                  <button
                    key={v.id}
                    role="tab"
                    aria-selected={view === v.id}
                    onClick={() => setView(v.id)}
                    className={`cursor-pointer border-b-2 px-3 py-1.5 text-xs ${view === v.id ? 'border-accent-500 text-accent-700' : 'border-transparent text-slate-600 hover:text-ink-900'}`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              {view === 'text' && (d.text
                ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 bg-white p-2 font-mono text-[11px] text-slate-700">{d.text}</pre>
                : <Nothing>No plain-text part was captured for this test.</Nothing>)}
              {view === 'html' && (d.html
                ? <>
                  {/* Never injected into the app document: an empty sandbox blocks
                      scripts, forms, remote loads and navigation, so links are inert. */}
                  <iframe
                    title="Tested email, rendered in a sandbox with scripts and links disabled"
                    sandbox=""
                    referrerPolicy="no-referrer"
                    srcDoc={d.html}
                    className="h-96 w-full rounded border border-slate-200 bg-white"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">{d.renderContract}</p>
                </>
                : <Nothing>No HTML part was captured for this test.</Nothing>)}
              {view === 'raw' && (d.raw
                ? <details><summary className="cursor-pointer text-xs text-slate-600">Show the raw message source</summary>
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded border border-slate-200 bg-white p-2 font-mono text-[11px] text-slate-700">{d.raw}</pre>
                </details>
                : <Nothing>No raw source was captured for this test.</Nothing>)}
            </div>
          )
        }}
      </Async>
    </Panel>
  )
}

// ===========================================================================
// Run history
// ===========================================================================

export function HistoryTab({ testId, test }) {
  const [runs, setRuns] = useState(null)
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchPage = useCallback(async (before) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`/api/deliverability/tests/${testId}/history${before ? `?before=${before}` : ''}`)
      setRuns((prev) => (before ? [...(prev || []), ...(res.runs || [])] : (res.runs || [])))
      setMeta(res)
    } catch (err) { setError(err) } finally { setLoading(false) }
  }, [testId])

  useEffect(() => { fetchPage(null) }, [fetchPage])

  if (loading && runs === null) return <Spinner label="Loading run history…" />
  if (error) return <ErrorState error={error} onRetry={() => fetchPage(null)} />

  const list = runs || []
  const nextRun = test?.type === 'automated' && test?.scheduleStartTime
    ? localTime(test.scheduleStartTime)
    : null

  if (!list.length) {
    return (
      <Panel title="Run history">
        <Nothing>
          No runs yet.{nextRun ? ` The next scheduled run is ${nextRun}.` : ' No run is scheduled for this test.'}
        </Nothing>
      </Panel>
    )
  }

  const max = Math.max(...list.map((r) => r.inboxRate ?? 0), 0.01)

  return (
    <Panel title="Run history" hint="newest first" right={<span className="text-[11px] text-slate-400">{meta?.total ?? list.length} run(s)</span>}>
      <p className="mb-2 text-xs text-slate-600">
        {meta?.trendPoints === null || meta?.trendPoints === undefined
          ? 'No trend is shown — fewer than two completed runs share the same measurement window, and rates measured over different windows are not comparable.'
          : <>Inbox rate {meta.trendPoints >= 0 ? 'up' : 'down'} {Math.abs(meta.trendPoints)} points between run {meta.trendBasis?.[1]} and run {meta.trendBasis?.[0]}.</>}
      </p>

      {/* Decorative only — every value below is in the table. */}
      <div className="mb-3 flex h-12 items-end gap-1" aria-hidden>
        {[...list].reverse().map((r) => (
          <div
            key={r.runNo}
            className="flex-1 rounded"
            style={{ maxWidth: 12, height: `${Math.max(8, ((r.inboxRate ?? 0) / max) * 100)}%`, background: r.partial ? 'rgba(148,163,184,0.5)' : 'rgba(23, 165, 131, 0.75)' }}
          />
        ))}
      </div>

      <Scroller label="Run history">
        <table className="w-full text-sm">
          <caption className="sr-only">Every recorded run of this test, newest first, with its measurement window</caption>
          <thead>
            <tr className="border-b border-slate-200">
              <th scope="col" className={TH}>Run</th>
              <th scope="col" className={TH}>Status</th>
              <th scope="col" className={TH}>Started</th>
              <th scope="col" className={TH}>Inbox</th>
              <th scope="col" className={TH}>Tabs</th>
              <th scope="col" className={TH}>Spam</th>
              <th scope="col" className={TH}>Total</th>
              <th scope="col" className={TH}>Inbox rate</th>
              <th scope="col" className={TH}>Window</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.runNo} className="border-b border-slate-200 last:border-0">
                <th scope="row" className={`${TD} font-normal tabular-nums`}>{r.runNo}</th>
                <td className={TD}>{r.status}{r.partial && <span className="ml-1 text-[11px] text-amber-700">partial</span>}</td>
                <td className={TD}>{localTime(r.startedAt) || '—'}</td>
                <td className={`${TD} tabular-nums`}>{num(r.inboxCount)}</td>
                <td className={`${TD} tabular-nums`}>{num(r.tabCount)}</td>
                <td className={`${TD} tabular-nums`}>{num(r.spamCount)}</td>
                <td className={`${TD} tabular-nums`}>{num(r.adjustedTotalEmailCount)}</td>
                <td className={`${TD} tabular-nums`}>{pct(r.inboxRate)}</td>
                <td className={TD}>
                  {r.replyWindowStartHour === null || r.replyWindowEndHour === null
                    ? 'not reported'
                    : `${r.replyWindowStartHour}–${r.replyWindowEndHour}h`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroller>

      {meta?.hasMore && (
        <div className="flex justify-center py-3">
          <button className="btn-ghost cursor-pointer" disabled={loading} onClick={() => fetchPage(meta.nextBefore)}>
            {loading ? 'Loading…' : 'Load older runs'}
          </button>
        </div>
      )}
    </Panel>
  )
}
