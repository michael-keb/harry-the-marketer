// The approval gate must not be bypassed by its own UI.
//
// The server gates edits to shared automation defaults behind a 409
// approval_required response for workspaces with require_approval. The old code
// hardcoded `confirmed: true` on every save, so the gate protected nothing.
// These tests pin the real behaviour: the first write goes WITHOUT confirmation,
// a 409 raises a confirmation the operator has to accept, and only then does a
// second write carry `confirmed: true`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { ApiError } from '../api.js'
import { ToastProvider } from '../ui.jsx'
import SendControlsSection from './SendControlsSection.jsx'

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}))
const { api } = await import('../api.js')

const RULES = {
  windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }],
  quietHours: { from: '07:00', to: '20:00' },
  frequency: {}, caps: {}, brakes: {},
  replyHandling: { email: {}, sms: {} },
  randomWindow: { enabled: false, from: '09:00', to: '11:00' },
}

const STATUS = { ok: true, hours: '9–5', timezone: 'UTC', quietHours: { from: '07:00', to: '20:00' }, holds: [] }

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/send-rules')) return Promise.resolve({ effective: RULES, stored: RULES })
    if (url.startsWith('/api/send-status')) return Promise.resolve(STATUS)
    if (url.startsWith('/api/send-health')) return Promise.resolve([])
    if (url.startsWith('/api/send-preview')) return Promise.resolve({ mailbox: null, note: '' })
    return Promise.resolve({})
  })
})

const renderSection = () => render(<ToastProvider><SendControlsSection /></ToastProvider>)

// Open the "Campaign automation defaults" group and press its Save button.
async function saveAutomationDefaults() {
  const heading = await screen.findByText('Campaign automation defaults')
  // The inline EditableSection wrapper carries the top border; the title above
  // is a plain div, so climb to the wrapper that holds Edit and Save.
  const group = heading.closest('.border-t')
  const edit = within(group).getByRole('button', { name: /^Edit$/ })
  fireEvent.click(edit)
  const save = within(group).getByRole('button', { name: /^Save$/ })
  fireEvent.click(save)
}

describe('SendControlsSection approval gate', () => {
  it('sends the first automation-defaults write WITHOUT confirmed', async () => {
    api.put.mockResolvedValue({ effective: RULES })
    renderSection()
    await saveAutomationDefaults()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const body = api.put.mock.calls[0][1]
    expect(body.confirmed).toBeUndefined()
    // No confirmation dialog when the server does not ask for one.
    expect(screen.queryByText(/Confirm change to shared defaults/i)).not.toBeInTheDocument()
  })

  it('raises a confirmation on 409 and only then re-submits with confirmed:true', async () => {
    api.put
      .mockRejectedValueOnce(new ApiError('This workspace requires confirmation…', 409, { error: 'approval_required' }))
      .mockResolvedValueOnce({ effective: RULES })

    renderSection()
    await saveAutomationDefaults()

    // The gate surfaced as a real confirmation the operator must accept.
    const dialog = await screen.findByText(/Confirm change to shared defaults/i)
    expect(dialog).toBeInTheDocument()

    // First write carried no confirmation — the gate was exercised, not bypassed.
    expect(api.put.mock.calls[0][1].confirmed).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: /Confirm and save/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2))
    expect(api.put.mock.calls[1][1].confirmed).toBe(true)
  })

  it('cancelling the confirmation leaves the change unconfirmed', async () => {
    api.put.mockRejectedValueOnce(
      new ApiError('This workspace requires confirmation…', 409, { error: 'approval_required' }),
    )
    renderSection()
    await saveAutomationDefaults()

    await screen.findByText(/Confirm change to shared defaults/i)
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^Cancel$/ }))

    await waitFor(() => expect(screen.queryByText(/Confirm change to shared defaults/i)).not.toBeInTheDocument())
    // Only the single, unconfirmed attempt was ever made.
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put.mock.calls[0][1].confirmed).toBeUndefined()
  })
})
