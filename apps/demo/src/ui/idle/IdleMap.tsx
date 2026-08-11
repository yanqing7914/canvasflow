import { useEffect, useRef, useState } from 'react'
import { amapLoaderSnapshot, invalidateAMap, loadAMap, subscribeAMapLoader } from '../amap/loader'
import { renderAMapPosition, type AMapPositionHandle } from '../amap/render'

export const PEOPLES_SQUARE = { latitude: 31.2304, longitude: 121.4737 } as const

export function IdleMap({ retryNonce = 0, onRuntimeFailure }: { retryNonce?: number; onRuntimeFailure?: () => void }) {
  const container = useRef<HTMLDivElement>(null)
  const handle = useRef<AMapPositionHandle | undefined>(undefined)
  const [source, setSource] = useState<'loading' | 'amap' | 'unavailable'>('loading')
  const [loadRevision, setLoadRevision] = useState(0)
  const runtimeAttempts = useRef(0)
  const onRuntimeFailureRef = useRef(onRuntimeFailure)
  onRuntimeFailureRef.current = onRuntimeFailure
  useEffect(() => subscribeAMapLoader((snapshot) => {
    if (snapshot.state === 'loading') setLoadRevision((current) => current + 1)
  }), [])
  useEffect(() => {
    let cancelled = false
    const mount = container.current
    if (!mount) return
    void loadAMap().then((amap) => {
      if (cancelled) return
      if (!amap) {
        setSource('unavailable')
        onRuntimeFailureRef.current?.()
        return
      }
      const rendered = renderAMapPosition(amap, mount, { position: PEOPLES_SQUARE, theme: 'dark' })
      if (!rendered) {
        const keyCount = amapLoaderSnapshot().keyCount
        invalidateAMap({ rotate: true })
        setSource('unavailable')
        onRuntimeFailureRef.current?.()
        if (runtimeAttempts.current < Math.max(0, keyCount - 1)) {
          runtimeAttempts.current += 1
          setLoadRevision((current) => current + 1)
        }
        return
      }
      runtimeAttempts.current = 0
      handle.current = rendered
      setSource('amap')
    })
    return () => {
      cancelled = true
      handle.current?.destroy()
      handle.current = undefined
    }
  }, [loadRevision, retryNonce])
  return (
    <div className="idle-map" data-map-source={source} aria-label="人民广场模拟车辆位置">
      <div ref={container} className="idle-map__basemap" data-active={source === 'amap'} aria-hidden="true" />
      <div className="idle-map__fallback" aria-hidden={source === 'amap'}>
        <span className="idle-map__car"><span /></span>
      </div>
      <p className="idle-map__source">
        {source === 'amap' ? '高德地图' : source === 'loading' ? '地图服务连接中' : '地图服务暂时不可用，等待恢复'}
        <strong>模拟位置，非真实 GPS</strong>
      </p>
    </div>
  )
}
