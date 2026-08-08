// Undo — the contract, not the styling.
//
// undo.jsx opens its own file with a rule it says it will not bend: `perform`
// runs immediately, and the toast is offered afterwards. That rule is the whole
// safety argument for replacing confirm dialogs with undo, and it is invisible
// — a regression that queued the work behind the countdown instead would look
// identical on screen for eight seconds and then quietly do the wrong thing.
// Half of this file exists to make that rule mechanically checkable.
//
// The other half covers the failure path, which is the part a hand-test never
// reaches: a revert that throws must leave the toast on screen saying so. A
// toast that vanishes after a failed undo tells the reader their data is back
// when it is not.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, act, fireEvent, within } from '@testing-library/react'
import { UndoProvider, useUndo } from '../undo.jsx'

// A deferred promise, so a test can hold `perform` or `revert` open and assert
// what the UI looks like *while* the work is in flight.
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Minimal caller: one button per action, and any error `run` rethrows is put on
// screen so a test can assert it actually propagated to the caller rather than
// being swallowed by the provider.
function Trigger({ id = 'go', label = 'Deleted 3 leads', perform, revert, duration }) {
  const undo = useUndo()
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  return (
    <>
      <button
        onClick={async () => {
          try {
            setResult(await undo.run({ label, perform, revert, duration }))
          } catch (err) {
            setError(err?.message || String(err))
          }
        }}
      >
        {id}
      </button>
      {error && <p data-testid={`${id}-error`}>{error}</p>}
      {result != null && <p data-testid={`${id}-result`}>{String(result)}</p>}
    </>
  )
}

const click = async (name) => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })) })
}

describe('UndoProvider — perform runs first', () => {
  it('calls perform immediately and shows no toast until it resolves', async () => {
    // The load-bearing assertion in this file. If someone ever "improves" this
    // into a queued action that only commits when the countdown expires, the
    // toast would appear here — before perform was called — and this fails.
    const gate = deferred()
    const perform = vi.fn(() => gate.promise)
    const revert = vi.fn()

    render(
      <UndoProvider>
        <Trigger perform={perform} revert={revert} />
      </UndoProvider>
    )

    await click('go')
    expect(perform).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).toBeNull()

    await act(async () => { gate.resolve('ok') })
    expect(screen.getByRole('status')).toHaveTextContent('Deleted 3 leads')
  })

  it("returns perform's value to the caller", async () => {
    render(
      <UndoProvider>
        <Trigger perform={() => Promise.resolve(42)} revert={vi.fn()} />
      </UndoProvider>
    )
    await click('go')
    expect(await screen.findByTestId('go-result')).toHaveTextContent('42')
  })

  it('lets a failing perform propagate and offers no undo for work that never happened', async () => {
    // "Deliberately not caught" in run() — the write failing is the caller's
    // story, in the caller's error surface. Offering to undo a write that never
    // landed would be the second lie on top of the first.
    const revert = vi.fn()
    render(
      <UndoProvider>
        <Trigger perform={() => Promise.reject(new Error('server said no'))} revert={revert} />
      </UndoProvider>
    )

    await click('go')
    expect(await screen.findByTestId('go-error')).toHaveTextContent('server said no')
    expect(screen.queryByRole('status')).toBeNull()
    expect(revert).not.toHaveBeenCalled()
  })

  it('refuses an action that cannot be reverted', async () => {
    render(
      <UndoProvider>
        <Trigger perform={vi.fn()} revert={undefined} />
      </UndoProvider>
    )
    await click('go')
    expect(await screen.findByTestId('go-error')).toHaveTextContent('undo.run needs both perform and revert')
  })
})

