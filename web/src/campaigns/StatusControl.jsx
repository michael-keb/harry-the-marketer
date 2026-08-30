// Status control and launch gate.
//
// `PUT /api/campaigns/:id/status` takes START, PAUSED or STOPPED. It answers
// ACTIVE with a 422 explaining that the source API's own samples disagree with
// its body spec — so ACTIVE is never offered here, and the button group is the
// only place a status changes.
//
// Two rules the backend enforces and this component has to say out loud:
//
//   * START returns EVERY unmet condition at once (invalid playbook, no
//     mailbox, no leads). They render as a checklist, not one error at a time.
//   * STOPPED is terminal. A stopped campaign 409s on every later start,
//     pointing at duplicate — so the confirmation says that before the user
//     commits, and offers Duplicate as the way forward.

import { useState } from 'react'
import { api } from '../api.js'
import { Confirm, LiveRegion } from '../parity-ui.jsx'
import { Icon, Modal, useToast } from '../ui.jsx'
import { StateChip, blockersOf, codeOf, messageOf, nfmt } from './shared.jsx'

const BLOCKER_FIX = {
  playbook: { label: 'A valid playbook', fix: 'Fix the diagram in the Playbook tab' },
  mailboxes: { label: 'A sending mailbox', fix: 'Attach one in the Sending from panel' },
  sms_accounts: { label: 'An SMSFlow sender', fix: 'Attach one in the Sending from panel' },
  leads: { label: 'At least one lead', fix: 'Attach leads in the Leads tab' },
  cohort: { label: 'Leads that match this playbook', fix: 'Add missing emails or phone numbers on the Leads tab' },
  purpose: { label: 'Playbook matches this ask', fix: 'Edit the playbook so it matches the campaign purpose' },
  email_subject: { label: 'A valid email subject', fix: 'Fix the subject in Settings' },
  defaults: { label: 'Sending defaults', fix: 'Review Settings' },
}

function conditionsFor({ channelMode = 'email', channels, blockers = [] } = {}) {
  const usesSms = Boolean(
    channels?.sms || channelMode === 'sms' || channelMode === 'multi'
    || blockers.some((b) => b.field === 'sms_accounts')
  )
  const usesEmail = Boolean(
    channels?.email || channelMode === 'email' || channelMode === 'multi'
    || blockers.some((b) => b.field === 'mailboxes')
    || (!usesSms && channelMode !== 'sms')
  )
  const conditions = ['playbook']
  if (usesEmail) conditions.push('mailboxes')
  if (usesSms) conditions.push('sms_accounts')
  conditions.push('leads')
  for (const b of blockers) {
    if (b?.field && !conditions.includes(b.field)) conditions.push(b.field)
  }
  return conditions
}

