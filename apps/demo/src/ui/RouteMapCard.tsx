import type { ComponentSpec } from '@canvasflow/schema'
import { ComponentSurface } from './ComponentSurface'
import { ROUTE_MAP_VIEWBOX, type RouteSketchDrawing } from './route-sketch'

/**
 * The route as a panel of its own rather than a rule inside the navigation card.
 *
 * The same fixture geometry the card's band draws, given a slot it can fill: the
 * planned line, its named stops, and — only when the spec carries a progress
 * value — a marker at that staged point along the drawing. Nothing here is live
 * positioning, so the caption says 模拟行程进度 and never claims a current
 * location, and the marker moves only when a new UISpec arrives carrying a
 * different value. There is deliberately no timer, no animation loop, and no
 * transition: this component cannot advance the trip, only draw where the task
 * says it is.
 *
 * `mode` is the composer's read of what the driver needs to see — the whole trip
 * or the part they are on. The offline panel draws the same picture either way and
 * reflects the intent in `data-route-map-mode`; turning that intent into a camera
 * is a renderer with a real basemap under it, not this one.
 *
 * The drawing arrives already projected, so the card decides nothing about
 * geometry — geometry that cannot be drawn never reaches it.
 */
export function RouteMapCard({
  component,
  drawing,
}: {
  component: Extract<ComponentSpec, { type: 'route-map' }>
  drawing: RouteSketchDrawing
}) {
  const { props } = component
  return (
    <ComponentSurface
      component={component}
      className="ui-route-map"
      data={{
        // Which drawing the driver is looking at. The offline sketch is the only
        // source today; a renderer with a real basemap would say so here instead.
        'data-route-map-source': 'sketch',
        'data-route-map-mode': props.mode,
        'data-route-progress': drawing.vehicle ? 'simulated' : 'route-only',
      }}
    >
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
