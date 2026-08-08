// One mailbox, in a sheet rather than a route — so the list stays the
// destination and nothing new appears in navigation.
//
// It answers the two questions a mailbox raises: is it healthy, and who depends
// on it. Every field that can be edited saves on its own, so one bad value
// never blocks the rest, and every number that interacts with another one says
// so in words beside it.

import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Drawer, ErrorState, LiveRegion, TagChip, TagPicker, useToast } from '../parity-ui.jsx'
import { Badge, timeAgo } from '../ui.jsx'
import { DeleteDialog, SuspendDialog } from './Actions.jsx'
import { WarmupSettings, WarmupStats } from './Warmup.jsx'
import { Field, Section, Skeleton, StatusWord, fieldError, plural, useAnnounce } from './common.jsx'

// A field that saves itself on blur and reports its own outcome, because
// "every field saves independently" is only true if each one owns its state.
function SavedField({ id, label, help, mailbox, name, value, type = 'text', onSaved, extra = {} }) {
  const [draft, setDraft] = useState(value ?? '')
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)

  useEffect(() => { setDraft(value ?? '') }, [value])

  const commit = async () => {
    const next = type === 'number' ? Number(draft) : String(draft)
    if (next === value) return
    setState('saving')
    setError(null)
    try {
      await api.patch(`/api/mailboxes/${mailbox.id}`, { [name]: next })
      setState('saved')
      onSaved?.()
    } catch (err) {
      // The entered value is kept exactly as typed — never reverted under the
      // user just because the server refused it.
      setState('error')
      setError(err)
    }
  }

  return (
    <Field id={id} label={label} help={help} error={fieldError(error, name) || (error && !error.payload?.field ? error.message : '')}>
      {({ id: inputId, describedBy }) => (
        <input
          id={inputId}
          type={type}
          className="input"
          value={draft}
          disabled={state === 'saving'}
          aria-describedby={describedBy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          {...extra}
        />
      )}
    </Field>
  )
}

