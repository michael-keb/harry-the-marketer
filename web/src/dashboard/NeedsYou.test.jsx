// The partial-load banner (ux-audit-self-healing.md, P0 item 3).
//
// Rows land one source at a time, and a half-loaded queue used to be
// indistinguishable from a finished one: approvals would render, tasks and
// reminders were still in flight, and "3 things need you" read as the whole
// truth. These tests hold requests open with deferred() and assert the section
// says which lists are still being checked until every source has answered.

import { describe, it, expect } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { stubFetch, deferred } from '../__tests__/helpers.js'
import NeedsYou from './NeedsYou.jsx'

const DRAFT = {
  id: 1, subject: 'Quick intro', first_name: 'Ada', last_name: 'Lovelace',
  lead_email: 'ada@example.test', campaign_name: 'Spring', campaign_status: 'running',
  created_at: '2026-08-29T00:00:00.000Z',
}

const renderQueue = () => render(
  <MemoryRouter>
    <NeedsYou decisions={[]} onDecisionsChanged={() => {}} />
  </MemoryRouter>,
)

describe('NeedsYou — a half-loaded queue says so', () => {
  it('names the sources still being checked while early rows render', async () => {
    const tasks = deferred()
    const reminders = deferred()
    stubFetch(async ({ path }) => {
      if (path === '/api/drafts') return { requireApproval: true, drafts: [DRAFT] }
      if (path === '/api/tasks') return tasks.promise
      if (path === '/api/reminders') return reminders.promise
      return { items: [] }
    })

    const { unmount } = renderQueue()

    // Approvals answered first — a row is on screen…
    expect(await screen.findByText('Quick intro')).toBeInTheDocument()
    // …and the section says the list is not finished rather than looking done.
    expect(screen.getByText(/Still checking tasks, reminders/)).toBeInTheDocument()
    // The All count is a floor, not a total, while sources are outstanding.
    expect(screen.getByRole('tab', { name: /at least 1/ })).toBeInTheDocument()

    await act(async () => {
      tasks.resolve({ items: [], counts: { open: 0 } })
      reminders.resolve({ items: [] })
    })

    await waitFor(() => expect(screen.queryByText(/Still checking/)).toBeNull())
    expect(screen.getByRole('tab', { name: /1 thing needs you/ })).toBeInTheDocument()
    unmount()
  })

  it('shows the spinner, not the banner, while nothing has answered yet', async () => {
    const hold = deferred()
    stubFetch(async () => hold.promise)

    const { unmount } = renderQueue()

    expect(screen.getByText('Checking what needs you…')).toBeInTheDocument()
    expect(screen.queryByText(/Still checking/)).toBeNull()

    await act(async () => { hold.resolve({ items: [], drafts: [] }) })
    unmount()
  })
})
