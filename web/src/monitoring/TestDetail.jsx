// The test detail view: one Drawer, one header, and every report endpoint in
// the category rendering beneath it as a tab.
//
// The header is loaded when the drawer opens; each tab body fetches only when
// its tab is opened, so a slow report never blocks the identity of the page.

import { useState } from 'react'
import { Confirm, Drawer, Spinner, ErrorState, Tabs, useToast } from '../parity-ui.jsx'
import { api } from '../api.js'
import {
  Blocklist, StatusChip, Unverified, UnverifiedTag, cadence, localTime, useLoad,
} from './delivery-kit.jsx'
import {
  AuthenticationTab, BlocklistsTab, ContentTab, HistoryTab, PlacementTab, SpamFiltersTab,
} from './report-tabs.jsx'

const TABS = [
  { id: 'setup', label: 'Setup' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'placement', label: 'Placement' },
  { id: 'blocklists', label: 'Blocklists' },
  { id: 'spam', label: 'Spam filters', contract: 'spamFilterReport' },
  { id: 'content', label: 'Tested email' },
  { id: 'history', label: 'Run history' },
]

export default function TestDetail({ testId, onClose, onChanged, announce }) {
  const toast = useToast()
  const [tab, setTab] = useState('setup')
  const [confirmStop, setConfirmStop] = useState(false)
  const [stopError, setStopError] = useState(null)
  const state = useLoad(`/api/deliverability/tests/${testId}`)
  const test = state.data

  const stoppable = test && test.type === 'automated' && ['active', 'scheduled'].includes(test.status)

  async function stop() {
    setStopError(null)
    try {
      const res = await api.put(`/api/deliverability/tests/${testId}/stop`, {})
      setConfirmStop(false)
      state.reload()
      onChanged?.()
      announce?.(res.message || 'Schedule stopped.')
      toast?.(res.message || 'Schedule stopped.')
    } catch (err) {
      setStopError(err)
      setConfirmStop(false)
    }
  }

  return (
    <Drawer
      title={test ? test.name : 'Placement test'}
      onClose={onClose}
      footer={
        // Stop is reversible and lives here; delete is destructive and lives
        // only behind the list's selection bar, so the two are never adjacent.
        stoppable ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">Stopping keeps every run and every report.</span>
            <button className="btn-ghost cursor-pointer" onClick={() => setConfirmStop(true)}>
              Stop schedule for {test.name}
            </button>
          </div>
        ) : null
      }
    >
      {state.loading && !test && <Spinner label="Loading test…" />}
      {state.error && (
        <div>
          <ErrorState error={state.error} onRetry={state.reload} />
          <div className="mt-3 text-center">
            <button className="btn-ghost cursor-pointer" onClick={onClose}>Back to the tests list</button>
          </div>
        </div>
      )}

      {test && (
        <>
          <Header test={test} />
          {stopError && (
            <p className="mb-3 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700" role="alert">
              {stopError.message} — the schedule is still running.
            </p>
          )}

          <Tabs
            ariaLabel="Test report sections"
            active={tab}
            onChange={setTab}
            tabs={TABS.map((t) => ({
              id: t.id,
              label: <>{t.label}{t.contract && <UnverifiedTag contract={t.contract} />}</>,
            }))}
          />

          {tab === 'setup' && <Setup test={test} />}
          {tab === 'authentication' && <AuthenticationTab testId={test.id} />}
          {tab === 'placement' && <PlacementTab testId={test.id} />}
          {tab === 'blocklists' && <BlocklistsTab testId={test.id} />}
          {tab === 'spam' && <SpamFiltersTab testId={test.id} onJump={(id) => setTab(id === 'content' ? 'content' : id)} />}
          {tab === 'content' && <ContentTab testId={test.id} />}
          {tab === 'history' && <HistoryTab testId={test.id} test={test} />}
        </>
      )}

      {confirmStop && test && (
        <Confirm
          title={`Stop "${test.name}"?`}
          body={`The schedule stops running from now on. Every run already recorded and every report already fetched is kept — nothing is deleted. You can still read ${test.name}'s history afterwards.`}
          confirmLabel="Stop schedule"
          onConfirm={stop}
          onClose={() => setConfirmStop(false)}
        />
      )}
    </Drawer>
  )
}

