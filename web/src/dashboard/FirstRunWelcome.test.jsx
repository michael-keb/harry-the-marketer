import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import FirstRunWelcome from './FirstRunWelcome.jsx'

describe('FirstRunWelcome', () => {
  it('releases the first-timer with the next two actions', () => {
    render(
      <MemoryRouter>
        <FirstRunWelcome planId="starter" name="Ada Lovelace" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: /ada, your workspace is ready/i })).toBeInTheDocument()
    expect(screen.getByText(/starter trial/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /create a campaign/i })).toHaveAttribute('href', '/app/campaigns?new=1')
    expect(screen.getByRole('link', { name: /sandbox mailbox/i }))
      .toHaveAttribute('href', '/app/connections?area=email&add=sandbox')
  })
})
