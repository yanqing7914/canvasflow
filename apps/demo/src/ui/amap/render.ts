import type { RouteSketch } from '@canvasflow/schema'
import { pointAtProgress, segmentLengths } from '../route-sketch'
import type { AMapApi, AMapDriving, AMapMap, AMapOverlay } from './loader'

/**
 * Draws the trip on a real AMap basemap, or resolves null to let the caller fall
 * back to the offline sketch.
 *
 * The line on the map is never the fixture polyline — that fictional path would
 * cut through buildings and water on real tiles. The only line drawn here is the
 * road geometry `AMap.Driving` returns for the fixture's start, waypoints, and
 * end. The vehicle is placed on that returned geometry by the same arc-length
 * math the sketch uses, from the spec's authored progress; it is a simulated
 * position, not a GPS fix, and it moves only when a new spec arrives. There is no
 * timer and no animation.
 *
 * The basemap style follows the theme the Agent sent. A daylight basemap under a
 * dark cabin would be the one surface still lit at night, and it is also the one
 * the glass has to stay readable over.
 *
 * Any failure — no plottable endpoints, a Driving error, a quota or jscode
 * rejection surfacing as a non-complete status — resolves null. The caller then
 * shows the sketch, so the map never half-renders.
 */

export type AMapRouteHandle = { destroy: () => void }

export type AMapRouteOptions = {
  sketch: RouteSketch
  mode: 'overview' | 'follow'
  theme: 'light' | 'dark'
}

/**
 * Basemap and route colours for one theme.
 *
 * `amap://styles/dark` is one of AMap's built-in styles, so it needs no console
 * configuration — only custom GeoHUB style IDs do. The route colours change with
 * it because the daylight blue and the traversed grey were both picked against
 * light tiles; on the dark basemap the blue sinks into the road fill and the grey
 * stops reading as "already covered".
 */
const THEMES = {
  light: { mapStyle: undefined, route: '#246bfd', traversed: '#9aa7b8' },
  dark: { mapStyle: 'amap://styles/dark', route: '#5b93ff', traversed: '#55637a' },
} as const

type LngLatPoint = { lng: number; lat: number }

function plottable(point: { latitude: number; longitude: number }): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
}

function tuple(point: { latitude: number; longitude: number }): [number, number] {
  return [point.longitude, point.latitude]
}

/** AMap path points expose lng/lat either as properties or accessors across builds. */
function readLngLat(point: unknown): LngLatPoint | null {
  if (!point || typeof point !== 'object') return null
  const candidate = point as { lng?: unknown; lat?: unknown; getLng?: () => number; getLat?: () => number }
  const lng = typeof candidate.getLng === 'function' ? candidate.getLng() : candidate.lng
  const lat = typeof candidate.getLat === 'function' ? candidate.getLat() : candidate.lat
  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return { lng, lat }
}

function extractPath(result: unknown): LngLatPoint[] {
  const routes = (result as { routes?: Array<{ steps?: Array<{ path?: unknown[] }> }> })?.routes
  const steps = routes?.[0]?.steps
  if (!Array.isArray(steps)) return []
  const path: LngLatPoint[] = []
  for (const step of steps) {
    if (!Array.isArray(step.path)) continue
    for (const raw of step.path) {
      const point = readLngLat(raw)
      if (point) path.push(point)
    }
  }
  return path
}

export function renderAMapRoute(
  amap: AMapApi,
  container: HTMLElement,
  options: AMapRouteOptions,
): Promise<AMapRouteHandle | null> {
  const stops = options.sketch.waypoints.filter(plottable)
  if (stops.length < 2) return Promise.resolve(null)

  const palette = THEMES[options.theme]
  let map: AMapMap | undefined
  try {
    map = new amap.Map(container, {
      zoom: 12,
      ...(palette.mapStyle ? { mapStyle: palette.mapStyle } : {}),
    })
  } catch {
    return Promise.resolve(null)
  }
  const activeMap = map

  const origin = tuple(stops[0]!)
  const destination = tuple(stops[stops.length - 1]!)
  const waypoints = stops.slice(1, -1).map(tuple)

  return new Promise<AMapRouteHandle | null>((resolve) => {
    const giveUp = () => {
      try { activeMap.destroy() } catch { /* nothing to clean up */ }
      resolve(null)
    }
    let driving: AMapDriving
    try {
      driving = new amap.Driving({ map: activeMap })
    } catch {
      giveUp()
      return
    }
    try {
      driving.search(origin, destination, { waypoints }, (status, result) => {
        if (status !== 'complete') {
          giveUp()
          return
        }
        try {
          const handle = drawRoute(amap, activeMap, result, options)
          resolve(handle)
        } catch {
          giveUp()
        }
      })
    } catch {
      giveUp()
    }
  })
}

function drawRoute(
  amap: AMapApi,
  map: AMapMap,
  result: unknown,
  options: AMapRouteOptions,
): AMapRouteHandle {
  const path = extractPath(result)
  if (path.length < 2) throw new Error('empty route path')

  const palette = THEMES[options.theme]
  const overlays: AMapOverlay[] = []
  const route = new amap.Polyline({
    path: path.map((point) => [point.lng, point.lat]),
    strokeColor: palette.route,
    strokeWeight: 6,
    strokeOpacity: 0.9,
    lineJoin: 'round',
    zIndex: 50,
  })
  map.add(route)
  overlays.push(route)

  const progress = normalizedProgress(options.sketch.progress)
  let vehicle: LngLatPoint | undefined
  if (progress !== undefined) {
    const asXy = path.map((point) => ({ x: point.lng, y: point.lat }))
    const lengths = segmentLengths(asXy)
    if (lengths.some((length) => length > 0)) {
      const at = pointAtProgress(asXy, lengths, progress)
      vehicle = { lng: at.x, lat: at.y }
      const traversed = traversedPath(asXy, lengths, progress)
      if (traversed.length >= 2) {
        const tail = new amap.Polyline({
          path: traversed.map((point) => [point.x, point.y]),
          strokeColor: palette.traversed,
          strokeWeight: 6,
          strokeOpacity: 0.9,
          zIndex: 60,
        })
        map.add(tail)
        overlays.push(tail)
      }
      const marker = new amap.Marker({ position: [vehicle.lng, vehicle.lat], zIndex: 70 })
      map.add(marker)
      overlays.push(marker)
    }
  }

  if (options.mode === 'follow' && vehicle) {
    map.setZoomAndCenter(14, [vehicle.lng, vehicle.lat])
  } else {
    map.setFitView(overlays)
  }

  return {
    destroy: () => {
      try {
        map.remove(overlays)
        map.destroy()
      } catch {
        /* the map is being torn down; nothing to recover */
      }
    },
  }
}

/** Only a finite fraction in [0, 1] places a vehicle; anything else is overview. */
function normalizedProgress(progress: number | undefined): number | undefined {
  if (progress === undefined || !Number.isFinite(progress)) return undefined
  if (progress < 0 || progress > 1) return undefined
  return progress
}

/** The stretch of road already covered, from the start up to the vehicle point. */
function traversedPath(
  points: Array<{ x: number; y: number }>,
  lengths: number[],
  progress: number,
): Array<{ x: number; y: number }> {
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const target = total * progress
  const covered: Array<{ x: number; y: number }> = [points[0]!]
  let travelled = 0
  for (const [index, length] of lengths.entries()) {
    if (travelled + length >= target) {
      covered.push(pointAtProgress(points, lengths, progress))
      break
    }
    travelled += length
    covered.push(points[index + 1]!)
  }
  return covered
}
