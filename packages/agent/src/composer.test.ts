import { describe, expect, it } from 'vitest'
import { composeAgentSpec } from './composer'
import { applyEvent, createInitialTask } from './index'

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

  it('projects a failed landing notification into an explicit retry action', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' as const },
      message: { ...createInitialTask().message, status: 'failed' as const, landingNoticeSent: false },
    }

    expect(composeAgentSpec(task)).toMatchObject({
      title: '落地通知失败',
      presentation: { density: 'minimal', priority: 'high' },
      components: [{
        id: 'message-preview',
        type: 'message-preview',
        props: { status: 'failed', cancellable: false },
        actions: ['retry-landing-message'],
      }],
      actions: [{
        id: 'retry-landing-message',
        event: { type: 'tool-request', actionToken: 'pickup-001:retry-landing-message' },
      }],
    })
  })

  it('projects a failed landing notification into an explicit retry action', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'landed' as const, estimatedArrival: timestamp, terminal: 'T2' },
      message: { ...createInitialTask().message, status: 'failed' as const, landingNoticeSent: false },
    }

    expect(composeAgentSpec(task)).toMatchObject({
      title: '落地通知失败',
      presentation: { density: 'minimal', priority: 'high' },
      components: [{
        id: 'message-preview',
        type: 'message-preview',
        props: { status: 'failed', cancellable: false },
        actions: ['retry-landing-message'],
      }],
      actions: [{
        id: 'retry-landing-message',
        event: { type: 'tool-request', actionToken: 'pickup-001:retry-landing-message' },
      }],
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

  it('does not retain a landing notification after task cancellation', () => {
    const scheduled = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      message: { ...createInitialTask().message, status: 'scheduled' as const, pendingMessageId: 'MU5102:landing' },
    }
    const cancelled = applyEvent(scheduled, { eventId: 'cancel', type: 'user.cancelled-task', timestamp: '2026-07-22T20:01:00+08:00' })

    expect(cancelled.message).toMatchObject({ status: 'cancelled', pendingMessageId: undefined })
    expect(composeAgentSpec(cancelled)).toMatchObject({
      title: '接机任务已取消',
      components: [{ type: 'status-banner', props: { title: '接机任务已取消' } }],
    })
  })
})
