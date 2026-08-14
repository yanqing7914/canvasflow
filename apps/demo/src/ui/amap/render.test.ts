import { describe, expect, it, vi } from 'vitest'
import type { RouteSketch } from '@canvasflow/schema'
import type { AMapApi, AMapMarker, AMapPolyline } from './loader'
import { renderAMapPosition, renderAMapRoute, renderAMapWorkspace } from './render'

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
  /** Every path the traversed tail has been given, in order, starting with its
      constructor argument — so a test can see the tail grow rather than only
      where it ended up. */
  const tailPaths: Array<Array<[number, number]>> = []
  const markerPositions: Array<[number, number]> = []
  const destroy = vi.fn()
  const remove = vi.fn()
  const setCenter = vi.fn()
  const setZoomAndCenter = vi.fn()
  const setRotation = vi.fn()
  const setPitch = vi.fn()
  const setMapStyle = vi.fn()
  const map = {
    add: vi.fn(),
    remove,
    setFitView: vi.fn(),
    setZoomAndCenter,
    setCenter,
    setRotation,
    setPitch,
    setMapStyle,
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
      // The route line is built first and never moves; only the second polyline,
      // the traversed tail, is the one `setProgress` rewrites.
      const isTail = polylineOptions.length === 2
      if (isTail) tailPaths.push(options.path as Array<[number, number]>)
      return {
        setPath: (path: Array<[number, number]>) => { if (isTail) tailPaths.push(path) },
      } as unknown as AMapPolyline
    }
  }
  class Marker {
    constructor(options: Record<string, unknown>) {
      markerPositions.push(options.position as [number, number])
      return {
        setPosition: (position: [number, number]) => { markerPositions.push(position) },
      } as unknown as AMapMarker
    }
  }
  class LngLat {
    constructor(readonly lng: number, readonly lat: number) {}
  }

  return {
    amap: { Map, Driving, Polyline, Marker, LngLat } as unknown as AMapApi,
    map,
    destroy,
    mapOptions,
    markerPositions,
    polylineOptions,
    remove,
    setCenter,
    setZoomAndCenter,
    setMapStyle,
    setRotation,
    setPitch,
    tailPaths,
  }
}

