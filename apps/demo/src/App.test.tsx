import { describe, expect, it } from 'vitest'
import { createInitialTask } from '@canvasflow/agent'
import { composePickupSpec } from '@canvasflow/ui'

describe('demo integration', () => {
  it('composes a valid UI from task state', () => {
    const spec = composePickupSpec(createInitialTask())
    expect(spec.surfaceId).toBe('airport-pickup-main')
    expect(spec.meta.sourceTaskRevision).toBe(spec.taskRevision)
  })

  it('includes the current initial phase in progress', () => {
    const spec = composePickupSpec(createInitialTask())
    const progress = spec.components.find((component) => component.type === 'task-progress')
    expect(progress?.props.steps[0]).toMatchObject({ phase: 'collecting-information', status: 'active' })
  })

  it('includes completed and cancelled terminal phases in progress', () => {
    for (const phase of ['completed', 'cancelled'] as const) {
      const spec = composePickupSpec({ ...createInitialTask(), phase })
      const progress = spec.components.find((component) => component.type === 'task-progress')
      expect(progress?.props.steps.some((step) => step.phase === phase && step.status === 'active')).toBe(true)
    }
  })
})
