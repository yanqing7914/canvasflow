import {
  chargingRecommendationOutputSchema,
  flightStatusOutputSchema,
  getPreferencesOutputSchema,
  resolveMembersOutputSchema,
  routePlanOutputSchema,
  toolResultSchema,
  vehicleStatusOutputSchema,
  type ChargingRecommendationOutput,
  type FlightStatusOutput,
  type GetPreferencesOutput,
  type ResolveMembersOutput,
  type RoutePlanOutput,
  type ToolResult,
  type VehicleStatusOutput,
} from '@canvasflow/schema'
import { createProviderRegistry, DEMO_ORIGIN, type ProviderRegistry, type ToolName } from '@canvasflow/tools'

type SuccessfulToolResult<T> = ToolResult<T> & { ok: true; data: T; error: null }

export type ReadToolResults = Partial<{
  'family.resolve-members': SuccessfulToolResult<ResolveMembersOutput>
  'memory.get-preferences': SuccessfulToolResult<GetPreferencesOutput>
  'flight.get-status': SuccessfulToolResult<FlightStatusOutput>
  'navigation.plan-route': SuccessfulToolResult<RoutePlanOutput>
  'vehicle.get-status': SuccessfulToolResult<VehicleStatusOutput>
  'charging.recommend': SuccessfulToolResult<ChargingRecommendationOutput>
}>

export class ReadToolOrchestrationError extends Error {
  constructor(
    readonly code: 'PROVIDER_FAILED' | 'PROVIDER_TIMEOUT',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

export type ReadToolOrchestratorOptions = {
  registry?: ProviderRegistry
  fixtureDate?: string
  origin?: { latitude: number; longitude: number }
  destination?: { id: string; name: string }
  safetyReservePercent?: number
}

export type InitialPassengerReads = {
  passengers: { memberIds: string[]; names: string[] }
  notificationAuthorized: boolean
  toolResults: ReadToolResults
}

export type TripPreparationReads = {
  flight: FlightStatusOutput
  route: RoutePlanOutput
  vehicle: VehicleStatusOutput
  charging: ChargingRecommendationOutput
  toolResults: ReadToolResults
}

export type ReturnTripPreferenceReads = SuccessfulToolResult<GetPreferencesOutput>

export interface ReadToolOrchestration {
  resolveInitialPassengers(taskId: string, requestId: string, labels: string[]): InitialPassengerReads
  prepareTrip(taskId: string, requestId: string, flightNumber: string): TripPreparationReads
  resolveReturnTripPreferences(taskId: string, requestId: string, memberIds: string[]): ReturnTripPreferenceReads
}

export class ReadToolOrchestrator implements ReadToolOrchestration {
  readonly #registry: ProviderRegistry
  readonly #fixtureDate: string
  readonly #origin: { latitude: number; longitude: number }
  readonly #destination: { id: string; name: string }
  readonly #safetyReservePercent: number

  constructor(options: ReadToolOrchestratorOptions = {}) {
    this.#registry = options.registry ?? createProviderRegistry()
    this.#fixtureDate = options.fixtureDate ?? '2026-07-22'
    this.#origin = options.origin ?? { ...DEMO_ORIGIN }
    this.#destination = options.destination ?? { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' }
    this.#safetyReservePercent = options.safetyReservePercent ?? 20
  }

  resolveInitialPassengers(taskId: string, requestId: string, labels: string[]): InitialPassengerReads {
    if (labels.length === 0) {
      return { passengers: { memberIds: [], names: [] }, notificationAuthorized: false, toolResults: {} }
    }

    const family = this.#call(
      'family.resolve-members',
      taskId,
      requestId,
      { labels },
      toolResultSchema(resolveMembersOutputSchema),
    )
    const memberIds = family.data.members.map((member) => member.memberId)
    const preferences = this.#call(
      'memory.get-preferences',
      taskId,
      requestId,
      { memberIds, scopes: ['notification'] },
      toolResultSchema(getPreferencesOutputSchema),
    )
    const notificationAuthorizedMemberIds = new Set(
      preferences.data.members
        .filter((member) => member.landingNotificationAuthorized === true)
        .map((member) => member.memberId),
    )

    return {
      passengers: {
        memberIds,
        names: family.data.members.map((member) => member.displayName),
      },
      notificationAuthorized: family.data.members.some(
        (member) => member.contactId !== undefined && notificationAuthorizedMemberIds.has(member.memberId),
      ),
      toolResults: {
        'family.resolve-members': family,
        'memory.get-preferences': preferences,
      },
    }
  }

