import { describe, expect, it } from 'vitest'
import {
  buildLandingNotifyContent,
  createMessagePreparer,
  createSideEffectRuntime,
} from '@canvasflow/tools'
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
        scheduledArrival: '2026-07-22T20:30:00+08:00',
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
    const prepared = createMessagePreparer(runtime)(
      { taskId: task.taskId },
      { contactId: 'contact-mom', flightNumber: 'CA1831', eta: '21:15' },
    )
    const armed = armLandingMessageRetry(task, prepared.data!)
    expect(armed?.pendingConfirmation?.action).toBe('send-message')

    const resolved = resolveLandingMessageRetry(
      armed!,
      {
        confirmationId: armed!.pendingConfirmation!.confirmationId,
        decision: 'accept',
        timestamp: '2026-07-22T21:16:00+08:00',
      },
    )
    expect(resolved).toMatchObject({
      decision: 'accept',
      event: { type: 'message.sent', messageId: prepared.data!.messageId },
    })
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
    const prepared = createMessagePreparer(runtime)(
      { taskId: task.taskId },
      { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:55' },
    )
    const armed = armLandingMessageRetry(task, prepared.data!)
    expect(armed).toBeDefined()
    const resolved = resolveLandingMessageRetry(
      armed!,
      {
        confirmationId: armed!.pendingConfirmation!.confirmationId,
        decision: 'accept',
        timestamp: '2026-07-22T20:56:00+08:00',
      },
    )
    expect(resolved).toMatchObject({
      decision: 'accept',
      event: { type: 'message.sent', messageId: prepared.data!.messageId },
    })
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

describe('landing-message retry confirmation lifecycle', () => {
  function failedLandingTask() {
    return {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
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
        landingNoticeSent: false,
        pendingContactId: 'contact-mom',
      },
    }
  }

  it('clears the pending confirmation on reject without reporting a send event', () => {
    const runtime = createSideEffectRuntime()
    const prepared = createMessagePreparer(runtime)(
      { taskId: 'pickup-001' },
      { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:40' },
    )
    const armed = armLandingMessageRetry(failedLandingTask(), prepared.data!)
    expect(armed?.pendingConfirmation?.confirmationId).toBeTruthy()
    const confirmationId = armed!.pendingConfirmation!.confirmationId

    const rejected = resolveLandingMessageRetry(
      armed!,
      { confirmationId, decision: 'reject', timestamp: '2026-07-22T20:42:00+08:00' },
    )
    expect(rejected).toMatchObject({ decision: 'reject' })
    expect(rejected?.task.pendingConfirmation).toBeUndefined()
    expect(rejected?.task.message).toMatchObject({ pendingMessageId: undefined, pendingText: undefined })
  })

  it('commits the exact provider-prepared message identity', () => {
    const runtime = createSideEffectRuntime()
    const prepared = createMessagePreparer(runtime)(
      { taskId: 'pickup-001' },
      { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:40' },
    )
    const armed = armLandingMessageRetry(failedLandingTask(), prepared.data!)
    expect(armed?.message).toMatchObject({
      pendingContactId: prepared.data!.contactId,
      pendingMessageId: prepared.data!.messageId,
      idempotencyKey: prepared.data!.messageId,
    })
  })

  it('projects a failed confirmed send into the reducer event without executing a provider', () => {
    const content = buildLandingNotifyContent('pickup-001', 'contact-mom', 'MU5102', '20:40')
    const confirmationId = 'cnf-retry'
    const armed = {
      ...failedLandingTask(),
      message: {
        ...failedLandingTask().message,
        pendingContactId: content.contactId,
        pendingMessageId: content.messageId,
        idempotencyKey: content.messageId,
      },
      pendingConfirmation: {
        confirmationId,
        action: 'send-message' as const,
      },
    }

    const resolved = resolveLandingMessageRetry(
      armed,
      {
        confirmationId,
        decision: 'accept',
        timestamp: '2026-07-22T20:42:00+08:00',
        sendSucceeded: false,
        errorCode: 'SEND_FAILED',
      },
    )
    expect(resolved).toMatchObject({
      decision: 'accept',
      event: { type: 'message.failed', messageId: content.messageId, errorCode: 'SEND_FAILED' },
    })
  })
})
