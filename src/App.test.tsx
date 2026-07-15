import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

describe('App', () => {
  it('renders the CanvasFlow workspace', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'CanvasFlow' })).toBeInTheDocument()
    expect(screen.getByText(/review confidence/i)).toBeInTheDocument()
  })

  it('adds a generated flow step once', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /generate flow/i }))
    await user.click(screen.getByRole('button', { name: /generate flow/i }))

    expect(screen.getAllByText('Adaptive checkout canvas')).toHaveLength(1)
  })
})

