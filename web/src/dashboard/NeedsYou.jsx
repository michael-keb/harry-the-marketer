// "Needs you" — one queue for the whole question.
//
// It sits above the KPIs because it is the reason to open the page: numbers are
// what you read afterwards. The four sources it merges each keep their own
// surface — the Inbox still owns approvals and reminders, Leads still owns
// tasks — and every row links back to the one that owns it. This is a queue,
// not a replacement: it exists so nobody has to visit three pages to find out
// whether they are finished.
//
// Two rules the code below is built around, both from README.md and both easy
// to break by accident:
//
//   1. Nothing sends without the user's OK, and the OK is given on the actual
//      words. So there is no send button on a collapsed row here — approving
//      opens the email in full first. "Send all" deliberately does not exist on
//      this page; it lives in the Inbox with its confirmation, next to the
//      cards that show what is being sent.
//   2. A count must never be a lie. A source that failed to load says so and
//      shows no number, because a 0 here reads as "nothing to do".

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { clockTime, Icon } from '../ui.jsx'
import { Confirm, Drawer, EmptyState, LiveRegion, Spinner, Tabs } from '../parity-ui.jsx'
import {
  SORT_EXPLAINER, SOURCE_IDS, SOURCE_META, absoluteWhen, useNeedsYou,
} from './needs-you-data.jsx'

// The dashboard is a dashboard: a queue of forty is a page nobody scrolls. The
// rest is one click away and the button says how many are behind it.
const FOLD = 8

