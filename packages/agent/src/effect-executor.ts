import {
  applyCabinProfileOutputSchema,
  mediaPlayOutputSchema,
  navigationStartOutputSchema,
  navigationUpdateRouteOutputSchema,
  routePlanOutputSchema,
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

export type ReturnTripExecution = {
  succeeded: boolean
  effect: EffectRecord[]
  navigation?: { routeId: string; destination: string; eta: string }
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

  executeReturnTrip(input: {
    task: AirportPickupTaskState
    memberIds: string[]
    preferences: { homeDestinationId?: string; temperatureC?: number; mediaTitle?: string; mediaMemberId?: string }
    idempotencyKey: string
    effectIdPrefix: string
  }): ReturnTripExecution {
    const effects: EffectRecord[] = []
    const failed = (type: string, errorCode: string): ReturnTripExecution => ({
      succeeded: false,
      effect: [...effects, { effectId: `${input.effectIdPrefix}:${effects.length}`, type, status: 'failed', tool: type, errorCode }],
    })
    if (input.task.phase !== 'returning-home' || input.task.passengers.confirmedOnboard === false) {
      return failed('return-trip', 'POLICY_DENIED')
    }
    const destinationId = input.preferences.homeDestinationId
    if (!destinationId) return failed('navigation.update-route', 'PREFERENCE_UNAVAILABLE')

    const providerRequestId = `${input.task.taskId}:return-trip:${input.idempotencyKey}`
    const planRaw = this.#registry['navigation.plan-route'](
      { taskId: input.task.taskId, requestId: `${providerRequestId}:plan` },
      { origin: { latitude: 31.23, longitude: 121.47 }, destination: { id: destinationId, name: '家' } },
    )
    const plan = toolResultSchema(routePlanOutputSchema).safeParse(planRaw)
    if (!plan.success || !plan.data.ok || plan.data.data === null || plan.data.error !== null) {
      return failed('navigation.update-route', plan.success && plan.data.error ? plan.data.error.code : 'PROVIDER_FAILED')
    }
    const route = plan.data.data
    const updateRaw = this.#registry['navigation.update-route'](
      { taskId: input.task.taskId, requestId: `${providerRequestId}:update` },
      { routeId: route.routeId, destination: { id: destinationId, name: '家' }, idempotencyKey: `${input.idempotencyKey}:route` },
    )
    const update = toolResultSchema(navigationUpdateRouteOutputSchema).safeParse(updateRaw)
    if (!update.success || !update.data.ok || update.data.data === null || update.data.error !== null) {
      return failed('navigation.update-route', update.success && update.data.error ? update.data.error.code : 'PROVIDER_FAILED')
    }
    effects.push({ effectId: `${input.effectIdPrefix}:${effects.length}`, type: 'navigation.update-route', status: 'succeeded', tool: 'navigation.update-route' })

    let cabinEffectId: string | undefined
    if (input.preferences.temperatureC !== undefined || input.preferences.mediaTitle !== undefined) {
      const cabinRaw = this.#registry['vehicle.apply-cabin-profile'](
        { taskId: input.task.taskId, requestId: `${providerRequestId}:cabin` },
        {
          zone: 'rear',
          ...(input.preferences.temperatureC !== undefined ? { temperatureC: input.preferences.temperatureC } : {}),
          ...(input.preferences.mediaTitle !== undefined ? { mediaTitle: input.preferences.mediaTitle } : {}),
          sourceMemberIds: input.memberIds,
          idempotencyKey: `${input.idempotencyKey}:cabin`,
        },
      )
      const cabin = toolResultSchema(applyCabinProfileOutputSchema).safeParse(cabinRaw)
      if (!cabin.success || !cabin.data.ok || cabin.data.data === null || cabin.data.error !== null) {
        return failed('vehicle.apply-cabin-profile', cabin.success && cabin.data.error ? cabin.data.error.code : 'PROVIDER_FAILED')
      }
      cabinEffectId = cabin.data.data.effectId
      effects.push({ effectId: `${input.effectIdPrefix}:${effects.length}`, type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' })
    }

    if (input.preferences.mediaTitle !== undefined && input.preferences.mediaMemberId !== undefined) {
      const mediaRaw = this.#registry['media.play'](
        { taskId: input.task.taskId, requestId: `${providerRequestId}:media` },
        { mediaTitle: input.preferences.mediaTitle, sourceMemberId: input.preferences.mediaMemberId, idempotencyKey: `${input.idempotencyKey}:media` },
      )
      const media = toolResultSchema(mediaPlayOutputSchema).safeParse(mediaRaw)
      if (!media.success || !media.data.ok || media.data.data === null || media.data.error !== null) {
        if (cabinEffectId) {
          this.#registry['vehicle.revert-cabin-profile'](
            { taskId: input.task.taskId, requestId: `${providerRequestId}:cabin-revert` },
            { effectId: cabinEffectId, idempotencyKey: `${input.idempotencyKey}:cabin-revert` },
          )
        }
        return failed('media.play', media.success && media.data.error ? media.data.error.code : 'PROVIDER_FAILED')
      }
      effects.push({ effectId: `${input.effectIdPrefix}:${effects.length}`, type: 'media.play', status: 'succeeded', tool: 'media.play' })
    }

    return { succeeded: true, effect: effects, navigation: { routeId: route.routeId, destination: '家', eta: route.arrivalTime } }
  }
}

function providerErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'PROVIDER_FAILED'
}
