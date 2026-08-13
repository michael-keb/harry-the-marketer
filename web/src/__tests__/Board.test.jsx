// Conversation board — columns come from the derived stage, cards from the
// last inbound the classifier tagged. Drag-and-drop is deliberately absent:
// writing a column would lie the next time a reply landed.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Board from '../leads/Board.jsx'

const leads = [
  {
    id: 1, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@acme.test',
    company: 'Acme', title: 'Head of Ops', stage: 'not contacted', lastInbound: null,
  },
  {
    id: 2, first_name: 'Ben', last_name: 'Byte', email: 'ben@byte.test',
    company: 'Byte', title: '', stage: 'replied',
    lastInbound: { snippet: 'Who handles this at your end?', intent: 'question', createdAt: '2026-08-12 10:00:00' },
  },
  {
    id: 3, first_name: 'Cara', last_name: 'Chen', email: 'cara@chen.test',
    company: 'Chen Co', title: '', stage: 'interested',
    lastInbound: { snippet: 'Yes, send the details.', intent: 'interested', createdAt: '2026-08-12 11:00:00' },
  },
]

describe('Board', () => {
  it('defaults to conversations, so people who have not replied are off the board', () => {
    render(<Board leads={leads} onOpenLead={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'replied' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'interested' })).toBeInTheDocument()
    expect(screen.queryByText('Ada Lovelace')).toBeNull()
    expect(screen.getByText('Ben Byte')).toBeInTheDocument()
    expect(screen.getByText('Who handles this at your end?')).toBeInTheDocument()
    expect(screen.getByText('Yes, send the details.')).toBeInTheDocument()
  })

  it('shows the AI intent the classifier stamped on the message', () => {
    render(<Board leads={leads} onOpenLead={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Ben Byte/ })).toHaveTextContent('question')
    expect(screen.getByRole('button', { name: /Cara Chen/ })).toHaveTextContent('interested')
  })

  it('opens the lead when a card is clicked', () => {
    const onOpenLead = vi.fn()
    render(<Board leads={leads} onOpenLead={onOpenLead} />)
    fireEvent.click(screen.getByRole('button', { name: /Cara Chen/ }))
    expect(onOpenLead).toHaveBeenCalledWith(3)
  })

  it('Show everyone puts not-contacted people on the board', () => {
    render(<Board leads={leads} onOpenLead={vi.fn()} />)
    expect(screen.queryByRole('heading', { name: 'not contacted' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Conversations' }))
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'not contacted' })).toBeInTheDocument()
  })

  it('says honestly that the board is empty until a reply lands', () => {
    render(<Board leads={[leads[0]]} onOpenLead={vi.fn()} />)
    expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    expect(screen.getByText(/Harry reads the message/)).toBeInTheDocument()
  })
})
