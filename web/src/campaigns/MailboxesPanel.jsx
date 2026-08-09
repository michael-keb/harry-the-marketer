// Sending from — the campaign's mailbox pool.
//
// A campaign sends from a pool, not a single account. `POST /mailboxes` attaches
// (whole list validated before anything is written, so a bad id attaches
// nothing) and `DELETE /mailboxes/:mailboxId` detaches. The backend refuses to
// leave a *running* campaign with nothing to send from — a 409 — so the control
// that would do it is disabled with the reason attached, rather than enabled and
// then rejected.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { Confirm, LiveRegion } from '../parity-ui.jsx'
import { Modal, useToast } from '../ui.jsx'
import { Panel, useResource, messageOf, nfmt } from './shared.jsx'

export default function MailboxesPanel({ campaign, onChanged }) {
  const toast = useToast()
  const { data, loading, error, reload } = useResource(`/api/campaigns/${campaign.id}/mailboxes`)
  const [adding, setAdding] = useState(false)
  const [detaching, setDetaching] = useState(null)
  const [note, setNote] = useState('')

  const rows = data?.mailboxes || []
  const running = campaign.state === 'START'
  const totalRemaining = rows.reduce((a, m) => a + (m.remainingToday || 0), 0)
  const totalCap = rows.reduce((a, m) => a + (m.rampedCap ?? m.dailyLimit ?? 0), 0)

  const detach = async (mailbox) => {
    try {
      await api.del(`/api/campaigns/${campaign.id}/mailboxes/${mailbox.id}`)
      setNote(`${mailbox.email} removed from this campaign. The account itself is untouched.`)
      toast('Mailbox removed from this campaign')
      await reload()
      await onChanged?.()
    } catch (err) {
      toast(messageOf(err), 'error')
    } finally { setDetaching(null) }
  }

  return (
    <Panel
      id="mailboxes"
      title="Sending from"
      note={
        rows.length
          ? `${rows.length} mailbox${rows.length === 1 ? '' : 'es'}, ${nfmt(totalRemaining)} of ${nfmt(totalCap)} sends left today. Removing one here never disconnects the account.`
          : 'Which accounts this campaign may send from.'
      }
      actions={<button className="btn-ghost cursor-pointer py-1.5" onClick={() => setAdding(true)}>Add mailboxes</button>}
    >
      <LiveRegion message={note} />

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert">
          {messageOf(error)}
          <button className="ml-2 cursor-pointer underline" onClick={reload}>Try again</button>
        </div>
      ) : loading && !data ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1].map((i) => <div key={i} className="h-14 rounded-lg bg-slate-100 animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-800">No mailbox attached yet — this campaign cannot launch.</p>
          <button className="btn-primary mt-3 cursor-pointer" onClick={() => setAdding(true)}>Attach a mailbox</button>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => {
            const isLast = rows.length === 1
            const blocked = running && isLast
            return (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm text-ink-900">{m.email}</span>
                    {m.isPrimary && (
                      <span className="rounded-full border border-accent-600 px-2 py-0.5 text-[11px] text-accent-700">Primary</span>
                    )}
                    {m.provider === 'sandbox' && (
                      <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600">Sandbox — nothing really sends</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {m.fromName ? `${m.fromName} · ` : ''}{m.provider}
                    {' · '}
                    <span className={m.connection === 'connected' ? 'text-emerald-700' : 'text-amber-700'}>
                      {m.connection === 'connected' ? 'Connected' : `Not connected (${m.connection})`}
                    </span>
                    {m.suspended && <span className="text-red-700"> · Suspended</span>}
                    {m.warmingUp && <span className="text-amber-700"> · Warming up</span>}
                    {' · '}{nfmt(m.remainingToday)} of {nfmt(m.rampedCap ?? m.dailyLimit)} left today
                    {m.campaignsUsing > 1 && ` · shared with ${m.campaignsUsing - 1} other campaign${m.campaignsUsing > 2 ? 's' : ''}`}
                  </div>
                  {m.lastError && <div className="mt-1 text-[11px] text-red-700">Last error: {m.lastError}</div>}
                  {blocked && (
                    <div id={`why-keep-${m.id}`} className="mt-1 text-[11px] text-amber-700">
                      This is the only mailbox on a running campaign — removing it would leave it with no way to send.
                      Pause the campaign first, or attach a replacement.
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Link className="text-xs text-slate-600 hover:text-accent-700" to="/app/connections?area=email">Manage account</Link>
                  <button
                    className="cursor-pointer text-xs text-slate-600 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={blocked}
                    aria-describedby={blocked ? `why-keep-${m.id}` : undefined}
                    aria-label={`Remove ${m.email} from this campaign`}
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
        <AddMailboxesModal
          campaignId={campaign.id}
          attachedIds={new Set(rows.map((m) => m.id))}
          onClose={() => setAdding(false)}
          onDone={async (n) => {
            setAdding(false)
            setNote(`${n} mailbox${n === 1 ? '' : 'es'} attached`)
            await reload()
            await onChanged?.()
          }}
        />
      )}

      {detaching && (
        <Confirm
          title={`Remove ${detaching.email} from this campaign?`}
          danger
          confirmLabel="Remove from campaign"
          body={
            `This campaign stops sending from ${detaching.email}. The account stays connected and keeps working `
            + 'everywhere else — this only changes which mailboxes this campaign draws on. Any lead pinned to it '
            + 'goes back to rotation.'
          }
          onConfirm={() => detach(detaching)}
          onClose={() => setDetaching(null)}
        />
      )}
    </Panel>
  )
}

function AddMailboxesModal({ campaignId, attachedIds, onClose, onDone }) {
  const toast = useToast()
  const { data, loading, error, reload } = useResource('/api/mailboxes')
  const [selected, setSelected] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)

  const all = data?.mailboxes || []
  const candidates = all.filter((m) => !attachedIds.has(m.id))

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const attach = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const res = await api.post(`/api/campaigns/${campaignId}/mailboxes`, { mailboxIds: [...selected] })
      toast(`Attached ${res.attached} mailbox${res.attached === 1 ? '' : 'es'}`)
      onDone(res.attached)
    } catch (err) {
      // Selection is preserved so a fixable problem does not cost the choice.
      setFailure(err)
      setBusy(false)
    }
  }

  return (
    <Modal title="Add mailboxes" onClose={onClose} wide>
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {messageOf(error)} <button className="cursor-pointer underline" onClick={reload}>Try again</button>
        </p>
      ) : loading && !data ? (
        <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-11 rounded bg-slate-100 animate-pulse" />)}</div>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-slate-600">
          Every mailbox in this workspace is already attached.{' '}
          <Link className="text-accent-700 hover:underline" to="/app/connections?area=email">Connect another</Link>.
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
              const usable = m.status === 'connected'
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
                      <span className="block truncate text-sm text-ink-900">{m.email}</span>
                      <span className="block text-[11px] text-slate-500">
                        {m.provider}
                        {m.provider === 'sandbox' ? ' · sandbox, nothing really sends' : ''}
                        {' · '}
                        {usable ? `${nfmt(m.remainingToday)} of ${nfmt(m.dailyLimit)} left today` : `Not connected (${m.status})`}
                      </span>
                    </span>
                    {!usable && (
                      <Link className="ml-auto shrink-0 text-xs text-accent-700 hover:underline" to="/app/connections?area=email">Reconnect</Link>
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
