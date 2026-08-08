// The lead detail — Docs/leads/*.
//
// One drawer holding everything Harry knows about a person: the extended
// fields, the custom-field bag, the derived stage, the campaigns they are in,
// the agent's research profile, the human notes, the follow-up tasks, the
// activity trail, and the one act that is genuinely global rather than
// per-campaign — unsubscribing.
//
// The stage is never edited here because it is never stored: server/stages.js
// derives it from messages, outcomes and signed agreements, so a control that
// set it would be lying.

import { useCallback, useEffect, useState } from 'react'
import { api, qs } from '../api.js'
import { Spinner, EmptyState, ErrorState, Badge, Icon, useToast, timeAgo } from '../ui.jsx'
import { Confirm, Drawer, Tabs, LiveRegion } from '../parity-ui.jsx'
import { LeadLabels } from './labels.jsx'
import NotesPanel from './NotesPanel.jsx'
import { LeadTasks } from './tasks.jsx'
import FindEmails from './FindEmails.jsx'
import { Field, FieldError, FormError, Panel, when } from './shared.jsx'

const TEXT_FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['company', 'Company'],
  ['title', 'Title'],
  ['phone', 'Phone'],
  ['website', 'Website'],
  ['linkedin', 'LinkedIn'],
  ['location', 'Location'],
]

export default function LeadDetail({ leadId, onClose, onChanged }) {
  const [tab, setTab] = useState('details')
  const [finding, setFinding] = useState(false)
  const [lead, setLead] = useState(null)
  const [enrolments, setEnrolments] = useState([])
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get(`/api/leads/${leadId}`)
      setLead(res.data)
      setEnrolments(res.enrolments || [])
    } catch (err) { setError(err) }
  }, [leadId])

  useEffect(() => { load() }, [load])

  const name = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email : 'Lead'

  return (
    <Drawer title={name} onClose={onClose}>
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !lead ? (
        <Spinner label="Loading lead…" />
      ) : (
        <div className="space-y-4">
          <header className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge value={lead.stage} />
              <span className="text-xs text-slate-500">stage is derived from what has happened, not set by hand</span>
            </div>
            <p className="text-sm text-slate-700">{lead.email}</p>
            {/* Where an address came from matters when it was guessed rather
                than given: the provider's own verification word is shown as it
                came, never rounded up into "verified". */}
            {(lead.emailSource || lead.emailVerificationStatus) && (
              <p className="text-[11px] text-slate-500">
                {lead.emailSource === 'find_emails' ? 'Found by the prospect data provider' : `Source: ${lead.emailSource}`}
                {lead.emailVerificationStatus ? ` — verification: ${lead.emailVerificationStatus}` : ''}
              </p>
            )}
            <button
              type="button"
              className="cursor-pointer text-[11px] text-accent-700 underline"
              onClick={() => setFinding(true)}
            >
              {lead.email ? 'Check this address against the provider' : 'Find an address for this lead'}
            </button>
            {lead.status === 'unsubscribed' && (
              <p className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs text-red-700">
                <Icon name="alert" className="size-3.5" />
                Unsubscribed{lead.unsubscribedAt ? ` on ${when(lead.unsubscribedAt)}` : ''}
                {lead.unsubscribedSource ? ` (${lead.unsubscribedSource})` : ''} — suppressed everywhere
              </p>
            )}
            {lead.status === 'bounced' && (
              <p className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
                <Icon name="alert" className="size-3.5" />
                Hard bounced — excluded from every send
              </p>
            )}
            <LeadLabels leadId={lead.id} />
          </header>

          <Tabs
            ariaLabel="Lead sections"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'details', label: 'Details' },
              { id: 'notes', label: 'Notes' },
              { id: 'tasks', label: 'Tasks' },
              { id: 'activity', label: 'Activity' },
            ]}
          />

          {tab === 'details' && (
            <Details lead={lead} enrolments={enrolments} onSaved={(next) => { setLead(next); onChanged?.() }} onUnsubscribed={() => { load(); onChanged?.() }} />
          )}
          {tab === 'notes' && <NotesPanel leadId={lead.id} />}
          {tab === 'tasks' && <LeadTasks leadId={lead.id} enrolments={enrolments} />}
          {tab === 'activity' && <Activity leadId={lead.id} />}

          {finding && (
            <FindEmails
              leads={[lead]}
              onClose={() => setFinding(false)}
              onChanged={() => { load(); onChanged?.() }}
            />
          )}
        </div>
      )}
    </Drawer>
  )
}

// ---- details -----------------------------------------------------------------

