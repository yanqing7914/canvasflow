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
  authorizeReturnTrip(task: AirportPickupTaskState): PolicyDecision
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

  authorizeReturnTrip(task: AirportPickupTaskState): PolicyDecision {
    if (task.phase === 'completed' || task.phase === 'cancelled') return { allowed: false, errorCode: 'TASK_TERMINAL' }
    if (task.phase !== 'returning-home' || !task.passengers.confirmedOnboard) return { allowed: false, errorCode: 'INVALID_TASK_PHASE' }
    if (task.flight?.status === 'cancelled') return { allowed: false, errorCode: 'FLIGHT_CANCELLED' }
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

type ProviderResult<T> =
  | { succeeded: true; data: T }
  | { succeeded: false; errorCode: string }

type ProviderResultSchema<T> = {
  safeParse(value: unknown):
    | {
        success: true
        data: {
          ok: boolean
          data: T | null
          error: { code: string } | null
          meta: { taskId: string; tool: string; requestId: string }
        }
      }
    | { success: false }
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
    completed?: { route: boolean; cabin: boolean; media: boolean }
  }): ReturnTripExecution {
    const effects: EffectRecord[] = []
    const navigation = { routeId: '', destination: '', eta: '' }
    const failed = (type: string, errorCode: string): ReturnTripExecution => ({
      succeeded: false,
      effect: [...effects, { effectId: `${input.effectIdPrefix}:${effects.length}`, type, status: 'failed', tool: type, errorCode }],
      ...(navigation.routeId ? { navigation } : {}),
    })
    const policy = this.#policy.authorizeReturnTrip(input.task)
    if (!policy.allowed) return failed('return-trip', policy.errorCode)
    const destinationId = input.preferences.homeDestinationId
    if (!destinationId && !(input.completed?.route === true)) return failed('navigation.update-route', 'PREFERENCE_UNAVAILABLE')

    const providerRequestId = `${input.task.taskId}:return-trip:${input.idempotencyKey}`
    const plan = input.completed?.route
      ? { succeeded: true as const, data: { routeId: input.task.navigation?.routeId ?? '', distanceKm: 0, durationMinutes: 0, arrivalTime: input.task.navigation?.eta ?? input.task.updatedAt, estimatedBatteryAtArrival: 0 } }
      : this.#callProvider(
      input.task.taskId,
      'navigation.plan-route',
      `${providerRequestId}:plan`,
      () => this.#registry['navigation.plan-route'](
        { taskId: input.task.taskId, requestId: `${providerRequestId}:plan` },
        { origin: { latitude: 31.23, longitude: 121.47 }, destination: { id: destinationId, name: '家' } },
      ),
      toolResultSchema(routePlanOutputSchema),
      )
    if (!plan.succeeded) return failed('navigation.update-route', plan.errorCode)
    const route = plan.data
    const update = input.completed?.route
      ? { succeeded: true as const, data: { navigationId: '', routeId: route.routeId, destination: '家', status: 'active' as const } }
      : this.#callProvider(
      input.task.taskId,
      'navigation.update-route',
      `${providerRequestId}:update`,
      () => this.#registry['navigation.update-route'](
        { taskId: input.task.taskId, requestId: `${providerRequestId}:update` },
        { routeId: route.routeId, destination: { id: destinationId, name: '家' }, idempotencyKey: `${input.idempotencyKey}:route` },
      ),
      toolResultSchema(navigationUpdateRouteOutputSchema),
        )
    if (!update.succeeded) return failed('navigation.update-route', update.errorCode)
    if (!input.completed?.route && (update.data.routeId !== route.routeId || update.data.destination !== '家' || update.data.status !== 'active')) {
      return failed('navigation.update-route', 'PROVIDER_FAILED')
    }
    navigation.routeId = route.routeId
    navigation.destination = '家'
    navigation.eta = route.arrivalTime
    if (!input.completed?.route) effects.push({ effectId: `${input.effectIdPrefix}:${effects.length}`, type: 'navigation.update-route', status: 'succeeded', tool: 'navigation.update-route' })

    if (!input.completed?.cabin && (input.preferences.temperatureC !== undefined || input.preferences.mediaTitle !== undefined)) {
      const cabin = this.#callProvider(
        input.task.taskId,
        'vehicle.apply-cabin-profile',
        `${providerRequestId}:cabin`,
        () => this.#registry['vehicle.apply-cabin-profile'](
          { taskId: input.task.taskId, requestId: `${providerRequestId}:cabin` },
          {
            zone: 'rear',
            ...(input.preferences.temperatureC !== undefined ? { temperatureC: input.preferences.temperatureC } : {}),
            ...(input.preferences.mediaTitle !== undefined ? { mediaTitle: input.preferences.mediaTitle } : {}),
            sourceMemberIds: input.memberIds,
            idempotencyKey: `${input.idempotencyKey}:cabin`,
          },
        ),
        toolResultSchema(applyCabinProfileOutputSchema),
      )
      if (!cabin.succeeded) return failed('vehicle.apply-cabin-profile', cabin.errorCode)
      if (
        !cabin.data.applied
        || (input.preferences.temperatureC !== undefined && cabin.data.current.temperatureC !== input.preferences.temperatureC)
        || (input.preferences.mediaTitle !== undefined && cabin.data.current.mediaTitle !== input.preferences.mediaTitle)
      ) {
        return failed('vehicle.apply-cabin-profile', 'PROVIDER_FAILED')
      }
      effects.push({ effectId: `${input.effectIdPrefix}:${effects.length}`, type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' })
    }

    if (!input.completed?.media && input.preferences.mediaTitle !== undefined && input.preferences.mediaMemberId !== undefined) {
      const media = this.#callProvider(
        input.task.taskId,
        'media.play',
        `${providerRequestId}:media`,
        () => this.#registry['media.play'](
          { taskId: input.task.taskId, requestId: `${providerRequestId}:media` },
          { mediaTitle: input.preferences.mediaTitle, sourceMemberId: input.preferences.mediaMemberId, idempotencyKey: `${input.idempotencyKey}:media` },
        ),
        toolResultSchema(mediaPlayOutputSchema),
      )
      if (!media.succeeded) return failed('media.play', media.errorCode)
      if (media.data.title !== input.preferences.mediaTitle || media.data.status !== 'playing') {
        return failed('media.play', 'PROVIDER_FAILED')
      }
      effects.push({ effectId: `${input.effectIdPrefix}:${effects.length}`, type: 'media.play', status: 'succeeded', tool: 'media.play' })
    }

    return { succeeded: true, effect: effects, navigation }
  }

  #callProvider<T>(
    taskId: string,
    tool: string,
    requestId: string,
    call: () => unknown,
    schema: ProviderResultSchema<T>,
  ): ProviderResult<T> {
    let raw: unknown
    try {
      raw = call()
    } catch (error) {
      return { succeeded: false, errorCode: providerErrorCode(error) }
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) return { succeeded: false, errorCode: 'PROVIDER_FAILED' }
    const result = parsed.data
    if (result.meta.taskId !== taskId || result.meta.tool !== tool || result.meta.requestId !== requestId) {
      return { succeeded: false, errorCode: 'PROVIDER_FAILED' }
    }
    if (result.ok && result.data !== null && result.error === null) {
      return { succeeded: true, data: result.data }
    }
    if (!result.ok && result.data === null && result.error !== null) {
      return { succeeded: false, errorCode: result.error.code }
    }
    return { succeeded: false, errorCode: 'PROVIDER_FAILED' }
  }
}

function providerErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'PROVIDER_FAILED'
}
