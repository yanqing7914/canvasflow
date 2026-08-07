import type { ComponentSpec, RouteSketch } from '@canvasflow/schema'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteMapCard } from './RouteMapCard'
import { ROUTE_MAP_DRAWING_OPTIONS, buildRouteSketchDrawing } from './route-sketch'

/**
 * What the basemap layer is showing when it arrives after the car has moved.
 *
 * The rest of the panel is covered through the renderer in
 * `UISpecRenderer.test.tsx`, where AMap is absent exactly as it is in CI. This
 * file exists for the one case that needs the map present *and* slow: the route
 * is drawn from the sketch's authored progress, but the crawl has its own
 * reading, and the two only meet through frames that arrive after the map does.
 * A map that loads late — a cold script, a throttled key — would otherwise draw
 * the car at the start of the span while the caption beside it read further
 * along, and a map that loads after the span is spent would stay wrong for good,
 * because there is no next frame to correct it.
 */
const stub = vi.hoisted(() => ({
  /** Resolves to the AMap API; a test releases it when it wants the map to exist. */
  load: Promise.resolve<unknown>(null),
  /** Where the map's own marker has been told to go. */
  setProgress: vi.fn<(progress: number) => void>(),
}))

vi.mock('./amap/loader', () => ({ loadAMap: () => stub.load }))
vi.mock('./amap/render', () => ({
  renderAMapRoute: () => Promise.resolve({
    setProgress: (progress: number) => stub.setProgress(progress),
    destroy: () => {},
  }),
}))

const sketch: RouteSketch = {
  summary: '经虹桥枢纽超充站前往机场',
  waypoints: [
    { id: 'origin-demo', name: '出发地', latitude: 31.23, longitude: 121.47 },
    { id: 'destination-hongqiao-t2', name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
  ],
  polyline: [
    { latitude: 31.23, longitude: 121.47 },
    { latitude: 31.21, longitude: 121.38 },
    { latitude: 31.198, longitude: 121.336 },
  ],
}

function card(routeSketch: RouteSketch) {
  const component = {
    id: 'route-map',
    type: 'route-map',
    props: { destination: '虹桥机场 T2', mode: 'follow', routeSketch },
  } as Extract<ComponentSpec, { type: 'route-map' }>
  return (
    <RouteMapCard
      component={component}
      drawing={buildRouteSketchDrawing(routeSketch, ROUTE_MAP_DRAWING_OPTIONS)!}
      theme="dark"
    />
  )
}

describe('a basemap that finishes loading after the crawl has moved', () => {
  let frames: Array<(timestampMs: number) => void> = []
  let releaseLoad!: () => void

  beforeEach(() => {
    frames = []
    now = 0
    stub.setProgress.mockClear()
    stub.load = new Promise((resolve) => { releaseLoad = () => resolve({}) })
    vi.stubGlobal('requestAnimationFrame', (callback: (timestampMs: number) => void) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { frames[handle - 1] = () => {} })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  let now = 0

  function step(timestampMs: number) {
    now = timestampMs
    const due = frames
    frames = []
    act(() => { for (const frame of due) frame(timestampMs) })
  }

  /**
   * Delivers `durationMs` of frames at 100ms each, the way a painting tab does.
   * The crawl counts the gap between frames rather than the time since it began,
   * so a single distant timestamp is a tab that stopped painting and buys almost
   * no movement — time has to arrive in frames to be spent.
   */
  function advance(durationMs: number) {
    const target = now + durationMs
    while (now < target) step(Math.min(now + 100, target))
  }

  /** Lets the load promise and the render promise inside it both settle. */
  async function letTheMapArrive() {
    releaseLoad()
    await act(async () => { await stub.load })
    await act(async () => {})
  }

  it('catches the map up to where the car already is', async () => {
    render(card({ ...sketch, progress: 0.4, crawl: { toProgress: 0.6, durationSeconds: 10 } }))

    step(0)
    advance(5000)
    expect(stub.setProgress).not.toHaveBeenCalled()

    await letTheMapArrive()
    // Halfway through the span, so the map is placed at the crawl's reading and
    // not at the 0.4 the route was drawn from.
    expect(stub.setProgress).toHaveBeenLastCalledWith(0.5)
  })

  it('places a map that arrives after the span is spent at the far end', async () => {
    render(card({ ...sketch, progress: 0.4, crawl: { toProgress: 0.6, durationSeconds: 10 } }))

    step(0)
    advance(11_000)
    // The span is over: nothing further is scheduled, so this is the last chance
    // to get the map right.
    expect(frames).toHaveLength(0)

    await letTheMapArrive()
    expect(stub.setProgress).toHaveBeenLastCalledWith(0.6)
  })

  it('leaves the map where it drew itself when no crawl was authored', async () => {
    render(card({ ...sketch, progress: 0.4 }))

    await letTheMapArrive()
    // The route already carries the authored marker, so moving it would be a
    // second source of truth for the same value.
    expect(stub.setProgress).not.toHaveBeenCalled()
  })
})
