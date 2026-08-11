import type { Page } from '@playwright/test'

export type MockAMapSnapshot = {
  mapCreates: number
  mapDestroys: number
  routeSearches: Array<{
    origin: [number, number]
    destination: [number, number]
  }>
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
    type MockOverlay = { mount?: (map: MockMap) => void; remove?: () => void }
    const SVG_NS = 'http://www.w3.org/2000/svg'
    const snapshot = {
      mapCreates: 0,
      mapDestroys: 0,
      routeSearches: [] as Array<{ origin: Point; destination: Point }>,
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
    const returnSteps = [...routeSteps].reverse().map((step) => ({
      ...step,
      path: [...step.path].reverse(),
    }))

    function point(value: unknown): Point {
      if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
        return [value[0], value[1]]
      }
      const candidate = value as { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number }
      const lng = typeof candidate?.getLng === 'function' ? candidate.getLng() : candidate?.lng
      const lat = typeof candidate?.getLat === 'function' ? candidate.getLat() : candidate?.lat
      if (typeof lng !== 'number' || typeof lat !== 'number') throw new TypeError('invalid mock AMap point')
      return [lng, lat]
    }

    function svgElement(name: string, attributes: Record<string, string>) {
      const element = document.createElementNS(SVG_NS, name)
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
      return element
    }

    function project([lng, lat]: Point): Point {
      const x = 70 + (lng - 121.27) / 0.2 * 860
      const y = 70 + (31.235 - lat) / 0.05 * 480
      return [x, y]
    }

    class MockMap {
      readonly overlays = svgElement('g', { 'data-layer': 'route-overlays' })
      readonly container: HTMLElement

      constructor(container: HTMLElement) {
        snapshot.mapCreates += 1
        this.container = container
        container.replaceChildren()
        container.dataset.mockAmap = 'ready'
        container.style.background = '#09111b'

        const map = svgElement('svg', {
          viewBox: '0 0 1000 620', width: '100%', height: '100%',
          preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true',
        })
        map.style.display = 'block'
        map.append(svgElement('rect', { width: '1000', height: '620', fill: '#0b1521' }))

        const blocks = svgElement('g', { fill: '#101e2b', stroke: '#162a3b', 'stroke-width': '1' })
        for (let row = 0; row < 5; row += 1) {
          for (let column = 0; column < 8; column += 1) {
            blocks.append(svgElement('rect', {
              x: String(48 + column * 122 + (row % 2) * 17), y: String(38 + row * 116),
              width: '82', height: '72', rx: '10',
            }))
          }
        }
        map.append(blocks)

        const roads = svgElement('g', { fill: 'none', 'stroke-linecap': 'round' })
        const roadPaths = [
          'M -30 165 C 210 150 360 190 560 176 S 820 116 1040 138',
          'M -20 320 C 190 292 350 342 540 310 S 780 252 1035 285',
          'M 70 600 C 170 480 250 405 350 300 S 560 130 690 -20',
          'M 305 650 C 365 500 455 420 590 348 S 820 220 930 -30',
          'M -10 505 C 240 470 385 505 565 478 S 820 420 1035 445',
        ]
        for (const path of roadPaths) {
          roads.append(svgElement('path', { d: path, stroke: '#1f3448', 'stroke-width': '18', opacity: '0.88' }))
          roads.append(svgElement('path', { d: path, stroke: '#4a6075', 'stroke-width': '2', opacity: '0.42' }))
        }
        map.append(roads)

        const navigation = container.classList.contains('persistent-route-map__basemap')
        const labels = navigation
          ? [
              ['延安西路', '730', '145'], ['内环高架', '500', '294'], ['虹桥路', '230', '435'],
              ['当前位置', '855', '205'], ['虹桥机场 T2', '88', '520'],
            ]
          : [
              ['人民大道', '710', '145'], ['西藏中路', '500', '294'], ['延安东路', '230', '435'],
              ['当前位置', '530', '260'],
            ]
        const labelLayer = svgElement('g', {
          fill: '#7990a8', 'font-family': 'sans-serif', 'font-size': '17', 'font-weight': '600', opacity: '0.86',
        })
        for (const [label, x, y] of labels) {
          const text = svgElement('text', { x: x!, y: y! })
          text.textContent = label!
          labelLayer.append(text)
        }
        map.append(labelLayer, this.overlays)
        container.append(map)

        const watermark = document.createElement('span')
        watermark.textContent = 'E2E MOCK · 上海确定性道路底图'
        Object.assign(watermark.style, {
          position: 'absolute', left: '20px', bottom: '18px', zIndex: '2',
          color: '#8195aa', font: '600 11px/1.2 sans-serif', letterSpacing: '0.08em',
          textTransform: 'uppercase', textShadow: '0 1px 4px #000',
        })
        container.append(watermark)
      }
      add(value: MockOverlay | MockOverlay[]) {
        for (const overlay of Array.isArray(value) ? value : [value]) overlay.mount?.(this)
      }
      remove(value: MockOverlay | MockOverlay[]) {
        for (const overlay of Array.isArray(value) ? value : [value]) overlay.remove?.()
      }
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
      destroy() {
        snapshot.mapDestroys += 1
        this.container.replaceChildren()
      }
    }

    class MockDriving {
      search(
        rawOrigin: unknown,
        rawDestination: unknown,
        options: unknown,
        callback: (status: string, result: unknown) => void,
      ) {
        void options
        const origin = point(rawOrigin)
        const destination = point(rawDestination)
        snapshot.routeSearches.push({ origin, destination })
        const steps = destination[0] >= origin[0] ? returnSteps : routeSteps
        queueMicrotask(() => callback('complete', { routes: [{ steps }] }))
      }
    }

    class MockPolyline {
      readonly line = svgElement('polyline', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
      path: Point[]

      constructor(options: { path?: Point[]; strokeColor?: string; strokeWeight?: number; strokeOpacity?: number }) {
        this.path = options.path ?? []
        this.line.setAttribute('stroke', options.strokeColor ?? '#5b93ff')
        this.line.setAttribute('stroke-width', String((options.strokeWeight ?? 6) * 1.35))
        this.line.setAttribute('opacity', String(options.strokeOpacity ?? 1))
        this.update()
      }
      mount(map: MockMap) { map.overlays.append(this.line) }
      remove() { this.line.remove() }
      setPath(path: Point[]) {
        this.path = path
        this.update()
      }
      update() {
        this.line.setAttribute('points', this.path.map((raw) => project(point(raw)).join(',')).join(' '))
      }
    }

    class MockMarker {
      readonly marker = svgElement('g', {})
      position?: Point
      angle = 0

      constructor(options: { position?: Point; angle?: number }) {
        this.position = options.position
        this.angle = options.angle ?? 0
        this.marker.append(
          svgElement('circle', { r: '20', fill: '#397cff', opacity: '0.2', stroke: '#8eb8ff', 'stroke-width': '2' }),
          svgElement('path', { d: 'M 0 -15 L 10 11 L 0 6 L -10 11 Z', fill: '#64a1ff', stroke: '#f4f8ff', 'stroke-width': '2' }),
        )
        if (options.position) snapshot.markerPositions.push(options.position)
        if (typeof options.angle === 'number') snapshot.markerAngles.push(options.angle)
        this.update()
      }
      mount(map: MockMap) { map.overlays.append(this.marker) }
      remove() { this.marker.remove() }
      setPosition(position: Point) {
        this.position = position
        snapshot.markerPositions.push(position)
        this.update()
      }
      setAngle(angle: number) {
        this.angle = angle
        snapshot.markerAngles.push(angle)
        this.update()
      }
      setContent(content: string | HTMLElement) { void content }
      update() {
        if (!this.position) return
        const [x, y] = project(point(this.position))
        this.marker.setAttribute('transform', `translate(${x} ${y}) rotate(${this.angle})`)
      }
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
