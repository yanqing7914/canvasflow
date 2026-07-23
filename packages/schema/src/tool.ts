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
      mediaTitle: z.string().optional(),
      homeDestinationId: z.string().optional(),
      landingNotificationAuthorized: z.boolean(),
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

export const routePlanOutputSchema = z.object({
  routeId: z.string(),
  distanceKm: z.number().nonnegative(),
  durationMinutes: z.number().nonnegative(),
  arrivalTime: z.iso.datetime({ offset: true }),
  estimatedBatteryAtArrival: z.number().min(0).max(100),
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
export type VehicleStatusOutput = z.infer<typeof vehicleStatusOutputSchema>
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
