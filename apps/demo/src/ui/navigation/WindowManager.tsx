import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { UISpec } from '@canvasflow/schema'
import { UISpecRenderer } from '../UISpecRenderer'
import type { NavigationSnapshot } from './simulator'
import { workspaceWindows, windowUISpec, type CockpitWindowKind, type CockpitWindowSpec } from './contracts'
import { createWindowManagerState, managedWindowSize, windowManagerReducer } from './window-manager'

export type WindowManagerProps = {
  spec: UISpec
  pending: boolean
  driving: boolean
  vehicle: NavigationSnapshot
  onAction: (actionId: string, componentId: string) => void
  clear: boolean
  preserveMissing?: boolean
  onWindowClose?: (windowId: string) => void
}

type DragState = { id: string; startX: number; startY: number; originX: number; originY: number }

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight }
}

export function WindowManager({ spec, pending, driving, vehicle, onAction, clear, preserveMissing = false, onWindowClose }: WindowManagerProps) {
  const [state, dispatch] = useReducer(windowManagerReducer, undefined, createWindowManagerState)
  const frozenSpecs = useRef(new Map<string, UISpec>())
  const previousFocus = useRef(new Map<string, HTMLElement | null>())
  const windowRefs = useRef(new Map<string, HTMLElement>())
  const drag = useRef<DragState | undefined>(undefined)
  const incoming = useMemo(() => workspaceWindows(spec), [spec])

  useEffect(() => {
    if (clear) {
      frozenSpecs.current.clear()
      dispatch({ type: 'clear' })
      return
    }
    if (!preserveMissing) {
      const incomingIds = new Set(incoming.map((windowSpec) => windowSpec.id))
      for (const id of frozenSpecs.current.keys()) {
        if (!incomingIds.has(id)) frozenSpecs.current.delete(id)
      }
    }
    for (const windowSpec of incoming) {
      if (!frozenSpecs.current.has(windowSpec.id)) frozenSpecs.current.set(windowSpec.id, windowUISpec(spec, windowSpec))
    }
    dispatch({ type: 'sync', specs: incoming, viewport: viewport(), preserveMissing })
  }, [clear, incoming, preserveMissing, spec])

  useEffect(() => {
    const newest = state.windows
      .filter((window) => !previousFocus.current.has(window.spec.id))
      .sort((left, right) => right.zIndex - left.zIndex)[0]
    if (!newest) return
    previousFocus.current.set(newest.spec.id, document.activeElement instanceof HTMLElement ? document.activeElement : null)
    windowRefs.current.get(newest.spec.id)?.focus()
  }, [state.windows])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = drag.current
      if (!active) return
      dispatch({
        type: 'move', id: active.id,
        x: active.originX + event.clientX - active.startX,
        y: active.originY + event.clientY - active.startY,
        viewport: viewport(),
      })
    }
    const stop = () => { drag.current = undefined }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [])

  function close(windowSpec: CockpitWindowSpec) {
    dispatch({ type: 'close', id: windowSpec.id })
    frozenSpecs.current.delete(windowSpec.id)
    onWindowClose?.(windowSpec.id)
    queueMicrotask(() => previousFocus.current.get(windowSpec.id)?.focus())
  }

  return (
    <section className="cockpit-windows" aria-label="行程信息窗口">
      <p className="sr-only" role="status" aria-live="polite">{state.announcement}</p>
      {state.windows.map((window) => {
        const frozen = frozenSpecs.current.get(window.spec.id)
        const activeActions = new Map(spec.actions.map((action) => [action.id, action]))
        const renderedSpec = frozen ? {
          ...frozen,
          actions: frozen.actions.flatMap((action) => {
            const current = activeActions.get(action.id)
            return current ? [current] : []
          }),
        } : undefined
        const size = managedWindowSize(window.spec)
        const maximized = window.mode === 'maximized'
        const minimized = window.mode === 'minimized'
        return (
          <article
            ref={(node) => { if (node) windowRefs.current.set(window.spec.id, node); else windowRefs.current.delete(window.spec.id) }}
            className="cockpit-window"
            data-kind={window.spec.kind}
            data-mode={window.mode}
            key={window.spec.id}
            aria-label={`${window.spec.title}窗口`}
            tabIndex={-1}
            style={maximized ? { zIndex: window.zIndex } : {
              '--window-x': `${window.x}px`, '--window-y': `${window.y}px`,
              '--window-width': `${size.width}px`, '--window-height': `${size.height}px`, zIndex: window.zIndex,
            } as React.CSSProperties}
            onPointerDown={() => dispatch({ type: 'focus', id: window.spec.id })}
          >
            <header
              className="cockpit-window__chrome"
              onPointerDown={(event) => {
                if (maximized || event.button !== 0 || (event.target as HTMLElement).closest('button')) return
                drag.current = { id: window.spec.id, startX: event.clientX, startY: event.clientY, originX: window.x, originY: window.y }
              }}
            >
              <span className="cockpit-window__signal" aria-hidden="true" />
              <h2>{window.spec.title}</h2>
              <div className="cockpit-window__controls">
                {window.spec.controls.minimizable && (
                  <button type="button" aria-label={minimized ? `恢复${window.spec.title}窗口` : `最小化${window.spec.title}窗口`} onClick={() => dispatch({ type: minimized ? 'restore' : 'minimize', id: window.spec.id })}>
                    <span aria-hidden="true">{minimized ? '□' : '—'}</span>
                  </button>
                )}
                {window.spec.controls.maximizable && (
                  <button type="button" aria-label={maximized ? `还原${window.spec.title}窗口` : `放大${window.spec.title}窗口`} onClick={() => dispatch({ type: 'toggle-maximize', id: window.spec.id })}>
                    <span aria-hidden="true">{maximized ? '↙' : '↗'}</span>
                  </button>
                )}
                {window.spec.controls.closable && (
                  <button type="button" aria-label={`关闭${window.spec.title}窗口`} onClick={() => close(window.spec)}>
                    <span aria-hidden="true">×</span>
                  </button>
                )}
              </div>
            </header>
            {!minimized && (
              <div className="cockpit-window__body">
                {window.spec.kind === 'vehicle-status' && <VehicleStatus vehicle={vehicle} />}
                {window.spec.kind === 'processing' && <OperationStatus kind="processing" renderedSpec={renderedSpec} />}
                {window.spec.kind === 'error' && <OperationStatus kind="error" renderedSpec={renderedSpec} onAction={onAction} pending={pending} />}
                {window.spec.kind !== 'vehicle-status' && renderedSpec && renderedSpec.components.length > 0
                  && window.spec.kind !== 'processing' && window.spec.kind !== 'error'
                  ? <UISpecRenderer driving={driving} pending={pending} spec={renderedSpec} onAction={onAction} />
                  : window.spec.kind !== 'vehicle-status' && window.spec.kind !== 'processing' && window.spec.kind !== 'error'
                    && <WindowEmpty kind={window.spec.kind} />}
              </div>
            )}
          </article>
        )
      })}
    </section>
  )
}

