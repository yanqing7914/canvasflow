import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { createInitialTask } from '@canvasflow/agent'
import { composePickupSpec } from '@canvasflow/ui'

describe('demo integration', () => {
  it('composes a valid UI from task state', () => {
    const spec = composePickupSpec(createInitialTask())
    expect(spec.surfaceId).toBe('airport-pickup-main')
    expect(spec.meta.sourceTaskRevision).toBe(spec.taskRevision)
  })

  it('shows the information request for the initial phase', () => {
    const spec = composePickupSpec(createInitialTask())
    expect(spec.components[0]).toMatchObject({ type: 'status-banner', props: { title: '请补充航班号' } })
  })

  it('includes completed and cancelled terminal phases in progress', () => {
    for (const phase of ['completed', 'cancelled'] as const) {
      const spec = composePickupSpec({ ...createInitialTask(), phase })
      const progress = spec.components.find((component) => component.type === 'task-progress')
      expect(progress?.props.steps.some((step) => step.phase === phase && step.status === 'active')).toBe(true)
    }
  })

  it('keeps UI revisions ahead of task revisions', () => {
    const first = composePickupSpec(createInitialTask())
    const second = composePickupSpec({ ...createInitialTask(), taskRevision: 2, uiRevision: first.uiRevision })
    expect(second.uiRevision).toBeGreaterThan(first.uiRevision)
  })

  it('advances the rendered demo and disables terminal controls', async () => {
    const user = userEvent.setup()
    render(<App />)
    const advance = screen.getByRole('button', { name: '推进下一事件' })
    expect(screen.getByText(/preparing/)).toBeInTheDocument()
    await user.click(advance)
    expect(screen.getByText(/driving-to-airport/)).toBeInTheDocument()
  })
})
