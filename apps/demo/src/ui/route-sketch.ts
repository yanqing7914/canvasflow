import type { RouteSketch } from '@canvasflow/schema'

/**
 * Geometry for the offline route sketch drawn by `NavigationSummaryCard`.
 *
 * Everything here is presentation math over fixture points: it normalizes a
 * fictional polyline into an SVG box and places a marker a given fraction along
 * the drawn line. It is not positioning, and it deliberately holds no route,
 * fixture, or provider knowledge — the card renders exactly what the UISpec
 * carries.
 */

/**
 * User-space box every sketch is normalized into. The aspect ratio is fixed so
 * the SVG can scale uniformly with its column (height follows width) without
 * distorting strokes or turning marker dots into ellipses.
 */
export const ROUTE_SKETCH_VIEWBOX = { width: 480, height: 72 } as const

/** Room for a marker dot and its stroke at the extremes of the drawing. */
const PADDING_X = 16
const PADDING_Y = 14

const INNER_WIDTH = ROUTE_SKETCH_VIEWBOX.width - PADDING_X * 2
const INNER_HEIGHT = ROUTE_SKETCH_VIEWBOX.height - PADDING_Y * 2

export type RouteSketchPoint = { latitude: number; longitude: number }

export type RouteSketchMarker = {
  key: string
  name: string
  role: 'origin' | 'via' | 'destination'
  x: number
  y: number
}

export type RouteSketchDrawing = {
  /** SVG path data for the route line. */
  path: string
  markers: RouteSketchMarker[]
  /** Present only when the spec carried a usable progress value. */
  vehicle?: { x: number; y: number }
  /** Whole percent for the visible "simulated trip progress" label. */
  progressPercent?: number
}

function plottable(point: RouteSketchPoint): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Independent min/max normalization per axis: the sketch has no geographic
 * scale, so both axes are stretched to fill the box rather than preserving a
 * ratio the fixture never claimed. An axis with no span collapses to the middle
 * of the box instead of dividing by zero.
 */
function projector(points: RouteSketchPoint[]): (point: RouteSketchPoint) => { x: number; y: number } {
  const latitudes = points.map((point) => point.latitude)
  const longitudes = points.map((point) => point.longitude)
  const minLatitude = Math.min(...latitudes)
  const maxLatitude = Math.max(...latitudes)
  const minLongitude = Math.min(...longitudes)
  const maxLongitude = Math.max(...longitudes)
  const latitudeSpan = maxLatitude - minLatitude
  const longitudeSpan = maxLongitude - minLongitude
  return (point) => ({
    x: longitudeSpan === 0
      ? PADDING_X + INNER_WIDTH / 2
      : PADDING_X + ((point.longitude - minLongitude) / longitudeSpan) * INNER_WIDTH,
    // Higher latitude is a smaller y, so a leg that climbs north climbs on screen too.
    y: latitudeSpan === 0
      ? PADDING_Y + INNER_HEIGHT / 2
      : PADDING_Y + ((maxLatitude - point.latitude) / latitudeSpan) * INNER_HEIGHT,
  })
}

/**
 * Mirror the box horizontally so the drawing always leaves from the left and
 * arrives at the right.
 *
 * This is a strip diagram, not a compass: the stop names sit beside it in travel
 * order, so a leg that happens to head west has to be flipped rather than drawn
 * against them — otherwise a marker at 8% appears at the far right, next to the
 * destination it has not reached. Mirroring keeps the shape of the fictional
 * line and only changes which end of the frame it starts at.
 */
function readLeftToRight(
  project: (point: RouteSketchPoint) => { x: number; y: number },
  polyline: RouteSketchPoint[],
): (point: RouteSketchPoint) => { x: number; y: number } {
  const from = project(polyline[0]!)
  const to = project(polyline[polyline.length - 1]!)
  if (to.x >= from.x) return project
  return (point) => {
    const projected = project(point)
    return { x: ROUTE_SKETCH_VIEWBOX.width - projected.x, y: projected.y }
  }
}

function roleFor(index: number, total: number): RouteSketchMarker['role'] {
  if (index === total - 1) return 'destination'
  // A lone named waypoint is the place the driver is going, not where they left.
  return index === 0 ? 'origin' : 'via'
}

/**
 * Position a fraction along the drawn line, measured by arc length rather than a
 * straight line between the endpoints, so a detour reads as distance covered.
 * Zero-length segments (duplicate points) contribute nothing and are stepped
 * over instead of being interpolated inside.
 */
function pointAtProgress(
  points: Array<{ x: number; y: number }>,
  lengths: number[],
  progress: number,
): { x: number; y: number } {
  const target = lengths.reduce((sum, length) => sum + length, 0) * progress
  let travelled = 0
  for (const [index, length] of lengths.entries()) {
    if (length === 0) continue
    if (travelled + length >= target) {
      const ratio = (target - travelled) / length
      const from = points[index]!
      const to = points[index + 1]!
      return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio }
    }
    travelled += length
  }
  return points[points.length - 1]!
}

function segmentLengths(points: Array<{ x: number; y: number }>): number[] {
  return points.slice(1).map((point, index) => {
    const previous = points[index]!
    return Math.hypot(point.x - previous.x, point.y - previous.y)
  })
}

/**
 * Turn spec geometry into something drawable, or `undefined` when it cannot be
 * drawn honestly — fewer than two plottable points, or a polyline whose points
 * all collapse onto each other. Callers fall back to the card's text.
 */
export function buildRouteSketchDrawing(sketch: RouteSketch | undefined): RouteSketchDrawing | undefined {
  if (!sketch) return undefined
  const polyline = sketch.polyline.filter(plottable)
  if (polyline.length < 2) return undefined
  const waypoints = sketch.waypoints.filter(plottable)
  const project = readLeftToRight(projector([...polyline, ...waypoints]), polyline)
  const points = polyline.map(project)
  const lengths = segmentLengths(points)
  // Every point landed on the same spot: there is no line to draw or travel.
  if (lengths.every((length) => length === 0)) return undefined
  const progress = sketch.progress !== undefined
    && Number.isFinite(sketch.progress)
    && sketch.progress >= 0
    && sketch.progress <= 1
    ? sketch.progress
    : undefined
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`)
    .join(' ')
  const markers = waypoints.map((waypoint, index) => {
    const projected = project(waypoint)
    return {
      key: waypoint.id ?? `${waypoint.name}-${index}`,
      name: waypoint.name,
      role: roleFor(index, waypoints.length),
      x: round(projected.x),
      y: round(projected.y),
    }
  })
  if (progress === undefined) return { path, markers }
  const vehicle = pointAtProgress(points, lengths, progress)
  return {
    path,
    markers,
    vehicle: { x: round(vehicle.x), y: round(vehicle.y) },
    progressPercent: Math.round(progress * 100),
  }
}
