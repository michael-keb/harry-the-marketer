// Team activity — where it lives is the requirement.
//
// The spec's definition of done leads with a negative: the panel must NOT
// appear on the Dashboard or Reports. That is a product judgement, not a layout
// preference — beside campaign performance these figures rank colleagues, and a
// scoreboard changes what people optimise for. It shipped as a Reports tab
// anyway, which is the whole reason this file exists.
//
// A placement requirement is easy to satisfy once and undo silently: a tab is
// one line, and nothing about adding it back would look wrong in review. So the
// absence is asserted here rather than left to memory.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import TeamActivity from './TeamActivity.jsx'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(path.join(HERE, rel), 'utf8')

// Partial mock: `api.js` also exports the query-string helper the paging hook
// uses, and replacing the whole module wholesale takes that with it.
vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}))
const { api } = await import('../api.js')

const member = (email, extra = {}) => ({
  email, role: 'member', status: 'active',
  campaigns_created: 0, leads_assigned: 0, approvals: 0, declines: 0,
  replies_handled: 0, notes_written: 0, tasks_created: 0,
  average_reply_seconds: 0, average_reply_time: '',
  ...extra,
})

const respond = (items) => {
  api.get.mockResolvedValue({
    items,
    range: { from: '2026-07-10', to: '2026-08-08', timezone: 'UTC' },
  })
}

beforeEach(() => { vi.clearAllMocks() })

describe('where the panel lives', () => {
  it('is not mounted anywhere on Reports', () => {
    // Read the page rather than rendering it: the claim is about the whole
    // surface, and rendering only proves the branches that happened to run.
    const reports = read('../pages/Reports.jsx')
    expect(reports).not.toMatch(/TeamTab|TeamActivity/)
    expect(reports).not.toMatch(/id: 'team'/)
  })

  it('is not mounted on the Dashboard', () => {
    expect(read('../pages/Dashboard.jsx')).not.toMatch(/TeamTab|TeamActivity/)
  })

  it('is mounted in Settings, under the member list', () => {
    const settings = read('../pages/Settings.jsx')
    expect(settings).toMatch(/<TeamActivity\s*\/>/)
    // Order matters: the panel is context for the list above it, not a headline.
    expect(settings.indexOf('<TeamSection />')).toBeLessThan(settings.indexOf('<TeamActivity />'))
  })
})

describe('TeamActivity', () => {
  it('renders nothing at all in a solo workspace', async () => {
    // Hidden entirely, not an empty state. A workspace of one should never be
    // shown a table comparing it to itself.
    respond([member('solo@example.test')])
    const { container } = render(<TeamActivity />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('shows the table once there is more than one member', async () => {
    respond([member('a@example.test'), member('b@example.test', { replies_handled: 4 })])
    render(<TeamActivity />)
    expect(await screen.findByRole('table', { name: /team activity/i })).toBeInTheDocument()
    expect(screen.getByText('a@example.test')).toBeInTheDocument()
    expect(screen.getByText('b@example.test')).toBeInTheDocument()
  })

  it('names the range in a caption, so a figure is never undated', async () => {
    respond([member('a@example.test'), member('b@example.test')])
    render(<TeamActivity />)
    const table = await screen.findByRole('table', { name: /team activity/i })
    expect(table.querySelector('caption')).toHaveTextContent('2026-07-10')
    expect(table.querySelector('caption')).toHaveTextContent('2026-08-08')
  })

  it('lists an inactive member with zeros rather than dropping them', async () => {
    // Dropping the quiet people would make the panel read as a ranking of who
    // is present, which is the failure mode the note in the panel disclaims.
    respond([member('busy@example.test', { replies_handled: 9 }), member('quiet@example.test')])
    render(<TeamActivity />)
    expect(await screen.findByText('quiet@example.test')).toBeInTheDocument()
  })

  it('states how each column is attributed', async () => {
    respond([member('a@example.test'), member('b@example.test')])
    render(<TeamActivity />)
    const header = await screen.findByRole('columnheader', { name: /replies handled/i })
    expect(header.textContent.length).toBeGreaterThan(0)
    // The definition rides on the header itself, so nobody has to guess what
    // they are being measured on.
    expect(header.querySelector('[title]') || header).toHaveAttribute('title', expect.stringContaining('assigned'))
  })

  it('sortable headers expose aria-sort', async () => {
    respond([member('a@example.test'), member('b@example.test')])
    render(<TeamActivity />)
    const header = await screen.findByRole('columnheader', { name: /replies handled/i })
    expect(header).toHaveAttribute('aria-sort')
  })

  it('an error hides the table and leaves the rest of the page alone', async () => {
    api.get.mockRejectedValue(new Error('the reporting query timed out'))
    render(<TeamActivity />)
    await waitFor(() => expect(screen.queryByRole('table')).not.toBeInTheDocument())
    expect(await screen.findByText(/timed out/i)).toBeInTheDocument()
  })
})
