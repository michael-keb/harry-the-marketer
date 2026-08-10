// Duplicate, archive, restore, delete — and the campaign's activity trail.
//
// Each of these says exactly what it does, because each is easy to get wrong:
//
//   Duplicate copies the playbook, settings, schedule and mailboxes, and NOT the
//   leads, messages or statistics. The copy starts as a draft, so it cannot
//   contact the original's audience — it has no audience.
//
//   Archive is reversible. Delete is not, and the backend 409s while the
//   campaign is running, so that answer is rendered as an action ("Stop the
//   campaign first") rather than as a raw error string. The delete dialog lists
//   the live counts of what is destroyed and asks for the campaign's name.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { Confirm } from '../parity-ui.jsx'
import { Modal, useToast, timeAgo } from '../ui.jsx'
import { Field, Panel, codeOf, errorFor, messageOf, nfmt, useOffsetList } from './shared.jsx'

export default function ManagePanel({ campaign, onChanged, onDuplicateRequest, duplicateOpen, onCloseDuplicate }) {
  const toast = useToast()
  const navigate = useNavigate()
  const [archiving, setArchiving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)

  const archived = campaign.state === 'ARCHIVED' || campaign.state === 'STOPPED'
  const stopped = campaign.state === 'STOPPED'
  const counts = campaign.counts || {}
  const totals = campaign.totals || {}

  const setArchived = async (next) => {
    setBusy(true)
    try {
      await api.patch(`/api/campaigns/${campaign.id}`, { status: next ? 'archived' : 'draft' })
      toast(next ? 'Campaign archived' : 'Campaign restored as a draft')
      await onChanged?.()
    } catch (err) { toast(messageOf(err), 'error') } finally { setBusy(false); setArchiving(false) }
  }

  return (
    <>
      <Panel
        id="manage"
        title="Manage this campaign"
        note="Duplicating is safe. Archiving is reversible. Deleting is not."
      >
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost cursor-pointer" onClick={onDuplicateRequest} disabled={busy}>Duplicate</button>
          {archived ? (
            <button className="btn-ghost cursor-pointer" disabled={busy || stopped} onClick={() => setArchived(false)}>
              Restore
            </button>
          ) : (
            <button className="btn-ghost cursor-pointer" disabled={busy} onClick={() => setArchiving(true)}>Archive</button>
          )}
          <button className="btn-danger cursor-pointer" disabled={busy} onClick={() => setDeleting(true)}>Delete permanently</button>
        </div>
        {stopped && (
          <p className="mt-2 text-xs text-slate-600">
            A stopped campaign cannot be restored. Duplicate it to run the same playbook again.
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Owner: {campaign.ownerEmail || 'unassigned'}
          {campaign.ownerEmail && (
            <button
              className="ml-2 cursor-pointer underline hover:text-slate-700"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await api.put(`/api/campaigns/${campaign.id}/owner`, { user_id: null })
                  toast('Owner cleared')
                  await onChanged?.()
                } catch (err) { toast(messageOf(err), 'error') } finally { setBusy(false) }
              }}
            >
              Unassign
            </button>
          )}
          {' '}— assignment is a label, not a permission: everyone in the workspace can still act on this campaign.
        </p>
      </Panel>

      {archiving && (
        <Confirm
          title="Archive this campaign?"
          confirmLabel="Archive"
          body={
            'It stops appearing in the list unless you ask for archived campaigns, and it stops running. '
            + 'Leads, messages and statistics are all kept, and you can restore it at any time.'
          }
          onConfirm={() => setArchived(true)}
          onClose={() => setArchiving(false)}
        />
      )}

      {deleting && (
        <DeleteCampaignModal
          campaign={campaign}
          counts={counts}
          totals={totals}
          onClose={() => setDeleting(false)}
          onDeleted={() => { toast('Campaign deleted'); navigate('/app/campaigns') }}
        />
      )}

      {duplicateOpen && (
        <DuplicateModal
          campaign={campaign}
          onClose={onCloseDuplicate}
          onDone={(id) => { onCloseDuplicate?.(); navigate(`/app/campaigns/${id}`) }}
        />
      )}
    </>
  )
}

// ------------------------------------------------------------- duplicate ----

