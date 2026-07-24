import { z } from 'zod'
import { airportPickupEventSchema, airportPickupTaskStateSchema } from './task'
import { uiSpecSchema } from './ui'

export const vehicleContextSchema = z.object({
  speedKph: z.number().nonnegative(),
  batteryPercent: z.number().min(0).max(100),
  remainingRangeKm: z.number().nonnegative(),
  gear: z.enum(['P', 'R', 'N', 'D']),
  isNight: z.boolean(),
})

export const clientCapabilitiesSchema = z.object({
  uiSchemaVersion: z.literal('1.0'),
  supportsSse: z.boolean(),
  supportsTts: z.boolean(),
})

export const agentInputSchema = z.object({
  type: z.literal('text'),
  text: z.string().trim().min(1),
  source: z.enum(['text', 'voice']).optional(),
  confidence: z.number().min(0).max(1).optional(),
})

export const createTaskRequestSchema = z.object({
  clientRequestId: z.string().min(1),
  input: agentInputSchema,
  vehicleContext: vehicleContextSchema,
  clientCapabilities: clientCapabilitiesSchema,
})

export const submitEventRequestSchema = z.object({
  clientRequestId: z.string().min(1),
  expectedTaskRevision: z.number().int().nonnegative(),
  event: airportPickupEventSchema,
})

export const submitActionRequestSchema = z.object({
  clientRequestId: z.string().min(1),
  expectedTaskRevision: z.number().int().nonnegative(),
  expectedUiRevision: z.number().int().nonnegative(),
  actionId: z.string().min(1),
  componentId: z.string().min(1),
  idempotencyKey: z.string().min(1),
})

export const submitConfirmationRequestSchema = z.object({
  clientRequestId: z.string().min(1),
  expectedTaskRevision: z.number().int().nonnegative(),
  decision: z.enum(['accept', 'reject']),
  idempotencyKey: z.string().min(1),
})

export const effectRecordSchema = z.object({
  effectId: z.string(),
  type: z.string(),
  status: z.enum(['planned', 'pending-confirmation', 'succeeded', 'failed', 'cancelled']),
  tool: z.string().optional(),
  errorCode: z.string().optional(),
})

export const agentResponseSchema = z.object({
  requestId: z.string(),
  task: airportPickupTaskStateSchema,
  ui: uiSpecSchema,
  assistant: z.object({ text: z.string(), shouldSpeak: z.boolean() }).optional(),
  effects: z.array(effectRecordSchema),
  meta: z.object({
    mode: z.enum(['fixture', 'mock', 'live']),
    durationMs: z.number().nonnegative(),
    modelUsed: z.string().optional(),
    fallbackUsed: z.boolean(),
  }),
})

export const agentErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'TASK_NOT_FOUND',
  'TASK_REVISION_CONFLICT',
  'UI_REVISION_CONFLICT',
  'CONFIRMATION_EXPIRED',
  'POLICY_DENIED',
  'PROVIDER_FAILED',
  'PROVIDER_TIMEOUT',
])

export const agentErrorResponseSchema = z.object({
  requestId: z.string(),
  error: z.object({
    code: agentErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  latest: z.object({ task: airportPickupTaskStateSchema, ui: uiSpecSchema }).optional(),
})

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>
export type SubmitEventRequest = z.infer<typeof submitEventRequestSchema>
export type SubmitActionRequest = z.infer<typeof submitActionRequestSchema>
export type SubmitConfirmationRequest = z.infer<typeof submitConfirmationRequestSchema>
export type EffectRecord = z.infer<typeof effectRecordSchema>
export type AgentResponse = z.infer<typeof agentResponseSchema>
export type AgentErrorCode = z.infer<typeof agentErrorCodeSchema>
export type AgentErrorResponse = z.infer<typeof agentErrorResponseSchema>
