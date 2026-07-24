import type { AirportPickupEvent, AirportPickupTaskState } from '@canvasflow/schema'
import {
  buildLandingNotifyContent,
  createMessagePreparer,
  createMessageSender,
  resolveAuthorizedLandingContact,
  type SideEffectRuntime,
} from '@canvasflow/tools'

export const RETRY_LANDING_MESSAGE_ACTION_ID = 'retry-landing-message'
export const CONFIRM_RETRY_LANDING_MESSAGE_ACTION_ID = 'confirm-retry-landing-message'

export function retryLandingMessageActionToken(taskId: string): string {
  return `${taskId}:${RETRY_LANDING_MESSAGE_ACTION_ID}`
}

/**
 * Arm an explicit send-message confirmation after a failed landing notify.
 * Does not send; uses runtime preferences + opaque prepare confirmation.
 */
export function armLandingMessageRetry(
  task: AirportPickupTaskState,
  runtime: SideEffectRuntime,
): AirportPickupTaskState | undefined {
  if (task.message.status !== 'failed' || !task.flight) return undefined
  const contactId = resolveAuthorizedLandingContact(task.passengers.memberIds, runtime.preferences)
  if (!contactId) return undefined

  const prepared = createMessagePreparer(runtime)(
    { taskId: task.taskId },
    { contactId, flightNumber: task.flight.flightNumber, eta: '20:40' },
  )
  if (!prepared.ok || !prepared.data) return undefined

  return {
    ...task,
    taskRevision: task.taskRevision + 1,
    message: {
      ...task.message,
      pendingContactId: contactId,
      pendingMessageId: `${task.flight.flightNumber}:landing`,
      idempotencyKey: prepared.data.messageId,
    },
    pendingConfirmation: {
      confirmationId: prepared.data.confirmationId,
      action: 'send-message',
    },
  }
}

export type LandingMessageRetryResolution =
  | { decision: 'reject'; task: AirportPickupTaskState }
  | {
      decision: 'accept'
      task: AirportPickupTaskState
      event: AirportPickupEvent
      sendSucceeded: boolean
    }

/**
 * Resolve a pending send-message confirmation.
 * Accept prepares an armed task + receipt event for the caller to apply;
 * reject only clears the confirmation boundary.
 */
export function resolveLandingMessageRetry(
  task: AirportPickupTaskState,
  runtime: SideEffectRuntime,
  confirmationId: string,
  decision: 'accept' | 'reject',
  timestamp: string,
): LandingMessageRetryResolution | undefined {
  const pending = task.pendingConfirmation
  if (
    task.message.status !== 'failed'
    || !task.flight
    || pending?.action !== 'send-message'
    || pending.confirmationId !== confirmationId
  ) {
    return undefined
  }

  if (decision === 'reject') {
    return {
      decision: 'reject',
      task: {
        ...task,
        taskRevision: task.taskRevision + 1,
        pendingConfirmation: undefined,
        updatedAt: timestamp,
      },
    }
  }

  const contactId = task.message.pendingContactId
    ?? resolveAuthorizedLandingContact(task.passengers.memberIds, runtime.preferences)
  if (!contactId) return undefined

  const content = buildLandingNotifyContent(task.taskId, contactId, task.flight.flightNumber, '20:40')
  const pendingMessageId = task.message.pendingMessageId ?? `${task.flight.flightNumber}:landing`
  const armed: AirportPickupTaskState = {
    ...task,
    pendingConfirmation: undefined,
    message: {
      ...task.message,
      status: 'scheduled',
      pendingMessageId,
      pendingContactId: contactId,
      idempotencyKey: content.messageId,
      landingNoticeSent: false,
    },
  }

  const sent = createMessageSender(runtime)(
    { taskId: task.taskId },
    {
      ...content,
      confirmationId,
      idempotencyKey: `${content.messageId}:retry`,
    },
  )

  if (!sent.ok) {
    return {
      decision: 'accept',
      task: armed,
      sendSucceeded: false,
      event: {
        eventId: `retry-failed-${task.taskRevision}`,
        type: 'message.failed',
        messageId: pendingMessageId,
        errorCode: sent.error?.code ?? 'SEND_FAILED',
        timestamp,
      },
    }
  }

  return {
    decision: 'accept',
    task: armed,
    sendSucceeded: true,
    event: {
      eventId: `retry-sent-${task.taskRevision}`,
      type: 'message.sent',
      messageId: pendingMessageId,
      timestamp,
    },
  }
}
