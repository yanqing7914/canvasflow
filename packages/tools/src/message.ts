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
import type { SideEffectRuntime } from './idempotency'
import { errorResult, FIXTURE_GENERATED_AT, okResult, type ToolContext } from './result'

const PREPARE = 'message.prepare'
const SEND = 'message.send'

/** Fixture contact that deterministically fails send. */
export const FAILING_CONTACT_ID = 'contact-fail'

export function prepareMessage(ctx: ToolContext, input: unknown): ToolResult<MessagePrepareOutput> {
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
  return okResult(
    ctx,
    PREPARE,
    messagePrepareOutputSchema.parse({
      messageId,
      contactId: parsed.data.contactId,
      text,
    }),
  )
}

export function createMessageSender(runtime: SideEffectRuntime) {
  return function sendMessage(ctx: ToolContext, input: unknown): ToolResult<MessageSendOutput> {
    const parsed = messageSendInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, SEND, 'INVALID_ARGUMENT', '需要 contactId、messageId、text 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<MessageSendOutput>(parsed.data.idempotencyKey)
    if (cached) return cached

    if (!parsed.data.authorizationId && !parsed.data.confirmationId) {
      return errorResult(ctx, SEND, 'AUTHORIZATION_REQUIRED', '发送消息需要预授权或本次确认', false)
    }

    if (parsed.data.contactId === FAILING_CONTACT_ID) {
      const failed = errorResult<MessageSendOutput>(ctx, SEND, 'SEND_FAILED', '消息发送失败', false)
      // Do not cache failures — contract: no auto-retry, but user may retry with a new key.
      return failed
    }

    const known = familyMembers.some((member) => member.contactId === parsed.data.contactId)
    if (!known) {
      return errorResult(ctx, SEND, 'AUTHORIZATION_REQUIRED', `联系人未授权：${parsed.data.contactId}`, false)
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
    runtime.idempotency.set(parsed.data.idempotencyKey, result)
    return result
  }
}
