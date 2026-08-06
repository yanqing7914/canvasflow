import type { RouteSketch } from '@canvasflow/schema'

/**
 * Geometry for the offline route drawing, shared by the `route-map` panel and
 * the band inside `NavigationSummaryCard`.
 *
 * Everything here is presentation math over fixture points: it normalizes a
 * fictional polyline into an SVG box and places a marker a given fraction along
 * the drawn line. It is not positioning, and it deliberately holds no route,
 * fixture, or provider knowledge — the cards render exactly what the UISpec
 * carries.
 */

/**
 * User-space box the in-card band normalizes into. The aspect ratio is fixed so
 * the SVG can scale uniformly with its column (height follows width) without
 * distorting strokes or turning marker dots into ellipses.
 */
export const ROUTE_SKETCH_VIEWBOX = { width: 480, height: 72 } as const

/** User-space box the standalone `route-map` panel normalizes into. */
export const ROUTE_MAP_VIEWBOX = { width: 640, height: 420 } as const

export type RouteSketchBox = { width: number; height: number }

type Padding = { top: number; right: number; bottom: number; left: number }

/** Room for a marker dot and its stroke at the extremes of the band. */
const BAND_PADDING: Padding = { top: 14, right: 16, bottom: 14, left: 16 }

/**
 * The panel's caption sits over the bottom of the canvas, so the drawing keeps
 * clear of that strip instead of putting a stop marker underneath it.
 */
const PANEL_PADDING: Padding = { top: 34, right: 44, bottom: 78, left: 44 }

export type RouteSketchDrawingOptions = {
  /** Defaults to {@link ROUTE_SKETCH_VIEWBOX}. */
  viewBox?: RouteSketchBox
  /** Keep-clear margin inside the box; defaults to the band's. */
  padding?: Padding
  /**
   * `stretch` fills both axes independently — right for a strip diagram, which
   * makes no claim about shape. `contain` scales both axes by the same factor
   * and centres the result, so the drawn line keeps the proportions the points
   * have. That is the data's own aspect ratio, not a map projection: these
   * points are fictional and no degree-to-distance correction is applied.
   */
  fit?: 'stretch' | 'contain'
  /** Mirror a westbound leg so it reads left to right. See {@link readLeftToRight}. */
  mirrorWestbound?: boolean
}

/** The band's behaviour, unchanged: a stretched, mirrored strip diagram. */
const BAND_OPTIONS = {
  viewBox: ROUTE_SKETCH_VIEWBOX,
  padding: BAND_PADDING,
  fit: 'stretch',
  mirrorWestbound: true,
} as const

/**
 * The panel's behaviour: proportional and unmirrored.
 *
 * A panel is read as a map, so north stays up and west stays left — flipping it
 * would put the airport on the wrong side of the frame. The band can mirror
 * because it is a strip beside a list of stop names, not a picture of a place.
 */
export const ROUTE_MAP_DRAWING_OPTIONS: RouteSketchDrawingOptions = {
  viewBox: ROUTE_MAP_VIEWBOX,
  padding: PANEL_PADDING,
  fit: 'contain',
  mirrorWestbound: false,
}

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
 * Min/max normalization into the box.
 *
 * With `stretch` each axis is normalized independently: the sketch has no
 * geographic scale, so both axes fill the box rather than preserving a ratio the
 * fixture never claimed. With `contain` both axes share one scale factor and the
 * drawing is centred, so the line keeps its shape inside a panel. An axis with
 * no span collapses to the middle of the box instead of dividing by zero.
 */
