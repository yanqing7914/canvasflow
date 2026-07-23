import {
  applyCabinProfileInputSchema,
  applyCabinProfileOutputSchema,
  revertCabinProfileInputSchema,
  revertCabinProfileOutputSchema,
  type ApplyCabinProfileOutput,
  type RevertCabinProfileOutput,
  type ToolResult,
} from '@canvasflow/schema'
import type { CabinProfileValues, SideEffectRuntime } from './idempotency'
import { errorResult, okResult, type ToolContext } from './result'

const APPLY = 'vehicle.apply-cabin-profile'
const REVERT = 'vehicle.revert-cabin-profile'

function cloneProfile(profile: CabinProfileValues): CabinProfileValues {
  return { ...profile }
}

function profilesEqual(a: CabinProfileValues, b: CabinProfileValues): boolean {
  return a.temperatureC === b.temperatureC && a.fanLevel === b.fanLevel && a.mediaTitle === b.mediaTitle
}

export function createCabinProfileTools(runtime: SideEffectRuntime) {
  function applyCabinProfile(ctx: ToolContext, input: unknown): ToolResult<ApplyCabinProfileOutput> {
    const parsed = applyCabinProfileInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, APPLY, 'INVALID_ARGUMENT', '需要 zone、sourceMemberIds 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<ApplyCabinProfileOutput>(APPLY, parsed.data.idempotencyKey)
    if (cached) return cached

    // 授权基于 runtime 的可变偏好副本，与 memory.confirm-update 的写入保持一致。
    const unknownMembers = parsed.data.sourceMemberIds.filter((memberId) => !(memberId in runtime.preferences))
    if (unknownMembers.length > 0) {
      return errorResult(ctx, APPLY, 'POLICY_DENIED', `未授权成员：${unknownMembers.join('、')}`, false)
    }

    if (
      parsed.data.temperatureC === undefined &&
      parsed.data.fanLevel === undefined &&
      parsed.data.mediaTitle === undefined
    ) {
      return errorResult(ctx, APPLY, 'APPLY_FAILED', '至少需要一项座舱设置', false)
    }

    // 声明"来自成员偏好"的值必须与某个来源成员存储的偏好一致；
    // fanLevel 不在记忆白名单内，视为可撤销的手动调整，不做偏好校验。
    const sourceRecords = parsed.data.sourceMemberIds.map((memberId) => runtime.preferences[memberId])
    if (
      parsed.data.temperatureC !== undefined &&
      !sourceRecords.some((record) => record.rearTemperatureC === parsed.data.temperatureC)
    ) {
      return errorResult(ctx, APPLY, 'POLICY_DENIED', `温度 ${parsed.data.temperatureC}°C 与来源成员偏好不一致`, false)
    }
    if (
      parsed.data.mediaTitle !== undefined &&
      !sourceRecords.some((record) => record.mediaTitle === parsed.data.mediaTitle)
    ) {
      return errorResult(ctx, APPLY, 'POLICY_DENIED', `媒体「${parsed.data.mediaTitle}」与来源成员偏好不一致`, false)
    }

    const previous = cloneProfile(runtime.cabinCurrent)
    const current: CabinProfileValues = {
      temperatureC: parsed.data.temperatureC ?? previous.temperatureC,
      fanLevel: parsed.data.fanLevel ?? previous.fanLevel,
      mediaTitle: parsed.data.mediaTitle ?? previous.mediaTitle,
    }
    const effectId = `${ctx.taskId}:cabin:${parsed.data.idempotencyKey}`
    runtime.cabinCurrent = current
    runtime.cabinEffects.set(effectId, { effectId, previous, current, reverted: false })

    const result = okResult(
      ctx,
      APPLY,
      applyCabinProfileOutputSchema.parse({
        effectId,
        applied: true,
        previous,
        current,
        reversible: true,
      }),
    )
    runtime.idempotency.set(APPLY, parsed.data.idempotencyKey, result)
    return result
  }

  function revertCabinProfile(ctx: ToolContext, input: unknown): ToolResult<RevertCabinProfileOutput> {
    const parsed = revertCabinProfileInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, REVERT, 'INVALID_ARGUMENT', '需要 effectId 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<RevertCabinProfileOutput>(REVERT, parsed.data.idempotencyKey)
    if (cached) return cached

    const effect = runtime.cabinEffects.get(parsed.data.effectId)
    if (!effect) {
      return errorResult(ctx, REVERT, 'APPLY_FAILED', `未知座舱效果：${parsed.data.effectId}`, false)
    }

    // 只允许撤销仍然生效的效果：若座舱状态已被后续 apply 覆盖，
    // 直接恢复旧快照会丢掉后来的设置。
    if (!effect.reverted && !profilesEqual(runtime.cabinCurrent, effect.current)) {
      return errorResult(ctx, REVERT, 'APPLY_FAILED', `座舱状态已被后续操作修改，无法撤销：${parsed.data.effectId}`, false)
    }

    if (!effect.reverted) {
      runtime.cabinCurrent = cloneProfile(effect.previous)
      effect.reverted = true
    }

    const result = okResult(
      ctx,
      REVERT,
      revertCabinProfileOutputSchema.parse({
        effectId: effect.effectId,
        reverted: true,
        current: cloneProfile(runtime.cabinCurrent),
      }),
    )
    runtime.idempotency.set(REVERT, parsed.data.idempotencyKey, result)
    return result
  }

  return { applyCabinProfile, revertCabinProfile }
}
