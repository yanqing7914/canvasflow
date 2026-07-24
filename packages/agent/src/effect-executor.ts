import {
  navigationStartOutputSchema,
  toolResultSchema,
  type AirportPickupTaskState,
  type EffectRecord,
} from '@canvasflow/schema'
import type { ProviderRegistry } from '@canvasflow/tools'

const NAVIGATION_START = 'navigation.start'

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; errorCode: string }

export interface PolicyGate {
  authorizeNavigationStart(task: AirportPickupTaskState, routeId: string): PolicyDecision
}

export class DefaultPolicyGate implements PolicyGate {
  authorizeNavigationStart(task: AirportPickupTaskState, routeId: string): PolicyDecision {
    if (task.phase === 'completed' || task.phase === 'cancelled') {
      return { allowed: false, errorCode: 'TASK_TERMINAL' }
    }
    if (task.phase !== 'preparing') {
      return { allowed: false, errorCode: 'INVALID_TASK_PHASE' }
    }
    if (task.flight?.status === 'cancelled') {
      return { allowed: false, errorCode: 'FLIGHT_CANCELLED' }
    }
    if (!task.navigation || task.navigation.status !== 'planned') {
      return { allowed: false, errorCode: 'ROUTE_NOT_PLANNED' }
    }
    if (task.navigation.routeId !== routeId) {
      return { allowed: false, errorCode: 'ROUTE_MISMATCH' }
    }
    return { allowed: true }
  }
}

export type NavigationStartExecution = {
  succeeded: boolean
  effect: EffectRecord
}

export class EffectExecutor {
  readonly #registry: ProviderRegistry
  readonly #policy: PolicyGate

  constructor(registry: ProviderRegistry, policy: PolicyGate = new DefaultPolicyGate()) {
    this.#registry = registry
    this.#policy = policy
  }

  startNavigation(input: {
    task: AirportPickupTaskState
    routeId: string
    idempotencyKey: string
    effectId: string
  }): NavigationStartExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: NAVIGATION_START,
      status,
      tool: NAVIGATION_START,
      ...(errorCode ? { errorCode } : {}),
    })
    const policy = this.#policy.authorizeNavigationStart(input.task, input.routeId)
    if (!policy.allowed) return { succeeded: false, effect: effect('failed', policy.errorCode) }

    const providerRequestId = `${input.task.taskId}:${NAVIGATION_START}:${input.idempotencyKey}`
    let raw: unknown
    try {
      raw = this.#registry[NAVIGATION_START](
        { taskId: input.task.taskId, requestId: providerRequestId },
        { routeId: input.routeId, idempotencyKey: input.idempotencyKey },
      )
    } catch (error) {
      return {
        succeeded: false,
        effect: effect('failed', providerErrorCode(error)),
      }
    }

    const parsed = toolResultSchema(navigationStartOutputSchema).safeParse(raw)
    if (!parsed.success) return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    const result = parsed.data
    if (
      result.meta.taskId !== input.task.taskId
      || result.meta.tool !== NAVIGATION_START
      || result.meta.requestId !== providerRequestId
    ) {
      return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    }
    if (result.ok && result.data !== null && result.error === null) {
      if (result.data.routeId !== input.routeId || result.data.status !== 'active') {
        return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
      }
      return { succeeded: true, effect: effect('succeeded') }
    }
    if (!result.ok && result.data === null && result.error !== null) {
      return {
        succeeded: false,
        effect: effect('failed', result.error?.code ?? 'PROVIDER_FAILED'),
      }
    }
    return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
  }
}

function providerErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'PROVIDER_FAILED'
}
