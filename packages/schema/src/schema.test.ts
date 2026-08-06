import { describe, expect, it } from 'vitest'
import { createTaskRequestSchema, taskUpdateEnvelopeSchema } from './api'
import { airportPickupEventSchema, flightStateSchema } from './task'
import {
  applyCabinProfileInputSchema,
  cabinProfileValuesSchema,
  getPreferencesOutputSchema,
  memoryPreferenceChangeSchema,
  routePlanOutputSchema,
} from './tool'
import { componentSpecSchema, routeSketchSchema, uiSpecSchema } from './ui'

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

describe('routeSketchSchema', () => {
  const sketch = {
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
  }

  it('accepts sketch geometry with and without progress', () => {
    expect(routeSketchSchema.safeParse(sketch).success).toBe(true)
    for (const progress of [0, 0.5, 1]) {
      expect(routeSketchSchema.safeParse({ ...sketch, progress }).success).toBe(true)
    }
  })

  it('rejects progress outside the 0-1 sketch range', () => {
    for (const progress of [-0.1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(routeSketchSchema.safeParse({ ...sketch, progress }).success).toBe(false)
    }
  })

  it('rejects unplottable coordinates and drawing-free geometry', () => {
    expect(
      routeSketchSchema.safeParse({
        ...sketch,
        polyline: [{ latitude: 31.23, longitude: 121.47 }, { latitude: 200, longitude: 121.336 }],
      }).success,
    ).toBe(false)
    expect(
      routeSketchSchema.safeParse({
        ...sketch,
        waypoints: [{ name: '出发地', latitude: Number.NaN, longitude: 121.47 }],
      }).success,
    ).toBe(false)
    // One point is a dot, not a route.
    expect(routeSketchSchema.safeParse({ ...sketch, polyline: sketch.polyline.slice(0, 1) }).success).toBe(false)
    expect(routeSketchSchema.safeParse({ ...sketch, waypoints: [] }).success).toBe(false)
    expect(
      routeSketchSchema.safeParse({ ...sketch, waypoints: [{ name: '', latitude: 31.23, longitude: 121.47 }] }).success,
    ).toBe(false)
  })

  it('keeps the sketch optional on navigation cards, and drops an illegal one instead of losing the card', () => {
    const props = {
      routeId: 'route-airport-001',
      destination: '虹桥机场 T2',
      eta: '2026-07-22T20:25:00+08:00',
      distanceKm: 32,
      estimatedBatteryAtArrival: 27,
    }
    const legacy = componentSpecSchema.safeParse({ id: 'nav', type: 'navigation-summary', props })
    expect(legacy.success).toBe(true)
    if (legacy.success && legacy.data.type === 'navigation-summary') {
      expect(legacy.data.props.routeSketch).toBeUndefined()
    }

    const drawn = componentSpecSchema.safeParse({
      id: 'nav',
      type: 'navigation-summary',
      props: { ...props, routeSketch: { ...sketch, progress: 0.4 } },
    })
    expect(drawn.success).toBe(true)
    if (drawn.success && drawn.data.type === 'navigation-summary') {
      expect(drawn.data.props.routeSketch?.progress).toBe(0.4)
      expect(drawn.data.props.routeSketch?.waypoints).toHaveLength(2)
    }

    // Degradation, not rejection: the driver loses the drawing, never the ETA.
    const broken = componentSpecSchema.safeParse({
      id: 'nav',
      type: 'navigation-summary',
      props: { ...props, routeSketch: { ...sketch, progress: 4 } },
    })
    expect(broken.success).toBe(true)
    if (broken.success && broken.data.type === 'navigation-summary') {
      expect(broken.data.props.routeSketch).toBeUndefined()
      expect(broken.data.props.eta).toBe(props.eta)
    }
  })
  it('requires drawable geometry on a route panel rather than degrading it away', () => {
    const props = { destination: '虹桥机场 T2', mode: 'follow' as const }

    const drawn = componentSpecSchema.safeParse({
      id: 'route-map',
      type: 'route-map',
      props: { ...props, routeSketch: { ...sketch, progress: 0.4 } },
    })
    expect(drawn.success).toBe(true)
    if (drawn.success && drawn.data.type === 'route-map') {
      expect(drawn.data.props.routeSketch.progress).toBe(0.4)
      expect(drawn.data.props.mode).toBe('follow')
    }

    // A navigation card without a drawing still has an ETA to give; a panel
    // without one is an empty frame, so it is rejected outright and the slot
    // goes to the renderer's per-component fallback instead.
    expect(componentSpecSchema.safeParse({ id: 'route-map', type: 'route-map', props }).success).toBe(false)
    expect(componentSpecSchema.safeParse({
      id: 'route-map', type: 'route-map', props: { ...props, routeSketch: { ...sketch, progress: 4 } },
    }).success).toBe(false)
    // The destination is what the driver reads, so it cannot be blank — and
    // `mode` is an intent from a closed set, not a free-form camera setting.
    expect(componentSpecSchema.safeParse({
      id: 'route-map', type: 'route-map', props: { ...props, destination: '', routeSketch: sketch },
    }).success).toBe(false)
    expect(componentSpecSchema.safeParse({
      id: 'route-map', type: 'route-map', props: { ...props, mode: 'zoom-14', routeSketch: sketch },
    }).success).toBe(false)
  })
})

describe('uiSpecSchema split layout slots', () => {
  const base = {
    version: '1.0', taskId: 'task', surfaceId: 'surface', taskRevision: 2, uiRevision: 2,
    phase: 'driving-to-airport', title: '去虹桥机场',
    presentation: { mode: 'replace', density: 'compact', theme: 'dark', priority: 'normal' },
    components: [
      { id: 'route-map', type: 'route-map', props: {
        destination: '虹桥机场 T2',
        mode: 'follow',
        routeSketch: {
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
        },
      } },
      { id: 'navigation-summary', type: 'navigation-summary', props: {
        routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00',
        distanceKm: 32, estimatedBatteryAtArrival: 27,
      } },
    ],
    actions: [],
    meta: { generatedBy: 'composer', sourceTaskRevision: 2, requiresConfirm: false, generatedAt: '2026-07-22T20:05:00+08:00', traceId: 'trace' },
  }

  function withSlots(slots: { primary: string[]; secondary: string[] }) {
    return uiSpecSchema.safeParse({ ...base, layout: { type: 'split', ratio: [1.75, 1], slots } })
  }

  it('accepts a split that places every component in exactly one column', () => {
    expect(withSlots({ primary: ['route-map'], secondary: ['navigation-summary'] }).success).toBe(true)
  })

  it('rejects a split that drops a component out of the frame or draws one twice', () => {
    // Unreferenced: the component exists but no column claims it, so nothing
    // would render it.
    expect(withSlots({ primary: ['route-map'], secondary: [] }).success).toBe(false)
    // Referenced twice: the same map in both columns.
    expect(withSlots({ primary: ['route-map'], secondary: ['route-map', 'navigation-summary'] }).success).toBe(false)
    // Referenced but absent: a slot naming a component the spec never carried.
    expect(withSlots({ primary: ['route-map'], secondary: ['navigation-summary', 'flight-status'] }).success).toBe(false)
  })
})

describe('Agent API', () => {
  it('validates task creation capabilities and vehicle context', () => {
    const result = createTaskRequestSchema.safeParse({
      clientRequestId: 'client-001',
      input: { type: 'text', text: '去机场接妈妈' },
      vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: true },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: true, supportsTts: true },
      destination: { id: 'destination-hongqiao-t1', name: '虹桥机场 T1' },
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.destination?.name).toBe('虹桥机场 T1')
  })

  it('validates public task updates without accepting stored runtime context', () => {
    const task = {
      taskId: 'task-001', surfaceId: 'surface', taskRevision: 0, uiRevision: 0, phase: 'collecting-information' as const,
      passengers: { memberIds: [], names: [], confirmedOnboard: false },
      charging: { recommended: false, accepted: false, status: 'none' as const },
      message: { autoNotifyAuthorized: true, status: 'idle' as const, landingNoticeSent: false },
      processedEventIds: [], updatedAt: '2026-07-22T12:00:00+08:00',
    }
    const ui = {
      version: '1.0' as const, taskId: 'task-001', surfaceId: 'surface', taskRevision: 0, uiRevision: 0,
      phase: 'collecting-information', title: 'Pickup',
      presentation: { mode: 'replace' as const, density: 'full' as const, theme: 'dark' as const, priority: 'normal' as const },
      layout: { type: 'stack' as const, gap: 'md' as const, slots: { main: [] } }, components: [], actions: [],
      meta: { generatedBy: 'composer' as const, sourceTaskRevision: 0, requiresConfirm: false, generatedAt: '2026-07-22T12:00:00+08:00', traceId: 'trace' },
    }
    expect(taskUpdateEnvelopeSchema.safeParse({
      type: 'task.updated', cursor: 1, taskId: 'task-001', snapshot: { task, ui },
    }).success).toBe(true)
    expect(taskUpdateEnvelopeSchema.safeParse({
      type: 'task.updated', cursor: 1, taskId: 'task-001',
      snapshot: { task, ui, toolResults: { secret: true }, requestContext: { token: 'secret' } },
    }).success).toBe(false)
    expect(taskUpdateEnvelopeSchema.safeParse({
      type: 'task.updated', cursor: 1, taskId: 'other-task', snapshot: { task, ui },
    }).success).toBe(false)
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
