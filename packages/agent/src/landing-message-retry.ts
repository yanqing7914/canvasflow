import type { AirportPickupEvent, AirportPickupTaskState } from '@canvasflow/schema'
import {
  buildLandingNotifyContent,
  resolveAuthorizedLandingContact,
  type MemberPreferenceRecord,
} from '@canvasflow/tools'

export const RETRY_LANDING_MESSAGE_ACTION_ID = 'retry-landing-message'
export const CONFIRM_RETRY_LANDING_MESSAGE_ACTION_ID = 'confirm-retry-landing-message'

export function retryLandingMessageActionToken(taskId: string): string {
  return `${taskId}:${RETRY_LANDING_MESSAGE_ACTION_ID}`
}

/**
 * Meeting ETA label (HH:mm) for landing-notify copy.
 * Prefer active route ETA, then flight estimated arrival; omit when neither is reliable.
 */
export function resolveLandingMeetingEta(task: AirportPickupTaskState): string | undefined {
  const iso = task.navigation?.eta ?? task.flight?.estimatedArrival
  if (!iso || Number.isNaN(Date.parse(iso))) return undefined
  const match = /T(\d{2}):(\d{2})/.exec(iso)
  return match ? `${match[1]}:${match[2]}` : undefined
}

/** True when failed landing notify can be armed for an authorized contact. */
export function canRetryLandingMessage(
  task: AirportPickupTaskState,
  preferences: Record<string, MemberPreferenceRecord>,
): boolean {
  return (
    task.message.status === 'failed'
    && Boolean(task.flight)
    && resolveAuthorizedLandingContact(task.passengers.memberIds, preferences) !== undefined
  )
}

/**
 * Commit a provider-prepared retry confirmation after a failed landing notify.
 * Provider execution and validation belong to EffectExecutor; this helper only
 * applies the already-validated receipt to task state.
 */
export function armLandingMessageRetry(
  task: AirportPickupTaskState,
  prepared: {
    contactId: string
    messageId: string
    text: string
    confirmationId: string
  },
): AirportPickupTaskState | undefined {
  if (task.message.status !== 'failed' || !task.flight) return undefined

  return {
    ...task,
    taskRevision: task.taskRevision + 1,
    message: {
      ...task.message,
      pendingContactId: prepared.contactId,
      pendingMessageId: prepared.messageId,
      pendingText: prepared.text,
      idempotencyKey: prepared.messageId,
    },
    pendingConfirmation: {
      confirmationId: prepared.confirmationId,
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
    }

type RetryResolutionInput = {
  confirmationId: string
  decision: 'accept' | 'reject'
  timestamp: string
  sendSucceeded?: boolean
  errorCode?: string
}

/**
 * Resolve a pending send-message confirmation.
 * Accept prepares an armed task + receipt event for the caller to apply after
 * EffectExecutor has successfully sent; reject only closes task state. */
export function resolveLandingMessageRetry(
  task: AirportPickupTaskState,
  input: RetryResolutionInput,
): LandingMessageRetryResolution | undefined {
  const { confirmationId, decision, timestamp } = input
  const sendSucceeded = input.sendSucceeded ?? true
  const errorCode = input.errorCode ?? 'SEND_FAILED'
  const pending = task.pendingConfirmation
  // 'failed' is the retry window; 'scheduled' is a prepared message (the
  // proactive umbrella reminder) already waiting on this same confirmation.
  if (
    (task.message.status !== 'failed' && task.message.status !== 'scheduled')
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
        message: {
          ...task.message,
          // A rejected prepared message frees the slot entirely; a rejected
          // retry keeps its failed status for the next retry offer.
          ...(task.message.status === 'scheduled' ? { status: 'idle' as const, pendingContactId: undefined } : {}),
          pendingMessageId: undefined,
          pendingText: undefined,
          idempotencyKey: undefined,
        },
        updatedAt: timestamp,
      },
    }
  }

  const contactId = task.message.pendingContactId
  if (!contactId) return undefined

  const content = task.message.pendingText
    ? {
        contactId,
        messageId: task.message.pendingMessageId ?? `${task.taskId}:${task.flight.flightNumber}:landing`,
        text: task.message.pendingText,
      }
    : buildLandingNotifyContent(
        task.taskId,
        contactId,
        task.flight.flightNumber,
        resolveLandingMeetingEta(task) ?? '即将到达',
      )
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

  if (!sendSucceeded) {
    return {
      decision: 'accept',
      task: armed,
      event: {
        eventId: `retry-failed-${task.taskRevision}`,
        type: 'message.failed',
        messageId: pendingMessageId,
        errorCode,
        timestamp,
      },
    }
  }

  return {
    decision: 'accept',
    task: armed,
    event: {
      eventId: `retry-sent-${task.taskRevision}`,
      type: 'message.sent',
      messageId: pendingMessageId,
      timestamp,
    },
  }
}