describe('renderAMapWorkspace', () => {
  it('keeps one map while switching idle, outbound, return, and idle again', async () => {
    const fake = fakeAMap()
    const handle = renderAMapWorkspace(fake.amap, document.createElement('div'), {
      mode: 'idle', theme: 'dark',
    })
    const returning: RouteSketch = {
      waypoints: [...sketch.waypoints].reverse(),
      polyline: [...sketch.polyline].reverse(),
      progress: 0,
    }

    expect(handle).not.toBeNull()
    expect(fake.mapOptions).toHaveLength(1)
    expect(fake.markerPositions).toEqual([[121.4737, 31.2304]])

    await expect(handle?.setMode('route', sketch, 0.5)).resolves.toBe(true)
    await expect(handle?.setRoute(returning)).resolves.toBe(true)
    expect(fake.mapOptions).toHaveLength(1)
    expect(fake.destroy).not.toHaveBeenCalled()
    expect(fake.polylineOptions).toHaveLength(4)

    await expect(handle?.setMode('idle')).resolves.toBe(true)
    expect(fake.remove).toHaveBeenCalled()
    expect(fake.destroy).not.toHaveBeenCalled()

    handle?.destroy()
    expect(fake.destroy).toHaveBeenCalledOnce()
  })

  it('creates the route marker before the first simulator snapshot and then moves it', async () => {
    const fake = fakeAMap()
    const handle = renderAMapWorkspace(fake.amap, document.createElement('div'), {
      mode: 'idle', theme: 'dark',
    })!

    await expect(handle.setMode('route', sketch)).resolves.toBe(true)
    expect(fake.markerPositions).toHaveLength(2)

    handle.setProgress(0.6)
    expect(fake.markerPositions).toHaveLength(3)
    expect(fake.markerPositions[2]).not.toEqual(fake.markerPositions[1])
  })

  it('follows the vehicle at a road-level zoom and heading in driving camera mode', async () => {
    const fake = fakeAMap()
    const handle = renderAMapWorkspace(fake.amap, document.createElement('div'), {
      mode: 'idle', theme: 'light', cameraMode: 'driving',
    })!

    handle.setFollow(true)
    await expect(handle.setMode('route', sketch, 0.25)).resolves.toBe(true)
    expect(fake.mapOptions).toHaveLength(1)
    expect(fake.markerPositions).toHaveLength(2)
    expect(fake.setRotation).toHaveBeenCalled()
    expect(fake.setPitch).toHaveBeenCalledWith(58)
    expect(fake.setZoomAndCenter).toHaveBeenCalledWith(19, expect.any(Array))

    handle.setProgress(0.6)
    expect(fake.setCenter).toHaveBeenCalledWith(expect.any(Array), false)
  })

  it('updates basemap and route palette in place when the cockpit theme changes', async () => {
    const fake = fakeAMap()
    const handle = renderAMapWorkspace(fake.amap, document.createElement('div'), {
      mode: 'idle', theme: 'dark',
    })!
    await expect(handle.setMode('route', sketch, 0.5)).resolves.toBe(true)
    const routeCount = fake.polylineOptions.length

    handle.setTheme('light')

    expect(fake.mapOptions).toHaveLength(1)
    expect(fake.setMapStyle).toHaveBeenCalledWith('amap://styles/normal')
    expect(fake.polylineOptions).toHaveLength(routeCount + 2)
    expect(fake.polylineOptions.slice(-2).map((options) => options.strokeColor)).toEqual(['#246bfd', '#9aa7b8'])
    expect(fake.destroy).not.toHaveBeenCalled()
  })

  it('ignores an obsolete route response after returning to idle', async () => {
    const fake = fakeAMap()
    let complete: ((status: string, result: unknown) => void) | undefined
    fake.amap.Driving = class {
      search(
        _origin: unknown,
        _destination: unknown,
        _options: { waypoints?: unknown[] },
        callback: (status: string, result: unknown) => void,
      ) { complete = callback }
    } as unknown as AMapApi['Driving']
    const handle = renderAMapWorkspace(fake.amap, document.createElement('div'), {
      mode: 'idle', theme: 'light',
    })!

    const pending = handle.setRoute(sketch)
    await expect(handle.setMode('idle')).resolves.toBe(true)
    complete?.('complete', {
      routes: [{ steps: [{ path: [{ lng: 121.47, lat: 31.23 }, { lng: 121.336, lat: 31.198 }] }] }],
    })

    await expect(pending).resolves.toBe(false)
    expect(fake.polylineOptions).toHaveLength(0)
    expect(fake.destroy).not.toHaveBeenCalled()
  })
})

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

describe('renderAMapPosition', () => {
  it('renders one fixed vehicle without requesting a route and cleans it up', () => {
    const fake = fakeAMap()
    const handle = renderAMapPosition(fake.amap, document.createElement('div'), {
      position: { latitude: 31.2304, longitude: 121.4737 }, theme: 'dark',
    })
    expect(handle).not.toBeNull()
    expect(fake.markerPositions).toEqual([[121.4737, 31.2304]])
    expect(fake.polylineOptions).toHaveLength(0)
    handle?.destroy()
    expect(fake.remove).toHaveBeenCalledOnce()
    expect(fake.destroy).toHaveBeenCalledOnce()
  })
})

describe('renderAMapRoute runtime failures', () => {
  it('signals a Map constructor failure while preserving the null fallback', async () => {
    const onRuntimeFailure = vi.fn()
    const broken = {
      Map: class { constructor() { throw new Error('map failed') } },
    } as unknown as AMapApi

    await expect(renderAMapRoute(broken, document.createElement('div'), {
      sketch,
      mode: 'follow',
      theme: 'light',
      onRuntimeFailure,
    })).resolves.toBeNull()
    expect(onRuntimeFailure).toHaveBeenCalledOnce()
  })

  it.each(['constructor', 'search', 'status'] as const)(
    'signals a Driving %s failure once and tears down the partial map',
    async (failure) => {
      const fake = fakeAMap()
      const onRuntimeFailure = vi.fn()
      fake.amap.Driving = class {
        constructor() {
          if (failure === 'constructor') throw new Error('driving failed')
        }
        search(
          _origin: unknown,
          _destination: unknown,
          _options: { waypoints?: unknown[] },
          callback: (status: string, result: unknown) => void,
        ) {
          if (failure === 'search') throw new Error('search failed')
          callback('error', {})
        }
      } as unknown as AMapApi['Driving']

      await expect(renderAMapRoute(fake.amap, document.createElement('div'), {
        sketch,
        mode: 'follow',
        theme: 'light',
        onRuntimeFailure,
      })).resolves.toBeNull()
      expect(onRuntimeFailure).toHaveBeenCalledOnce()
      expect(fake.destroy).toHaveBeenCalledOnce()
    },
  )

  it('signals a later route-search failure without destroying the working map', async () => {
    const fake = fakeAMap()
    const onRuntimeFailure = vi.fn()
    const handle = await renderAMapRoute(fake.amap, document.createElement('div'), {
      sketch,
      mode: 'follow',
      theme: 'light',
      onRuntimeFailure,
    })
    fake.amap.Driving = class {
      search(
        _origin: unknown,
        _destination: unknown,
        _options: { waypoints?: unknown[] },
        callback: (status: string, result: unknown) => void,
      ) { callback('error', {}) }
    } as unknown as AMapApi['Driving']

    await expect(handle?.setRoute(sketch)).resolves.toBe(false)
    expect(onRuntimeFailure).toHaveBeenCalledOnce()
    expect(fake.destroy).not.toHaveBeenCalled()
  })
})

