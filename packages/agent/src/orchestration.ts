import {
  chargingRecommendationOutputSchema,
  flightArrivalsOutputSchema,
  flightStatusOutputSchema,
  getPreferencesOutputSchema,
  listUpcomingEventsOutputSchema,
  resolveMembersOutputSchema,
  routePlanOutputSchema,
  toolResultSchema,
  vehicleStatusOutputSchema,
  weatherOutputSchema,
  type ChargingRecommendationOutput,
  type FlightArrivalsOutput,
  type FlightStatusOutput,
  type GetPreferencesOutput,
  type ListUpcomingEventsOutput,
  type ResolveMembersOutput,
  type RoutePlanOutput,
  type ToolResult,
  type VehicleContext,
  type VehicleStatusOutput,
  type WeatherOutput,
  type AirportPickupTaskState,
} from '@canvasflow/schema'
import {
  ARRIVAL_CITY,
  createProviderRegistry,
  DEMO_PICKUP_POINT,
  DEMO_ORIGIN,
  pickupDestinationForAirport,
  type ProviderRegistry,
  type ToolName,
} from '@canvasflow/tools'

type SuccessfulToolResult<T> = ToolResult<T> & { ok: true; data: T; error: null }

export type ReadToolResults = Partial<{
  'family.resolve-members': SuccessfulToolResult<ResolveMembersOutput>
  'memory.get-preferences': SuccessfulToolResult<GetPreferencesOutput>
  'flight.get-status': SuccessfulToolResult<FlightStatusOutput>
  /**
   * The arrivals board offered before the driver has named a flight. Read on the
   * turns that still lack the slot and dropped once it is filled: a board kept
   * around after the pick would keep offering a choice already made.
   */
  'flight.list-arrivals': SuccessfulToolResult<FlightArrivalsOutput>
  'navigation.plan-route': SuccessfulToolResult<RoutePlanOutput>
  'vehicle.get-status': SuccessfulToolResult<VehicleStatusOutput>
  'charging.recommend': SuccessfulToolResult<ChargingRecommendationOutput>
  'calendar.list-upcoming': SuccessfulToolResult<ListUpcomingEventsOutput>
  /**
   * The check-schedule query turn's own reading. A separate key on purpose:
   * 'calendar.list-upcoming' persists across events to feed the schedule
   * strip, while this key exists only in the one published snapshot that
   * answers the query — the strip and the card must never fight over data.
   */
  'calendar.query': SuccessfulToolResult<ListUpcomingEventsOutput>
  'weather.get-current': SuccessfulToolResult<WeatherOutput>
  /**
   * The proactive advisory's own persisted reading. A separate key on purpose:
   * 'weather.get-current' is the transient query answer that must vanish on
   * the next event, while this one must survive every recompose for as long
   * as the advisory is active.
   */
  'weather.advisory': SuccessfulToolResult<WeatherOutput>
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
  safetyReservePercent?: number
}

export type InitialPassengerReads = {
  passengers: { memberIds: string[]; names: string[] }
  notificationAuthorized: boolean
  toolResults: ReadToolResults
}

export type TripPreparationReads = {
  flight: FlightStatusOutput
  /**
   * Where the drive was planned to, derived from the flight unless the caller
   * named one. Returned rather than left implicit because the destination is
   * what the navigation label, the weather advisory and the meeting point all
   * have to agree on — handing back the one that was actually used is cheaper
   * than three callers re-deriving it and one of them getting it wrong.
   */
  destination: { id: string; name: string }
  route: RoutePlanOutput
  vehicle: VehicleStatusOutput
  charging: ChargingRecommendationOutput
  toolResults: ReadToolResults
}

export type ReturnTripPreferenceReads = SuccessfulToolResult<GetPreferencesOutput>

