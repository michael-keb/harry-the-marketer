// Undo — the reversal a confirm dialog cannot give you.
//
// "Are you sure?" in front of a reversible bulk action buys nothing: it is
// clicked through, it does not tell you what 500 leads are about to look like,
// and it still leaves you stranded the one time you were wrong. An undo toast
// is the better trade — the work happens now, and for eight seconds you can put
// it back.
//
// The one rule this file will not bend: `perform` runs immediately. A queued
// action that has not happened yet, sitting behind a countdown, is a worse lie
// than offering no undo at all — the list has already redrawn, the numbers
// already moved, and the server has not been told. So: perform, then offer.
//
// Reverting reports the truth. If `revert` throws, the toast says the undo
// failed and stays on screen; it never quietly disappears having done nothing.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

const UndoCtx = createContext(null)

const DEFAULT_MS = 8000
const TICK_MS = 200
// How long "Undone" stays up after a successful revert, so the outcome is read
// rather than inferred from the toast vanishing.
const SETTLED_MS = 2000

let counter = 0
const nextId = () => `undo-${++counter}-${Date.now().toString(36)}`

export function UndoProvider({ children }) {
  const [entries, setEntries] = useState([])
  // The countdown reads and writes the same rows the render does, so the
  // interval works off a ref and pushes to state — otherwise every tick would
  // need `entries` in its dependency list and restart the timer.
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  const patch = useCallback((id, changes) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...changes } : e)))
  }, [])

  const dismiss = useCallback((id) => {
    setEntries((prev) => prev.filter((e) => e.id !== id))
  }, [])

  // One timer for the whole stack. It only exists while something is counting,
  // so an idle app has no interval running at all.
  const counting = entries.some((e) => e.state === 'live' && !e.paused)
  useEffect(() => {
    if (!counting) return undefined
    const timer = setInterval(() => {
      setEntries((prev) => {
        let changed = false
        const next = prev.map((e) => {
          if (e.state !== 'live' || e.paused) return e
          changed = true
          return { ...e, remaining: Math.max(0, e.remaining - TICK_MS) }
        })
        if (!changed) return prev
        // Expiry is the same event as dismissal: the window closed, the action
        // stands. Nothing is committed here because nothing was deferred.
        return next.filter((e) => !(e.state === 'live' && e.remaining <= 0))
      })
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [counting])

  const revertEntry = useCallback(async (id) => {
    const entry = entriesRef.current.find((e) => e.id === id)
    if (!entry || entry.state === 'reverting' || entry.state === 'reverted') return
    patch(id, { state: 'reverting', error: null })
    try {
      await entry.revert()
      patch(id, { state: 'reverted' })
      setTimeout(() => dismiss(id), SETTLED_MS)
    } catch (err) {
      // Failed is a terminal-ish state with a retry, not a disappearance. The
      // countdown is over by definition — the toast now waits for a decision.
      patch(id, { state: 'failed', error: err?.message || String(err) })
    }
  }, [dismiss, patch])

  const run = useCallback(async ({ label, perform, revert, duration = DEFAULT_MS, undoLabel = 'Undo' }) => {
    if (typeof perform !== 'function' || typeof revert !== 'function') {
      throw new TypeError('undo.run needs both perform and revert')
    }
    // Deliberately not caught: the write failing is the caller's story to tell,
    // in the caller's own error surface. There is nothing to undo.
    const result = await perform()
    const id = nextId()
    setEntries((prev) => [...prev, {
      id,
      label,
      revert,
      undoLabel,
      duration,
      remaining: duration,
      paused: false,
      state: 'live',
      error: null,
    }])
    return result
  }, [])

  // Returned as a callable with `.run` on it, so both `undo.run({…})` and
  // `undo({…})` work and nobody has to remember which.
  const value = useMemo(() => {
    const fn = (options) => run(options)
    fn.run = run
    fn.dismiss = dismiss
    return fn
  }, [run, dismiss])

  // Reaching the Undo button by Tab means crossing the whole page first, which
  // is exactly the hunting the shortcut exists to avoid. Ctrl/⌘+Z reverts the
  // newest live action — and stands aside whenever a text field has focus, so
  // it never eats a real editing undo.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'z' && event.key !== 'Z') return
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      const el = event.target
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      const newest = [...entriesRef.current].reverse().find((e) => e.state === 'live')
      if (!newest) return
      event.preventDefault()
      revertEntry(newest.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [revertEntry])

  return (
    <UndoCtx.Provider value={value}>
      {children}
      {/* ui.jsx already owns bottom-right at z-50 and the BulkBar sits centred
          at the bottom of the content column, so the undo stack takes the left
          edge — clear of the sidebar on md and up, and lifted above the bulk
          bar on small screens. */}
      <div className="pointer-events-none fixed bottom-20 left-4 right-4 z-50 flex flex-col gap-2 md:bottom-4 md:left-60 md:right-auto md:w-80">
        {entries.map((entry) => (
          <UndoToast
            key={entry.id}
            entry={entry}
            onUndo={() => revertEntry(entry.id)}
            onDismiss={() => dismiss(entry.id)}
            onPause={(paused) => patch(entry.id, { paused })}
          />
        ))}
      </div>
    </UndoCtx.Provider>
  )
}

export function useUndo() {
  const ctx = useContext(UndoCtx)
  if (!ctx) throw new Error('useUndo must be used inside <UndoProvider>')
  return ctx
}

// ------------------------------------------------------------------ toast ----

function UndoToast({ entry, onUndo, onDismiss, onPause }) {
  const { label, remaining, duration, state, error, undoLabel, paused } = entry
  const seconds = Math.ceil(remaining / 1000)
  const pct = duration > 0 ? Math.max(0, Math.min(100, (remaining / duration) * 100)) : 0
  const live = state === 'live'

  return (
    <div
      role="status"
      aria-live="polite"
      className={`card pointer-events-auto overflow-hidden border-l-4 px-4 py-3 text-sm shadow-xl ${
        state === 'failed' ? 'border-l-red-500' : state === 'reverted' ? 'border-l-emerald-500' : 'border-l-accent-500'
      }`}
      // Hover and focus both hold the clock: someone reaching for the button
      // with a trackpad and someone reaching for it with Tab are doing the same
      // thing, and neither should lose the window on the way.
      onMouseEnter={() => live && onPause(true)}
      onMouseLeave={() => live && onPause(false)}
      onFocus={() => live && onPause(true)}
      onBlur={(e) => live && !e.currentTarget.contains(e.relatedTarget) && onPause(false)}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-ink-900">{label}</div>
          {state === 'failed' && (
            <div className="mt-1 text-xs text-red-700">Undo failed — {error}. Nothing was changed back.</div>
          )}
          {state === 'reverted' && <div className="mt-1 text-xs text-emerald-700">Undone.</div>}
          {state === 'reverting' && <div className="mt-1 text-xs text-slate-600">Undoing…</div>}
        </div>

        {(state === 'live' || state === 'failed') && (
          <button
            type="button"
            onClick={onUndo}
            className="btn-ghost shrink-0 px-2.5 py-1 text-xs"
          >
            {state === 'failed' ? 'Try again' : undoLabel}
          </button>
        )}
        {state !== 'live' && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 cursor-pointer text-lg leading-none text-slate-500 hover:text-slate-700"
          >
            ×
          </button>
        )}
      </div>

      {live && (
        <div className="mt-2 flex items-center gap-2">
          {/* The number is the countdown; the bar only repeats it. Nothing here
              depends on seeing the bar, or on telling its colour apart. */}
          <span className="shrink-0 text-[11px] tabular-nums text-slate-600">
            {paused ? 'Paused' : `${seconds}s left`}
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-200" aria-hidden>
            <div
              className="h-full rounded-full bg-accent-500 transition-[width] duration-200 ease-linear"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
