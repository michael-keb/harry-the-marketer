// The email trail — the thing the Inbox rebuild exists for.
//
// Three properties are worth standing in front of, because all three are easy
// to lose in a tidy-up and none of them is obvious from looking at the markup:
//
//  1. The whole conversation is there, oldest first. A reading pane that shows
//     the last message with "12 earlier" beside it is what we replaced.
//  2. The newest message is open on arrival and stays open. Folding it away
//     would hide the one message you came to read.
//  3. Who sent what is in words. Strip every colour out and the trail must
//     still say which side each message came from.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MessageTrail from './MessageTrail.jsx'

const at = (n) => new Date(Date.now() - n * 3600_000).toISOString()

const message = (id, direction, body, hours) => ({
  id,
  direction,
  subject: 'About your outbound',
  body,
  from_email: direction === 'out' ? 'harry@agency.test' : 'dana@lead.test',
  to_email: direction === 'out' ? 'dana@lead.test' : 'harry@agency.test',
  created_at: at(hours),
})

const trail = (n) => Array.from({ length: n }, (_, i) =>
  message(i + 1, i % 2 === 0 ? 'out' : 'in', `Body of message number ${i + 1}`, n - i))

describe('MessageTrail — the whole conversation, oldest first', () => {
  it('opens the newest message and no other', () => {
    render(<MessageTrail messages={trail(3)} />)
    // Only expanded messages are articles; collapsed ones are buttons that open
    // them. Three messages, one open.
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByText('Body of message number 3')).toBeInTheDocument()
  })

  it('names the trail with how many messages are in it', () => {
    render(<MessageTrail messages={trail(4)} />)
    expect(screen.getByRole('list', { name: /4 messages, oldest first/ })).toBeInTheDocument()
  })

  it('leaves a short trail unfolded — every older message is one click away', () => {
    // Three messages is two older ones, which is the point the fold starts.
    render(<MessageTrail messages={trail(3)} />)
    expect(screen.queryByRole('button', { name: /earlier message/ })).toBeNull()
    // Both older messages are present as their own expanders.
    expect(screen.getAllByRole('button', { name: /Show this message/ })).toHaveLength(2)
  })

  it('folds a long trail behind one expander, keeping the first message visible', async () => {
    const user = userEvent.setup()
    // Six messages: five older. The first stays out, four fold away.
    render(<MessageTrail messages={trail(6)} />)

    expect(screen.getAllByRole('button', { name: /Show this message/ })).toHaveLength(1)
    const expander = screen.getByRole('button', { name: /4\s*earlier messages/ })
    expect(expander).toBeInTheDocument()

    await user.click(expander)

    expect(screen.queryByRole('button', { name: /earlier messages/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: /Show this message/ })).toHaveLength(5)
    // The newest was never folded and is still open.
    expect(screen.getByText('Body of message number 6')).toBeInTheDocument()
  })

  it('opens an older message in place without closing the newest', async () => {
    const user = userEvent.setup()
    render(<MessageTrail messages={trail(3)} />)

    await user.click(screen.getAllByRole('button', { name: /Show this message/ })[0])

    expect(screen.getAllByRole('article')).toHaveLength(2)
    expect(screen.getByText('Body of message number 1')).toBeInTheDocument()
    expect(screen.getByText('Body of message number 3')).toBeInTheDocument()
  })
})

describe('MessageTrail — direction is never carried by colour', () => {
  it('says in words which side each message came from', () => {
    render(<MessageTrail messages={[message(1, 'in', 'Their words', 2)]} />)
    // The visible label, not a tint and not an alignment.
    expect(screen.getByText('They replied')).toBeInTheDocument()
  })

  it('names outbound and inbound differently to assistive tech', () => {
    render(<MessageTrail messages={[message(9, 'out', 'Our words', 1)]} />)
    const article = screen.getByRole('article')
    expect(article).toHaveAccessibleName(/^Sent by you, from harry@agency\.test to dana@lead\.test/)
  })

  it('names both ends of every message — who it came from and who it went to', () => {
    render(<MessageTrail messages={trail(2)} />)
    const article = screen.getByRole('article')
    expect(article).toHaveAccessibleName(/from dana@lead\.test to harry@agency\.test/)
  })

  it('states an empty conversation rather than rendering nothing', () => {
    render(<MessageTrail messages={[]} />)
    expect(screen.getByText(/no messages stored yet/i)).toBeInTheDocument()
  })
})