function Details({ lead, enrolments, onSaved, onUnsubscribed }) {
  const toast = useToast()
  const [form, setForm] = useState(() => ({
    email: lead.email,
    ...Object.fromEntries(TEXT_FIELDS.map(([key]) => [key, lead[key] || ''])),
    notes: lead.notes || '',
  }))
  const [custom, setCustom] = useState(() => Object.entries(lead.customFields || {}).map(([k, v]) => ({ key: k, value: String(v) })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [live, setLive] = useState('')
  const [unsubscribing, setUnsubscribing] = useState(false)

  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setError(null) }

  const originalCustom = lead.customFields || {}

  const save = async (e) => {
    e.preventDefault()
    const body = {}
    if (form.email.trim().toLowerCase() !== String(lead.email).toLowerCase()) body.email = form.email.trim()
    for (const [key] of TEXT_FIELDS) {
      if (form[key] !== (lead[key] || '')) body[key] = form[key]
    }
    if (form.notes !== (lead.notes || '')) body.notes = form.notes

    // Custom fields merge server-side; an explicit null deletes a key, which is
    // how a removed row is expressed.
    const nextCustom = {}
    for (const row of custom) if (row.key.trim()) nextCustom[row.key.trim()] = row.value
    const patchCustom = {}
    for (const [key, value] of Object.entries(nextCustom)) {
      if (String(originalCustom[key] ?? '') !== String(value)) patchCustom[key] = value
    }
    for (const key of Object.keys(originalCustom)) if (!(key in nextCustom)) patchCustom[key] = null
    if (Object.keys(patchCustom).length) body.customFields = patchCustom

    if (!Object.keys(body).length) { setLive('Nothing to save — no field changed'); return }

    setBusy(true)
    setError(null)
    try {
      const res = await api.patch(`/api/leads/${lead.id}`, body)
      onSaved({ ...res.data, stage: lead.stage })
      const bits = [`${res.changedFields.length} field(s) updated`]
      if (res.draftsInvalidated) bits.push(`${res.draftsInvalidated} queued email(s) dropped because the details changed`)
      if (res.researchRefreshQueued) bits.push('the research profile was cleared and will be rebuilt')
      setLive(bits.join('; '))
      toast(bits.join('; '))
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <LiveRegion message={live} />

      <Panel title="Contact">
        <form onSubmit={save} className="space-y-3">
          <Field label="Email" htmlFor="lead-email" hint="Changing this revalidates the suppression list — a correction cannot walk someone around their own opt-out.">
            <input id="lead-email" type="email" className="input" value={form.email} onChange={set('email')} />
            <FieldError err={error} field="email" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            {TEXT_FIELDS.map(([key, label]) => (
              <Field key={key} label={label} htmlFor={`lead-${key}`}>
                <input id={`lead-${key}`} className="input" value={form[key]} onChange={set(key)} />
                <FieldError err={error} field={key} />
              </Field>
            ))}
          </div>
          <Field label="Notes for the agent" htmlFor="lead-notes" hint="This is the composer's input. To record what a human knows, use the Notes tab instead.">
            <textarea id="lead-notes" className="input min-h-16" value={form.notes} onChange={set('notes')} />
            <FieldError err={error} field="notes" />
          </Field>

          <CustomFields rows={custom} onChange={(rows) => { setCustom(rows); setError(null) }} error={error} />

          <FormError err={error} fields={['email', 'notes', 'customFields', ...TEXT_FIELDS.map(([k]) => k)]} />
          <div className="flex justify-end">
            <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          </div>
        </form>
      </Panel>

      <Panel title="Campaigns" hint="Every enrolment this person has, across the workspace.">
        {enrolments.length === 0 ? (
          <p className="text-sm text-slate-500">Not attached to a campaign yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {enrolments.map((e) => (
              <li key={e.enrolmentId} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/60 px-3 py-2 text-sm">
                <span className="text-ink-900">{e.campaignName}</span>
                <Badge value={e.state} />
                {e.outcome && <span className="text-xs text-slate-500">outcome: {e.outcome}</span>}
                {e.pausedAt && <span className="text-xs text-amber-700">paused {timeAgo(e.pausedAt)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Research profile"
        tone="agent"
        hint="Built by the research agent and used by the composer. This is the machine's view — a person's own context belongs in Notes."
      >
        {lead.researchedAt ? (
          <p className="text-xs text-slate-500">Last built {when(lead.researchedAt)}. Open it from the Profile action on the leads table.</p>
        ) : (
          <p className="text-sm text-slate-500">No profile yet.</p>
        )}
      </Panel>

      <Panel
        title="Unsubscribe everywhere"
        hint="Honouring a request must never be slower than ignoring it."
      >
        {lead.status === 'unsubscribed' ? (
          <p className="text-sm text-slate-600">
            Already unsubscribed{lead.unsubscribedAt ? ` on ${when(lead.unsubscribedAt)}` : ''}. There is no control anywhere
            in Harry that undoes this or that emails them anyway.
          </p>
        ) : (
          <button type="button" className="btn-danger" onClick={() => setUnsubscribing(true)}>Unsubscribe everywhere</button>
        )}
      </Panel>

      {unsubscribing && (
        <Confirm
          title={`Unsubscribe ${lead.email} everywhere?`}
          body={
            'This is permanent and it applies everywhere, not to one campaign. Every open enrolment is closed, every '
            + 'queued email for this person is dropped, and the address is added to this workspace’s suppression list — so '
            + 'deleting the lead or re-importing them tomorrow will not undo it. It cannot be reversed from this interface.'
          }
          confirmLabel="Unsubscribe permanently"
          danger
          onClose={() => setUnsubscribing(false)}
          onConfirm={async () => {
            try {
              const res = await api.post(`/api/leads/${lead.id}/unsubscribe`, { source: 'manual' })
              toast(res.changed
                ? `Unsubscribed everywhere — ${res.campaignsClosed} campaign(s) closed, ${res.draftsDropped} queued email(s) dropped`
                : 'That lead was already unsubscribed')
              setUnsubscribing(false)
              onUnsubscribed()
            } catch (err) { toast(err.message, 'error') }
          }}
        />
      )}
    </div>
  )
}

function CustomFields({ rows, onChange, error }) {
  const update = (index, patch) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  return (
    <fieldset>
      <legend className="mb-1 block text-xs text-slate-600">Custom fields</legend>
      {rows.length === 0 && <p className="mb-2 text-xs text-slate-500">None yet.</p>}
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-end gap-2">
            <div className="flex-1">
              <label className="sr-only" htmlFor={`cf-key-${index}`}>Custom field name {index + 1}</label>
              <input id={`cf-key-${index}`} className="input" placeholder="Name" value={row.key} onChange={(e) => update(index, { key: e.target.value })} />
            </div>
            <div className="flex-1">
              <label className="sr-only" htmlFor={`cf-value-${index}`}>Custom field value {index + 1}</label>
              <input id={`cf-value-${index}`} className="input" placeholder="Value" value={row.value} onChange={(e) => update(index, { value: e.target.value })} />
            </div>
            <button
              type="button"
              className="btn-ghost px-2 py-2"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              aria-label={`Remove custom field ${row.key || index + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        + Add a custom field
      </button>
      <FieldError err={error} field="customFields" />
    </fieldset>
  )
}

// ---- activity ----------------------------------------------------------------

const PAGE = 25

function Activity({ leadId }) {
  const [items, setItems] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    setItems(null)
    try {
      const res = await api.get(`/api/leads/${leadId}/activities${qs({ limit: PAGE })}`)
      setItems(res.data || [])
      setHasMore(Boolean(res.hasMore))
      setOffset(PAGE)
    } catch (err) { setError(err) }
  }, [leadId])

  useEffect(() => { load() }, [load])

  const more = async () => {
    setBusy(true)
    try {
      const res = await api.get(`/api/leads/${leadId}/activities${qs({ limit: PAGE, offset })}`)
      setItems((list) => [...(list || []), ...(res.data || [])])
      setHasMore(Boolean(res.hasMore))
      setOffset((o) => o + PAGE)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  if (error) return <ErrorState error={error} onRetry={load} />
  if (items === null) return <Spinner label="Loading activity…" />
  if (items.length === 0) return <EmptyState title="Nothing has happened yet" hint="Sends, opens, replies and every change made here land in this trail." />

  return (
    <Panel title="Activity" hint="A log of what happened, written by the engine, the mailer and every change made in Harry.">
      <ol className="space-y-2">
        {items.map((event) => (
          <li key={event.id} className="border-l border-slate-200 pl-3">
            <p className="text-sm text-ink-900">{String(event.type).replace(/_/g, ' ')}</p>
            {event.detail && <p className="text-xs text-slate-600">{event.detail}</p>}
            <p className="text-[11px] text-slate-500">
              {when(event.at)}{event.campaignName ? ` · ${event.campaignName}` : ''}
            </p>
          </li>
        ))}
      </ol>
      {hasMore && (
        <div className="flex justify-center pt-3">
          <button type="button" className="btn-ghost" onClick={more} disabled={busy}>{busy ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </Panel>
  )
}
