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
  routeKey?: string
  mapRetryNonce?: number
  follow?: boolean
  recenterNonce?: number
  onManualInteraction?: () => void
  onRecenter?: () => void
  onRuntimeFailure?: () => void
  onRuntimeReady?: () => void
}

/** Stable cockpit map shell. AMap owns one basemap; only its overlays change. */
export function PersistentMapLayer({
  mode, sketch, progress, theme, sessionKey, routeKey = mode, mapRetryNonce = 0,
  follow = true, recenterNonce = 0, onManualInteraction, onRecenter, onRuntimeFailure, onRuntimeReady,
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
  const modeRef = useRef(mode)
  const sketchRef = useRef(sketch)
  const progressRef = useRef(progress)
  modeRef.current = mode
  sketchRef.current = sketch
  progressRef.current = progress
  const drawing = useMemo(() => mode === 'route' && sketch
    ? buildRouteSketchDrawing({ ...sketch, ...(progress === undefined ? {} : { progress }) }, ROUTE_MAP_DRAWING_OPTIONS)
    : undefined, [mode, progress, sketch])

  useEffect(() => {
    let cancelled = false
    const mount = container.current
    if (!mount) return
    setSource('loading')
    void loadAMap().then((amap) => {
      if (cancelled || !amap) {
        if (!cancelled) {
          setSource('fallback')
          failureCallback.current?.()
        }
        return
      }
      const rendered = renderAMapWorkspace(amap, mount, {
        mode: modeRef.current, sketch: sketchRef.current, progress: progressRef.current,
        theme: initialTheme.current,
        onManualInteraction: () => manualInteractionCallback.current?.(),
        onRuntimeFailure: () => {
          if (cancelled) return
          const current = handle.current
          handle.current = undefined
          current?.destroy()
          setSource('fallback')
          failureCallback.current?.()
          const keyCount = amapLoaderSnapshot().keyCount
          if (keyCount > 1) {
            invalidateAMap({ rotate: true })
            setLoadRevision((value) => value + 1)
          }
        },
      })
      if (cancelled) { rendered?.destroy(); return }
      if (!rendered) { setSource('fallback'); return }
      handle.current = rendered
      setSource('amap')
      readyCallback.current?.()
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
  }, [mode, routeKey, source])

  useEffect(() => {
    if (mode === 'route' && progress !== undefined) handle.current?.setProgress(progress)
  }, [mode, progress])

  useEffect(() => { handle.current?.setFollow(follow) }, [follow, source])
  useEffect(() => { if (recenterNonce > 0) handle.current?.recenter() }, [recenterNonce])

  return (
    <section className="persistent-map-layer" data-testid="persistent-map-layer" data-map-source={source} data-mode={mode} data-session-key={sessionKey} data-progress={mode === 'route' && progress !== undefined ? String(progress) : undefined} aria-label={mode === 'route' ? '模拟导航地图' : '座舱地图'}>
      <div ref={container} className="persistent-map-layer__basemap" data-active={source === 'amap'} aria-hidden="true" />
      <div className="persistent-map-layer__fallback" aria-hidden={source === 'amap'}>
        {drawing ? (
          <svg viewBox={`0 0 ${ROUTE_MAP_VIEWBOX.width} ${ROUTE_MAP_VIEWBOX.height}`} preserveAspectRatio="xMidYMid meet">
            <path className="persistent-map-layer__route" d={drawing.path} />
            {drawing.vehicle && <circle className="persistent-map-layer__vehicle" cx={drawing.vehicle.x} cy={drawing.vehicle.y} r="10" />}
          </svg>
        ) : (
          <><span className="persistent-map-layer__car"><span /></span><span className="persistent-map-layer__location">上海 · 人民广场</span></>
        )}
      </div>
      <span className="persistent-map-layer__source">
        {source === 'amap' ? '高德道路图层' : source === 'loading' ? '地图服务连接中' : '离线地图示意'}
        {mode === 'route' && progress !== undefined ? ` · 模拟行程进度 ${Math.round(progress * 100)}%` : ''}
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
    </section>
  )
}
