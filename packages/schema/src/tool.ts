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

export const routePlanOutputSchema = z.object({
  routeId: z.string(),
  distanceKm: z.number().nonnegative(),
  durationMinutes: z.number().nonnegative(),
  arrivalTime: z.iso.datetime({ offset: true }),
  estimatedBatteryAtArrival: z.number().min(0).max(100),
})

export const chargingRecommendationOutputSchema = z.object({
  recommended: z.boolean(),
  reason: z.string(),
  estimatedFinalBatteryPercent: z.number().min(0).max(100),
  suggestedDurationMinutes: z.number().positive().optional(),
  stationId: z.string().optional(),
  etaImpactMinutes: z.number().nonnegative().optional(),
})

export const policyDecisionSchema = z.object({
  allowed: z.boolean(),
  requiresConfirmation: z.boolean(),
  confirmationType: z.enum(['voice', 'touch', 'long-press']).optional(),
  reason: z.string().optional(),
})

export type ProviderMode = z.infer<typeof providerModeSchema>
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>
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
