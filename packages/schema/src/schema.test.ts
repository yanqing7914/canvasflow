import { describe, expect, it } from 'vitest'
import { createTaskRequestSchema } from './api'
import { applyCabinProfileInputSchema, memoryPreferenceChangeSchema } from './tool'
import { uiSpecSchema } from './ui'

describe('UISpec', () => {
  it('rejects stale source revisions', () => {
    const result = uiSpecSchema.safeParse({
      version: '1.0', taskId: 'task', surfaceId: 'surface', taskRevision: 2, uiRevision: 3,
      phase: 'preparing', title: 'Pickup',
      presentation: { mode: 'replace', density: 'full', theme: 'dark', priority: 'normal' },
      layout: { type: 'stack', gap: 'md', slots: { main: [] } }, components: [], actions: [],
      meta: { generatedBy: 'composer', sourceTaskRevision: 1, requiresConfirm: false, generatedAt: '2026-07-22T12:00:00+08:00', traceId: 'trace' },
    })
    expect(result.success).toBe(false)
  })
})

describe('Agent API', () => {
  it('validates task creation capabilities and vehicle context', () => {
    const result = createTaskRequestSchema.safeParse({
      clientRequestId: 'client-001',
      input: { type: 'text', text: '去机场接妈妈' },
      vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: true },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: true, supportsTts: true },
    })
    expect(result.success).toBe(true)
  })
})

describe('cabin / memory domain bounds', () => {
  it('rejects out-of-range cabin temperature and fan level', () => {
    expect(
      applyCabinProfileInputSchema.safeParse({
        zone: 'rear',
        temperatureC: 40,
        sourceMemberIds: ['mom'],
        idempotencyKey: 'k',
      }).success,
    ).toBe(false)
    expect(
      applyCabinProfileInputSchema.safeParse({
        zone: 'rear',
        fanLevel: 9,
        sourceMemberIds: ['mom'],
        idempotencyKey: 'k',
      }).success,
    ).toBe(false)
    expect(
      applyCabinProfileInputSchema.safeParse({
        zone: 'rear',
        temperatureC: 22,
        fanLevel: 3,
        sourceMemberIds: ['mom'],
        idempotencyKey: 'k',
      }).success,
    ).toBe(true)
  })

  it('rejects out-of-range preference temperature and empty catalog strings', () => {
    expect(memoryPreferenceChangeSchema.safeParse({ rearTemperatureC: 10 }).success).toBe(false)
    expect(memoryPreferenceChangeSchema.safeParse({ mediaTitle: '' }).success).toBe(false)
    expect(memoryPreferenceChangeSchema.safeParse({ homeDestinationId: '' }).success).toBe(false)
    expect(memoryPreferenceChangeSchema.safeParse({ rearTemperatureC: 24, mediaTitle: '豆豆故事' }).success).toBe(true)
  })
})