function OperationStatus({
  kind,
  renderedSpec,
  onAction,
  pending = false,
}: {
  kind: 'processing' | 'error'
  renderedSpec?: UISpec
  onAction?: WindowManagerProps['onAction']
  pending?: boolean
}) {
  const component = renderedSpec?.components.find((candidate) => candidate.type === 'status-banner')
  const action = kind === 'error' ? renderedSpec?.actions[0] : undefined
  const title = component?.type === 'status-banner'
    ? component.props.title
    : kind === 'processing' ? '正在处理' : '操作未完成'
  const message = component?.type === 'status-banner'
    ? component.props.message
    : kind === 'processing' ? '地图和车辆仍在继续。' : '地图和导航仍在继续。'
  return (
    <div className="cockpit-operation" role={kind === 'error' ? 'alert' : 'status'} aria-live={kind === 'error' ? 'assertive' : 'polite'}>
      <span className="cockpit-operation__pulse" aria-hidden="true" />
      <strong>{title}</strong>
      {message && <p>{message}</p>}
      {action && component && onAction ? (
        <button
          className="ui-action ui-action--primary"
          type="button"
          disabled={pending}
          onClick={() => onAction(action.id, component.id)}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

function VehicleStatus({ vehicle }: { vehicle: NavigationSnapshot }) {
  return (
    <dl className="vehicle-status-grid" aria-label="实时车辆状态">
      <div><dt>当前车速</dt><dd>{Math.round(vehicle.speedKph)} km/h</dd></div>
      <div><dt>当前电量</dt><dd>{Math.round(vehicle.batteryPercent)}%</dd></div>
      <div><dt>剩余续航</dt><dd>{Math.round(vehicle.remainingRangeKm)} km</dd></div>
      <div><dt>剩余距离</dt><dd>{vehicle.remainingDistanceKm.toFixed(1)} km</dd></div>
      <div><dt>当前道路</dt><dd>{vehicle.road}</dd></div>
      <div><dt>当前目的地</dt><dd>{vehicle.destination}</dd></div>
      <div><dt>速度档位</dt><dd>{vehicle.speedTier === 'fast' ? '快速' : vehicle.speedTier === 'slow' ? '慢速' : '正常'}</dd></div>
      <div><dt>行驶状态</dt><dd>{vehicle.runState === 'driving' ? '正在导航' : vehicle.runState === 'arrived' ? '已到达' : '等待出发'}</dd></div>
    </dl>
  )
}

function WindowEmpty({ kind }: { kind: CockpitWindowKind }) {
  const copy: Record<CockpitWindowKind, string> = {
    'flight-list': '航班信息暂时无法显示，请重新查询。',
    'outbound-confirmation': '出发方案正在准备。',
    weather: '天气结果暂时无法显示，请重新查询。',
    charging: '充电方案暂时无法显示，请重新查询。',
    calendar: '日历结果暂时无法显示，请重新查询。',
    'flight-detail': '当前航班详情暂时无法显示。',
    'passenger-onboard': '已记录乘客上车。',
    'return-confirmation': '返程方案正在准备。',
    'vehicle-status': '车辆状态暂时不可用。',
    processing: '正在处理，请稍候。',
    error: '这项操作暂时没有完成，地图和导航仍在继续。',
  }
  return <p className="cockpit-window__empty" role={kind === 'error' ? 'alert' : 'status'}>{copy[kind]}</p>
}