  prepareTrip(taskId: string, requestId: string, flightNumber: string): TripPreparationReads {
    const flight = this.#call(
      'flight.get-status',
      taskId,
      requestId,
      { flightNumber, date: this.#fixtureDate },
      toolResultSchema(flightStatusOutputSchema),
    )
    const route = this.#call(
      'navigation.plan-route',
      taskId,
      requestId,
      { origin: this.#origin, destination: this.#destination },
      toolResultSchema(routePlanOutputSchema),
    )
    const vehicle = this.#call(
      'vehicle.get-status',
      taskId,
      requestId,
      undefined,
      toolResultSchema(vehicleStatusOutputSchema),
    )
    const charging = this.#call(
      'charging.recommend',
      taskId,
      requestId,
      {
        batteryPercent: vehicle.data.batteryPercent,
        remainingRangeKm: vehicle.data.remainingRangeKm,
        outboundDistanceKm: route.data.distanceKm,
        returnDistanceKm: route.data.distanceKm,
        safetyReservePercent: this.#safetyReservePercent,
      },
      toolResultSchema(chargingRecommendationOutputSchema),
    )

    return {
      flight: flight.data,
      route: route.data,
      vehicle: vehicle.data,
      charging: charging.data,
      toolResults: {
        'flight.get-status': flight,
        'navigation.plan-route': route,
        'vehicle.get-status': vehicle,
        'charging.recommend': charging,
      },
    }
  }

  resolveReturnTripPreferences(taskId: string, requestId: string, memberIds: string[]): ReturnTripPreferenceReads {
    return this.#call(
      'memory.get-preferences',
      taskId,
      requestId,
      { memberIds, scopes: ['cabin', 'media', 'address'] },
      toolResultSchema(getPreferencesOutputSchema),
    )
  }

  #call<T>(
    tool: ToolName,
    taskId: string,
    requestId: string,
    input: unknown,
    schema: { safeParse(value: unknown): { success: true; data: ToolResult<T> } | { success: false } },
  ): SuccessfulToolResult<T> {
    const maxAttempts = tool === 'flight.get-status' || tool === 'navigation.plan-route' ? 2 : 1
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = this.#attempt(tool, taskId, requestId, input, schema)
      if ('result' in outcome) return outcome.result
      if (!outcome.error.retryable || attempt === maxAttempts) throw outcome.error
    }
    throw new ReadToolOrchestrationError('PROVIDER_FAILED', `${tool} provider failed`, false)
  }

  #attempt<T>(
    tool: ToolName,
    taskId: string,
    requestId: string,
    input: unknown,
    schema: { safeParse(value: unknown): { success: true; data: ToolResult<T> } | { success: false } },
  ): { result: SuccessfulToolResult<T> } | { error: ReadToolOrchestrationError } {
    let raw: unknown
    try {
      raw = this.#registry[tool]({ taskId, requestId: `${requestId}:${tool}` }, input)
    } catch (error) {
      const timeout = hasErrorCode(error, 'PROVIDER_TIMEOUT')
      return {
        error: new ReadToolOrchestrationError(
          timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_FAILED',
          error instanceof Error ? error.message : `${tool} provider failed`,
          timeout || hasRetryableFlag(error),
        ),
      }
    }

    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return { error: new ReadToolOrchestrationError('PROVIDER_FAILED', `${tool} returned an invalid result envelope`, false) }
    }
    const result = parsed.data
    if (result.meta.taskId !== taskId || result.meta.tool !== tool || result.meta.requestId !== `${requestId}:${tool}`) {
      return { error: new ReadToolOrchestrationError('PROVIDER_FAILED', `${tool} returned mismatched result metadata`, false) }
    }
    if (!result.ok || result.data === null || result.error !== null) {
      const error = result.error
      const timeout = error?.code === 'PROVIDER_TIMEOUT'
      return {
        error: new ReadToolOrchestrationError(
          timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_FAILED',
          error?.message ?? `${tool} provider failed`,
          error?.retryable ?? false,
        ),
      }
    }
    return { result: result as SuccessfulToolResult<T> }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function hasRetryableFlag(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true
}
