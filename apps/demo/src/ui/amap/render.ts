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
 * position, not a GPS fix.
 *
 * The marker can move without a new spec, through `setProgress` on the returned
 * handle, and that is the only way it moves: this module runs no clock of its
 * own and decides no position. The caller drives it between the two points the
 * fixture authored — see `crawl.ts` — so the geometry here stays a pure function
 * of a progress value handed in.
 *
 * The basemap style follows the theme the Agent sent. A daylight basemap under a
 * dark cabin would be the one surface still lit at night, and it is also the one
 * the glass has to stay readable over.
 *
 * Any failure — no plottable endpoints, a Driving error, a quota or jscode
 * rejection surfacing as a non-complete status — resolves null. The caller then
 * shows the sketch, so the map never half-renders.
 */

export type AMapRouteHandle = {
  /**
   * Moves the vehicle marker and the traversed tail to a new point on the road
   * geometry already drawn. A no-op where the route carries no marker, so the
   * caller does not have to know whether the spec authored a progress value.
   */
  setProgress: (progress: number) => void
  setRoute: (sketch: RouteSketch) => Promise<boolean>
  setFollow: (follow: boolean) => void
  recenter: () => void
  destroy: () => void
}

export type AMapPositionHandle = { destroy: () => void }

/** A map handle whose basemap survives idle/route transitions. */
export type AMapWorkspaceHandle = {
  setMode: (mode: 'idle' | 'route', sketch?: RouteSketch, progress?: number) => Promise<boolean>
  setRoute: (sketch: RouteSketch) => Promise<boolean>
  setProgress: (progress: number) => void
  setFollow: (follow: boolean) => void
  recenter: () => void
  destroy: () => void
}

export type AMapWorkspaceOptions = {
  mode: 'idle' | 'route'
  sketch?: RouteSketch
  progress?: number
  theme: 'light' | 'dark'
  onManualInteraction?: () => void
  onRuntimeFailure?: () => void
}

export function renderAMapPosition(
  amap: AMapApi,
  container: HTMLElement,
  options: { position: { latitude: number; longitude: number }; theme: 'light' | 'dark' },
): AMapPositionHandle | null {
  if (!plottable(options.position)) return null
  let map: AMapMap
  let marker: AMapOverlay
  try {
    const palette = THEMES[options.theme]
    map = new amap.Map(container, { zoom: 14, center: tuple(options.position), ...(palette.mapStyle ? { mapStyle: palette.mapStyle } : {}) })
    marker = new amap.Marker({
      position: tuple(options.position),
      zIndex: 70,
      anchor: 'center',
      content: '<span class="amap-cockpit-car" aria-hidden="true"><span></span></span>',
    })
    map.add(marker)
    map.setZoomAndCenter(14, tuple(options.position))
  } catch {
    try { map!.destroy() } catch { /* failed construction has nothing else to release */ }
    return null
  }
  return { destroy: () => {
    try { map.remove(marker); map.destroy() } catch { /* unmount cleanup is best-effort */ }
  } }
}

/**
 * Creates one AMap instance for the lifetime of a cockpit session. Route
 * overlays are replaced in-place while the idle marker and map DOM remain.
 */
