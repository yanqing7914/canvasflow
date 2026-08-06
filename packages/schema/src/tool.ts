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

export const flightStatusOutputSchema = z.object({
  flightNumber: z.string(),
  status: z.enum(['scheduled', 'in-air', 'landed', 'delayed', 'cancelled']),
  scheduledArrival: z.iso.datetime({ offset: true }),
  estimatedArrival: z.iso.datetime({ offset: true }),
  terminal: z.string(),
  baggageClaim: z.string().optional(),
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
})

export const listUpcomingEventsInputSchema = z.object({
  date: z.iso.date(),
})

export const listUpcomingEventsOutputSchema = z.object({
  /** The requested day's remaining events, ordered by start time. */
  events: z.array(calendarEventSchema),
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
export type FlightStatusOutput = z.infer<typeof flightStatusOutputSchema>
export type RoutePlanInput = z.infer<typeof routePlanInputSchema>
export type RoutePlanOutput = z.infer<typeof routePlanOutputSchema>
export type ChargingRecommendationInput = z.infer<typeof chargingRecommendationInputSchema>
export type ChargingRecommendationOutput = z.infer<typeof chargingRecommendationOutputSchema>
export type CalendarEvent = z.infer<typeof calendarEventSchema>
export type ListUpcomingEventsInput = z.infer<typeof listUpcomingEventsInputSchema>
export type ListUpcomingEventsOutput = z.infer<typeof listUpcomingEventsOutputSchema>
export type VehicleStatusOutput = z.infer<typeof vehicleStatusOutputSchema>
export type NavigationStartInput = z.infer<typeof navigationStartInputSchema>
export type NavigationStartOutput = z.infer<typeof navigationStartOutputSchema>
export type NavigationUpdateRouteInput = z.infer<typeof navigationUpdateRouteInputSchema>
export type NavigationUpdateRouteOutput = z.infer<typeof navigationUpdateRouteOutputSchema>
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
