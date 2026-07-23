import { useMemo, useState } from 'react'
import { applyEvent, createInitialTask, resolveConfirmation } from '@canvasflow/agent'
import { createProviderRegistry, createSideEffectRuntime, familyMembers, issueSendMessageConfirmation, prepareMessage } from '@canvasflow/tools'
import { composePickupSpec, type ComposerContext } from '@canvasflow/ui'
import type { AirportPickupEvent, AirportPickupTaskState, ComponentSpec } from '@canvasflow/schema'

const demoRuntime = createSideEffectRuntime()
const demoRegistry = createProviderRegistry(demoRuntime)

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
    case 'status-banner': return component.props.message ?? component.props.title
    case 'flight-status': return `${component.props.flightNumber} · ${component.props.status} · ${component.props.terminal}`
    case 'navigation-summary': return `${component.props.destination} · ETA ${component.props.eta}`
    case 'charging-recommendation': return component.props.reason
    case 'message-preview': return `${component.props.contactLabel}：${component.props.textPreview}`
    case 'passenger-status': return component.props.meetingPoint ? `${component.props.label} · ${component.props.meetingPoint}` : component.props.label
    case 'cabin-profile': {
      const parts: string[] = []
      if (component.props.temperatureC !== undefined) parts.push(`${component.props.temperatureC}°C`)
      if (component.props.fanLevel !== undefined) parts.push(`风速 ${component.props.fanLevel}`)
      if (component.props.mediaTitle) parts.push(component.props.mediaTitle)
      return parts.join(' · ')
    }
    case 'alert': return component.props.message ?? component.props.title
  }
}

function componentTitle(component: ComponentSpec): string {
  switch (component.type) {
    case 'pickup-overview': return component.props.phaseLabel
    case 'status-banner': return component.props.title
    case 'flight-status': return '航班状态'
    case 'navigation-summary': return '导航路线'
    case 'charging-recommendation': return '补能建议'
    case 'message-preview': return '落地通知'
    case 'passenger-status': return '乘客状态'
    case 'cabin-profile': return '家庭座舱偏好'
    case 'task-progress': return '任务进度'
    case 'alert': return component.props.title
  }
}

export default function App({
  initialTask = createDemoTask(),
  composeContext = {},
}: {
  initialTask?: AirportPickupTaskState
  composeContext?: ComposerContext
}) {
  const [task, setTask] = useState<AirportPickupTaskState>(initialTask)
  const spec = useMemo(() => composePickupSpec(task, composeContext), [task, composeContext])
  const advance = () => {
    const candidate = timeline
      .map((event) => ({ event, next: applyEvent(task, event) }))
      .find(({ event, next }) => !task.processedEventIds.includes(event.eventId) && next.processedEventIds.includes(event.eventId))
    if (candidate) setTask(candidate.next)
  }
  const handleAction = (actionId: string) => {
    if (actionId === 'save-trip-preferences') {
      setTask((current) => resolveConfirmation(current, `${current.taskId}:save-memory`))
      return
    }
    if (actionId === 'retry-landing-message') {
      setTask((current) => {
        if (current.message.status !== 'failed' || !current.flight) return current
        const contactId = current.passengers.memberIds
          .map((memberId) => familyMembers.find((member) => member.memberId === memberId)?.contactId)
          .find((id): id is string => typeof id === 'string')
        if (!contactId) return current
        const ctx = { taskId: current.taskId }
        const prepared = prepareMessage(ctx, {
          contactId,
          flightNumber: current.flight.flightNumber,
          eta: '20:40',
        })
        if (!prepared.ok || !prepared.data) return current

        const pendingMessageId = `${current.flight.flightNumber}:landing`
        const armed: AirportPickupTaskState = {
          ...current,
          message: {
            ...current.message,
            status: 'scheduled',
            pendingMessageId,
            idempotencyKey: prepared.data.messageId,
            landingNoticeSent: false,
          },
        }
        const binding = {
          taskId: current.taskId,
          contactId: prepared.data.contactId,
          messageId: prepared.data.messageId,
          text: prepared.data.text,
        }
        const confirmationId = issueSendMessageConfirmation(demoRuntime, binding)
        const sent = demoRegistry['message.send'](ctx, {
          ...binding,
          confirmationId,
          idempotencyKey: `${prepared.data.messageId}:retry`,
        })
        if (!sent.ok) {
          return applyEvent(armed, {
            eventId: `retry-failed-${current.taskRevision}`,
            type: 'message.failed',
            messageId: pendingMessageId,
            errorCode: sent.error?.code ?? 'SEND_FAILED',
            timestamp: '2026-07-22T20:42:00+08:00',
          })
        }
        return applyEvent(armed, {
          eventId: `retry-sent-${current.taskRevision}`,
          type: 'message.sent',
          messageId: pendingMessageId,
          timestamp: '2026-07-22T20:42:00+08:00',
        })
      })
    }
  }

  return <main className="demo-shell">
    <header><p className="eyebrow">CanvasFlow / Fixture mode</p><h1>机场接人任务卡片</h1><p>同一个 taskId 随事件演化，UI 只渲染受约束的 UISpec。</p></header>
    <section className="console" aria-label="Event console"><div><span className="label">阶段</span><strong>{spec.title}</strong><small>{task.phase} · taskRevision {task.taskRevision} · uiRevision {spec.uiRevision}</small></div><button type="button" onClick={advance} disabled={task.phase === 'completed' || task.phase === 'cancelled'}>推进下一事件</button></section>
    <section className="cards">{spec.components.map((component) => <article key={component.id}><span className="tag">{component.type}</span><h2>{componentTitle(component)}</h2><p>{componentSummary(component)}</p></article>)}</section>
    {spec.actions.length > 0 && <section className="actions" aria-label="Task actions">{spec.actions.map((action) => <button key={action.id} type="button" onClick={() => handleAction(action.id)}>{action.label}</button>)}</section>}
  </main>
}
