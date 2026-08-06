import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentSpec } from '@canvasflow/schema'
import { ComponentSurface } from './ComponentSurface'
import {
  ROUTE_MAP_DRAWING_OPTIONS,
  ROUTE_MAP_VIEWBOX,
  buildRouteSketchDrawing,
  type RouteSketchDrawing,
} from './route-sketch'
import { loadAMap } from './amap/loader'
import { startCrawl } from './amap/crawl'
import { renderAMapRoute, type AMapRouteHandle } from './amap/render'

/**
 * The route as a panel of its own rather than a rule inside the navigation card.
 *
 * Two layers share one slot. The base is the offline sketch: the same fixture
 * geometry the card's band draws, given room to fill — the planned line, its
 * named stops, and, only when the spec carries a progress value, a marker at
 * that staged point. On top, when an AMap key is configured and the API loads,
 * the real basemap renderer takes over and `data-route-map-source` flips from
 * `sketch` to `amap`. With no key, or on any load or routing failure, the map
 * layer never appears and the sketch is what shows — the demo's default state.
 *
 * None of this is live positioning. The caption says 模拟行程进度 throughout and
 * never claims a current location. Where the spec's sketch carries a `crawl`, the
 * marker moves between two points the fixture authored, at a rate the fixture
 * authored, and stops at the far end; where it does not, the marker holds until a
 * new UISpec arrives. The component cannot choose either end of that span, cannot
 * extend it, and makes no request per frame. What moves is a staged figure, not a
 * measurement.
 *
 * The sketch marker, the basemap marker, and the percentage in the caption all
 * read the same crawled value, so the three never disagree about where the car
 * is. The basemap one is moved imperatively through the render handle because the
 * map owns its own overlays; the other two are ordinary React state.
 *
 * `mode` is the composer's read of what the driver needs to see — the whole trip
 * or the part they are on. The sketch reflects the intent in
 * `data-route-map-mode`; the basemap renderer turns it into a camera.
 *
 * `theme` is the Agent's, carried in `presentation.theme`, and it reaches the
 * basemap because a light-tiled map under a dark cabin is the one surface that
 * would still be daylight at night. It only ever selects a basemap style and a
 * route colour; what the car reported is upstream of it.
 */
export function RouteMapCard({
  component,
  drawing,
  theme,
}: {
  component: Extract<ComponentSpec, { type: 'route-map' }>
  drawing: RouteSketchDrawing
  theme: 'light' | 'dark'
}) {
  const { props } = component
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapHandle = useRef<AMapRouteHandle | null>(null)
  const [source, setSource] = useState<'sketch' | 'amap'>('sketch')
  /** Where the crawl has reached, or `undefined` while the marker holds. */
  const [crawled, setCrawled] = useState<number | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const container = mapContainer.current
    if (!container) return

    void loadAMap().then((amap) => {
      if (cancelled || !amap) return
      return renderAMapRoute(amap, container, {
        sketch: props.routeSketch,
        mode: props.mode,
        theme,
      }).then((rendered) => {
        if (cancelled) {
          rendered?.destroy()
          return
        }
        if (rendered) {
          mapHandle.current = rendered
          setSource('amap')
        }
      })
    })

    return () => {
      cancelled = true
      mapHandle.current?.destroy()
      mapHandle.current = null
      setSource('sketch')
    }
    // Re-run when the drawn route, the camera intent, or the theme changes, so a
    // new spec redraws on the basemap instead of leaving a stale route behind.
  }, [props.routeSketch, props.mode, theme])

  useEffect(() => {
    // A new sketch is a new authored position: drop whatever the last one had
    // crawled to rather than carrying it onto different geometry.
    setCrawled(undefined)

    const { progress, crawl } = props.routeSketch
    if (progress === undefined || !crawl) return

    const handle = startCrawl({
      from: progress,
      span: crawl,
      onProgress: (next) => {
        setCrawled(next)
        // The map may still be loading, or may never load at all; the sketch
        // below it moves either way.
        mapHandle.current?.setProgress(next)
      },
    })
    // A background tab stops delivering frames, so the crawl pauses with it and
    // resumes from where it stopped — the span is a distance, not a wall clock.
    return () => handle?.stop()
  }, [props.routeSketch])

  // Rebuilt only while crawling, so a spec with no crawl renders from exactly the
  // drawing the renderer already built for it.
  const shown = useMemo(() => {
    if (crawled === undefined) return drawing
    return buildRouteSketchDrawing(
      { ...props.routeSketch, progress: crawled },
      ROUTE_MAP_DRAWING_OPTIONS,
    ) ?? drawing
  }, [crawled, drawing, props.routeSketch])

  return (
    <ComponentSurface
      component={component}
      className="ui-route-map"
      data={{
        // Which drawing the driver is looking at: the offline sketch by default,
        // the real basemap once AMap has loaded and drawn the route.
        'data-route-map-source': source,
        'data-route-map-mode': props.mode,
        'data-route-progress': shown.vehicle ? 'simulated' : 'route-only',
      }}
    >
      {/* The basemap draws into this layer; it sits empty (and hidden) until the
          AMap renderer succeeds, so the sketch below shows through by default. */}
      <div
        ref={mapContainer}
        className="ui-route-map__basemap"
        data-active={source === 'amap' ? 'true' : 'false'}
        aria-hidden="true"
      />
      <svg
        className="ui-route-map__canvas"
        viewBox={`0 0 ${ROUTE_MAP_VIEWBOX.width} ${ROUTE_MAP_VIEWBOX.height}`}
        // The projection already fits the drawing inside this box and centres it,
        // so the box is scaled whole rather than stretched to the slot's shape.
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`前往${props.destination}的路线示意`}
      >
        <path className="ui-route-map__line" d={shown.path} />
        {shown.markers.map((marker) => (
          <g key={marker.key} className="ui-route-map__stop" data-role={marker.role}>
            <circle className="ui-route-map__marker" cx={marker.x} cy={marker.y} r={marker.role === 'via' ? 5 : 7} />
            <text className="ui-route-map__label" x={marker.x} y={marker.y - 15} textAnchor="middle">{marker.name}</text>
          </g>
        ))}
        {shown.vehicle && (
          <g className="ui-route-map__vehicle" transform={`translate(${shown.vehicle.x} ${shown.vehicle.y})`}>
            <circle className="ui-route-map__vehicle-halo" r={14} />
            <circle className="ui-route-map__vehicle-dot" r={6.5} />
          </g>
        )}
      </svg>
      <p className="ui-route-map__caption">
        <span className="ui-route-map__destination">前往 {props.destination}</span>
        {shown.progressPercent !== undefined && (
          <span className="ui-route-map__progress">模拟行程进度 {shown.progressPercent}%</span>
        )}
      </p>
    </ComponentSurface>
  )
}
