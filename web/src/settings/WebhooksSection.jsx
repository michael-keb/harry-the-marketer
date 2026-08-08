// Webhooks — Docs/webhooks/*.md and the campaign-scoped files in Docs/campaigns/*.
//
// This sits directly under the Slack/Teams block because it is the same idea
// one step further out: "tell my own systems what happened". It is the second
// block in that section, not a new one (create.md §4).
//
// Two things this file deliberately cannot do:
//
//   * Show a signing secret. The secret is supplied once at creation (or
//     generated), and `server/parity/webhooks.js` has no read path that returns
//     it — the projection does not include the column. So the UI says that
//     plainly instead of offering a reveal that would have to fail.
//   * Replay failures for the whole workspace. The retrigger route the backlog
//     specifies is campaign-scoped (`POST /api/campaigns/:id/notifications/
//     retry`), so the replay control asks which campaign, rather than pretending
//     to a workspace-wide button that has no route behind it.
//
// The event checklist is rendered from `GET /api/webhooks/event-types`, so the
// constants stay on the server exactly as the frontend story requires.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import {
  Confirm, DateRange, Drawer, Modal, Spinner, EmptyState, ErrorState,
  LoadMore, LiveRegion, useToast,
} from '../parity-ui.jsx'
import { timeAgo } from '../ui.jsx'
import {
  Field, StatusPill, daysAgoDate, describedBy, errFor, isoFromDate, todayDate,
  usePaged, useFieldErrors,
} from './common.jsx'

function hostOf(url) {
  try { return new URL(url).host } catch { return url }
}

