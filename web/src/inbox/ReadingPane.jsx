// The right-hand pane: whatever the list is pointing at, read in full.
//
// It is always there. That is the whole difference from the drawer this
// replaces — a drawer is a thing you open and close over the list, a reading
// pane is where you read, and the list beside it is how you choose. Selecting a
// row changes what is in here and nothing else moves.
//
// One labelled region, three things it can hold: an email waiting for your OK,
// a conversation's full trail, or the sentence that says nothing is selected.

import { EmptyState } from '../ui.jsx'
import ThreadView from './ThreadPane.jsx'
import DraftPane from './DraftPane.jsx'

export default function ReadingPane({
  folder, threadId, draft, hint, refs, announce, onChanged, onBack, paneRef, className = '',
}) {
  const showing = folder === 'approve' ? draft : threadId

  return (
    <section
      ref={paneRef}
      // A named region, so a screen reader user can jump straight to what they
      // are reading rather than tabbing back through the list to find it.
      aria-label={label(folder, draft, hint)}
      className={`flex min-h-0 min-w-0 flex-col bg-white ${className}`}
    >
      {!showing && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            icon={folder === 'approve' ? 'check' : 'mail'}
            title={folder === 'approve' ? 'Pick an email to read' : 'Pick a conversation to read'}
            hint={folder === 'approve'
              ? 'Choose one on the left and it opens here, with the reply that prompted it and everything you can do about it.'
              : 'Choose one on the left and the whole trail opens here — every message, oldest first, both halves of the conversation.'}
          />
        </div>
      )}

      {folder === 'approve' && draft && (
        <DraftPane key={draft.id} draft={draft} onChanged={onChanged} onBack={onBack} announce={announce} />
      )}

      {folder !== 'approve' && threadId && (
        <ThreadView
          key={threadId}
          threadId={threadId}
          hint={hint}
          refs={refs}
          announce={announce}
          onChanged={onChanged}
          onBack={onBack}
        />
      )}
    </section>
  )
}

function label(folder, draft, hint) {
  if (folder === 'approve') {
    return draft ? `Reading pane — email to ${draft.lead_email || 'this lead'} waiting for your OK` : 'Reading pane — no email selected'
  }
  const who = hint?.lead ? [hint.lead.first_name, hint.lead.last_name].filter(Boolean).join(' ') || hint.lead.email : ''
  return who ? `Reading pane — conversation with ${who}` : 'Reading pane'
}
