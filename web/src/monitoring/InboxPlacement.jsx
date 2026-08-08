// Monitoring → Inbox placement.
//
// The whole 28-endpoint smart-delivery category renders inside this one section
// and the one detail view it opens: a tests list with folders as a filter, a
// create form, folder management, and a tabbed report drawer. Nothing here adds
// a navigation item, and nothing here is a second place to look.
//
// Three things are non-negotiable on this surface:
//   * Harry's own rows are authoritative — everything works with no provider.
//   * A figure the server could not refresh is marked, never shown as current.
//   * A blocklist that has never been checked reads "not checked yet", because
//     rendering it as 0 would be a clean bill of health nobody earned.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import {
  BulkBar, Confirm, LiveRegion, LoadMore, NotConnected, Spinner, ErrorState,
  useToast, usePagedList,
} from '../parity-ui.jsx'
import {
  Blocklist, ContractsCtx, StatusChip, cadence, localTime,
} from './delivery-kit.jsx'
import CreateTestForm from './CreateTestForm.jsx'
import DeliverabilityFolders from './DeliverabilityFolders.jsx'
import TestDetail from './TestDetail.jsx'

const STATUSES = ['draft', 'scheduled', 'active', 'completed', 'stopped', 'error']
const TYPES = ['manual', 'automated']

