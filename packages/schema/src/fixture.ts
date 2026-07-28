import { z } from 'zod'
import { airportPickupEventSchema, airportPickupPhaseSchema, airportPickupTaskStateSchema } from './task'
import { providerModeSchema } from './tool'
import { uiSpecSchema, type ComponentSpec } from './ui'

export const scenarioFixtureSchema = z.object({
  id: z.string(),
  title: z.string(),
  mode: providerModeSchema,
  inputEvent: airportPickupEventSchema,
  initialTaskState: airportPickupTaskStateSchema,
  toolResults: z.record(z.string(), z.unknown()),
  expectedTaskState: airportPickupTaskStateSchema,
  expectedUISpec: uiSpecSchema,
  expectedEffects: z.array(z.object({
    type: z.string(),
    status: z.enum(['planned', 'pending-confirmation', 'succeeded', 'failed', 'cancelled']),
    tool: z.string().optional(),
  })),
})

export type ScenarioFixture = z.infer<typeof scenarioFixtureSchema>

const demoComponentTypeSchema = z.enum([
  'pickup-overview',
  'flight-status',
  'navigation-summary',
  'charging-recommendation',
  'message-preview',
  'passenger-status',
  'cabin-profile',
  'task-progress',
  'alert',
  'status-banner',
] satisfies Array<ComponentSpec['type']>)

export const demoTimelineUiExpectationSchema = z.object({
  generatedBy: z.enum(['composer', 'fallback']),
  primaryComponent: demoComponentTypeSchema,
  priority: z.enum(['normal', 'high', 'critical']),
  fallback: z.object({
    title: z.string().min(1),
    message: z.string().min(1).optional(),
    level: z.enum(['warning', 'error']).optional(),
  }).optional(),
}).superRefine((expectation, context) => {
  if (expectation.generatedBy === 'fallback' && !expectation.fallback) {
    context.addIssue({
      code: 'custom',
      path: ['fallback'],
      message: 'fallback details are required when generatedBy is fallback',
    })
  }
  if (expectation.generatedBy === 'composer' && expectation.fallback) {
    context.addIssue({
      code: 'custom',
      path: ['fallback'],
      message: 'fallback details are only valid for fallback UI expectations',
    })
  }
})

/**
 * One step of a replayable demo timeline. `advisory` marks sensor-only events
 * (e.g. vehicle.moving, occupancy.changed) that per the task contract may only
 * suggest transitions: the reducer must treat them as no-ops. `statePatch` is a
 * typed partial of task state applied after the event, representing planner/tool
 * writes that are not driven by the event itself (e.g. passengers resolved from
 * family.resolve-members, navigation reroutes). `toolCalls` documents which
 * tools fire at this step; replay tests must execute them against fixture
 * providers rather than trusting the patch alone.
 */
export const demoTimelineStepSchema = z.object({
  event: airportPickupEventSchema,
  advisory: z.boolean().optional(),
  toolCalls: z.array(z.string().min(1)).optional(),
  /** Expected provider error codes for tools exercised by this step. */
  expectedToolErrors: z.record(z.string().min(1), z.string().min(1)).optional(),
  statePatch: airportPickupTaskStateSchema.partial().optional(),
  expectedUI: demoTimelineUiExpectationSchema.optional(),
  expectedPhase: airportPickupPhaseSchema,
  expectedTaskRevision: z.number().int().nonnegative(),
  note: z.string().optional(),
}).superRefine((step, context) => {
  const toolCalls = new Set(step.toolCalls ?? [])
  for (const tool of Object.keys(step.expectedToolErrors ?? {})) {
    if (!toolCalls.has(tool)) {
      context.addIssue({
        code: 'custom',
        path: ['expectedToolErrors', tool],
        message: 'expected tool errors must reference a toolCalls entry',
      })
    }
  }
})

export const demoTimelineSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  mode: providerModeSchema,
  initialTaskState: airportPickupTaskStateSchema,
  steps: z.array(demoTimelineStepSchema).min(1),
})

export type DemoTimelineStep = z.infer<typeof demoTimelineStepSchema>
export type DemoTimeline = z.infer<typeof demoTimelineSchema>

export const voiceFixtureManifestSchema = z.object({
  version: z.literal('1.0'),
  language: z.literal('zh-CN'),
  sampleRateHz: z.number().int().positive(),
  channels: z.number().int().positive(),
  samples: z.array(z.object({
    id: z.string().min(1),
    file: z.string().regex(/^[^/\\]+\.wav$/),
    text: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
    requiresConfirmation: z.boolean(),
  })).min(1),
}).superRefine((manifest, context) => {
  const ids = manifest.samples.map((sample) => sample.id)
  const files = manifest.samples.map((sample) => sample.file)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['samples'], message: 'voice sample ids must be unique' })
  }
  if (new Set(files).size !== files.length) {
    context.addIssue({ code: 'custom', path: ['samples'], message: 'voice sample files must be unique' })
  }
})

export type VoiceFixtureManifest = z.infer<typeof voiceFixtureManifestSchema>
