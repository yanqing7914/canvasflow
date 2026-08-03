import { describe, expect, it } from 'vitest'
import type { AirportPickupTaskState, UISpec } from '@canvasflow/schema'
import { composePickupSpec } from '@canvasflow/ui'
import { routeSketchFor, routeSketchGeometry, routeSketchProgress, routeProgressCheckpoints } from './route-sketch'

function taskState(overrides: Partial<AirportPickupTaskState> = {}): AirportPickupTaskState {
  return {
    taskId: 'pickup-001',
    surfaceId: 'airport-pickup-main',
    taskRevision: 3,
    uiRevision: 3,
    phase: 'driving-to-airport',
    passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
    flight: { flightNumber: 'MU5102', status: 'in-air', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
    navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
    charging: { recommended: false, accepted: false, status: 'none' },
    message: { autoNotifyAuthorized: true, status: 'idle', landingNoticeSent: false },
    processedEventIds: [],
    updatedAt: '2026-07-22T20:35:00+08:00',
    ...overrides,
  }
}

function authored(checkpointId: string): number {
  const checkpoint = routeProgressCheckpoints.find((entry) => entry.id === checkpointId)
  if (!checkpoint) throw new Error(`未定义的进度档位：${checkpointId}`)
  return checkpoint.progress
}

function navigationProps(spec: UISpec) {
  const component = spec.components.find((candidate) => candidate.type === 'navigation-summary')
  if (component?.type !== 'navigation-summary') throw new Error('没有导航卡片')
  return component.props
}

const returnTrip: NonNullable<AirportPickupTaskState['returnTrip']> = {
  workflowId: 'pickup-001:return',
  route: { status: 'succeeded', routeId: 'route-home-001', eta: '2026-07-22T21:35:00+08:00' },
  cabin: { status: 'pending' },
  media: { status: 'pending' },
}

describe('routeSketchProgress', () => {
  it('reads every step of the ladder from the fixture rather than accumulating one', () => {
    // Anchor the first value so a fixture edit shows up as a behaviour change,
    // then compare the rest against the fixture itself: nothing here is computed.
    expect(routeSketchProgress(taskState())).toBe(0.08)

    const ladder: Array<[string, AirportPickupTaskState]> = [
      ['outbound-departed', taskState()],
      ['outbound-charging-under-way', taskState({ charging: { recommended: true, accepted: true, status: 'active' } })],
      ['outbound-charged', taskState({ charging: { recommended: true, accepted: true, status: 'completed' } })],
      ['outbound-flight-landed', taskState({ flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' } })],
      ['airport-approach', taskState({ phase: 'approaching-airport' })],
      ['airport-parked', taskState({ phase: 'waiting-for-passengers' })],
      ['return-departed', taskState({ phase: 'returning-home', returnTrip })],
      ['return-cabin-ready', taskState({ phase: 'returning-home', returnTrip: { ...returnTrip, cabin: { status: 'succeeded' } } })],
      ['home-arrived', taskState({ phase: 'completed' })],
    ]

    for (const [checkpointId, task] of ladder) {
      expect(routeSketchProgress(task), checkpointId).toBe(authored(checkpointId))
    }
  })

  it('has no progress for a state no checkpoint stages', () => {
    expect(routeSketchProgress(taskState({ phase: 'preparing' }))).toBeUndefined()
    expect(routeSketchProgress(taskState({ phase: 'collecting-information' }))).toBeUndefined()
    expect(routeSketchProgress(taskState({ phase: 'cancelled' }))).toBeUndefined()
  })

  it('restarts near the origin on the return leg instead of continuing the outbound value', () => {
    const parked = routeSketchProgress(taskState({ phase: 'waiting-for-passengers' }))
    const returning = routeSketchProgress(taskState({ phase: 'returning-home', returnTrip }))
    expect(parked).toBe(1)
    expect(returning).toBeLessThan(parked!)
  })
})

describe('routeSketchGeometry', () => {
  it('resolves the geometry of the route the task is actually on', () => {
    const direct = routeSketchGeometry('route-airport-001')
    const viaCharge = routeSketchGeometry('route-airport-via-charge-001')
    const bypass = routeSketchGeometry('route-airport-bypass-001')
    const home = routeSketchGeometry('route-home-001')

    expect(direct?.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '虹桥机场 T2'])
    expect(viaCharge?.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '虹桥枢纽超充站', '虹桥机场 T2'])
    expect(bypass?.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '外环快速路', '虹桥机场 T2'])
    expect(home?.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '家'])

    // Each variant draws its own line: a reroute cannot silently reuse the direct one.
    expect(viaCharge?.polyline).not.toEqual(direct?.polyline)
    expect(bypass?.polyline).not.toEqual(direct?.polyline)
    expect(home?.polyline).not.toEqual(direct?.polyline)
  })

  it('invents nothing for a route it does not have', () => {
    expect(routeSketchGeometry('route-does-not-exist')).toBeUndefined()
    expect(routeSketchGeometry('')).toBeUndefined()
  })
})

