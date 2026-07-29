import type { CSSProperties, ReactNode } from 'react'
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
  CompleteIcon,
  InfoIcon,
  LocationIcon,
  MediaIcon,
  MessageIcon,
  NavigationIcon,
  SeatIcon,
} from './icons'

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

function ComponentSurface({
  component,
  children,
  className = '',
}: {
  component: ComponentSpec
  children: ReactNode
  className?: string
}) {
  const level = component.type === 'alert' || component.type === 'status-banner' ? component.props.level : undefined
  return (
    <article
      className={`ui-card ui-card--${component.type}${className ? ` ${className}` : ''}`}
      data-component-id={component.id}
      data-component-type={component.type}
      data-visibility={component.visibility ?? 'always'}
      data-level={level}
    >
      {children}
    </article>
  )
}

function Metric({
  label,
  value,
  detail,
  className = '',
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  className?: string
}) {
  return (
    <div className={`ui-metric${className ? ` ${className}` : ''}`}>
      <span className="ui-metric__label">{label}</span>
      <strong className="ui-metric__value">{value}</strong>
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

function NavigationSummaryCard({ component }: { component: Extract<ComponentSpec, { type: 'navigation-summary' }> }) {
  const { props } = component
  return (
    <ComponentSurface component={component} className="ui-navigation-brief">
      <header className="ui-navigation-brief__header">
        <span className="ui-navigation-brief__glyph" aria-hidden="true"><NavigationIcon /></span>
        <div>
          <p className="ui-navigation-brief__eyebrow">正在前往</p>
          <h2 className="ui-navigation-brief__destination">{props.destination}</h2>
        </div>
      </header>
      <section className="ui-navigation-brief__eta ui-navigation-hero" aria-label="预计到达">
        <span className="ui-metric__label">预计到达</span>
        <time className="ui-navigation-eta" dateTime={props.eta}>{formatTime(props.eta)}</time>
      </section>
      <div
        className="ui-navigation-brief__route-rule"
        data-route-progress="unavailable"
        aria-hidden="true"
      >
        <span className="ui-navigation-brief__route-start" />
        <span className="ui-navigation-brief__route-line" />
        <span className="ui-navigation-brief__route-end" />
      </div>
      <div className="ui-navigation-brief__facts ui-route-facts">
        <Metric label="剩余里程" value={formatDistance(props.distanceKm)} />
        <Metric label="到达电量" value={formatPercent(props.estimatedBatteryAtArrival)} />
        <Metric label="路线" value={props.routeId} className="ui-metric--route" />
      </div>
    </ComponentSurface>
  )
}

function ChargingRecommendationCard({ component }: { component: Extract<ComponentSpec, { type: 'charging-recommendation' }> }) {
  const { props } = component
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
          {props.cancellable && <span>发送前可取消</span>}
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
        {props.mediaTitle && <Metric label="媒体" value={props.mediaTitle} detail={<MediaIcon size={16} />} />}
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

function AlertCard({ component }: { component: Extract<ComponentSpec, { type: 'alert' }> }) {
  return (
    <ComponentSurface component={component} className={`ui-status-card ui-status-card--alert ui-card--${component.props.level}`}>
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
    <ComponentSurface component={component} className={`ui-status-card ui-status-card--banner ui-card--${component.props.level}`}>
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
}: {
  component?: unknown
  slotId: string
  phase: UISpec['phase']
}) {
  const result = componentSpecSchema.safeParse(component)
  if (!result.success) return <ComponentFallback component={component} slotId={slotId} />

  switch (result.data.type) {
    case 'pickup-overview': return <PickupOverviewCard component={result.data} />
    case 'flight-status': return <FlightStatusCard component={result.data} />
    case 'navigation-summary': return <NavigationSummaryCard component={result.data} />
    case 'charging-recommendation': return <ChargingRecommendationCard component={result.data} />
    case 'message-preview': return <MessagePreviewCard component={result.data} />
    case 'passenger-status': return <PassengerStatusCard component={result.data} />
    case 'cabin-profile': return <CabinProfileCard component={result.data} />
    case 'task-progress': return <TaskProgressCard component={result.data} phase={phase} />
    case 'alert': return <AlertCard component={result.data} />
    case 'status-banner': return <StatusBannerCard component={result.data} />
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

export function UISpecRenderer({ spec, driving, pending, onAction }: UISpecRendererProps) {
  const runtimeComponents: unknown[] = Array.isArray(spec.components) ? spec.components : []
  const runtimeActions: unknown[] = Array.isArray(spec.actions) ? spec.actions : []
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
  // A component the driving context forbids is dropped before anything counts it, so the
  // layout hooks, the single-component treatment, and the action bar all describe what is
  // actually on screen rather than what the spec asked for.
  const layout = {
    ...resolved,
    slots: resolved.slots.map((slot) => ({
      ...slot,
      ids: slot.ids.filter((componentId) => componentVisible(componentById.get(componentId), driving)),
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
              const actionIds = parsedComponent.success ? componentActionIds(parsedComponent.data) : []
              return (
                <div className="ui-component" data-component-order={index} key={`${componentId}-${index}`}>
                  <ComponentCard component={component} slotId={componentId} phase={spec.phase} />
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
        {renderedComponentCount === 0 && <EmptyFallback />}
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
