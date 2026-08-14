import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
import {
  actionSpecSchema,
  componentSpecSchema,
  type ComponentSpec,
  type UISpec,
} from '@canvasflow/schema'
import {
  AirplaneIcon,
  AlertIcon,
  ArrowRightIcon,
  ChargingIcon,
  ChevronUpIcon,
  ClockIcon,
  CompleteIcon,
  InfoIcon,
  LocationIcon,
  MediaIcon,
  MessageIcon,
  NavigationIcon,
  SeatIcon,
  WeatherIcon,
} from './icons'
import { ComponentSurface } from './ComponentSurface'
import { FlightChoicesCard } from './FlightChoicesCard'
import { RouteMapCard } from './RouteMapCard'
import { ROUTE_MAP_DRAWING_OPTIONS, ROUTE_SKETCH_VIEWBOX, buildRouteSketchDrawing } from './route-sketch'

export type UISpecRendererProps = {
  spec: UISpec
  driving?: boolean
  pending: boolean
  onAction: (actionId: string, componentId: string) => void
}

type RuntimeRecord = Record<string, unknown>
type SlotName = 'main' | 'primary' | 'secondary'
type LayoutType = UISpec['layout']['type']
type LayoutGap = 'none' | 'sm' | 'md' | 'lg'

const layoutTypes = new Set<LayoutType>(['stack', 'row', 'column', 'split', 'focus'])

const flightStatusLabels: Record<Extract<ComponentSpec, { type: 'flight-status' }>['props']['status'], string> = {
  scheduled: '计划中',
  'in-air': '飞行中',
  landed: '已落地',
  delayed: '延误',
  cancelled: '已取消',
}

const freshnessLabels: Record<Extract<ComponentSpec, { type: 'flight-status' }>['props']['freshness'], string> = {
  live: '航班动态',
  cached: '最近航班动态',
  fixture: '航班动态',
}

const passengerStatusLabels: Record<Extract<ComponentSpec, { type: 'passenger-status' }>['props']['status'], string> = {
  'in-flight': '航班飞行中',
  landed: '航班已落地',
  waiting: '等待上车',
  'possibly-onboard': '可能已上车',
  'confirmed-onboard': '已确认上车',
}

const messageStatusLabels: Record<Extract<ComponentSpec, { type: 'message-preview' }>['props']['status'], string> = {
  scheduled: '待发送',
  sending: '发送中',
  sent: '已发送',
  cancelled: '已取消',
  failed: '发送失败',
}

const progressStatusLabels: Record<
  Extract<ComponentSpec, { type: 'task-progress' }>['props']['steps'][number]['status'],
  string
> = {
  pending: '下一步',
  active: '现在',
  completed: '已完成',
}

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === 'object' && value !== null
}

