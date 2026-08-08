// ClientLens — the switch that silently changes what every list means.
//
// The lens is deliberately wired through a global (`__harryClientLensId`)
// rather than an import, so that api.js can stay plain and React-free. That is
// a reasonable trade and an untested seam: the publisher and the reader live in
// different files with no type or import connecting them, so a rename on either
// side breaks the lens without breaking anything that looks related. The tests
// below cross that seam on purpose — they select a client in the component and
// then assert on the URL api.js actually sends.
//
// The other property here is the honesty rule the file opens with: a filter you
// cannot see is how someone concludes their leads have vanished. So the banner
// is asserted, and so is the fact that the control hides itself entirely in a
// workspace that has no clients — a distinction that workspace does not make
// should not be offered to it.
//
// Everything is re-imported per test: the lens keeps its selection in a
// module-level variable by design (it must be readable before React mounts), so
// without vi.resetModules() one test's selection leaks into the next.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { stubFetch } from './helpers.js'

const CLIENTS = { items: [{ id: 7, name: 'Acme' }, { id: 9, name: 'Belrose' }] }

let calls

// Load a fresh copy of the lens *and* of api.js, so both sides of the global
// seam come from the same module graph.
async function load(clientsPayload = CLIENTS) {
  const stub = stubFetch(async ({ path }) => (path === '/api/clients' ? clientsPayload : { items: [] }))
  calls = stub.calls
  vi.resetModules()
  const lens = await import('../ClientLens.jsx')
  const { api } = await import('../api.js')
  return { ClientLens: lens.default, ...lens, api }
}

beforeEach(() => {
  window.localStorage.clear()
  globalThis.__harryClientLensId = null
})
afterEach(() => { globalThis.__harryClientLensId = null })

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /Viewing:/ }))

describe('ClientLens — presence', () => {
  it('does not exist in a workspace with no clients', async () => {
    // A single-brand workspace should never be shown a control for a
    // distinction it does not make.
    const { ClientLens } = await load({ items: [] })
    const { container } = render(<ClientLens />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('offers the switch once there are clients to switch between', async () => {
    const { ClientLens } = await load()
    render(<ClientLens />)
    expect(await screen.findByRole('button', { name: /Viewing:\s*All clients/ })).toBeInTheDocument()
  })

  it('stays visible if the client list could not be loaded', async () => {
    // Hiding on error would look identical to "this workspace has no clients",
    // and would strand anyone who already had a lens applied.
    stubFetch(async () => { throw new Error('offline') })
    vi.resetModules()
    const { default: ClientLens } = await import('../ClientLens.jsx')
    const { container } = render(<ClientLens />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Viewing:/ })).toBeInTheDocument())
    expect(container).not.toBeEmptyDOMElement()
  })
})

