import {
  applyCabinProfileOutputSchema,
  confirmMemoryUpdateOutputSchema,
  mediaPlayOutputSchema,
  navigationStartOutputSchema,
  navigationUpdateRouteOutputSchema,
  proposeMemoryUpdateOutputSchema,
  rejectMemoryUpdateOutputSchema,
  revertCabinProfileOutputSchema,
  routePlanOutputSchema,
  messagePrepareOutputSchema,
  messageSendOutputSchema,
  revokeMessageConfirmationOutputSchema,
  revokeMessageAuthorizationOutputSchema,
  toolResultSchema,
  type AirportPickupTaskState,
  type EffectRecord,
  type VehicleContext,
} from '@canvasflow/schema'
import { buildLandingNotifyContent, type ProviderRegistry } from '@canvasflow/tools'

const NAVIGATION_START = 'navigation.start'

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; errorCode: string }

export interface PolicyGate {
  authorizeNavigationStart(task: AirportPickupTaskState, routeId: string, vehicle?: VehicleContext): PolicyDecision
  authorizeReturnTrip(task: AirportPickupTaskState): PolicyDecision
  authorizeCabinRevert(task: AirportPickupTaskState, vehicle?: VehicleContext): PolicyDecision
  authorizeLandingMessage(task: AirportPickupTaskState): PolicyDecision
  authorizeLandingMessageRetry(task: AirportPickupTaskState, confirmationId?: string): PolicyDecision
}

export class DefaultPolicyGate implements PolicyGate {
  authorizeNavigationStart(task: AirportPickupTaskState, routeId: string, vehicle?: VehicleContext): PolicyDecision {
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
    if (vehicle && (vehicle.speedKph > 0 || vehicle.gear !== 'P')) {
      return { allowed: false, errorCode: 'VEHICLE_MOVING' }
    }
    return { allowed: true }
  }

  authorizeReturnTrip(task: AirportPickupTaskState): PolicyDecision {
    if (task.phase === 'completed' || task.phase === 'cancelled') return { allowed: false, errorCode: 'TASK_TERMINAL' }
    if (task.phase !== 'returning-home' || !task.passengers.confirmedOnboard) return { allowed: false, errorCode: 'INVALID_TASK_PHASE' }
    if (task.flight?.status === 'cancelled') return { allowed: false, errorCode: 'FLIGHT_CANCELLED' }
    return { allowed: true }
  }

  authorizeCabinRevert(task: AirportPickupTaskState, vehicle?: VehicleContext): PolicyDecision {
    if (task.phase === 'completed' || task.phase === 'cancelled') return { allowed: false, errorCode: 'TASK_TERMINAL' }
    if (task.phase !== 'returning-home' || !task.passengers.confirmedOnboard) {
      return { allowed: false, errorCode: 'INVALID_TASK_PHASE' }
    }
    if (task.flight?.status === 'cancelled') return { allowed: false, errorCode: 'FLIGHT_CANCELLED' }
    if (
      task.returnTrip?.cabin.status !== 'succeeded'
      || task.returnTrip.cabin.revert?.status === 'succeeded'
      || task.returnTrip.cabin.revert?.status === 'unknown'
    ) {
      return { allowed: false, errorCode: 'INVALID_TASK_STATE' }
    }
    if (!vehicle) return { allowed: false, errorCode: 'VEHICLE_CONTEXT_REQUIRED' }
    if (vehicle.speedKph > 0 || vehicle.gear !== 'P') return { allowed: false, errorCode: 'VEHICLE_MOVING' }
    return { allowed: true }
  }

  authorizeLandingMessage(task: AirportPickupTaskState): PolicyDecision {
    if (task.phase === 'completed' || task.phase === 'cancelled') return { allowed: false, errorCode: 'TASK_TERMINAL' }
    if (task.flight?.status !== 'landed' || task.message.status !== 'scheduled') return { allowed: false, errorCode: 'INVALID_TASK_STATE' }
    if (!task.message.pendingMessageId || !task.message.pendingContactId || !task.message.authorizationId) return { allowed: false, errorCode: 'AUTHORIZATION_REQUIRED' }
    return { allowed: true }
  }