export default function WebhooksSection() {
  const [catalogue, setCatalogue] = useState(null)
  const [catalogueError, setCatalogueError] = useState(null)
  const [editing, setEditing] = useState(null)   // 'new' | webhook row
  const [openId, setOpenId] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [said, setSaid] = useState('')
  const toast = useToast()

  const params = useMemo(() => ({ scope: 'user', limit: 25 }), [])
  const list = usePaged('/api/webhooks', params)

  const loadCatalogue = useCallback(() => {
    setCatalogueError(null)
    api.get('/api/webhooks/event-types')
      .then((res) => setCatalogue(res?.data || []))
      .catch(setCatalogueError)
  }, [])
  useEffect(() => { loadCatalogue() }, [loadCatalogue])

  const toggleActive = async (hook) => {
    setBusyId(hook.id)
    try {
      const res = await api.patch(`/api/webhooks/${hook.id}`, { is_active: !hook.is_active })
      setSaid(`${res.data.name} ${res.data.is_active ? 'resumed' : 'paused'}.`)
      list.reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (hook) => {
    setBusyId(hook.id)
    try {
      await api.del(`/api/webhooks/${hook.id}`)
      toast(`“${hook.name}” removed`)
      setSaid(`${hook.name} removed. Its delivery history is kept.`)
      list.reload()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusyId(null)
      setDeleting(null)
    }
  }

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-ink-900">Send events to your own systems</h2>
          <p className="mt-1 text-sm text-slate-600">
            An HTTPS endpoint of yours, and a tick against each thing you want to hear about. Harry posts a signed
            JSON payload as it happens — a reply, a bounce, an email that needs your OK. Failures are retried three
            times, then the endpoint is rested rather than hammered.
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0"
          disabled={!catalogue}
          onClick={() => setEditing('new')}
        >
          Add endpoint
        </button>
      </div>

      {catalogueError ? (
        <ErrorState error={catalogueError} onRetry={loadCatalogue} />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : (list.loading && list.items.length === 0) || !catalogue ? (
        <Spinner label="Loading endpoints…" />
      ) : list.items.length === 0 ? (
        <EmptyState
          icon="pulse"
          title="No endpoints yet"
          hint="Add one to push replies, bounces and campaign changes into your CRM, your data warehouse, or a script you wrote this morning."
          action={<button type="button" className="btn-primary" onClick={() => setEditing('new')}>Add endpoint</button>}
        />
      ) : (
        <ul className="divide-y divide-slate-200">
          {list.items.map((hook) => (
            <li key={hook.id} className="py-3">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-ink-900">{hook.name}</span>
                    <StatusPill tone={hook.is_active ? 'good' : 'warn'}>
                      {hook.is_active ? 'Active' : 'Paused'}
                    </StatusPill>
                  </div>
                  <div className="truncate text-xs text-slate-500">{hostOf(hook.url)}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {hook.event_types.length === 0
                      ? 'Listening for nothing — no event is ticked, so this endpoint never fires.'
                      : `${hook.event_types.length} event${hook.event_types.length === 1 ? '' : 's'}: ${hook.event_labels.join(', ')}`}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button type="button" className="btn-ghost" onClick={() => setOpenId(hook.id)}>
                    Deliveries
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setEditing(hook)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer text-xs text-slate-600 hover:text-accent-700 disabled:opacity-40"
                    disabled={busyId === hook.id}
                    onClick={() => toggleActive(hook)}
                  >
                    {hook.is_active ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer text-xs text-slate-600 hover:text-red-600 disabled:opacity-40"
                    disabled={busyId === hook.id}
                    onClick={() => setDeleting(hook)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        Each request is signed with an <code className="font-mono">X-Harry-Signature</code> header. The signing
        secret is set once when the endpoint is created and is never shown again — Harry keeps it only to sign
        with, and no route returns it. Lost it? Remove the endpoint and add it again with a secret you choose.
      </p>

      <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
      <LiveRegion message={said} />

      {editing && catalogue && (
        <WebhookDialog
          catalogue={catalogue}
          hook={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(hook, created) => {
            setEditing(null)
            setSaid(`${hook.name} ${created ? 'added' : 'saved'}.`)
            list.reload()
          }}
        />
      )}

      {openId != null && catalogue && (
        <WebhookDrawer
          webhookId={openId}
          catalogue={catalogue}
          onClose={() => setOpenId(null)}
        />
      )}

      {deleting && (
        <Confirm
          title={`Remove “${deleting.name}”?`}
          body={`Harry stops posting to ${hostOf(deleting.url)} immediately, including any retry already queued. The delivery history is kept so you can still see what was sent and what failed.`}
          confirmLabel="Remove endpoint"
          danger
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  )
}

// ---- add / edit -------------------------------------------------------------

function WebhookDialog({ catalogue, hook, onClose, onSaved }) {
  const toast = useToast()
  const { errors, setErrors, capture, clear } = useFieldErrors()
  const [name, setName] = useState(hook?.name || '')
  const [url, setUrl] = useState(hook?.url || '')
  const [secret, setSecret] = useState('')
  const [events, setEvents] = useState(hook?.event_types || [])
  const [busy, setBusy] = useState(false)
  const [duplicate, setDuplicate] = useState(null)

  const nameError = errFor(errors, 'name')
  const urlError = errFor(errors, 'webhook_url', 'url')
  const eventsError = errFor(errors, 'event_types', 'event_type_map')
  const secretError = errFor(errors, 'secret')

  const toggle = (value) => setEvents((prev) => (
    prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
  ))

  const submit = async (e, { force = false } = {}) => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    clear()
    setDuplicate(null)
    try {
      if (hook) {
        const res = await api.patch(`/api/webhooks/${hook.id}`, {
          name: name.trim(), webhook_url: url.trim(), event_types: events,
        })
        onSaved(res.data, false)
      } else {
        const res = await api.post('/api/webhooks', {
          name: name.trim(),
          webhook_url: url.trim(),
          association_type: 'user',
          event_types: events,
          ...(secret.trim() ? { secret: secret.trim() } : {}),
          ...(force ? { force_create: true } : {}),
        })
        onSaved(res.data, true)
      }
    } catch (err) {
      // A duplicate URL in the same scope is a 409 that the caller may insist
      // past. It is shown against the URL field with the way out beside it.
      if (err?.payload?.error === 'duplicate_webhook') {
        setErrors({ webhook_url: err.payload.message })
        setDuplicate(true)
      } else if (!capture(err)) {
        toast(err.message, 'error')
      }
      setBusy(false)
    }
  }

  return (
    <Modal title={hook ? `Edit “${hook.name}”` : 'Add an endpoint'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-5">
        <Field id="hook-name" label="Name" hint="How you will recognise it — “CRM sync”, not “webhook 3”." error={nameError}>
          <input
            id="hook-name" className="input" required maxLength={200}
            value={name} onChange={(e) => setName(e.target.value)}
            {...describedBy('hook-name', { hint: true, error: nameError })}
          />
        </Field>

        <Field
          id="hook-url"
          label="URL"
          hint="Must be https and must be reachable from the internet — localhost and private addresses are refused, because an endpoint Harry cannot reach is an integration that silently does nothing."
          error={urlError}
        >
          <input
            id="hook-url" className="input" type="url" required placeholder="https://api.yourcompany.com/harry"
            value={url} onChange={(e) => setUrl(e.target.value)}
            {...describedBy('hook-url', { hint: true, error: urlError })}
          />
          {duplicate && (
            <button
              type="button"
              className="btn-ghost mt-2"
              disabled={busy}
              onClick={(e) => submit(e, { force: true })}
            >
              Add it anyway
            </button>
          )}
        </Field>

        <fieldset>
          <legend className="text-sm text-slate-700">What should it hear about?</legend>
          <p className="mt-0.5 text-xs text-slate-500">
            Tick nothing and the endpoint is registered but silent — a legitimate state, and one the list says out loud.
          </p>
          <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {catalogue.map((event) => (
              <label key={event.value} className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="cursor-pointer accent-accent-500"
                  checked={events.includes(event.value)}
                  onChange={() => toggle(event.value)}
                />
                {event.label}
              </label>
            ))}
          </div>
          {eventsError && <p className="mt-1 text-xs text-red-700">{eventsError}</p>}
          <div className="mt-2 flex gap-3 text-xs">
            <button
              type="button"
              className="cursor-pointer text-slate-600 underline hover:text-accent-700"
              onClick={() => setEvents(catalogue.map((e) => e.value))}
            >
              Select all
            </button>
            <button
              type="button"
              className="cursor-pointer text-slate-600 underline hover:text-accent-700"
              onClick={() => setEvents([])}
            >
              Clear
            </button>
          </div>
        </fieldset>

        {!hook && (
          <Field
            id="hook-secret"
            label="Signing secret (optional)"
            hint="Used to sign every request so your receiver can prove the payload came from Harry. Leave blank and Harry generates one. Either way it is never shown again — store your own now if you want to keep it."
            error={secretError}
          >
            <input
              id="hook-secret" className="input font-mono text-[12px]" maxLength={200} autoComplete="off"
              value={secret} onChange={(e) => setSecret(e.target.value)}
              {...describedBy('hook-secret', { hint: true, error: secretError })}
            />
          </Field>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !name.trim() || !url.trim()}>
            {busy ? 'Saving…' : hook ? 'Save endpoint' : 'Add endpoint'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ---- deliveries -------------------------------------------------------------

function WebhookDrawer({ webhookId, catalogue, onClose }) {
  const [hook, setHook] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setError(null)
    api.get(`/api/webhooks/${webhookId}`)
      .then((res) => setHook(res.data))
      .catch(setError)
  }, [webhookId])

  useEffect(() => { load() }, [load])

  const missing = error?.status === 404

  return (
    <Drawer title={hook ? hook.name : 'Endpoint'} onClose={onClose}>
      {missing ? (
        <EmptyState
          icon="alert"
          title="This endpoint no longer exists"
          hint="It was removed, perhaps in another tab. Its delivery history is kept, but there is nothing left to configure."
          action={<button type="button" className="btn-ghost" onClick={onClose}>Back to the list</button>}
        />
      ) : error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !hook ? (
        <Spinner label="Loading deliveries…" />
      ) : (
        <div className="space-y-6">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={hook.is_active ? 'good' : 'warn'}>
                {hook.is_active ? 'Active' : 'Paused'}
              </StatusPill>
              <span className="text-xs text-slate-500">{hook.scope === 'user' ? 'Whole workspace' : 'One campaign'}</span>
            </div>
            <div className="break-all text-xs text-slate-600">{hook.url}</div>
            {!hook.is_active && (
              <p className="text-xs text-amber-700">
                Paused. Harry rests an endpoint after five failures in a row; saving a correction to the URL or the
                event list resumes it.
              </p>
            )}
          </div>

          <fieldset>
            <legend className="text-sm font-semibold text-ink-900">Subscribed events</legend>
            <p className="mt-0.5 text-xs text-slate-500">Read-only here — edit the endpoint to change it.</p>
            {hook.event_types.length === 0 && (
              <p className="mt-1.5 text-xs text-amber-700" role="status">
                Nothing is ticked, so this endpoint never fires.
              </p>
            )}
            <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
              {catalogue.map((event) => {
                const on = hook.event_types.includes(event.value)
                return (
                  <li key={event.value} className={`text-xs ${on ? 'text-slate-700' : 'text-slate-400'}`}>
                    <span aria-hidden className="mr-1.5 font-mono">{on ? '[x]' : '[ ]'}</span>
                    <span className="sr-only">{on ? 'Subscribed: ' : 'Not subscribed: '}</span>
                    {event.label}
                  </li>
                )
              })}
            </ul>
          </fieldset>

          <div>
            <h3 className="text-sm font-semibold text-ink-900">Recent deliveries</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              The last ten attempts, newest first. Attempt 2 and 3 are Harry’s own retries of the same event.
            </p>
            {(hook.deliveries || []).length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">Nothing has been delivered to this endpoint yet.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[30rem] text-left text-sm">
                  <caption className="sr-only">Recent delivery attempts for {hook.name}</caption>
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-slate-500">
                      <th scope="col" className="py-2 pr-3 font-medium">When</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Event</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Result</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                      <th scope="col" className="py-2 font-medium">Attempt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {hook.deliveries.map((d) => (
                      <tr key={d.id} className="align-top">
                        <td className="py-2.5 pr-3 text-slate-600">{timeAgo(d.created_at)}</td>
                        <td className="py-2.5 pr-3 text-slate-700">{d.event_type}</td>
                        <td className="py-2.5 pr-3">
                          <StatusPill tone={d.ok ? 'good' : 'bad'}>{d.ok ? 'Delivered' : 'Failed'}</StatusPill>
                        </td>
                        <td className="py-2.5 pr-3 text-slate-600">
                          {d.status_code === 0 ? 'no response' : d.status_code}
                          {!d.ok && d.error && (
                            <div className="mt-0.5 break-words text-[11px] text-red-700">{d.error}</div>
                          )}
                        </td>
                        <td className="py-2.5 text-slate-600">{d.attempt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <button type="button" className="btn-ghost mt-3" onClick={load}>Refresh</button>
          </div>

          <div className="border-t border-slate-200 pt-5">
            <RetryFailed onDone={load} />
          </div>
        </div>
      )}
    </Drawer>
  )
}

// ---- replay -----------------------------------------------------------------

// The retrigger route is campaign-scoped by design (Docs/campaigns/
// retrigger-webhooks.md), so this asks which campaign rather than implying a
// workspace-wide replay that has no route behind it. A replay is idempotent:
// a payload that has since succeeded is never sent twice.
function RetryFailed({ onDone }) {
  const toast = useToast()
  const [campaigns, setCampaigns] = useState(null)
  const [campaignId, setCampaignId] = useState('')
  const [range, setRange] = useState({ from: daysAgoDate(7), to: todayDate() })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.get('/api/campaigns')
      .then((res) => setCampaigns(Array.isArray(res) ? res : (res?.data ?? res?.campaigns ?? res?.items ?? [])))
      .catch(() => setCampaigns([]))
  }, [])

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.post(`/api/campaigns/${campaignId}/notifications/retry`, {
        from: isoFromDate(range.from),
        to: isoFromDate(range.to, true),
      })
      setResult(res)
      onDone?.()
    } catch (err) {
      setError(err)
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink-900">Replay failed deliveries</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Resends events that failed and never succeeded afterwards. Harry replays one attempt per event, so running
        this twice does not deliver the same event twice. Replays are organised by campaign — pick the campaign
        whose events you want retried.
      </p>

      <div className="mt-3 space-y-3">
        <Field id="retry-campaign" label="Campaign">
          <select
            id="retry-campaign"
            className="input"
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            disabled={!campaigns || campaigns.length === 0}
          >
            <option value="">
              {campaigns === null ? 'Loading campaigns…' : campaigns.length === 0 ? 'No campaigns yet' : 'Choose a campaign…'}
            </option>
            {(campaigns || []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>

        <DateRange value={range} onChange={setRange} />

        <button type="button" className="btn-ghost" disabled={busy || !campaignId} onClick={run}>
          {busy ? 'Replaying…' : 'Replay failed deliveries'}
        </button>
      </div>

      <div aria-live="polite" className="mt-2 text-xs">
        {error && <p className="text-red-700">{error.message}</p>}
        {result && (
          <p className="text-slate-600">
            {result.message}
            {result.retriggered_count > 0 && (
              <> — {result.delivered_count} delivered, {result.failed_count} still failing, {result.skipped_count} skipped.</>
            )}
            {result.truncated && ' Only the first batch was replayed; run it again for the rest.'}
          </p>
        )}
      </div>
    </div>
  )
}
