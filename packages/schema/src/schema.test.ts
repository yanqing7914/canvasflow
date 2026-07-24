import { describe, expect, it } from 'vitest'
import { createTaskRequestSchema } from './api'
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