function Header({ test }) {
  const cad = cadence(test)
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip value={test.status} />
        <span className="text-xs text-slate-600">{test.type === 'automated' ? 'Automated' : 'Manual'} test</span>
        {cad && <span className="text-xs text-slate-600">{cad}</span>}
        <span className="text-xs"><Blocklist blacklist={test.blacklist} /></span>
      </div>
      {test.description && <p className="mt-2 text-sm leading-relaxed text-slate-700">{test.description}</p>}
      <p className="mt-1.5 text-[11px] text-slate-400">
        Created {localTime(test.createdAt) || 'date not recorded'} · last updated {localTime(test.updatedAt) || 'date not recorded'}
      </p>
    </div>
  )
}

// Names, never identifiers; nulls omitted rather than labelled.
function Setup({ test }) {
  const rows = []

  if (test.campaignName) {
    rows.push(['Campaign', <a key="c" className="text-accent-700 underline underline-offset-2 hover:text-accent-700" href={`/app/campaigns/${test.campaignId}`}>Open the campaign {test.campaignName}</a>])
  } else if (test.campaignUnavailableReason) {
    rows.push(['Campaign', <span key="c" className="text-slate-500">Not shown — {test.campaignUnavailableReason}.</span>])
  }

  if (test.sequenceStepLabel) rows.push(['Send: step', test.sequenceStepLabel])
  else if (test.sequenceStepUnavailableReason) rows.push(['Send: step', <span key="s" className="text-slate-500">Not shown — {test.sequenceStepUnavailableReason}.</span>])

  if (test.providerLabel) rows.push(['Seed provider group', test.providerLabel])
  else if (test.providerUnavailableReason) rows.push(['Seed provider group', <span key="p" className="text-slate-500">Not shown — {test.providerUnavailableReason}.</span>])

  if (test.folderName) rows.push(['Folder', test.folderName])
  else if (test.folderUnavailableReason) rows.push(['Folder', <span key="f" className="text-slate-500">Not shown — {test.folderUnavailableReason}.</span>])

  if (test.type === 'automated') {
    const start = localTime(test.scheduleStartTime)
    const end = localTime(test.testEndDate)
    if (start) rows.push(['Starts', start])
    if (end) rows.push(['Ends', end])
    const cad = cadence(test)
    if (cad) rows.push(['Cadence', cad])
  }

  rows.push(['Pacing', test.allEmailSentWithoutTimeGap
    ? 'All seed emails sent at once, with no gap between them'
    : `At least ${test.minTimeBtwnEmails} ${test.minTimeUnit} between seed emails`])
  rows.push(['Options', [
    test.isWarmup ? 'counted as warm-up' : 'not counted as warm-up',
    test.linkChecker ? 'link checker on' : 'link checker off',
    test.testWithSlAccount ? 'seeded with the provider\'s own account' : 'not seeded with the provider\'s own account',
  ].join(' · ')])
  if (test.spamFilters?.length) rows.push(['Spam filters requested', test.spamFilters.join(', ')])

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value], i) => (
          <div key={i} className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
            <dt className="text-xs text-slate-500 sm:pt-0.5">{label}</dt>
            <dd className="break-words text-slate-700">{value}</dd>
          </div>
        ))}
      </dl>

      {test.schedulerCronValue && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-slate-500">Scheduling details</summary>
          <p className="mt-1 font-mono text-[11px] text-slate-500">{test.schedulerCronValue}</p>
        </details>
      )}

      <div className="mt-3">
        <Unverified contract={test.type === 'automated' ? 'createAutomated' : 'createManual'} />
      </div>
    </div>
  )
}
