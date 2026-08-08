// Clients — agency client workspaces. Docs/clients/*.md.
//
// The backlog calls this one of only three surfaces Harry genuinely lacks, and
// it is worth being precise about why, because the page it lands on already has
// a Team section that looks superficially similar:
//
//   A team member SHARES this workspace. Invite one and they see every lead,
//   campaign, mailbox and reply you see — that is the point of them.
//   A client is a SCOPE INSIDE this workspace. Its campaigns, leads and
//   mailboxes are tagged as that brand's, so a brand's rows can be handed to
//   that brand without handing over the rest.
//
// That sentence is in the UI too (clients/create.md §7), not just this comment,
// because the two ideas are one click apart on the same page.
//
// A client is a section here, not a navigation item: the standing rule is that
// a new feature should not cost a new thing to think about, and 203 of the
// backlog's 210 endpoints keep it.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import {
  Confirm, Drawer, Modal, Spinner, EmptyState, ErrorState,
  LoadMore, LiveRegion, Stat, Tabs, TagChip, useToast,
} from '../parity-ui.jsx'
import { timeAgo } from '../ui.jsx'
import { Field, StatusPill, describedBy, errFor, usePaged, useFieldErrors } from './common.jsx'
import ClientApiKeys from './ClientApiKeys.jsx'

// Harry's real areas. The server accepts SmartLead's spellings too and maps
// them, so these labels never have to know about `email_accounts`.
const AREAS = [
  { value: 'campaigns', label: 'Campaigns' },
  { value: 'mailboxes', label: 'Mailboxes' },
  { value: 'leads', label: 'Leads' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'reports', label: 'Reports' },
]

const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.value, a.label]))

const STATUS_TABS = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
  { id: 'all', label: 'All' },
]

export default function ClientsSection() {
  const [status, setStatus] = useState('active')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [said, setSaid] = useState('')

  const params = useMemo(() => ({ status, limit: 25 }), [status])
  const list = usePaged('/api/clients', params)

  // The list route answers with four light fields by design (get-all.md), so
  // "what does this client actually scope?" is a second, cheap read per row.
  const [counts, setCounts] = useState({})
  useEffect(() => {
    const missing = list.items.filter((c) => counts[c.id] === undefined).map((c) => c.id)
    if (missing.length === 0) return undefined
    let cancelled = false
    Promise.all(missing.map((id) =>
      api.get(`/api/clients/${id}/scope`)
        .then((res) => [id, res?.data?.counts || null])
        .catch(() => [id, null]),
    )).then((pairs) => {
      if (cancelled) return
      setCounts((prev) => ({ ...prev, ...Object.fromEntries(pairs) }))
    })
    return () => { cancelled = true }
  }, [list.items, counts])

  const refresh = useCallback(() => {
    setCounts({})
    list.reload()
  }, [list])

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-ink-900">Clients</h2>
          <p className="mt-1 text-sm text-slate-600">
            For running Harry on behalf of several brands. A client is a separate scope inside this workspace:
            its campaigns, leads and mailboxes are tagged as that brand’s and can be handed over on their own.
          </p>
          <p className="mt-1.5 text-sm text-slate-600">
            <span className="text-slate-700">This is not the same as Team.</span>{' '}
            Team members <span className="text-slate-700">share</span> one workspace — invite someone and they see
            everything you see. A client is the opposite: a partition, so one brand’s contact can never read
            another’s inbox. Running one brand? You can ignore this section entirely; nothing changes.
          </p>
        </div>
        <button type="button" className="btn-ghost shrink-0" onClick={() => setCreating(true)}>
          New client
        </button>
      </div>

      <Tabs tabs={STATUS_TABS} active={status} onChange={setStatus} ariaLabel="Filter clients by status" />

      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.loading && list.items.length === 0 ? (
        <Spinner label="Loading clients…" />
      ) : list.items.length === 0 ? (
        <EmptyState
          icon="leads"
          title={status === 'archived' ? 'No archived clients' : 'No client workspaces yet'}
          hint={
            status === 'archived'
              ? 'Archived clients keep their rows and their history; they simply stop appearing in the active list.'
              : 'Create one when you start running outreach for a brand that should not see the rest of this workspace.'
          }
          action={status !== 'archived' && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>New client</button>
          )}
        />
      ) : (
        <ul className="divide-y divide-slate-200">
          {list.items.map((client) => (
            <li key={client.id} className="flex flex-wrap items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink-900">{client.name}</div>
                <div className="truncate text-xs text-slate-500">{client.email}</div>
                <div className="mt-1 text-xs text-slate-500">
                  <ScopeLine counts={counts[client.id]} />
                  {client.created_at && <> · added {timeAgo(client.created_at)}</>}
                </div>
              </div>
              <button
                type="button"
                className="btn-ghost shrink-0"
                onClick={() => setOpenId(client.id)}
                aria-label={`Manage ${client.name}`}
              >
                Manage
              </button>
            </li>
          ))}
        </ul>
      )}

      <LoadMore hasMore={list.hasMore} loading={list.loading} onClick={list.loadMore} />
      <LiveRegion message={said} />

      {creating && (
        <ClientDialog
          onClose={() => setCreating(false)}
          onSaved={(client) => {
            setCreating(false)
            setSaid(`Client ${client.name} created.`)
            refresh()
          }}
        />
      )}

      {openId != null && (
        <ClientDrawer
          clientId={openId}
          onClose={() => setOpenId(null)}
          onChanged={(message) => { if (message) setSaid(message); refresh() }}
          onGone={() => { setOpenId(null); refresh() }}
        />
      )}
    </section>
  )
}

