import { z } from 'zod'
import { airportPickupEventSchema, airportPickupTaskStateSchema } from './task'
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
