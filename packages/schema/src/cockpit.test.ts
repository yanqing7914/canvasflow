import { describe, expect, it } from 'vitest'
import { uiSpecSchema } from './ui'
import { airportPickupEventSchema, airportPickupTaskStateSchema } from './task'

describe('cockpit-compatible contracts', () => {
  it('accepts window-owned components without requiring them in the legacy layout', () => {
    const spec = uiSpecSchema.parse({
      version: '1.0', taskId: 'task-1', surfaceId: 'airport-pickup-main', taskRevision: 1, uiRevision: 1,
      phase: 'confirming-outbound', title: '现在出发',
      presentation: { mode: 'replace', density: 'compact', theme: 'dark', priority: 'high' },
      layout: { type: 'stack', gap: 'md', slots: { main: ['hud'] } },
      components: [
        { id: 'hud', type: 'status-banner', props: { level: 'info', title: '导航 HUD' } },
        { id: 'confirm', type: 'route-confirmation', props: { leg: 'outbound', destination: '虹桥机场 T2', durationMinutes: 20, arrivalTime: '2026-08-11T10:00:00+08:00', distanceKm: 32, currentBatteryPercent: 80, estimatedBatteryAtArrival: 65, simulated: true } },
      ],
      actions: [{ id: 'start-outbound', label: '现在出发', style: 'primary', event: { type: 'tool-request', actionToken: 'start-outbound' } }],
      windows: [{ id: 'window-confirm-1', kind: 'outbound-confirmation', title: '现在出发', componentIds: ['confirm'], actionIds: ['start-outbound'], size: 'medium', controls: { closable: true, minimizable: true, maximizable: true } }],
      meta: { generatedBy: 'composer', sourceTaskRevision: 1, requiresConfirm: true, generatedAt: '2026-08-11T09:00:00+08:00', traceId: 'trace-1' },
    })
    expect(spec.windows?.[0]?.componentIds).toEqual(['confirm'])
  })

  it('rejects dangling or duplicate window ownership', () => {
    expect(() => uiSpecSchema.parse({
      version: '1.0', taskId: 'task-1', surfaceId: 's', taskRevision: 0, uiRevision: 0, phase: 'collecting-information', title: 'x',
      presentation: { mode: 'replace', density: 'full', theme: 'dark', priority: 'normal' }, layout: { type: 'stack', gap: 'md', slots: { main: ['a'] } },
      components: [{ id: 'a', type: 'status-banner', props: { level: 'info', title: 'x' } }], actions: [],
      windows: [{ id: 'w', kind: 'weather', title: '天气', componentIds: ['a', 'missing'], size: 'compact', controls: { closable: true, minimizable: true, maximizable: true } }],
      meta: { generatedBy: 'composer', sourceTaskRevision: 0, requiresConfirm: false, generatedAt: '2026-08-11T09:00:00+08:00', traceId: 'trace' },
    })).toThrow()
  })

  it('accepts new guarded event names and task phases', () => {
    expect(airportPickupEventSchema.parse({ eventId: 'airport', type: 'pickup.airport-selected', airport: { label: '浦东机场', code: 'PVG' }, timestamp: '2026-08-11T09:00:00+08:00' }).type).toBe('pickup.airport-selected')
    expect(airportPickupEventSchema.parse({ eventId: 'arrive', type: 'navigation.outbound-arrived', timestamp: '2026-08-11T09:00:00+08:00' }).type).toBe('navigation.outbound-arrived')
    expect(airportPickupTaskStateSchema.shape.phase.parse('return-driving')).toBe('return-driving')
  })

  it('requires a strict route-bound navigation command snapshot', () => {
    const snapshot = {
      routeId: 'route-airport-001', leg: 'outbound', progress: 0.5, speedKph: 55,
      batteryPercent: 34.5, remainingRangeKm: 92, remainingDistanceKm: 16,
      currentRoad: '延安西路',
    }
    expect(airportPickupEventSchema.parse({ eventId: 'weather', type: 'user.input', text: '查天气', navigationSnapshot: snapshot, timestamp: '2026-08-11T09:00:00+08:00' }))
      .toMatchObject({ navigationSnapshot: { routeId: 'route-airport-001', leg: 'outbound' } })
    const missingRoute = { ...snapshot }
    delete (missingRoute as Partial<typeof snapshot>).routeId
    expect(() => airportPickupEventSchema.parse({ eventId: 'missing-route', type: 'user.input', text: '查天气', navigationSnapshot: missingRoute, timestamp: '2026-08-11T09:00:00+08:00' })).toThrow()
    expect(() => airportPickupEventSchema.parse({ eventId: 'extra', type: 'user.input', text: '查天气', navigationSnapshot: { ...snapshot, location: '伪造位置' }, timestamp: '2026-08-11T09:00:00+08:00' })).toThrow()
  })
})
