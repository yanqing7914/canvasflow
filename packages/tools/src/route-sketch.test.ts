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

/** The route panel's own props. The geometry lives here, not on the card beside it. */
function routeMapProps(spec: UISpec) {
  const component = spec.components.find((candidate) => candidate.type === 'route-map')
  if (component?.type !== 'route-map') throw new Error('没有路线面板')
  return component.props
}

const returnTrip: NonNullable<AirportPickupTaskState['returnTrip']> = {
  workflowId: 'pickup-001:return',
  route: { status: 'succeeded', routeId: 'route-home-001', eta: '2026-07-22T21:35:00+08:00' },
  cabin: { status: 'pending' },
  media: { status: 'pending' },
}

/**
 * The crawl spans, checked as a ladder rather than one at a time.
 *
 * The fixture's own prose makes two promises the renderer then relies on: a span
 * only ever moves forwards, and it stops short of the next authored stage. The
 * second is the one that matters — a bound that reached or passed the next
 * checkpoint would let the marker present a stage the Agent has not sent, which
 * is exactly the claim the demo must not make. Both are properties of the
 * fixture as a whole, so they are asserted across it rather than spot-checked.
 */
describe('authored crawl spans', () => {
  const crawling = routeProgressCheckpoints.filter((checkpoint) => checkpoint.crawl)

  it('authors a crawl for the driving stages and none for the stopped ones', () => {
    // Named rather than counted, so adding a checkpoint has to say which it is.
    expect(crawling.map((checkpoint) => checkpoint.id)).toEqual([
      'outbound-departed',
      'outbound-charged',
      'outbound-flight-landed',
      'airport-approach',
      'return-departed',
      'return-cabin-ready',
    ])
    for (const id of ['outbound-charging-under-way', 'airport-parked', 'home-arrived']) {
      expect(routeProgressCheckpoints.find((entry) => entry.id === id)?.crawl, id).toBeUndefined()
    }
  })

  it.each(crawling)('moves $id forwards over a positive duration', (checkpoint) => {
    expect(checkpoint.crawl!.toProgress).toBeGreaterThan(checkpoint.progress)
    expect(checkpoint.crawl!.toProgress).toBeLessThanOrEqual(1)
    expect(checkpoint.crawl!.durationSeconds).toBeGreaterThan(0)
  })

  it('stops every span short of the next stage on the same leg', () => {
    // The ladder restarts at `return-departed` — the sketch becomes the home
    // route there, so its 0.08 is a different line's 0.08 and comparing across
    // the two legs would be comparing different geometry.
    const legStart = routeProgressCheckpoints.findIndex((entry) => entry.id === 'return-departed')
    for (const [index, checkpoint] of routeProgressCheckpoints.entries()) {
      if (!checkpoint.crawl) continue
      const next = routeProgressCheckpoints[index + 1]
      if (!next || index + 1 === legStart) continue
      expect(checkpoint.crawl.toProgress, `${checkpoint.id} -> ${next.id}`).toBeLessThan(next.progress)
    }
  })

  it('carries the authored span onto the sketch, and omits it where none is authored', () => {
    expect(routeSketchFor(taskState(), { routeId: 'route-airport-001' })?.crawl)
      .toEqual({ toProgress: 0.34, durationSeconds: 90 })
    const parked = routeSketchFor(
      taskState({ phase: 'waiting-for-passengers' }),
      { routeId: 'route-airport-001' },
    )
    expect(parked?.progress).toBe(1)
    expect(parked?.crawl).toBeUndefined()
  })
})

describe('routeSketchProgress', () => {  it('reads every step of the ladder from the fixture rather than accumulating one', () => {
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
  it('carries the active route and its staged progress into the route panel', () => {
    const spec = composePickupSpec(taskState())
    const map = routeMapProps(spec)

    expect(map.routeSketch.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '虹桥机场 T2'])
    expect(map.routeSketch.polyline.length).toBeGreaterThan(1)
    expect(map.routeSketch.progress).toBe(authored('outbound-departed'))
    expect(map.destination).toBe('虹桥机场 T2')
    // One route, drawn once: the card beside the panel keeps the facts and no geometry.
    expect(navigationProps(spec).routeSketch).toBeUndefined()
    expect(navigationProps(spec).destination).toBe('虹桥机场 T2')
  })

  it('follows a mid-trip reroute instead of keeping the original geometry', () => {
    const before = routeMapProps(composePickupSpec(taskState()))
    const after = routeMapProps(composePickupSpec(taskState({
      navigation: { routeId: 'route-airport-bypass-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:35:00+08:00', status: 'active' },
    })))

    expect(after.routeSketch.waypoints.map((waypoint) => waypoint.name)).toContain('外环快速路')
    expect(after.routeSketch.polyline).not.toEqual(before.routeSketch.polyline)
  })

  it('draws the home route on the way back, not the airport route again', () => {
    const outbound = routeMapProps(composePickupSpec(taskState()))
    const returning = routeMapProps(composePickupSpec(taskState({
      phase: 'returning-home',
      navigation: { routeId: 'route-home-001', destination: '家', eta: '2026-07-22T21:35:00+08:00', status: 'active' },
      returnTrip,
    })))

    expect(returning.routeSketch.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '家'])
    expect(returning.routeSketch.polyline).not.toEqual(outbound.routeSketch.polyline)
    expect(returning.routeSketch.progress).toBe(authored('return-departed'))
    expect(returning.destination).toBe('家')
  })

  it('keeps the navigation card without geometry when the route has no sketch', () => {
    const spec = composePickupSpec(taskState({
      navigation: { routeId: 'route-does-not-exist', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
    }))
    const props = navigationProps(spec)

    // Nothing to draw means no panel to draw it in, so the card owns the frame alone.
    expect(spec.components.some((component) => component.type === 'route-map')).toBe(false)
    expect(spec.layout.type).toBe('stack')
    expect(props.routeSketch).toBeUndefined()
    expect(props.destination).toBe('虹桥机场 T2')
    expect(props.eta).toBe('2026-07-22T20:25:00+08:00')
  })
})
