import { describe, expect, it } from 'vitest'
import {
  createMessagePreparer,
  createMessageSender,
  createSideEffectRuntime,
  FAILING_CONTACT_ID,
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

  it('revokes the opaque grant on reject so a retained confirmationId cannot send', () => {
    const runtime = createSideEffectRuntime()
    const armed = armLandingMessageRetry(failedLandingTask(), runtime)
    expect(armed?.pendingConfirmation?.confirmationId).toBeTruthy()
    const confirmationId = armed!.pendingConfirmation!.confirmationId

    const rejected = resolveLandingMessageRetry(
      armed!,
      runtime,
      confirmationId,
      'reject',
      '2026-07-22T20:42:00+08:00',
    )
    expect(rejected).toMatchObject({ decision: 'reject' })
    expect(rejected?.task.pendingConfirmation).toBeUndefined()

    const staleSend = createMessageSender(runtime)(
      { taskId: 'pickup-001' },
      {
        contactId: 'contact-mom',
        messageId: 'pickup-001:MU5102:landing',
        text: '我已到达机场接机点，航班 MU5102，预计 20:40 会合。',
        confirmationId,
        idempotencyKey: 'pickup-001:MU5102:landing:stale-after-reject',
      },
    )
    expect(staleSend.ok).toBe(false)
    expect(staleSend.error?.code).toBe('AUTHORIZATION_REQUIRED')
  })

  it('revokes a superseded confirmation when re-arming retry', () => {
    const runtime = createSideEffectRuntime()
    const first = armLandingMessageRetry(failedLandingTask(), runtime)
    const firstId = first!.pendingConfirmation!.confirmationId
    const second = armLandingMessageRetry(first!, runtime)
    const secondId = second!.pendingConfirmation!.confirmationId
    expect(secondId).not.toBe(firstId)

    const staleSend = createMessageSender(runtime)(
      { taskId: 'pickup-001' },
      {
        contactId: 'contact-mom',
        messageId: 'pickup-001:MU5102:landing',
        text: '我已到达机场接机点，航班 MU5102，预计 20:40 会合。',
        confirmationId: firstId,
        idempotencyKey: 'pickup-001:MU5102:landing:stale-after-supersede',
      },
    )
    expect(staleSend.error?.code).toBe('AUTHORIZATION_REQUIRED')
  })

  it('revokes the grant after a failed confirmed send so the UI must re-arm', () => {
    const runtime = createSideEffectRuntime()
    const prepared = createMessagePreparer(runtime)(
      { taskId: 'pickup-001' },
      { contactId: FAILING_CONTACT_ID, flightNumber: 'MU5102', eta: '20:40' },
    )
    expect(prepared.ok).toBe(true)
    const confirmationId = prepared.data!.confirmationId
    const armed = {
      ...failedLandingTask(),
      message: {
        ...failedLandingTask().message,
        pendingContactId: FAILING_CONTACT_ID,
        pendingMessageId: 'MU5102:landing',
        idempotencyKey: prepared.data!.messageId,
      },
      pendingConfirmation: {
        confirmationId,
        action: 'send-message' as const,
      },
    }

    const resolved = resolveLandingMessageRetry(
      armed,
      runtime,
      confirmationId,
      'accept',
      '2026-07-22T20:42:00+08:00',
    )
    expect(resolved).toMatchObject({ decision: 'accept', sendSucceeded: false })

    const staleSend = createMessageSender(runtime)(
      { taskId: 'pickup-001' },
      {
        contactId: FAILING_CONTACT_ID,
        messageId: prepared.data!.messageId,
        text: prepared.data!.text,
        confirmationId,
        idempotencyKey: 'pickup-001:MU5102:landing:stale-after-failed-accept',
      },
    )
    expect(staleSend.error?.code).toBe('AUTHORIZATION_REQUIRED')
  })
})