  authorizeLandingMessageRetry(task: AirportPickupTaskState, confirmationId?: string): PolicyDecision {
    if (task.phase === 'completed' || task.phase === 'cancelled') return { allowed: false, errorCode: 'TASK_TERMINAL' }
    if (task.message.status !== 'failed' || !task.flight) return { allowed: false, errorCode: 'INVALID_TASK_STATE' }
    if (task.flight.status === 'cancelled') return { allowed: false, errorCode: 'FLIGHT_CANCELLED' }
    if (confirmationId !== undefined && (
      task.pendingConfirmation?.action !== 'send-message'
      || task.pendingConfirmation.confirmationId !== confirmationId
    )) return { allowed: false, errorCode: 'AUTHORIZATION_REQUIRED' }
    return { allowed: true }
  }
}

export type NavigationStartExecution = {
  succeeded: boolean
  effect: EffectRecord
}

type LandingMessageExecution = {
  succeeded: boolean
  effect: EffectRecord
  /** The provider reports that the external send happened, but its envelope is untrusted. */
  ambiguousApplied?: boolean
}

export type ReturnTripExecution = {
  succeeded: boolean
  effect: EffectRecord[]
  navigation?: { routeId: string; destination: string; eta: string }
  rolledBack?: boolean
  applied: { route: boolean; cabin: boolean; media: boolean }
  residual: { route: boolean; cabin: boolean; media: boolean }
  skipped: { cabin: boolean; media: boolean }
  cabinEffectId?: string
  cabinEffectIsNew?: boolean
}

export type CabinRevertExecution = {
  succeeded: boolean
  effect: EffectRecord
  current?: { temperatureC?: number; fanLevel?: number; mediaTitle?: string }
  ambiguous?: boolean
}

export type MemoryProposalExecution = {
  succeeded: boolean
  effect: EffectRecord
  proposal?: {
    proposalId: string
    memberId: string
    confirmationId: string
    expiresAt: string
  }
}

export type MemoryConfirmationExecution = {
  succeeded: boolean
  effect: EffectRecord
  errorCode?: string
}

export type LandingMessagePrepareExecution = {
  succeeded: boolean
  effect: EffectRecord
  prepared?: {
    contactId: string
    messageId: string
    text: string
    confirmationId: string
  }
}

export type LandingMessageRevocationExecution = {
  succeeded: boolean
  effect: EffectRecord
  errorCode?: string
  /** Provider returned a successful payload but an untrusted envelope; reconcile locally. */
  ambiguous?: boolean
}

export type CabinPreferenceExecution = {
  succeeded: boolean
  effect: EffectRecord
  compensationEffect?: EffectRecord
  residualApplied?: boolean
  cabinEffectId?: string
}