function projector(
  points: RouteSketchPoint[],
  box: RouteSketchBox,
  padding: Padding,
  fit: 'stretch' | 'contain',
): (point: RouteSketchPoint) => { x: number; y: number } {
  const latitudes = points.map((point) => point.latitude)
  const longitudes = points.map((point) => point.longitude)
  const minLatitude = Math.min(...latitudes)
  const maxLatitude = Math.max(...latitudes)
  const minLongitude = Math.min(...longitudes)
  const maxLongitude = Math.max(...longitudes)
  const latitudeSpan = maxLatitude - minLatitude
  const longitudeSpan = maxLongitude - minLongitude
  const innerWidth = box.width - padding.left - padding.right
  const innerHeight = box.height - padding.top - padding.bottom
  // Higher latitude is a smaller y, so a leg that climbs north climbs on screen too.
  if (fit === 'stretch') {
    return (point) => ({
      x: longitudeSpan === 0
        ? padding.left + innerWidth / 2
        : padding.left + ((point.longitude - minLongitude) / longitudeSpan) * innerWidth,
      y: latitudeSpan === 0
        ? padding.top + innerHeight / 2
        : padding.top + ((maxLatitude - point.latitude) / latitudeSpan) * innerHeight,
    })
  }
  const scales = [
    ...(longitudeSpan > 0 ? [innerWidth / longitudeSpan] : []),
    ...(latitudeSpan > 0 ? [innerHeight / latitudeSpan] : []),
  ]
  // No span on either axis: every point is the same place, so scale is moot.
  const scale = scales.length > 0 ? Math.min(...scales) : 1
  const offsetX = padding.left + (innerWidth - longitudeSpan * scale) / 2
  const offsetY = padding.top + (innerHeight - latitudeSpan * scale) / 2
  return (point) => ({
    x: offsetX + (point.longitude - minLongitude) * scale,
    y: offsetY + (maxLatitude - point.latitude) * scale,
  })
}

/**
 * Mirror the box horizontally so the drawing always leaves from the left and
 * arrives at the right.
 *
 * This is for a strip diagram, not a compass: the stop names sit beside it in
 * travel order, so a leg that happens to head west has to be flipped rather than
 * drawn against them — otherwise a marker at 8% appears at the far right, next
 * to the destination it has not reached. Mirroring keeps the shape of the
 * fictional line and only changes which end of the frame it starts at. The
 * standalone panel opts out, because a panel is read as a map.
 */
function readLeftToRight(
  project: (point: RouteSketchPoint) => { x: number; y: number },
  polyline: RouteSketchPoint[],
  boxWidth: number,
): (point: RouteSketchPoint) => { x: number; y: number } {
  const from = project(polyline[0]!)
  const to = project(polyline[polyline.length - 1]!)
  if (to.x >= from.x) return project
  return (point) => {
    const projected = project(point)
    return { x: boxWidth - projected.x, y: projected.y }
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
 *
 * Exported so a live-basemap renderer can place the vehicle the same way, on the
 * road geometry the map returns rather than the fixture polyline.
 */
export function pointAtProgress(
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

export function segmentLengths(points: Array<{ x: number; y: number }>): number[] {
  return points.slice(1).map((point, index) => {
    const previous = points[index]!
    return Math.hypot(point.x - previous.x, point.y - previous.y)
  })
}

/**
 * Turn spec geometry into something drawable, or `undefined` when it cannot be
 * drawn honestly — fewer than two plottable points, or a polyline whose points
 * all collapse onto each other. Callers fall back to the card's text.
 *
 * `options` defaults to the in-card band; pass {@link ROUTE_MAP_DRAWING_OPTIONS}
 * for the standalone panel.
 */
export function buildRouteSketchDrawing(
  sketch: RouteSketch | undefined,
  options: RouteSketchDrawingOptions = {},
): RouteSketchDrawing | undefined {
  if (!sketch) return undefined
  const box = options.viewBox ?? BAND_OPTIONS.viewBox
  const fit = options.fit ?? BAND_OPTIONS.fit
  const padding = options.padding ?? BAND_OPTIONS.padding
  const polyline = sketch.polyline.filter(plottable)
  if (polyline.length < 2) return undefined
  const waypoints = sketch.waypoints.filter(plottable)
  const projectInBox = projector([...polyline, ...waypoints], box, padding, fit)
  const project = (options.mirrorWestbound ?? BAND_OPTIONS.mirrorWestbound)
    ? readLeftToRight(projectInBox, polyline, box.width)
    : projectInBox
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