export interface ReadToolOrchestration {
  resolveInitialPassengers(taskId: string, requestId: string, labels: string[]): InitialPassengerReads
  prepareTrip(taskId: string, requestId: string, flightNumber: string, context?: {
    vehicle?: VehicleContext
    destination?: { id: string; name: string }
  }): TripPreparationReads
  resolveReturnTripPreferences(taskId: string, requestId: string, memberIds: string[]): ReturnTripPreferenceReads
  /**
   * On-demand weather read for the check-weather query intent. Optional so
   * test doubles built for the trip flow keep compiling; a gateway facing an
   * orchestration without it degrades to the weather-unavailable reply.
   */
  resolveWeather?(taskId: string, requestId: string, input: { locationId: string; at?: string }): SuccessfulToolResult<WeatherOutput>
  /** On-demand single-flight read for cockpit flight-detail queries. */
  resolveFlightStatus?(taskId: string, requestId: string, flightNumber: string): SuccessfulToolResult<FlightStatusOutput>
  /**
   * On-demand calendar read for the check-schedule query intent. Optional for
   * the same reason as resolveWeather; a missing implementation degrades to
   * the schedule-unavailable reply.
   */
  resolveSchedule?(taskId: string, requestId: string, input: { date: string; now?: string }): SuccessfulToolResult<ListUpcomingEventsOutput>
  /** Re-evaluates charging against the vehicle and distances at query time. */
  resolveCharging?(taskId: string, requestId: string, input: {
    batteryPercent: number
    remainingRangeKm: number
    outboundDistanceKm: number
    returnDistanceKm: number
  }): SuccessfulToolResult<ChargingRecommendationOutput>
  /**
   * The arrivals board for the demo's one pickup city, on the fixture date.
   * Optional for the same reason as the two above; without it the Agent asks
   * for the flight number instead of offering a list.
   */
  resolveArrivals?(taskId: string, requestId: string, input?: {
    limit?: number
    queryAt?: string
    queryId?: string
    pickupAirport?: AirportPickupTaskState['pickupAirport']
  }): SuccessfulToolResult<FlightArrivalsOutput>
  resolveCockpitRoute?(taskId: string, requestId: string, input: {
    leg: 'outbound' | 'return'
    pickupAirport?: AirportPickupTaskState['pickupAirport']
    vehicle?: VehicleContext
  }): {
    route: SuccessfulToolResult<RoutePlanOutput>
    vehicle: SuccessfulToolResult<VehicleStatusOutput>
    charging: SuccessfulToolResult<ChargingRecommendationOutput>
  }
}

export class ReadToolOrchestrator implements ReadToolOrchestration {
  readonly #registry: ProviderRegistry
  readonly #fixtureDate: string
  readonly #origin: { latitude: number; longitude: number }
  readonly #safetyReservePercent: number

