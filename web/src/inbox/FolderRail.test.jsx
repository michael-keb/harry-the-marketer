// The folder rail.
//
// It replaces a tab strip, and the two things a tab strip got for free have to
// be built by hand here: which one you are in, and what the number beside a
// folder counts. Both are encoded below because both are invisible in a browser
// and trivially undone by anyone tidying the markup.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FolderRail } from './FolderRail.jsx'

const renderRail = (props = {}) => render(
  <FolderRail folder="active" onChange={vi.fn()} counts={{}} approvals={0} {...props} />,
)

describe('FolderRail', () => {
  it('is a named navigation list', () => {
    renderRail()
    expect(screen.getByRole('navigation', { name: 'Mail folders' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(5)
  })

  it('puts Needs your OK first — the queue is the spine, not one folder among ten', () => {
    renderRail()
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Needs your OK')
  })

  it('marks exactly one folder as current, in the markup and not only in the tint', () => {
    renderRail({ folder: 'snoozed' })
    const current = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveTextContent('Snoozed')
  })

  it('says what a count counts rather than gluing a number to the label', () => {
    renderRail({ approvals: 5, counts: { unread: 3, active: 12 } })
    // The regression this stands in front of: a bare pill beside the text
    // computes an accessible name of "Unread3".
    expect(screen.getByRole('button', { name: /^Needs your OK\s*\(5 waiting for your approval\)$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Unread\s*\(3 unread\)$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Active\s*\(12 conversations\)$/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unread3' })).toBeNull()
  })

  it('hides the visible pill from assistive tech so the number is not read twice', () => {
    renderRail({ approvals: 5 })
    const button = screen.getByRole('button', { name: /Needs your OK/ })
    const pill = [...button.querySelectorAll('span')].find((s) => s.getAttribute('aria-hidden') !== null)
    expect(pill).toHaveTextContent('5')
  })

  it('keeps a zero in the name but shows no pill — "empty" is information, a "0" badge is noise', () => {
    renderRail({ counts: { archived: 0 } })
    const button = screen.getByRole('button', { name: /^Archived\s*\(0 conversations\)$/ })
    expect([...button.querySelectorAll('[aria-hidden]')]).toHaveLength(0)
  })

  it('hides Untracked entirely until there is something untracked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = renderRail({ onChange })
    expect(screen.queryByRole('button', { name: /Untracked/ })).toBeNull()

    rerender(<FolderRail folder="active" onChange={onChange} counts={{}} approvals={0} showUntracked />)
    await user.click(screen.getByRole('button', { name: /Untracked/ }))
    expect(onChange).toHaveBeenCalledWith('untracked')
  })

  it('keeps Untracked visible while you are standing in it', () => {
    renderRail({ folder: 'untracked' })
    expect(screen.getByRole('button', { name: /Untracked/ })).toHaveAttribute('aria-current', 'true')
  })

  it('reports the folder you picked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderRail({ onChange })
    await user.click(screen.getByRole('button', { name: /^Archived/ }))
    expect(onChange).toHaveBeenCalledWith('archived')
  })

  it('renders the same folders as a strip when there is no room for a column', () => {
    renderRail({ variant: 'strip', folder: 'important' })
    expect(screen.getByRole('navigation', { name: 'Mail folders' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Important/ })).toHaveAttribute('aria-current', 'true')
  })
})
