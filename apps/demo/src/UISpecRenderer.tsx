import type {
  ActionSpec,
  ComponentSpec,
  UISpec,
} from '@canvasflow/schema'
import type { CSSProperties, ReactNode } from 'react'

type UISpecRendererProps = {
  spec: UISpec
  driving?: boolean
  pending: boolean
  onAction: (actionId: string, componentId: string) => void
}

type ActionButtonProps = {
  action: ActionSpec | undefined
  fallbackId: string
  componentId: string
  pending: boolean
  onAction: UISpecRendererProps['onAction']
}

const statusLabels: Record<string, string> = {
  scheduled: '计划中',
  'in-air': '飞行中',
  landed: '已落地',
  delayed: '延误',
  cancelled: '已取消',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  waiting: '等待中',
  'possibly-onboard': '可能已上车',
  'confirmed-onboard': '已确认上车',
}

const knownComponentTypes = new Set([
  'pickup-overview',
  'flight-status',
  'navigation-summary',
  'charging-recommendation',
  'message-preview',
  'passenger-status',
  'cabin-profile',
  'task-progress',
  'alert',
  'status-banner',
])

export function UISpecRenderer({ spec, driving, pending, onAction }: UISpecRendererProps) {
  const components = new Map(spec.components.map((component) => [component.id, component]))
  const actions = new Map(spec.actions.map((action) => [action.id, action]))
  const boundActions = new Set(spec.components.flatMap((component) => component.actions ?? []))
  const slots = Object.entries(spec.layout.slots) as Array<[string, string[]]>

  return (
    <section
      className={`ui-surface density-${spec.presentation.density} priority-${spec.presentation.priority}`}
      aria-label="Generated task interface"
      data-layout={spec.layout.type}
      data-theme={spec.presentation.theme}
      style={themeStyle(spec.presentation.theme)}
    >
      <div className="surface-heading">
        <div>
          <span className="surface-kicker">LIVE UISPEC / {spec.meta.generatedBy}</span>
          <h2>{spec.title}</h2>
        </div>
        <div className="surface-revision" aria-label={`UI revision ${spec.uiRevision}`}>
          <span>UI</span>
          <strong>{String(spec.uiRevision).padStart(2, '0')}</strong>
        </div>
      </div>

      <div
        className={`ui-layout layout-${spec.layout.type} gap-${layoutGap(spec)}`}
        style={layoutStyle(spec)}
      >
        {slots.map(([slotName, componentIds]) => (
          <div className={`ui-slot slot-${slotName}`} data-slot={slotName} key={slotName}>
            {componentIds.map((componentId) => {
              const component = components.get(componentId)
              if (!component) return <MissingComponent key={componentId} id={componentId} />
              if (!componentVisible(component, driving)) return null
              if (!knownComponentTypes.has(component.type)) {
                return (
                  <article className="ui-card card-unknown" data-component-id={component.id} key={component.id}>
                    <UnknownComponent type={component.type} />
                  </article>
                )
              }
              return (
                <ComponentCard component={component} key={component.id}>
                  {component.actions?.map((actionId) => (
                    <ActionButton
                      action={actions.get(actionId)}
                      componentId={component.id}
                      fallbackId={actionId}
                      key={actionId}
                      onAction={onAction}
                      pending={pending}
                    />
                  ))}
                </ComponentCard>
              )
            })}
          </div>
        ))}
      </div>

      {spec.actions.some((action) => !boundActions.has(action.id)) && (
        <div className="surface-actions" aria-label="Task actions">
          {spec.actions.filter((action) => !boundActions.has(action.id)).map((action) => (
            <ActionButton
              action={action}
              componentId={spec.components[0]?.id ?? 'task'}
              fallbackId={action.id}
              key={action.id}
              onAction={onAction}
              pending={pending}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ComponentCard({ component, children }: { component: ComponentSpec; children?: ReactNode }) {
  const content = renderComponent(component)
  return (
    <article
      className={`ui-card card-${component.type}`}
      data-component-id={component.id}
      data-component-type={component.type}
    >
      <span className="component-code">{component.type}</span>
      {content}
      {children && <div className="component-actions">{children}</div>}
    </article>
  )
}

function renderComponent(component: ComponentSpec): ReactNode {
  switch (component.type) {
    case 'pickup-overview':
      return (
        <>
          <p className="card-eyebrow">{component.props.phaseLabel}</p>
          <h3>{component.props.passengers.length > 0 ? component.props.passengers.join('和') : '等待乘客信息'}</h3>
          <div className="overview-route" aria-label="Pickup route">
            <span><small>航班</small><strong>{component.props.flightNumber}</strong></span>
            <i aria-hidden="true" />
            <span><small>目的地</small><strong>{component.props.airport} {component.props.terminal}</strong></span>
          </div>
        </>
      )
    case 'task-progress':
      return (
        <>
          <p className="card-eyebrow">任务进度</p>
          <ol className="progress-track">
            {component.props.steps.map((step, index) => (
              <li aria-current={step.status === 'active' ? 'step' : undefined} className={`progress-${step.status}`} key={step.phase}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div><strong>{step.label}</strong><small>{step.status}</small></div>
              </li>
            ))}
          </ol>
        </>
      )
    case 'status-banner':
      return (
        <div className={`banner-content banner-${component.props.level}`} role={component.props.level === 'error' ? 'alert' : 'status'}>
          <span className="signal-mark" aria-hidden="true" />
          <div><p className="card-eyebrow">系统提示</p><h3>{component.props.title}</h3>{component.props.message && <p>{component.props.message}</p>}</div>
        </div>
      )
    case 'alert':
      return (
        <div className={`banner-content alert-${component.props.level}`} role="alert">
          <span className="signal-mark" aria-hidden="true" />
          <div><p className="card-eyebrow">需要注意</p><h3>{component.props.title}</h3>{component.props.message && <p>{component.props.message}</p>}</div>
        </div>
      )
    case 'flight-status':
      return (
        <>
          <div className="card-headline"><div><p className="card-eyebrow">航班状态</p><h3>{component.props.flightNumber}</h3></div><StatusPill status={component.props.status} /></div>
          <div className="flight-board">
            <Metric label="计划到达" value={formatTime(component.props.scheduledArrival)} />
            <Metric label="预计到达" value={formatTime(component.props.estimatedArrival)} />
            <Metric label="航站楼" value={component.props.terminal} />
            {component.props.baggageClaim && <Metric label="行李转盘" value={component.props.baggageClaim} />}
          </div>
          <p className="freshness">数据源 / {component.props.freshness}</p>
        </>
      )
    case 'navigation-summary':
      return (
        <>
          <p className="card-eyebrow">导航路线</p>
          <h3>{component.props.destination}</h3>
          <div className="route-line" aria-hidden="true"><span /><i /><span /></div>
          <div className="metric-row">
            <Metric label="预计到达" value={formatTime(component.props.eta)} />
            <Metric label="距离" value={`${formatNumber(component.props.distanceKm)} km`} />
            <Metric label="到达电量" value={`${formatNumber(component.props.estimatedBatteryAtArrival)}%`} />
          </div>
          <small className="route-id">{component.props.routeId}</small>
        </>
      )
    case 'charging-recommendation': {
      const current = clampPercent(component.props.currentBatteryPercent)
      const final = clampPercent(component.props.estimatedFinalBatteryPercent)
      return (
        <>
          <div className="card-headline"><div><p className="card-eyebrow">能源策略</p><h3>{component.props.recommended ? '建议先补能' : '补能状态'}</h3></div><strong className="battery-reading">{current}%</strong></div>
          <div className="battery-track" aria-label={`当前电量 ${current}%`}><span style={{ width: `${current}%` }} /></div>
          <p className="recommendation-copy">{component.props.reason}</p>
          <div className="metric-row">
            <Metric label="预计任务后" value={`${final}%`} />
            {component.props.suggestedDurationMinutes !== undefined && <Metric label="建议补能" value={`${component.props.suggestedDurationMinutes} min`} />}
            {component.props.etaImpactMinutes !== undefined && <Metric label="行程增加" value={`+${component.props.etaImpactMinutes} min`} />}
          </div>
        </>
      )
    }
    case 'message-preview':
      return (
        <>
          <div className="card-headline"><div><p className="card-eyebrow">落地通知</p><h3>{component.props.contactLabel}</h3></div><StatusPill status={component.props.status} /></div>
          <blockquote className="message-bubble">{component.props.textPreview}</blockquote>
          {component.props.scheduledAt && <p className="freshness">计划发送 / {formatTime(component.props.scheduledAt)}</p>}
        </>
      )
    case 'passenger-status':
      return (
        <>
          <div className="passenger-orbit" aria-hidden="true"><span /><span /><span /></div>
          <p className="card-eyebrow">乘客状态</p>
          <h3>{component.props.label}</h3>
          <StatusPill status={component.props.status} />
          {component.props.meetingPoint && <p className="meeting-point"><small>建议会合点</small><strong>{component.props.meetingPoint}</strong></p>}
        </>
      )
    case 'cabin-profile':
      return (
        <>
          <div className="card-headline"><div><p className="card-eyebrow">后排座舱</p><h3>{component.props.appliedFromMemory ? '家庭偏好已应用' : '座舱设置'}</h3></div><span className="memory-chip">MEMORY</span></div>
          <div className="cabin-dials">
            {component.props.temperatureC !== undefined && <Metric label="温度" value={`${formatNumber(component.props.temperatureC)}°C`} />}
            {component.props.fanLevel !== undefined && <Metric label="风量" value={`${formatNumber(component.props.fanLevel)} / 5`} />}
            {component.props.mediaTitle && <Metric label="正在播放" value={component.props.mediaTitle} />}
          </div>
          {component.props.reversible && <p className="reversible-note">此设置支持撤销</p>}
        </>
      )
  }

  const unknown = component as unknown as { type?: string }
  return <UnknownComponent type={unknown.type ?? 'unknown'} />
}

function ActionButton({ action, fallbackId, componentId, pending, onAction }: ActionButtonProps) {
  if (!action) return <button className="action-button action-unavailable" disabled type="button">操作不可用</button>
  return (
    <button
      className={`action-button action-${action.style}`}
      data-action-id={action.id}
      disabled={pending}
      onClick={() => onAction(action.id, componentId)}
      type="button"
    >
      <span>{action.label}</span>
      <small aria-hidden="true">{fallbackId.slice(0, 2).toUpperCase()}</small>
    </button>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span className="metric"><small>{label}</small><strong>{value}</strong></span>
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`}>{statusLabels[status] ?? status}</span>
}

function MissingComponent({ id }: { id: string }) {
  return <article className="ui-card card-unknown" role="status"><p className="card-eyebrow">渲染降级</p><h3>组件引用不可用</h3><p>{id}</p></article>
}

function UnknownComponent({ type }: { type: string }) {
  return <div role="status"><p className="card-eyebrow">渲染降级</p><h3>暂不支持的组件</h3><p>{type}</p></div>
}

function componentVisible(component: ComponentSpec, driving: boolean | undefined): boolean {
  if (!component.visibility || component.visibility === 'always') return true
  // Conditional components are safety-sensitive; hide them until the caller
  // has an authoritative driving/parked signal.
  if (driving === undefined) return false
  return component.visibility === 'driving-only' ? driving : !driving
}

function layoutGap(spec: UISpec): string {
  return 'gap' in spec.layout ? spec.layout.gap : 'lg'
}

function layoutStyle(spec: UISpec): CSSProperties | undefined {
  if (spec.layout.type !== 'split') return undefined
  return { gridTemplateColumns: `${spec.layout.ratio[0]}fr ${spec.layout.ratio[1]}fr` }
}

function themeStyle(theme: UISpec['presentation']['theme']): CSSProperties {
  return theme === 'light'
    ? { backgroundColor: '#e8ede5', color: '#102019' }
    : { backgroundColor: '#091410', color: '#f4f0e5' }
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function clampPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)))
}
