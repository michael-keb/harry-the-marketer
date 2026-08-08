// Find missing addresses for leads that have a name and a company but no
// usable email.
//
// Routes: POST /api/leads/find-emails, GET /api/leads/find-emails/:jobId.
//
// Three things about this screen are deliberate.
//
// **Nothing is overwritten.** The server fills a blank address and refuses to
// replace one a human already entered; a difference comes back as a report, not
// an edit. So the only place an existing address can change is the explicit
// old-versus-new choice below, which goes through the normal lead update and
// therefore still gets the suppression and duplicate checks.
//
// **Skipped is a group, not a silence.** A lead without a first name, last name
// or company domain cannot be looked up at all. Those leads are counted, named
// and given their missing field, because a lookup that quietly covered 40 of 60
// selected leads reads as "20 not found" and is acted on as if the provider had
// answered.
//
// **Progress is honest about its grain.** The route processes every batch inside
// one request and answers once, at the end, so this shows the work it knows is
// coming — how many leads, in how many batches of ten — rather than a fake
// counter ticking against nothing. Per-batch progress would need the server to
// run the job in the background; the job row and its status route exist, so that
// is a server change away, not a rewrite here.

import { useCallback, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Spinner, useToast } from '../ui.jsx'
import { LiveRegion } from '../parity-ui.jsx'
import { Sheet, fmt } from './shared.jsx'

const BATCH = 10        // the provider's documented per-request ceiling
const MAX_LEADS = 500   // one job's worth, mirrored from the server

// Two shapes reach this screen and they disagree about case. `GET /api/leads`
// serves the table its rows straight out of SQLite (`first_name`), while the
// lead drawer holds a shaped record (`firstName`). Reading only one of them is
// not a cosmetic bug: every field comes back undefined, every lead is declared
// ineligible, and the screen refuses to look up leads the server would have
// accepted. So each field is read under both names.
const field = (lead, camel, snake) => String(lead?.[camel] ?? lead?.[snake] ?? '').trim()

// The same three requirements the server checks, applied here so a lead that
// cannot be looked up is named before the request rather than after it.
export function eligibility(lead) {
  const missing = []
  if (!field(lead, 'firstName', 'first_name')) missing.push('first name')
  if (!field(lead, 'lastName', 'last_name')) missing.push('last name')
  const fromEmail = String(lead?.email || '').split('@')[1] || ''
  if (!field(lead, 'website', 'website') && !fromEmail.trim()) missing.push('company website')
  return { eligible: missing.length === 0, missing }
}

// What to call a lead in a result row, whichever shape it arrived in.
const leadName = (lead, id) =>
  [field(lead, 'firstName', 'first_name'), field(lead, 'lastName', 'last_name')].filter(Boolean).join(' ')
  || lead?.email
  || `Lead ${id}`

const MISSING_WORDS = {
  firstName: 'first name',
  lastName: 'last name',
  companyDomain: 'company website',
}

// The provider grades an address it found. The word is its own; Harry shows it
// rather than translating it into a confidence it did not express.
function VerificationTag({ status }) {
  const text = String(status || '').trim()
  if (!text) {
    return <span className="text-[11px] text-slate-500">no verification status given</span>
  }
  return <span className="text-[11px] text-slate-600">verification: {text}</span>
}

