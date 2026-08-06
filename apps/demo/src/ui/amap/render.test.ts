import { describe, expect, it, vi } from 'vitest'
import type { RouteSketch } from '@canvasflow/schema'
import type { AMapApi, AMapOverlay } from './loader'
import { renderAMapRoute } from './render'

const sketch: RouteSketch = {
  waypoints: [
    { id: 'origin', name: '出发地', latitude: 31.23, longitude: 121.47 },
    { id: 'destination', name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
  ],
  polyline: [
    { latitude: 31.23, longitude: 121.47 },
    { latitude: 31.21, longitude: 121.38 },
    { latitude: 31.198, longitude: 121.336 },
  ],
  progress: 0.5,
}

function fakeAMap() {
  const mapOptions: Array<Record<string, unknown> | undefined> = []
  const polylineOptions: Array<Record<string, unknown>> = []
  const destroy = vi.fn()
  const remove = vi.fn()
  const map = {
    add: vi.fn(),
    remove,
    setFitView: vi.fn(),
    setZoomAndCenter: vi.fn(),
    destroy,
  }

  class Map {
    constructor(_container: HTMLElement, options?: Record<string, unknown>) {
      mapOptions.push(options)
      return map
    }
  }
  class Driving {
    search(
      _origin: unknown,
      _destination: unknown,
      _options: { waypoints?: unknown[] },
      callback: (status: string, result: unknown) => void,
    ) {
      callback('complete', {
        routes: [{ steps: [{ path: [{ lng: 121.47, lat: 31.23 }, { lng: 121.38, lat: 31.21 }, { lng: 121.336, lat: 31.198 }] }] }],
      })
    }
  }
  class Polyline {
    constructor(options: Record<string, unknown>) {
      polylineOptions.push(options)
      return {} as AMapOverlay
    }
  }
  class Marker {
    constructor(options: Record<string, unknown>) {
      void options
      return {} as AMapOverlay
    }
  }
  class LngLat {
    constructor(readonly lng: number, readonly lat: number) {}
  }

  return {
    amap: { Map, Driving, Polyline, Marker, LngLat } as unknown as AMapApi,
    destroy,
    mapOptions,
    polylineOptions,
    remove,
  }
}

describe('renderAMapRoute themes', () => {
  it.each([
    ['light', undefined, '#246bfd', '#9aa7b8'],
    ['dark', 'amap://styles/dark', '#5b93ff', '#55637a'],
  ] as const)('renders the %s basemap and route palette', async (theme, mapStyle, route, traversed) => {
    const fake = fakeAMap()
    const handle = await renderAMapRoute(fake.amap, document.createElement('div'), {
      sketch,
      mode: 'follow',
      theme,
    })

    expect(handle).not.toBeNull()
    expect(fake.mapOptions).toEqual([
      mapStyle ? { zoom: 12, mapStyle } : { zoom: 12 },
    ])
    expect(fake.polylineOptions.map((options) => options.strokeColor)).toEqual([route, traversed])

    handle?.destroy()
    expect(fake.remove).toHaveBeenCalled()
    expect(fake.destroy).toHaveBeenCalledOnce()
  })
})
