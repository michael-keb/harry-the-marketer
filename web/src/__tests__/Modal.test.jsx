// Modal — the dialog contract, pinned.
//
// ui.jsx says it plainly: this component backs around forty call sites, so
// everything it fails to do it fails to do forty times. It has already been
// through one round of this — no dialog role, Escape inert, focus never
// entering, the page behind still in the tab order — and those were fixed by
// hand and confirmed in a browser. A hand-confirmed fix with no test is a fix
// with an expiry date, so each of those four failures gets an assertion here.
//
// Note on the environment: jsdom has no layout, so the trap's
// `offsetParent !== null` visibility filter is shimmed in __tests__/setup.js.
// Without that shim the trap finds zero focusable candidates and bails out, and
// these tests would pass for the wrong reason.

import { describe, it, expect, vi } from 'vitest'
import { useCallback, useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Modal } from '../ui.jsx'

// A realistic host: something to return focus to, and something behind the
// overlay that a leaking tab order would reach.
function Host({ onClose }) {
  const [open, setOpen] = useState(false)
  const close = () => { setOpen(false); onClose?.() }
  return (
    <>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      <input aria-label="Behind the overlay" />
      {open && (
        <Modal title="Rename campaign" onClose={close}>
          <input aria-label="Name" defaultValue="Acme outreach" />
          <button>Save</button>
        </Modal>
      )}
    </>
  )
}

// Open the dialog the way a person does: focus the trigger, then click it. The
// focus matters — it is what "returns to the opener" is measured against.
function open(onClose) {
  render(<Host onClose={onClose} />)
  const trigger = screen.getByRole('button', { name: 'Open dialog' })
  act(() => { trigger.focus() })
  fireEvent.click(trigger)
  return { trigger, dialog: screen.getByRole('dialog') }
}

describe('Modal — announced as a dialog', () => {
  it('is a modal dialog labelled by its own title', () => {
    const { dialog } = open()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // The label comes from the heading rather than a hand-written aria-label,
    // so the visible title and the announced one cannot drift apart.
    const titleId = dialog.getAttribute('aria-labelledby')
    expect(titleId).toBeTruthy()
    expect(document.getElementById(titleId)).toHaveTextContent('Rename campaign')
    expect(screen.getByRole('dialog', { name: 'Rename campaign' })).toBe(dialog)
  })
})

describe('Modal — dismissal', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn()
    open(onClose)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on Escape pressed from a control inside it', () => {
    // The listener is registered in the capture phase precisely so a field
    // inside the dialog cannot eat the key on its way up.
    const onClose = vi.fn()
    open(onClose)
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a click on the backdrop but not on the panel', () => {
    const onClose = vi.fn()
    const { dialog } = open(onClose)
    fireEvent.mouseDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(dialog.parentElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('Modal — focus', () => {
  it('moves focus inside on open', () => {
    // A screen reader has to start reading here rather than wherever it was.
    // The first focusable in DOM order is the header Close button, so that is
    // what receives focus — the assertion is containment, because *which*
    // control is a layout detail and "inside" is the actual promise.
    const { dialog } = open()
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('returns focus to whatever opened it', () => {
    // Otherwise focus falls back to <body> and a keyboard user restarts their
    // tab journey at the top of the page every time they close a dialog.
    const { trigger } = open()
    expect(document.activeElement).not.toBe(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  it('wraps Tab from the last control back to the first', () => {
    open()
    const save = screen.getByRole('button', { name: 'Save' })
    const close = screen.getByRole('button', { name: 'Close' })
    act(() => { save.focus() })
    fireEvent.keyDown(save, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
  })

  it('wraps Shift+Tab from the first control back to the last', () => {
    open()
    const save = screen.getByRole('button', { name: 'Save' })
    const close = screen.getByRole('button', { name: 'Close' })
    act(() => { close.focus() })
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
  })

  it('leaves Tab alone in the middle of the dialog', () => {
    // The trap only intervenes at the two edges; anywhere else the browser's
    // own ordering must be left to do its job.
    open()
    const name = screen.getByLabelText('Name')
    act(() => { name.focus() })
    const event = fireEvent.keyDown(name, { key: 'Tab' })
    expect(event).toBe(true) // not preventDefault()ed
    expect(document.activeElement).toBe(name)
  })

  it('holds focus still across a re-render when onClose is stable', () => {
    // The control case for the defect below. With a `useCallback`-stable
    // onClose the effect does not re-run, and focus stays where the reader put
    // it — which is what isolates the cause to the dependency array rather
    // than to the focusing itself.
    function StableHost() {
      const [n, setN] = useState(0)
      const close = useCallback(() => {}, [])
      return (
        <>
          <button onClick={() => setN((v) => v + 1)}>Bump {n}</button>
          <Modal title="Rename campaign" onClose={close}>
            <input aria-label="Name" />
          </Modal>
        </>
      )
    }
    render(<StableHost />)
    const name = screen.getByLabelText('Name')
    act(() => { name.focus() })
    fireEvent.click(screen.getByRole('button', { name: /Bump/ }))
    expect(document.activeElement).toBe(name)
  })

  // KNOWN DEFECT — ui.jsx:113/148. The focus-and-trap effect lists `onClose` as
  // a dependency, and the overwhelming majority of the ~40 call sites pass a
  // freshly-created arrow (`onClose={() => setGenerating(false)}`). A new
  // identity every render means the effect tears down and sets up every render,
  // and setup ends with `(first || panel).focus()` — so focus is dragged back
  // to the header Close button on any re-render while the dialog is open.
  //
  // The user-visible symptom, e.g. at web/src/pages/CampaignDetail.jsx:533:
  // that Modal holds a controlled <textarea> whose state lives in the parent,
  // so typing one character re-renders the parent, re-runs the effect, and
  // takes focus away. You can type exactly one character into the AI brief.
  //
  // FIXED: `onClose` is now held in a ref and the effect is mount-only, so a
  // parent re-render no longer re-runs the focus logic. Kept as a regression
  // test — restoring `[onClose]` to the dependency array makes this red again.
  it('keeps focus where the user put it when the parent re-renders', () => {
    function UnstableHost() {
      const [n, setN] = useState(0)
      return (
        <>
          <button onClick={() => setN((v) => v + 1)}>Bump {n}</button>
          {/* exactly what the real call sites do */}
          <Modal title="Rename campaign" onClose={() => {}}>
            <input aria-label="Name" />
          </Modal>
        </>
      )
    }
    render(<UnstableHost />)
    const name = screen.getByLabelText('Name')
    act(() => { name.focus() })
    fireEvent.click(screen.getByRole('button', { name: /Bump/ }))
    expect(document.activeElement).toBe(name)
  })

  it('never hands focus to a control behind the overlay', () => {
    // The regression this whole trap exists for: tabbing out of a modal, acting
    // on the page it is covering, and having no way back.
    open()
    const behind = screen.getByLabelText('Behind the overlay')
    const save = screen.getByRole('button', { name: 'Save' })
    act(() => { save.focus() })
    fireEvent.keyDown(save, { key: 'Tab' })
    expect(document.activeElement).not.toBe(behind)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })
})
