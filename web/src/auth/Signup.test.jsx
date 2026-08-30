import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { stubFetch } from '../__tests__/helpers.js'
import Signup from './Signup.jsx'

function mount(path = '/signup') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/signup" element={<Signup />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  stubFetch(async ({ path }) => {
    if (path === '/api/auth/config') return { auth0: true, devLogin: false }
    return {}
  })
})

describe('Signup', () => {
  it('maps a signup OAuth error into customer copy on the create-account screen', async () => {
    mount('/signup?error=oauth_failed')
    expect(await screen.findByRole('heading', { name: /create your account/i })).toBeInTheDocument()
    expect(screen.getByRole('alert').textContent).toMatch(/create your account/i)
    expect(screen.getByRole('alert').textContent).not.toMatch(/Auth0|server logs/i)
  })

  it('echoes Redirecting to Google after the primary tap', async () => {
    mount('/signup')
    const link = await screen.findByRole('link', { name: /sign up with google/i })
    fireEvent.click(link)
    expect(screen.getByRole('link', { name: /redirecting to google/i })).toHaveAttribute('aria-busy', 'true')
  })

  it('keeps every trust point on the page, not a three-bullet stand-in', async () => {
    mount('/signup')
    await screen.findByRole('heading', { name: /create your account/i })
    const points = screen.getByRole('heading', { name: /what you get immediately/i }).closest('div')
    expect(points.textContent).toMatch(/working default playbook/i)
    expect(points.textContent).toMatch(/sandbox mailbox/i)
    expect(points.textContent).toMatch(/full editor/i)
    expect(points.textContent).toMatch(/reply classification/i)
    expect(points.textContent).toMatch(/unsubscribe/i)
  })
})
