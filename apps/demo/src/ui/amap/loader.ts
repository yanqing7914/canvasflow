/**
 * Loads the AMap JS API once, or resolves null when it should stay offline.
 *
 * The route panel calls this and falls back to its offline sketch on null, so
 * every failure mode — no key configured, script blocked, slow network — has to
 * end in a plain `null` rather than a throw. Nothing here logs the key, and with
 * no key the loader injects no script and touches the network not at all: the
 * demo's default, keyless state makes zero requests.
 *
 * The security code never appears here. It is server-only; the loader just
 * points AMap's service host at our `/_AMapService` proxy, which appends it.
 */

/** The slice of the AMap global the panel actually uses. */
export type AMapApi = {
  Map: new (container: HTMLElement, options?: Record<string, unknown>) => AMapMap
  Driving: new (options?: Record<string, unknown>) => AMapDriving
  Polyline: new (options: Record<string, unknown>) => AMapPolyline
  Marker: new (options: Record<string, unknown>) => AMapMarker
  LngLat: new (lng: number, lat: number) => unknown
}

export type AMapMap = {
  add: (overlay: AMapOverlay | AMapOverlay[]) => void
  remove: (overlay: AMapOverlay | AMapOverlay[]) => void
  setFitView: (overlays?: AMapOverlay[] | null) => void
  setZoomAndCenter: (zoom: number, center: [number, number]) => void
  setCenter?: (center: [number, number], immediately?: boolean) => void
  on?: (event: 'dragstart' | 'zoomstart', listener: () => void) => void
  off?: (event: 'dragstart' | 'zoomstart', listener: () => void) => void
  destroy: () => void
}

export type AMapDriving = {
  search: (
    origin: unknown,
    destination: unknown,
    options: { waypoints?: unknown[] },
    callback: (status: string, result: unknown) => void,
  ) => void
}

/**
 * An overlay the panel has added to the map.
 *
 * Structurally empty because nothing generic is read off one — they are handed
 * back to `map.remove` and no further. The two the crawl repositions are narrower
 * types below, so a plain overlay still cannot be moved by accident.
 */
export type AMapOverlay = Record<string, never>

/** A marker the crawl moves, rather than removes and rebuilds each frame. */
export type AMapMarker = AMapOverlay & {
  setPosition: (position: [number, number]) => void
  setAngle?: (angle: number) => void
}

/** A polyline whose points the crawl rewrites, for the traversed tail. */
export type AMapPolyline = AMapOverlay & {
  setPath: (path: Array<[number, number]>) => void
}

type AMapWindow = typeof globalThis & {
  AMap?: AMapApi
  _AMapSecurityConfig?: { serviceHost: string }
}

const SCRIPT_ID = 'amap-js-api'
const LOAD_TIMEOUT_MS = 3000

let pending: Promise<AMapApi | null> | null = null

/**
 * Resolve the AMap API, or null if it cannot be loaded. Single-flight: repeated
 * mounts share one load (and one script tag). Never rejects.
 */
export function loadAMap(): Promise<AMapApi | null> {
  if (pending) return pending
  pending = inject()
  return pending
}

function inject(): Promise<AMapApi | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null)
  const amapWindow = window as AMapWindow
  if (amapWindow.AMap) return Promise.resolve(amapWindow.AMap)

  const key = import.meta.env.VITE_AMAP_JS_KEY
  // No key: stay entirely offline. No script, no request, no security config.
  if (!key) return Promise.resolve(null)

  return new Promise<AMapApi | null>((resolve) => {
    // Route AMap's own service calls through our proxy so the jscode stays server-side.
    amapWindow._AMapSecurityConfig = { serviceHost: `${window.location.origin}/_AMapService` }

    const existing = document.getElementById(SCRIPT_ID)
    let settled = false
    const finish = (value: AMapApi | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve(value)
    }

    // No retry: one attempt, and a slow or blocked script degrades to the sketch.
    const timer = window.setTimeout(() => finish(null), LOAD_TIMEOUT_MS)

    if (existing) {
      existing.addEventListener('load', () => finish(amapWindow.AMap ?? null))
      existing.addEventListener('error', () => finish(null))
      if (amapWindow.AMap) finish(amapWindow.AMap)
      return
    }

    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.async = true
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.Driving`
    script.addEventListener('load', () => finish(amapWindow.AMap ?? null))
    // The failure is intentionally opaque: the key is never read back into any message.
    script.addEventListener('error', () => finish(null))
    document.head.appendChild(script)
  })
}

/** Test-only: drop the single-flight cache so a fresh load can be observed. */
export function __resetAMapLoaderForTest(): void {
  pending = null
}
