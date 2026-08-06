import { describe, expect, it } from 'vitest'
import { modelPlanningOutputSchema, modelPlanningRequestSchema } from './planning'

describe('model planning schemas', () => {
  it('accepts only minimal allowlisted model requests', () => {
    expect(modelPlanningRequestSchema.safeParse({
      text: '  委婉的接机请求  ',
      context: { phase: 'preparing', knownSlots: { passengers: true, flightNumber: 'MU5102' } },
    })).toMatchObject({
      success: true,
      data: { text: '委婉的接机请求' },
    })
    expect(modelPlanningRequestSchema.safeParse({
      text: '委婉的接机请求',
      context: { knownSlots: { passengers: false }, taskId: 'forged' },
    }).success).toBe(false)
  })

  it('rejects extra policy and runtime fields in model output', () => {
    const valid = {
      confidence: 0.8,
      canonicalInput: '去机场接妈妈',
      intentHint: 'create-airport-pickup',
      evidence: { passengers: ['妈妈'] },
    }
    expect(modelPlanningOutputSchema.safeParse(valid).success).toBe(true)
    expect(modelPlanningOutputSchema.safeParse({ ...valid, eventId: 'forged' }).success).toBe(false)
    expect(modelPlanningOutputSchema.safeParse({ ...valid, modelUsed: 'forged' }).success).toBe(false)
    expect(modelPlanningOutputSchema.safeParse({ ...valid, actionToken: 'forged' }).success).toBe(false)
  })

  it('bounds evidence quotes and keeps the evidence object strict', () => {
    const base = { confidence: 0.8, canonicalInput: '去机场接妈妈', intentHint: 'create-airport-pickup' }
    expect(modelPlanningOutputSchema.safeParse({ ...base, evidence: { passengers: ['妈妈'] } }).success).toBe(true)
    expect(modelPlanningOutputSchema.safeParse({ ...base, evidence: { passengers: [] } }).success).toBe(false)
    expect(modelPlanningOutputSchema.safeParse({ ...base, evidence: { passengers: ['妈妈'], routeId: 'forged' } }).success).toBe(false)
    expect(modelPlanningOutputSchema.safeParse({ ...base, evidence: { flightNumber: 'x'.repeat(33) } }).success).toBe(false)
  })
})
