// Conversation board — the same derived stages the table already shows,
// laid out left-to-right so you can see where each thread actually is.
//
// Columns are not draggable. Stage is read off messages, signed agreements
// and campaign outcomes (server/stages.js); a drop that wrote a column would
// lie the next time a reply landed. Harry tags the inbound itself: classify
// writes intent on the message, and the board just reads that.

import { useMemo, useState } from 'react'
import { Badge, EmptyState, timeAgo } from '../ui.jsx'

const PROGRESS = ['not contacted', 'contacted', 'replied', 'interested', 'agreed', 'won']
const TERMINAL = ['lost', 'unsubscribed', 'bounced']

function displayName(lead) {
  return [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email
}

export default function Board({ leads, onOpenLead }) {
  const [query, setQuery] = useState('')
  // Default is conversations: the board exists because a message arrived.
  // "Everyone" is the same columns with people who have not replied yet.
  const [conversationsOnly, setConversationsOnly] = useState(true)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (leads || []).filter((l) => {
      if (conversationsOnly && !l.lastInbound) return false
      if (!q) return true
      return [l.email, l.first_name, l.last_name, l.company, l.title, l.lastInbound?.snippet]
        .join(' ').toLowerCase().includes(q)
    })
  }, [leads, query, conversationsOnly])

  const grouped = useMemo(() => {
    const buckets = Object.fromEntries([...PROGRESS, ...TERMINAL].map((k) => [k, []]))
    for (const lead of shown) {
      const key = buckets[lead.stage] ? lead.stage : 'replied'
      buckets[key].push(lead)
    }
    return buckets
  }, [shown])

  const columns = [
    ...(conversationsOnly
      ? PROGRESS.filter((k) => grouped[k].length > 0)
      : PROGRESS),
    ...TERMINAL.filter((k) => grouped[k].length > 0),
  ]

  if (!leads?.length) {
    return (
      <EmptyState
        title="No leads yet"
        hint="Add people, run a campaign, and when a reply lands Harry reads it and puts the conversation on this board."
      />
    )
  }

  if (shown.length === 0) {
    return (
      <div className="space-y-4">
        <BoardToolbar
          query={query}
          onQuery={setQuery}
          conversationsOnly={conversationsOnly}
          onConversationsOnly={setConversationsOnly}
          count={0}
        />
        <EmptyState
          title={conversationsOnly ? 'No conversations yet' : 'No matches'}
          hint={conversationsOnly
            ? 'When someone replies, Harry reads the message, tags where the conversation is, and the card appears here.'
            : (query ? `Nothing matches “${query}”.` : 'Nobody is on the board right now.')}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <BoardToolbar
        query={query}
        onQuery={setQuery}
        conversationsOnly={conversationsOnly}
        onConversationsOnly={setConversationsOnly}
        count={shown.length}
      />
      <p className="text-xs text-slate-500">
        Columns move when a reply lands. Harry reads the message and tags the conversation — the stage is never set by hand.
      </p>
      <div className="overflow-x-auto pb-2" role="region" aria-label="Conversation board">
        <div className="flex min-w-min gap-3">
          {columns.map((stage) => (
            <section
              key={stage}
              aria-labelledby={`board-col-${stage.replace(/\s+/g, '-')}`}
              className="flex w-64 shrink-0 flex-col rounded-xl border border-slate-200 bg-slate-50/80"
            >
              <header className="flex items-baseline justify-between gap-2 px-3 py-2.5">
                <h2
                  id={`board-col-${stage.replace(/\s+/g, '-')}`}
                  className="text-xs font-semibold capitalize text-ink-900"
                >
                  {stage}
                </h2>
                <span className="tabular-nums text-[11px] text-slate-500">{grouped[stage].length}</span>
              </header>
              <ul className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto px-2 pb-3">
                {grouped[stage].length === 0 ? (
                  <li className="px-1 py-6 text-center text-[11px] text-slate-400">Nobody here</li>
                ) : grouped[stage].map((lead) => (
                  <li key={lead.id}>
                    <button
                      type="button"
                      onClick={() => onOpenLead(lead.id)}
                      className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white p-3 text-left shadow-sm transition-colors hover:border-accent-400 hover:bg-accent-50/40"
                    >
                      <div className="truncate text-sm font-medium text-ink-900">{displayName(lead)}</div>
                      {lead.company ? (
                        <div className="mt-0.5 truncate text-[11px] text-slate-500">{lead.company}</div>
                      ) : (
                        <div className="mt-0.5 truncate text-[11px] text-slate-400">{lead.email}</div>
                      )}
                      {lead.lastInbound?.snippet && (
                        <p className="mt-2 line-clamp-3 text-[12px] leading-snug text-slate-600">
                          {lead.lastInbound.snippet}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {lead.lastInbound?.intent ? <Badge value={lead.lastInbound.intent} /> : null}
                        {lead.lastInbound?.createdAt ? (
                          <span className="text-[11px] text-slate-400">{timeAgo(lead.lastInbound.createdAt)}</span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

function BoardToolbar({ query, onQuery, conversationsOnly, onConversationsOnly, count }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="board-search">Search the board</label>
      <input
        id="board-search"
        className="input w-full sm:w-56"
        placeholder="Search the board…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <button
        type="button"
        aria-pressed={conversationsOnly}
        onClick={() => onConversationsOnly(!conversationsOnly)}
        className={`cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors ${
          conversationsOnly
            ? 'border-accent-500 bg-accent-500/10 text-accent-700'
            : 'border-slate-300 text-slate-600 hover:border-slate-400'
        }`}
      >
        Conversations
      </button>
      <span className="text-xs text-slate-500 tabular-nums">{count} {count === 1 ? 'card' : 'cards'}</span>
    </div>
  )
}
