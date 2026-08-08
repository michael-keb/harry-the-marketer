// The message list — the middle pane.
//
// The list is the thing you live in, so it has to work from the keyboard: up
// and down move the selection and the reading pane follows, Enter takes you
// into what you are reading, and stepping past the whole list costs one Tab
// rather than one per row. None of that is visible in a browser and all of it
// is easy to lose, so it is asserted here.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ListPane from './ListPane.jsx'

const conversation = (id, who, subject) => ({
  id,
  rowType: 'thread',
  lead: { id, first_name: who, last_name: 'Vale', email: `${who.toLowerCase()}@lead.test` },
  campaign: { id: 1, name: 'Q3 outbound' },
  last_message: { id, subject, body: `Snippet for ${subject}`, at: new Date().toISOString() },
  last_reply_at: new Date().toISOString(),
  message_count: 2,
  is_read: false,
  is_important: false,
  is_archived: false,
  is_snoozed: false,
})

const ITEMS = [
  conversation(11, 'Dana', 'Pricing question'),
  conversation(12, 'Femi', 'Send me the deck'),
  conversation(13, 'Sam', 'Not right now'),
]

const renderList = (props = {}) => {
  const onSelect = vi.fn()
  const onOpen = vi.fn()
  const view = render(
    <ListPane
      folder="active"
      items={ITEMS}
      loading={false}
      error={null}
      hasMore={false}
      total={3}
      selectedId="11"
      onSelect={onSelect}
      onOpen={onOpen}
      onCheck={vi.fn()}
      onCheckAll={vi.fn()}
      onPatch={vi.fn()}
      {...props}
    />,
  )
  return { ...view, onSelect, onOpen }
}

const rowButtons = () => [...document.querySelectorAll('[data-row-button]')]

describe('ListPane — what a row says', () => {
  it('shows sender, subject and a one-line snippet on every row', () => {
    renderList()
    expect(screen.getByText('Dana Vale')).toBeInTheDocument()
    expect(screen.getByText('Pricing question')).toBeInTheDocument()
    expect(screen.getByText('Snippet for Pricing question')).toBeInTheDocument()
  })

  it('says "unread" in words, not only in weight and a dot', () => {
    renderList()
    expect(screen.getAllByText('Unread.')).toHaveLength(3)
  })

  it('marks the selected row as current so the reading pane and the list agree', () => {
    renderList({ selectedId: '12' })
    const current = rowButtons().filter((b) => b.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveTextContent('Femi Vale')
  })

  it('names the list and reports how much of the folder is on screen', () => {
    renderList({ total: 40 })
    expect(screen.getByRole('list', { name: /Active — conversations/ })).toBeInTheDocument()
    expect(screen.getByText('3 of 40 conversations')).toBeInTheDocument()
  })
})

describe('ListPane — keyboard', () => {
  it('keeps exactly one row in the tab order', () => {
    renderList({ selectedId: '12' })
    const tabbable = rowButtons().filter((b) => b.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]).toHaveTextContent('Femi Vale')
  })

  it('falls back to the first row when the selection is not on this page', () => {
    renderList({ selectedId: '999' })
    const tabbable = rowButtons().filter((b) => b.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]).toHaveTextContent('Dana Vale')
  })

  it('moves the selection down and up, so the reading pane follows the arrows', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderList()
    rowButtons()[0].focus()

    await user.keyboard('{ArrowDown}')
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[1])
    expect(rowButtons()[1]).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[2])

    await user.keyboard('{ArrowUp}')
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[1])
  })

  it('stops at the ends rather than wrapping round', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderList()
    rowButtons()[0].focus()
    await user.keyboard('{ArrowUp}')
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[0])
    expect(rowButtons()[0]).toHaveFocus()
  })

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderList()
    rowButtons()[0].focus()
    await user.keyboard('{End}')
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[2])
    await user.keyboard('{Home}')
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[0])
  })

  it('opens on Enter — once, not twice', async () => {
    const user = userEvent.setup()
    const { onSelect, onOpen } = renderList()
    rowButtons()[1].focus()
    await user.keyboard('{Enter}')
    // The handler calls preventDefault, so the button's own activation does not
    // also fire and select the row a second time.
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1])
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('selects on click as well, for everyone who is using a mouse', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderList()
    await user.click(rowButtons()[2])
    expect(onSelect).toHaveBeenCalledWith(ITEMS[2])
  })
})

describe('ListPane — the approval queue is a folder like any other', () => {
  const DRAFTS = [
    { id: 1, subject: 'Following up', body: 'Hello there', lead_email: 'dana@lead.test', first_name: 'Dana', campaign_name: 'Q3 outbound', campaign_status: 'running', created_at: new Date().toISOString() },
    { id: 2, subject: 'One more thought', body: 'Circling back', lead_email: 'femi@lead.test', first_name: 'Femi', campaign_name: 'Q3 outbound', campaign_status: 'running', created_at: new Date().toISOString() },
  ]

  it('offers Send all only when there is more than one, and keeps it out of the rows', () => {
    const onApproveAll = vi.fn()
    render(
      <ListPane
        folder="approve" items={DRAFTS} loading={false} error={null} hasMore={false}
        total={2} selectedId="1" onSelect={vi.fn()} onApproveAll={onApproveAll}
      />,
    )
    expect(screen.getByRole('button', { name: 'Send all 2' })).toBeInTheDocument()
    expect(screen.getByText('Following up')).toBeInTheDocument()
    // Every row says what it is waiting for, in words — not by sitting in a
    // folder whose name you cannot see from the row.
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toHaveTextContent('Needs your OK')
  })

  it('offers no bulk send for a queue of one', () => {
    render(
      <ListPane
        folder="approve" items={[DRAFTS[0]]} loading={false} error={null} hasMore={false}
        total={1} selectedId="1" onSelect={vi.fn()} onApproveAll={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /Send all/ })).toBeNull()
  })

  it('offers no bulk selection on the approval queue — approving is not a state you can undo', () => {
    render(
      <ListPane
        folder="approve" items={DRAFTS} loading={false} error={null} hasMore={false}
        total={2} selectedId="1" onSelect={vi.fn()} onApproveAll={vi.fn()}
      />,
    )
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

describe('ListPane — empty', () => {
  it('says what the folder is for when it is empty', () => {
    renderList({ items: [], total: 0 })
    expect(screen.getByText('No replies yet')).toBeInTheDocument()
  })

  it('says the filters are the reason, and offers to clear them', async () => {
    const user = userEvent.setup()
    const onClearFilters = vi.fn()
    renderList({ items: [], total: 0, filtered: true, onClearFilters })
    expect(screen.getByText('Nothing matches these filters')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(onClearFilters).toHaveBeenCalled()
  })
})