export default function FindEmails({ leads = [], onClose, onChanged }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [live, setLive] = useState('')
  const [resolved, setResolved] = useState({})   // leadId -> 'kept' | 'replaced'

  const split = useMemo(() => {
    const ok = []
    const skipped = []
    for (const lead of leads) {
      const { eligible, missing } = eligibility(lead)
      if (eligible) ok.push(lead)
      else skipped.push({ lead, missing })
    }
    return { ok, skipped }
  }, [leads])

  const byId = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads])
  const batches = Math.ceil(split.ok.length / BATCH)
  const overCeiling = split.ok.length > MAX_LEADS

  const run = useCallback(async (ids) => {
    setBusy(true)
    setError(null)
    setLive(`Looking up ${fmt(ids.length)} lead${ids.length === 1 ? '' : 's'}…`)
    try {
      const res = await api.post('/api/leads/find-emails', { leadIds: ids })
      setResult(res)
      if (res.status === 'failed') {
        setLive(res.error || 'The lookup stopped early.')
      } else {
        setLive(`Finished. ${fmt(res.found || 0)} address${res.found === 1 ? '' : 'es'} found.`)
      }
      if (res.found > 0) onChanged?.()
    } catch (err) {
      setError(err)
      setLive('The lookup could not start.')
    } finally {
      setBusy(false)
    }
  }, [onChanged])

  // A job survives a reload; this re-reads one by id so a refreshed browser can
  // pick the result back up instead of running the lookup twice.
  const reread = useCallback(async (jobId) => {
    try {
      setResult(await api.get(`/api/leads/find-emails/${jobId}`))
    } catch (err) {
      setError(err)
    }
  }, [])

  const rows = Array.isArray(result?.results) ? result.results : []
  const found = rows.filter((r) => r.written)
  const differs = rows.filter((r) => r.reason === 'differs_from_existing')
  const notFound = rows.filter((r) => r.reason === 'not_found')
  const serverSkipped = Array.isArray(result?.ineligible) ? result.ineligible : []

  // Leads the provider never got to, because the job stopped. Offering "resume"
  // on the whole selection would re-spend credit on addresses already found.
  const unresolvedIds = useMemo(() => {
    if (!result || result.status !== 'failed') return []
    const seen = new Set(rows.map((r) => r.leadId))
    return split.ok.map((l) => l.id).filter((id) => !seen.has(id))
  }, [result, rows, split.ok])

  const outOfCredit = result?.status === 'failed' && /credit/i.test(String(result.error || ''))

  const applyNew = async (row) => {
    try {
      await api.patch(`/api/leads/${row.leadId}`, { email: row.email })
      setResolved((s) => ({ ...s, [row.leadId]: 'replaced' }))
      setLive(`Address for lead ${row.leadId} replaced with ${row.email}.`)
      onChanged?.()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <Sheet
      title="Find missing addresses"
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-slate-600">
            {result
              ? `Job ${result.jobId} — ${result.status}`
              : `${fmt(split.ok.length)} of ${fmt(leads.length)} selected lead${leads.length === 1 ? '' : 's'} can be looked up`}
          </span>
          <span className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {result ? 'Done' : 'Cancel'}
            </button>
            {!result && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy || split.ok.length === 0 || overCeiling}
                onClick={() => run(split.ok.map((l) => l.id))}
              >
                {busy ? 'Looking up…' : `Look up ${fmt(split.ok.length)}`}
              </button>
            )}
            {result?.status === 'failed' && unresolvedIds.length > 0 && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => { setResult(null); run(unresolvedIds) }}
              >
                Resume the remaining {fmt(unresolvedIds.length)}
              </button>
            )}
          </span>
        </div>
      }
    >
      <LiveRegion message={live} />

      {/* ---- before the run ------------------------------------------------ */}
      {!result && (
        <div className="space-y-3 text-sm">
          <p className="text-slate-700">
            Harry asks the prospect data provider for an address using each lead's first name, last name and company
            domain. A lead already holding an address is still checked, but an existing address is never overwritten —
            a difference comes back for you to decide on.
          </p>

          {overCeiling && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">
              One lookup covers at most {fmt(MAX_LEADS)} leads and {fmt(split.ok.length)} are selected. Narrow the
              selection and run it in more than one pass.
            </p>
          )}

          <dl className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg bg-slate-100/60 px-3 py-2">
              <dt className="text-xs text-slate-600">Can be looked up</dt>
              <dd className="text-lg font-semibold tabular-nums text-ink-950">{fmt(split.ok.length)}</dd>
              {batches > 0 && (
                <dd className="text-[11px] text-slate-500">
                  in {fmt(batches)} batch{batches === 1 ? '' : 'es'} of {BATCH}
                </dd>
              )}
            </div>
            <div className="rounded-lg bg-slate-100/60 px-3 py-2">
              <dt className="text-xs text-slate-600">Skipped — missing details</dt>
              <dd className="text-lg font-semibold tabular-nums text-ink-950">{fmt(split.skipped.length)}</dd>
            </div>
          </dl>

          {split.skipped.length > 0 && (
            <details className="rounded-lg border border-slate-200 p-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-700">
                Which {fmt(split.skipped.length)} are skipped, and why
              </summary>
              <ul className="mt-2 space-y-1 text-xs">
                {split.skipped.slice(0, 50).map(({ lead, missing }) => (
                  <li key={lead.id} className="flex flex-wrap justify-between gap-2">
                    <span className="text-slate-700">{lead.email || leadName(lead, lead.id)}</span>
                    <span className="text-slate-500">no {missing.join(', no ')}</span>
                  </li>
                ))}
                {split.skipped.length > 50 && (
                  <li className="text-slate-500">… and {fmt(split.skipped.length - 50)} more</li>
                )}
              </ul>
            </details>
          )}

          {split.ok.length === 0 && (
            <p className="rounded-lg bg-slate-100/60 px-3 py-2 text-xs text-slate-700">
              None of the selected leads can be looked up. The provider needs a first name, a last name and a company
              domain for every lookup — add those on the lead, or import them, and try again.
            </p>
          )}

          {busy && (
            <div className="sticky bottom-0 -mx-5 border-t border-slate-200 bg-white px-5 py-3 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
              <Spinner label={`Looking up ${fmt(split.ok.length)} lead(s) in ${fmt(batches)} batch(es)…`} />
              <p className="mt-1 text-[11px] text-slate-500">
                Every batch runs inside one request, so the result arrives together rather than batch by batch.
              </p>
            </div>
          )}

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
              {error.status === 401
                ? 'Your session expired — sign in again. Nothing was looked up and no credit was spent.'
                : `${error.message} Nothing was changed.`}
            </p>
          )}
        </div>
      )}

      {/* ---- after the run -------------------------------------------------- */}
      {result && (
        <div className="space-y-4 text-sm">
          {outOfCredit && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">
              You are out of email-finding credits, so the job stopped where it was. Everything found before it stopped
              is listed below and has already been saved. Nothing was retried, because a retry cannot create credit.
            </p>
          )}
          {result.status === 'failed' && !outOfCredit && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">
              {result.error || 'The lookup stopped early.'} Completed batches were kept — resume covers only the leads
              that were never reached.
            </p>
          )}
          {result.configured === false && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {result.message || 'The prospect provider is not connected, so no lookup ran.'} The job was recorded and
              can be run again once the provider is configured.
            </p>
          )}

          <Group
            title="Addresses found"
            count={found.length}
            empty="No new addresses were found."
          >
            {found.map((row) => (
              <li key={row.leadId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1">
                <span className="text-slate-700">{leadName(byId.get(row.leadId), row.leadId)} — <span className="break-all font-medium text-ink-950">{row.email}</span></span>
                <VerificationTag status={row.verificationStatus} />
              </li>
            ))}
          </Group>

          <Group
            title="Different from the address already on the lead"
            count={differs.length}
            empty={null}
            note="Nothing here has been changed. Pick one address per lead; keeping the existing one needs no action."
          >
            {differs.map((row) => {
              const choice = resolved[row.leadId]
              return (
                <li key={row.leadId} className="rounded border border-slate-200 p-2">
                  <dl className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-[11px] text-slate-600">On the lead now</dt>
                      <dd className="break-all text-sm text-ink-950">{row.existing}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-600">Found by the provider</dt>
                      <dd className="break-all text-sm text-ink-950">{row.email}</dd>
                      <dd><VerificationTag status={row.verificationStatus} /></dd>
                    </div>
                  </dl>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                    {choice === 'replaced' ? (
                      <span className="text-slate-700">Replaced with the found address.</span>
                    ) : choice === 'kept' ? (
                      <span className="text-slate-700">Kept the existing address.</span>
                    ) : (
                      <>
                        <button type="button" className="cursor-pointer text-accent-700 underline" onClick={() => applyNew(row)}>
                          Use the found address
                        </button>
                        <button
                          type="button"
                          className="cursor-pointer text-slate-600 underline"
                          onClick={() => setResolved((s) => ({ ...s, [row.leadId]: 'kept' }))}
                        >
                          Keep the existing one
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </Group>

          <Group
            title="No address found"
            count={notFound.length}
            empty={null}
            note="The provider answered and had nothing for these. Their lead records are unchanged."
          >
            {notFound.map((row) => (
              <li key={row.leadId} className="py-1 text-slate-700">
                {leadName(byId.get(row.leadId), row.leadId)}
                {byId.get(row.leadId)?.company ? ` at ${byId.get(row.leadId).company}` : ''}
              </li>
            ))}
          </Group>

          <Group
            title="Skipped — missing details"
            count={serverSkipped.length}
            empty={null}
            note="These were never sent to the provider, so no credit was spent on them."
          >
            {serverSkipped.map((row) => (
              <li key={row.leadId} className="flex flex-wrap justify-between gap-2 py-1">
                <span className="text-slate-700">{byId.get(row.leadId)?.email || `Lead ${row.leadId}`}</span>
                <span className="text-slate-500">
                  no {(row.missing || []).map((m) => MISSING_WORDS[m] || m).join(', no ')}
                </span>
              </li>
            ))}
          </Group>

          <p className="text-[11px] text-slate-500">
            Job {result.jobId}.{' '}
            <button type="button" className="cursor-pointer text-accent-700 underline" onClick={() => reread(result.jobId)}>
              Re-read this result
            </button>{' '}
            — the job is stored, so closing this panel does not lose it.
          </p>
        </div>
      )}
    </Sheet>
  )
}

// A counted, labelled group. The count is text rather than a badge so a screen
// reader gets it from the heading rather than from an adjacent pill.
function Group({ title, count, empty, note, children }) {
  if (count === 0 && empty === null) return null
  return (
    <section>
      <h3 className="text-xs font-semibold text-slate-700">{title}: {fmt(count)}</h3>
      {note && count > 0 && <p className="mt-0.5 text-[11px] text-slate-500">{note}</p>}
      {count === 0 ? (
        <p className="mt-1 text-xs text-slate-500">{empty}</p>
      ) : (
        <ul className="mt-1.5 space-y-1 text-xs">{children}</ul>
      )}
    </section>
  )
}