function ScopeLine({ counts }) {
  if (counts === undefined) return <span>counting what this scopes…</span>
  if (counts === null) return <span>scope unavailable</span>
  const n = counts.campaigns + counts.leads + counts.mailboxes
  if (n === 0) return <span>nothing attached yet</span>
  return (
    <span>
      {counts.campaigns} campaign{counts.campaigns === 1 ? '' : 's'} ·{' '}
      {counts.leads} lead{counts.leads === 1 ? '' : 's'} ·{' '}
      {counts.mailboxes} mailbox{counts.mailboxes === 1 ? '' : 'es'}
    </span>
  )
}

// ---- the shared form --------------------------------------------------------

function emptyDraft() {
  return {
    name: '', email: '', permissions: [], logo_url: '', color: '',
    is_credit_assigned: false, email_credits: '', lead_credits: '',
  }
}

function draftFromClient(client) {
  return {
    name: client.name || '',
    email: client.email || '',
    permissions: client.permissions || [],
    logo_url: client.logo_url || '',
    color: client.color || '',
    is_credit_assigned: Boolean(client.credits?.assigned),
    email_credits: client.credits?.assigned ? String(client.credits.email_credits ?? '') : '',
    lead_credits: client.credits?.assigned ? String(client.credits.lead_credits ?? '') : '',
  }
}

function payloadFrom(draft) {
  return {
    name: draft.name.trim(),
    email: draft.email.trim(),
    permission: draft.permissions,
    logo_url: draft.logo_url.trim(),
    color: draft.color.trim(),
    is_credit_assigned: draft.is_credit_assigned,
    email_credits: draft.is_credit_assigned ? Number(draft.email_credits || 0) : 0,
    lead_credits: draft.is_credit_assigned ? Number(draft.lead_credits || 0) : 0,
  }
}