export function renderAMapWorkspace(
  amap: AMapApi,
  container: HTMLElement,
  options: AMapWorkspaceOptions,
): AMapWorkspaceHandle | null {
  const palette = THEMES[options.theme]
  let map: AMapMap
  let idleMarker: AMapOverlay | undefined
  let routeOverlays: AMapOverlay[] = []
  let moveTo: ((progress: number) => void) | undefined
  let currentProgress: number | undefined
  let following = options.mode === 'route'
  let destroyed = false
  let routeGeneration = 0

  try {
    map = new amap.Map(container, { zoom: 14, center: [121.4737, 31.2304], ...(palette.mapStyle ? { mapStyle: palette.mapStyle } : {}) })
    idleMarker = new amap.Marker({
      position: [121.4737, 31.2304], zIndex: 70, anchor: 'center',
      content: '<span class="amap-cockpit-car" aria-hidden="true"><span></span></span>',
    })
    map.add(idleMarker)
    map.setZoomAndCenter(14, [121.4737, 31.2304])
  } catch {
    try { map!.destroy() } catch { /* construction failed */ }
    options.onRuntimeFailure?.()
    return null
  }

  const clearRoute = () => {
    if (routeOverlays.length > 0) map.remove(routeOverlays)
    routeOverlays = []
    moveTo = undefined
    currentProgress = undefined
  }
  const drawWorkspaceRoute = (path: LngLatPoint[], progress: number | undefined) => {
    clearRoute()
    if (idleMarker) map.remove(idleMarker)
    const route = new amap.Polyline({
      path: path.map((point) => [point.lng, point.lat]), strokeColor: palette.route,
      strokeWeight: 6, strokeOpacity: 0.9, lineJoin: 'round', zIndex: 50,
    })
    map.add(route)
    routeOverlays.push(route)
    const normalized = normalizedProgress(progress)
    if (normalized === undefined) { map.setFitView(routeOverlays); return }
    const xy = path.map((point) => ({ x: point.lng, y: point.lat }))
    const lengths = segmentLengths(xy)
    if (!lengths.some((length) => length > 0)) { map.setFitView(routeOverlays); return }
    const markerPoint = pointAtProgress(xy, lengths, normalized)
    currentProgress = normalized
    const tail = new amap.Polyline({
      path: traversedPath(xy, lengths, normalized).map((point) => [point.x, point.y]),
      strokeColor: palette.traversed, strokeWeight: 6, strokeOpacity: 0.9, zIndex: 60,
    })
    const marker = new amap.Marker({
      position: [markerPoint.x, markerPoint.y], zIndex: 70, anchor: 'center',
      content: '<span class="amap-cockpit-car" aria-hidden="true"><span></span></span>',
    })
    map.add([tail, marker])
    routeOverlays.push(tail, marker)
    moveTo = (next: number) => {
      const valid = normalizedProgress(next)
      if (valid === undefined) return
      currentProgress = valid
      const point = pointAtProgress(xy, lengths, valid)
      marker.setPosition([point.x, point.y])
      marker.setAngle?.(headingAtProgress(xy, lengths, valid))
      tail.setPath(traversedPath(xy, lengths, valid).map((covered) => [covered.x, covered.y]))
      if (following) {
        if (map.setCenter) map.setCenter([point.x, point.y], false)
        else map.setZoomAndCenter(14, [point.x, point.y])
      }
    }
    if (following) map.setZoomAndCenter(14, [markerPoint.x, markerPoint.y])
    else map.setFitView(routeOverlays)
  }

  const leaveFollow = () => {
    if (!following) return
    following = false
    options.onManualInteraction?.()
  }
  map.on?.('dragstart', leaveFollow)
  map.on?.('zoomstart', leaveFollow)

  const setRoute = async (sketch: RouteSketch): Promise<boolean> => {
    if (destroyed) return false
    const requestGeneration = ++routeGeneration
    const path = await searchRoute(amap, map, sketch, () => {
      if (!destroyed && requestGeneration === routeGeneration) options.onRuntimeFailure?.()
    })
    if (path.length < 2 || destroyed || requestGeneration !== routeGeneration) return false
    try {
      drawWorkspaceRoute(path, sketch.progress)
      return true
    } catch {
      options.onRuntimeFailure?.()
      return false
    }
  }

  const handle: AMapWorkspaceHandle = {
    setMode: async (mode, sketch, progress) => {
      if (mode === 'idle') {
        routeGeneration += 1
        clearRoute()
        if (idleMarker) map.add(idleMarker)
        map.setZoomAndCenter(14, [121.4737, 31.2304])
        return true
      }
      if (!sketch) return false
      return setRoute({ ...sketch, ...(progress === undefined ? {} : { progress }) })
    },
    setRoute,
    setProgress: (progress) => {
      if (destroyed || normalizedProgress(progress) === undefined) return
      moveTo?.(progress)
    },
    setFollow: (follow) => { following = follow },
    recenter: () => {
      following = true
      if (currentProgress !== undefined) moveTo?.(currentProgress)
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      try {
        map.off?.('dragstart', leaveFollow)
        map.off?.('zoomstart', leaveFollow)
        clearRoute()
        if (idleMarker) map.remove(idleMarker)
        map.destroy()
      } catch { /* unmount cleanup is best-effort */ }
    },
  }

  if (options.mode === 'route' && options.sketch) {
    void handle.setMode('route', options.sketch, options.progress)
  }
  return handle
}