describe('routeSketchFor', () => {
  it('uses the plan-route geometry in hand before falling back to the route id', () => {
    const planned = routeSketchFor(taskState({ phase: 'preparing' }), {
      routeId: 'route-airport-001',
      summary: '经超充站前往机场',
      waypoints: [
        { id: 'origin-demo', name: '出发地', latitude: 31.23, longitude: 121.47 },
        { id: 'station-hongqiao-01', name: '虹桥枢纽超充站', latitude: 31.21, longitude: 121.38 },
      ],
      polyline: [
        { latitude: 31.23, longitude: 121.47 },
        { latitude: 31.21, longitude: 121.38 },
      ],
    })

    expect(planned?.summary).toBe('经超充站前往机场')
    expect(planned?.polyline).toHaveLength(2)
    // Planning is not travelling: no checkpoint stages `preparing`.
    expect(planned?.progress).toBeUndefined()
  })

  it('attaches the staged progress to the geometry of the active route', () => {
    const sketch = routeSketchFor(taskState({ navigation: { routeId: 'route-airport-via-charge-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:37:00+08:00', status: 'active' }, charging: { recommended: true, accepted: true, status: 'active' } }), { routeId: 'route-airport-via-charge-001' })

    expect(sketch?.waypoints.map((waypoint) => waypoint.name)).toContain('虹桥枢纽超充站')
    expect(sketch?.progress).toBe(authored('outbound-charging-under-way'))
  })

  it('yields no sketch for an unknown route or undrawable geometry', () => {
    expect(routeSketchFor(taskState(), { routeId: 'route-does-not-exist' })).toBeUndefined()
    expect(
      routeSketchFor(taskState(), {
        routeId: 'route-does-not-exist',
        waypoints: [{ name: '出发地', latitude: 31.23, longitude: 121.47 }],
        polyline: [{ latitude: 31.23, longitude: 121.47 }],
      }),
    ).toBeUndefined()
  })
})

describe('composePickupSpec route sketch projection', () => {
  it('carries the active route and its staged progress into the navigation card', () => {
    const props = navigationProps(composePickupSpec(taskState()))

    expect(props.routeSketch?.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '虹桥机场 T2'])
    expect(props.routeSketch?.polyline.length).toBeGreaterThan(1)
    expect(props.routeSketch?.progress).toBe(authored('outbound-departed'))
    expect(props.destination).toBe('虹桥机场 T2')
  })

  it('follows a mid-trip reroute instead of keeping the original geometry', () => {
    const before = navigationProps(composePickupSpec(taskState()))
    const after = navigationProps(composePickupSpec(taskState({
      navigation: { routeId: 'route-airport-bypass-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:35:00+08:00', status: 'active' },
    })))

    expect(after.routeSketch?.waypoints.map((waypoint) => waypoint.name)).toContain('外环快速路')
    expect(after.routeSketch?.polyline).not.toEqual(before.routeSketch?.polyline)
  })

  it('draws the home route on the way back, not the airport route again', () => {
    const outbound = navigationProps(composePickupSpec(taskState()))
    const returning = navigationProps(composePickupSpec(taskState({
      phase: 'returning-home',
      navigation: { routeId: 'route-home-001', destination: '家', eta: '2026-07-22T21:35:00+08:00', status: 'active' },
      returnTrip,
    })))

    expect(returning.routeSketch?.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '家'])
    expect(returning.routeSketch?.polyline).not.toEqual(outbound.routeSketch?.polyline)
    expect(returning.routeSketch?.progress).toBe(authored('return-departed'))
  })

  it('keeps the navigation card without geometry when the route has no sketch', () => {
    const props = navigationProps(composePickupSpec(taskState({
      navigation: { routeId: 'route-does-not-exist', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
    })))

    expect(props.routeSketch).toBeUndefined()
    expect(props.destination).toBe('虹桥机场 T2')
    expect(props.eta).toBe('2026-07-22T20:25:00+08:00')
  })
})
