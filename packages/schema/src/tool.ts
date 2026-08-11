import { z } from 'zod'

export const toolRiskLevelSchema = z.enum(['read', 'reversible', 'external', 'persistent', 'blocked'])
export const providerModeSchema = z.enum(['mock', 'live', 'fixture'])

export const toolDefinitionSchema = z.object({
  name: z.string().min(1),
  version: z.literal('1.0'),
  description: z.string().min(1),
  riskLevel: toolRiskLevelSchema,
  timeoutMs: z.number().int().positive(),
})

export const toolResultSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    ok: z.boolean(),
    data: dataSchema.nullable(),
    error: z
      .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
      .nullable(),
    meta: z.object({
      requestId: z.string(),
      taskId: z.string(),
      tool: z.string(),
      provider: providerModeSchema,
      durationMs: z.number().nonnegative(),
      generatedAt: z.iso.datetime({ offset: true }),
    }),
  })

export const resolveMembersInputSchema = z.object({
  labels: z.array(z.string().min(1)).min(1),
})

export const resolveMembersOutputSchema = z.object({
  members: z.array(
    z.object({
      memberId: z.string().min(1),
      displayName: z.string().min(1),
      contactId: z.string().optional(),
    }),
  ),
  unresolvedLabels: z.array(z.string()),
})

export const preferenceScopeSchema = z.enum(['cabin', 'media', 'address', 'notification'])

export const getPreferencesInputSchema = z.object({
  memberIds: z.array(z.string().min(1)).min(1),
  scopes: z.array(preferenceScopeSchema).min(1),
})

export const getPreferencesOutputSchema = z.object({
  members: z.array(
    z.object({
      memberId: z.string().min(1),
      rearTemperatureC: z.number().optional(),
      mediaTitle: z.string().min(1).optional(),
      homeDestinationId: z.string().optional(),
      /** Only present when `notification` is in the requested scopes. */
      landingNotificationAuthorized: z.boolean().optional(),
    }),
  ),
})

export const flightStatusInputSchema = z.object({
  flightNumber: z.string().min(1),
  date: z.iso.date(),
})

/**
 * Which Shanghai airport a flight lands at.
 *
 * The pickup city stays one value — 上海 — and the airport is a per-flight fact
 * rather than a second city, because that is what the driver is actually choosing
 * between: two arrival boards for one city would make "去浦东的那个" a query
 * against the wrong axis.
 *
 * A closed enum rather than a free string: the airport selects a route, a weather
 * location and a meeting point downstream, and every one of those lookups can
 * only answer for airports the fixtures know.
 */
export const arrivalAirportSchema = z.enum(['SHA', 'PVG'])

/**
 * A user-confirmed pickup airport. Known Shanghai airports carry a code; an
 * explicitly named other airport keeps the user's label without pretending the
 * demo owns live route or airport data for it.
 */
export const pickupAirportSchema = z.object({
  label: z.string().trim().min(1).max(80),
  code: arrivalAirportSchema.optional(),
}).strict()

export const flightStatusOutputSchema = z.object({
  flightNumber: z.string(),
  status: z.enum(['scheduled', 'in-air', 'landed', 'delayed', 'cancelled']),
  scheduledArrival: z.iso.datetime({ offset: true }),
  estimatedArrival: z.iso.datetime({ offset: true }),
  /**
   * Which airport, alongside the terminal within it. Required here rather than
   * optional: the status read is what `prepareTrip` derives the drive
   * destination from, and a provider that could omit the airport would silently
   * route a 浦东 pickup to 虹桥.
   */
  arrivalAirport: arrivalAirportSchema,
  arrivalAirportName: z.string().min(1),
  terminal: z.string(),
  baggageClaim: z.string().optional(),
  sourceUpdatedAt: z.iso.datetime({ offset: true }),
})

/**
 * The arrivals board read: which flights are landing at a city, not the status
 * of one the driver already named.
 *
 * `arrivalCityId` rather than a free-text city so the fixture stays keyed and a
 * typo cannot silently return an empty board. `limit` is the caller's cap on how
 * many rows it can present; the provider may return fewer.
 */
export const flightArrivalsInputSchema = z.object({
  arrivalCityId: z.string().min(1),
  date: z.iso.date(),
  limit: z.number().int().min(1).max(10).optional(),
  /** Enables the cockpit's injected-clock deterministic board. */
  queryAt: z.iso.datetime({ offset: true }).optional(),
  /** Stable within one query; a re-query must supply a new id. */
  queryId: z.string().min(1).optional(),
  pickupAirport: pickupAirportSchema.optional(),
})