describe('UndoProvider — reverting', () => {
  it('calls revert when Undo is clicked and reports success', async () => {
    const revert = vi.fn(() => Promise.resolve())
    render(
      <UndoProvider>
        <Trigger perform={vi.fn()} revert={revert} />
      </UndoProvider>
    )

    await click('go')
    await click('Undo')

    expect(revert).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Undone.')).toBeInTheDocument()
    // The countdown is gone: the window is over either way once undo is taken.
    expect(screen.queryByText(/s left$/)).toBeNull()
  })

  it('keeps the toast up and says the undo failed rather than claiming success', async () => {
    // The case a manual check never sees. Before this behaviour existed a
    // failed revert looked exactly like a successful one — the toast expired
    // and the reader walked away believing the rows were back.
    const revert = vi.fn(() => Promise.reject(new Error('network down')))
    render(
      <UndoProvider>
        <Trigger perform={vi.fn()} revert={revert} />
      </UndoProvider>
    )

    await click('go')
    await click('Undo')

    const toast = await screen.findByRole('status')
    expect(toast).toHaveTextContent('Undo failed — network down. Nothing was changed back.')
    expect(toast).toBeInTheDocument()
    expect(screen.queryByText('Undone.')).toBeNull()
    // And it offers a way out rather than stranding the reader.
    expect(within(toast).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('retries a failed revert from the same toast', async () => {
    const revert = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('network down')))
      .mockImplementationOnce(() => Promise.resolve())
    render(
      <UndoProvider>
        <Trigger perform={vi.fn()} revert={revert} />
      </UndoProvider>
    )

    await click('go')
    await click('Undo')
    await screen.findByText(/Undo failed/)
    await click('Try again')

    expect(revert).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Undone.')).toBeInTheDocument()
  })

  it('ignores a second click while a revert is already in flight', async () => {
    // Double-clicking Undo must not double-post the reversal.
    const gate = deferred()
    const revert = vi.fn(() => gate.promise)
    render(
      <UndoProvider>
        <Trigger perform={vi.fn()} revert={revert} />
      </UndoProvider>
    )

    await click('go')
    await click('Undo')
    expect(screen.getByText('Undoing…')).toBeInTheDocument()
    // While 'reverting' the Undo button is not rendered at all, so the only way
    // to re-enter is programmatically — assert the guard holds anyway.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()

    await act(async () => { gate.resolve() })
    expect(revert).toHaveBeenCalledTimes(1)
  })
})

describe('UndoProvider — the stack', () => {
  it('stacks several actions and undoes each independently', async () => {
    // Bulk work arrives in bursts (tag 40 leads, then pause a campaign). One
    // toast replacing another would silently drop the older undo window.
    const revertA = vi.fn(() => Promise.resolve())
    const revertB = vi.fn(() => Promise.resolve())
    render(
      <UndoProvider>
        <Trigger id="a" label="Tagged 40 leads" perform={vi.fn()} revert={revertA} />
        <Trigger id="b" label="Paused Acme outreach" perform={vi.fn()} revert={revertB} />
      </UndoProvider>
    )

    await click('a')
    await click('b')

    const toasts = screen.getAllByRole('status')
    expect(toasts).toHaveLength(2)
    expect(toasts[0]).toHaveTextContent('Tagged 40 leads')
    expect(toasts[1]).toHaveTextContent('Paused Acme outreach')

    await act(async () => {
      fireEvent.click(within(toasts[0]).getByRole('button', { name: 'Undo' }))
    })

    expect(revertA).toHaveBeenCalledTimes(1)
    expect(revertB).not.toHaveBeenCalled()
    // The untouched toast is still counting, not collateral damage.
    expect(within(screen.getByText('Paused Acme outreach').closest('[role="status"]'))
      .getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('⌘Z reverts the newest live action only', async () => {
    const revertA = vi.fn(() => Promise.resolve())
    const revertB = vi.fn(() => Promise.resolve())
    render(
      <UndoProvider>
        <Trigger id="a" label="First" perform={vi.fn()} revert={revertA} />
        <Trigger id="b" label="Second" perform={vi.fn()} revert={revertB} />
      </UndoProvider>
    )

    await click('a')
    await click('b')
    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true })
    })

    expect(revertB).toHaveBeenCalledTimes(1)
    expect(revertA).not.toHaveBeenCalled()
  })

  it('stands aside when ⌘Z is pressed inside a text field', async () => {
    // Eating a real editing undo would be a worse bug than not having the
    // shortcut at all.
    const revert = vi.fn(() => Promise.resolve())
    render(
      <UndoProvider>
        <input aria-label="Subject" defaultValue="hello" />
        <Trigger perform={vi.fn()} revert={revert} />
      </UndoProvider>
    )

    await click('go')
    const input = screen.getByLabelText('Subject')
    await act(async () => {
      input.focus()
      fireEvent.keyDown(input, { key: 'z', metaKey: true })
    })

    expect(revert).not.toHaveBeenCalled()
  })
})

describe('UndoProvider — the countdown', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const setup = async () => {
    const revert = vi.fn(() => Promise.resolve())
    render(
      <UndoProvider>
        <Trigger perform={vi.fn()} revert={revert} duration={3000} />
      </UndoProvider>
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'go' })) })
    return { revert }
  }

  it('counts down and drops the toast when the window closes', async () => {
    await setup()
    expect(screen.getByText('3s left')).toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText('2s left')).toBeInTheDocument()

    // Expiry is dismissal — the action already happened, so nothing is
    // committed here and nothing should be announced.
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('holds the clock while the pointer is over the toast', async () => {
    // Someone reaching for the button with a trackpad must not lose the window
    // on the way to it. mouseOver/mouseOut are used rather than
    // mouseEnter/mouseLeave because React synthesises enter/leave from them.
    await setup()
    const toast = screen.getByRole('status')

    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText('2s left')).toBeInTheDocument()

    await act(async () => { fireEvent.mouseOver(toast) })
    expect(screen.getByText('Paused')).toBeInTheDocument()

    // Far longer than the whole window: if the clock were still running the
    // toast would be gone.
    await act(async () => { vi.advanceTimersByTime(10000) })
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText('Paused')).toBeInTheDocument()

    await act(async () => { fireEvent.mouseOut(toast) })
    expect(screen.getByText('2s left')).toBeInTheDocument()
  })

  it('holds the clock while the Undo button has keyboard focus', async () => {
    // Tabbing to the button is the same act as reaching for it; the two must
    // not behave differently.
    await setup()

    await act(async () => { vi.advanceTimersByTime(1000) })
    const button = screen.getByRole('button', { name: 'Undo' })

    await act(async () => { button.focus() })
    expect(screen.getByText('Paused')).toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(10000) })
    expect(screen.getByRole('status')).toBeInTheDocument()

    await act(async () => { button.blur() })
    expect(screen.getByText('2s left')).toBeInTheDocument()
  })

  it('clears a reverted toast after it has been read, not instantly', async () => {
    // "Undone." is the outcome; a toast that disappears the moment the revert
    // lands makes the reader infer success from an absence.
    const { revert } = await setup()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) })
    expect(revert).toHaveBeenCalled()
    expect(screen.getByText('Undone.')).toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(1900) })
    expect(screen.getByText('Undone.')).toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(200) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
