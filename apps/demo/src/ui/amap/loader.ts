/**
 * Loads the AMap JS API, or resolves null when the demo should stay offline.
 *
 * A failed key is retired for the current generation and the next configured
 * key is tried. Generation checks make a late event from an old attempt unable
 * to settle or remove the script belonging to a newer attempt.
 */

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

export type AMapOverlay = Record<string, never>
export type AMapMarker = AMapOverlay & {
  setPosition: (position: [number, number]) => void
  setAngle?: (angle: number) => void
}
export type AMapPolyline = AMapOverlay & { setPath: (path: Array<[number, number]>) => void }

type AMapWindow = typeof globalThis & {
  AMap?: AMapApi
  _AMapSecurityConfig?: { serviceHost: string }
}

const SCRIPT_ID = 'amap-js-api'
const LOAD_TIMEOUT_MS = 3000

let pending: Promise<AMapApi | null> | null = null
let generation = 0
let keyIndex = 0
let currentScript: HTMLScriptElement | null = null
let currentScriptGeneration = -1

function configuredKeys(): string[] {
  const env = import.meta.env as ImportMetaEnv & { VITE_AMAP_JS_KEYS?: string; VITE_AMAP_JS_KEY?: string }
  const raw = env.VITE_AMAP_JS_KEYS || env.VITE_AMAP_JS_KEY || ''
  return raw.split(',').map((key) => key.trim()).filter(Boolean)
}

export function loadAMap(): Promise<AMapApi | null> {
  if (pending) return pending
  if (typeof window !== 'undefined' && (window as AMapWindow).AMap) {
    pending = Promise.resolve((window as AMapWindow).AMap!)
    return pending
  }
  const loadGeneration = generation
  pending = loadAll(loadGeneration)
  return pending
}

async function loadAll(loadGeneration: number): Promise<AMapApi | null> {
  const keys = configuredKeys()
  if (typeof window === 'undefined' || typeof document === 'undefined' || keys.length === 0) return null
  const start = keyIndex % keys.length
  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (start + offset) % keys.length
    const api = await loadAttempt(keys[index]!, loadGeneration)
    if (loadGeneration !== generation) return null
    if (api) {
      keyIndex = index
      return api
    }
  }
  delete (window as AMapWindow)._AMapSecurityConfig
  return null
}

function loadAttempt(key: string, loadGeneration: number): Promise<AMapApi | null> {
  const amapWindow = window as AMapWindow
  return new Promise((resolve) => {
    let settled = false
    let timer: number | undefined
    let script: HTMLScriptElement | null = null
    const finish = (value: AMapApi | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) window.clearTimeout(timer)
      const isCurrent = loadGeneration === generation && currentScript === script && currentScriptGeneration === loadGeneration
      if (!isCurrent) {
        resolve(null)
        return
      }
      if (value) {
        resolve(value)
        return
      }
      delete amapWindow.AMap
      if (script && script.parentNode && document.getElementById(SCRIPT_ID) === script) script.remove()
      currentScript = null
      resolve(null)
    }

    amapWindow._AMapSecurityConfig = { serviceHost: `${window.location.origin}/_AMapService` }
    const existing = document.getElementById(SCRIPT_ID)
    if (existing && existing !== currentScript) existing.remove()
    script = document.createElement('script')
    script.id = SCRIPT_ID
    script.async = true
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.Driving`
    currentScript = script
    currentScriptGeneration = loadGeneration
    script.addEventListener('load', () => finish(amapWindow.AMap ?? null))
    script.addEventListener('error', () => finish(null))
    timer = window.setTimeout(() => finish(null), LOAD_TIMEOUT_MS)
    document.head.appendChild(script)
  })
}

/** Invalidate the current generation and optionally advance to the next key. */
export function invalidateAMap(options: { rotate?: boolean } = {}): void {
  generation += 1
  if (options.rotate !== false) keyIndex += 1
  const amapWindow = typeof window === 'undefined' ? null : (window as AMapWindow)
  if (currentScript && currentScriptGeneration < generation && currentScript.parentNode && document.getElementById(SCRIPT_ID) === currentScript) {
    currentScript.remove()
  }
  currentScript = null
  currentScriptGeneration = -1
  if (amapWindow) {
    delete amapWindow.AMap
    delete amapWindow._AMapSecurityConfig
  }
  pending = null
}

/** Test-only: drop the single-flight cache and generation state. */
export function __resetAMapLoaderForTest(): void {
  invalidateAMap({ rotate: false })
  keyIndex = 0
  generation = 0
}