export default function InboxPlacement() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [announcement, setAnnouncement] = useState('')
  const [selected, setSelected] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [showFolders, setShowFolders] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  // Filters live in the URL so they survive a reload and can be shared.
  const status = params.get('ipStatus') || ''
  const type = params.get('ipType') || ''
  const folderId = params.get('ipFolder') || ''
  const q = params.get('ipQ') || ''
  const openTestId = params.get('ipTest') || ''

  // The search box is typed into far faster than a page can be fetched, so the
  // field is local and the URL — and therefore the request — follows behind it.
  const [qInput, setQInput] = useState(q)
  useEffect(() => {
    if (qInput === q) return undefined
    const timer = setTimeout(() => {
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        if (qInput) next.set('ipQ', qInput); else next.delete('ipQ')
        return next
      }, { replace: true })
    }, 350)
    return () => clearTimeout(timer)
  }, [qInput, q, setParams])

  const setParam = useCallback((key, value) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value === '' || value === null || value === undefined) next.delete(key)
      else next.set(key, String(value))
      return next
    }, { replace: true })
  }, [setParams])

  // ---- provider block, seed groups and the unverified request contracts ----
  const [prov, setProv] = useState(null)
  const [provError, setProvError] = useState(null)
  const loadProviders = useCallback(() => {
    api.get('/api/deliverability/providers').then(
      (r) => { setProv(r); setProvError(null) },
      (e) => setProvError(e),
    )
  }, [])
  useEffect(() => { loadProviders() }, [loadProviders])

  const contracts = useMemo(() => {
    const entries = prov?.contracts?.entries || []
    return { byKey: new Map(entries.map((e) => [e.key, e])), count: entries.length }
  }, [prov])

  // ---- folders -------------------------------------------------------------
  const [folders, setFolders] = useState(null)
  const [foldersError, setFoldersError] = useState(null)
  const [foldersLoading, setFoldersLoading] = useState(true)
  const loadFolders = useCallback(async () => {
    setFoldersLoading(true)
    try {
      const r = await api.get('/api/deliverability/folders')
      setFolders(r.items || [])
      setFoldersError(null)
    } catch (e) { setFoldersError(e) } finally { setFoldersLoading(false) }
  }, [])
  useEffect(() => { loadFolders() }, [loadFolders])

  // ---- the tests list ------------------------------------------------------
  const list = usePagedList('/api/deliverability/tests', {
    status: status || undefined,
    type: type || undefined,
    folderId: folderId === '' ? undefined : folderId,
    q: q || undefined,
  })

  // A selection can only ever name rows that are still on screen.
  const visibleIds = list.items.map((t) => t.id)
  const chosen = selected.filter((id) => visibleIds.includes(id))
  const allOnPage = visibleIds.length > 0 && visibleIds.every((id) => chosen.includes(id))
  const chosenTests = list.items.filter((t) => chosen.includes(t.id))
  const runningChosen = chosenTests.filter((t) => ['active', 'scheduled'].includes(t.status))

  const announce = useCallback((message) => setAnnouncement(message), [])

  async function deleteChosen() {
    setDeleteError(null)
    try {
      const res = await api.post('/api/deliverability/tests/delete', { testIds: chosen })
      setConfirmDelete(false)
      setSelected([])
      await list.reload()
      const message = `${res.deleted} test${res.deleted === 1 ? '' : 's'} deleted${res.schedulesStopped ? `, ${res.schedulesStopped} running schedule(s) stopped` : ''}.`
      announce(message)
      toast?.(message)
    } catch (err) {
      setConfirmDelete(false)
      // All-or-nothing: nothing was deleted, so the selection is kept intact.
      setDeleteError(err)
    }
  }

  const connectionStatus = prov ? { ...prov, envVars: prov.missingEnv || [] } : null
  const filtered = Boolean(status || type || folderId || q)

  return (
    <ContractsCtx.Provider value={contracts}>
      <section className="card p-4" aria-labelledby="inbox-placement-heading">
        <LiveRegion message={announcement} />

        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="inbox-placement-heading" className="text-sm font-semibold text-slate-700">
              Inbox placement{' '}
              <span className="font-normal text-slate-500">— seed tests, authentication and blocklists for the last hop before a prospect reads anything</span>
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost cursor-pointer" onClick={() => setShowFolders(true)}>Folders</button>
            <button className="btn-primary cursor-pointer" onClick={() => setShowCreate(true)}>Run a test</button>
          </div>
        </div>

        <NotConnected status={connectionStatus} what="A deliverability provider" />
        {provError && (
          <p className="mb-3 text-xs text-slate-500">
            The provider status could not be read ({provError.message}) — the list below still comes from Harry&apos;s own rows.{' '}
            <button className="cursor-pointer underline underline-offset-2" onClick={loadProviders}>Try again</button>
          </p>
        )}

        {/* Nine of the twenty-eight upstream request shapes are not attested by
            the source documentation. That is stated here in full, and again in
            place on each control built on one. */}
        {contracts.count > 0 && (
          <details className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2">
            <summary className="cursor-pointer text-xs text-amber-800">
              {contracts.count} of the 28 upstream request contracts are unconfirmed — what that means
            </summary>
            <ul className="mt-2 space-y-1.5">
              {[...contracts.byKey.values()].map((entry) => (
                <li key={entry.key} className="text-[11px] leading-relaxed text-amber-700">
                  <span className="font-mono text-amber-800">{entry.key}</span>
                  <span className="ml-2 text-amber-700">
                    {entry.method}{entry.altMethod ? ` (falls back to ${entry.altMethod} on a 405)` : ''}
                  </span>
                  <div>{entry.note}</div>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* ---- filters ---- */}
        <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-sm">
            <span className="text-xs text-slate-600">Folder</span>
            <select className="input mt-1" value={folderId} onChange={(e) => { setParam('ipFolder', e.target.value); setSelected([]) }}>
              <option value="">All tests</option>
              <option value="0">Not filed</option>
              {(folders || []).map((f) => (
                <option key={f.id} value={f.id}>{f.name} ({f.testCount})</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-600">Status</span>
            <select className="input mt-1" value={status} onChange={(e) => { setParam('ipStatus', e.target.value); setSelected([]) }}>
              <option value="">Any status</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-600">Type</span>
            <select className="input mt-1" value={type} onChange={(e) => { setParam('ipType', e.target.value); setSelected([]) }}>
              <option value="">Manual and automated</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-600">Search by name</span>
            <input className="input mt-1" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Test name" />
          </label>
        </div>

        {foldersError && (
          <p className="mb-2 text-xs text-slate-500">
            Folders could not be loaded ({foldersError.message}).{' '}
            <button className="cursor-pointer underline underline-offset-2" onClick={loadFolders}>Try again</button>
          </p>
        )}

        {deleteError && (
          <p className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700" role="alert">
            {deleteError.message} — nothing was deleted and your selection is unchanged.
          </p>
        )}

        {/* ---- the list ---- */}
        {list.error && list.items.length === 0 && <ErrorState error={list.error} onRetry={list.reload} />}
        {list.error && list.items.length > 0 && (
          <p className="mb-2 text-xs text-amber-700" role="status">
            This list is not up to date — the last successful load is shown.{' '}
            <button className="cursor-pointer underline underline-offset-2" onClick={list.reload}>Try again</button>
          </p>
        )}

        {list.loading && list.items.length === 0 && !list.error && <Spinner label="Loading placement tests…" />}

        {!list.loading && !list.error && list.items.length === 0 && (
          <p className="text-sm text-slate-500">
            {filtered
              ? 'No placement tests match these filters.'
              : 'No placement tests yet — nothing has been seeded, so nothing here is a measurement of anything. '}
            {!filtered && (
              <button className="cursor-pointer text-accent-700 underline underline-offset-2 hover:text-accent-700" onClick={() => setShowCreate(true)}>
                Run a test
              </button>
            )}
          </p>
        )}

        {list.items.length > 0 && (
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[46rem] text-sm">
              <caption className="sr-only">Deliverability placement tests, most recently updated first</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th scope="col" className="w-8 py-2">
                    <input
                      type="checkbox"
                      checked={allOnPage}
                      onChange={() => setSelected(allOnPage ? [] : visibleIds)}
                      aria-label={allOnPage ? 'Clear the selection of every test on this page' : 'Select every test on this page'}
                    />
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">Test</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Type</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Schedule</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Current run</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Blocklist</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((t) => {
                  const on = chosen.includes(t.id)
                  const cad = cadence(t)
                  const start = localTime(t.scheduleStartTime)
                  const end = localTime(t.testEndDate)
                  return (
                    <tr key={t.id} className="border-b border-slate-200 last:border-0 align-top">
                      <td className="py-2">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => setSelected(on ? chosen.filter((id) => id !== t.id) : [...chosen, t.id])}
                          aria-label={`Select the test ${t.name}`}
                        />
                      </td>
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <button
                          type="button"
                          className="cursor-pointer text-ink-900 hover:text-accent-700"
                          onClick={() => setParam('ipTest', t.id)}
                        >
                          {t.name}
                        </button>
                        {t.folderName && <div className="text-[11px] text-slate-500">in {t.folderName}</div>}
                      </th>
                      <td className="py-2 pr-3 text-slate-600">{t.type}</td>
                      <td className="py-2 pr-3"><StatusChip value={t.status} /></td>
                      <td className="py-2 pr-3 text-slate-600">
                        {/* A manual test has no cadence, and "null" never appears. */}
                        {t.type === 'automated'
                          ? <>
                            <div>{cad || 'cadence not set'}</div>
                            <div className="text-[11px] text-slate-500">
                              {start ? `from ${start}` : 'no start time recorded'}{end ? ` until ${end}` : ''}
                            </div>
                          </>
                          : <span className="text-slate-500">runs once</span>}
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-slate-600">
                        {t.currentRunNo > 0 ? t.currentRunNo : <span className="text-slate-500">not started</span>}
                      </td>
                      <td className="py-2 pr-3 text-xs"><Blocklist blacklist={t.blacklist} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />

        <BulkBar count={chosen.length} onClear={() => setSelected([])}>
          <button className="btn-danger cursor-pointer" onClick={() => setConfirmDelete(true)}>
            Delete {chosen.length} test{chosen.length === 1 ? '' : 's'}
          </button>
        </BulkBar>
      </section>

      {confirmDelete && (
        <Confirm
          title={`Delete ${chosen.length} test${chosen.length === 1 ? '' : 's'}?`}
          body={
            `Every report, blocklist result, sender row and run recorded for ${chosen.length === 1 ? 'this test' : 'these tests'} is removed with ${chosen.length === 1 ? 'it' : 'them'}. ` +
            (runningChosen.length
              ? `${runningChosen.length} of them ${runningChosen.length === 1 ? 'is' : 'are'} still running (${runningChosen.map((t) => t.name).join(', ')}) — deleting also stops ${runningChosen.length === 1 ? 'its' : 'their'} schedule. `
              : '') +
            'This happens all at once: if any one of them cannot be deleted, none of them are.'
          }
          confirmLabel={`Delete ${chosen.length} test${chosen.length === 1 ? '' : 's'}`}
          danger
          onConfirm={deleteChosen}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      {showCreate && (
        <CreateTestForm
          folders={folders}
          providers={prov}
          announce={announce}
          onClose={() => setShowCreate(false)}
          onCreated={(created) => {
            setShowCreate(false)
            list.reload()
            loadFolders()
            if (created?.duplicateOf) {
              announce(`Created. Note: "${created.duplicateOf.name}" already runs on the same cadence for this campaign.`)
            }
            if (created?.id) setParam('ipTest', created.id)
          }}
        />
      )}

      {showFolders && (
        <DeliverabilityFolders
          folders={folders}
          loading={foldersLoading}
          error={foldersError}
          onReload={loadFolders}
          announce={announce}
          onSelect={(id) => { setParam('ipFolder', id); setSelected([]) }}
          onClose={() => setShowFolders(false)}
        />
      )}

      {openTestId && (
        <TestDetail
          key={openTestId}
          testId={openTestId}
          announce={announce}
          onChanged={() => { list.reload(); loadFolders() }}
          onClose={() => setParam('ipTest', '')}
        />
      )}
    </ContractsCtx.Provider>
  )
}