function componentVisible(component: unknown, driving: boolean | undefined): boolean {
  if (!isRecord(component)) return true
  const visibility = stringValue(component.visibility)
  if (!visibility || visibility === 'always') return true
  // Conditional components are safety-sensitive; hide them until the caller
  // has an authoritative driving/parked signal.
  if (driving === undefined) return false
  return visibility === 'driving-only' ? driving : !driving
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function runtimeComponentId(component: unknown): string | undefined {
  return isRecord(component) ? stringValue(component.id) : undefined
}

function runtimeActionId(action: unknown): string | undefined {
  return isRecord(action) ? stringValue(action.id) : undefined
}

function formatTime(value: string): string {
  const matchedTime = value.match(/T(\d{2}:\d{2})/u)?.[1]
  return matchedTime ?? value
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`
}

function formatDistance(value: number): string {
  return `${value.toFixed(1)} km`
}

function levelIcon(level: 'info' | 'warning' | 'error' | 'critical'): ReactNode {
  return level === 'info' ? <InfoIcon /> : <AlertIcon />
}

// The UI Schema contract lets a night context force `dark`, so the renderer carries both
// themes. State colors are untouched: only the surface and ink tokens dim, which keeps blue,
// green, amber, and red meaning exactly what they mean in daylight.
function themeTokens(theme: UISpec['presentation']['theme']): CSSProperties {
  return theme === 'dark'
    ? ({
      '--surface': '#141a22',
      '--cabin': '#0c1015',
      '--ink': '#e8edf4',
      '--muted': '#94a2b3',
      '--rule': '#2a333f',
      '--quiet-rule': '#1c232c',
      backgroundColor: '#141a22',
      color: '#e8edf4',
    } as CSSProperties)
    : ({
      '--surface': '#ffffff',
      '--cabin': '#edf0f4',
      '--ink': '#102033',
      '--muted': '#667384',
      '--rule': '#dde3ea',
      '--quiet-rule': '#edf0f4',
      backgroundColor: '#ffffff',
      color: '#102033',
    } as CSSProperties)
}

// A safety or degradation state has to reach a driver who is not looking at the screen.
// `alert` interrupts, `status` waits its turn, so only a failure claims the interruption.
function liveRegionRole(level: 'info' | 'warning' | 'error' | 'critical'): 'alert' | 'status' {
  return level === 'error' || level === 'critical' ? 'alert' : 'status'
}

function Metric({
  label,
  value,
  detail,
  className = '',
  valueKind = 'figure',
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  className?: string
  // `.ui-metric__value` is a tabular numeral face at a numeral size. A value that is
  // prose rather than a figure asks for the body face at a reading size instead, or
  // it runs out of its grid column and ellipsises.
  valueKind?: 'figure' | 'text'
}) {
  return (
    <div className={`ui-metric${className ? ` ${className}` : ''}`}>
      <span className="ui-metric__label">{label}</span>
      <strong className="ui-metric__value">
        {valueKind === 'text' ? <span className="ui-metric__value-text">{value}</span> : value}
      </strong>
      {detail !== undefined && <small className="ui-metric__detail">{detail}</small>}
    </div>
  )
}

function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: string }) {
  return <span className={`ui-status ui-status--${tone}`}>{label}</span>
}

function PickupOverviewCard({ component }: { component: Extract<ComponentSpec, { type: 'pickup-overview' }> }) {
  const { props } = component
  const passengers = props.passengers.length > 0 ? props.passengers.join('、') : '家人'
  return (
    <ComponentSurface component={component} className="ui-pickup-brief">
      <header className="ui-pickup-brief__header">
        <span className="ui-pickup-brief__glyph" aria-hidden="true"><LocationIcon /></span>
        <p className="ui-pickup-brief__phase">{props.phaseLabel}</p>
      </header>
      <h2 className="ui-pickup-brief__lead ui-card__lead">去接 {passengers}</h2>
      <div className="ui-pickup-brief__facts ui-route-facts">
        <Metric label="航班" value={props.flightNumber} className="ui-metric--primary" />
        <Metric label="机场" value={props.airport} detail={props.terminal} />
      </div>
    </ComponentSurface>
  )
}

function FlightStatusCard({ component }: { component: Extract<ComponentSpec, { type: 'flight-status' }> }) {
  const { props } = component
  const changedArrival = props.scheduledArrival !== props.estimatedArrival
  return (
    <ComponentSurface component={component} className={`ui-flight-brief ui-card--flight-${props.status}`}>
      <header className="ui-flight-brief__header">
        <span className="ui-flight-brief__glyph" aria-hidden="true"><AirplaneIcon /></span>
        <div>
          <p className="ui-flight-brief__source">{freshnessLabels[props.freshness]}</p>
          <h2 className="ui-flight-brief__number">{props.flightNumber}</h2>
        </div>
        <StatusPill label={flightStatusLabels[props.status]} tone={props.status} />
      </header>
      <section className="ui-flight-brief__arrival" aria-label="预计到达">
        <span className="ui-metric__label">预计到达</span>
        <time className="ui-flight-brief__time ui-metric__value" dateTime={props.estimatedArrival}>{formatTime(props.estimatedArrival)}</time>
      </section>
      <div className="ui-flight-brief__facts ui-hero-metrics">
        <Metric label="航站楼" value={props.terminal} />
        {props.baggageClaim && <Metric label="行李转盘" value={props.baggageClaim} />}
        {changedArrival && (
          <Metric
            label="原计划"
            value={formatTime(props.scheduledArrival)}
            detail="时间已更新"
            className="ui-metric--comparison"
          />
        )}
      </div>
    </ComponentSurface>
  )
}

function FlightDetailCard({ component }: { component: Extract<ComponentSpec, { type: 'flight-detail' }> }) {
  const { props } = component
  const changedArrival = props.scheduledArrival !== props.estimatedArrival
  return (
    <ComponentSurface component={component} className="ui-flight-brief">
      <header className="ui-flight-brief__header">
        <span className="ui-flight-brief__glyph" aria-hidden="true"><AirplaneIcon /></span>
        <div>
          <p className="ui-flight-brief__source">{freshnessLabels[props.freshness]}</p>
          <h2 className="ui-flight-brief__number">{props.flightNumber}</h2>
        </div>
        <StatusPill label={flightStatusLabels[props.status]} tone={props.status} />
      </header>
      <p className="ui-card__summary">{props.airlineName} · {props.originName} → {props.arrivalAirportName}</p>
      <div className="vehicle-status-grid">
        <Metric label="预计到达" value={formatTime(props.estimatedArrival)} />
        <Metric label="计划到达" value={formatTime(props.scheduledArrival)} detail={changedArrival ? '时间已更新' : undefined} />
        <Metric label="航站楼" value={props.terminal} />
      </div>
    </ComponentSurface>
  )
}

function RouteConfirmationCard({ component }: { component: Extract<ComponentSpec, { type: 'route-confirmation' }> }) {
  const { props } = component
  const outbound = props.leg === 'outbound'
  return (
    <ComponentSurface component={component} className="ui-navigation-brief">
      <header className="ui-navigation-brief__header">
        <span className="ui-navigation-brief__glyph" aria-hidden="true"><NavigationIcon /></span>
        <div>
          <p className="ui-navigation-brief__eyebrow">{outbound ? '去程方案' : '返程方案'}</p>
          <h2 className="ui-navigation-brief__destination">{props.destination}</h2>
        </div>
        <StatusPill label="模拟路线" tone="neutral" />
      </header>
      {outbound && props.flightNumber && (
        <div className="ui-detail-row">
          <span>已选航班</span>
          <strong>{props.flightNumber}</strong>
          {props.flightEstimatedArrival && (
            <time dateTime={props.flightEstimatedArrival}>预计 {formatTime(props.flightEstimatedArrival)} 到达</time>
          )}
        </div>
      )}
      <div className="vehicle-status-grid">
        <Metric label="预计驾车" value={`${Math.round(props.durationMinutes)} 分钟`} />
        <Metric label="预计到达" value={formatTime(props.arrivalTime)} />
        <Metric label="距离" value={formatDistance(props.distanceKm)} />
        <Metric label="当前电量" value={formatPercent(props.currentBatteryPercent)} />
        <Metric label={outbound ? '预计到达电量' : '预计到家电量'} value={formatPercent(props.estimatedBatteryAtArrival)} />
      </div>
      <p className="ui-card__status-line">模拟行驶位置，非真实 GPS</p>
    </ComponentSurface>
  )
}

/**
 * The trip's navigation brief, and — where it floats over a map — the one card
 * the driver can put away.
 *
 * `floating` is the renderer's read of the same condition the stylesheet paints
 * on: a split layout, a drawn map in it, and this card alone in the rail. Only
 * there is there anything underneath worth uncovering, so only there does the
 * control exist. Everywhere else the card renders exactly as it did.
 *
 * Collapsing hides the route band and the two figures and keeps the header and
 * the ETA, because those are the answers a driver glances for — where am I going
 * and when do I get there. Nothing is unmounted: the stylesheet hides the detail
 * inside the same breakpoint that paints the panel, so a window narrowed below
 * it shows the whole card again rather than stranding the driver with a
 * collapsed card and no control to reopen it.
 */
function NavigationSummaryCard({
  component,
  floating,
}: {
  component: Extract<ComponentSpec, { type: 'navigation-summary' }>
  floating: boolean
}) {
  const { props } = component
  // The driver's choice, not the Agent's: a new UISpec for the same trip leaves
  // it alone, and it resets when the phase changes the screen out from under it.
  const [collapsed, setCollapsed] = useState(false)
  const detailId = `${component.id}-detail`
  return (
    <ComponentSurface
      component={component}
      className="ui-navigation-brief"
      data={floating ? { 'data-panel': collapsed ? 'collapsed' : 'expanded' } : undefined}
    >
      <header className="ui-navigation-brief__header">
        <span className="ui-navigation-brief__glyph" aria-hidden="true"><NavigationIcon /></span>
        <div>
          <p className="ui-navigation-brief__eyebrow">正在前往</p>
          <h2 className="ui-navigation-brief__destination">{props.destination}</h2>
        </div>
        {floating && (
          <button
            className="ui-navigation-brief__fold"
            type="button"
            aria-controls={detailId}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((wasCollapsed) => !wasCollapsed)}
          >
            {/* A chevron and no visible label: the destination is already at the
                width the rail can hold, and a labelled button beside it would
                push it to an ellipsis. The label is the button's whole accessible
                name, so nothing is lost to anyone reading by screen reader. */}
            <span className="sr-only">{collapsed ? '展开面板' : '收起面板'}</span>
            <ChevronUpIcon size={22} aria-hidden="true" />
          </button>
        )}
      </header>
      <section className="ui-navigation-brief__eta ui-navigation-hero" aria-label="预计到达">
        <span className="ui-metric__label">预计到达</span>
        <time className="ui-navigation-eta" dateTime={props.eta}>{formatTime(props.eta)}</time>
      </section>
      <div className="ui-navigation-brief__detail" id={detailId}>
        <RouteSketchBand destination={props.destination} sketch={props.routeSketch} />
        <div className="ui-navigation-brief__facts ui-route-facts">
          <Metric label="剩余里程" value={formatDistance(props.distanceKm)} />
          <Metric label="到达电量" value={formatPercent(props.estimatedBatteryAtArrival)} />
        </div>
      </div>
    </ComponentSurface>
  )
}

/**
 * The route region of the navigation card.
 *
 * With drawable geometry in the spec it is an offline sketch of the planned
 * route: a fictional polyline, its named stops, and — only when the spec carries
 * a progress value — a marker at that staged point along the drawing. Nothing
 * here is live positioning, so the copy says 模拟行程进度 rather than claiming a
 * current location, and the marker only ever moves when a new spec arrives with
 * a different value.
 *
 * The stop names and the progress figure share one caption row, and the route
 * summary in the spec is deliberately not drawn: the destination heading and the
 * stop names already say where this route goes, and inside a fixed frame the ETA
 * keeps the room a third line of prose would have taken.
 *
 * Without drawable geometry it stays the plain activity stroke the card has
 * always shown, so a spec with no sketch — or one whose geometry cannot be drawn
 * — loses the drawing and keeps every fact around it.
 */
function RouteSketchBand({
  destination,
  sketch,
}: {
  destination: string
  sketch: Extract<ComponentSpec, { type: 'navigation-summary' }>['props']['routeSketch']
}) {
  const drawing = buildRouteSketchDrawing(sketch)
  if (!drawing) {
    return (
      <div
        className="ui-navigation-brief__route-rule"
        data-route-progress="unavailable"
        aria-hidden="true"
      >
        <span className="ui-navigation-brief__route-start" />
        <span className="ui-navigation-brief__route-line" />
      </div>
    )
  }
  return (
    <div
      className="ui-navigation-brief__route-rule ui-route-sketch"
      data-route-progress={drawing.vehicle ? 'simulated' : 'route-only'}
    >
      <svg
        className="ui-route-sketch__canvas"
        viewBox={`0 0 ${ROUTE_SKETCH_VIEWBOX.width} ${ROUTE_SKETCH_VIEWBOX.height}`}
        role="img"
        aria-label={`前往${destination}的路线示意`}
      >
        <path className="ui-route-sketch__line" d={drawing.path} />
        {drawing.markers.map((marker) => (
          <circle
            key={marker.key}
            className="ui-route-sketch__marker"
            data-role={marker.role}
            cx={marker.x}
            cy={marker.y}
            r={marker.role === 'via' ? 4 : 5.5}
          />
        ))}
        {drawing.vehicle && (
          <g
            className="ui-route-sketch__vehicle"
            transform={`translate(${drawing.vehicle.x} ${drawing.vehicle.y})`}
          >
            <circle className="ui-route-sketch__vehicle-halo" r={9} />
            <circle className="ui-route-sketch__vehicle-dot" r={4.5} />
          </g>
        )}
      </svg>
      <p className="ui-route-sketch__caption">
        <span className="ui-route-sketch__stops">
          {drawing.markers.map((marker) => (
            <span key={marker.key} className="ui-route-sketch__stop" data-role={marker.role}>{marker.name}</span>
          ))}
        </span>
        {drawing.progressPercent !== undefined && (
          <span className="ui-route-sketch__progress">模拟行程进度 {drawing.progressPercent}%</span>
        )}
      </p>
    </div>
  )
}

function ChargingRecommendationCard({ component }: { component: Extract<ComponentSpec, { type: 'charging-recommendation' }> }) {
  const { props } = component
  const route = props.chargingRoute
  const stations = props.nearbyStations
  const formatRouteDuration = (minutes?: number) => {
    if (minutes === undefined) return ''
    const hours = Math.floor(minutes / 60)
    const remainder = minutes % 60
    return `${hours ? `${hours}小时` : ''}${remainder ? `${remainder}分钟` : ''}` || '0分钟'
  }
  return (
    <ComponentSurface component={component} className={`ui-charge-brief ${props.recommended ? 'ui-card--attention' : 'ui-card--settled'}`}>
      <header className="ui-charge-brief__header">
        <span className="ui-charge-brief__glyph" aria-hidden="true"><ChargingIcon /></span>
        <div>
          <p className="ui-charge-brief__eyebrow">车辆电量</p>
          <h2 className="ui-charge-brief__title">{props.recommended ? '建议途中补能' : '电量足够完成行程'}</h2>
        </div>
      </header>
      {props.suggestedDurationMinutes !== undefined && (
        <p className="ui-charge-brief__recommendation ui-card__lead ui-card__lead--recommendation">补能约 {props.suggestedDurationMinutes} 分钟</p>
      )}
      <div className="ui-charge-brief__battery ui-battery-journey" aria-label={`电量从 ${formatPercent(props.currentBatteryPercent)} 到 ${formatPercent(props.estimatedFinalBatteryPercent)}`}>
        <Metric label="当前" value={formatPercent(props.currentBatteryPercent)} className="ui-metric--hero" />
        <ArrowRightIcon className="ui-battery-journey__arrow" size={28} />
        <Metric label="到达后" value={formatPercent(props.estimatedFinalBatteryPercent)} className="ui-metric--hero" />
      </div>
      <p className="ui-charge-brief__reason ui-card__summary">{props.reason}</p>
      {props.etaImpactMinutes !== undefined && (
        <div className="ui-charge-brief__detail ui-detail-row">
          <span>行程增加约 {props.etaImpactMinutes} 分钟</span>
        </div>
      )}
      {stations && (
        <section className="ui-charge-brief__stations" aria-label="附近充电站">
          <div className="ui-charge-brief__section-heading">
            <span className="ui-charge-brief__section-icon" aria-hidden="true"><ChargingIcon size={18} /></span>
            <strong>附近充电站</strong>
            {stations.soc && <span className="ui-charge-brief__section-meta">当前电量 {stations.soc}</span>}
          </div>
          <div className="ui-charge-brief__station-list">
            {stations.items.map((station, index) => (
              <div className="ui-charge-brief__station" key={station.id ?? `${station.name}-${index}`}>
                <span className="ui-charge-brief__station-index">{index + 1}</span>
                <div className="ui-charge-brief__station-copy">
                  <div className="ui-charge-brief__station-title">
                    <strong>{station.name}</strong>
                    {station.distanceKm !== undefined && <span className="ui-charge-brief__station-distance">{station.distanceKm}km</span>}
                  </div>
                  <div className="ui-charge-brief__station-meta">
                    {station.operator && <span>{station.operator}</span>}
                    {station.available !== undefined && station.total !== undefined && <span className={station.available > 0 ? 'ui-charge-brief__station-available' : 'ui-charge-brief__station-unavailable'}>{station.available}/{station.total} 空闲</span>}
                    {station.price && <span>{station.price}/度</span>}
                    {station.rating !== undefined && <span className="ui-charge-brief__station-rating">★ {station.rating}</span>}
                  </div>
                  {station.address && <div className="ui-charge-brief__station-address">{station.address}</div>}
                </div>
              </div>
            ))}
          </div>
          <p className="ui-charge-brief__voice-hint">说「导航去第一个」或「换一个」</p>
        </section>
      )}
      {route && (
        <section className="ui-charge-brief__route" aria-label="充电路线规划">
          <div className="ui-charge-brief__section-heading ui-charge-brief__section-heading--route">
            <span className="ui-charge-brief__section-icon" aria-hidden="true"><ChargingIcon size={18} /></span>
            <strong>充电路线规划</strong>
            {(route.distanceKm !== undefined || route.durationMinutes !== undefined) && (
              <span className="ui-charge-brief__section-meta">
                {route.distanceKm !== undefined ? `${route.distanceKm}km` : ''}
                {route.distanceKm !== undefined && route.durationMinutes !== undefined ? ' · ' : ''}
                {formatRouteDuration(route.durationMinutes)}
              </span>
            )}
          </div>
          {route.soc && (
            <div className="ui-charge-brief__soc" aria-label={`当前电量 ${route.soc}`}>
              <div className="ui-charge-brief__soc-head"><span>当前电量</span><strong>{route.soc}</strong></div>
              <div className="ui-charge-brief__soc-track"><span style={{ width: `${Math.max(0, Math.min(100, Number.parseInt(route.soc, 10) || 0))}%` }} /></div>
              <div className="ui-charge-brief__soc-foot"><span>出发地</span><span>目的地 · {route.destination}</span></div>
            </div>
          )}
          <div className="ui-charge-brief__route-stops">
            <div className="ui-charge-brief__route-stop ui-charge-brief__route-stop--origin"><span className="ui-charge-brief__route-dot" /><div><strong>出发地</strong>{route.soc && <small>当前电量 {route.soc}</small>}</div></div>
            {route.stops.map((stop, index) => (
              <div className="ui-charge-brief__route-stop-wrap" key={`${stop.name}-${index}`}>
                <div className="ui-charge-brief__route-connector">{stop.atKm !== undefined && <span>约 {stop.atKm}km 处</span>}</div>
                <div className="ui-charge-brief__route-stop ui-charge-brief__route-stop--charge"><span className="ui-charge-brief__route-stop-icon" aria-hidden="true"><ChargingIcon size={15} /></span><div><strong>{stop.name}</strong>{stop.address && <small>{stop.address}</small>}</div></div>
              </div>
            ))}
            <div className="ui-charge-brief__route-stop ui-charge-brief__route-stop--destination"><span className="ui-charge-brief__route-dot" /><strong>{route.destination}</strong></div>
          </div>
        </section>
      )}
    </ComponentSurface>
  )
}

function MessagePreviewCard({ component }: { component: Extract<ComponentSpec, { type: 'message-preview' }> }) {
  const { props } = component
  return (
    <ComponentSurface component={component} className="ui-message-brief">
      <header className="ui-message-brief__header">
        <span className="ui-message-brief__glyph" aria-hidden="true"><MessageIcon /></span>
        <div>
          <p className="ui-message-brief__eyebrow">给家人的消息</p>
          <h2 className="ui-message-brief__contact">{props.contactLabel}</h2>
        </div>
      </header>
      <blockquote className="ui-message-brief__copy ui-message-preview">“{props.textPreview}”</blockquote>
      <div className="ui-message-brief__status ui-card__status-line">
        <StatusPill label={messageStatusLabels[props.status]} tone={props.status} />
      </div>
      {(props.scheduledAt || props.cancellable) && (
        <div className="ui-message-brief__detail ui-detail-row">
          {props.scheduledAt && <span>计划 {formatTime(props.scheduledAt)} 发送</span>}
          {/* `cancellable` says the message is not committed yet — it does not say this screen
              can take it back, and nothing here can. State the fact, promise nothing. */}
          {props.cancellable && <span>尚未发出</span>}
        </div>
      )}
    </ComponentSurface>
  )
}

function PassengerStatusCard({ component }: { component: Extract<ComponentSpec, { type: 'passenger-status' }> }) {
  const { props } = component
  const tone = props.status === 'confirmed-onboard' ? 'confirmed' : props.status
  return (
    <ComponentSurface component={component} className="ui-passenger-brief">
      <header className="ui-passenger-brief__header">
        <span className="ui-passenger-brief__glyph" aria-hidden="true"><SeatIcon /></span>
        <div>
          <p className="ui-passenger-brief__eyebrow">接机状态</p>
          <h2 className="ui-passenger-brief__lead">{props.label}</h2>
        </div>
      </header>
      <div className="ui-passenger-brief__status">
        <StatusPill label={passengerStatusLabels[props.status]} tone={tone} />
      </div>
      {props.meetingPoint && (
        <div className="ui-passenger-brief__meeting-point ui-callout">
          <span className="ui-callout__label">推荐接机点</span>
          <strong className="ui-passenger-brief__meeting-name">{props.meetingPoint}</strong>
        </div>
      )}
    </ComponentSurface>
  )
}

function CabinProfileCard({ component }: { component: Extract<ComponentSpec, { type: 'cabin-profile' }> }) {
  const { props } = component
  return (
    <ComponentSurface component={component} className="ui-cabin-brief">
      <header className="ui-cabin-brief__header">
        <span className="ui-cabin-brief__glyph" aria-hidden="true"><SeatIcon /></span>
        <div>
          <p className="ui-cabin-brief__eyebrow">后排座舱</p>
          <h2 className="ui-cabin-brief__title">{props.appliedFromMemory ? '已应用家庭偏好' : '座舱设置已应用'}</h2>
        </div>
      </header>
      <div className="ui-cabin-brief__facts ui-cabin-grid">
        {props.temperatureC !== undefined && <Metric label="温度" value={`${props.temperatureC}°C`} />}
        {props.fanLevel !== undefined && <Metric label="风量" value={`${props.fanLevel} 档`} />}
        {props.mediaTitle && (
          <Metric label="媒体" value={props.mediaTitle} valueKind="text" detail={<MediaIcon size={16} />} />
        )}
      </div>
      <div className="ui-cabin-brief__state ui-detail-row">
        <span>已应用</span>
        {props.appliedFromMemory && <span>来自家庭记忆</span>}
        {props.reversible && <span>可随时撤销</span>}
      </div>
    </ComponentSurface>
  )
}

function TaskProgressCard({
  component,
  phase,
}: {
  component: Extract<ComponentSpec, { type: 'task-progress' }>
  phase: UISpec['phase']
}) {
  const { steps } = component.props
  const activeIndex = steps.findIndex((step) => step.status === 'active')
  const isCompleted = phase === 'completed'
  // A completed brief has no next actionable phase. When a legacy progress list omits
  // its active terminal step, close the last real step rather than showing an empty route.
  const declaredCompletionIndex = steps.findIndex((step) => step.phase === 'completed')
  const completionIndex = isCompleted
    ? declaredCompletionIndex >= 0
      ? declaredCompletionIndex
      : activeIndex >= 0
        ? activeIndex
        : steps.length - 1
    : -1
  const currentIndex = isCompleted ? completionIndex : activeIndex
  const hasNextStep = !isCompleted && activeIndex >= 0 && activeIndex < steps.length - 1
  const activeLabel = steps[currentIndex]?.label ?? '行程进度'
  return (
    <ComponentSurface component={component} className="ui-progress-brief">
      <header className="ui-progress-brief__header">
        <span className="ui-progress-brief__glyph" aria-hidden="true"><CompleteIcon /></span>
        <div>
          <p className="ui-progress-brief__eyebrow">行程进度</p>
          <h2 className="ui-progress-brief__title">{activeLabel}</h2>
        </div>
      </header>
      <ol
        className="ui-progress"
        aria-label={isCompleted ? '已完成的行程步骤' : '行程步骤'}
        data-has-next={hasNextStep}
        data-active-index={currentIndex}
        data-completion-index={completionIndex >= 0 ? completionIndex : undefined}
        data-terminal={isCompleted || undefined}
      >
        {steps.length === 0 ? (
          <li className="ui-progress__empty ui-card__empty">暂时没有可显示的进度</li>
        ) : steps.map((step, index) => {
          const isCompletionStep = index === completionIndex
          // `spec.phase` is the authoritative screen state. A terminal screen closes
          // every listed historical phase without manufacturing a new route step.
          const displayStatus = isCompleted && index <= completionIndex
            ? 'completed'
            : step.status
          return (
            <li
              className={`ui-progress__step ui-progress__step--${displayStatus}`}
              key={`${step.phase}-${step.label}`}
              data-status={step.status}
              data-display-status={displayStatus}
              data-terminal-step={isCompletionStep || undefined}
              aria-current={index === currentIndex ? 'step' : undefined}
            >
              <span className="ui-progress__marker" aria-hidden="true">
                {displayStatus === 'completed' ? <CompleteIcon size={18} /> : index + 1}
              </span>
              <span className="ui-progress__label">{step.label}</span>
              <small>{progressStatusLabels[displayStatus]}</small>
            </li>
          )
        })}
      </ol>
    </ComponentSurface>
  )
}

const scheduleMilestoneStatusLabels: Record<
  Extract<ComponentSpec, { type: 'schedule-strip' }>['props']['milestones'][number]['status'],
  string
> = {
  done: '已完成',
  next: '下一个',
  upcoming: '随后',
  'at-risk': '可能赶不上',
}

/**
 * One compact band that lays the task's projected milestones alongside the
 * family calendar. Task points render solid, calendar points hollow, so the
 * driver reads "the trip runs in the gaps of the day" at a glance; `at-risk`
 * is the only state allowed to raise its voice.
 */
function ScheduleStripCard({ component }: { component: Extract<ComponentSpec, { type: 'schedule-strip' }> }) {
  const { milestones } = component.props
  return (
    <ComponentSurface component={component} className="ui-schedule-strip">
      <header className="ui-schedule-strip__header">
        <span className="ui-schedule-strip__glyph" aria-hidden="true"><ClockIcon size={18} /></span>
        <p className="ui-schedule-strip__eyebrow">今日安排</p>
      </header>
      <ol className="ui-schedule-strip__track" aria-label="任务与日程时间带">
        {milestones.map((milestone) => (
          <li
            key={`${milestone.label}-${milestone.time}`}
            className="ui-schedule-strip__milestone"
            data-kind={milestone.kind}
            data-status={milestone.status}
          >
            <span className="ui-schedule-strip__dot" aria-hidden="true" />
            <span className="ui-schedule-strip__label">{milestone.label}</span>
            <time className="ui-schedule-strip__time" dateTime={milestone.time}>{formatTime(milestone.time)}</time>
            {milestone.status === 'at-risk' && (
              <span className="ui-schedule-strip__risk">{scheduleMilestoneStatusLabels['at-risk']}</span>
            )}
          </li>
        ))}
      </ol>
    </ComponentSurface>
  )
}

/**
 * The on-demand weather answer. One horizontal band — glyph, condition,
 * temperature, facts, one advisory — sized like the schedule strip whose slot
 * it borrows on a full brief, so the fixed frame never has to grow for it.
 */
function WeatherCard({ component }: { component: Extract<ComponentSpec, { type: 'weather-card' }> }) {
  const { props } = component
  return (
    <ComponentSurface component={component} className={`ui-weather-brief ui-card--weather-${props.condition}`}>
      <header className="ui-weather-brief__header">
        <span className="ui-weather-brief__glyph" aria-hidden="true"><WeatherIcon size={18} /></span>
        <p className="ui-weather-brief__eyebrow">{props.timeLabel} · {props.location}</p>
      </header>
      <div className="ui-weather-brief__reading">
        <strong className="ui-weather-brief__condition">{props.conditionLabel}</strong>
        <strong className="ui-weather-brief__temperature">{Math.round(props.temperatureC)}°C</strong>
        {props.windLevel !== undefined && <span className="ui-weather-brief__fact">风力 {props.windLevel} 级</span>}
        {props.precipitationChance !== undefined && <span className="ui-weather-brief__fact">降水 {Math.round(props.precipitationChance)}%</span>}
      </div>
      {props.advisory && <p className="ui-weather-brief__advisory">{props.advisory}</p>}
    </ComponentSurface>
  )
}

/**
 * The on-demand schedule answer: the day's remaining events on one band, in
 * the same single-row posture as the strip whose slot it borrows. Each entry
 * is time + title (+ location); the tail beyond the cap collapses to a count.
 */
function ScheduleCard({ component }: { component: Extract<ComponentSpec, { type: 'schedule-card' }> }) {
  const { props } = component
  const statusLabels = { ended: '已结束', ongoing: '进行中', upcoming: '即将开始' } as const
  return (
    <ComponentSurface component={component} className="ui-schedule-card">
      <header className="ui-schedule-card__header">
        <span className="ui-schedule-card__glyph" aria-hidden="true"><ClockIcon size={18} /></span>
        <p className="ui-schedule-card__eyebrow">{props.dateLabel}的日程</p>
      </header>
      {props.events.length === 0 ? (
        <p className="ui-schedule-card__empty">{props.emptyCopy ?? '今天没有更多安排了'}</p>
      ) : (
        <ol className="ui-schedule-card__list" aria-label="今日日程列表">
          {props.events.map((event) => (
            <li
              className={`ui-schedule-card__event${event.atRisk ? ' ui-schedule-card__event--at-risk' : ''}`}
              key={event.eventId}
            >
              <time className="ui-schedule-card__time" dateTime={event.startAt}>{formatTime(event.startAt)}</time>
              <span className="ui-schedule-card__title">{event.title}</span>
              {event.status && (
                <span className="ui-schedule-card__status" data-status={event.status}>{statusLabels[event.status]}</span>
              )}
              {event.location && <span className="ui-schedule-card__location">{event.location}</span>}
              {event.atRisk && <span className="ui-schedule-card__risk">可能迟到</span>}
            </li>
          ))}
        </ol>
      )}
      {props.moreCount !== undefined && <span className="ui-schedule-card__more">还有 {props.moreCount} 项</span>}
    </ComponentSurface>
  )
}

function AlertCard({ component }: { component: Extract<ComponentSpec, { type: 'alert' }> }) {
  return (
    <ComponentSurface
      component={component}
      className={`ui-status-card ui-status-card--alert ui-card--${component.props.level}`}
      // An explicit alert is always something the driver was asked to notice.
      role="alert"
    >
      <span className="ui-status-card__glyph" aria-hidden="true">{levelIcon(component.props.level)}</span>
      <div className="ui-status-card__content">
        <p className="ui-status-card__kind">需要留意</p>
        <h2 className="ui-status-card__title">{component.props.title}</h2>
        {component.props.message && <p className="ui-status-card__message">{component.props.message}</p>}
      </div>
    </ComponentSurface>
  )
}

function StatusBannerCard({ component }: { component: Extract<ComponentSpec, { type: 'status-banner' }> }) {
  const tone = component.props.level === 'error' ? 'critical' : component.props.level
  return (
    <ComponentSurface
      component={component}
      className={`ui-status-card ui-status-card--banner ui-card--${component.props.level}`}
      role={liveRegionRole(component.props.level)}
    >
      <span className="ui-status-card__glyph" aria-hidden="true">{levelIcon(component.props.level)}</span>
      <div className="ui-status-card__content">
        <p className="ui-status-card__kind">行程提示</p>
        <h2 className="ui-status-card__title">{component.props.title}</h2>
        {component.props.message && <p className="ui-status-card__message">{component.props.message}</p>}
        <div className="ui-status-card__state">
          <StatusPill label={component.props.level === 'error' ? '暂不可用' : tone === 'warning' ? '请留意' : '信息'} tone={tone} />
        </div>
      </div>
    </ComponentSurface>
  )
}

function ComponentFallback({ component, slotId }: { component?: unknown; slotId: string }) {
  return (
    <article
      className="ui-card ui-card--fallback ui-status-card ui-status-card--fallback"
      data-component-id={slotId}
      data-component-type={isRecord(component) ? stringValue(component.type) ?? 'unknown' : 'unknown'}
      role="status"
    >
      <span className="ui-status-card__glyph" aria-hidden="true"><InfoIcon /></span>
      <div className="ui-status-card__content">
        <p className="ui-status-card__kind">行程信息</p>
        <h2 className="ui-status-card__title">这项信息暂时无法显示</h2>
        <p className="ui-status-card__message">请稍后再试，其他行程信息仍可继续使用。</p>
      </div>
    </article>
  )
}

function EmptyFallback() {
  return (
    <article className="ui-card ui-card--fallback ui-card--empty ui-status-card ui-status-card--fallback" role="status">
      <span className="ui-status-card__glyph" aria-hidden="true"><InfoIcon /></span>
      <div className="ui-status-card__content">
        <p className="ui-status-card__kind">行程信息</p>
        <h2 className="ui-status-card__title">暂时没有可显示的信息</h2>
      </div>
    </article>
  )
}

function ComponentCard({
  component,
  slotId,
  phase,
  theme,
  actionById,
  pending,
  onAction,
  floating,
}: {
  component?: unknown
  slotId: string
  phase: UISpec['phase']
  theme: UISpec['presentation']['theme']
  /** Only cards whose own contents are the controls need these. */
  actionById: Map<string, unknown>
  pending: boolean
  onAction: UISpecRendererProps['onAction']
  /** True only for the one card the stylesheet floats over the map as a panel. */
  floating: boolean
}) {
  const result = componentSpecSchema.safeParse(component)
  if (!result.success) return <ComponentFallback component={component} slotId={slotId} />

  switch (result.data.type) {
    case 'pickup-overview': return <PickupOverviewCard component={result.data} />
    case 'flight-status': return <FlightStatusCard component={result.data} />
    case 'flight-detail': return <FlightDetailCard component={result.data} />
    case 'navigation-summary': return <NavigationSummaryCard component={result.data} floating={floating} />
    case 'route-confirmation': return <RouteConfirmationCard component={result.data} />
    case 'route-map': {
      // Geometry that survived the schema can still be undrawable — every point on
      // one spot, say. A map with no line in it is an empty frame, so the slot goes
      // to the same fallback a malformed component would get.
      const drawing = buildRouteSketchDrawing(result.data.props.routeSketch, ROUTE_MAP_DRAWING_OPTIONS)
      return drawing
        ? <RouteMapCard component={result.data} drawing={drawing} theme={theme} />
        : <ComponentFallback component={component} slotId={slotId} />
    }
    case 'charging-recommendation': return <ChargingRecommendationCard component={result.data} />
    case 'message-preview': return <MessagePreviewCard component={result.data} />
    case 'passenger-status': return <PassengerStatusCard component={result.data} />
    case 'cabin-profile': return <CabinProfileCard component={result.data} />
    case 'task-progress': return <TaskProgressCard component={result.data} phase={phase} />
    case 'schedule-strip': return <ScheduleStripCard component={result.data} />
    case 'weather-card': return <WeatherCard component={result.data} />
    case 'schedule-card': return <ScheduleCard component={result.data} />
    case 'flight-choices':
      return (
        <FlightChoicesCard
          component={result.data}
          actionById={actionById}
          pending={pending}
          onAction={onAction}
        />
      )
    case 'departure-plan': return <DeparturePlanCard component={result.data} />
    case 'alert': return <AlertCard component={result.data} />
    case 'status-banner': return <StatusBannerCard component={result.data} />
    case 'vehicle-status': return <ComponentFallback component={component} slotId={slotId} />
  }
}

function ActionButton({
  action,
  actionId,
  componentId,
  pending,
  onAction,
}: {
  action?: unknown
  actionId?: string
  componentId: string
  pending: boolean
  onAction: UISpecRendererProps['onAction']
}) {
  const result = actionSpecSchema.safeParse(action)
  if (!result.success) {
    const label = isRecord(action) ? stringValue(action.label) : undefined
    return (
      <button className="ui-action ui-action--unavailable" type="button" disabled>
        {label ?? '操作暂不可用'}
        {actionId && <span className="sr-only">（{actionId}）</span>}
      </button>
    )
  }

  return (
    <button
      className={`ui-action ui-action--${result.data.style}`}
      type="button"
      data-action-id={result.data.id}
      // An action already in flight must not be submitted twice.
      disabled={pending}
      onClick={() => onAction(result.data.id, componentId)}
    >
      <span>{result.data.label}</span>
      {result.data.style === 'primary' && <ArrowRightIcon size={20} />}
    </button>
  )
}

function componentActionIds(component: unknown): string[] {
  if (!isRecord(component) || !Array.isArray(component.actions)) return []
  return component.actions.filter((actionId): actionId is string => typeof actionId === 'string' && actionId.length > 0)
}

/**
 * Action ids a card draws inside itself, so the slot's button group does not draw
 * them a second time.
 *
 * The ids stay on the component's `actions` list either way — that list is what
 * keeps them out of the global bar and what the on-screen action count reads — so
 * this only answers who renders them, not who owns them.
 */
function cardOwnedActionIds(component: ComponentSpec): string[] {
  return component.type === 'flight-choices'
    ? [
        ...component.props.choices
          .map((choice) => choice.actionId)
          .filter((actionId): actionId is string => actionId !== undefined),
        // The refresh pill is drawn in the card's own header, so it belongs here
        // too — left off this list it would appear twice, once as a pill and once
        // as a full-height button in the slot's group.
        ...(component.props.refreshActionId ? [component.props.refreshActionId] : []),
      ]
    : []
}

/**
 * The on-demand departure answer: one clock time, and the three facts it was
 * worked backwards from.
 *
 * The time leads because it is the only thing the driver has to act on, and the
 * facts follow because a recommendation nobody can check is one they have to take
 * on faith. There is deliberately no "leave now" verdict — the demo's fixture
 * timeline and the wall clock disagree, so the card gives the numbers and the
 * driver keeps the decision.
 */
function DeparturePlanCard({ component }: { component: Extract<ComponentSpec, { type: 'departure-plan' }> }) {
  const { props } = component
  return (
    <ComponentSurface component={component} className="ui-departure-plan">
      <header className="ui-departure-plan__header">
        <span className="ui-departure-plan__glyph" aria-hidden="true"><ClockIcon size={18} /></span>
        <p className="ui-departure-plan__eyebrow">建议出发</p>
      </header>
      <strong className="ui-departure-plan__time">{props.departAtLabel}</strong>
      <ul className="ui-departure-plan__facts">
        <li className="ui-departure-plan__fact">{props.arrivalLabel}</li>
        <li className="ui-departure-plan__fact">路上 {props.driveMinutes} 分钟</li>
        <li className="ui-departure-plan__fact">提前 {props.bufferMinutes} 分钟到</li>
        {props.viaLabel && <li className="ui-departure-plan__fact ui-departure-plan__fact--via">{props.viaLabel}</li>}
      </ul>
      {/* Not a fact the time was derived from, so not in the list: it is the
          answer to "did that reminder take". It carries its own clock because a
          reminder set against an earlier route keeps the time the driver was
          actually promised, and a bare 已设提醒 would hide the difference. */}
      {props.reminderAtLabel && (
        <p className="ui-departure-plan__reminder">已设提醒 {props.reminderAtLabel}</p>
      )}
    </ComponentSurface>
  )
}

function resolveLayout(spec: UISpec, runtimeComponents: unknown[]): {
  type: LayoutType
  slots: Array<{ name: SlotName; ids: string[] }>
  gap?: LayoutGap
  style?: CSSProperties
} {
  const layout = spec.layout as unknown
  if (isRecord(layout) && typeof layout.type === 'string' && layoutTypes.has(layout.type as LayoutType) && isRecord(layout.slots)) {
    const type = layout.type as LayoutType
    const layoutSlots = layout.slots
    const slotNames: SlotName[] = type === 'split' || type === 'focus' ? ['primary', 'secondary'] : ['main']
    const slots = slotNames.map((name) => ({
      name,
      ids: Array.isArray(layoutSlots[name])
        ? (layoutSlots[name] as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [],
    }))
    const hasSlotItems = slots.some((slot) => slot.ids.length > 0)
    if (hasSlotItems || runtimeComponents.length === 0) {
      const ratio = type === 'split' && Array.isArray(layout.ratio) ? layout.ratio : undefined
      const style = ratio && typeof ratio[0] === 'number' && typeof ratio[1] === 'number'
        ? ({ '--ui-primary-ratio': `${ratio[0]}fr`, '--ui-secondary-ratio': `${ratio[1]}fr` } as CSSProperties)
        : undefined
      const gap = stringValue(layout.gap)
      return {
        type,
        slots,
        style,
        gap: gap === 'none' || gap === 'sm' || gap === 'md' || gap === 'lg' ? gap : undefined,
      }
    }
  }

  return {
    type: 'stack',
    slots: [{ name: 'main', ids: runtimeComponents.map(runtimeComponentId).filter((id): id is string => Boolean(id)) }],
  }
}

function ActionGroup({
  className,
  actionIds,
  actionById,
  componentId,
  pending,
  onAction,
  label,
}: {
  className: string
  actionIds: string[]
  actionById: Map<string, unknown>
  componentId: string
  pending: boolean
  onAction: UISpecRendererProps['onAction']
  label?: string
}) {
  if (actionIds.length === 0) return null
  return (
    <div className={className} aria-label={label}>
      {actionIds.map((actionId, index) => (
        <ActionButton
          key={`${actionId}-${index}`}
          action={actionById.get(actionId)}
          actionId={actionId}
          componentId={componentId}
          pending={pending}
          onAction={onAction}
        />
      ))}
    </div>
  )
}

/**
 * The one card the stylesheet floats over the map, or `undefined` where nothing
 * floats.
 *
 * This is the CSS guard read back in TypeScript: a split layout, a route map
 * that actually drew, and a rail carrying exactly one card. It has to agree with
 * the stylesheet because the fold control it gates only makes sense over a map —
 * a card that is an ordinary column has nothing behind it to uncover.
 *
 * Only a navigation summary qualifies, which the stylesheet also assumes: it is
 * the one card type painted as glass, and a fold control on an unpainted card in
 * the rail would put a chrome button on plain text over a basemap.
 *
 * The breakpoint is deliberately not read here. The control renders into the DOM
 * whatever the width and the stylesheet hides it, along with the collapse it
 * drives, below the width where the panel exists — so a narrowed window shows
 * the whole card again instead of a collapsed one with no way back.
 */
function floatingPanelId(
  layout: { type: LayoutType; slots: Array<{ name: SlotName; ids: string[] }> },
  componentById: Map<string, unknown>,
): string | undefined {
  if (layout.type !== 'split') return undefined
  const rail = layout.slots.find((slot) => slot.name === 'secondary')?.ids ?? []
  if (rail.length !== 1) return undefined
  const drawsAMap = layout.slots.some((slot) => slot.ids.some((id) => {
    const parsed = componentSpecSchema.safeParse(componentById.get(id))
    if (!parsed.success || parsed.data.type !== 'route-map') return false
    // An undrawable sketch renders the fallback instead, which the stylesheet's
    // `:has(.ui-card--route-map)` does not match and no panel floats over.
    return buildRouteSketchDrawing(parsed.data.props.routeSketch, ROUTE_MAP_DRAWING_OPTIONS) !== undefined
  }))
  if (!drawsAMap) return undefined
  const parsedRail = componentSpecSchema.safeParse(componentById.get(rail[0]!))
  return parsedRail.success && parsedRail.data.type === 'navigation-summary' ? rail[0] : undefined
}

export function UISpecRenderer({ spec, driving, pending, onAction }: UISpecRendererProps) {
  const runtimeComponents: unknown[] = Array.isArray(spec.components) ? spec.components : []
  const runtimeActions: unknown[] = Array.isArray(spec.actions) ? spec.actions : []
  const hasRuntimeWindows = Array.isArray((spec as unknown as { windows?: unknown }).windows)
    && ((spec as unknown as { windows: unknown[] }).windows.length > 0)
  const componentById = new Map<string, unknown>()
  const actionById = new Map<string, unknown>()

  for (const component of runtimeComponents) {
    const id = runtimeComponentId(component)
    if (id && !componentById.has(id)) componentById.set(id, component)
  }
  for (const action of runtimeActions) {
    const id = runtimeActionId(action)
    if (id && !actionById.has(id)) actionById.set(id, action)
  }

  const resolved = resolveLayout(spec, runtimeComponents)
  const windowOwnedComponentIds = new Set(
    Array.isArray((spec as unknown as { windows?: Array<{ componentIds?: unknown }> }).windows)
      ? (spec as unknown as { windows: Array<{ componentIds?: unknown }> }).windows.flatMap((window) => (
          Array.isArray(window.componentIds) ? window.componentIds.filter((id): id is string => typeof id === 'string') : []
        ))
      : [],
  )
  // A component the driving context forbids is dropped before anything counts it, so the
  // layout hooks, the single-component treatment, and the action bar all describe what is
  // actually on screen rather than what the spec asked for.
  const layout = {
    ...resolved,
    slots: resolved.slots.map((slot) => ({
      ...slot,
      ids: slot.ids.filter((componentId) => (
        !windowOwnedComponentIds.has(componentId) && componentVisible(componentById.get(componentId), driving)
      )),
    })),
  }
  const renderedComponentIds = new Set(layout.slots.flatMap((slot) => slot.ids))
  // Any action a component claims stays with that component: invalid cards suppress it, and a
  // component left out of every slot must not promote its action into the global bar without context.
  const referencedActions = new Set(runtimeComponents.flatMap(componentActionIds))
  const globalActionIds = runtimeActions
    .map(runtimeActionId)
    .filter((id): id is string => id !== undefined && !referencedActions.has(id))
  // The Agent API pairs every action with the component it was dispatched from. A global
  // action has no card of its own, so it reports the first component the brief actually
  // resolved. An unresolvable slot id is never sent: the backend would reject it, and the
  // driver's action would fail for a reason that has nothing to do with what they pressed.
  const globalActionComponentId = layout.slots
    .flatMap((slot) => slot.ids)
    .find((componentId) => componentById.has(componentId))
    ?? runtimeComponents.map(runtimeComponentId).find((id): id is string => id !== undefined)
    ?? 'task'
  const renderedComponentCount = renderedComponentIds.size
  const renderedComponentActionCount = layout.slots.reduce((count, slot) => count + slot.ids.reduce((slotCount, componentId) => {
    const parsedComponent = componentSpecSchema.safeParse(componentById.get(componentId))
    return slotCount + (parsedComponent.success ? componentActionIds(parsedComponent.data).length : 0)
  }, 0), 0)
  const renderedActionCount = renderedComponentActionCount + globalActionIds.length
  const fillsTaskSurface = renderedComponentCount === 1
  const theme = spec.presentation?.theme ?? 'dark'
  const panelId = floatingPanelId(layout, componentById)

  return (
    <section
      className="ui-spec-renderer"
      // A stable landmark name for assistive tech and automation. The driver-facing title
      // is the shell's `h1` from `spec.title`, so this must not compete with it.
      aria-label="Generated task interface"
      data-title={spec.title}
      data-density={spec.presentation?.density ?? 'full'}
      data-theme={theme}
      data-priority={spec.presentation?.priority ?? 'normal'}
      data-layout={layout.type}
      data-gap={layout.gap ?? 'md'}
      data-phase={spec.phase}
      data-single-component={fillsTaskSurface}
      data-component-count={renderedComponentCount}
      data-has-actions={renderedActionCount > 0}
      style={themeTokens(theme)}
    >
      <div className={`ui-layout ui-layout--${layout.type}`} style={layout.style}>
        {layout.slots.map((slot) => (
          <div className={`ui-slot ui-slot--${slot.name}`} data-slot={slot.name} key={slot.name}>
            {slot.ids.map((componentId, index) => {
              const component = componentById.get(componentId)
              const parsedComponent = componentSpecSchema.safeParse(component)
              const ownedByCard = parsedComponent.success ? new Set(cardOwnedActionIds(parsedComponent.data)) : new Set<string>()
              const actionIds = parsedComponent.success
                ? componentActionIds(parsedComponent.data).filter((actionId) => !ownedByCard.has(actionId))
                : []
              return (
                <div className="ui-component" data-component-order={index} key={`${componentId}-${index}`}>
                  <ComponentCard
                    component={component}
                    slotId={componentId}
                    phase={spec.phase}
                    theme={theme}
                    actionById={actionById}
                    pending={pending}
                    onAction={onAction}
                    floating={componentId === panelId}
                  />
                  <ActionGroup
                    className="ui-card__actions"
                    actionIds={actionIds}
                    actionById={actionById}
                    componentId={componentId}
                    pending={pending}
                    onAction={onAction}
                  />
                </div>
              )
            })}
          </div>
        ))}
        {renderedComponentCount === 0 && !hasRuntimeWindows && <EmptyFallback />}
      </div>
      <ActionGroup
        className="ui-actions"
        actionIds={globalActionIds}
        actionById={actionById}
        componentId={globalActionComponentId}
        pending={pending}
        onAction={onAction}
        label="Task actions"
      />
    </section>
  )
}

export default UISpecRenderer
