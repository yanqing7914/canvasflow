import {
  confirmMemoryUpdateInputSchema,
  confirmMemoryUpdateOutputSchema,
  proposeMemoryUpdateInputSchema,
  proposeMemoryUpdateOutputSchema,
  type ConfirmMemoryUpdateOutput,
  type ProposeMemoryUpdateOutput,
  type ToolResult,
} from '@canvasflow/schema'
import type { SideEffectRuntime } from './idempotency'
import { errorResult, okResult, type ToolContext } from './result'

const PROPOSE = 'memory.propose-update'
const CONFIRM = 'memory.confirm-update'

const MEMORY_WHITELIST = [
  'rearTemperatureC',
  'mediaTitle',
  'homeDestinationId',
  'landingNotificationAuthorized',
] as const

const PROPOSAL_TTL_MS = 30 * 60 * 1000

function pickWhitelist(changes: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of MEMORY_WHITELIST) {
    if (changes[key] !== undefined) picked[key] = changes[key]
  }
  return picked
}

export function createMemoryWriteTools(runtime: SideEffectRuntime) {
  function proposeMemoryUpdate(ctx: ToolContext, input: unknown): ToolResult<ProposeMemoryUpdateOutput> {
    const parsed = proposeMemoryUpdateInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, PROPOSE, 'INVALID_ARGUMENT', '需要 memberId 和 changes', false)
    }

    const record = runtime.preferences[parsed.data.memberId]
    if (!record) {
      return errorResult(ctx, PROPOSE, 'PREFERENCE_UNAVAILABLE', `无可用偏好：${parsed.data.memberId}`, false)
    }

    const changes = pickWhitelist(parsed.data.changes as Record<string, unknown>)
    if (Object.keys(changes).length === 0) {
      return errorResult(ctx, PROPOSE, 'INVALID_ARGUMENT', 'changes 仅允许白名单偏好字段', false)
    }

    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(changes)) {
      before[key] = (record as Record<string, unknown>)[key]
      after[key] = value
    }

    const proposalId = `${ctx.taskId}:memory:${parsed.data.memberId}:${Object.keys(changes).sort().join(',')}`
    runtime.memoryProposals.set(proposalId, {
      proposalId,
      memberId: parsed.data.memberId,
      before,
      after,
      confirmed: false,
      expiresAtMs: runtime.nowMs() + PROPOSAL_TTL_MS,
    })

    return okResult(
      ctx,
      PROPOSE,
      proposeMemoryUpdateOutputSchema.parse({
        proposalId,
        before,
        after,
        requiresConfirmation: true,
      }),
    )
  }

  function confirmMemoryUpdate(ctx: ToolContext, input: unknown): ToolResult<ConfirmMemoryUpdateOutput> {
    const parsed = confirmMemoryUpdateInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, CONFIRM, 'INVALID_ARGUMENT', '需要 proposalId、confirmationId 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<ConfirmMemoryUpdateOutput>(parsed.data.idempotencyKey)
    if (cached) return cached

    if (!parsed.data.confirmationId) {
      return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '写入长期记忆需要确认', false)
    }

    const proposal = runtime.memoryProposals.get(parsed.data.proposalId)
    if (!proposal) {
      return errorResult(ctx, CONFIRM, 'PROPOSAL_EXPIRED', `提案不存在或已过期：${parsed.data.proposalId}`, false)
    }
    if (runtime.nowMs() > proposal.expiresAtMs) {
      runtime.memoryProposals.delete(proposal.proposalId)
      return errorResult(ctx, CONFIRM, 'PROPOSAL_EXPIRED', `提案已过期：${parsed.data.proposalId}`, false)
    }

    if (!proposal.confirmed) {
      const record = runtime.preferences[proposal.memberId]
      Object.assign(record, proposal.after)
      proposal.confirmed = true
    }

    const result = okResult(
      ctx,
      CONFIRM,
      confirmMemoryUpdateOutputSchema.parse({
        proposalId: proposal.proposalId,
        memberId: proposal.memberId,
        applied: proposal.after,
      }),
    )
    runtime.idempotency.set(parsed.data.idempotencyKey, result)
    return result
  }

  return { proposeMemoryUpdate, confirmMemoryUpdate }
}
