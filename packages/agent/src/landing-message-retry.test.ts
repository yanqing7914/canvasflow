import { describe, expect, it } from 'vitest'
import { createSideEffectRuntime } from '@canvasflow/tools'
import { createInitialTask } from './index'
import {
  armLandingMessageRetry,
  resolveLandingMeetingEta,
  resolveLandingMessageRetry,
} from './landing-message-retry'

const timestamp = '2026-07-22T20:41:00+08:00'

describe('landing-message retry ETA', () => {
  it('derives meeting ETA from a non-20:40 flight when no route ETA exists', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: {
        flightNumber: 'CA1831',
        status: 'landed' as const,
        scheduledArrival: '2026-07-22T21:15:00+08:00',
        estimatedArrival: '2026-07-22T21:15:00+08:00',
        terminal: 'T2',
      },
      message: {
        ...createInitialTask().message,
        status: 'failed' as const,
        landingNoticeSent: false,
        pendingContactId: 'contact-mom',
      },
    }

    expect(resolveLandingMeetingEta(task)).toBe('21:15')

    const runtime = createSideEffectRuntime()
    const armed = armLandingMessageRetry(task, runtime)
    expect(armed?.pendingConfirmation?.action).toBe('send-message')

    const resolved = resolveLandingMessageRetry(
      armed!,
      runtime,
      armed!.pendingConfirmation!.confirmationId,
      'accept',
      '2026-07-22T21:16:00+08:00',
    )
    // Prepare and confirm must share the derived 21:15 ETA or the payload-bound token fails.
    expect(resolved).toMatchObject({ decision: 'accept', sendSucceeded: true })
  })

  it('prefers route ETA over flight arrival when both exist', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      navigation: {
        routeId: 'route-airport-001',
        destination: '虹桥机场 T2',
        eta: '2026-07-22T20:55:00+08:00',
        status: 'active' as const,
      },
      flight: {
        flightNumber: 'MU5102',
        status: 'landed' as const,
        scheduledArrival: '2026-07-22T20:30:00+08:00',
        estimatedArrival: '2026-07-22T20:40:00+08:00',
        terminal: 'T2',
      },
      message: {
        ...createInitialTask().message,
        status: 'failed' as const,
        pendingContactId: 'contact-mom',
      },
    }
    expect(resolveLandingMeetingEta(task)).toBe('20:55')

    const runtime = createSideEffectRuntime()
    const armed = armLandingMessageRetry(task, runtime)
    expect(armed).toBeDefined()
    const resolved = resolveLandingMessageRetry(
      armed!,
      runtime,
      armed!.pendingConfirmation!.confirmationId,
      'accept',
      '2026-07-22T20:56:00+08:00',
    )
    expect(resolved).toMatchObject({ decision: 'accept', sendSucceeded: true })
  })

  it('omits meeting ETA when neither route nor flight ETA is available', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      flight: undefined,
      navigation: undefined,
    }
    expect(resolveLandingMeetingEta(task)).toBeUndefined()
  })
})
