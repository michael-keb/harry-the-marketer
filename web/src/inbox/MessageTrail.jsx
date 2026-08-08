// The email trail: every message in a conversation, oldest first.
//
// This is the thing the inbox exists to show. `GET /api/inbox/threads/:id`
// returns the whole `messages` array — both halves, the agent's emails and the
// lead's replies, in one ordered list — and the reading pane renders all of it
// rather than the last message with a count beside it.
//
// Two rules shape the markup.
//
// Who sent what is never carried by colour. Every message states it in words
// ("You sent this" / "They replied"), names the address it came from and the
// address it went to, and carries a shape — a solid left rule for outbound, a
// notched one for inbound — so the distinction survives a greyscale print and a
// colour-blind reader alike. The tint is the fourth signal, not the first.
//
// A long trail collapses. Only the newest message is open on arrival, because
// that is the one you came to read; older ones are one-line rows you can open,
// and anything beyond the first is folded behind a single "N earlier messages"
// button. Gmail's shape, and for Gmail's reason: a twelve-email thread is
// otherwise a page of scrolling before you reach what just arrived.

import { useState } from 'react'
import { Badge } from '../ui.jsx'
import { Marker, absolute, relative } from './common.jsx'

// Beyond this many older messages, everything after the first is folded away.
// Two is the point where the trail stops being a conversation you can take in
// at a glance.
const FOLD_AFTER = 2

const oneLine = (body) => String(body || '').replace(/\s+/g, ' ').trim()

const initials = (address) => {
  const name = String(address || '?').split('@')[0].replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  const parts = name.split(' ').filter(Boolean)
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase()
}

const directionWord = (m) => (m.direction === 'out' ? 'You sent this' : 'They replied')

// The accessible name of a message, so a screen reader moving through the trail
// hears who, to whom and when before it hears the body.
const describe = (m) => `${m.direction === 'out' ? 'Sent by you' : 'Reply from them'}, from ${m.from_email || 'an unknown address'}`
  + `${m.to_email ? ` to ${m.to_email}` : ''}, ${absolute(m.created_at)}`

export default function MessageTrail({ messages = [], renderExtras }) {
  // Which older messages the reader has opened, and whether the fold is undone.
  const [opened, setOpened] = useState(() => new Set())
  const [unfolded, setUnfolded] = useState(false)

  if (messages.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        This conversation has no messages stored yet.
      </p>
    )
  }

  const newest = messages[messages.length - 1]
  const older = messages.slice(0, -1)
  // The first message is always visible: it is where the conversation started,
  // and losing it is what makes a folded thread disorienting.
  const folded = !unfolded && older.length > FOLD_AFTER
  const hidden = folded ? older.slice(1) : []
  const shownOlder = folded ? older.slice(0, 1) : older

  const toggle = (id) => setOpened((set) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const row = (m) => (opened.has(m.id)
    ? <Message key={m.id} message={m} renderExtras={renderExtras} onCollapse={() => toggle(m.id)} />
    : <CollapsedMessage key={m.id} message={m} onExpand={() => toggle(m.id)} />)

  return (
    <ol className="space-y-2" aria-label={`Email trail, ${messages.length} message${messages.length === 1 ? '' : 's'}, oldest first`}>
      {shownOlder.map((m) => <li key={m.id}>{row(m)}</li>)}

      {folded && (
        <li>
          <button
            type="button"
            onClick={() => setUnfolded(true)}
            aria-expanded={false}
            className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-600 hover:border-slate-400 hover:text-ink-900"
          >
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700 tabular-nums">{hidden.length}</span>
            <span>earlier message{hidden.length === 1 ? '' : 's'} in this conversation — show {hidden.length === 1 ? 'it' : 'them'}</span>
          </button>
        </li>
      )}

      {/* The newest message is always open. It is what you came for. */}
      <li>
        <Message message={newest} renderExtras={renderExtras} newest />
      </li>
    </ol>
  )
}

// ------------------------------------------------------------- collapsed ----

function CollapsedMessage({ message: m, onExpand }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      aria-label={`${describe(m)}. Show this message.`}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:border-slate-300 hover:bg-slate-50"
    >
      <Avatar message={m} small />
      <span className="max-w-[8rem] shrink-0 truncate text-xs font-medium text-ink-900">
        {m.direction === 'out' ? 'You' : m.from_email}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{oneLine(m.body).slice(0, 160)}</span>
      <span className="shrink-0 text-[11px] text-slate-500" title={absolute(m.created_at)}>{relative(m.created_at)}</span>
    </button>
  )
}

// -------------------------------------------------------------- expanded ----

function Avatar({ message: m, small }) {
  const out = m.direction === 'out'
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center font-semibold ${small ? 'size-6 text-[10px]' : 'size-8 text-[11px]'} ${
        // Shape carries the direction as well as the tint: outbound is a
        // rounded square, inbound is a circle. Two signals, neither of them
        // colour on its own.
        out ? 'rounded-md bg-slate-200 text-slate-700' : 'rounded-full bg-accent-100 text-accent-700'
      }`}
    >
      {initials(out ? m.from_email : m.from_email)}
    </span>
  )
}

function Message({ message: m, renderExtras, onCollapse, newest }) {
  const out = m.direction === 'out'
  return (
    <article
      aria-label={describe(m)}
      className={`rounded-xl border bg-white ${
        // The left rule is thick and solid for what we sent, and thin over a
        // tinted panel for what came back. Remove every colour and the two are
        // still not the same object.
        out
          ? 'border-slate-200 border-l-4 border-l-slate-400'
          : 'border-accent-200 border-l-4 border-l-accent-500 bg-accent-50/40'
      }`}
    >
      {/* No wrapping in this row and `min-w-0` all the way down: a sender
          address long enough to fill the pane must truncate, not shove the
          timestamp out from under itself. */}
      <header className="flex items-start gap-2.5 px-3 pt-3">
        <Avatar message={m} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="max-w-full truncate text-sm font-semibold text-ink-950">{m.from_email || 'Unknown sender'}</span>
            <Marker tone={out ? 'plain' : 'good'}>{directionWord(m)}</Marker>
            {newest && <Marker>Latest</Marker>}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500">
            <span className="text-slate-400">To</span> {m.to_email || '—'}
            {m.subject ? <> · <span className="text-slate-400">Subject</span> {m.subject}</> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-2">
          <time className="text-[11px] text-slate-500" title={absolute(m.created_at)}>
            {relative(m.created_at)}
            <span className="sr-only"> — {absolute(m.created_at)}</span>
          </time>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-expanded
              className="cursor-pointer text-[11px] text-slate-500 underline hover:text-ink-900"
            >
              Hide
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1.5 text-[11px] text-slate-500">
        {m.node_id && m.node_id !== 'manual' && m.node_id !== 'forward' && <span className="font-mono">node {m.node_id}</span>}
        {m.manual_reply && <Marker>Manual reply</Marker>}
        {m.forwarded_to && <Marker>Forwarded to {m.forwarded_to}</Marker>}
        {m.intent && <Badge value={m.intent} />}
      </div>

      <div className="whitespace-pre-wrap px-3 py-2.5 text-[13.5px] leading-relaxed text-ink-900">{m.body}</div>

      {renderExtras && <div className="px-3 pb-3">{renderExtras(m)}</div>}
    </article>
  )
}
