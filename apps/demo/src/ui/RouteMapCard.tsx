import { useEffect, useRef, useState } from 'react'
import type { ComponentSpec } from '@canvasflow/schema'
import { ComponentSurface } from './ComponentSurface'
import { ROUTE_MAP_VIEWBOX, type RouteSketchDrawing } from './route-sketch'
import { loadAMap } from './amap/loader'
import { renderAMapRoute } from './amap/render'

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
 * Nothing here is live positioning. The caption says 模拟行程进度 and never
 * claims a current location; the marker — sketch or basemap — moves only when a
 * new UISpec arrives. There is deliberately no timer, no animation loop, and no
 * request made per frame: this component cannot advance the trip, only draw
 * where the task says it is.
 *
 * `mode` is the composer's read of what the driver needs to see — the whole trip
 * or the part they are on. The sketch reflects the intent in
 * `data-route-map-mode`; the basemap renderer turns it into a camera.
 */
export function RouteMapCard({
  component,
  drawing,
}: {
  component: Extract<ComponentSpec, { type: 'route-map' }>
  drawing: RouteSketchDrawing
}) {
  const { props } = component
  const mapContainer = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState<'sketch' | 'amap'>('sketch')

  useEffect(() => {
    let cancelled = false
    let handle: { destroy: () => void } | null = null
    const container = mapContainer.current
    if (!container) return

    void loadAMap().then((amap) => {
      if (cancelled || !amap) return
      return renderAMapRoute(amap, container, { sketch: props.routeSketch, mode: props.mode }).then((rendered) => {
        if (cancelled) {
          rendered?.destroy()
          return
        }
        if (rendered) {
          handle = rendered
          setSource('amap')
        }
      })
    })

    return () => {
      cancelled = true
      handle?.destroy()
      setSource('sketch')
    }
    // Re-run when the drawn route or the camera intent changes, so a new spec
    // redraws on the basemap instead of leaving a stale route behind.
  }, [props.routeSketch, props.mode])

  return (
    <ComponentSurface
      component={component}
      className="ui-route-map"
      data={{
        // Which drawing the driver is looking at: the offline sketch by default,
        // the real basemap once AMap has loaded and drawn the route.
        'data-route-map-source': source,
        'data-route-map-mode': props.mode,
        'data-route-progress': drawing.vehicle ? 'simulated' : 'route-only',
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
        <path className="ui-route-map__line" d={drawing.path} />
        {drawing.markers.map((marker) => (
          <g key={marker.key} className="ui-route-map__stop" data-role={marker.role}>
            <circle className="ui-route-map__marker" cx={marker.x} cy={marker.y} r={marker.role === 'via' ? 5 : 7} />
            <text className="ui-route-map__label" x={marker.x} y={marker.y - 15} textAnchor="middle">{marker.name}</text>
          </g>
        ))}
        {drawing.vehicle && (
          <g className="ui-route-map__vehicle" transform={`translate(${drawing.vehicle.x} ${drawing.vehicle.y})`}>
            <circle className="ui-route-map__vehicle-halo" r={14} />
            <circle className="ui-route-map__vehicle-dot" r={6.5} />
          </g>
        )}
      </svg>
      <p className="ui-route-map__caption">
        <span className="ui-route-map__destination">前往 {props.destination}</span>
        {drawing.progressPercent !== undefined && (
          <span className="ui-route-map__progress">模拟行程进度 {drawing.progressPercent}%</span>
        )}
      </p>
    </ComponentSurface>
  )
}
