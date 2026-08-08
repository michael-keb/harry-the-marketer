// Triage on the lead-in-campaign pairing: who owns it, what the reply meant,
// what it is worth, restarting a paused lead, and moving it to a subsequence.
//
// Every control here writes to `campaign_leads` through the parity routes, so
// the same change made from Leads or from a campaign lands in the same place.
// None of them sends anything.

import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Modal } from '../ui.jsx'
import { Banner, FieldError, Menu, absolute } from './common.jsx'

// ---------------------------------------------------------------- assignee --

export function AssigneeControl({ campaignLeadId, value, refs, onChanged }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(value || '')

  useEffect(() => { setShown(value || '') }, [value])

  // In a solo workspace there is nobody to assign to, so the control is not
  // shown at all — an empty picker is worse than no picker.
  if (refs.solo) {
    return (
      <p className="text-[11px] text-slate-500">
        Invite a teammate in Settings → Team to hand conversations to someone.
      </p>
    )
  }

  const change = async (next) => {
    const previous = shown
    setShown(next)          // optimistic
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/api/campaign-leads/${campaignLeadId}/assignee`, { assignee: next || 'none' })
      onChanged?.(next)
    } catch (err) {
      setShown(previous)    // reverted, and said out loud
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <label className="block text-xs text-slate-600" htmlFor={`assignee-${campaignLeadId}`}>Owner</label>
      <select
        id={`assignee-${campaignLeadId}`}
        className="input mt-1"
        value={shown}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">Unassigned</option>
        {refs.members.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <p className="mt-1 text-[11px] text-slate-500">
        Assignment marks who is responsible. It does not restrict who can approve — any member of the workspace still can.
      </p>
      <Banner error={error} />
    </div>
  )
}

// ---------------------------------------------------------------- category --

const BUILTIN_INTENTS = ['interested', 'not interested', 'unsubscribe', 'out of office', 'referral', 'question']

export function CategoryControl({ campaignLeadId, intent, categoryId, refs, onChanged }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(intent || '')
  const [category, setCategory] = useState(categoryId || '')

  useEffect(() => { setShown(intent || ''); setCategory(categoryId || '') }, [intent, categoryId])

  const options = [...new Set([...(refs.intents || []), ...BUILTIN_INTENTS])]

  const apply = async (nextIntent, nextCategory) => {
    const before = { intent: shown, category }
    setShown(nextIntent)
    setCategory(nextCategory)
    setBusy(true)
    setError(null)
    try {
      const result = await api.patch(`/api/campaign-leads/${campaignLeadId}/intent`, {
        intent: nextIntent === '' ? null : nextIntent,
        categoryId: nextCategory === '' ? null : Number(nextCategory),
      })
      onChanged?.(result)
    } catch (err) {
      setShown(before.intent)
      setCategory(before.category)
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <label className="block text-xs text-slate-600" htmlFor={`intent-${campaignLeadId}`}>What the reply meant</label>
      <select
        id={`intent-${campaignLeadId}`}
        className="input mt-1"
        value={shown}
        disabled={busy}
        aria-describedby={`intent-help-${campaignLeadId}`}
        onChange={(e) => apply(e.target.value, category)}
      >
        <option value="">Clear — no intent set</option>
        {options.map((i) => <option key={i} value={i}>{i}</option>)}
      </select>
      <p id={`intent-help-${campaignLeadId}`} className="mt-1 text-[11px] text-slate-500">
        Changing this reroutes the lead down the matching branch of this campaign's playbook. Any draft written under
        the old branch is withdrawn from Needs your OK, so it cannot go out saying the wrong thing.
      </p>

      {refs.categories.length > 0 && (
        <label className="mt-2 block text-xs text-slate-600">
          Reply category
          <select className="input mt-1" value={category} disabled={busy} onChange={(e) => apply(shown, e.target.value)}>
            <option value="">None</option>
            {refs.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <FieldError error={error} field="intent" />
      <FieldError error={error} field="categoryId" />
      <Banner error={error} handled={['intent', 'categoryId']} />
    </div>
  )
}

// ---------------------------------------------------------------- revenue ---

export function RevenueField({ campaignLeadId, revenue, onChanged }) {
  const currency = revenue?.currency || 'USD'
  const recorded = revenue && revenue.amount_minor > 0
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(recorded ? String(revenue.amount) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => { setValue(revenue && revenue.amount_minor > 0 ? String(revenue.amount) : '') }, [revenue])

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.patch(`/api/campaign-leads/${campaignLeadId}/revenue`, {
        amount: value.trim() === '' ? null : Number(value),
        currency,
      })
      setEditing(false)
      onChanged?.(result)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="text-xs text-slate-600">Revenue</div>
      {editing ? (
        <form onSubmit={save} className="mt-1 flex flex-wrap items-start gap-2">
          <label className="sr-only" htmlFor={`revenue-${campaignLeadId}`}>{`Revenue in ${currency}`}</label>
          <input
            id={`revenue-${campaignLeadId}`}
            className="input !w-32"
            type="number" min="0" step="0.01" inputMode="decimal"
            value={value}
            aria-label={`Revenue in ${currency}`}
            placeholder="Not recorded"
            autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit" className="btn-primary !py-1.5" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn-ghost !py-1.5" disabled={busy} onClick={() => { setEditing(false); setError(null) }}>Cancel</button>
          <FieldError error={error} field="amount" />
          <Banner error={error} handled={['amount']} />
        </form>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          {/* "Not recorded" is not zero, and neither is presented as won. */}
          <span className={recorded ? 'text-ink-950' : 'text-slate-500'}>
            {recorded ? `${currency} ${revenue.amount}` : 'Not recorded'}
          </span>
          <button type="button" className="text-xs text-slate-600 underline cursor-pointer hover:text-ink-900" onClick={() => setEditing(true)}>
            {recorded ? 'Change' : 'Record revenue'}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- resume ----

export function ResumeControl({ campaignLead, onChanged }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!campaignLead?.paused_at) return null

  const resume = async (delayDays) => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.patch(`/api/campaign-leads/${campaignLead.id}/resume`, { delayDays })
      onChanged?.(result)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const stated = (days) => {
    const at = new Date(Date.now() + days * 864e5)
    return `Picks up again ${absolute(at.toISOString())}`
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <div className="text-sm text-amber-800">This lead is paused</div>
      <p className="mt-0.5 text-[11px] text-amber-700">
        Paused since {absolute(campaignLead.paused_at)}.
        {campaignLead.resume_at ? ` A delayed restart is already set for ${absolute(campaignLead.resume_at)}.` : ' The campaign will not email them until it is resumed.'}
      </p>
      <div className="mt-2">
        <Menu
          label={busy ? 'Resuming…' : 'Resume'}
          ariaLabel="Resume this lead"
          disabled={busy}
          buttonClass="btn-ghost !py-1.5 text-xs"
          items={[
            { key: 'now', label: 'Resume now', hint: 'The campaign picks them up on the next tick', onSelect: () => resume(0) },
            { key: '7', label: 'Resume in 7 days', hint: stated(7), onSelect: () => resume(7) },
            { key: '30', label: 'Resume in 30 days', hint: stated(30), onSelect: () => resume(30) },
          ]}
        />
      </div>
      <Banner error={error} />
    </div>
  )
}

// ------------------------------------------------------------ subsequence ---

// Only campaigns that already exist and are already children of this one. A
// campaign is never created from here — a campaign conjured out of a text box
// would be one without a playbook or a mailbox, which is to say a broken one.
export function SubsequenceDialog({ thread, onClose, onDone }) {
  const [children, setChildren] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [target, setTarget] = useState('')
  const [delay, setDelay] = useState('0')
  const [stopOnSourceReply, setStopOnSourceReply] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const campaignId = thread.campaign?.id

  useEffect(() => {
    if (!campaignId) { setChildren([]); return }
    api.get(`/api/campaigns/${campaignId}/children?limit=200`)
      .then((r) => setChildren(r.children || []))
      .catch(setLoadError)
  }, [campaignId])

  const chosen = (children || []).find((c) => String(c.id) === String(target))
  const seconds = Number(delay)
  const startsAt = seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : ''

  const move = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.post(`/api/inbox/threads/${thread.id}/push-to-subsequence`, {
        subsequenceId: Number(target),
        startAfterSeconds: seconds,
        stopOnSourceReply,
      })
      onDone(result, chosen)
    } catch (err) {
      setError(err)
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  const reasonFor = (child) => {
    if (!child.mailboxId) return 'No mailbox attached to that campaign'
    if (child.status === 'archived') return 'That campaign is archived'
    return ''
  }

  return (
    <Modal title="Move to another playbook" onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600">
          Reclassifying a reply changes which edge the lead follows <em>inside</em> this playbook. Moving them sends them
          into a different playbook entirely.
        </p>

        {loadError && <Banner error={loadError} />}
        {children === null && !loadError && <p className="text-slate-600">Loading subsequences…</p>}

        {children?.length === 0 && (
          <div className="rounded-lg border border-slate-200 p-3 text-slate-600">
            This campaign has no subsequences yet. Create one under the campaign in Campaigns first — a subsequence
            cannot be conjured from here, because it would arrive without a playbook or a mailbox.
          </div>
        )}

        {children && children.length > 0 && !confirming && (
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); setConfirming(true) }}
          >
            <div>
              <label className="block text-xs text-slate-600" htmlFor="subseq-target">Subsequence</label>
              <select id="subseq-target" className="input mt-1" value={target} required onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose a subsequence…</option>
                {children.map((child) => {
                  const reason = reasonFor(child)
                  return (
                    <option key={child.id} value={child.id} disabled={!!reason}>
                      {child.name}{reason ? ` — ${reason}` : ''}
                    </option>
                  )
                })}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">
                Only subsequences of “{thread.campaign?.name}” appear here. Ones that cannot take a lead say why.
              </p>
              <FieldError error={error} field="subsequenceId" />
            </div>

            <div>
              <label className="block text-xs text-slate-600" htmlFor="subseq-delay">When it starts</label>
              <select id="subseq-delay" className="input mt-1" value={delay} onChange={(e) => setDelay(e.target.value)}>
                <option value="0">Start immediately</option>
                <option value="86400">In 1 day</option>
                <option value="259200">In 3 days</option>
                <option value="604800">In 7 days</option>
              </select>
              <p className="mt-1 text-[11px] text-slate-500" aria-live="polite">
                {startsAt ? `The first email would be composed around ${absolute(startsAt)}.` : 'The first email would be composed on the next engine tick.'}
              </p>
            </div>

            <label className="flex items-start gap-2 text-xs text-slate-700">
              <input type="checkbox" className="mt-0.5 accent-accent-500" checked={stopOnSourceReply} onChange={(e) => setStopOnSourceReply(e.target.checked)} />
              <span>
                Stop if they reply to the current campaign
                <span className="mt-0.5 block text-[11px] text-slate-500">
                  A reply on the old thread halts the subsequence rather than talking over it.
                </span>
              </span>
            </label>

            <Banner error={error} handled={['subsequenceId']} />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={!target}>Continue…</button>
            </div>
          </form>
        )}

        {confirming && chosen && (
          <div className="space-y-3">
            <ul className="space-y-1 rounded-lg border border-slate-200 bg-white p-3 text-[13px] text-slate-700">
              <li><span className="text-slate-500">Leaves</span> {thread.campaign?.name}</li>
              <li><span className="text-slate-500">Joins</span> {chosen.name}</li>
              <li><span className="text-slate-500">First email composed</span> {startsAt ? absolute(startsAt) : 'on the next engine tick'}</li>
            </ul>
            <p className="text-slate-600">
              The first email of the new playbook still parks in <span className="text-ink-900">Needs your OK</span>. Moving a
              lead is a routing change, never a way around approval. The old pairing is closed rather than deleted, so the
              campaign's own numbers stay honest.
            </p>
            <Banner error={error} />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Back</button>
              <button type="button" className="btn-primary" onClick={move} disabled={busy}>{busy ? 'Moving…' : 'Move this lead'}</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

// --------------------------------------------------------------- blocking ---

export function BlockDomainDialog({ address, onClose, onDone }) {
  const domain = String(address || '').split('@').pop().toLowerCase()
  const [scope, setScope] = useState('domain')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const value = scope === 'domain' ? domain : String(address || '').toLowerCase()

  const block = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.post('/api/blocked-domains', { domains: [value], source: 'manual' })
      onDone(result, value)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Modal title="Block this sender" onClose={onClose}>
      <div className="space-y-3 text-sm text-slate-700">
        <fieldset>
          <legend className="text-xs text-slate-600">What to block</legend>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" name="block-scope" className="accent-accent-500" checked={scope === 'domain'} onChange={() => setScope('domain')} />
            Everyone at <span className="text-ink-950">{domain}</span>
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" name="block-scope" className="accent-accent-500" checked={scope === 'address'} onChange={() => setScope('address')} />
            Just <span className="text-ink-950">{address}</span>
          </label>
        </fieldset>

        <p className="text-slate-600">
          Suppression is unconditional and has no bypass. There is no per-campaign, per-send or "ignore the block list"
          option anywhere in Harry, and a request that asks for one is refused rather than quietly obeyed.
        </p>
        <p className="text-slate-600">
          Every matching lead stops in every campaign at once, and any email already written for them is withdrawn from
          Needs your OK so it cannot be approved afterwards.
        </p>

        <Banner error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-danger" onClick={block} disabled={busy}>{busy ? 'Blocking…' : `Block ${value}`}</button>
        </div>
      </div>
    </Modal>
  )
}
