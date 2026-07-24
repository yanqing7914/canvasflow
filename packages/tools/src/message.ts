import {
  messagePrepareInputSchema,
  messagePrepareOutputSchema,
  messageSendInputSchema,
  messageSendOutputSchema,
  type MessagePrepareOutput,
  type MessageSendOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { familyMembers } from './data'
import type { MessageSendBinding, SideEffectRuntime } from './idempotency'
import { errorResult, FIXTURE_GENERATED_AT, okResult, type ToolContext } from './result'

const PREPARE = 'message.prepare'
const SEND = 'message.send'

/** Fixture contact that deterministically fails send. */
export const FAILING_CONTACT_ID = 'contact-fail'

/** Issue an opaque, one-time confirmation for an explicit send / retry. */
export function issueSendMessageConfirmation(runtime: SideEffectRuntime, binding: MessageSendBinding): string {
  return runtime.confirmations.issueSendMessageConfirmation(binding)
}

/** Issue an opaque auto-notify capability grant for a task (not forgeable from taskId). */
export function issueAutoNotifyAuthorization(runtime: SideEffectRuntime, taskId: string): string {
  return runtime.confirmations.issueAutoNotifyAuthorization(taskId)
}

/**
 * Prepare a landing message and mint a single-use confirmation bound to the
 * prepared contactId / messageId / text. Callers pass the returned
 * `confirmationId` to `message.send` (auto-notify still works without it).
 */
export function createMessagePreparer(runtime: SideEffectRuntime) {
  return function prepareMessage(ctx: ToolContext, input: unknown): ToolResult<MessagePrepareOutput> {
    const parsed = messagePrepareInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, PREPARE, 'INVALID_ARGUMENT', '需要 contactId 和 flightNumber', false)
    }

    const known = familyMembers.some((member) => member.contactId === parsed.data.contactId)
    if (!known && parsed.data.contactId !== FAILING_CONTACT_ID) {
      return errorResult(ctx, PREPARE, 'AUTHORIZATION_REQUIRED', `联系人未授权：${parsed.data.contactId}`, false)
    }

    const eta = parsed.data.eta ?? '即将到达'
    const text = `我已到达机场接机点，航班 ${parsed.data.flightNumber.toUpperCase()}，预计 ${eta} 会合。`
    const messageId = `${ctx.taskId}:${parsed.data.flightNumber.toUpperCase()}:landing`
    const confirmationId = runtime.confirmations.issueSendMessageConfirmation({
      taskId: ctx.taskId,
      contactId: parsed.data.contactId,
      messageId,
      text,
    })
    return okResult(
      ctx,
      PREPARE,
      messagePrepareOutputSchema.parse({
        messageId,
        contactId: parsed.data.contactId,
        text,
        confirmationId,
      }),
    )
  }
}

export function createMessageSender(runtime: SideEffectRuntime) {
  return function sendMessage(ctx: ToolContext, input: unknown): ToolResult<MessageSendOutput> {
    const parsed = messageSendInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, SEND, 'INVALID_ARGUMENT', '需要 contactId、messageId、text 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<MessageSendOutput>(ctx.taskId, SEND, parsed.data.idempotencyKey, parsed.data)
    if (cached.kind === 'hit') return cached.result
    if (cached.kind === 'conflict') {
      return errorResult(ctx, SEND, 'INVALID_ARGUMENT', '同一 idempotencyKey 已被不同请求参数使用', false)
    }

    const binding: MessageSendBinding = {
      taskId: ctx.taskId,
      contactId: parsed.data.contactId,
      messageId: parsed.data.messageId,
      text: parsed.data.text,
    }

    // 凭据必须由 runtime 签发：预授权路径还要求联系人对应成员开启了落地通知授权；
    // 显式确认路径使用一次性 opaque token，绑定到具体消息。
    const member = familyMembers.find((candidate) => candidate.contactId === parsed.data.contactId)
    const autoNotifyGranted =
      parsed.data.authorizationId !== undefined &&
      runtime.confirmations.matchesAutoNotifyAuthorization(parsed.data.authorizationId, ctx.taskId) &&
      member !== undefined &&
      Object.hasOwn(runtime.preferences, member.memberId) &&
      runtime.preferences[member.memberId]?.landingNotificationAuthorized === true
    const confirmationValid =
      parsed.data.confirmationId !== undefined &&
      runtime.confirmations.matchesSendMessageConfirmation(parsed.data.confirmationId, binding)
    if (!autoNotifyGranted && !confirmationValid) {
      return errorResult(ctx, SEND, 'AUTHORIZATION_REQUIRED', '发送消息需要任务绑定的预授权或本次确认', false)
    }

    if (parsed.data.contactId === FAILING_CONTACT_ID) {
      // Do not cache failures and do not consume the confirmation — caller may retry.
      return errorResult<MessageSendOutput>(ctx, SEND, 'SEND_FAILED', '消息发送失败', false)
    }

    const known = familyMembers.some((entry) => entry.contactId === parsed.data.contactId)
    if (!known) {
      return errorResult(ctx, SEND, 'AUTHORIZATION_REQUIRED', `联系人未授权：${parsed.data.contactId}`, false)
    }

    if (!autoNotifyGranted) {
      if (!runtime.confirmations.consumeSendMessageConfirmation(parsed.data.confirmationId!, binding)) {
        return errorResult(ctx, SEND, 'AUTHORIZATION_REQUIRED', '发送消息需要任务绑定的预授权或本次确认', false)
      }
    }

    const result = okResult(
      ctx,
      SEND,
      messageSendOutputSchema.parse({
        messageId: parsed.data.messageId,
        status: 'sent',
        sentAt: FIXTURE_GENERATED_AT,
      }),
    )
    runtime.idempotency.set(ctx.taskId, SEND, parsed.data.idempotencyKey, parsed.data, result)
    return result
  }
}