  constructor(options: ReadToolOrchestratorOptions = {}) {
    this.#registry = options.registry ?? createProviderRegistry()
    this.#fixtureDate = options.fixtureDate ?? '2026-07-22'
    this.#origin = options.origin ?? { ...DEMO_ORIGIN }
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

  prepareTrip(taskId: string, requestId: string, flightNumber: string, context?: {
    vehicle?: VehicleContext
    destination?: { id: string; name: string }
  }): TripPreparationReads {
    const flight = this.#call(
      'flight.get-status',
      taskId,
      requestId,
      { flightNumber, date: this.#fixtureDate },
      toolResultSchema(flightStatusOutputSchema),
    )
    // The flight is read before the route on purpose: which airport the plane
    // lands at is what decides where the car drives, and 虹桥 and 浦东 are on
    // opposite sides of the city. Settling the destination before the flight is
    // known — as a caller-supplied default would — is how a 浦东 pickup ends up
    // routed west without anything failing. An explicitly named destination still
    // wins, since a caller that names one is answering a different question.
    const destination = context?.destination ?? pickupDestinationForAirport(flight.data.arrivalAirport)
    const route = this.#call(
      'navigation.plan-route',
      taskId,
      requestId,
      { origin: this.#origin, destination },
      toolResultSchema(routePlanOutputSchema),
    )
    const vehicle = this.#call(
      'vehicle.get-status',
      taskId,
      requestId,
      context?.vehicle ? { context: context.vehicle } : undefined,
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

    // The calendar only feeds the schedule strip. Losing it costs the driver
    // one auxiliary band, so a provider failure here must never take down the
    // trip preparation the way a flight or route failure does.
    let calendar: SuccessfulToolResult<ListUpcomingEventsOutput> | undefined
    try {
      calendar = this.#call(
        'calendar.list-upcoming',
        taskId,
        requestId,
        { date: this.#fixtureDate },
        toolResultSchema(listUpcomingEventsOutputSchema),
      )
    } catch {
      calendar = undefined
    }

    return {
      flight: flight.data,
      destination,
      route: route.data,
      vehicle: vehicle.data,
      charging: charging.data,
      toolResults: {
        'flight.get-status': flight,
        'navigation.plan-route': route,
        'vehicle.get-status': vehicle,
        'charging.recommend': charging,
        ...(calendar ? { 'calendar.list-upcoming': calendar } : {}),
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

  resolveWeather(taskId: string, requestId: string, input: { locationId: string; at?: string }): SuccessfulToolResult<WeatherOutput> {
    return this.#call(
      'weather.get-current',
      taskId,
      requestId,
      input,
      toolResultSchema(weatherOutputSchema),
    )
  }

  resolveFlightStatus(taskId: string, requestId: string, flightNumber: string): SuccessfulToolResult<FlightStatusOutput> {
    return this.#call(
      'flight.get-status',
      taskId,
      requestId,
      { flightNumber, date: this.#fixtureDate },
      toolResultSchema(flightStatusOutputSchema),
    )
  }

  resolveSchedule(taskId: string, requestId: string, input: { date: string; now?: string }): SuccessfulToolResult<ListUpcomingEventsOutput> {
    return this.#call(
      'calendar.list-upcoming',
      taskId,
      requestId,
      input,
      toolResultSchema(listUpcomingEventsOutputSchema),
    )
  }

  resolveCharging(taskId: string, requestId: string, input: {
    batteryPercent: number
    remainingRangeKm: number
    outboundDistanceKm: number
    returnDistanceKm: number
  }): SuccessfulToolResult<ChargingRecommendationOutput> {
    return this.#call(
      'charging.recommend',
      taskId,
      requestId,
      { ...input, safetyReservePercent: this.#safetyReservePercent },
      toolResultSchema(chargingRecommendationOutputSchema),
    )
  }

  /**
   * The city and the date are the orchestrator's own, not the caller's: the
   * demo has one pickup city and one fixture day, and letting a caller pass
   * either would invite a board for a date the flight lookups cannot match.
   */
  resolveArrivals(taskId: string, requestId: string, input: {
    limit?: number
    queryAt?: string
    queryId?: string
    pickupAirport?: AirportPickupTaskState['pickupAirport']
  } = {}): SuccessfulToolResult<FlightArrivalsOutput> {
    return this.#call(
      'flight.list-arrivals',
      taskId,
      requestId,
      {
        arrivalCityId: ARRIVAL_CITY.id,
        date: input.queryAt?.slice(0, 10) ?? this.#fixtureDate,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.queryAt ? { queryAt: input.queryAt } : {}),
        ...(input.queryId ? { queryId: input.queryId } : {}),
        ...(input.pickupAirport ? { pickupAirport: input.pickupAirport } : {}),
      },
      toolResultSchema(flightArrivalsOutputSchema),
    )
  }

  resolveCockpitRoute(taskId: string, requestId: string, input: {
    leg: 'outbound' | 'return'
    pickupAirport?: AirportPickupTaskState['pickupAirport']
    vehicle?: VehicleContext
  }): {
    route: SuccessfulToolResult<RoutePlanOutput>
    vehicle: SuccessfulToolResult<VehicleStatusOutput>
    charging: SuccessfulToolResult<ChargingRecommendationOutput>
  } {
    const destination = input.leg === 'return'
      ? { id: 'destination-home', name: '家' }
      : input.pickupAirport?.code
        ? pickupDestinationForAirport(input.pickupAirport.code)
        : { id: 'destination-hongqiao-t2', name: input.pickupAirport?.label ?? '机场接人点' }
    const route = this.#call(
        'navigation.plan-route', taskId, requestId,
        { origin: input.leg === 'return' ? DEMO_PICKUP_POINT : this.#origin, destination }, toolResultSchema(routePlanOutputSchema),
      )
    const vehicle = this.#call(
        'vehicle.get-status', taskId, requestId,
        input.vehicle ? { context: input.vehicle } : undefined, toolResultSchema(vehicleStatusOutputSchema),
      )
    const charging = this.#call(
      'charging.recommend', taskId, requestId,
      {
        batteryPercent: vehicle.data.batteryPercent,
        remainingRangeKm: vehicle.data.remainingRangeKm,
        outboundDistanceKm: route.data.distanceKm,
        // An outbound plan still has both legs ahead. A return plan starts at
        // the airport, so only the homeward leg remains.
        returnDistanceKm: input.leg === 'outbound' ? route.data.distanceKm : 0,
        safetyReservePercent: this.#safetyReservePercent,
      }, toolResultSchema(chargingRecommendationOutputSchema),
    )
    return { route, vehicle, charging }
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
