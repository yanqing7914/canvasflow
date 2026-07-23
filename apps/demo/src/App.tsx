import { useMemo, useState } from 'react'
import { applyEvent, createInitialTask, resolveConfirmation } from '@canvasflow/agent'
import { composePickupSpec } from '@canvasflow/ui'
import type { AirportPickupEvent, AirportPickupTaskState, ComponentSpec } from '@canvasflow/schema'

const timeline: AirportPickupEvent[] = [
  { eventId: 'start-navigation', type: 'navigation.started', routeId: 'route-airport-001', timestamp: '2026-07-22T20:05:00+08:00' },
  { eventId: 'flight-landed', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' },
  { eventId: 'airport-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T20:41:00+08:00' },
  { eventId: 'vehicle-parked', type: 'vehicle.parked', timestamp: '2026-07-22T20:45:00+08:00' },
  { eventId: 'passengers-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T20:55:00+08:00' },
  { eventId: 'trip-completed', type: 'destination.arrived', destination: '家', timestamp: '2026-07-22T21:35:00+08:00' },
]

function createDemoTask(): AirportPickupTaskState {
  return {
    ...createInitialTask(),
    passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
    flight: { flightNumber: 'MU5102', status: 'scheduled', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
    phase: 'preparing',
    taskRevision: 1,
  }
}

function componentSummary(component: ComponentSpec): string {
  switch (component.type) {
    case 'pickup-overview': return `${component.props.passengers.join('、')} · ${component.props.flightNumber} · ${component.props.airport} ${component.props.terminal}`
    case 'task-progress': return component.props.steps.map((step) => `${step.label} ${step.status}`).join(' / ')
    default: return component.type
  }
}

function componentTitle(component: ComponentSpec): string {
  return component.type === 'pickup-overview' ? component.props.phaseLabel : '任务进度'
}

export default function App({ initialTask = createDemoTask() }: { initialTask?: AirportPickupTaskState }) {
  const [task, setTask] = useState<AirportPickupTaskState>(initialTask)
  const spec = useMemo(() => composePickupSpec(task), [task])
  const advance = () => {
    const candidate = timeline
      .map((event) => ({ event, next: applyEvent(task, event) }))
      .find(({ event, next }) => !task.processedEventIds.includes(event.eventId) && next.processedEventIds.includes(event.eventId))
    if (candidate) setTask(candidate.next)
  }
  const handleAction = (actionId: string) => {
    if (actionId === 'save-trip-preferences') {
      setTask((current) => resolveConfirmation(current, `${current.taskId}:save-memory`))
    }
  }

  return <main className="demo-shell">
    <header><p className="eyebrow">CanvasFlow / Fixture mode</p><h1>机场接人任务卡片</h1><p>同一个 taskId 随事件演化，UI 只渲染受约束的 UISpec。</p></header>
    <section className="console" aria-label="Event console"><div><span className="label">阶段</span><strong>{spec.title}</strong><small>{task.phase} · taskRevision {task.taskRevision} · uiRevision {spec.uiRevision}</small></div><button type="button" onClick={advance} disabled={task.phase === 'completed' || task.phase === 'cancelled'}>推进下一事件</button></section>
    <section className="cards">{spec.components.map((component) => <article key={component.id}><span className="tag">{component.type}</span><h2>{componentTitle(component)}</h2><p>{componentSummary(component)}</p></article>)}</section>
    {spec.actions.length > 0 && <section className="actions" aria-label="Task actions">{spec.actions.map((action) => <button key={action.id} type="button" onClick={() => handleAction(action.id)}>{action.label}</button>)}</section>}
  </main>
}