/**
 * One row of the board. A subset of `flightStatusOutputSchema` plus the airline
 * and origin a driver needs to tell two 20:30 arrivals apart — every row's
 * `flightNumber` is also resolvable through `flight.get-status` for the same
 * date, so picking a row can always be prepared into a trip.
 *
 * The airport rides every row because the board mixes 虹桥 and 浦东: with two
 * airports in one city, a bare terminal ("T2") no longer identifies a place.
 */
export const flightArrivalCandidateSchema = z.object({
  flightNumber: z.string().min(1),
  airlineName: z.string().min(1),
  originName: z.string().min(1),
  status: z.enum(['scheduled', 'in-air', 'landed', 'delayed', 'cancelled']),
  scheduledArrival: z.iso.datetime({ offset: true }),
  estimatedArrival: z.iso.datetime({ offset: true }),
  arrivalAirport: arrivalAirportSchema.optional(),
  arrivalAirportName: z.string().min(1),
  terminal: z.string().min(1),
})

export const flightArrivalsOutputSchema = z.object({
  arrivalCityId: z.string().min(1),
  arrivalCityName: z.string().min(1),
  /**
   * Identity of this exact set of candidates.
   *
   * Derived deterministically from the query and the rows it produced (see
   * `candidateSetId` in packages/tools/src/flight.ts), never minted from a clock
   * or a counter: the same fixture query has to replay to the same id, or
   * "相同输入始终返回相同顺序" stops being checkable.
   *
   * What it is for: an ordinal ("第三个") names a row by position, so it is only
   * meaningful against the set the driver was looking at. Revision numbers
   * already reject a stale pick; this makes *which* set was picked from legible
   * and assertable rather than implied.
   */
  candidateSetId: z.string().min(1),
  queryId: z.string().min(1).optional(),
  queriedAt: z.iso.datetime({ offset: true }).optional(),
  /** After this instant the ordinal path refuses the set and asks for a re-read. */
  expiresAt: z.iso.datetime({ offset: true }),
  arrivals: z.array(flightArrivalCandidateSchema),
  sourceUpdatedAt: z.iso.datetime({ offset: true }),
})

export const routePlanInputSchema = z.object({
  origin: z.object({ latitude: z.number(), longitude: z.number() }),
  destination: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  via: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).optional(),
  preferences: z
    .object({
      avoidHighway: z.boolean().optional(),
      avoidTolls: z.boolean().optional(),
    })
    .optional(),
})

/** Optional map-demo point shared by waypoints and simplified polylines. */
export const routeGeoPointSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
})

export const routeWaypointSchema = routeGeoPointSchema.extend({
  id: z.string().min(1),
  name: z.string().min(1),
})

export const routePlanOutputSchema = z.object({
  routeId: z.string(),
  distanceKm: z.number().nonnegative(),
  durationMinutes: z.number().nonnegative(),
  arrivalTime: z.iso.datetime({ offset: true }),
  estimatedBatteryAtArrival: z.number().min(0).max(100),
  /** Named endpoints / vias for static map labels (optional; UI may ignore). */
  waypoints: z.array(routeWaypointSchema).min(1).optional(),
  /** Simplified fictional polyline (3–8 points) for demo sketch maps. */
  polyline: z.array(routeGeoPointSchema).min(3).max(8).optional(),
  /** One-line human summary distinguishing route variants. */
  summary: z.string().min(1).optional(),
})

export const chargingRecommendationInputSchema = z.object({
  batteryPercent: z.number().min(0).max(100),
  remainingRangeKm: z.number().nonnegative(),
  outboundDistanceKm: z.number().nonnegative(),
  returnDistanceKm: z.number().nonnegative(),
  safetyReservePercent: z.number().min(0).max(100),
})

export const chargingRecommendationOutputSchema = z.object({
  recommended: z.boolean(),
  reason: z.string(),
  estimatedFinalBatteryPercent: z.number().min(0).max(100),
  suggestedDurationMinutes: z.number().positive().optional(),
  stationId: z.string().optional(),
  etaImpactMinutes: z.number().nonnegative().optional(),
})