function ClientFields({ idPrefix, draft, setDraft, errors }) {
  const set = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }))
  const nameError = errFor(errors, 'name')
  const emailError = errFor(errors, 'email')
  const permError = errFor(errors, 'permission', 'permissions')
  const logoError = errFor(errors, 'logo_url', 'logo', 'logo_mime')
  const colorError = errFor(errors, 'color')
  const emailCreditError = errFor(errors, 'email_credits')
  const leadCreditError = errFor(errors, 'lead_credits')

  const toggleArea = (value) => setDraft((d) => ({
    ...d,
    permissions: d.permissions.includes(value)
      ? d.permissions.filter((p) => p !== value)
      : [...d.permissions, value],
  }))

  return (
    <div className="space-y-4">
      <Field id={`${idPrefix}-name`} label="Client name" error={nameError}>
        <input
          id={`${idPrefix}-name`} className="input" required maxLength={120}
          value={draft.name} onChange={set('name')}
          {...describedBy(`${idPrefix}-name`, { error: nameError })}
        />
      </Field>

      <Field
        id={`${idPrefix}-email`}
        label="Contact email"
        hint="Their own address. There is no password field here and never will be — a client’s people sign in through Auth0 with their own identity, exactly as team members do."
        error={emailError}
      >
        <input
          id={`${idPrefix}-email`} className="input" type="email" required
          value={draft.email} onChange={set('email')}
          {...describedBy(`${idPrefix}-email`, { hint: true, error: emailError })}
        />
      </Field>

      <fieldset>
        <legend className="text-sm text-slate-700">What may this client see?</legend>
        <p className="mt-0.5 text-xs text-slate-500">
          Areas left unticked are absent for them, not present and blocked.
        </p>
        <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {AREAS.map((area) => (
            <label key={area.value} className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-700">
              <input
                type="checkbox"
                className="cursor-pointer accent-accent-500"
                checked={draft.permissions.includes(area.value)}
                onChange={() => toggleArea(area.value)}
              />
              {area.label}
            </label>
          ))}
        </div>
        {permError && <p className="mt-1 text-xs text-red-700">{permError}</p>}
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id={`${idPrefix}-logo`} label="Logo URL" hint="Optional. https:// or a data:image URL." error={logoError}>
          <input
            id={`${idPrefix}-logo`} className="input" type="url" placeholder="https://acme.com/logo.png"
            value={draft.logo_url} onChange={set('logo_url')}
            {...describedBy(`${idPrefix}-logo`, { hint: true, error: logoError })}
          />
        </Field>
        <Field id={`${idPrefix}-color`} label="Brand colour" hint="Optional. A hex value such as #7c3aed." error={colorError}>
          <input
            id={`${idPrefix}-color`} className="input" placeholder="#7c3aed" maxLength={9}
            value={draft.color} onChange={set('color')}
            {...describedBy(`${idPrefix}-color`, { hint: true, error: colorError })}
          />
        </Field>
      </div>

      <fieldset>
        <legend className="text-sm text-slate-700">Allowance</legend>
        <label className="mt-2 flex cursor-pointer items-start gap-2.5 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5 cursor-pointer accent-accent-500"
            checked={draft.is_credit_assigned}
            onChange={(e) => setDraft((d) => ({ ...d, is_credit_assigned: e.target.checked }))}
          />
          <span>
            Give this client its own allowance
            <span className="block text-xs text-slate-500">
              Left off, the client draws on the agency pool. Numbers typed below are ignored until this is ticked.
            </span>
          </span>
        </label>
        {draft.is_credit_assigned && (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id={`${idPrefix}-email-credits`} label="Emails" error={emailCreditError}>
              <input
                id={`${idPrefix}-email-credits`} className="input" type="number" min="0" inputMode="numeric"
                value={draft.email_credits} onChange={set('email_credits')}
                {...describedBy(`${idPrefix}-email-credits`, { error: emailCreditError })}
              />
            </Field>
            <Field id={`${idPrefix}-lead-credits`} label="Leads" error={leadCreditError}>
              <input
                id={`${idPrefix}-lead-credits`} className="input" type="number" min="0" inputMode="numeric"
                value={draft.lead_credits} onChange={set('lead_credits')}
                {...describedBy(`${idPrefix}-lead-credits`, { error: leadCreditError })}
              />
            </Field>
          </div>
        )}
      </fieldset>
    </div>
  )
}

// ---- create -----------------------------------------------------------------

