import { describe, expect, it } from 'vitest'
import type { RouteSketch } from '@canvasflow/schema'
import { ROUTE_SKETCH_VIEWBOX, buildRouteSketchDrawing } from './route-sketch'

/** An L-shaped line: right along the top, then straight down. */
const elbow: RouteSketch = {
  waypoints: [
    { id: 'origin-demo', name: '出发地', latitude: 31.23, longitude: 121.4 },
    { id: 'via-ring-road-01', name: '外环快速路', latitude: 31.23, longitude: 121.5 },
    { id: 'destination-hongqiao-t2', name: '虹桥机场 T2', latitude: 31.13, longitude: 121.5 },
  ],
  polyline: [
    { latitude: 31.23, longitude: 121.4 },
    { latitude: 31.23, longitude: 121.5 },
    { latitude: 31.13, longitude: 121.5 },
  ],
}

describe('buildRouteSketchDrawing', () => {
  it('draws every polyline point inside the view box', () => {
    const drawing = buildRouteSketchDrawing(elbow)
    const commands = drawing!.path.split(/(?=[ML])/).map((command) => command.trim())

    expect(commands).toHaveLength(3)
    expect(commands[0]!.startsWith('M')).toBe(true)
    for (const command of commands.slice(1)) expect(command.startsWith('L')).toBe(true)
    for (const [x, y] of commands.map((command) => command.slice(1).trim().split(' ').map(Number))) {
      expect(x!).toBeGreaterThanOrEqual(0)
      expect(x!).toBeLessThanOrEqual(ROUTE_SKETCH_VIEWBOX.width)
      expect(y!).toBeGreaterThanOrEqual(0)
      expect(y!).toBeLessThanOrEqual(ROUTE_SKETCH_VIEWBOX.height)
    }
  })

  it('labels the first waypoint as the origin, the last as the destination, the rest as vias', () => {
    expect(buildRouteSketchDrawing(elbow)!.markers.map((marker) => [marker.name, marker.role])).toEqual([
      ['出发地', 'origin'],
      ['外环快速路', 'via'],
      ['虹桥机场 T2', 'destination'],
    ])
  })

  it('places the vehicle on the drawn line rather than between the endpoints', () => {
    const drawing = buildRouteSketchDrawing({ ...elbow, progress: 0.5 })!
    const [origin, , destination] = drawing.markers
    const straightMidpoint = { x: (origin!.x + destination!.x) / 2, y: (origin!.y + destination!.y) / 2 }

    // Halfway by travelled distance stays on the elbow; the straight line between
    // the two ends cuts the corner and would put the marker off the route.
    expect(distanceToPath(drawing.vehicle!, drawing.path)).toBeCloseTo(0, 5)
    expect(distanceToPath(straightMidpoint, drawing.path)).toBeGreaterThan(1)
    expect(drawing.progressPercent).toBe(50)
  })

  it('lands the vehicle on the ends at 0 and 1', () => {
    const start = buildRouteSketchDrawing({ ...elbow, progress: 0 })!
    const end = buildRouteSketchDrawing({ ...elbow, progress: 1 })!

    expect(start.vehicle).toEqual({ x: start.markers[0]!.x, y: start.markers[0]!.y })
    expect(end.vehicle).toEqual({ x: end.markers[2]!.x, y: end.markers[2]!.y })
    expect(start.progressPercent).toBe(0)
    expect(end.progressPercent).toBe(100)
  })

  it('moves monotonically forward as the authored progress advances', () => {
    const travelled = [0, 0.08, 0.4, 0.52, 0.72, 0.92, 1].map((progress) => {
      const drawing = buildRouteSketchDrawing({ ...elbow, polyline: straightLine(), progress })!
      return drawing.vehicle!.x
    })

    for (const [index, x] of travelled.slice(1).entries()) expect(x).toBeGreaterThan(travelled[index]!)
  })

  it('draws a westbound leg from left to right like the stop names beside it', () => {
    // The demo's airport route runs west: unmirrored it would start at the right
    // edge, and a marker at 8% would sit next to the destination.
    const westbound = buildRouteSketchDrawing({
      waypoints: [
        { name: '出发地', latitude: 31.23, longitude: 121.47 },
        { name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
      ],
      polyline: [
        { latitude: 31.23, longitude: 121.47 },
        { latitude: 31.222, longitude: 121.44 },
        { latitude: 31.21, longitude: 121.39 },
        { latitude: 31.198, longitude: 121.336 },
      ],
      progress: 0.08,
    })!

    const [origin, destination] = westbound.markers
    expect(origin!.x).toBeLessThan(destination!.x)
    // Just departed reads as just departed, next to the origin it left.
    expect(westbound.vehicle!.x - origin!.x).toBeLessThan((destination!.x - origin!.x) / 2)
    // Mirroring is horizontal only: the leg still descends south as it goes.
    expect(origin!.y).toBeLessThan(destination!.y)
  })

  it('leaves an eastbound leg unmirrored', () => {
    const drawing = buildRouteSketchDrawing({ ...elbow, progress: 0.1 })!
    const [origin, , destination] = drawing.markers

    expect(origin!.x).toBeLessThan(destination!.x)
    expect(drawing.vehicle!.x).toBeGreaterThan(origin!.x)
  })

  it('shows no vehicle when no progress was authored', () => {
    const drawing = buildRouteSketchDrawing(elbow)!

    expect(drawing.vehicle).toBeUndefined()
    expect(drawing.progressPercent).toBeUndefined()
    expect(drawing.markers).toHaveLength(3)
  })

  it('keeps the line and drops the vehicle when progress is not a usable number', () => {
    for (const progress of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2]) {
      const drawing = buildRouteSketchDrawing({ ...elbow, progress } as RouteSketch)!
      expect(drawing.path.length).toBeGreaterThan(0)
      expect(drawing.vehicle).toBeUndefined()
    }
  })

  it('refuses to draw geometry that has no line in it', () => {
    expect(buildRouteSketchDrawing(undefined)).toBeUndefined()
    expect(buildRouteSketchDrawing({ ...elbow, polyline: [] } as unknown as RouteSketch)).toBeUndefined()
    expect(buildRouteSketchDrawing({ ...elbow, polyline: elbow.polyline.slice(0, 1) } as RouteSketch)).toBeUndefined()
    // Every point on the same spot: a dot, not a route.
    expect(
      buildRouteSketchDrawing({
        ...elbow,
        polyline: [
          { latitude: 31.23, longitude: 121.4 },
          { latitude: 31.23, longitude: 121.4 },
          { latitude: 31.23, longitude: 121.4 },
        ],
        progress: 0.5,
      }),
    ).toBeUndefined()
  })

  it('skips unplottable points instead of throwing', () => {
    const drawing = buildRouteSketchDrawing({
      waypoints: [
        { name: '出发地', latitude: Number.NaN, longitude: 121.4 },
        { name: '虹桥机场 T2', latitude: 31.13, longitude: 121.5 },
      ],
      polyline: [
        { latitude: 31.23, longitude: 121.4 },
        { latitude: Number.POSITIVE_INFINITY, longitude: 121.45 },
        { latitude: 31.13, longitude: 121.5 },
      ],
      progress: 0.5,
    } as unknown as RouteSketch)!

    // The unplottable point is dropped from both the line and the labels.
    expect(drawing.path.split('L')).toHaveLength(2)
    expect(drawing.markers.map((marker) => marker.name)).toEqual(['虹桥机场 T2'])
    expect(Number.isFinite(drawing.vehicle!.x)).toBe(true)
  })

  it('steps over duplicate points and zero-length segments', () => {
    const drawing = buildRouteSketchDrawing({
      ...elbow,
      polyline: [
        { latitude: 31.23, longitude: 121.4 },
        { latitude: 31.23, longitude: 121.4 },
        { latitude: 31.23, longitude: 121.5 },
        { latitude: 31.23, longitude: 121.5 },
      ],
      progress: 0.5,
    })!

    expect(Number.isFinite(drawing.vehicle!.x)).toBe(true)
    expect(Number.isFinite(drawing.vehicle!.y)).toBe(true)
  })

  it('centres a line that has no span on one axis', () => {
    const drawing = buildRouteSketchDrawing({
      waypoints: [
        { name: '出发地', latitude: 31.23, longitude: 121.4 },
        { name: '虹桥机场 T2', latitude: 31.23, longitude: 121.5 },
      ],
      polyline: [
        { latitude: 31.23, longitude: 121.4 },
        { latitude: 31.23, longitude: 121.5 },
      ],
      progress: 1,
    })!

    const middle = ROUTE_SKETCH_VIEWBOX.height / 2
    for (const marker of drawing.markers) expect(marker.y).toBeCloseTo(middle, 5)
    expect(drawing.vehicle!.y).toBeCloseTo(middle, 5)
  })

  it('gives markers stable keys even when the geometry has no ids', () => {
    const drawing = buildRouteSketchDrawing({
      waypoints: [
        { name: '出发地', latitude: 31.23, longitude: 121.4 },
        { name: '出发地', latitude: 31.2, longitude: 121.45 },
        { name: '虹桥机场 T2', latitude: 31.13, longitude: 121.5 },
      ],
      polyline: elbow.polyline,
    })!

    expect(new Set(drawing.markers.map((marker) => marker.key)).size).toBe(3)
  })
})

function straightLine(): RouteSketch['polyline'] {
  return [
    { latitude: 31.23, longitude: 121.4 },
    { latitude: 31.23, longitude: 121.45 },
    { latitude: 31.23, longitude: 121.5 },
  ]
}

/** Shortest distance from a point to the drawn path, in view-box units. */
function distanceToPath(point: { x: number; y: number }, path: string): number {
  const vertices = path.split(/[ML]/).filter((command) => command.trim().length > 0).map((command) => {
    const [x, y] = command.trim().split(' ').map(Number)
    return { x: x!, y: y! }
  })
  return Math.min(...vertices.slice(1).map((to, index) => {
    const from = vertices[index]!
    const spanX = to.x - from.x
    const spanY = to.y - from.y
    const lengthSquared = spanX * spanX + spanY * spanY
    const ratio = lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((point.x - from.x) * spanX + (point.y - from.y) * spanY) / lengthSquared))
    return Math.hypot(point.x - (from.x + spanX * ratio), point.y - (from.y + spanY * ratio))
  }))
}