export const calendarEventSchema = z.object({
  eventId: z.string().min(1),
  title: z.string().min(1),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }).optional(),
  location: z.string().min(1).optional(),
  status: z.enum(['ended', 'ongoing', 'upcoming']).optional(),
})

export const listUpcomingEventsInputSchema = z.object({
  date: z.iso.date(),
  /** When present, fixture events are generated for date and statused at now. */
  now: z.iso.datetime({ offset: true }).optional(),
})

export const listUpcomingEventsOutputSchema = z.object({
  /** The requested day's remaining events, ordered by start time. */
  events: z.array(calendarEventSchema),
})

export const weatherConditionSchema = z.enum(['sunny', 'cloudy', 'overcast', 'light-rain', 'heavy-rain', 'fog'])

export const weatherQueryInputSchema = z.object({
  locationId: z.string().min(1),
  /** Forecast point of interest; omitted means current conditions. */
  at: z.iso.datetime({ offset: true }).optional(),
})

export const weatherOutputSchema = z.object({
  locationId: z.string().min(1),
  locationName: z.string().min(1),
  temperatureC: z.number(),
  condition: weatherConditionSchema,
  windLevel: z.number().int().min(0).max(12).optional(),
  precipitationChance: z.number().min(0).max(100).optional(),
  observedAt: z.iso.datetime({ offset: true }),
})

export const vehicleStatusOutputSchema = z.object({
  speedKph: z.number().nonnegative(),
  batteryPercent: z.number().min(0).max(100),
  remainingRangeKm: z.number().nonnegative(),
  gear: z.enum(['P', 'R', 'N', 'D']),
  isNight: z.boolean(),
  rearOccupied: z.boolean(),
})

export const policyDecisionSchema = z.object({
  allowed: z.boolean(),
  requiresConfirmation: z.boolean(),
  confirmationType: z.enum(['voice', 'touch', 'long-press']).optional(),
  reason: z.string().optional(),
})

export const navigationStartInputSchema = z.object({
  routeId: z.string().min(1),
  idempotencyKey: z.string().min(1),
})

export const navigationStartOutputSchema = z.object({
  navigationId: z.string().min(1),
  routeId: z.string().min(1),
  status: z.literal('active'),
})

export const navigationUpdateRouteInputSchema = z.object({
  routeId: z.string().min(1),
  destination: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  via: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).optional(),
  idempotencyKey: z.string().min(1),
})

export const navigationUpdateRouteOutputSchema = z.object({
  navigationId: z.string().min(1),
  routeId: z.string().min(1),
  destination: z.string().min(1),
  status: z.literal('active'),
})

export const navigationSimulationLegSchema = z.enum(['outbound', 'return'])
export const navigationSimulationSpeedModeSchema = z.enum(['slow', 'normal', 'fast'])
export const navigationSimulationSpeedProfileSchema = z.object({
  durationSeconds: z.number().positive(),
  displaySpeedKph: z.number().positive(),
}).strict()
export const navigationSimulationProfilesSchema = z.object({
  slow: navigationSimulationSpeedProfileSchema,
  normal: navigationSimulationSpeedProfileSchema,
  fast: navigationSimulationSpeedProfileSchema,
}).strict()
export const navigationSimulationSeedSchema = z.object({
  leg: navigationSimulationLegSchema,
  routeId: z.string().min(1),
  distanceKm: z.number().positive(),
  initialBatteryPercent: z.number().min(0).max(100),
  estimatedBatteryAtArrival: z.number().min(0).max(100),
  profiles: navigationSimulationProfilesSchema,
}).strict()

export const cabinProfileValuesSchema = z.object({
  temperatureC: z.number().optional(),
  fanLevel: z.number().optional(),
  mediaTitle: z.string().min(1).optional(),
})

export const applyCabinProfileInputSchema = z.object({
  zone: z.literal('rear'),
  temperatureC: z.number().min(16).max(32).optional(),
  fanLevel: z.number().int().min(0).max(5).optional(),
  mediaTitle: z.string().min(1).optional(),
  sourceMemberIds: z.array(z.string().min(1)).min(1),
  idempotencyKey: z.string().min(1),
})

export const applyCabinProfileOutputSchema = z.object({
  effectId: z.string().min(1),
  applied: z.boolean(),
  previous: cabinProfileValuesSchema,
  current: cabinProfileValuesSchema,
  reversible: z.boolean(),
})

