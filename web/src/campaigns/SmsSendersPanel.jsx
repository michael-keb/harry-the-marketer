// Sending from — SMS channel accounts attached to this campaign.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { Confirm, LiveRegion } from '../parity-ui.jsx'
import { Modal, useToast } from '../ui.jsx'
import { Panel, useResource, messageOf, nfmt } from './shared.jsx'

function labelOf(account) {
  return account.displayName || account.phoneNumber || account.messagingServiceSid || `SMS #${account.id}`
}

export default function SmsSendersPanel({ campaign, onChanged, compact = false }) {
  const toast = useToast()
  const { data, loading, error, reload } = useResource(`/api/campaigns/${campaign.id}/channel-accounts`)
  const [adding, setAdding] = useState(false)
  const [detaching, setDetaching] = useState(null)
  const [note, setNote] = useState('')

  const rows = data?.accounts || []
  const running = campaign.state === 'START'
  const totalRemaining = rows.reduce((a, m) => a + Math.max(0, (m.dailyLimit || 0) - (m.sentToday || 0)), 0)
  const totalCap = rows.reduce((a, m) => a + (m.dailyLimit || 0), 0)

  const detach = async (account) => {
    try {
      await api.del(`/api/campaigns/${campaign.id}/channel-accounts/${account.id}`)
      setNote(`${labelOf(account)} removed from this campaign. The account itself is untouched.`)
      toast('SMS sender removed from this campaign')
      await reload()
      await onChanged?.()
    } catch (err) {
      toast(messageOf(err), 'error')
    } finally {
      setDetaching(null)
    }
  }

  return (
    <Panel
      id="sms-senders"
      title={compact ? 'SMS senders' : 'Sending from — SMS'}
      note={
        rows.length
          ? `${rows.length} SMS sender${rows.length === 1 ? '' : 's'}, ${nfmt(totalRemaining)} of ${nfmt(totalCap)} texts left today. Removing one here never disconnects the account.`
          : 'Which Twilio (or sandbox) numbers this campaign may text from.'
      }
      actions={(
        <button className="btn-ghost cursor-pointer py-1.5" onClick={() => setAdding(true)}>
          Add SMS senders
        </button>
      )}
    >
      <LiveRegion message={note} />

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert">
          {messageOf(error)}
          <button className="ml-2 cursor-pointer underline" onClick={reload}>Try again</button>
        </div>
      ) : loading && !data ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-800">No SMS sender attached yet — this campaign cannot launch texts.</p>
          <button className="btn-primary mt-3 cursor-pointer" onClick={() => setAdding(true)}>Attach an SMS sender</button>
          <p className="mt-2 text-xs text-amber-700">
            Need a number first?{' '}
            <Link className="underline" to="/app/connections?area=messages">Connect SMS in Connections</Link>.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => {
            const isLast = rows.length === 1
            const blocked = running && isLast
            const remaining = Math.max(0, (m.dailyLimit || 0) - (m.sentToday || 0))
            return (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm text-ink-900">{labelOf(m)}</span>
                    {m.provider === 'sandbox' && (
                      <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600">
                        Sandbox — nothing really sends
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {m.phoneNumber || m.messagingServiceSid || 'No From number'}
                    {' · '}{m.provider}
                    {' · '}
                    <span className={m.status === 'connected' && !m.isSuspended ? 'text-emerald-700' : 'text-amber-700'}>
                      {m.isSuspended ? 'Suspended' : m.status === 'connected' ? 'Connected' : m.status}
                    </span>
                    {' · '}{nfmt(remaining)} of {nfmt(m.dailyLimit)} left today
                  </div>
                  {m.lastError && <div className="mt-1 text-[11px] text-red-700">Last error: {m.lastError}</div>}
                  {blocked && (
                    <div id={`why-keep-sms-${m.id}`} className="mt-1 text-[11px] text-amber-700">
                      This is the only SMS sender on a running campaign — removing it would leave SMS steps with nowhere to send from.
                      Pause the campaign first, or attach a replacement.
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Link className="text-xs text-slate-600 hover:text-accent-700" to="/app/connections?area=messages">
                    Manage account
                  </Link>
                  <button
                    className="cursor-pointer text-xs text-slate-600 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={blocked}
                    aria-describedby={blocked ? `why-keep-sms-${m.id}` : undefined}
                    aria-label={`Remove ${labelOf(m)} from this campaign`}
                    onClick={() => setDetaching(m)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {adding && (
        <AddSmsSendersModal
          campaignId={campaign.id}
          attachedIds={new Set(rows.map((m) => m.id))}
          onClose={() => setAdding(false)}
          onDone={async (n) => {
            setAdding(false)
            setNote(`${n} SMS sender${n === 1 ? '' : 's'} attached`)
            await reload()
            await onChanged?.()
          }}
        />
      )}

      {detaching && (
        <Confirm
          title={`Remove ${labelOf(detaching)} from this campaign?`}
          danger
          confirmLabel="Remove from campaign"
          body={
            `This campaign stops texting from ${labelOf(detaching)}. The Twilio account stays connected `
            + 'everywhere else — this only changes which SMS senders this campaign draws on.'
          }
          onConfirm={() => detach(detaching)}
          onClose={() => setDetaching(null)}
        />
      )}
    </Panel>
  )
}

function AddSmsSendersModal({ campaignId, attachedIds, onClose, onDone }) {
  const toast = useToast()
  const { data, loading, error, reload } = useResource('/api/channel-accounts?channel=sms')
  const [selected, setSelected] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)

  const all = data?.accounts || []
  const candidates = all.filter((m) => !attachedIds.has(m.id))

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const attach = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const res = await api.post(`/api/campaigns/${campaignId}/channel-accounts`, {
        channelAccountIds: [...selected],
      })
      toast(`Attached ${res.attached} SMS sender${res.attached === 1 ? '' : 's'}`)
      onDone(res.attached)
    } catch (err) {
      setFailure(err)
      setBusy(false)
    }
  }

  return (
    <Modal title="Add SMS senders" onClose={onClose} wide>
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {messageOf(error)} <button className="cursor-pointer underline" onClick={reload}>Try again</button>
        </p>
      ) : loading && !data ? (
        <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-11 animate-pulse rounded bg-slate-100" />)}</div>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-slate-600">
          Every SMS sender in this workspace is already attached.{' '}
          <Link className="text-accent-700 hover:underline" to="/app/connections?area=messages">Connect another</Link>.
        </p>
      ) : (
        <>
          {failure && (
            <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {messageOf(failure)} — nothing was attached, and your selection is still here.
            </p>
          )}
          <ul className="max-h-80 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200">
            {candidates.map((m) => {
              const usable = m.status === 'connected' && !m.isSuspended
              const remaining = Math.max(0, (m.dailyLimit || 0) - (m.sentToday || 0))
              return (
                <li key={m.id}>
                  <label className={`flex items-center gap-3 px-3 py-2.5 ${usable ? 'cursor-pointer hover:bg-slate-100/50' : 'opacity-60'}`}>
                    <input
                      type="checkbox"
                      className="accent-accent-500"
                      disabled={!usable}
                      checked={selected.has(m.id)}
                      onChange={() => toggle(m.id)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink-900">{labelOf(m)}</span>
                      <span className="block text-[11px] text-slate-500">
                        {m.phoneNumber || m.messagingServiceSid || 'No From number'}
                        {' · '}{m.provider}
                        {m.provider === 'sandbox' ? ' · sandbox, nothing really sends' : ''}
                        {' · '}
                        {usable ? `${nfmt(remaining)} of ${nfmt(m.dailyLimit)} left today` : `Not usable (${m.status})`}
                      </span>
                    </span>
                    {!usable && (
                      <Link className="ml-auto shrink-0 text-xs text-accent-700 hover:underline" to="/app/connections?area=messages">
                        Fix in Connections
                      </Link>
                    )}
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">{selected.size} selected</span>
            <div className="flex gap-2">
              <button className="btn-ghost cursor-pointer" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn-primary cursor-pointer" disabled={!selected.size || busy} onClick={attach}>
                {busy ? 'Attaching…' : `Attach ${selected.size || ''}`}
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}
