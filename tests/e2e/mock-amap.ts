import type { Page } from '@playwright/test'

export type MockAMapSnapshot = {
  mapCreates: number
  mapDestroys: number
  centers: Array<[number, number]>
  markerPositions: Array<[number, number]>
  markerAngles: number[]
  events: string[]
}

/**
 * Installs the small AMap surface the cockpit uses. The route follows named
 * Shanghai roads but stays deterministic and never touches the network.
 */
export async function installMockAMap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Point = [number, number]
    const snapshot = {
      mapCreates: 0,
      mapDestroys: 0,
      centers: [] as Point[],
      markerPositions: [] as Point[],
      markerAngles: [] as number[],
      events: [] as string[],
    }
    const listeners = new Map<string, Set<() => void>>()
    const routeSteps = [
      {
        road: '延安西路',
        instruction: '沿延安西路向西直行',
        path: [
          { lng: 121.455, lat: 31.225 },
          { lng: 121.425, lat: 31.222 },
          { lng: 121.395, lat: 31.218 },
        ],
      },
      {
        road: '内环高架',
        instruction: '右转进入内环高架',
        path: [
          { lng: 121.395, lat: 31.218 },
          { lng: 121.365, lat: 31.213 },
          { lng: 121.335, lat: 31.208 },
        ],
      },
      {
        road: '虹桥路',
        instruction: '沿虹桥路驶向机场接人点',
        path: [
          { lng: 121.335, lat: 31.208 },
          { lng: 121.305, lat: 31.202 },
          { lng: 121.285, lat: 31.196 },
        ],
      },
    ]

    class MockMap {
      constructor(container: HTMLElement) {
        snapshot.mapCreates += 1
        container.dataset.mockAmap = 'ready'
      }
      add() {}
      remove() {}
      setFitView() {}
      setCenter(center: Point) { snapshot.centers.push(center) }
      setZoomAndCenter(_zoom: number, center: Point) { snapshot.centers.push(center) }
      on(type: string, listener: () => void) {
        const set = listeners.get(type) ?? new Set<() => void>()
        set.add(listener)
        listeners.set(type, set)
      }
      off(type: string, listener: () => void) { listeners.get(type)?.delete(listener) }
      resize() {}
      destroy() { snapshot.mapDestroys += 1 }
    }

    class MockDriving {
      search(
        _origin: unknown,
        _destination: unknown,
        _options: unknown,
        callback: (status: string, result: unknown) => void,
      ) {
        queueMicrotask(() => callback('complete', { routes: [{ steps: routeSteps }] }))
      }
    }

    class MockPolyline {
      constructor(_options: unknown) {}
      setPath(_path: Point[]) {}
    }

    class MockMarker {
      constructor(options: { position?: Point; angle?: number }) {
        if (options.position) snapshot.markerPositions.push(options.position)
        if (typeof options.angle === 'number') snapshot.markerAngles.push(options.angle)
      }
      setPosition(position: Point) { snapshot.markerPositions.push(position) }
      setAngle(angle: number) { snapshot.markerAngles.push(angle) }
      setContent(_content: string | HTMLElement) {}
    }

    class MockLngLat {
      constructor(readonly lng: number, readonly lat: number) {}
      getLng() { return this.lng }
      getLat() { return this.lat }
    }

    Object.assign(window, {
      AMap: {
        Map: MockMap,
        Driving: MockDriving,
        Polyline: MockPolyline,
        Marker: MockMarker,
        LngLat: MockLngLat,
      },
      __canvasflowMockAMap: {
        snapshot: () => structuredClone(snapshot),
        emit: (type: string) => {
          snapshot.events.push(type)
          for (const listener of listeners.get(type) ?? []) listener()
        },
      },
    })
  })
}

export async function mockAMapSnapshot(page: Page): Promise<MockAMapSnapshot> {
  return page.evaluate(() => {
    const api = (window as typeof window & {
      __canvasflowMockAMap?: { snapshot: () => MockAMapSnapshot }
    }).__canvasflowMockAMap
    if (!api) throw new Error('mock AMap was not installed')
    return api.snapshot()
  })
}

export async function emitMockAMapInteraction(page: Page, type: 'dragstart' | 'zoomstart'): Promise<void> {
  await page.evaluate((eventType) => {
    const api = (window as typeof window & {
      __canvasflowMockAMap?: { emit: (type: string) => void }
    }).__canvasflowMockAMap
    if (!api) throw new Error('mock AMap was not installed')
    api.emit(eventType)
  }, type)
}
