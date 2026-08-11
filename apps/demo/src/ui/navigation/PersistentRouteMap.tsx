import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RouteSketch } from '@canvasflow/schema'
import { amapLoaderSnapshot, invalidateAMap, loadAMap } from '../amap/loader'
import { renderAMapRoute, type AMapRouteHandle } from '../amap/render'
import { ROUTE_MAP_DRAWING_OPTIONS, ROUTE_MAP_VIEWBOX, buildRouteSketchDrawing } from '../route-sketch'
import { pointAtProgress, segmentLengths } from '../route-sketch'

export type PersistentRouteMapProps = {
  sessionKey: string
  routeKey: string
  destination: string
  progress: number
  sketch: RouteSketch
  theme: 'light' | 'dark'
  progressLabel?: string
  mapRetryNonce?: number
  onRuntimeFailure?: () => void
  onRuntimeReady?: () => void
}

export function PersistentRouteMap({ sessionKey, routeKey, destination, progress, sketch, theme, progressLabel, mapRetryNonce = 0, onRuntimeFailure, onRuntimeReady }: PersistentRouteMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const handle = useRef<AMapRouteHandle | undefined>(undefined)
  const initialTheme = useRef(theme)
  const sketchRef = useRef(sketch)
  const progressRef = useRef(progress)
  sketchRef.current = sketch
  progressRef.current = progress
  const [source, setSource] = useState<'sketch' | 'amap'>('sketch')
  const [runtimeFailure, setRuntimeFailure] = useState(false)
  const [runtimeReload, setRuntimeReload] = useState(0)
  const runtimeAttempts = useRef(0)
  const runtimeFailureSerial = useRef(0)
  const onRuntimeFailureRef = useRef(onRuntimeFailure)
  onRuntimeFailureRef.current = onRuntimeFailure
  const onRuntimeReadyRef = useRef(onRuntimeReady)
  onRuntimeReadyRef.current = onRuntimeReady
  const [following, setFollowing] = useState(true)
  const drawing = useMemo(() => buildRouteSketchDrawing(
    { ...sketch, progress }, ROUTE_MAP_DRAWING_OPTIONS,
  ), [progress, sketch])
  const heading = useMemo(() => headingAtProgress(sketch, progress), [progress, sketch])

  const recoverRuntime = useCallback(() => {
    runtimeFailureSerial.current += 1
    const failedHandle = handle.current
    handle.current = undefined
    failedHandle?.destroy()
    const keyCount = amapLoaderSnapshot().keyCount
    invalidateAMap({ rotate: true })
    setRuntimeFailure(true)
    setSource('sketch')
    onRuntimeFailureRef.current?.()
    if (runtimeAttempts.current < Math.max(0, keyCount - 1)) {
      runtimeAttempts.current += 1
      setRuntimeReload((current) => current + 1)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadFailureSerial = runtimeFailureSerial.current
    const mount = container.current
    if (!mount) return
    void loadAMap().then(async (amap) => {
      if (!amap || cancelled) {
        if (!cancelled) {
          setRuntimeFailure(true)
          onRuntimeFailureRef.current?.()
        }
        return
      }
      const rendered = await renderAMapRoute(amap, mount, {
        sketch: { ...sketchRef.current, progress: progressRef.current }, mode: 'follow', theme: initialTheme.current,
        onManualInteraction: () => setFollowing(false),
        onRuntimeFailure: recoverRuntime,
      })
      if (cancelled || loadFailureSerial !== runtimeFailureSerial.current) {
        rendered?.destroy()
        return
      }
      if (!rendered) return
      handle.current = rendered
      runtimeAttempts.current = 0
      setRuntimeFailure(false)
      setSource('amap')
      onRuntimeReadyRef.current?.()
    })
    return () => {
      cancelled = true
      handle.current?.destroy()
      handle.current = undefined
      setSource('sketch')
    }
    // The task session owns the map. Only a leg/route replacement can replace
    // its route overlays; HUD, UISpec revisions and window changes never remount it.
  }, [mapRetryNonce, recoverRuntime, runtimeReload, sessionKey])

  useEffect(() => { handle.current?.setProgress(progress) }, [progress])

  useEffect(() => {
    const routeHandle = handle.current
    if (!routeHandle) return
    let cancelled = false
    const failureSerial = runtimeFailureSerial.current
    void routeHandle.setRoute({ ...sketchRef.current, progress: progressRef.current }).then((replaced) => {
      if (cancelled || replaced) return
      // renderAMapRoute normally reports the failure before resolving false.
      // Only recover here when an implementation returns false silently, so one
      // failed replacement consumes exactly one key and one retry slot.
      if (runtimeFailureSerial.current === failureSerial) recoverRuntime()
    })
    return () => { cancelled = true }
  }, [recoverRuntime, routeKey])

  function recenter() {
    setFollowing(true)
    handle.current?.setFollow(true)
    handle.current?.recenter()
  }

  return (
    <section className="persistent-route-map" data-map-source={source} data-following={following} aria-label="模拟导航地图">
      <div ref={container} className="persistent-route-map__basemap" data-active={source === 'amap'} aria-hidden="true" />
      {drawing && (
        <svg className="persistent-route-map__fallback" viewBox={`0 0 ${ROUTE_MAP_VIEWBOX.width} ${ROUTE_MAP_VIEWBOX.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`前往${destination}的路线示意`}>
          <path className="persistent-route-map__route" d={drawing.path} />
          {drawing.markers.map((marker) => (
            <g key={marker.key} className="persistent-route-map__stop" data-role={marker.role}>
              <circle cx={marker.x} cy={marker.y} r={marker.role === 'destination' ? 8 : 5} />
              <text x={marker.x} y={marker.y - 16} textAnchor="middle">{marker.name}</text>
            </g>
          ))}
          {drawing.vehicle && (
            <g className="persistent-route-map__vehicle" transform={`translate(${drawing.vehicle.x} ${drawing.vehicle.y}) rotate(${heading})`}>
              <circle className="persistent-route-map__vehicle-halo" r="17" />
              <path d="M0 -12 L8 9 L0 5 L-8 9 Z" />
            </g>
          )}
        </svg>
      )}
      <div className="persistent-route-map__source">
        {progressLabel && <span>{progressLabel}</span>}
        <span>{source === 'amap' ? '道路导航 · 高德地图' : runtimeFailure ? '地图服务暂时不可用 · 模拟已暂停' : '离线路线示意 · 降级展示'}</span>
        <strong>模拟位置，非真实 GPS</strong>
      </div>
      {!following && (
        <button className="persistent-route-map__recenter" type="button" onClick={recenter}>回到车辆位置</button>
      )}
    </section>
  )
}

function headingAtProgress(sketch: RouteSketch, progress: number): number {
  const points = sketch.polyline.map((point) => ({ x: point.longitude, y: -point.latitude }))
  const lengths = segmentLengths(points)
  if (!lengths.some((length) => length > 0)) return 0
  const before = pointAtProgress(points, lengths, Math.max(0, progress - 0.002))
  const after = pointAtProgress(points, lengths, Math.min(1, progress + 0.002))
  return Math.atan2(after.x - before.x, -(after.y - before.y)) * 180 / Math.PI
}