/**
 * `setProgress` is the whole of the crawl's reach into the map.
 *
 * It moves a marker and rewrites a tail on geometry that is already drawn; it
 * starts nothing, schedules nothing, and holds no position of its own. These
 * tests pin that: the same call twice with the same value is the same result,
 * and a route with no marker to move accepts the call and does nothing.
 */
describe('renderAMapRoute progress', () => {
  async function rendered(routeSketch: RouteSketch = sketch) {
    const fake = fakeAMap()
    const handle = await renderAMapRoute(fake.amap, document.createElement('div'), {
      sketch: routeSketch,
      mode: 'follow',
      theme: 'light',
    })
    return { fake, handle: handle! }
  }

  it('moves the marker and grows the traversed tail together', async () => {
    const { fake, handle } = await rendered()
    const startedAt = fake.markerPositions.at(-1)!
    const tailAtStart = fake.tailPaths.at(-1)!

    handle.setProgress(0.9)

    const movedTo = fake.markerPositions.at(-1)!
    const tailAfter = fake.tailPaths.at(-1)!
    expect(movedTo).not.toEqual(startedAt)
    // Further along the route means further west and south on this geometry.
    expect(movedTo[0]).toBeLessThan(startedAt[0])
    expect(tailAfter.length).toBeGreaterThanOrEqual(tailAtStart.length)
    expect(tailAfter.at(-1)).toEqual(movedTo)
  })

  it('places the marker exactly at the ends of the route', async () => {
    const { fake, handle } = await rendered()

    handle.setProgress(0)
    expect(fake.markerPositions.at(-1)).toEqual([121.47, 31.23])

    handle.setProgress(1)
    expect(fake.markerPositions.at(-1)).toEqual([121.336, 31.198])
  })

  it('replaces route overlays without destroying the basemap', async () => {
    const { fake, handle } = await rendered()
    const reverse: RouteSketch = {
      waypoints: [...sketch.waypoints].reverse(), polyline: [...sketch.polyline].reverse(), progress: 0,
    }
    await expect(handle.setRoute(reverse)).resolves.toBe(true)
    expect(fake.remove).toHaveBeenCalled()
    expect(fake.destroy).not.toHaveBeenCalled()
    handle.setProgress(0.5)
    expect(fake.markerPositions.length).toBeGreaterThan(2)
  })

  it('ignores a value that is not a position on the route', async () => {
    const { fake, handle } = await rendered()
    const before = fake.markerPositions.length

    handle.setProgress(1.5)
    handle.setProgress(-0.2)
    handle.setProgress(Number.NaN)

    expect(fake.markerPositions).toHaveLength(before)
  })

  it('is a no-op on a route the spec staged no marker for', async () => {
    // Rebuilt rather than spread-and-omitted so the absent `progress` is the
    // point of the fixture rather than a detail of how it was derived.
    const withoutProgress: RouteSketch = { waypoints: sketch.waypoints, polyline: sketch.polyline }
    const { fake, handle } = await rendered(withoutProgress)

    expect(fake.markerPositions).toHaveLength(0)
    expect(() => handle.setProgress(0.5)).not.toThrow()
    expect(fake.markerPositions).toHaveLength(0)
  })
})
