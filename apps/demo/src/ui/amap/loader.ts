/** Generation-safe loader for the AMap Web JS API and its ordered key ring. */
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
  zoomIn?: () => void
  zoomOut?: () => void
  setPitch?: (pitch: number) => void
  setRotation?: (rotation: number) => void
  setMapStyle?: (style: string) => void
  setCenter?: (center: [number, number], immediately?: boolean) => void
  on?: (event: 'dragstart' | 'zoomstart', listener: () => void) => void
  off?: (event: 'dragstart' | 'zoomstart', listener: () => void) => void
  destroy: () => void
}

export type AMapDriving = {
  search: (origin: unknown, destination: unknown, options: { waypoints?: unknown[] }, callback: (status: string, result: unknown) => void) => void
}
export type AMapOverlay = Record<string, never>
export type AMapMarker = AMapOverlay & { setPosition: (position: [number, number]) => void; setAngle?: (angle: number) => void }
export type AMapPolyline = AMapOverlay & { setPath: (path: Array<[number, number]>) => void }

type AMapWindow = typeof globalThis & { AMap?: AMapApi; _AMapSecurityConfig?: { serviceHost: string } }
export type AMapLoaderSnapshot = { state: 'idle' | 'loading' | 'ready' | 'failed'; keyIndex?: number; keyCount: number }
type LoaderListener = (snapshot: AMapLoaderSnapshot) => void

const SCRIPT_ID = 'amap-js-api'
const LOAD_TIMEOUT_MS = 10_000
const listeners = new Set<LoaderListener>()
let pending: Promise<AMapApi | null> | null = null
let generation = 0
let keyIndex = 0
let currentScript: HTMLScriptElement | null = null
let currentScriptGeneration = -1
let testKeys: string[] | undefined
let snapshot: AMapLoaderSnapshot = { state: 'idle', keyCount: 0 }

function configuredKeys(): string[] {
  if (testKeys) return [...testKeys]
  const env = import.meta.env as ImportMetaEnv & { VITE_AMAP_JS_KEYS?: string; VITE_AMAP_JS_KEY?: string }
  const raw = env.VITE_AMAP_JS_KEYS || env.VITE_AMAP_JS_KEY || ''
  return raw.split(',').map((key) => key.trim()).filter(Boolean)
}

function publish(next: AMapLoaderSnapshot) {
  snapshot = next
  for (const listener of listeners) listener(next)
}

export function amapLoaderSnapshot(): AMapLoaderSnapshot { return snapshot }
export function subscribeAMapLoader(listener: LoaderListener): () => void {
  listeners.add(listener)
  listener(snapshot)
  return () => listeners.delete(listener)
}

export function loadAMap(): Promise<AMapApi | null> {
  if (pending) return pending
  const keys = configuredKeys()
  const loadGeneration = generation
  publish({ state: 'loading', keyCount: keys.length, ...(keys.length ? { keyIndex: keyIndex % keys.length } : {}) })
  if (typeof window !== 'undefined' && (window as AMapWindow).AMap) {
    const api = (window as AMapWindow).AMap!
    publish({ state: 'ready', keyCount: keys.length, ...(keys.length ? { keyIndex: keyIndex % keys.length } : {}) })
    pending = Promise.resolve(api)
    return pending
  }
  pending = loadAll(keys, loadGeneration).then((api) => {
    if (loadGeneration !== generation) return null
    publish(api
      ? { state: 'ready', keyCount: keys.length, keyIndex: keyIndex % keys.length }
      : { state: 'failed', keyCount: keys.length, ...(keys.length ? { keyIndex: keyIndex % keys.length } : {}) })
    return api
  })
  return pending
}

async function loadAll(keys: string[], loadGeneration: number): Promise<AMapApi | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined' || keys.length === 0) return null
  const start = keyIndex % keys.length
  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (start + offset) % keys.length
    const api = await loadAttempt(keys[index]!, index, loadGeneration)
    if (loadGeneration !== generation) return null
    if (api) {
      keyIndex = index
      return api
    }
  }
  delete (window as AMapWindow)._AMapSecurityConfig
  return null
}

function loadAttempt(key: string, attemptIndex: number, loadGeneration: number): Promise<AMapApi | null> {
  const amapWindow = window as AMapWindow
  return new Promise((resolve) => {
    let settled = false
    const timer = window.setTimeout(() => finish(null), LOAD_TIMEOUT_MS)
    let script: HTMLScriptElement | null = null
    const finish = (value: AMapApi | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      const current = loadGeneration === generation && currentScript === script && currentScriptGeneration === loadGeneration
      if (!current) { resolve(null); return }
      if (value) { resolve(value); return }
      delete amapWindow.AMap
      if (script?.parentNode && document.getElementById(SCRIPT_ID) === script) script.remove()
      currentScript = null
      resolve(null)
    }

    amapWindow._AMapSecurityConfig = { serviceHost: `${window.location.origin}/_AMapService` }
    const existing = document.getElementById(SCRIPT_ID)
    if (existing && existing !== currentScript) existing.remove()
    script = document.createElement('script')
    script.id = SCRIPT_ID
    script.dataset.keyIndex = String(attemptIndex)
    script.async = true
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.Driving`
    currentScript = script
    currentScriptGeneration = loadGeneration
    script.addEventListener('load', () => finish(amapWindow.AMap ?? null))
    script.addEventListener('error', () => finish(null))
    document.head.appendChild(script)
  })
}

export function invalidateAMap(options: { rotate?: boolean } = {}): void {
  generation += 1
  const count = configuredKeys().length
  if (options.rotate !== false && count > 0) keyIndex = (keyIndex + 1) % count
  const amapWindow = typeof window === 'undefined' ? null : (window as AMapWindow)
  if (currentScript?.parentNode && document.getElementById(SCRIPT_ID) === currentScript) currentScript.remove()
  currentScript = null
  currentScriptGeneration = -1
  if (amapWindow) {
    delete amapWindow.AMap
    delete amapWindow._AMapSecurityConfig
  }
  pending = null
  publish({ state: 'idle', keyCount: count, ...(count ? { keyIndex: keyIndex % count } : {}) })
}

export function retryAMap(): Promise<AMapApi | null> { invalidateAMap({ rotate: false }); return loadAMap() }
export function switchAMapKey(): Promise<AMapApi | null> { invalidateAMap(); return loadAMap() }
export function __setAMapKeysForTest(keys?: string[]): void { testKeys = keys }
export function __resetAMapLoaderForTest(): void {
  invalidateAMap({ rotate: false })
  keyIndex = 0
  generation = 0
  testKeys = undefined
  snapshot = { state: 'idle', keyCount: 0 }
}