export type AMapRouteOptions = {
  sketch: RouteSketch
  mode: 'overview' | 'follow'
  theme: 'light' | 'dark'
  onManualInteraction?: () => void
  onRuntimeFailure?: () => void
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
    options.onRuntimeFailure?.()
    return Promise.resolve(null)
  }
  const activeMap = map

  const origin = tuple(stops[0]!)
  const destination = tuple(stops[stops.length - 1]!)
  const waypoints = stops.slice(1, -1).map(tuple)

  return new Promise<AMapRouteHandle | null>((resolve) => {
    let failed = false
    const giveUp = () => {
      if (failed) return
      failed = true
      try { activeMap.destroy() } catch { /* nothing to clean up */ }
      options.onRuntimeFailure?.()
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
  let overlays: AMapOverlay[] = []
  let following = options.mode === 'follow'
  let vehicle: LngLatPoint | undefined
  /** Set only where a marker was drawn, and the only thing `setProgress` moves. */
  let moveTo: ((progress: number) => void) | undefined
  const drawPath = (routePath: LngLatPoint[], progress: number | undefined) => {
    if (overlays.length > 0) map.remove(overlays)
    overlays = []
    moveTo = undefined
    const route = new amap.Polyline({
      path: routePath.map((point) => [point.lng, point.lat]),
      strokeColor: palette.route,
      strokeWeight: 6,
      strokeOpacity: 0.9,
      lineJoin: 'round',
      zIndex: 50,
    })
    map.add(route)
    overlays.push(route)
    if (progress === undefined) return
    const asXy = routePath.map((point) => ({ x: point.lng, y: point.lat }))
    const lengths = segmentLengths(asXy)
    if (lengths.some((length) => length > 0)) {
      const at = pointAtProgress(asXy, lengths, progress)
      vehicle = { lng: at.x, lat: at.y }
      // Created whatever the starting progress, because the crawl can grow the
      // traversed stretch from nothing: a tail added later would sit above the
      // marker in z-order and would not be in `overlays` for teardown.
      const tail = new amap.Polyline({
        path: traversedPath(asXy, lengths, progress).map((point) => [point.x, point.y]),
        strokeColor: palette.traversed,
        strokeWeight: 6,
        strokeOpacity: 0.9,
        zIndex: 60,
      })
      map.add(tail)
      overlays.push(tail)

      const marker = new amap.Marker({
        position: [vehicle.lng, vehicle.lat],
        zIndex: 70,
        anchor: 'center',
        content: '<span class="amap-cockpit-car" aria-hidden="true"><span></span></span>',
      })
      map.add(marker)
      overlays.push(marker)

      moveTo = (next: number) => {
        const point = pointAtProgress(asXy, lengths, next)
        vehicle = { lng: point.x, lat: point.y }
        marker.setPosition([point.x, point.y])
        marker.setAngle?.(headingAtProgress(asXy, lengths, next))
        tail.setPath(traversedPath(asXy, lengths, next).map((covered) => [covered.x, covered.y]))
        if (following) {
          if (map.setCenter) map.setCenter([point.x, point.y], false)
          else map.setZoomAndCenter(14, [point.x, point.y])
        }
      }
    }
  }
  drawPath(path, normalizedProgress(options.sketch.progress))

  if (options.mode === 'follow' && vehicle) {
    map.setZoomAndCenter(14, [vehicle.lng, vehicle.lat])
  } else {
    map.setFitView(overlays)
  }

  const leaveFollow = () => {
    if (!following) return
    following = false
    options.onManualInteraction?.()
  }
  map.on?.('dragstart', leaveFollow)
  map.on?.('zoomstart', leaveFollow)

  return {
    setProgress: (next: number) => {
      const clamped = normalizedProgress(next)
      if (clamped === undefined || !moveTo) return
      try {
        moveTo(clamped)
      } catch {
        // A repositioning that fails mid-crawl leaves the marker where it was,
        // which is a stale simulated point rather than a wrong one. Tearing the
        // map down over it would be the worse outcome.
      }
    },
    setRoute: async (sketch: RouteSketch) => {
      const nextPath = await searchRoute(amap, map, sketch, options.onRuntimeFailure)
      if (nextPath.length < 2) return false
      try {
        drawPath(nextPath, normalizedProgress(sketch.progress))
        if (following && vehicle) map.setZoomAndCenter(14, [vehicle.lng, vehicle.lat])
        else map.setFitView(overlays)
        return true
      } catch {
        options.onRuntimeFailure?.()
        return false
      }
    },
    setFollow: (next: boolean) => { following = next },
    recenter: () => {
      following = true
      if (vehicle) {
        if (map.setCenter) map.setCenter([vehicle.lng, vehicle.lat], false)
        else map.setZoomAndCenter(14, [vehicle.lng, vehicle.lat])
      }
    },
    destroy: () => {
      try {
        map.off?.('dragstart', leaveFollow)
        map.off?.('zoomstart', leaveFollow)
        map.remove(overlays)
        map.destroy()
      } catch {
        /* the map is being torn down; nothing to recover */
      }
    },
  }
}

function searchRoute(
  amap: AMapApi,
  map: AMapMap,
  sketch: RouteSketch,
  onRuntimeFailure?: () => void,
): Promise<LngLatPoint[]> {
  const stops = sketch.waypoints.filter(plottable)
  if (stops.length < 2) return Promise.resolve([])
  return new Promise((resolve) => {
    let driving: AMapDriving
    try {
      driving = new amap.Driving({ map })
    } catch {
      onRuntimeFailure?.()
      resolve([])
      return
    }
    try {
      driving.search(tuple(stops[0]!), tuple(stops[stops.length - 1]!), {
        waypoints: stops.slice(1, -1).map(tuple),
      }, (status, result) => {
        const path = status === 'complete' ? extractPath(result) : []
        if (path.length < 2) onRuntimeFailure?.()
        resolve(path)
      })
    } catch {
      onRuntimeFailure?.()
      resolve([])
    }
  })
}

function headingAtProgress(
  points: Array<{ x: number; y: number }>,
  lengths: number[],
  progress: number,
): number {
  const before = pointAtProgress(points, lengths, Math.max(0, progress - 0.002))
  const after = pointAtProgress(points, lengths, Math.min(1, progress + 0.002))
  return Math.atan2(after.x - before.x, after.y - before.y) * 180 / Math.PI
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
