import { z } from 'zod'
import { airportPickupPhaseSchema } from './task'

const safePlanningTextSchema = z.string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !hasControlCharacters(value), 'Control characters are not allowed')

export const modelPlanningRequestSchema = z.object({
  text: safePlanningTextSchema,
  context: z.object({
    phase: airportPickupPhaseSchema.optional(),
    knownSlots: z.object({
      passengers: z.boolean(),
      flightNumber: z.string().regex(/^[A-Z0-9]{2}\d{3,4}$/u).optional(),
    }).strict(),
  }).strict(),
}).strict()

export const modelPlanningIntentHintSchema = z.enum([
  'create-airport-pickup',
  'provide-flight-number',
])

export const modelPlanningOutputSchema = z.object({
  confidence: z.number().finite().min(0).max(1),
  canonicalInput: safePlanningTextSchema.max(240),
  intentHint: modelPlanningIntentHintSchema,
  evidence: z.object({
    passengers: z.array(safePlanningTextSchema.max(80)).min(1).max(3).optional(),
    flightNumber: safePlanningTextSchema.max(32).optional(),
  }).strict(),
}).strict()

export type ModelPlanningRequest = z.infer<typeof modelPlanningRequestSchema>
export type ModelPlanningIntentHint = z.infer<typeof modelPlanningIntentHintSchema>
export type ModelPlanningOutput = z.infer<typeof modelPlanningOutputSchema>

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
  })
}