function DuplicateModal({ campaign, onClose, onDone }) {
  const toast = useToast()
  const [name, setName] = useState(`${campaign.name} (copy)`)
  const [includeChildren, setIncludeChildren] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await api.post(`/api/campaigns/${campaign.id}/duplicate`, { name: name.trim(), includeChildren })
      toast('Campaign duplicated — the copy is a draft with no leads')
      onDone(res.id)
    } catch (error) {
      setErr(error)
      setBusy(false)
    }
  }

  return (
    <Modal title="Duplicate this campaign" onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="Name of the copy" htmlFor="dup-name" error={errorFor(err, 'name')}>
          <input id="dup-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-xs font-medium text-emerald-700">Copied</h3>
            <ul className="mt-1.5 space-y-1 text-xs text-slate-600">
              <li>The playbook diagram</li>
              <li>Any copy you approved for its steps</li>
              <li>Behaviour settings</li>
              <li>The sending window</li>
              <li>The attached mailboxes and SMS senders</li>
              <li>Campaign type (Email / SMS / Email + SMS)</li>
            </ul>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-xs font-medium text-amber-700">Not copied</h3>
            <ul className="mt-1.5 space-y-1 text-xs text-slate-600">
              <li>Leads — the copy starts with none</li>
              <li>Messages and threads</li>
              <li>Statistics and reports</li>
              <li>Drafts waiting for your OK</li>
            </ul>
          </div>
        </div>

        <p className="text-xs text-slate-500">
          The copy starts as a draft, so it cannot contact anyone the original wrote to — it has no audience until
          you attach leads yourself.
        </p>

        <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-0.5 accent-accent-500" checked={includeChildren}
            onChange={(e) => setIncludeChildren(e.target.checked)} />
          <span>
            Also duplicate its follow-on campaigns
            <span className="mt-0.5 block text-[11px] text-slate-500">
              A follow-on campaign is a separate campaign leads move into from this one. Their copies are drafts
              with no leads either.
            </span>
          </span>
        </label>

        {err && !errorFor(err, 'name') && <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>}

        <div className="flex justify-end gap-2">
          <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary cursor-pointer" disabled={busy || !name.trim()} onClick={run}>
            {busy ? 'Duplicating…' : 'Duplicate'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- delete ----

function DeleteCampaignModal({ campaign, counts, totals, onClose, onDeleted }) {
  const toast = useToast()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [stopping, setStopping] = useState(false)

  const active = codeOf(err) === 'CAMPAIGN_ACTIVE'

  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.del(`/api/campaigns/${campaign.id}/permanent`)
      onDeleted()
    } catch (error) {
      setErr(error)
      setBusy(false)
    }
  }

  const stopFirst = async () => {
    setStopping(true)
    try {
      await api.put(`/api/campaigns/${campaign.id}/status`, { status: 'PAUSED' })
      toast('Campaign paused — you can delete it now')
      setErr(null)
    } catch (error) { toast(messageOf(error), 'error') } finally { setStopping(false) }
  }

  return (
    <Modal title="Delete this campaign permanently" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-700">
          This destroys the campaign and everything attached to it. It cannot be undone, and there is no copy kept.
        </p>
        <ul className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <li>{nfmt(counts.total)} lead link{counts.total === 1 ? '' : 's'} — the people stay in your workspace, their place in this campaign does not</li>
          <li>{nfmt(totals.sent)} email{totals.sent === 1 ? '' : 's'} sent and {nfmt(totals.replied)} repl{totals.replied === 1 ? 'y' : 'ies'} received</li>
          <li>Every email of theirs still waiting for your OK</li>
          <li>The playbook, its approved copy, and every statistic</li>
        </ul>
        <p className="text-xs text-slate-500">
          Archiving keeps all of it and hides the campaign instead. If you only want the data, export the leads
          before deleting.
        </p>

        {active ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5" role="alert">
            <p className="text-xs text-amber-800">This campaign is running. Stop the campaign first.</p>
            <button className="btn-ghost mt-2 cursor-pointer py-1.5" disabled={stopping} onClick={stopFirst}>
              {stopping ? 'Pausing…' : 'Pause it now'}
            </button>
          </div>
        ) : err ? (
          <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>
        ) : null}

        <Field label={`Type “${campaign.name}” to confirm`} htmlFor="del-name">
          <input id="del-name" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy} autoFocus>Cancel</button>
          <button
            className="btn-danger cursor-pointer"
            disabled={busy || typed.trim() !== campaign.name}
            aria-label={`Permanently delete the campaign ${campaign.name}. This cannot be undone.`}
            onClick={run}
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// -------------------------------------------------------------- activity ----

export function ActivityPanel({ campaignId }) {
  const [type, setType] = useState('')
  const list = useOffsetList('/api/activity', { campaignId, type: type || undefined }, { pick: 'activities', limit: 50 })

  const types = [...new Set(list.items.map((a) => a.type))].sort()

  return (
    <Panel
      id="activity"
      title="Activity"
      note="Everything this campaign has done, newest first."
      actions={
        <label className="text-xs text-slate-600">
          <span className="sr-only">Filter by activity type</span>
          <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value)} aria-label="Activity type">
            <option value="">Every kind of activity</option>
            {types.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
      }
    >
      {list.error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {messageOf(list.error)} <button className="cursor-pointer underline" onClick={list.reload}>Try again</button>
        </p>
      ) : list.loading && !list.items.length ? (
        <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-8 rounded bg-slate-100 animate-pulse" />)}</div>
      ) : list.items.length === 0 ? (
        <p className="text-sm text-slate-500">
          {type ? `No “${type.replace(/_/g, ' ')}” activity on this campaign.` : 'Nothing has happened on this campaign yet.'}
        </p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {list.items.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-2 text-sm text-slate-600">
                <span className="text-slate-700">{a.type.replace(/_/g, ' ')}</span>
                <span className="min-w-0 flex-1 truncate" title={a.detail}>{a.detail}</span>
                <span className="text-xs text-slate-500" title={a.createdAt}>{timeAgo(a.createdAt)}</span>
              </li>
            ))}
          </ul>
          {list.hasMore && (
            <div className="flex justify-center py-3">
              <button className="btn-ghost cursor-pointer" disabled={list.loading} onClick={list.loadMore}>
                {list.loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
