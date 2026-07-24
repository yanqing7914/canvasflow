import { useMemo, useState } from 'react'
import {
  applyEvent,
  armLandingMessageRetry,
  resolveConfirmation,
  resolveLandingMessageRetry,
} from '@canvasflow/agent'
import { createSideEffectRuntime, resolveAuthorizedLandingContact } from '@canvasflow/tools'
import { composePickupSpec, type ComposerContext } from '@canvasflow/ui'
import type { AirportPickupTaskState, ComponentSpec } from '@canvasflow/schema'
import { advanceMainFlowStep, mainFlowTimeline } from './main-flow'

const demoRuntime = createSideEffectRuntime()

function createDemoTask(): AirportPickupTaskState {
  return mainFlowTimeline.initialTaskState
}

function componentSummary(component: ComponentSpec): string {
  switch (component.type) {
    case 'pickup-overview': return `${component.props.passengers.join('、')} · ${component.props.flightNumber} · ${component.props.airport} ${component.props.terminal}`
    case 'task-progress': return component.props.steps.map((step) => `${step.label} ${step.status}`).join(' / ')
    case 'status-banner': return component.props.message ?? component.props.title
    case 'flight-status': return `${component.props.flightNumber} · ${component.props.status} · ${component.props.terminal}`
    case 'navigation-summary': return `${component.props.destination} · ETA ${component.props.eta}`
    case 'charging-recommendation':
      return `${component.props.reason} · ${component.props.currentBatteryPercent}% → ${component.props.estimatedFinalBatteryPercent}%`
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
  const spec = useMemo(() => composePickupSpec(task, {
    ...composeContext,
    landingMessageRetryAvailable:
      composeContext.landingMessageRetryAvailable
      ?? Boolean(resolveAuthorizedLandingContact(task.passengers.memberIds, demoRuntime.preferences)),
  }), [task, composeContext])
  const advance = () => {
    setTask((current) => advanceMainFlowStep(current, demoRuntime.preferences))
  }
  const handleAction = (actionId: string) => {
    if (actionId === 'save-trip-preferences') {
      setTask((current) => resolveConfirmation(current, `${current.taskId}:save-memory`))
      return
    }
    if (actionId === 'retry-landing-message') {
      setTask((current) => armLandingMessageRetry(current, demoRuntime) ?? current)
      return
    }
    if (actionId === 'confirm-retry-landing-message') {
      setTask((current) => {
        const confirmationId = current.pendingConfirmation?.confirmationId
        if (!confirmationId) return current
        const resolved = resolveLandingMessageRetry(
          current,
          demoRuntime,
          confirmationId,
          'accept',
          '2026-07-22T20:42:00+08:00',
        )
        if (!resolved) return current
        if (resolved.decision === 'reject') return resolved.task
        return applyEvent(resolved.task, resolved.event, demoRuntime.preferences)
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