function ClientDialog({ onClose, onSaved }) {
  const toast = useToast()
  const { errors, capture, clear } = useFieldErrors()
  const [draft, setDraft] = useState(emptyDraft)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    clear()
    try {
      const res = await api.post('/api/clients', payloadFrom(draft))
      onSaved(res.data)
    } catch (err) {
      // A duplicate name comes back as a 409 carrying `field: name`; it belongs
      // on the input, not in a toast that vanishes mid-read.
      if (!capture(err)) toast(err.message, 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title="New client" onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        <ClientFields idPrefix="new-client" draft={draft} setDraft={setDraft} errors={errors} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !draft.name.trim() || !draft.email.trim()}>
            {busy ? 'Creating…' : 'Create client'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ---- detail -----------------------------------------------------------------

function ClientDrawer({ clientId, onClose, onChanged, onGone }) {
  const toast = useToast()
  const { errors, capture, clear } = useFieldErrors()
  const [client, setClient] = useState(null)
  const [scope, setScope] = useState(null)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState(emptyDraft)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get(`/api/clients/${clientId}`)
      setClient(res.data)
      setDraft(draftFromClient(res.data))
    } catch (err) {
      setError(err)
      return
    }
    try {
      const res = await api.get(`/api/clients/${clientId}/scope`)
      setScope(res.data.counts)
    } catch { /* the counts are context, not the point of the panel */ }
  }, [clientId])

  useEffect(() => { load() }, [load])

  const save = async () => {
    setBusy(true)
    clear()
    try {
      const res = await api.patch(`/api/clients/${clientId}`, payloadFrom(draft))
      setClient(res.data)
      setDraft(draftFromClient(res.data))
      toast(res.changed === false ? 'Nothing to save — this is already what is stored' : 'Client saved')
      if (res.overAllowance) {
        toast(res.overAllowance.reason, 'error')
      }
      onChanged(res.changed === false ? '' : `Client ${res.data.name} saved.`)
    } catch (err) {
      if (!capture(err)) toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (status) => {
    setBusy(true)
    try {
      const res = await api.patch(`/api/clients/${clientId}`, { status })
      setClient(res.data)
      setDraft(draftFromClient(res.data))
      toast(status === 'archived' ? 'Client archived' : 'Client restored')
      onChanged(`Client ${res.data.name} ${status === 'archived' ? 'archived' : 'restored'}.`)
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      const res = await api.del(`/api/clients/${clientId}`)
      const r = res.released || {}
      toast(`Client removed — ${r.campaigns ?? 0} campaign(s), ${r.leads ?? 0} lead(s) and ${r.mailboxes ?? 0} mailbox(es) returned to this workspace`)
      onGone()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
      setConfirming(null)
    }
  }

  return (
    <Drawer title={client ? client.name : 'Client'} onClose={onClose}>
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !client ? (
        <Spinner label="Loading client…" />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={client.status === 'active' ? 'good' : 'neutral'}>
              {client.status === 'active' ? 'Active' : 'Archived'}
            </StatusPill>
            {(client.permissions || []).length === 0 ? (
              <span className="text-xs text-slate-500">No areas granted yet</span>
            ) : (
              client.permissions.map((p) => (
                <TagChip key={p} tag={{ name: AREA_LABEL[p] || p, color: client.color || '#0f9d6e' }} />
              ))
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-ink-900">What this client scopes</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Attach campaigns, leads and mailboxes to a client from their own pages. Anything not attached belongs
              to the agency itself.
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Stat label="Campaigns" value={scope ? scope.campaigns : '—'} />
              <Stat label="Leads" value={scope ? scope.leads : '—'} />
              <Stat label="Mailboxes" value={scope ? scope.mailboxes : '—'} />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Allowance:{' '}
              {client.credits?.assigned
                ? `${client.credits.email_credits.toLocaleString()} emails and ${client.credits.lead_credits.toLocaleString()} leads of its own`
                : 'draws on the agency pool'}
            </p>
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h3 className="mb-3 text-sm font-semibold text-ink-900">Details</h3>
            <ClientFields idPrefix={`client-${clientId}`} draft={draft} setDraft={setDraft} errors={errors} />
            <div className="mt-4 flex justify-end">
              <button type="button" className="btn-primary" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-5">
            <ClientApiKeys client={client} />
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h3 className="text-sm font-semibold text-ink-900">Ending the relationship</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {client.status === 'active' ? (
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirming('archive')}>
                  Archive client
                </button>
              ) : (
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => setStatus('active')}>
                  Restore client
                </button>
              )}
              <button type="button" className="btn-danger" disabled={busy} onClick={() => setConfirming('remove')}>
                Remove client
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Archiving hides the client and keeps everything. Removing also releases its campaigns, leads and
              mailboxes back to this workspace and revokes its API keys — a year of outreach is never deleted with
              a brand.
            </p>
          </div>
        </div>
      )}

      {confirming === 'archive' && (
        <Confirm
          title={`Archive “${client.name}”?`}
          body="The client stops appearing in the active list. Its scoped campaigns, leads and mailboxes stay attached and keep working, and you can restore it at any time."
          confirmLabel="Archive client"
          onConfirm={() => setStatus('archived')}
          onClose={() => setConfirming(null)}
        />
      )}

      {confirming === 'remove' && (
        <Confirm
          title={`Remove “${client.name}”?`}
          body={`This cannot be undone. Every API key for this client is revoked immediately, and its ${scope ? `${scope.campaigns} campaign(s), ${scope.leads} lead(s) and ${scope.mailboxes} mailbox(es)` : 'campaigns, leads and mailboxes'} return to the agency’s own scope — they are released, not deleted.`}
          confirmLabel="Remove client"
          danger
          onConfirm={remove}
          onClose={() => setConfirming(null)}
        />
      )}
    </Drawer>
  )
}
