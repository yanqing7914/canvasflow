import { describe, expect, it } from 'vitest'
import { createTaskRequestSchema } from './api'
import { airportPickupEventSchema, flightStateSchema } from './task'
import {
  applyCabinProfileInputSchema,
  cabinProfileValuesSchema,
  getPreferencesOutputSchema,
  memoryPreferenceChangeSchema,
  routePlanOutputSchema,
} from './tool'
import { componentSpecSchema, uiSpecSchema } from './ui'

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

  it('rejects cabin-profile cards with no applied preference value', () => {
    const empty = componentSpecSchema.safeParse({
      id: 'cabin',
      type: 'cabin-profile',
      props: { zone: 'rear', appliedFromMemory: true, reversible: true },
    })
    expect(empty.success).toBe(false)

    const mediaOnly = componentSpecSchema.safeParse({
      id: 'cabin',
      type: 'cabin-profile',
      props: { zone: 'rear', mediaTitle: '豆豆故事', appliedFromMemory: true, reversible: true },
    })
    expect(mediaOnly.success).toBe(true)

    const emptyMediaTitle = componentSpecSchema.safeParse({
      id: 'cabin',
      type: 'cabin-profile',
      props: { zone: 'rear', mediaTitle: '', appliedFromMemory: true, reversible: true },
    })
    expect(emptyMediaTitle.success).toBe(false)
  })

  it('rejects empty mediaTitle in preference and cabin value schemas', () => {
    expect(getPreferencesOutputSchema.safeParse({ members: [{ memberId: 'doubao', mediaTitle: '' }] }).success).toBe(
      false,
    )
    expect(cabinProfileValuesSchema.safeParse({ mediaTitle: '' }).success).toBe(false)
    expect(
      getPreferencesOutputSchema.safeParse({ members: [{ memberId: 'doubao', mediaTitle: '豆豆故事' }] }).success,
    ).toBe(true)
  })
})

describe('routePlanOutputSchema sketch geometry', () => {
  const base = {
    routeId: 'route-airport-001',
    distanceKm: 32,
    durationMinutes: 20,
    arrivalTime: '2026-07-22T20:25:00+08:00',
    estimatedBatteryAtArrival: 27,
  }

  it('accepts legacy numeric-only route plans without geometry', () => {
    expect(routePlanOutputSchema.safeParse(base).success).toBe(true)
  })

  it('accepts optional waypoints, polyline, and summary', () => {
    expect(
      routePlanOutputSchema.safeParse({
        ...base,
        summary: '直达虹桥机场 T2',
        waypoints: [
          { id: 'origin-demo', name: '出发地', latitude: 31.23, longitude: 121.47 },
          { id: 'destination-hongqiao-t2', name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
        ],
        polyline: [
          { latitude: 31.23, longitude: 121.47 },
          { latitude: 31.222, longitude: 121.44 },
          { latitude: 31.198, longitude: 121.336 },
        ],
      }).success,
    ).toBe(true)
  })

  it('rejects polylines shorter than three points', () => {
    expect(
      routePlanOutputSchema.safeParse({
        ...base,
        polyline: [
          { latitude: 31.23, longitude: 121.47 },
          { latitude: 31.198, longitude: 121.336 },
        ],
      }).success,
    ).toBe(false)
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

describe('flightStateSchema legacy compatibility', () => {
  it('derives scheduledArrival from estimatedArrival when omitted', () => {
    const legacy = {
      flightNumber: 'MU5102',
      status: 'landed' as const,
      estimatedArrival: '2026-07-22T20:40:00+08:00',
      terminal: 'T2',
    }
    expect(flightStateSchema.parse(legacy)).toEqual({
      ...legacy,
      scheduledArrival: '2026-07-22T20:40:00+08:00',
    })
    const event = airportPickupEventSchema.parse({
      eventId: 'legacy-flight',
      type: 'flight.updated',
      flight: legacy,
      timestamp: '2026-07-22T20:40:00+08:00',
    })
    expect(event.type).toBe('flight.updated')
    if (event.type !== 'flight.updated') return
    expect(event.flight.scheduledArrival).toBe('2026-07-22T20:40:00+08:00')
  })

  it('keeps distinct scheduledArrival when both arrivals are present', () => {
    expect(
      flightStateSchema.parse({
        flightNumber: 'MU5102',
        status: 'delayed',
        scheduledArrival: '2026-07-22T20:30:00+08:00',
        estimatedArrival: '2026-07-22T21:10:00+08:00',
        terminal: 'T1',
      }),
    ).toMatchObject({
      scheduledArrival: '2026-07-22T20:30:00+08:00',
      estimatedArrival: '2026-07-22T21:10:00+08:00',
    })
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
