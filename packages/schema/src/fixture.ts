import { z } from 'zod'
import { airportPickupEventSchema, airportPickupPhaseSchema, airportPickupTaskStateSchema } from './task'
import { providerModeSchema } from './tool'
import { uiSpecSchema } from './ui'

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
  statePatch: airportPickupTaskStateSchema.partial().optional(),
  expectedPhase: airportPickupPhaseSchema,
  expectedTaskRevision: z.number().int().nonnegative(),
  note: z.string().optional(),
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