export const revertCabinProfileInputSchema = z.object({
  effectId: z.string().min(1),
  idempotencyKey: z.string().min(1),
})

export const revertCabinProfileOutputSchema = z.object({
  effectId: z.string().min(1),
  reverted: z.boolean(),
  current: cabinProfileValuesSchema,
})

export const mediaPlayInputSchema = z.object({
  mediaTitle: z.string().min(1),
  sourceMemberId: z.string().optional(),
  idempotencyKey: z.string().min(1),
})

export const mediaPlayOutputSchema = z.object({
  playbackId: z.string().min(1),
  title: z.string().min(1),
  status: z.literal('playing'),
  reversible: z.literal(true),
})

export const messagePrepareInputSchema = z.object({
  contactId: z.string().min(1),
  flightNumber: z.string().min(1),
  eta: z.string().optional(),
  /**
   * Which fixed template to prepare. An enum on purpose: neither the client
   * nor a model may inject free-form message text — every sendable payload
   * comes from a reviewed template. Absent means the landing notice.
   */
  kind: z.enum(['landing', 'weather-umbrella']).optional(),
})

export const messagePrepareOutputSchema = z.object({
  messageId: z.string().min(1),
  contactId: z.string().min(1),
  text: z.string().min(1),
  /**
   * Opaque, single-use credential issued into the registry runtime's ConfirmationStore.
   * Pass the same id to `message.send` for the explicit confirm path; bound to this
   * prepared message (taskId + contactId + messageId + text). Auto-notify may omit it.
   */
  confirmationId: z.string().min(1),
})

export const messageSendInputSchema = z.object({
  contactId: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string().min(1),
  authorizationId: z.string().optional(),
  confirmationId: z.string().optional(),
  idempotencyKey: z.string().min(1),
})

export const messageSendOutputSchema = z.object({
  messageId: z.string().min(1),
  status: z.literal('sent'),
  sentAt: z.iso.datetime({ offset: true }),
})

export const revokeMessageConfirmationInputSchema = z.object({
  confirmationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
})

export const revokeMessageConfirmationOutputSchema = z.object({
  confirmationId: z.string().min(1),
  revoked: z.literal(true),
})

export const revokeMessageAuthorizationInputSchema = z.object({
  authorizationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
})

export const revokeMessageAuthorizationOutputSchema = z.object({
  authorizationId: z.string().min(1),
  revoked: z.literal(true),
})

export const memoryPreferenceChangeSchema = z.object({
  rearTemperatureC: z.number().min(16).max(32).optional(),
  mediaTitle: z.string().min(1).optional(),
  homeDestinationId: z.string().min(1).optional(),
  landingNotificationAuthorized: z.boolean().optional(),
}).strict()

export const proposeMemoryUpdateInputSchema = z.object({
  memberId: z.string().min(1),
  changes: memoryPreferenceChangeSchema,
})

export const proposeMemoryUpdateOutputSchema = z.object({
  proposalId: z.string().min(1),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  requiresConfirmation: z.literal(true),
  /** The exact confirmation credential `memory.confirm-update` will accept for this proposal. */
  confirmationId: z.string().min(1),
  /** Absolute expiry for the one-shot confirmation and its proposal. */
  expiresAt: z.iso.datetime({ offset: true }),
})

export const confirmMemoryUpdateInputSchema = z.object({
  proposalId: z.string().min(1),
  confirmationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
})

export const confirmMemoryUpdateOutputSchema = z.object({
  proposalId: z.string().min(1),
  memberId: z.string().min(1),
  applied: z.record(z.string(), z.unknown()),
})

export const rejectMemoryUpdateOutputSchema = z.object({
  proposalId: z.string().min(1),
  rejected: z.literal(true),
})

