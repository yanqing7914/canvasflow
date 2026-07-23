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

    if (!Object.hasOwn(runtime.preferences, parsed.data.memberId)) {
      return errorResult(ctx, PROPOSE, 'PREFERENCE_UNAVAILABLE', `无可用偏好：${parsed.data.memberId}`, false)
    }
    const record = runtime.preferences[parsed.data.memberId]

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

    const baseId = `${ctx.taskId}:memory:${parsed.data.memberId}:${Object.keys(changes).sort().join(',')}`
    const now = runtime.nowMs()
    const related = [...runtime.memoryProposals.values()].filter(
      (candidate) => candidate.proposalId === baseId || candidate.proposalId.startsWith(`${baseId}:v`),
    )
    const active = related.find((candidate) => !candidate.confirmed && now <= candidate.expiresAtMs)

    // 同内容的未决提案幂等返回；不同内容不静默覆盖，旧提案显式失效并签发新版本号。
    if (active && JSON.stringify(active.after) === JSON.stringify(after)) {
      return okResult(
        ctx,
        PROPOSE,
        proposeMemoryUpdateOutputSchema.parse({
          proposalId: active.proposalId,
          before: active.before,
          after: active.after,
          requiresConfirmation: true,
          confirmationId: active.confirmationId,
        }),
      )
    }
    if (active) {
      active.expiresAtMs = now - 1
    }

    const proposalId = related.length === 0 ? baseId : `${baseId}:v${related.length + 1}`
    const confirmationId = runtime.confirmations.issueMemoryConfirmation({
      taskId: ctx.taskId,
      proposalId,
    })
    runtime.memoryProposals.set(proposalId, {
      proposalId,
      taskId: ctx.taskId,
      memberId: parsed.data.memberId,
      before,
      after,
      confirmationId,
      confirmed: false,
      expiresAtMs: now + PROPOSAL_TTL_MS,
    })

    return okResult(
      ctx,
      PROPOSE,
      proposeMemoryUpdateOutputSchema.parse({
        proposalId,
        before,
        after,
        requiresConfirmation: true,
        confirmationId,
      }),
    )
  }

  function confirmMemoryUpdate(ctx: ToolContext, input: unknown): ToolResult<ConfirmMemoryUpdateOutput> {
    const parsed = confirmMemoryUpdateInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, CONFIRM, 'INVALID_ARGUMENT', '需要 proposalId、confirmationId 和 idempotencyKey', false)
    }

    const proposal = runtime.memoryProposals.get(parsed.data.proposalId)
    if (!proposal) {
      return errorResult(ctx, CONFIRM, 'PROPOSAL_EXPIRED', `提案不存在或已过期：${parsed.data.proposalId}`, false)
    }
    if (runtime.nowMs() > proposal.expiresAtMs) {
      runtime.memoryProposals.delete(proposal.proposalId)
      return errorResult(ctx, CONFIRM, 'PROPOSAL_EXPIRED', `提案已过期：${parsed.data.proposalId}`, false)
    }

    // Opaque token must match the proposal and stay on the issuing task for every
    // request — including post-confirm replays — so another task cannot present
    // a spent token and claim the applied result as its own authorization.
    if (proposal.taskId !== ctx.taskId || parsed.data.confirmationId !== proposal.confirmationId) {
      return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '确认凭据与提案或当前任务不匹配', false)
    }
    if (
      !proposal.confirmed &&
      !runtime.confirmations.matchesMemoryConfirmation(parsed.data.confirmationId, {
        taskId: ctx.taskId,
        proposalId: proposal.proposalId,
      })
    ) {
      return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '确认凭据无效或已使用', false)
    }

    const cached = runtime.idempotency.get<ConfirmMemoryUpdateOutput>(ctx.taskId, CONFIRM, parsed.data.idempotencyKey, parsed.data)
    if (cached.kind === 'hit') {
      if (cached.result.meta.taskId !== ctx.taskId) {
        return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '幂等结果与当前任务不匹配', false)
      }
      return cached.result
    }
    if (cached.kind === 'conflict') {
      return errorResult(ctx, CONFIRM, 'INVALID_ARGUMENT', '同一 idempotencyKey 已被不同请求参数使用', false)
    }

    if (!proposal.confirmed) {
      if (
        !runtime.confirmations.consumeMemoryConfirmation(parsed.data.confirmationId, {
          taskId: ctx.taskId,
          proposalId: proposal.proposalId,
        })
      ) {
        return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '确认凭据无效或已使用', false)
      }
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
    runtime.idempotency.set(ctx.taskId, CONFIRM, parsed.data.idempotencyKey, parsed.data, result)
    return result
  }

  return { proposeMemoryUpdate, confirmMemoryUpdate }
}
