import type { RouteSketch } from '@canvasflow/schema'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersistentRouteMap } from './PersistentRouteMap'

const stub = vi.hoisted(() => ({
  keyCount: 2,
  loadAMap: vi.fn(),
  invalidateAMap: vi.fn(),
  renderAMapRoute: vi.fn(),
}))

vi.mock('../amap/loader', () => ({
  amapLoaderSnapshot: () => ({ state: 'ready', keyCount: stub.keyCount, keyIndex: 0 }),
  invalidateAMap: (options?: { rotate?: boolean }) => stub.invalidateAMap(options),
  loadAMap: () => stub.loadAMap(),
}))

vi.mock('../amap/render', () => ({
  renderAMapRoute: (...args: unknown[]) => stub.renderAMapRoute(...args),
}))

const outbound: RouteSketch = {
  waypoints: [
    { name: '当前位置', latitude: 31.2304, longitude: 121.4737 },
    { name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
  ],
  polyline: [
    { latitude: 31.2304, longitude: 121.4737 },
    { latitude: 31.198, longitude: 121.336 },
  ],
}

const returning: RouteSketch = {
  waypoints: [
    { name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
    { name: '家', latitude: 31.2304, longitude: 121.4737 },
  ],
  polyline: [...outbound.polyline].reverse(),
}

function routeHandle(setRoute = vi.fn(async () => true)) {
  return {
    setProgress: vi.fn(),
    setRoute,
    setFollow: vi.fn(),
    recenter: vi.fn(),
    destroy: vi.fn(),
  }
}

describe('PersistentRouteMap route replacement recovery', () => {
  beforeEach(() => {
    stub.keyCount = 2
    stub.loadAMap.mockReset()
    stub.loadAMap.mockResolvedValue({})
    stub.invalidateAMap.mockReset()
    stub.renderAMapRoute.mockReset()
  })

  afterEach(() => cleanup())

  it('keeps the offline simulation available when AMap cannot load', async () => {
    stub.loadAMap.mockResolvedValue(undefined)
    const onRuntimeFailure = vi.fn()

    const view = render(
      <PersistentRouteMap
        sessionKey="cockpit-1"
        routeKey="outbound:route-1"
        destination="虹桥机场 T2"
        progress={0.25}
        sketch={outbound}
        theme="dark"
        onRuntimeFailure={onRuntimeFailure}
      />,
    )
    await act(async () => {})

    expect(onRuntimeFailure).toHaveBeenCalledOnce()
    expect(view.getByLabelText('模拟导航地图')).toHaveAttribute('data-map-source', 'sketch')
    expect(view.getByText('地图服务暂时不可用 · 离线模拟继续')).toBeInTheDocument()
  })

  it('recovers a failed return-route replacement with the next key without remounting the session', async () => {
    let reportRuntimeFailure: (() => void) | undefined
    const failedSetRoute = vi.fn(async () => {
      // renderAMapRoute reports the same runtime failure before resolving false.
      // The map owner must coalesce both signals into one key rotation.
      reportRuntimeFailure?.()
      return false
    })
    const outboundHandle = routeHandle(failedSetRoute)
    const returnHandle = routeHandle()
    stub.renderAMapRoute
      .mockImplementationOnce(async (...args: unknown[]) => {
        reportRuntimeFailure = (args[2] as { onRuntimeFailure?: () => void }).onRuntimeFailure
        return outboundHandle
      })
      .mockResolvedValueOnce(returnHandle)
    const onRuntimeFailure = vi.fn()
    const onRuntimeReady = vi.fn()

    const view = render(
      <PersistentRouteMap
        sessionKey="cockpit-1"
        routeKey="outbound:route-1"
        destination="虹桥机场 T2"
        progress={0.9}
        sketch={outbound}
        theme="dark"
        onRuntimeFailure={onRuntimeFailure}
        onRuntimeReady={onRuntimeReady}
      />,
    )
    await act(async () => {})
    const mountedSession = view.getByLabelText('模拟导航地图')
    expect(mountedSession).toHaveAttribute('data-map-source', 'amap')

    view.rerender(
      <PersistentRouteMap
        sessionKey="cockpit-1"
        routeKey="return:route-2"
        destination="家"
        progress={0}
        sketch={returning}
        theme="dark"
        onRuntimeFailure={onRuntimeFailure}
        onRuntimeReady={onRuntimeReady}
      />,
    )
    await act(async () => {})
    await act(async () => {})

    expect(view.getByLabelText('模拟导航地图')).toBe(mountedSession)
    expect(failedSetRoute).toHaveBeenCalledOnce()
    expect(outboundHandle.destroy).toHaveBeenCalledOnce()
    expect(stub.invalidateAMap).toHaveBeenCalledOnce()
    expect(stub.invalidateAMap).toHaveBeenCalledWith({ rotate: true })
    expect(stub.loadAMap).toHaveBeenCalledTimes(2)
    expect(stub.renderAMapRoute).toHaveBeenCalledTimes(2)
    expect(onRuntimeFailure).toHaveBeenCalledOnce()
    expect(onRuntimeReady).toHaveBeenCalledTimes(2)
    expect(mountedSession).toHaveAttribute('data-map-source', 'amap')
  })

  it('stops on the sketch after the replacement and every remaining key fail', async () => {
    let reportRuntimeFailure: (() => void) | undefined
    const outboundHandle = routeHandle(vi.fn(async () => {
      reportRuntimeFailure?.()
      return false
    }))
    stub.renderAMapRoute
      .mockImplementationOnce(async (...args: unknown[]) => {
        reportRuntimeFailure = (args[2] as { onRuntimeFailure?: () => void }).onRuntimeFailure
        return outboundHandle
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const onFailure = (args[2] as { onRuntimeFailure?: () => void }).onRuntimeFailure
        onFailure?.()
        return null
      })

    const view = render(
      <PersistentRouteMap
        sessionKey="cockpit-1"
        routeKey="outbound:route-1"
        destination="虹桥机场 T2"
        progress={0.9}
        sketch={outbound}
        theme="dark"
      />,
    )
    await act(async () => {})

    view.rerender(
      <PersistentRouteMap
        sessionKey="cockpit-1"
        routeKey="return:route-2"
        destination="家"
        progress={0}
        sketch={returning}
        theme="dark"
      />,
    )
    await act(async () => {})
    await act(async () => {})

    expect(stub.invalidateAMap).toHaveBeenCalledTimes(2)
    expect(stub.loadAMap).toHaveBeenCalledTimes(2)
    expect(stub.renderAMapRoute).toHaveBeenCalledTimes(2)
    expect(view.getByLabelText('模拟导航地图')).toHaveAttribute('data-map-source', 'sketch')
    expect(view.container.querySelector('.persistent-route-map__basemap')).toHaveAttribute('data-active', 'false')
  })
})
