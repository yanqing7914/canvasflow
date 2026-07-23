import { describe, expect, it } from 'vitest'
import { createInitialTask } from '@canvasflow/agent'
import { composePickupSpec } from '@canvasflow/ui'

describe('demo integration', () => {
  it('composes a valid UI from task state', () => {
    const spec = composePickupSpec(createInitialTask())
    expect(spec.surfaceId).toBe('airport-pickup-main')
    expect(spec.meta.sourceTaskRevision).toBe(spec.taskRevision)
  })
})