export type ProviderMode = z.infer<typeof providerModeSchema>
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>
export type ResolveMembersInput = z.infer<typeof resolveMembersInputSchema>
export type ResolveMembersOutput = z.infer<typeof resolveMembersOutputSchema>
export type PreferenceScope = z.infer<typeof preferenceScopeSchema>
export type GetPreferencesInput = z.infer<typeof getPreferencesInputSchema>
export type GetPreferencesOutput = z.infer<typeof getPreferencesOutputSchema>
export type FlightStatusInput = z.infer<typeof flightStatusInputSchema>
export type ArrivalAirport = z.infer<typeof arrivalAirportSchema>
export type PickupAirport = z.infer<typeof pickupAirportSchema>
export type FlightStatusOutput = z.infer<typeof flightStatusOutputSchema>
export type FlightArrivalsInput = z.infer<typeof flightArrivalsInputSchema>
export type FlightArrivalCandidate = z.infer<typeof flightArrivalCandidateSchema>
export type FlightArrivalsOutput = z.infer<typeof flightArrivalsOutputSchema>
export type RoutePlanInput = z.infer<typeof routePlanInputSchema>
export type RoutePlanOutput = z.infer<typeof routePlanOutputSchema>
export type ChargingRecommendationInput = z.infer<typeof chargingRecommendationInputSchema>
export type ChargingRecommendationOutput = z.infer<typeof chargingRecommendationOutputSchema>
export type CalendarEvent = z.infer<typeof calendarEventSchema>
export type ListUpcomingEventsInput = z.infer<typeof listUpcomingEventsInputSchema>
export type ListUpcomingEventsOutput = z.infer<typeof listUpcomingEventsOutputSchema>
export type WeatherCondition = z.infer<typeof weatherConditionSchema>
export type WeatherQueryInput = z.infer<typeof weatherQueryInputSchema>
export type WeatherOutput = z.infer<typeof weatherOutputSchema>
export type VehicleStatusOutput = z.infer<typeof vehicleStatusOutputSchema>
export type NavigationStartInput = z.infer<typeof navigationStartInputSchema>
export type NavigationStartOutput = z.infer<typeof navigationStartOutputSchema>
export type NavigationUpdateRouteInput = z.infer<typeof navigationUpdateRouteInputSchema>
export type NavigationUpdateRouteOutput = z.infer<typeof navigationUpdateRouteOutputSchema>
export type NavigationSimulationLeg = z.infer<typeof navigationSimulationLegSchema>
export type NavigationSimulationSpeedMode = z.infer<typeof navigationSimulationSpeedModeSchema>
export type NavigationSimulationSpeedProfile = z.infer<typeof navigationSimulationSpeedProfileSchema>
export type NavigationSimulationProfiles = z.infer<typeof navigationSimulationProfilesSchema>
export type NavigationSimulationSeed = z.infer<typeof navigationSimulationSeedSchema>
export type ApplyCabinProfileInput = z.infer<typeof applyCabinProfileInputSchema>
export type ApplyCabinProfileOutput = z.infer<typeof applyCabinProfileOutputSchema>
export type RevertCabinProfileInput = z.infer<typeof revertCabinProfileInputSchema>
export type RevertCabinProfileOutput = z.infer<typeof revertCabinProfileOutputSchema>
export type MediaPlayInput = z.infer<typeof mediaPlayInputSchema>
export type MediaPlayOutput = z.infer<typeof mediaPlayOutputSchema>
export type MessagePrepareInput = z.infer<typeof messagePrepareInputSchema>
export type MessagePrepareOutput = z.infer<typeof messagePrepareOutputSchema>
export type MessageSendInput = z.infer<typeof messageSendInputSchema>
export type MessageSendOutput = z.infer<typeof messageSendOutputSchema>
export type RevokeMessageConfirmationInput = z.infer<typeof revokeMessageConfirmationInputSchema>
export type RevokeMessageConfirmationOutput = z.infer<typeof revokeMessageConfirmationOutputSchema>
export type RevokeMessageAuthorizationInput = z.infer<typeof revokeMessageAuthorizationInputSchema>
export type RevokeMessageAuthorizationOutput = z.infer<typeof revokeMessageAuthorizationOutputSchema>
export type ProposeMemoryUpdateInput = z.infer<typeof proposeMemoryUpdateInputSchema>
export type ProposeMemoryUpdateOutput = z.infer<typeof proposeMemoryUpdateOutputSchema>
export type ConfirmMemoryUpdateInput = z.infer<typeof confirmMemoryUpdateInputSchema>
export type ConfirmMemoryUpdateOutput = z.infer<typeof confirmMemoryUpdateOutputSchema>
export type RejectMemoryUpdateOutput = z.infer<typeof rejectMemoryUpdateOutputSchema>
export type ToolResult<T> = {
  ok: boolean
  data: T | null
  error: { code: string; message: string; retryable: boolean } | null
  meta: {
    requestId: string
    taskId: string
    tool: string
    provider: ProviderMode
    durationMs: number
    generatedAt: string
  }
}
