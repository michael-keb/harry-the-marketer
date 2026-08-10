// Follow-on campaigns.
//
// A subsequence is a real campaign with a parent, created explicitly — Harry
// never conjures a campaign from a name (Docs/README.md, "A campaign is never
// created implicitly"), so there is no "type a name and we'll make one"
// affordance anywhere here. Detaching unlinks; it never deletes, and the child
// survives as a standalone campaign.
//
// Triggers are picked from the parent playbook's own edge labels rather than
// typed free-hand, so a trigger cannot name something the diagram never emits.

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { Confirm } from '../parity-ui.jsx'
import { Modal, useToast } from '../ui.jsx'
import { Field, Panel, StateChip, errorFor, messageOf, nfmt, useOffsetList } from './shared.jsx'

const CORE_INTENTS = ['interested', 'not interested', 'not now', 'question', 'out of office']

// Everything the parent diagram can actually say about a lead.
function triggerVocabulary(steps) {
  const out = new Set()
  for (const intent of CORE_INTENTS) out.add(`reply: ${intent}`)
  for (const step of steps) {
    for (const intent of step.replyIntents || []) out.add(`reply: ${intent}`)
    for (const branch of step.branches || []) {
      const cond = branch.condition || {}
      if (cond.kind === 'reply' && cond.intent) out.add(`reply: ${cond.intent}`)
      else if (branch.label) out.add(String(branch.label).toLowerCase())
    }
  }
  return [...out].filter((t) => t && t.length <= 80).sort()
}

export default function SubsequencesPanel({ campaign, steps = [], onChanged }) {
  const toast = useToast()
  const list = useOffsetList(`/api/campaigns/${campaign.id}/children`, {}, { pick: 'children', limit: 25 })
  const [creating, setCreating] = useState(false)
  const [detaching, setDetaching] = useState(null)

  const detach = async (child) => {
    try {
      await api.del(`/api/campaigns/${campaign.id}/children/${child.id}`)
      toast(`${child.name} is no longer a follow-on of this campaign`)
      await list.reload()
      await onChanged?.()
    } catch (err) { toast(messageOf(err), 'error') } finally { setDetaching(null) }
  }

  return (
    <Panel
      id="subsequences"
      title="Follow-on campaigns"
      note="Separate campaigns that leads move into from this one. Each is a real campaign with its own playbook, senders and leads."
      actions={<button className="btn-ghost cursor-pointer py-1.5" onClick={() => setCreating(true)}>New follow-on campaign</button>}
    >
      {campaign.parent && (
        <p className="mb-3 text-sm text-slate-600">
          Leads arrive from{' '}
          <Link className="text-accent-700 hover:underline" to={`/app/campaigns/${campaign.parent.id}`}>{campaign.parent.name}</Link>.
        </p>
      )}

      {list.error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {messageOf(list.error)} <button className="cursor-pointer underline" onClick={list.reload}>Try again</button>
        </p>
      ) : list.loading && !list.items.length ? (
        <div className="space-y-2" aria-hidden>{[0, 1].map((i) => <div key={i} className="h-14 rounded-lg bg-slate-100 animate-pulse" />)}</div>
      ) : list.items.length === 0 ? (
        <p className="text-sm text-slate-500">
          No follow-on campaigns. Create one when a particular answer deserves a different conversation.
        </p>
      ) : (
        <ul className="space-y-2">
          {list.items.map((child) => (
            <li key={child.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link className="truncate text-sm text-ink-900 hover:text-accent-700" to={`/app/campaigns/${child.id}`}>
                    {child.name}
                  </Link>
                  <StateChip state={child.state} />
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {child.triggers?.length
                    ? child.triggers.map((t) => `When a lead ${t.startsWith('reply') ? `replies “${t.replace(/^reply:\s*/, '')}”` : `hits “${t}”`}`).join(' · ')
                    : 'No triggers set — nothing routes into it automatically yet'}
                  {' · '}{nfmt(child.leadCount)} lead{child.leadCount === 1 ? '' : 's'}
                </p>
                {child.state === 'DRAFT' && (
                  <p className="mt-0.5 text-[11px] text-amber-700">Still a draft — it cannot receive leads until it is started.</p>
                )}
              </div>
              <button
                className="shrink-0 cursor-pointer text-xs text-slate-600 hover:text-red-600"
                aria-label={`Detach ${child.name} from this campaign`}
                onClick={() => setDetaching(child)}
              >
                Detach
              </button>
            </li>
          ))}
        </ul>
      )}

      {list.hasMore && (
        <div className="flex justify-center py-3">
          <button className="btn-ghost cursor-pointer" disabled={list.loading} onClick={list.loadMore}>Load more</button>
        </div>
      )}

      {creating && (
        <CreateSubsequenceModal
          campaignId={campaign.id}
          steps={steps}
          onClose={() => setCreating(false)}
          onDone={async () => { setCreating(false); await list.reload(); await onChanged?.() }}
        />
      )}

      {detaching && (
        <Confirm
          title={`Detach “${detaching.name}”?`}
          confirmLabel="Detach"
          body={
            `“${detaching.name}” stops being a follow-on of this campaign and carries on as a standalone campaign. `
            + 'Nothing is deleted: its playbook, leads and history are untouched, and leads already in it stay where they are.'
          }
          onConfirm={() => detach(detaching)}
          onClose={() => setDetaching(null)}
        />
      )}
    </Panel>
  )
}

