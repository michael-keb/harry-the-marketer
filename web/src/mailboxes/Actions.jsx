// The two decisions on a mailbox that change what a campaign can do: taking it
// out of every send, and removing it entirely.
//
// Both of them state their consequences before the user commits, not after.
// The server can only report which campaigns a mailbox *is* holding — a mailbox
// that still works holds nothing back — so the "if you do this" answer is
// computed here from the same rule the server uses, over the whole fleet.

import { useState } from 'react'
import { api } from '../api.js'
import { Confirm } from '../parity-ui.jsx'
import { campaignsLeftWithNothing, plural } from './common.jsx'

function HoldingList({ campaigns }) {
  if (!campaigns.length) return null
  return (
    <span className="mt-3 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <span className="block font-medium">
        {plural(campaigns.length, 'campaign')} would have nothing left to send from and will hold:
      </span>
      <span className="mt-1 block">
        {campaigns.map((c) => c.name || `Campaign ${c.campaignId || c.id}`).join(', ')}
      </span>
    </span>
  )
}

// Suspend and resume are the same control, so they are the same dialog.
export function SuspendDialog({ mailbox, fleet, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const resuming = Boolean(mailbox.isSuspended)
  const wouldHold = resuming ? [] : campaignsLeftWithNothing(fleet, mailbox)

  const run = async () => {
    setError('')
    try {
      if (resuming) {
        const res = await api.del(`/api/mailboxes/${mailbox.id}/suspend`)
        const check = res.connection || {}
        const legs = (check.checks || []).filter((c) => c.checked && !c.ok)
        onDone(
          legs.length
            ? `${mailbox.fromEmail} resumed, but the check found: ${legs.map((l) => l.detail).join('; ')}`
            : `${mailbox.fromEmail} resumed and its connection checks passed.`,
          legs.length ? 'error' : 'success'
        )
      } else {
        const res = await api.put(`/api/mailboxes/${mailbox.id}/suspend`, { reason })
        const holding = res.holding || []
        onDone(
          holding.length
            ? `${mailbox.fromEmail} suspended. ${plural(holding.length, 'campaign')} now holding: ${holding.map((h) => h.name).join(', ')}.`
            : `${mailbox.fromEmail} suspended — it is out of every send from now.`,
          'success'
        )
      }
      onClose()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Confirm
      title={resuming ? `Resume ${mailbox.fromEmail}?` : `Suspend ${mailbox.fromEmail}?`}
      confirmLabel={resuming ? 'Resume mailbox' : 'Suspend mailbox'}
      danger={!resuming}
      onClose={onClose}
      onConfirm={run}
      body={
        <span className="block">
          {resuming ? (
            <>
              Resuming puts this mailbox back to work and re-checks its connection in the same step, so
              it is never quietly resumed-and-still-broken. Its warm-up carries on from where the calendar
              says it should be — it neither restarts nor jumps to the ceiling.
            </>
          ) : (
            <>
              A suspended mailbox is excluded from every send immediately. Nothing is disconnected and no
              campaign loses it — anything attached simply says why it is holding. You can resume it at
              any time.
            </>
          )}

          {!resuming && <HoldingList campaigns={wouldHold} />}
          {!resuming && !wouldHold.length && (
            <span className="mt-3 block text-xs text-slate-600">
              No running campaign depends on this mailbox alone, so nothing will stop.
            </span>
          )}

          {!resuming && (
            <label className="mt-3 block text-xs text-slate-600">
              Reason (optional — shown wherever this mailbox is holding something up)
              <input
                className="input mt-1"
                value={reason}
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. bounce rate climbing"
              />
            </label>
          )}

          {error && <span role="alert" className="mt-3 block text-xs text-red-700">{error}</span>}
        </span>
      }
    />
  )
}

// Removal is not reversible from the UI, so the consequence list is the whole
// dialog: which campaigns use it, how many drafts are waiting, and whether a
// campaign is left with nothing to send from.
export function DeleteDialog({ mailbox, impact, fleet, onClose, onDone }) {
  const [error, setError] = useState('')
  const attached = (mailbox.campaigns || [])
  const wouldHold = campaignsLeftWithNothing(fleet, mailbox)
  const alreadyHolding = impact?.wouldHold || []

  const run = async () => {
    setError('')
    try {
      await api.del(`/api/mailboxes/${mailbox.id}`)
      onDone(`${mailbox.fromEmail} removed. History in Inbox and Reports still shows what it sent.`)
      onClose()
    } catch (err) {
      // Already gone is reconciled silently rather than shown as a failure.
      if (err.status === 404) {
        onDone(`${mailbox.fromEmail} was already removed.`)
        onClose()
        return
      }
      setError(err.message)
    }
  }

  return (
    <Confirm
      title={`Remove ${mailbox.fromEmail}?`}
      confirmLabel="Remove mailbox"
      danger
      onClose={onClose}
      onConfirm={run}
      body={
        <span className="block">
          This cannot be undone from here. Suspending instead takes the mailbox out of every send while
          keeping its campaign links and its warm-up progress.

          <span className="mt-3 block rounded-lg border border-slate-200 bg-white/40 px-3 py-2 text-xs text-slate-700">
            <span className="block">
              <span className="text-slate-500">Campaigns using it: </span>
              {impact ? impact.campaignsAttached : '—'}
              {attached.length > 0 && (
                <span className="text-slate-500"> ({attached.map((c) => c.name).join(', ')})</span>
              )}
            </span>
            <span className="mt-1 block">
              <span className="text-slate-500">Drafts waiting for approval: </span>
              {impact ? impact.draftsWaiting : '—'}
            </span>
          </span>

          <HoldingList campaigns={wouldHold.length ? wouldHold : alreadyHolding} />

          {error && <span role="alert" className="mt-3 block text-xs text-red-700">{error}</span>}
        </span>
      }
    />
  )
}
