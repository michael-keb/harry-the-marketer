// Tabs — the count belongs in the accessible name.
//
// This encodes a bug that already happened: the count pill sat next to the
// label as plain text, so the accessible name computed to "Leads0" and a screen
// reader announced a tab that does not exist. The fix — aria-hidden on the
// decorative pill plus an sr-only " (0)" — is invisible in a browser and
// trivially undone by anyone tidying up the markup, which is exactly the kind
// of change a test has to stand in front of.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Tabs } from '../parity-ui.jsx'

const TABS = [
  { id: 'leads', label: 'Leads', count: 0 },
  { id: 'segments', label: 'Segments', count: 12 },
  { id: 'blocked', label: 'Never contact' },
]

const renderTabs = (props = {}) =>
  render(<Tabs tabs={TABS} active="leads" onChange={vi.fn()} {...props} />)

describe('Tabs — accessible naming', () => {
  it('reads the count as a bracketed aside, never glued to the label', () => {
    renderTabs()
    // The regression: getByRole matches on the *computed accessible name*, so
    // "Leads0" and "Leads (0)" are distinguishable here in a way they are not
    // on screen.
    //
    // The brackets are the assertion, not the space. dom-accessibility-api
    // trims each node's contribution before joining, so it computes
    // "Leads(0)" where Chrome computes "Leads (0)" — the separator differs by
    // implementation, the parentheses do not, and it is the parentheses that
    // stop the number running into the word.
    expect(screen.getByRole('tab', { name: /^Leads\s*\(0\)$/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Segments\s*\(12\)$/ })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Leads0' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Segments12' })).toBeNull()
  })

  it('keeps a zero count in the name rather than dropping it', () => {
    // `typeof t.count === 'number'` rather than a truthiness check: "Leads (0)"
    // is information — it says the tab is empty, not that it is countless.
    renderTabs()
    expect(screen.getByRole('tab', { name: /\(0\)$/ })).toBeInTheDocument()
  })

  it('omits the count entirely for a tab that has none', () => {
    renderTabs()
    expect(screen.getByRole('tab', { name: 'Never contact' })).toBeInTheDocument()
  })

  it('hides the visible pill from assistive tech so the number is not read twice', () => {
    renderTabs()
    const tab = screen.getByRole('tab', { name: /^Segments\s*\(12\)$/ })
    const pill = [...tab.querySelectorAll('span')].find((s) => s.getAttribute('aria-hidden') !== null)
    expect(pill).toHaveTextContent('12')
  })

  it('labels the tablist', () => {
    renderTabs({ ariaLabel: 'Lead views' })
    expect(screen.getByRole('tablist', { name: 'Lead views' })).toBeInTheDocument()
    // …and has a sensible default, so a call site that forgets is still labelled.
    render(<Tabs tabs={TABS} active="leads" onChange={vi.fn()} />)
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument()
  })
})

describe('Tabs — selection', () => {
  it('marks exactly one tab selected, and it is the active one', () => {
    renderTabs({ active: 'segments' })
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  })

  it('tracks aria-selected when the active tab changes', () => {
    // aria-selected is the only signal a screen reader has; the colour change
    // that carries it visually is not available to everyone.
    const leads = /^Leads\s*\(0\)$/
    const { rerender } = renderTabs({ active: 'leads' })
    expect(screen.getByRole('tab', { name: leads })).toHaveAttribute('aria-selected', 'true')

    rerender(<Tabs tabs={TABS} active="blocked" onChange={vi.fn()} />)
    expect(screen.getByRole('tab', { name: leads })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'Never contact' })).toHaveAttribute('aria-selected', 'true')
  })

  it('reports the id of the clicked tab', () => {
    const onChange = vi.fn()
    renderTabs({ onChange })
    fireEvent.click(screen.getByRole('tab', { name: /^Segments\s*\(12\)$/ }))
    expect(onChange).toHaveBeenCalledWith('segments')
  })
})