function CreateSubsequenceModal({ campaignId, steps, onClose, onDone }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [triggers, setTriggers] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const vocabulary = useMemo(() => triggerVocabulary(steps), [steps])

  const toggle = (value) => setTriggers((prev) => (prev.includes(value) ? prev.filter((t) => t !== value) : [...prev, value]))

  const create = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.post(`/api/campaigns/${campaignId}/children`, { name: name.trim(), triggers })
      toast('Follow-on campaign created as a draft')
      onDone()
    } catch (error) {
      setErr(error)
      setBusy(false)
    }
  }

  return (
    <Modal title="New follow-on campaign" onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="Name" htmlFor="sub-name" error={errorFor(err, 'name')}>
          <input id="sub-name" className="input" autoFocus placeholder="Nurture — Q2 revisit"
            value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <fieldset>
          <legend className="text-xs text-slate-600">What sends a lead here</legend>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Chosen from this campaign’s own playbook edges, so a trigger can only name something the diagram
            actually produces.
          </p>
          {errorFor(err, 'triggers') && <p className="mt-1 text-[11px] text-red-700" role="alert">{errorFor(err, 'triggers')}</p>}
          <div className="mt-2 max-h-52 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            {vocabulary.length === 0 ? (
              <p className="px-1 py-2 text-xs text-slate-500">
                This playbook has no reply edges yet, so there is nothing to trigger on. You can still create the
                campaign and add triggers once the diagram branches.
              </p>
            ) : vocabulary.map((t) => (
              <label key={t} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-slate-700 hover:bg-slate-100">
                <input type="checkbox" className="accent-accent-500" checked={triggers.includes(t)} onChange={() => toggle(t)} />
                {t.startsWith('reply:') ? `When a lead replies “${t.replace(/^reply:\s*/, '')}”` : `When a lead hits “${t}”`}
              </label>
            ))}
          </div>
        </fieldset>

        <p className="text-xs text-slate-500">
          It is created as a draft with an empty playbook. Nothing routes into it, and nothing sends from it, until
          you draw its diagram, attach senders and start it.
        </p>

        {err && !['name', 'triggers'].includes(err?.payload?.field) && (
          <p className="text-xs text-red-700" role="alert">{messageOf(err)}</p>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary cursor-pointer" disabled={busy || !name.trim()} onClick={create}>
            {busy ? 'Creating…' : 'Create follow-on campaign'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