export default function MailboxDrawer({ mailboxId, fleet, onClose, onChanged }) {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [testing, setTesting] = useState(false)
  const [dialog, setDialog] = useState('')
  const [busyTag, setBusyTag] = useState(null)
  const [announcement, say] = useAnnounce()

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get(`/api/mailboxes/${mailboxId}?withCampaigns=1`)
      setData(res.data)
    } catch (err) {
      setError(err)
    }
  }, [mailboxId])

  useEffect(() => { load() }, [load])

  const refresh = () => { load(); onChanged?.() }

  const toggleTag = async (tag, on) => {
    setBusyTag(tag.id)
    try {
      const body = { appliesTo: 'mailbox', mailboxIds: [mailboxId], tagIds: [tag.id] }
      if (on) await api.post('/api/tags/assign', body)
      else await api.del('/api/tags/assign', body)
      say(on ? `Label ${tag.name} added` : `Label ${tag.name} removed`)
      refresh()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusyTag(null)
    }
  }

  const createTag = async (name) => {
    try {
      const res = await api.post('/api/tags', { appliesTo: 'mailbox', name })
      await toggleTag(res.data, true)
    } catch (err) {
      if (err.status === 409 && err.payload?.id) {
        toast(`“${name}” already exists — applying it instead`)
        await toggleTag({ id: err.payload.id, name }, true)
        return
      }
      toast(err.message, 'error')
    }
  }

  const runTest = async () => {
    setTesting(true)
    try {
      const res = await api.post(`/api/mailboxes/${mailboxId}/test`)
      const failed = (res.data?.checks || []).filter((c) => c.checked && !c.ok)
      say(failed.length ? `Check failed: ${failed.map((c) => c.detail).join('; ')}` : 'Connection check passed')
      toast(failed.length ? failed[0].detail : 'Connection check passed', failed.length ? 'error' : 'success')
      load()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setTesting(false)
    }
  }

  const title = data ? data.fromEmail : 'Mailbox'

  return (
    <Drawer
      title={title}
      onClose={onClose}
      footer={data && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button className="btn-ghost cursor-pointer" onClick={() => setDialog('suspend')}>
            {data.isSuspended ? `Resume ${data.fromEmail}` : `Suspend ${data.fromEmail}`}
          </button>
          <button className="btn-danger cursor-pointer" onClick={() => setDialog('delete')}>
            Remove mailbox
          </button>
        </div>
      )}
    >
      <LiveRegion message={announcement} />

      {error && <ErrorState error={error} onRetry={load} />}
      {!data && !error && <Skeleton rows={4} className="h-20" />}

      {data && (
        <div className="space-y-4">
          {/* --- what it is doing right now ------------------------------- */}
          <Section id="mb-sending" title="Sending">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
              <Badge value={data.isSuspended ? 'paused' : data.status} />
              <span className="text-slate-600">{data.type === 'GMAIL' ? 'Gmail (OAuth)' : 'Sandbox — nothing leaves this machine'}</span>
              {data.isSuspended && (
                <span className="text-amber-700">
                  Suspended{data.suspendedAt ? ` ${timeAgo(data.suspendedAt)}` : ''}
                  {data.suspendedReason ? ` — ${data.suspendedReason}` : ''}
                </span>
              )}
            </div>

            <p className="mt-2 text-xs text-slate-600">
              {data.sending?.ok
                ? `Ready to send. ${data.sending.sentToday} of ${data.sending.cap} used today, ${data.sending.remainingToday} left.`
                : `Not sending — ${data.sending?.reason || 'no reason given'}.`}
            </p>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <SavedField
                id={`mb-name-${data.id}`} label="Display name" mailbox={data} name="fromName"
                value={data.fromName} onSaved={refresh}
                help="The name recipients see beside the address."
              />
              <SavedField
                id={`mb-limit-${data.id}`} label="Daily limit" type="number" mailbox={data} name="dailyLimit"
                value={data.messagePerDay} onSaved={refresh} extra={{ min: 1, max: 2000, inputMode: 'numeric' }}
                help={`Harry's ramp allows ${data.sending?.pacingCap ?? data.messagePerDay} today, so raising this moves the ceiling rather than today's number.`}
              />
              <SavedField
                id={`mb-track-${data.id}`} label="Tracking domain" mailbox={data} name="trackingDomain"
                value={data.trackingDomain} onSaved={refresh}
                help="A hostname such as links.example.com. Leave empty to use Harry's own."
                extra={{ placeholder: 'links.example.com' }}
              />
              <SavedField
                id={`mb-sig-${data.id}`} label="Signature (simple HTML)" mailbox={data} name="signature"
                value={data.signature} onSaved={refresh}
                help="Anything other than basic formatting is stripped. Harry's one-click unsubscribe line is appended after it and cannot be replaced."
              />
            </div>
          </Section>

          {/* --- health, per leg ------------------------------------------ */}
          <Section
            id="mb-health"
            title="Health"
            hint="Sending and reading are checked separately: a mailbox that cannot read replies can still send, and saying so is the point."
            action={(
              <button className="btn-ghost text-xs cursor-pointer" onClick={runTest} disabled={testing}>
                {testing ? 'Checking…' : 'Re-check connection'}
              </button>
            )}
          >
            <ul className="space-y-1.5">
              {(data.connection?.checks || []).map((c, i) => (
                <li key={`${c.leg}-${i}`} className="flex flex-wrap items-baseline gap-2">
                  <StatusWord ok={c.ok} unknown={!c.checked}>
                    {c.leg === 'send' ? 'Sending' : c.leg === 'read' ? 'Reading replies' : c.leg === 'oauth' ? 'Google sign-in' : 'Sandbox'}
                    {!c.checked ? ' — not checked' : c.ok ? ' — working' : ' — broken'}
                  </StatusWord>
                  <span className="text-xs text-slate-600">{c.detail}</span>
                </li>
              ))}
            </ul>
            {data.lastSyncAt && (
              <p className="mt-2 text-[11px] text-slate-500">Last inbound sync {timeAgo(data.lastSyncAt)}</p>
            )}
          </Section>

          {/* --- labels ---------------------------------------------------- */}
          <Section id="mb-labels" title="Labels" hint="Every label shows its name as text; the colour is decoration.">
            <div className="flex flex-wrap gap-1.5 mb-3">
              {data.tags?.length
                ? data.tags.map((t) => <TagChip key={t.id} tag={t} onRemove={() => toggleTag(t, false)} />)
                : <span className="text-xs text-slate-500">No labels on this mailbox yet.</span>}
            </div>
            <TagPicker
              appliesTo="mailbox"
              selected={(data.tags || []).map((t) => t.id)}
              onToggle={toggleTag}
              onCreate={createTag}
              busyId={busyTag}
            />
          </Section>

          {/* --- warm-up --------------------------------------------------- */}
          <WarmupSettings mailbox={data} onSaved={refresh} />
          <WarmupStats mailbox={data} />

          {/* --- who depends on it ----------------------------------------- */}
          <Section id="mb-usedby" title="Used by">
            {data.campaigns?.length ? (
              <ul className="space-y-1">
                {data.campaigns.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 text-xs">
                    <a className="text-accent-700 hover:underline" href={`/campaigns/${c.id}`}>{c.name}</a>
                    <Badge value={c.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">No campaign uses this mailbox yet.</p>
            )}
          </Section>

          {/* --- what removing it would cost -------------------------------- */}
          <Section id="mb-impact" title="Before you remove it">
            <p className="text-xs text-slate-600">
              {plural(data.deleteImpact?.campaignsAttached ?? 0, 'campaign')} attached ·{' '}
              {plural(data.deleteImpact?.draftsWaiting ?? 0, 'draft')} waiting for approval
              {data.deleteImpact?.wouldHold?.length
                ? ` · ${plural(data.deleteImpact.wouldHold.length, 'campaign')} already holding because of it`
                : ''}
            </p>
          </Section>
        </div>
      )}

      {data && dialog === 'suspend' && (
        <SuspendDialog
          mailbox={data}
          fleet={fleet}
          onClose={() => setDialog('')}
          onDone={(message, kind) => { toast(message, kind === 'error' ? 'error' : 'success'); say(message); refresh() }}
        />
      )}
      {data && dialog === 'delete' && (
        <DeleteDialog
          mailbox={data}
          impact={data.deleteImpact}
          fleet={fleet}
          onClose={() => setDialog('')}
          onDone={(message) => { toast(message); onChanged?.(); onClose() }}
        />
      )}
    </Drawer>
  )
}