export default function NeedsYou({ decisions, onDecisionsChanged }) {
  const queue = useNeedsYou(decisions, onDecisionsChanged)
  const { sources, counts, unavailable, loading, total, leadNames, setPaused } = queue

  const [tab, setTab] = useState('all')
  const [live, setLive] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [busyKey, setBusyKey] = useState(null)
  const [rowError, setRowError] = useState(null)   // { key, field, message }
  const [reviewing, setReviewing] = useState(null) // an approval item, read in full
  const [confirming, setConfirming] = useState(null)

  // A poll must not move a row out from under a click, or refresh the email
  // someone is part-way through reading.
  useEffect(() => {
    setPaused(Boolean(reviewing || confirming || busyKey))
  }, [setPaused, reviewing, confirming, busyKey])

  // A source going dark is a change worth hearing about — it is the difference
  // between "nothing to do" and "we cannot tell you".
  useEffect(() => {
    if (!unavailable.length) return
    setLive(`${unavailable.map((id) => SOURCE_META[id].label).join(' and ')} could not be loaded — the counts below are incomplete.`)
  }, [unavailable.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(
    () => (tab === 'all' ? queue.items : queue.items.filter((i) => i.source === tab)),
    [queue.items, tab],
  )

  // Every action goes through here: pause, act, re-read the one source that
  // changed, then say what happened out loud.
  const run = async (item, action, said) => {
    setBusyKey(item.key)
    setRowError(null)
    try {
      const message = await action()
      await queue.reloadSource(item.source)
      setLive(message || said)
    } catch (err) {
      // A 422 carries `{ field, message }` where the message is the sentence
      // written for a person. It belongs on the row it is about — a toast in
      // the corner cannot say which of eight rows was refused, or why.
      setRowError({
        key: item.key,
        field: err?.payload?.field || '',
        message: err?.payload?.message || err?.message || 'That did not work.',
      })
    } finally {
      setBusyKey(null)
    }
  }

  // ---- the actions ---------------------------------------------------------

  const sendDraft = (item) => run(item, async () => {
    const result = await api.post(`/api/drafts/${item.raw.id}/approve`, {})
    setReviewing(null)
    // Approving means "yes, send this", not "send this instant" — the sending
    // rhythm still picks the minute, so say which one.
    return result.sent
      ? `Sent to ${item.who}.`
      : `Approved — goes to ${item.who}${result.sending?.until ? ` around ${clockTime(result.sending.until)}` : ' shortly'}.`
  })

  const declineDraft = (item) => setConfirming({
    title: "Don't send this?",
    body: `Nothing goes out, and ${item.who || 'this lead'} is stopped in “${item.context}”. You can still email them by hand.`,
    confirmLabel: "Don't send",
    danger: true,
    onConfirm: () => run(item, async () => {
      await api.post(`/api/drafts/${item.raw.id}/decline`)
      setReviewing(null)
      return `${item.who} stopped — nothing was sent.`
    }),
  })

  // Resuming runs the engine, and the engine is what puts mail on the wire. The
  // old Action Center resumed on a single click; it gets a beat of thought here
  // for the same reason every other send does.
  const resumeLead = (item) => setConfirming({
    title: 'Resume this lead?',
    body: `The playbook picks up where it stopped and the engine runs straight away. If ${item.who || 'this lead'} is due an email next, it will be written — and, if approvals are on, parked here for your OK first.`,
    confirmLabel: 'Resume',
    onConfirm: () => run(item, async () => {
      await api.post(`/api/campaigns/${item.raw.campaign_id}/leads/${item.raw.lead_id}/retry`)
      await api.post('/api/engine/tick')
      return `${item.who} resumed and the engine has run.`
    }),
  })

  const completeTask = (item) => run(item, async () => {
    await api.patch(`/api/tasks/${item.raw.id}`, { status: 'done' })
    return `Task “${item.headline}” marked complete.`
  })

  const clearReminder = (item) => run(item, async () => {
    await api.patch(`/api/reminders/${item.raw.id}`, { status: 'cleared' })
    return 'Reminder marked done.'
  })

  // ---- filters -------------------------------------------------------------

  // The counts live inside the tab's accessible name rather than beside it: a
  // bare "3" beside "Tasks" tells a screen-reader user a number, not what it
  // counts, and the same "3" beside "Approvals" would mean something else.
  const tabs = [
    {
      id: 'all',
      label: (
        <>
          All
          <Pill>{unavailable.length ? `${total}+` : total}</Pill>
          <span className="sr-only">
            , {unavailable.length
              ? `at least ${total} things need you — ${unavailable.map((id) => SOURCE_META[id].label).join(' and ')} could not be loaded`
              : `${total} thing${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} you`}
          </span>
        </>
      ),
    },
    ...SOURCE_IDS.map((id) => {
      const count = counts[id]
      return {
        id,
        label: (
          <>
            {SOURCE_META[id].label}
            <Pill unknown={count === null}>{count === null ? '—' : count}</Pill>
            <span className="sr-only">
              , {count === null
                ? 'count unavailable, this source could not be loaded'
                : SOURCE_META[id].noun(count)}
            </span>
          </>
        ),
      }
    }),
  ]

  const heading = tab === 'all'
    ? (unavailable.length ? `at least ${total}` : String(total))
    : counts[tab] === null ? 'unknown' : String(counts[tab])

  const visible = expanded ? shown : shown.slice(0, FOLD)
  const allWell = !loading && !unavailable.length && total === 0

  return (
    <section className="card" aria-labelledby="needs-you-heading">
      <LiveRegion message={live} />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-4">
        <h2 id="needs-you-heading" className="text-sm font-semibold text-ink-900">Needs you</h2>
        <p className="text-xs text-slate-500">
          Everything waiting on a person, from all four places it can come from.
        </p>
      </div>

      {unavailable.length > 0 && (
        <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800" role="status">
          <p className="font-medium">
            {unavailable.map((id) => SOURCE_META[id].label).join(' and ')}{' '}
            {unavailable.length === 1 ? 'is' : 'are'} unavailable — this list is incomplete.
          </p>
          <ul className="mt-1 space-y-0.5 text-[12px] text-amber-700">
            {unavailable.map((id) => (
              <li key={id}>
                {SOURCE_META[id].label}: {String(sources[id].error?.message || sources[id].error)}. Check {SOURCE_META[id].home} directly.
              </li>
            ))}
          </ul>
          <button type="button" className="btn-ghost mt-2 !py-1 !text-xs" onClick={() => queue.reload()}>
            Try again
          </button>
        </div>
      )}

      <div className="px-4 pt-3">
        <Tabs tabs={tabs} active={tab} onChange={(next) => {
          setTab(next)
          setExpanded(false)
          setRowError(null)
          if (next === 'all') {
            setLive(`Showing everything: ${unavailable.length ? 'at least ' : ''}${total} item${total === 1 ? '' : 's'}, ${SORT_EXPLAINER.toLowerCase()}`)
          } else if (counts[next] === null) {
            setLive(`${SOURCE_META[next].label} could not be loaded.`)
          } else {
            setLive(`Showing ${SOURCE_META[next].noun(counts[next])}.`)
          }
        }} ariaLabel="Filter what needs you" />
      </div>

      <div role="tabpanel" aria-label={`${tab === 'all' ? 'Everything that needs you' : SOURCE_META[tab].label}, ${heading} shown`}>
        {loading && shown.length === 0 ? (
          <div className="pb-2"><Spinner label="Checking what needs you…" /></div>
        ) : allWell ? (
          <div className="px-4 pb-4">
            <EmptyState
              icon="check"
              title="Nothing needs you"
              hint="No emails waiting for your OK, no leads parked on a decision, no open tasks and no reminders due. The agent keeps working; anything that needs a person lands here."
            />
          </div>
        ) : shown.length === 0 ? (
          <p className="px-4 pb-4 pt-1 text-sm text-slate-500">
            Nothing under {SOURCE_META[tab]?.label || 'this filter'} right now.{' '}
            {total > 0 && <button type="button" className="cursor-pointer text-accent-700 underline" onClick={() => setTab('all')}>See all {total}</button>}
          </p>
        ) : (
          <>
            {tab === 'all' && (
              <p className="px-4 pb-2 text-[11px] text-slate-500">{SORT_EXPLAINER}</p>
            )}
            <ul className="divide-y divide-slate-200 border-t border-slate-200">
              {visible.map((item) => (
                <QueueRow
                  key={item.key}
                  item={item}
                  leadNames={leadNames}
                  busy={busyKey === item.key}
                  disabled={Boolean(busyKey) && busyKey !== item.key}
                  error={rowError?.key === item.key ? rowError : null}
                  onReview={() => setReviewing(item)}
                  onResume={() => resumeLead(item)}
                  onComplete={() => completeTask(item)}
                  onClear={() => clearReminder(item)}
                />
              ))}
            </ul>

            {shown.length > FOLD && (
              <div className="flex justify-center border-t border-slate-200 py-2.5">
                <button type="button" className="btn-ghost !py-1 !text-xs" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? `Show only the first ${FOLD}` : `Show the other ${shown.length - FOLD}`}
                </button>
              </div>
            )}

            <Footnotes sources={sources} tab={tab} counts={counts} />
          </>
        )}
      </div>

      {reviewing && (
        <ReviewDrawer
          item={reviewing}
          busy={busyKey === reviewing.key}
          error={rowError?.key === reviewing.key ? rowError : null}
          onClose={() => setReviewing(null)}
          onSend={() => sendDraft(reviewing)}
          onDecline={() => declineDraft(reviewing)}
        />
      )}

      {confirming && (
        <Confirm
          title={confirming.title}
          body={confirming.body}
          confirmLabel={confirming.confirmLabel}
          danger={confirming.danger}
          onClose={() => setConfirming(null)}
          onConfirm={async () => { await confirming.onConfirm(); setConfirming(null) }}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------- bits -------

function Pill({ children, unknown }) {
  return (
    <span
      aria-hidden
      className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
        unknown ? 'bg-amber-50 text-amber-700' : 'bg-slate-200 text-slate-700'
      }`}
    >
      {children}
    </span>
  )
}

// Lateness is a word with an icon beside it, never a red row on its own.
function LateMark() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-700">
      <Icon name="alert" className="size-3" />
      Late
    </span>
  )
}

// What this list is not showing, said plainly. `GET /api/tasks` reports the
// workspace's true open count separately from the page of rows it returns, so
// the tab can be right while the list is a page short — that difference has to
// be visible or the count looks wrong.
function Footnotes({ sources, tab, counts }) {
  const notes = []
  for (const id of SOURCE_IDS) {
    if (tab !== 'all' && tab !== id) continue
    const entry = sources[id]
    if (entry.status !== 'ok') continue
    const shown = entry.items.length
    const known = counts[id]
    if (entry.meta?.hasMore || (known !== null && known > shown)) {
      notes.push(`Showing the first ${shown} of ${known ?? 'more'} ${SOURCE_META[id].label.toLowerCase()} — the rest are in ${SOURCE_META[id].home}.`)
    }
  }
  if (tab === 'all' || tab === 'reminder') {
    notes.push('Reminders appear here once they come due; ones set for later stay in the Inbox.')
  }
  if (!notes.length) return null
  return (
    <ul className="space-y-0.5 border-t border-slate-200 px-4 py-2.5 text-[11px] text-slate-500">
      {notes.map((note) => <li key={note}>{note}</li>)}
    </ul>
  )
}

// ----------------------------------------------------------------- row -------

function QueueRow({ item, leadNames, busy, disabled, error, onReview, onResume, onComplete, onClear }) {
  const subject = item.who || leadNames[item.leadId] || (item.leadId ? `Lead #${item.leadId}` : '')

  return (
    <li className="px-3 py-3 sm:px-4">
      {/* Stacks at 375px and lays out in a row from `sm` up — nothing here
          scrolls sideways. */}
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-600">{item.kind}</span>
            {item.late && <LateMark />}
          </div>
          <p className="mt-0.5 break-words text-sm text-ink-950">{item.headline}</p>
          {(subject || item.context) && (
            <p className="mt-0.5 break-words text-xs text-slate-500">
              {[subject, item.context].filter(Boolean).join(' · ')}
            </p>
          )}
          {item.note && <p className="mt-0.5 break-words text-xs text-slate-500">{item.note}</p>}
        </div>
        <span className="shrink-0 text-[11px] text-slate-500 sm:text-right" title={absoluteWhen(item.at)}>
          {item.atLabel}
          <span className="sr-only"> — {absoluteWhen(item.at)}</span>
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <RowActions
          item={item}
          busy={busy}
          disabled={disabled}
          onReview={onReview}
          onResume={onResume}
          onComplete={onComplete}
          onClear={onClear}
        />
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error.field && <span className="text-red-600">{error.field}: </span>}
          {error.message}
        </p>
      )}
    </li>
  )
}

function RowActions({ item, busy, disabled, onReview, onResume, onComplete, onClear }) {
  const off = busy || disabled
  const deepLink = 'text-xs text-slate-600 underline hover:text-accent-700'

  if (item.source === 'approval') {
    return (
      <>
        {/* No send button on the row. The OK is given on the words, so reading
            them is the first step and not an optional one. */}
        <button type="button" className="btn-ghost !py-1 !text-xs" disabled={off} onClick={onReview}>
          {busy ? 'Working…' : 'Read it'}
        </button>
        <Link to="/app/inbox?tab=approve" className={deepLink}>Open in Inbox</Link>
      </>
    )
  }

  if (item.source === 'decision') {
    return (
      <>
        <button type="button" className="btn-ghost !py-1 !text-xs" disabled={off} onClick={onResume}>
          {busy ? 'Working…' : 'Resume'}
        </button>
        <Link to="/app/inbox?tab=replies" className={deepLink}>Open in Inbox</Link>
        {/* The campaign's own Leads tab is where this enrolment, its node and
            its history actually live — the closest thing to "open the lead"
            that is reachable by URL today. */}
        {item.raw.campaign_id && (
          <Link to={`/app/campaigns/${item.raw.campaign_id}?tab=leads`} className={deepLink}>
            Open the lead in its campaign
          </Link>
        )}
      </>
    )
  }

  if (item.source === 'task') {
    return (
      <>
        <button type="button" className="btn-ghost !py-1 !text-xs" disabled={off} onClick={onComplete}>
          {busy ? 'Working…' : 'Mark complete'}
        </button>
        {/* Leads → Tasks keeps its tab in component state rather than the URL,
            so this can only land on the page, not on the row. Labelled for what
            it does rather than what it would be nice for it to do. */}
        <Link to="/app/leads" className={deepLink}>Open in Leads</Link>
      </>
    )
  }

  return (
    <>
      <button type="button" className="btn-ghost !py-1 !text-xs" disabled={off} onClick={onClear}>
        {busy ? 'Working…' : 'Mark done'}
      </button>
      {item.raw.message_id
        ? <Link to={`/app/inbox?tab=replies&thread=${item.raw.message_id}`} className={deepLink}>Open the conversation</Link>
        : <Link to="/app/inbox?tab=replies" className={deepLink}>Open in Inbox</Link>}
    </>
  )
}

// -------------------------------------------------------------- approve ------

// The email in full, because approving it is approving these words. Editing
// stays in the Inbox: this drawer is a decision, not a second composer, and a
// half-typed edit is the one thing a thirty-second poll must never touch.
function ReviewDrawer({ item, busy, error, onClose, onSend, onDecline }) {
  const d = item.raw
  const stopped = d.campaign_status && d.campaign_status !== 'running'

  return (
    <Drawer
      title={`Send this to ${item.who}?`}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-primary" disabled={busy || stopped} onClick={onSend}>
            {busy ? 'Sending…' : 'Send it'}
          </button>
          <Link to="/app/inbox?tab=approve" className="btn-ghost">Edit in the Inbox</Link>
          <button
            type="button"
            className="ml-auto cursor-pointer text-xs text-slate-500 hover:text-red-600"
            disabled={busy}
            onClick={onDecline}
          >
            Don&apos;t send
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          {item.context}
          {d.company ? ` · ${d.company}${d.title ? `, ${d.title}` : ''}` : ''}
          {` · ${item.atLabel}`}
        </p>

        {stopped && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
            “{item.context}” is {d.campaign_status}. Resume the campaign and this can go out; until then sending is off.
          </p>
        )}

        {d.last_reply && (
          <div className="rounded-lg border border-accent-600/30 bg-accent-500/10 p-3 text-sm text-slate-700">
            <div className="mb-1 text-xs text-accent-700">They said</div>
            <div className="whitespace-pre-wrap">{String(d.last_reply).slice(0, 800)}</div>
          </div>
        )}

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="font-medium text-ink-900">{d.subject}</div>
          <div className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{d.body}</div>
        </div>

        {d.thread_length > 0 && (
          <p className="text-[11px] text-slate-500">Message {d.thread_length + 1} in this thread.</p>
        )}

        {error && (
          <p className="text-xs text-red-700" role="alert">
            {error.field && <span className="text-red-600">{error.field}: </span>}
            {error.message}
          </p>
        )}
      </div>
    </Drawer>
  )
}