// The readiness strip: what is still missing, and where to fix it. It disappears
// once every condition is met.
export function LaunchChecklist({ blockers = [], onGoTo, channelMode = 'email', channels }) {
  if (!blockers.length) return null
  const unmet = new Map(blockers.map((b) => [b.field, b]))
  const conditions = conditionsFor({ channelMode, channels, blockers })
  return (
    <div className="card border-amber-200 bg-amber-50 p-4" role="status">
      <h3 className="text-sm font-semibold text-amber-800">Not ready to start</h3>
      <p className="mt-0.5 text-xs text-amber-700">
        Everything below has to be true before this campaign can send. They are all listed together
        so you can fix them in one pass.
      </p>
      <ul className="mt-3 space-y-2">
        {conditions.map((field) => {
          const blocker = unmet.get(field)
          const meta = BLOCKER_FIX[field] || { label: blocker?.message || field, fix: 'Review this campaign' }
          return (
            <li key={field} className="flex items-start gap-2 text-sm">
              <span
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                  blocker ? 'border-amber-300 text-amber-700' : 'border-emerald-300 text-emerald-700'
                }`}
                aria-hidden
              >
                {blocker ? '!' : <Icon name="check" className="size-3" />}
              </span>
              <span className={blocker ? 'text-amber-800' : 'text-slate-600'}>
                <span className="sr-only">{blocker ? 'Still needed: ' : 'Done: '}</span>
                {meta.label}
                {blocker && (
                  <>
                    {' — '}
                    <span className="text-amber-700">{blocker.message}</span>
                    {onGoTo && (
                      <button
                        type="button"
                        className="ml-2 cursor-pointer underline hover:text-amber-800"
                        onClick={() => onGoTo(field)}
                      >
                        {meta.fix}
                      </button>
                    )}
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {unmet.get('playbook')?.errors?.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-amber-200 pt-3 text-xs text-amber-700">
          {unmet.get('playbook').errors.slice(0, 6).map((e, i) => (
            <li key={i}>{e.line ? `Line ${e.line}: ` : ''}{e.message}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function scheduleSentence(schedule) {
  if (!schedule) return null
  const days = Array.isArray(schedule.days) ? schedule.days : []
  const dayText = days.length === 7 ? 'every day'
    : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'weekdays'
    : days.map((d) => DAY_ABBR[d] ?? d).join(', ')
  return `${dayText || 'weekdays'}, ${schedule.start_hour}–${schedule.end_hour}${schedule.timezone ? ` (${schedule.timezone})` : ''}`
}

// The pre-start summary. Starting is the moment a campaign stops being a
// document and begins contacting people, so instead of "are you sure" the
// dialog shows what is about to act: how many leads, from which senders,
// inside which window, and whether a person still OKs every email.
function StartConfirm({ resuming, summary, busy, onConfirm, onClose }) {
  const s = summary || {}
  const senders = [
    ...(s.mailboxes || []),
    s.smsSenderCount ? `${s.smsSenderCount} SMS sender${s.smsSenderCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  const windowLine = scheduleSentence(s.schedule)
  return (
    <Modal title={resuming ? 'Resume this campaign?' : 'Start this campaign?'} onClose={onClose}>
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          {resuming
            ? 'Sending picks up where it paused. From the next window, the agent works these leads again:'
            : 'From the next send window, the agent starts working these leads:'}
        </p>
        <ul className="space-y-1 rounded-lg border border-slate-200 bg-white p-3 text-[13px]">
          <li>
            <span className="text-slate-500">Leads</span>{' '}
            {s.leadCount == null ? 'attached to this campaign' : `${nfmt(s.leadCount)} attached`}
          </li>
          <li>
            <span className="text-slate-500">Sending from</span>{' '}
            {senders.length ? senders.join(', ') : 'the attached senders'}
          </li>
          {windowLine && (
            <li><span className="text-slate-500">Send window</span> {windowLine}</li>
          )}
          <li>
            <span className="text-slate-500">Approvals</span>{' '}
            {s.requireApproval == null
              ? 'as set in Settings → Sending'
              : s.requireApproval
                ? 'on — every email waits in Needs your OK first'
                : 'off — emails go out without a person reading them'}
          </li>
        </ul>
        <p className="text-slate-600">
          {s.requireApproval
            ? 'Nothing reaches a lead until you approve it, and you can pause any time.'
            : 'Real emails go on the wire without a second look. You can pause any time, but what has left cannot be recalled.'}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Starting…' : resuming ? 'Yes, resume it' : 'Yes, start it'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export default function StatusControl({ campaign, onChanged, onDuplicate, onGoTo, showChip = true, actions = null, launchSummary = null }) {
  const toast = useToast()
  const [busy, setBusy] = useState('')
  const [confirming, setConfirming] = useState(null) // 'START' | 'STOPPED'
  const [blockers, setBlockers] = useState(null)     // from the server's 422
  const [note, setNote] = useState('')
  const [stoppedError, setStoppedError] = useState('')

  const state = campaign.state
  const stopped = state === 'STOPPED'
  const archived = state === 'ARCHIVED'

  const send = async (status) => {
    setBusy(status)
    setBlockers(null)
    setStoppedError('')
    try {
      const res = await api.put(`/api/campaigns/${campaign.id}/status`, { status })
      setNote(res.message || 'Campaign status updated successfully')
      toast(status === 'START' ? 'Campaign started' : status === 'PAUSED' ? 'Campaign paused' : 'Campaign stopped')
      await onChanged?.()
    } catch (err) {
      if (blockersOf(err).length) {
        setBlockers(blockersOf(err))
        setNote('This campaign is not ready to start')
      } else if (codeOf(err) === 'campaign_stopped') {
        setStoppedError(messageOf(err))
      } else {
        toast(messageOf(err), 'error')
      }
    } finally {
      setBusy('')
      setConfirming(null)
    }
  }

  // Only the moves that apply right now. Previously Start, Pause and Stop were
  // all rendered whatever the state was, with two of them permanently greyed —
  // so a running campaign showed an inert "Start" beside a live "Pause" and the
  // header read as broken rather than as busy.
  const running = state === 'START'

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        {showChip && <StateChip state={state} />}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Campaign status">
          {stopped ? (
            <button className="btn-ghost" onClick={onDuplicate}>Duplicate to run again</button>
          ) : (
            <>
              {running ? (
                <button
                  className="btn-ghost"
                  disabled={Boolean(busy)}
                  aria-label="Pause this campaign"
                  onClick={() => send('PAUSED')}
                >
                  {busy === 'PAUSED' ? 'Pausing…' : 'Pause'}
                </button>
              ) : (
                <button
                  className="btn-primary"
                  disabled={Boolean(busy) || archived}
                  aria-label={state === 'PAUSED' ? 'Resume this campaign' : 'Start this campaign'}
                  onClick={() => setConfirming('START')}
                >
                  {busy === 'START' ? 'Starting…' : state === 'PAUSED' ? 'Resume' : 'Start'}
                </button>
              )}
              <button
                className="btn-danger"
                disabled={Boolean(busy) || archived}
                aria-label="Stop this campaign permanently"
                onClick={() => setConfirming('STOPPED')}
              >
                Stop
              </button>
            </>
          )}
        </div>
        {actions && (
          <>
            <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" aria-hidden />
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          </>
        )}
      </div>

      {stopped && (
        <p className="max-w-md text-right text-xs text-red-700">
          This campaign was stopped permanently. It cannot be restarted — duplicate it to run the same
          playbook again.
        </p>
      )}
      {archived && !stopped && (
        <p className="max-w-md text-right text-xs text-slate-600">
          Archived. Restore it from Manage before starting it.
        </p>
      )}
      {stoppedError && <p className="max-w-md text-right text-xs text-red-700" role="alert">{stoppedError}</p>}

      <LiveRegion message={note} />

      {blockers && (
        <div className="w-full max-w-xl text-left">
          <LaunchChecklist blockers={blockers} onGoTo={onGoTo} />
        </div>
      )}

      {confirming === 'START' && (
        <StartConfirm
          resuming={state === 'PAUSED'}
          summary={launchSummary}
          busy={busy === 'START'}
          onConfirm={() => send('START')}
          onClose={() => setConfirming(null)}
        />
      )}

      {confirming === 'STOPPED' && (
        <Confirm
          title="Stop this campaign permanently?"
          danger
          confirmLabel="Stop permanently"
          body={
            'Stopping is final: this campaign can never be started again, and any email waiting for your OK '
            + 'is declined. Leads, messages and statistics are kept, and nothing is deleted. If you want to run '
            + 'this playbook again later, cancel and use Duplicate instead — pause is the reversible option.'
          }
          onConfirm={() => send('STOPPED')}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  )
}
