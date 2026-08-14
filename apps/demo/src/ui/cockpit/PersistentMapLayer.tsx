import { useEffect, useMemo, useRef, useState } from 'react'
import type { RouteSketch } from '@canvasflow/schema'
import { amapLoaderSnapshot, invalidateAMap, loadAMap } from '../amap/loader'
import { renderAMapWorkspace, type AMapWorkspaceHandle } from '../amap/render'
import { ROUTE_MAP_DRAWING_OPTIONS, ROUTE_MAP_VIEWBOX, buildRouteSketchDrawing } from '../route-sketch'

export const PEOPLES_SQUARE_POSITION = { latitude: 31.2304, longitude: 121.4737 } as const

export type PersistentMapLayerProps = {
  mode: 'idle' | 'route'
  sketch?: RouteSketch
  progress?: number
  theme: 'light' | 'dark'
  sessionKey: string
  /** Resets exhausted runtime recovery when a new business task starts. */
  recoveryKey?: string
  routeKey?: string
  mapRetryNonce?: number
  follow?: boolean
  cameraMode?: 'overview' | 'driving'
  recenterNonce?: number
  onManualInteraction?: () => void
  onRecenter?: () => void
  onRuntimeFailure?: () => void
  onRuntimeReady?: () => void
}

/** Stable cockpit map shell. AMap owns one basemap; only its overlays change. */
export function PersistentMapLayer({
  mode, sketch, progress, theme, sessionKey, recoveryKey = sessionKey, routeKey = mode, mapRetryNonce = 0,
  follow = true, cameraMode = 'overview', recenterNonce = 0, onManualInteraction, onRecenter, onRuntimeFailure, onRuntimeReady,
}: PersistentMapLayerProps) {
  const container = useRef<HTMLDivElement>(null)
  const handle = useRef<AMapWorkspaceHandle | undefined>(undefined)
  const initialLoader = amapLoaderSnapshot()
  const [source, setSource] = useState<'loading' | 'amap' | 'fallback'>(initialLoader.keyCount === 0 ? 'fallback' : 'loading')
  const failureCallback = useRef(onRuntimeFailure)
  failureCallback.current = onRuntimeFailure
  const readyCallback = useRef(onRuntimeReady)
  readyCallback.current = onRuntimeReady
  const manualInteractionCallback = useRef(onManualInteraction)
  manualInteractionCallback.current = onManualInteraction
  const initialTheme = useRef(theme)
  const [loadRevision, setLoadRevision] = useState(0)
  // The loader learns its configured key count when the first request starts,
  // which can be later than this component's initial render.
  const runtimeRetriesRemaining = useRef<number | undefined>(
    initialLoader.keyCount > 0 ? Math.max(0, initialLoader.keyCount - 1) : undefined,
  )
  const recoveryInFlight = useRef(false)
  const modeRef = useRef(mode)
  const sketchRef = useRef(sketch)
  const progressRef = useRef(progress)
  const cameraModeRef = useRef(cameraMode)
  modeRef.current = mode
  sketchRef.current = sketch
  progressRef.current = progress
  cameraModeRef.current = cameraMode
  const drawing = useMemo(() => mode === 'route' && sketch
    ? buildRouteSketchDrawing({ ...sketch, ...(progress === undefined ? {} : { progress }) }, ROUTE_MAP_DRAWING_OPTIONS)
    : undefined, [mode, progress, sketch])
  const effectiveProgress = mode === 'route' ? (progress ?? sketch?.progress) : undefined
  const destination = drawing?.markers.at(-1)?.name

  useEffect(() => {
    const keyCount = amapLoaderSnapshot().keyCount
    runtimeRetriesRemaining.current = keyCount > 0 ? Math.max(0, keyCount - 1) : undefined
    recoveryInFlight.current = false
  }, [mapRetryNonce, sessionKey])

  useEffect(() => {
    const keyCount = amapLoaderSnapshot().keyCount
    runtimeRetriesRemaining.current = keyCount > 0 ? Math.max(0, keyCount - 1) : undefined
    recoveryInFlight.current = false
    if (source !== 'fallback' || keyCount === 0) return
    // A failed previous trip must not poison the next one. Retrying a fallback
    // handle is safe; a healthy AMap handle stays mounted and is never rebuilt.
    invalidateAMap({ rotate: false })
    setLoadRevision((value) => value + 1)
  // `source` intentionally is not a dependency: this effect is a business
  // session boundary, not another reaction to the recovery it starts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryKey])

  const recoverRuntime = () => {
    if (recoveryInFlight.current) return
    recoveryInFlight.current = true
    setSource('fallback')
    failureCallback.current?.()
    if (runtimeRetriesRemaining.current === undefined) {
      const keyCount = amapLoaderSnapshot().keyCount
      runtimeRetriesRemaining.current = Math.max(0, keyCount - 1)
    }
    if (runtimeRetriesRemaining.current <= 0) return
    runtimeRetriesRemaining.current -= 1
    invalidateAMap({ rotate: true })
    setLoadRevision((value) => value + 1)
  }

  useEffect(() => {
    let cancelled = false
    recoveryInFlight.current = false
    const mount = container.current
    if (!mount) return
    setSource('loading')
    void loadAMap().then((amap) => {
      if (cancelled || !amap) {
        if (!cancelled) {
          recoverRuntime()
        }
        return
      }
      const rendered = renderAMapWorkspace(amap, mount, {
        mode: modeRef.current, sketch: sketchRef.current, progress: progressRef.current, cameraMode: cameraModeRef.current,
        theme: initialTheme.current,
        onManualInteraction: () => manualInteractionCallback.current?.(),
        onRuntimeFailure: () => {
          if (cancelled) return
          const current = handle.current
          handle.current = undefined
          current?.destroy()
          recoverRuntime()
        },
      })
      if (cancelled) { rendered?.destroy(); return }
      if (!rendered) { recoverRuntime(); return }
      handle.current = rendered
      setSource('amap')
      readyCallback.current?.()
      if (modeRef.current === 'route' && sketchRef.current) {
        void rendered.setMode('route', sketchRef.current, progressRef.current)
      }
    })
    return () => {
      cancelled = true
      handle.current?.destroy()
      handle.current = undefined
    }
  }, [mapRetryNonce, loadRevision])

  useEffect(() => {
    const current = handle.current
    if (!current) return
    if (mode === 'idle') {
      void current.setMode('idle')
      return
    }
    if (sketchRef.current) void current.setMode('route', sketchRef.current, progressRef.current)
  }, [mode, routeKey])

  useEffect(() => {
    if (mode === 'route' && progress !== undefined) handle.current?.setProgress(progress)
  }, [mode, progress])

  useEffect(() => { handle.current?.setFollow(follow) }, [follow, source])
  useEffect(() => { handle.current?.setCameraMode(cameraMode) }, [cameraMode, source])
  useEffect(() => { handle.current?.setTheme(theme) }, [theme, source])
  useEffect(() => { if (recenterNonce > 0) handle.current?.recenter() }, [recenterNonce])

  return (
    <section className="persistent-map-layer" data-testid="persistent-map-layer" data-map-source={source} data-mode={mode} data-theme={theme} data-session-key={sessionKey} data-progress={effectiveProgress === undefined ? undefined : String(effectiveProgress)} aria-label={mode === 'route' ? '模拟导航地图' : '座舱地图'}>
      <div ref={container} className="persistent-map-layer__basemap" data-active={source === 'amap'} aria-hidden="true" />
      <div className="persistent-map-layer__fallback" aria-hidden={source === 'amap'}>
        {drawing ? (
          <>
            <svg
              viewBox={`0 0 ${ROUTE_MAP_VIEWBOX.width} ${ROUTE_MAP_VIEWBOX.height}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={`前往${destination ?? '目的地'}的路线示意`}
            >
              <path className="persistent-map-layer__route" d={drawing.path} />
              {drawing.markers.map((marker) => (
                <circle
                  key={marker.key}
                  className="persistent-map-layer__stop"
                  data-role={marker.role}
                  cx={marker.x}
                  cy={marker.y}
                  r="7"
                />
              ))}
              {drawing.vehicle && <circle className="persistent-map-layer__vehicle" cx={drawing.vehicle.x} cy={drawing.vehicle.y} r="10" />}
            </svg>
            <ol className="persistent-map-layer__stops" aria-label="路线途经点">
              {drawing.markers.map((marker) => <li key={marker.key}>{marker.name}</li>)}
            </ol>
          </>
        ) : (
          <><span className="persistent-map-layer__car"><span /></span><span className="persistent-map-layer__location">上海 · 人民广场</span></>
        )}
      </div>
      <span className="persistent-map-layer__source">
        {source === 'amap' ? '高德道路图层' : source === 'loading' ? '地图服务连接中' : '离线地图示意'}
        {effectiveProgress !== undefined ? ` · 模拟行程进度 ${Math.round(effectiveProgress * 100)}%` : ''}
      </span>
      {!follow && mode === 'route' ? (
        <button
          className="persistent-map-layer__recenter"
          type="button"
          onClick={() => {
            handle.current?.recenter()
            onRecenter?.()
          }}
        >
          回到车辆位置
        </button>
      ) : null}
      {mode === 'route' ? (
        <div className="persistent-map-layer__zoom" aria-label="地图缩放">
          <button type="button" aria-label="放大地图" onClick={() => handle.current?.zoomIn()}>+</button>
          <button type="button" aria-label="缩小地图" onClick={() => handle.current?.zoomOut()}>−</button>
        </div>
      ) : null}
    </section>
  )
}
