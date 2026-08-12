import type { RouteSketch } from '@canvasflow/schema'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersistentMapLayer } from './PersistentMapLayer'

const stub = vi.hoisted(() => ({
  loadAMap: vi.fn(),
  renderAMapWorkspace: vi.fn(),
}))

vi.mock('../amap/loader', () => ({
  amapLoaderSnapshot: () => ({ state: 'ready', keyCount: 1, keyIndex: 0 }),
  invalidateAMap: vi.fn(),
  loadAMap: () => stub.loadAMap(),
}))

vi.mock('../amap/render', () => ({
  renderAMapWorkspace: (...args: unknown[]) => stub.renderAMapWorkspace(...args),
}))

const outbound: RouteSketch = {
  waypoints: [
    { name: '人民广场', latitude: 31.2304, longitude: 121.4737 },
    { name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
  ],
  polyline: [
    { latitude: 31.2304, longitude: 121.4737 },
    { latitude: 31.198, longitude: 121.336 },
  ],
}

const returning: RouteSketch = {
  waypoints: [...outbound.waypoints].reverse(),
  polyline: [...outbound.polyline].reverse(),
}

function workspaceHandle() {
  return {
    setMode: vi.fn(async () => true),
    setRoute: vi.fn(async () => true),
    setProgress: vi.fn(),
    setFollow: vi.fn(),
    recenter: vi.fn(),
    destroy: vi.fn(),
  }
}

describe('PersistentMapLayer', () => {
  beforeEach(() => {
    stub.loadAMap.mockReset()
    stub.loadAMap.mockResolvedValue({})
    stub.renderAMapWorkspace.mockReset()
  })
  afterEach(() => cleanup())

  it('keeps the same DOM and AMap handle through the complete cockpit lifecycle', async () => {
    const handle = workspaceHandle()
    stub.renderAMapWorkspace.mockReturnValue(handle)
    const view = render(<PersistentMapLayer mode="idle" theme="dark" sessionKey="cockpit" />)
    await act(async () => {})
    const layer = view.getByTestId('persistent-map-layer')
    expect(stub.renderAMapWorkspace).toHaveBeenCalledOnce()

    view.rerender(<PersistentMapLayer mode="route" sketch={outbound} progress={0} routeKey="outbound" theme="dark" sessionKey="cockpit" />)
    await act(async () => {})
    view.rerender(<PersistentMapLayer mode="route" sketch={returning} progress={0.2} routeKey="return" theme="dark" sessionKey="cockpit" />)
    await act(async () => {})
    view.rerender(<PersistentMapLayer mode="idle" theme="dark" sessionKey="cockpit" />)
    await act(async () => {})

    expect(view.getByTestId('persistent-map-layer')).toBe(layer)
    expect(stub.renderAMapWorkspace).toHaveBeenCalledOnce()
    expect(handle.destroy).not.toHaveBeenCalled()
    expect(handle.setMode).toHaveBeenCalledWith('route', outbound, 0)
    expect(handle.setMode).toHaveBeenCalledWith('route', returning, 0.2)
    expect(handle.setMode).toHaveBeenLastCalledWith('idle')

    view.unmount()
    expect(handle.destroy).toHaveBeenCalledOnce()
  })

  it('moves fallback progress without rebuilding the map or route', async () => {
    const handle = workspaceHandle()
    stub.renderAMapWorkspace.mockReturnValue(handle)
    const view = render(<PersistentMapLayer mode="route" sketch={outbound} progress={0.1} routeKey="outbound" theme="dark" sessionKey="cockpit" />)
    await act(async () => {})
    const fallbackVehicle = view.container.querySelector('.persistent-map-layer__vehicle')
    const startX = fallbackVehicle?.getAttribute('cx')

    view.rerender(<PersistentMapLayer mode="route" sketch={outbound} progress={0.7} routeKey="outbound" theme="dark" sessionKey="cockpit" />)

    expect(stub.renderAMapWorkspace).toHaveBeenCalledOnce()
    expect(handle.setMode).toHaveBeenCalledTimes(1)
    expect(handle.setProgress).toHaveBeenLastCalledWith(0.7)
    expect(view.container.querySelector('.persistent-map-layer__vehicle')?.getAttribute('cx')).not.toBe(startX)
  })
})
