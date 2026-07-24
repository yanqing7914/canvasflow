import {
  confirmMemoryUpdateInputSchema,
  confirmMemoryUpdateOutputSchema,
  rejectMemoryUpdateOutputSchema,
  proposeMemoryUpdateInputSchema,
  proposeMemoryUpdateOutputSchema,
  type ConfirmMemoryUpdateOutput,
  type ProposeMemoryUpdateOutput,
  type RejectMemoryUpdateOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { knownDestinationIds, knownMediaTitles } from './data'
import type { SideEffectRuntime } from './idempotency'
import { errorResult, okResult, type ToolContext } from './result'

const PROPOSE = 'memory.propose-update'
const CONFIRM = 'memory.confirm-update'
const REJECT = 'memory.reject-update'

const MEMORY_WHITELIST = [
  'rearTemperatureC',
  'mediaTitle',
  'homeDestinationId',
  'landingNotificationAuthorized',
] as const

const PROPOSAL_TTL_MS = 30 * 60 * 1000
const TEMPERATURE_MIN_C = 16
const TEMPERATURE_MAX_C = 32

function pickWhitelist(changes: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of MEMORY_WHITELIST) {
    if (changes[key] !== undefined) picked[key] = changes[key]
  }
  return picked
}

function validatePreferenceDomain(changes: Record<string, unknown>): string | undefined {
  const temperature = changes.rearTemperatureC
  if (typeof temperature === 'number' && (temperature < TEMPERATURE_MIN_C || temperature > TEMPERATURE_MAX_C)) {
    return `后排温度须在 ${TEMPERATURE_MIN_C}–${TEMPERATURE_MAX_C}°C`
  }
  const mediaTitle = changes.mediaTitle
  if (typeof mediaTitle === 'string' && !knownMediaTitles.has(mediaTitle)) {
    return `未知媒体标题：${mediaTitle}`
  }
  const homeDestinationId = changes.homeDestinationId
  if (typeof homeDestinationId === 'string' && !knownDestinationIds.has(homeDestinationId)) {
    return `未知目的地：${homeDestinationId}`
  }
  return undefined
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

    const domainError = validatePreferenceDomain(changes)
    if (domainError) {
      return errorResult(ctx, PROPOSE, 'INVALID_ARGUMENT', domainError, false)
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
          expiresAt: new Date(active.expiresAtMs).toISOString(),
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
        expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
      }),
    )
  }

  function confirmMemoryUpdate(ctx: ToolContext, input: unknown): ToolResult<ConfirmMemoryUpdateOutput> {
    const parsed = confirmMemoryUpdateInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, CONFIRM, 'INVALID_ARGUMENT', '需要 proposalId、confirmationId 和 idempotencyKey', false)
    }

    // Cache-first: a prior success for this key must replay even after proposal TTL.
    const cached = runtime.idempotency.get<ConfirmMemoryUpdateOutput>(ctx.taskId, CONFIRM, parsed.data.idempotencyKey, parsed.data)
    if (cached.kind === 'hit') return cached.result
    if (cached.kind === 'conflict') {
      return errorResult(ctx, CONFIRM, 'INVALID_ARGUMENT', '同一 idempotencyKey 已被不同请求参数使用', false)
    }

    const proposal = runtime.memoryProposals.get(parsed.data.proposalId)
    if (!proposal) {
      return errorResult(ctx, CONFIRM, 'PROPOSAL_EXPIRED', `提案不存在或已过期：${parsed.data.proposalId}`, false)
    }
    if (runtime.nowMs() > proposal.expiresAtMs) {
      runtime.memoryProposals.delete(proposal.proposalId)
      return errorResult(ctx, CONFIRM, 'PROPOSAL_EXPIRED', `提案已过期：${parsed.data.proposalId}`, false)
    }

    // Task ownership is authoritative: proposalId prefixes are not a security boundary.
    if (proposal.taskId !== ctx.taskId) {
      return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '确认凭据与当前任务不匹配', false)
    }

    if (parsed.data.confirmationId !== proposal.confirmationId) {
      return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '确认凭据与提案不匹配', false)
    }

    const binding = { taskId: ctx.taskId, proposalId: proposal.proposalId }
    if (!proposal.confirmed && !runtime.confirmations.matchesMemoryConfirmation(parsed.data.confirmationId, binding)) {
      return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '确认凭据无效或已使用', false)
    }

    // After the first successful confirm the token is spent: only the original
    // idempotency key may replay success (handled above). Fresh keys must not mint new oks.
    if (proposal.confirmed) {
      return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '确认凭据已使用', false)
    }

    if (!runtime.confirmations.consumeMemoryConfirmation(parsed.data.confirmationId, binding)) {
      return errorResult(ctx, CONFIRM, 'CONFIRMATION_REQUIRED', '确认凭据无效或已使用', false)
    }
    const record = runtime.preferences[proposal.memberId]
    Object.assign(record, proposal.after)
    proposal.confirmed = true

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

  function rejectMemoryUpdate(ctx: ToolContext, input: unknown): ToolResult<RejectMemoryUpdateOutput> {
    const parsed = confirmMemoryUpdateInputSchema.safeParse(input)
    if (!parsed.success) return errorResult(ctx, REJECT, 'INVALID_ARGUMENT', '需要 proposalId、confirmationId 和 idempotencyKey', false)
    const cached = runtime.idempotency.get<RejectMemoryUpdateOutput>(ctx.taskId, REJECT, parsed.data.idempotencyKey, parsed.data)
    if (cached.kind === 'hit') return cached.result
    if (cached.kind === 'conflict') return errorResult(ctx, REJECT, 'INVALID_ARGUMENT', '同一 idempotencyKey 已被不同请求参数使用', false)
    const proposal = runtime.memoryProposals.get(parsed.data.proposalId)
    if (!proposal) {
      const tokenState = runtime.confirmations.memoryConfirmationState(parsed.data.confirmationId)
      if (
        tokenState === 'active'
        && runtime.confirmations.memoryConfirmationBinding(parsed.data.confirmationId)?.taskId !== ctx.taskId
      ) {
        return errorResult(ctx, REJECT, 'CONFIRMATION_REQUIRED', '确认凭据与提案不匹配', false)
      }
      if (tokenState === 'active' && runtime.confirmations.memoryConfirmationBinding(parsed.data.confirmationId)?.proposalId !== parsed.data.proposalId) {
        return errorResult(ctx, REJECT, 'CONFIRMATION_REQUIRED', '确认凭据与提案不匹配', false)
      }
      if (tokenState === 'active') runtime.confirmations.revokeMemoryConfirmation(parsed.data.confirmationId)
      const result = okResult(ctx, REJECT, rejectMemoryUpdateOutputSchema.parse({ proposalId: parsed.data.proposalId, rejected: true }))
      runtime.idempotency.set(ctx.taskId, REJECT, parsed.data.idempotencyKey, parsed.data, result)
      return result
    }
    if (proposal.taskId !== ctx.taskId || proposal.confirmationId !== parsed.data.confirmationId) {
      return errorResult(ctx, REJECT, 'CONFIRMATION_REQUIRED', '确认凭据与提案不匹配', false)
    }
    runtime.confirmations.revokeMemoryConfirmation(parsed.data.confirmationId)
    runtime.memoryProposals.delete(proposal.proposalId)
    const result = okResult(ctx, REJECT, rejectMemoryUpdateOutputSchema.parse({ proposalId: proposal.proposalId, rejected: true }))
    runtime.idempotency.set(ctx.taskId, REJECT, parsed.data.idempotencyKey, parsed.data, result)
    return result
  }

  return { proposeMemoryUpdate, confirmMemoryUpdate, rejectMemoryUpdate }
}
