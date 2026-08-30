// The reply composer's one new promise: a half-typed reply survives everything
// short of being sent (ux-audit-self-healing.md, P0 item 2). The composer
// unmounts on a thread switch, a refresh and the mobile back button, so the
// draft's home is localStorage — and these tests cross that seam the way the
// user does: type, unmount, mount again.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from '../ui.jsx'
import { stubFetch } from '../__tests__/helpers.js'
import { ReplyComposer } from './Composer.jsx'

const thread = {
  id: 42,
  threadKey: 'em-42',
  lead: { id: 7, email: 'lead@example.test' },
  messages: [{ direction: 'out', from_email: 'me@box.test' }],
}

const renderComposer = (props = {}) => render(
  <ToastProvider>
    <ReplyComposer thread={thread} onSent={vi.fn()} {...props} />
  </ToastProvider>,
)

beforeEach(() => { stubFetch(async () => ({ ok: true })) })

const stored = () => JSON.parse(window.localStorage.getItem('harry.replyDrafts') || '{}')

describe('ReplyComposer — the draft survives', () => {
  it('persists what is typed, keyed by thread', () => {
    renderComposer()
    fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: 'Half a thought' } })
    expect(stored()['em-42']?.body).toBe('Half a thought')
  })

  it('restores the draft when the composer mounts again', () => {
    const first = renderComposer()
    fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: 'Interrupted mid-reply' } })
    first.unmount()

    renderComposer()
    expect(screen.getByLabelText('Your reply')).toHaveValue('Interrupted mid-reply')
  })

  it('clearing the textarea clears the stored draft too', () => {
    renderComposer()
    const box = screen.getByLabelText('Your reply')
    fireEvent.change(box, { target: { value: 'oops' } })
    fireEvent.change(box, { target: { value: '' } })
    expect(stored()['em-42']).toBeUndefined()
  })

  it('drops the draft only once the server has taken the send', async () => {
    const onSent = vi.fn()
    renderComposer({ onSent })
    fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: 'Ready to go' } })

    fireEvent.click(screen.getByRole('button', { name: 'Send reply…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, send it' }))

    await waitFor(() => expect(onSent).toHaveBeenCalled())
    expect(stored()['em-42']).toBeUndefined()
  })

  it('keeps the draft when the send fails', async () => {
    stubFetch(async () => { throw new Error('offline') })
    renderComposer()
    fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: 'Do not lose this' } })

    fireEvent.click(screen.getByRole('button', { name: 'Send reply…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, send it' }))

    await waitFor(() => expect(screen.getByLabelText('Your reply')).toHaveValue('Do not lose this'))
    expect(stored()['em-42']?.body).toBe('Do not lose this')
  })

  it('survives localStorage being unavailable', () => {
    // Private browsing throws on setItem. The draft is allowed not to persist;
    // it is not allowed to take the keystroke down with it.
    const setItem = vi.spyOn(window.localStorage.__proto__, 'setItem')
      .mockImplementation(() => { throw new Error('QuotaExceededError') })
    try {
      renderComposer()
      const box = screen.getByLabelText('Your reply')
      fireEvent.change(box, { target: { value: 'still typing' } })
      expect(box).toHaveValue('still typing')
    } finally {
      setItem.mockRestore()
    }
  })
})
