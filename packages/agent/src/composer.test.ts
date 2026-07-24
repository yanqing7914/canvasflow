import { describe, expect, it } from 'vitest'
import { composeAgentSpec } from './composer'
import { applyEvent, createInitialTask } from './index'
import { ReadToolOrchestrator } from './orchestration'

const timestamp = '2026-07-22T20:00:00+08:00'

describe('Agent UISpec composer', () => {
  it('combines provider-backed flight, route, and charging cards while preparing', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    expect(composeAgentSpec(task, reads.toolResults).components.map((component) => component.type)).toEqual([
      'flight-status', 'navigation-summary', 'charging-recommendation',
    ])
  })

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