type ProviderResult<T> =
  | { succeeded: true; data: T }
  | { succeeded: false; errorCode: string; data?: T }

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
    vehicle?: VehicleContext
  }): NavigationStartExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: NAVIGATION_START,
      status,
      tool: NAVIGATION_START,
      ...(errorCode ? { errorCode } : {}),
    })
    const policy = this.#policy.authorizeNavigationStart(input.task, input.routeId, input.vehicle)
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

  sendLandingMessage(input: {
    task: AirportPickupTaskState
    idempotencyKey: string
    effectId: string
  }): LandingMessageExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({ effectId: input.effectId, type: 'message.send', status, tool: 'message.send', ...(errorCode ? { errorCode } : {}) })
    const policy = this.#policy.authorizeLandingMessage(input.task)
    if (!policy.allowed) return { succeeded: false, effect: effect('failed', policy.errorCode) }
    const providerRequestId = `${input.task.taskId}:message.send:${input.idempotencyKey}`
    const result = this.#callProvider(
      input.task.taskId,
      'message.send',
      providerRequestId,
      () => this.#registry['message.send'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        {
          contactId: input.task.message.pendingContactId!,
          messageId: input.task.message.pendingMessageId!,
          text: `我已到达机场接机点，航班 ${input.task.flight!.flightNumber}，预计 ${input.task.navigation?.eta ?? input.task.flight!.estimatedArrival} 会合。`,
          authorizationId: input.task.message.authorizationId!,
          idempotencyKey: input.idempotencyKey,
        },
      ),
      toolResultSchema(messageSendOutputSchema),
    )
    if (!result.succeeded) {
      return {
        succeeded: false,
        effect: effect('failed', result.errorCode),
        ambiguousApplied: result.data?.messageId === input.task.message.pendingMessageId && result.data?.status === 'sent',
      }
    }
    if (result.data.messageId !== input.task.message.pendingMessageId || result.data.status !== 'sent') {
      return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    }
    return { succeeded: true, effect: effect('succeeded') }
  }

  prepareLandingMessageRetry(input: {
    task: AirportPickupTaskState
    contactId: string
    idempotencyKey: string
    effectId: string
    eta?: string
  }): LandingMessagePrepareExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: 'message.prepare',
      status,
      tool: 'message.prepare',
      ...(errorCode ? { errorCode } : {}),
    })
    const policy = this.#policy.authorizeLandingMessageRetry(input.task)
    if (!policy.allowed) return { succeeded: false, effect: effect('failed', policy.errorCode) }

    const eta = input.eta ?? resolveLandingMeetingEta(input.task)
    const expected = buildLandingNotifyContent(
      input.task.taskId, input.contactId, input.task.flight!.flightNumber, eta ?? '即将到达',
    )
    const providerRequestId = `${input.task.taskId}:message.prepare:${input.idempotencyKey}`
    let raw: unknown
    try {
      raw = this.#registry['message.prepare'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        {
          contactId: input.contactId,
          flightNumber: input.task.flight!.flightNumber,
          ...(eta !== undefined ? { eta } : {}),
        },
      )
    } catch (error) {
      return { succeeded: false, effect: effect('failed', providerErrorCode(error)) }
    }
    const parsed = toolResultSchema(messagePrepareOutputSchema).safeParse(raw)
    if (!parsed.success) return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    const providerResult = parsed.data
    const invalidMetadata = providerResult.meta.taskId !== input.task.taskId
      || providerResult.meta.tool !== 'message.prepare'
      || providerResult.meta.requestId !== providerRequestId
    const invalidSemantics = providerResult.ok
      && providerResult.data !== null
      && (
        providerResult.data.contactId !== expected.contactId
        || providerResult.data.messageId !== expected.messageId
        || providerResult.data.text !== expected.text
      )
    if ((invalidMetadata || invalidSemantics) && providerResult.data?.confirmationId) {
      const compensated = this.#revokePreparedConfirmation(
        input.task.taskId,
        providerResult.data.confirmationId,
        `${input.idempotencyKey}:invalid-prepare`,
      )
      return { succeeded: false, effect: effect('failed', compensated ? 'PROVIDER_FAILED' : 'COMPENSATION_FAILED') }
    }
    if (invalidMetadata) return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    if (!providerResult.ok && providerResult.data === null && providerResult.error !== null) {
      return { succeeded: false, effect: effect('failed', providerResult.error.code) }
    }
    if (!providerResult.ok || providerResult.data === null || providerResult.error !== null) {
      return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    }
    const result = providerResult.data
    if (
      result.contactId !== expected.contactId
      || result.messageId !== expected.messageId
      || result.text !== expected.text
    ) {
      return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    }
    return {
      succeeded: true,
      effect: effect('pending-confirmation'),
      prepared: result,
    }
  }

  sendConfirmedLandingMessage(input: {
    task: AirportPickupTaskState
    contactId: string
    messageId: string
    text: string
    confirmationId: string
    idempotencyKey: string
    effectId: string
  }): { succeeded: boolean; effect: EffectRecord } {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: 'message.send',
      status,
      tool: 'message.send',
      ...(errorCode ? { errorCode } : {}),
    })
    const policy = this.#policy.authorizeLandingMessageRetry(input.task, input.confirmationId)
    if (!policy.allowed) return { succeeded: false, effect: effect('failed', policy.errorCode) }
    const expected = input.task.message.pendingText
      ? { contactId: input.contactId, messageId: input.task.message.pendingMessageId, text: input.task.message.pendingText }
      : buildLandingNotifyContent(
          input.task.taskId,
          input.contactId,
          input.task.flight!.flightNumber,
          resolveLandingMeetingEta(input.task) ?? '即将到达',
        )
    if (
      input.messageId !== expected.messageId
      || input.text !== expected.text
      || (input.task.message.pendingContactId !== undefined && input.task.message.pendingContactId !== input.contactId)
      || (input.task.message.pendingMessageId !== undefined && input.task.message.pendingMessageId !== input.messageId)
    ) {
      return { succeeded: false, effect: effect('failed', 'INVALID_TASK_STATE') }
    }

    const providerRequestId = `${input.task.taskId}:message.send:${input.idempotencyKey}`
    const result = this.#callProvider(
      input.task.taskId,
      'message.send',
      providerRequestId,
      () => this.#registry['message.send'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        {
          contactId: input.contactId,
          messageId: input.messageId,
          text: input.text,
          confirmationId: input.confirmationId,
          idempotencyKey: input.idempotencyKey,
        },
      ),
      toolResultSchema(messageSendOutputSchema),
    )
    if (!result.succeeded) {
      return { succeeded: false, effect: effect('failed', result.errorCode) }
    }
    if (result.data.messageId !== input.messageId || result.data.status !== 'sent') {
      return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    }
    return { succeeded: true, effect: effect('succeeded') }
  }

  revokeLandingMessageConfirmation(input: {
    task: AirportPickupTaskState
    confirmationId: string
    idempotencyKey: string
    effectId: string
  }): LandingMessageRevocationExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: 'message.revoke-confirmation',
      status,
      tool: 'message.revoke-confirmation',
      ...(errorCode ? { errorCode } : {}),
    })
    if (
      input.task.pendingConfirmation?.action !== 'send-message'
      || input.task.pendingConfirmation.confirmationId !== input.confirmationId
    ) {
      return { succeeded: false, errorCode: 'AUTHORIZATION_REQUIRED', effect: effect('failed', 'AUTHORIZATION_REQUIRED') }
    }
    const providerRequestId = `${input.task.taskId}:message.revoke-confirmation:${input.idempotencyKey}`
    const result = this.#callProvider(
      input.task.taskId,
      'message.revoke-confirmation',
      providerRequestId,
      () => this.#registry['message.revoke-confirmation'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        { confirmationId: input.confirmationId, idempotencyKey: input.idempotencyKey },
      ),
      toolResultSchema(revokeMessageConfirmationOutputSchema),
    )
    if (!result.succeeded) {
      return {
        succeeded: false,
        errorCode: result.errorCode,
        ambiguous: result.data !== undefined,
        effect: effect('failed', result.errorCode),
      }
    }
    if (result.data.confirmationId !== input.confirmationId || !result.data.revoked) {
      return { succeeded: false, errorCode: 'PROVIDER_FAILED', effect: effect('failed', 'PROVIDER_FAILED') }
    }
    return { succeeded: true, effect: effect('cancelled', 'USER_REJECTED') }
  }

  revokeLandingMessageAuthorization(input: {
    task: AirportPickupTaskState
    authorizationId: string
    idempotencyKey: string
    effectId: string
  }): LandingMessageRevocationExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: 'message.revoke-authorization',
      status,
      tool: 'message.revoke-authorization',
      ...(errorCode ? { errorCode } : {}),
    })
    if (input.task.message.authorizationId !== input.authorizationId) {
      return { succeeded: false, errorCode: 'AUTHORIZATION_REQUIRED', effect: effect('failed', 'AUTHORIZATION_REQUIRED') }
    }
    const providerRequestId = `${input.task.taskId}:message.revoke-authorization:${input.idempotencyKey}`
    const result = this.#callProvider(
      input.task.taskId,
      'message.revoke-authorization',
      providerRequestId,
      () => this.#registry['message.revoke-authorization'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        { authorizationId: input.authorizationId, idempotencyKey: input.idempotencyKey },
      ),
      toolResultSchema(revokeMessageAuthorizationOutputSchema),
    )
    if (!result.succeeded) {
      return {
        succeeded: false,
        errorCode: result.errorCode,
        ambiguous: result.data !== undefined,
        effect: effect('failed', result.errorCode),
      }
    }
    if (result.data.authorizationId !== input.authorizationId || !result.data.revoked) {
      return {
        succeeded: false,
        errorCode: 'PROVIDER_FAILED',
        ambiguous: result.data.revoked,
        effect: effect('failed', 'PROVIDER_FAILED'),
      }
    }
    return { succeeded: true, effect: effect('cancelled', 'TASK_CANCELLED') }
  }

  applyCabinPreferences(input: {
    task: AirportPickupTaskState
    memberIds: string[]
    temperatureC?: number
    mediaTitle?: string
    idempotencyKey: string
    effectId: string
  }): CabinPreferenceExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: 'vehicle.apply-cabin-profile',
      status,
      tool: 'vehicle.apply-cabin-profile',
      ...(errorCode ? { errorCode } : {}),
    })
    const policy = this.#policy.authorizeReturnTrip(input.task)
    if (!policy.allowed) return { succeeded: false, effect: effect('failed', policy.errorCode) }
    if (input.temperatureC === undefined && input.mediaTitle === undefined) {
      return { succeeded: false, effect: effect('failed', 'PREFERENCE_UNAVAILABLE') }
    }
    const providerRequestId = `${input.task.taskId}:vehicle.apply-cabin-profile:${input.idempotencyKey}`
    const result = this.#callProvider(
      input.task.taskId,
      'vehicle.apply-cabin-profile',
      providerRequestId,
      () => this.#registry['vehicle.apply-cabin-profile'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        {
          zone: 'rear',
          ...(input.temperatureC !== undefined ? { temperatureC: input.temperatureC } : {}),
          ...(input.mediaTitle !== undefined ? { mediaTitle: input.mediaTitle } : {}),
          sourceMemberIds: input.memberIds,
          idempotencyKey: input.idempotencyKey,
        },
      ),
      toolResultSchema(applyCabinProfileOutputSchema),
    )
    if (!result.succeeded && result.data === undefined) return { succeeded: false, effect: effect('failed', result.errorCode) }
    if (
      !result.succeeded
      || !result.data.applied
      || !result.data.reversible
      || (input.temperatureC !== undefined && result.data.current.temperatureC !== input.temperatureC)
      || (input.mediaTitle !== undefined && result.data.current.mediaTitle !== input.mediaTitle)
    ) {
      const appliedData = result.data
      if (!appliedData || !appliedData.applied || !appliedData.effectId) {
        return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
      }
      const rollbackRequestId = `${providerRequestId}:rollback`
      const rollback = this.#callProvider(
        input.task.taskId,
        'vehicle.revert-cabin-profile',
        rollbackRequestId,
        () => this.#registry['vehicle.revert-cabin-profile'](
          { taskId: input.task.taskId, requestId: rollbackRequestId },
          { effectId: appliedData.effectId, idempotencyKey: `${input.idempotencyKey}:rollback` },
        ),
        toolResultSchema(revertCabinProfileOutputSchema),
      )
      const compensated = rollback.succeeded
        && rollback.data.effectId === appliedData.effectId
        && rollback.data.reverted
      return {
        succeeded: false,
        effect: effect('failed', compensated ? 'PROVIDER_FAILED' : 'COMPENSATION_FAILED'),
        compensationEffect: {
          effectId: `${input.effectId}:rollback`,
          type: 'vehicle.revert-cabin-profile',
          status: compensated ? 'succeeded' : 'failed',
          tool: 'vehicle.revert-cabin-profile',
          ...(compensated ? {} : { errorCode: rollback.succeeded ? 'PROVIDER_FAILED' : rollback.errorCode }),
        },
        residualApplied: !compensated,
        ...(!compensated ? { cabinEffectId: appliedData.effectId } : {}),
      }
    }
    return { succeeded: true, effect: effect('succeeded'), cabinEffectId: result.data.effectId }
  }

  revertCabinProfile(input: {
    task: AirportPickupTaskState
    cabinEffectId: string
    idempotencyKey: string
    effectId: string
    vehicle?: VehicleContext
  }): CabinRevertExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: 'vehicle.revert-cabin-profile',
      status,
      tool: 'vehicle.revert-cabin-profile',
      ...(errorCode ? { errorCode } : {}),
    })
    const policy = this.#policy.authorizeCabinRevert(input.task, input.vehicle)
    if (!policy.allowed) return { succeeded: false, effect: effect('failed', policy.errorCode) }

    const providerRequestId = `${input.task.taskId}:vehicle.revert-cabin-profile:${input.idempotencyKey}`
    const result = this.#callProvider(
      input.task.taskId,
      'vehicle.revert-cabin-profile',
      providerRequestId,
      () => this.#registry['vehicle.revert-cabin-profile'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        { effectId: input.cabinEffectId, idempotencyKey: input.idempotencyKey },
      ),
      toolResultSchema(revertCabinProfileOutputSchema),
    )
    if (!result.succeeded) {
      const ambiguous = result.data?.effectId === input.cabinEffectId && result.data.reverted
      return {
        succeeded: false,
        effect: effect('failed', result.errorCode),
        ...(ambiguous ? { current: result.data!.current, ambiguous: true } : {}),
      }
    }
    if (result.data.effectId !== input.cabinEffectId || !result.data.reverted) {
      return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    }
    return { succeeded: true, effect: effect('succeeded'), current: result.data.current }
  }

  executeReturnTrip(input: {
    task: AirportPickupTaskState
    memberIds: string[]
    preferences: { homeDestinationId?: string; temperatureC?: number; mediaTitle?: string; mediaMemberId?: string }
    rollbackNavigation?: { routeId: string; destination: { id: string; name: string }; eta: string }
    idempotencyKey: string
    effectIdPrefix: string
    completed?: { route: boolean; cabin: boolean; media: boolean; cabinEffectId?: string }
  }): ReturnTripExecution {
    const effects: EffectRecord[] = []
    const navigation = { routeId: '', destination: '', eta: '' }
    const applied = {
      route: input.completed?.route === true,
      cabin: input.completed?.cabin === true,
      media: input.completed?.media === true,
    }
    const skipped = {
      cabin: input.completed?.cabin !== true
        && input.preferences.temperatureC === undefined
        && input.preferences.mediaTitle === undefined,
      media: input.completed?.media !== true
        && (input.preferences.mediaTitle === undefined || input.preferences.mediaMemberId === undefined),
    }
    const residual = { ...applied }
    const newlyApplied = { route: false, cabin: false, media: false }
    let cabinEffectId = input.completed?.cabinEffectId
    const append = (type: string, status: EffectRecord['status'], tool = type, errorCode?: string) => {
      effects.push({
        effectId: `${input.effectIdPrefix}:${effects.length}`,
        type,
        status,
        tool,
        ...(errorCode ? { errorCode } : {}),
      })
    }
    const failed = (type: string, errorCode: string): ReturnTripExecution => {
      append(type, 'failed', type, errorCode)

      if (newlyApplied.cabin && cabinEffectId) {
        const revert = this.#callProvider(
          input.task.taskId,
          'vehicle.revert-cabin-profile',
          `${input.task.taskId}:return-trip:${input.idempotencyKey}:rollback:cabin`,
          () => this.#registry['vehicle.revert-cabin-profile'](
            {
              taskId: input.task.taskId,
              requestId: `${input.task.taskId}:return-trip:${input.idempotencyKey}:rollback:cabin`,
            },
            {
              effectId: cabinEffectId!,
              idempotencyKey: `${input.idempotencyKey}:rollback:cabin`,
            },
          ),
          toolResultSchema(revertCabinProfileOutputSchema),
        )
        if (revert.succeeded && revert.data.effectId === cabinEffectId && revert.data.reverted) {
          applied.cabin = false
          residual.cabin = false
          newlyApplied.cabin = false
          append('vehicle.revert-cabin-profile', 'succeeded')
        } else {
          append(
            'vehicle.revert-cabin-profile',
            'failed',
            'vehicle.revert-cabin-profile',
            revert.succeeded ? 'PROVIDER_FAILED' : revert.errorCode,
          )
        }
      }

      if (newlyApplied.route) {
        const rollback = input.rollbackNavigation
        if (!rollback) {
          append('navigation.update-route.rollback', 'failed', 'navigation.update-route', 'ROLLBACK_UNAVAILABLE')
        } else {
          const rollbackRequestId = `${input.task.taskId}:return-trip:${input.idempotencyKey}:rollback:route`
          const restored = this.#callProvider(
            input.task.taskId,
            'navigation.update-route',
            rollbackRequestId,
            () => this.#registry['navigation.update-route'](
              { taskId: input.task.taskId, requestId: rollbackRequestId },
              {
                routeId: rollback.routeId,
                destination: rollback.destination,
                idempotencyKey: `${input.idempotencyKey}:rollback:route`,
              },
            ),
            toolResultSchema(navigationUpdateRouteOutputSchema),
          )
          if (
            restored.succeeded
            && restored.data.routeId === rollback.routeId
            && restored.data.destination === rollback.destination.name
            && restored.data.status === 'active'
          ) {
            applied.route = false
            residual.route = false
            newlyApplied.route = false
            append('navigation.update-route.rollback', 'succeeded', 'navigation.update-route')
          } else {
            append(
              'navigation.update-route.rollback',
              'failed',
              'navigation.update-route',
              restored.succeeded ? 'PROVIDER_FAILED' : restored.errorCode,
            )
          }
        }
      }

      const rolledBack = !residual.route && !residual.cabin && !residual.media
      return {
        succeeded: false,
        effect: effects,
        rolledBack,
        applied,
        residual,
        skipped,
        ...(cabinEffectId ? { cabinEffectId } : {}),
        ...(newlyApplied.cabin ? { cabinEffectIsNew: true } : {}),
        ...(residual.route && navigation.routeId ? { navigation } : {}),
      }
    }
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
    navigation.routeId = update.data.routeId
    navigation.destination = update.data.destination
    navigation.eta = route.arrivalTime
    if (!input.completed?.route && (update.data.routeId !== route.routeId || update.data.destination !== '家' || update.data.status !== 'active')) {
      residual.route = true
      newlyApplied.route = true
      return failed('navigation.update-route', 'PROVIDER_FAILED')
    }
    applied.route = true
    residual.route = true
    if (!input.completed?.route) {
      newlyApplied.route = true
      append('navigation.update-route', 'succeeded')
    }

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
      if (!cabin.succeeded) {
        if (cabin.data?.applied && cabin.data.effectId) {
          cabinEffectId = cabin.data.effectId
          residual.cabin = true
          newlyApplied.cabin = true
        }
        return failed('vehicle.apply-cabin-profile', cabin.errorCode)
      }
      if (
        !cabin.data.applied
        || !cabin.data.reversible
        || (input.preferences.temperatureC !== undefined && cabin.data.current.temperatureC !== input.preferences.temperatureC)
        || (input.preferences.mediaTitle !== undefined && cabin.data.current.mediaTitle !== input.preferences.mediaTitle)
      ) {
        cabinEffectId = cabin.data.effectId
        residual.cabin = true
        newlyApplied.cabin = true
        return failed('vehicle.apply-cabin-profile', 'PROVIDER_FAILED')
      }
      cabinEffectId = cabin.data.effectId
      applied.cabin = true
      residual.cabin = true
      newlyApplied.cabin = true
      append('vehicle.apply-cabin-profile', 'succeeded')
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
      if (!media.succeeded) {
        if (media.data?.status === 'playing') {
          applied.media = true
          residual.media = true
        }
        return failed('media.play', media.errorCode)
      }
      if (media.data.title !== input.preferences.mediaTitle || media.data.status !== 'playing') {
        applied.media = media.data.status === 'playing'
        residual.media = true
        return failed('media.play', 'PROVIDER_FAILED')
      }
      applied.media = true
      residual.media = true
      append('media.play', 'succeeded')
    }

    return {
      succeeded: true,
      effect: effects,
      navigation,
      applied,
      residual,
      skipped,
      ...(cabinEffectId ? { cabinEffectId } : {}),
      ...(newlyApplied.cabin ? { cabinEffectIsNew: true } : {}),
    }
  }

  proposeMemoryUpdate(input: {
    task: AirportPickupTaskState
    memberId: string
    changes: { rearTemperatureC: number }
    requestId: string
    effectId: string
  }): MemoryProposalExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: 'memory.propose-update',
      status,
      tool: 'memory.propose-update',
      ...(errorCode ? { errorCode } : {}),
    })
    const providerRequestId = `${input.task.taskId}:memory.propose-update:${input.requestId}`
    const result = this.#callProvider(
      input.task.taskId,
      'memory.propose-update',
      providerRequestId,
      () => this.#registry['memory.propose-update'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        { memberId: input.memberId, changes: input.changes },
      ),
      toolResultSchema(proposeMemoryUpdateOutputSchema),
    )
    if (!result.succeeded) return { succeeded: false, effect: effect('failed', result.errorCode) }
    if (
      !result.data.requiresConfirmation
      || JSON.stringify(result.data.after) !== JSON.stringify(input.changes)
    ) return { succeeded: false, effect: effect('failed', 'PROVIDER_FAILED') }
    return {
      succeeded: true,
      effect: effect('pending-confirmation'),
      proposal: {
        proposalId: result.data.proposalId,
        memberId: input.memberId,
        confirmationId: result.data.confirmationId,
        expiresAt: result.data.expiresAt,
      },
    }
  }

  confirmMemoryUpdate(input: {
    task: AirportPickupTaskState
    proposalId: string
    confirmationId: string
    memberId: string
    changes: Record<string, unknown>
    idempotencyKey: string
    effectId: string
  }): MemoryConfirmationExecution {
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: 'memory.confirm-update',
      status,
      tool: 'memory.confirm-update',
      ...(errorCode ? { errorCode } : {}),
    })
    const providerRequestId = `${input.task.taskId}:memory.confirm-update:${input.idempotencyKey}`
    const result = this.#callProvider(
      input.task.taskId,
      'memory.confirm-update',
      providerRequestId,
      () => this.#registry['memory.confirm-update'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        {
          proposalId: input.proposalId,
          confirmationId: input.confirmationId,
          idempotencyKey: input.idempotencyKey,
        },
      ),
      toolResultSchema(confirmMemoryUpdateOutputSchema),
    )
    if (!result.succeeded) {
      return { succeeded: false, errorCode: result.errorCode, effect: effect('failed', result.errorCode) }
    }
    if (
      result.data.proposalId !== input.proposalId
      || result.data.memberId !== input.memberId
      || JSON.stringify(result.data.applied) !== JSON.stringify(input.changes)
    ) {
      return { succeeded: false, errorCode: 'PROVIDER_FAILED', effect: effect('failed', 'PROVIDER_FAILED') }
    }
    return { succeeded: true, effect: effect('succeeded') }
  }

  rejectMemoryUpdate(input: {
    task: AirportPickupTaskState
    proposalId: string
    confirmationId: string
    idempotencyKey: string
    effectId: string
  }): MemoryConfirmationExecution {
    const providerRequestId = `${input.task.taskId}:memory.reject-update:${input.idempotencyKey}`
    const result = this.#callProvider(
      input.task.taskId,
      'memory.reject-update',
      providerRequestId,
      () => this.#registry['memory.reject-update'](
        { taskId: input.task.taskId, requestId: providerRequestId },
        { proposalId: input.proposalId, confirmationId: input.confirmationId, idempotencyKey: input.idempotencyKey },
      ),
      toolResultSchema(rejectMemoryUpdateOutputSchema),
    )
    const effect = (status: EffectRecord['status'], errorCode?: string): EffectRecord => ({
      effectId: input.effectId,
      type: 'memory.reject-update',
      status,
      tool: 'memory.reject-update',
      ...(errorCode ? { errorCode } : {}),
    })
    if (!result.succeeded || result.data.proposalId !== input.proposalId || !result.data.rejected) {
      const errorCode = result.succeeded ? 'PROVIDER_FAILED' : result.errorCode
      return { succeeded: false, errorCode, effect: effect('failed', errorCode) }
    }
    return { succeeded: true, effect: effect('cancelled', 'USER_REJECTED') }
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
      return result.ok && result.data !== null && result.error === null
        ? { succeeded: false, errorCode: 'PROVIDER_FAILED', data: result.data }
        : { succeeded: false, errorCode: 'PROVIDER_FAILED' }
    }
    if (result.ok && result.data !== null && result.error === null) {
      return { succeeded: true, data: result.data }
    }
    if (!result.ok && result.data === null && result.error !== null) {
      return { succeeded: false, errorCode: result.error.code }
    }
    return { succeeded: false, errorCode: 'PROVIDER_FAILED' }
  }

  #revokePreparedConfirmation(taskId: string, confirmationId: string, idempotencyKey: string): boolean {
    const requestId = `${taskId}:message.revoke-confirmation:${idempotencyKey}`
    const result = this.#callProvider(
      taskId,
      'message.revoke-confirmation',
      requestId,
      () => this.#registry['message.revoke-confirmation'](
        { taskId, requestId },
        { confirmationId, idempotencyKey },
      ),
      toolResultSchema(revokeMessageConfirmationOutputSchema),
    )
    return result.succeeded && result.data.confirmationId === confirmationId && result.data.revoked
  }
}

function providerErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'PROVIDER_FAILED'
}

function resolveLandingMeetingEta(task: AirportPickupTaskState): string | undefined {
  const iso = task.navigation?.eta ?? task.flight?.estimatedArrival
  if (!iso || Number.isNaN(Date.parse(iso))) return undefined
  const match = /T(\d{2}):(\d{2})/.exec(iso)
  return match ? `${match[1]}:${match[2]}` : undefined
}
