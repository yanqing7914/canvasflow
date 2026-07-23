import { describe, expect, it } from 'vitest'
import { composeAgentSpec } from './composer'
import { createInitialTask } from './index'

const timestamp = '2026-07-22T20:00:00+08:00'

describe('Agent UISpec composer', () => {
  it('projects a scheduled landing notification into a cancellable message preview', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      message: { ...createInitialTask().message, status: 'scheduled' as const, pendingMessageId: 'MU5102:landing' },
    }

    expect(composeAgentSpec(task)).toMatchObject({
      presentation: { density: 'minimal', priority: 'high' },
      components: [{ type: 'message-preview', props: { cancellable: true } }],
    })
  })

  it('projects the completion confirmation into a confirmation action', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'completed' as const,
      pendingConfirmation: { confirmationId: 'pickup-001:save-memory', action: 'save-memory' as const },
    }

    expect(composeAgentSpec(task)).toMatchObject({
      meta: { requiresConfirm: true },
      actions: [{ event: { type: 'confirmation', confirmationId: 'pickup-001:save-memory', decision: 'accept' } }],
    })
  })
})
