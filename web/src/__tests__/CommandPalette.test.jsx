// CommandPalette — keyboard contract and the stale-response guard.
//
// Two very different risks live in this component.
//
// The first is keyboard navigation. The palette is a combobox driving a
// listbox: the input keeps focus the whole time and `aria-activedescendant` is
// the *only* thing that tells a screen reader which row is current. Nothing
// about that is visible in a browser — the highlight moving looks correct while
// the attribute stays stale — so it is exactly the kind of thing that is either
// tested or broken.
//
// The second is the sequence guard. Eight sources are searched in parallel on
// every keystroke; the moment one of them is slower than the debounce, an
// answer for a query the reader has already moved past can land last and win.
// The result is a palette that shows results for something you are no longer
// typing, which reads as the search being wrong rather than late. It is
// unreproducible by hand and trivial to reproduce here.
//
// All eight sources go through api.js, which uses global fetch and nothing
// else, so a single stub isolates the whole component.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import CommandPalette from '../CommandPalette.jsx'
import { stubFetch, deferred } from './helpers.js'

function Where() {
  const loc = useLocation()
  return <p data-testid="location">{loc.pathname + loc.search}</p>
}

function open(props = {}) {
  const onClose = vi.fn()
  const view = render(
    <MemoryRouter initialEntries={['/app']}>
      <CommandPalette open onClose={onClose} {...props} />
      <Where />
    </MemoryRouter>
  )
  return { ...view, onClose, input: screen.getByRole('combobox') }
}

// Quiet by default: every test stubs fetch so nothing can escape to the
// network, and the tests that care about responses override the handler.
beforeEach(() => { stubFetch(async () => ({ items: [] })) })

describe('CommandPalette — is useful before anything is typed', () => {
  it('lists the navigation commands with no query and no request', async () => {
    const { calls } = stubFetch(async () => ({ items: [] }))
    open()
    expect(screen.getAllByRole('option').length).toBeGreaterThan(5)
    expect(screen.getByRole('option', { name: /Go to Dashboard/ })).toBeInTheDocument()
    // An empty query must not fan out eight requests just for being open.
    expect(calls).toHaveLength(0)
  })
})

describe('CommandPalette — arrow keys drive aria-activedescendant', () => {
  it('starts on the first row', () => {
    const { input } = open()
    const options = screen.getAllByRole('option')
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('moves down and up, and the attribute follows the highlight', () => {
    const { input } = open()
    const options = screen.getAllByRole('option')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
  })

  it('wraps at both ends rather than dead-ending', () => {
    const { input } = open()
    const options = screen.getAllByRole('option')
    const last = options[options.length - 1]

    // Up from the top lands on the bottom…
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveAttribute('aria-activedescendant', last.id)
    // …and down from the bottom comes back to the top.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
  })

  it('Home and End jump to the ends', () => {
    const { input } = open()
    const options = screen.getAllByRole('option')
    fireEvent.keyDown(input, { key: 'End' })
    expect(input).toHaveAttribute('aria-activedescendant', options[options.length - 1].id)
    fireEvent.keyDown(input, { key: 'Home' })
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
  })

  it('points aria-activedescendant at a row that actually exists', () => {
    // A dangling id is worse than none: the screen reader announces nothing and
    // the reader gets silence instead of a row.
    const { input } = open()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const id = input.getAttribute('aria-activedescendant')
    expect(document.getElementById(id)).toHaveAttribute('role', 'option')
  })

  it('opens the row the arrows landed on, not the one the mouse last touched', async () => {
    const { input, onClose } = open()
    // Walk to a known destination rather than assuming a position, so the test
    // survives someone reordering NAV_COMMANDS. Getting there at all is itself
    // the assertion that the arrows and aria-activedescendant stay in step.
    const activeLabel = () =>
      document.getElementById(input.getAttribute('aria-activedescendant'))?.textContent
    for (let i = 0; i < 40 && activeLabel() !== 'Go to Leads'; i++) {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    }
    expect(activeLabel()).toBe('Go to Leads')

    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(onClose).toHaveBeenCalled()
    // Navigation actually happened — the palette is a router, not a menu that
    // merely looks like one.
    expect(screen.getByTestId('location')).toHaveTextContent('/app/leads')
  })
})

describe('CommandPalette — dismissal', () => {
  it('closes on Escape', () => {
    const { input, onClose } = open()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a click on the backdrop but not inside the dialog', () => {
    const { onClose } = open()
    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(dialog.parentElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('is a labelled modal dialog', () => {
    open()
    const dialog = screen.getByRole('dialog', { name: 'Search everything' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })
})

describe('CommandPalette — the sequence guard', () => {
  it('drops a slow answer for a query the reader has already moved past', async () => {
    // The bug this encodes: type "ac", the leads route takes a second, type
    // "acm" and get the right answers, then the "ac" answer lands and replaces
    // them. Nothing errors; the palette just shows the wrong list.
    const slow = deferred()
    const dispatched = new Set()

    stubFetch(async ({ path, params }) => {
      const q = params.get('q')
      // The three no-`q` sources (clients, both label kinds) are fetched once
      // per open and cached — they are not part of this race.
      if (!q) return { items: [] }
      dispatched.add(q)
      if (q === 'ac') {
        await slow.promise
        return path === '/api/leads' ? [{ id: 1, first_name: 'Stale', last_name: 'Answer' }] : { items: [] }
      }
      return path === '/api/leads' ? [{ id: 2, first_name: 'Fresh', last_name: 'Answer' }] : { items: [] }
    })

    const { input } = open()

    fireEvent.change(input, { target: { value: 'ac' } })
    // Wait for the first batch to genuinely be in flight — otherwise the
    // debounce alone would cancel it and the guard would never be exercised.
    await waitFor(() => expect(dispatched.has('ac')).toBe(true))

    fireEvent.change(input, { target: { value: 'acm' } })
    expect(await screen.findByText('Fresh Answer')).toBeInTheDocument()

    // Now let the older request finish. It must be discarded on arrival.
    await act(async () => {
      slow.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(screen.queryByText('Stale Answer')).toBeNull()
    expect(screen.getByText('Fresh Answer')).toBeInTheDocument()
    expect(input).toHaveValue('acm')
  })
})

describe('CommandPalette — partial failure is admitted, not hidden', () => {
  it('says how many sources could not be searched', async () => {
    // A source that fails quietly turns "your mailbox is not in the results"
    // into "you do not have that mailbox".
    stubFetch(async ({ path, params }) => {
      if (path === '/api/mailboxes/fleet') throw new Error('offline')
      if (!params.get('q')) return { items: [] }
      return { items: [] }
    })

    const { input } = open()
    fireEvent.change(input, { target: { value: 'acme' } })

    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText(/1 of \d+ sources could not be searched/)).toBeInTheDocument()
  })

  it('reports an outright failure rather than an empty result set', async () => {
    stubFetch(async () => { throw new Error('offline') })

    const { input } = open()
    fireEvent.change(input, { target: { value: 'acme' } })

    // Scoped to the dialog: the same sentence is deliberately repeated in the
    // off-screen live region, and both copies are wanted.
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText(/Nothing could be searched/)).toBeInTheDocument()
    expect(screen.getAllByText(/Nothing could be searched/)).toHaveLength(2)
    // Crucially not "Nothing matches “acme”", which would be a lie.
    expect(screen.queryByText(/Nothing matches/)).toBeNull()
  })
})
