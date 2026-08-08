// The block list — Docs/utilities/domain-block-list.md.
//
// A suppression list is one of the few settings people genuinely read, so it is
// a list you can search and edit rather than a rule you have to trust.
//
// The deliberate divergence from the source API, stated in Docs/README.md and
// repeated here in the UI: suppression is unconditional. SmartLead offers
// `ignore_unsubscribe_list` and `ignore_global_block_list` on import; Harry does
// not, because a suppression list with a bypass is a suppression list that will
// one day be bypassed. There is no toggle on this screen for the same reason.
//
// Paging is by offset because `GET /api/block-list` is offset-paged (the spec
// names `offset` and `limit`), unlike the keyset lists elsewhere in Settings.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, qs } from '../api.js'
import {
  Confirm, Spinner, EmptyState, ErrorState, LiveRegion, useToast,
} from '../parity-ui.jsx'
import { timeAgo } from '../ui.jsx'
import { Field, StatusPill, describedBy, errFor, useFieldErrors } from './common.jsx'

const PAGE_SIZE = 50

const DUPLICATE_REASON = {
  already_blocked: 'already on the list',
  duplicate_in_request: 'listed twice in what you pasted',
}

export default function BlockListSection() {
  const toast = useToast()
  const { errors, capture, clear } = useFieldErrors()

  const [paste, setPaste] = useState('')
  const [adding, setAdding] = useState(false)
  const [outcome, setOutcome] = useState(null)
  const [said, setSaid] = useState('')

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [nextOffset, setNextOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busyId, setBusyId] = useState(null)

  // TC-5: typing in the search box must not fire a request per keystroke.
  const timer = useRef(null)
  useEffect(() => {
    timer.current = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(timer.current)
  }, [search])

  const load = useCallback(async (offset = 0) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`/api/block-list${qs({ offset: offset || undefined, limit: PAGE_SIZE, search: query || undefined })}`)
      const page = res?.data || []
      setRows((prev) => (offset ? [...prev, ...page] : page))
      setTotal(res?.total ?? page.length)
      setHasMore(Boolean(res?.hasMore))
      setNextOffset(res?.nextOffset ?? 0)
    } catch (err) {
      // "error keeps loaded rows and offers Retry" — the rows already on screen
      // are still true, so they stay.
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => { load(0) }, [load])

  const submit = async (e) => {
    e.preventDefault()
    if (adding || !paste.trim()) return
    setAdding(true)
    clear()
    setOutcome(null)
    try {
      const res = await api.post('/api/block-list', { domain_block_list: paste })
      setOutcome(res)
      setPaste('')
      setSaid(
        `${res.addedCount} added, ${res.duplicateCount} already present, ${res.rejectedCount} rejected.`,
      )
      load(0)
    } catch (err) {
      if (!capture(err)) toast(err.message, 'error')
    } finally {
      setAdding(false)
    }
  }

  const remove = async (entry) => {
    setBusyId(entry.id)
    try {
      await api.del(`/api/block-list/${entry.id}`)
      toast(`${entry.value} removed — leads there can be contacted again`)
      setSaid(`${entry.value} removed from the block list.`)
      load(0)
    } catch (err) {
      // A second delete 404s, which reads as already-removed rather than an error.
      if (err?.status === 404) { toast(`${entry.value} was already removed`); load(0) }
      else toast(err.message, 'error')
    } finally {
      setBusyId(null)
      setRemoving(null)
    }
  }

  const pasteError = errFor(errors, 'domain_block_list', 'domainBlockList')
  const showSearch = total > 5 || query !== ''

  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="font-semibold text-ink-900">Never contact</h2>
        <p className="mt-1 text-sm text-slate-600">
          Addresses and whole domains Harry will never email — a competitor, a former client, an address that
          bounced. This is checked immediately before every send, in one place, so no campaign you write later can
          reach them.
        </p>
        <p className="mt-1.5 text-sm text-slate-600">
          <span className="text-slate-700">There is no way round it, by design.</span>{' '}
          Suppression here is unconditional: no import setting, no per-campaign override, no “send anyway”. A
          blocked lead never even produces a draft for you to approve.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <Field
          id="block-paste"
          label="Add addresses or domains"
          hint="One per line, or separated by commas — paste as many as you like. A bare domain such as competitor.com also blocks every subdomain of it, so ana@mail.competitor.com is covered."
          error={pasteError}
        >
          <textarea
            id="block-paste"
            className="input min-h-24 font-mono text-[13px]"
            placeholder={'competitor.com\nspam@example.com, other.co.uk'}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            {...describedBy('block-paste', { hint: true, error: pasteError })}
          />
        </Field>
        <div className="flex justify-end">
          <button type="submit" className="btn-primary" disabled={adding || !paste.trim()}>
            {adding ? 'Adding…' : 'Add to the list'}
          </button>
        </div>
      </form>

      {outcome && <Outcome outcome={outcome} onDismiss={() => setOutcome(null)} />}

      {showSearch && (
        <div>
          <label className="sr-only" htmlFor="block-search">Search the block list</label>
          <input
            id="block-search"
            className="input"
            type="search"
            placeholder="Search what is blocked…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {query && !loading && (
            <p className="mt-1 text-xs text-slate-500">
              {rows.length === 0 ? `Nothing matches “${query}”.` : `Matching “${query}” — ${total} entr${total === 1 ? 'y' : 'ies'}.`}
            </p>
          )}
        </div>
      )}

      {error && rows.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="status">
          {error.message}{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => load(0)}>Try again</button>
        </div>
      )}

      {error && rows.length === 0 ? (
        <ErrorState error={error} onRetry={() => load(0)} />
      ) : loading && rows.length === 0 ? (
        <Spinner label="Loading the block list…" />
      ) : rows.length === 0 ? (
        query ? (
          <p className="text-sm text-slate-500">Nothing on the list matches that.</p>
        ) : (
          <EmptyState
            icon="alert"
            title="Nothing is blocked yet"
            hint="Unsubscribes and hard bounces are added here on their own. Use the box above for the handful you want to add by hand."
          />
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-left text-sm">
              <caption className="sr-only">
                Addresses and domains Harry will never contact — {total} entries
              </caption>
              <thead>
                <tr className="text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className="py-2 pr-3 font-medium">Blocked</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Why</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Added</th>
                  <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {rows.map((entry) => (
                  <tr key={entry.id} className="align-top">
                    <td className="py-2.5 pr-3">
                      <span className="break-all font-mono text-[13px] text-ink-900">{entry.value}</span>
                      <div className="text-[11px] text-slate-500">
                        {entry.isDomain ? 'whole domain, including subdomains' : 'this address only'}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <StatusPill tone={entry.source === 'manual' ? 'neutral' : 'warn'}>
                        {entry.sourceLabel}
                      </StatusPill>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-slate-600">
                      {timeAgo(entry.createdAt)}
                      {entry.createdBy && <div className="text-[11px] text-slate-500">{entry.createdBy}</div>}
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        disabled={busyId === entry.id}
                        className="cursor-pointer text-xs text-slate-600 hover:text-red-600 disabled:opacity-40"
                        aria-label={`Remove ${entry.value} from the block list`}
                        onClick={() => setRemoving(entry)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div className="flex justify-center">
              <button type="button" className="btn-ghost" disabled={loading} onClick={() => load(nextOffset)}>
                {loading ? 'Loading…' : `Load more (${rows.length} of ${total})`}
              </button>
            </div>
          )}
        </>
      )}

      <LiveRegion message={said} />

      {removing && (
        <Confirm
          title={`Remove ${removing.value}?`}
          body={
            removing.isDomain
              ? `Every lead at ${removing.value} and its subdomains becomes contactable again, including any campaign already running. The removal is written to the activity trail.`
              : `${removing.value} becomes contactable again, including by any campaign already running. The removal is written to the activity trail.`
          }
          confirmLabel="Remove from the list"
          danger
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  )
}

// What a paste actually did. All three outcomes are shown, because a paste that
// silently drops a typo is a paste that quietly fails to block a competitor.
function Outcome({ outcome, onDismiss }) {
  const { addedCount = 0, duplicateCount = 0, rejectedCount = 0, added = [], duplicates = [], rejected = [] } = outcome
  return (
    // Not a live region itself: the counts are announced once through
    // LiveRegion, and repeating the whole breakdown would talk over the reader.
    <div className="rounded-lg border border-slate-300 bg-white p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          <p className="text-ink-900">
            {addedCount} added · {duplicateCount} already there · {rejectedCount} not accepted
          </p>

          {addedCount > 0 && (
            <p className="text-xs text-slate-600">
              <span className="text-slate-700">Now blocked:</span>{' '}
              {added.map((a) => a.value).join(', ')}
            </p>
          )}

          {duplicateCount > 0 && (
            <ul className="space-y-0.5 text-xs text-slate-500">
              {duplicates.map((d, i) => (
                <li key={`${d.value || d.input}-${i}`}>
                  <span className="font-mono text-slate-600">{d.value || d.input}</span>{' '}
                  — {DUPLICATE_REASON[d.reason] || 'already present'}, nothing changed
                </li>
              ))}
            </ul>
          )}

          {rejectedCount > 0 && (
            <ul className="space-y-0.5 text-xs text-red-700">
              {rejected.map((r, i) => (
                <li key={`${r.input}-${i}`}>{r.message || `“${r.input}” was not accepted`}</li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className="shrink-0 cursor-pointer text-xs text-slate-500 hover:text-slate-700"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