describe('ClientLens — publishing the selection', () => {
  it('publishes the id api.js reads, and api.js applies it to lens-aware routes', async () => {
    // The seam. `setActiveClient` writes `globalThis.__harryClientLensId`;
    // api.js reads that name and nothing else. Nothing but a test connects the
    // two, which is why this asserts on the URL rather than on the global.
    const { ClientLens, api } = await load()
    render(<ClientLens />)
    await screen.findByRole('button', { name: /Viewing:/ })

    openMenu()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Acme' })) })

    expect(globalThis.__harryClientLensId).toBe(7)
    await api.get('/api/leads')
    expect(calls.at(-1)).toBe('/api/leads?clientId=7')

    // …and it composes with a query string that is already there.
    await api.get('/api/leads?q=smith')
    expect(calls.at(-1)).toBe('/api/leads?q=smith&clientId=7')
  })

  it('leaves workspace-wide routes alone rather than pretending to filter them', async () => {
    // Reports and Monitoring really are workspace-wide. Appending clientId to
    // them would be a lie by omission — the numbers would not change and the
    // reader would believe they had.
    const { ClientLens, api } = await load()
    render(<ClientLens />)
    await screen.findByRole('button', { name: /Viewing:/ })

    openMenu()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Acme' })) })

    await api.get('/api/reports/overview')
    expect(calls.at(-1)).toBe('/api/reports/overview')
  })

  it('removes the id when the lens is cleared', async () => {
    const { ClientLens, api } = await load()
    render(<ClientLens />)
    await screen.findByRole('button', { name: /Viewing:/ })

    openMenu()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Acme' })) })
    expect(globalThis.__harryClientLensId).toBe(7)

    openMenu()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'All clients' })) })

    expect(globalThis.__harryClientLensId).toBeNull()
    await api.get('/api/leads')
    // Not `?clientId=` and not `?clientId=null` — no parameter at all.
    expect(calls.at(-1)).toBe('/api/leads')
  })

  it('marks the chosen client selected in the listbox', async () => {
    const { ClientLens } = await load()
    render(<ClientLens />)
    await screen.findByRole('button', { name: /Viewing:/ })

    openMenu()
    expect(screen.getByRole('option', { name: 'All clients' })).toHaveAttribute('aria-selected', 'true')
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Acme' })) })

    openMenu()
    expect(screen.getByRole('option', { name: 'Acme' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'All clients' })).toHaveAttribute('aria-selected', 'false')
  })
})

describe('ClientLens — saying so out loud', () => {
  it('names the client in the control and explains what is filtered', async () => {
    const { ClientLens } = await load()
    render(<ClientLens />)
    await screen.findByRole('button', { name: /Viewing:/ })

    openMenu()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Acme' })) })

    expect(screen.getByRole('button', { name: /Viewing:\s*Acme/ })).toBeInTheDocument()
    // Continuously, not once: this sentence is the mitigation for "my leads
    // have disappeared".
    expect(screen.getByText(/Campaigns, leads and mailboxes are filtered to this client/)).toBeInTheDocument()
    expect(screen.getByText(/Reports and\s+Monitoring stay workspace-wide/)).toBeInTheDocument()
  })

  it('says nothing extra when no client is selected', async () => {
    const { ClientLens } = await load()
    render(<ClientLens />)
    await screen.findByRole('button', { name: /Viewing:/ })
    expect(screen.queryByText(/are filtered to this client/)).toBeNull()
  })
})

describe('ClientLens — persistence', () => {
  it('applies a stored lens before the first request leaves the page', async () => {
    // Read at module load rather than in an effect: a lens applied one render
    // late means every page flashes unscoped data first, which for an agency is
    // another client's data.
    window.localStorage.setItem('harry.clientLens', JSON.stringify({ id: 9, name: 'Belrose' }))
    const { api } = await load()
    expect(globalThis.__harryClientLensId).toBe(9)
    await api.get('/api/leads')
    expect(calls.at(-1)).toBe('/api/leads?clientId=9')
  })

  it('survives localStorage being unavailable', async () => {
    // Private browsing throws on setItem. The lens is allowed not to persist;
    // it is not allowed to take the click down with it.
    const { ClientLens } = await load()
    render(<ClientLens />)
    await screen.findByRole('button', { name: /Viewing:/ })

    const setItem = vi.spyOn(window.localStorage.__proto__, 'setItem')
      .mockImplementation(() => { throw new Error('QuotaExceededError') })
    try {
      openMenu()
      await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Acme' })) })
      expect(globalThis.__harryClientLensId).toBe(7)
    } finally {
      setItem.mockRestore()
    }
  })

  it('ignores corrupt stored state instead of blanking the shell', async () => {
    window.localStorage.setItem('harry.clientLens', '{not json')
    const { ClientLens } = await load()
    expect(globalThis.__harryClientLensId).toBeNull()
    render(<ClientLens />)
    expect(await screen.findByRole('button', { name: /Viewing:\s*All clients/ })).toBeInTheDocument()
  })
})
