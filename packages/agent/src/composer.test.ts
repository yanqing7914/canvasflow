import { describe, expect, it } from 'vitest'
import { memberPreferences } from '@canvasflow/tools'
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
      flight: { flightNumber: 'MU5102', status: 'landed' as const, scheduledArrival: timestamp, estimatedArrival: timestamp, terminal: 'T2' },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' as const },
      message: {
        ...createInitialTask().message,
        status: 'failed' as const,
        landingNoticeSent: false,
        pendingContactId: 'contact-mom',
      },
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

  it('surfaces unavailable state when failed notify has no authorized contact', () => {
    const preferences = {
      ...memberPreferences,
      mom: { ...memberPreferences.mom, landingNotificationAuthorized: false },
    }
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'landed' as const, scheduledArrival: timestamp, estimatedArrival: timestamp, terminal: 'T2' },
      message: {
        ...createInitialTask().message,
        status: 'failed' as const,
        landingNoticeSent: false,
        pendingContactId: 'contact-mom',
      },
    }

    expect(composeAgentSpec(task, preferences)).toMatchObject({
      title: '落地通知失败',
      components: [{
        type: 'status-banner',
        props: {
          level: 'error',
          title: '无法重试发送',
          message: '没有已授权的落地通知联系人',
        },
      }],
      actions: [],
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

  it('keeps original scheduledArrival separate from delayed estimatedArrival', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: {
        flightNumber: 'MU5102',
        status: 'delayed' as const,
        scheduledArrival: '2026-07-22T20:30:00+08:00',
        estimatedArrival: '2026-07-22T21:10:00+08:00',
        terminal: 'T1',
      },
    }

    expect(composeAgentSpec(task)).toMatchObject({
      components: [{
        type: 'flight-status',
        props: {
          status: 'delayed',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T21:10:00+08:00',
          terminal: 'T1',
        },
      }],
    })
  })

  it('surfaces delayed and cancelled flight status over active navigation', () => {
    for (const status of ['delayed', 'cancelled'] as const) {
      const task = {
        ...createInitialTask('pickup-001', timestamp),
        phase: 'driving-to-airport' as const,
        passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
        flight: {
          flightNumber: 'MU5102',
          status,
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: status === 'delayed' ? '2026-07-22T21:10:00+08:00' : '2026-07-22T20:30:00+08:00',
          terminal: status === 'delayed' ? 'T1' : 'T2',
        },
        navigation: {
          routeId: 'route-airport-001',
          destination: '虹桥机场 T2',
          eta: '2026-07-22T20:25:00+08:00',
          status: 'active' as const,
        },
      }

      const spec = composeAgentSpec(task)
      expect(spec.components).toMatchObject([{
        type: 'flight-status',
        props: {
          status,
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: status === 'delayed' ? '2026-07-22T21:10:00+08:00' : '2026-07-22T20:30:00+08:00',
        },
      }])
      expect(spec.components.map((component) => component.type)).not.toContain('navigation-summary')
    }
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
