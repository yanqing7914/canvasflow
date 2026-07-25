import { useMemo, useRef, useState } from 'react'
import {
  applyEvent,
  armLandingMessageRetry,
  resolveConfirmation,
  resolveLandingMessageRetry,
} from '@canvasflow/agent'
import { createSideEffectRuntime, resolveAuthorizedLandingContact } from '@canvasflow/tools'
import { composePickupSpec, type ComposerContext } from '@canvasflow/ui'
import type { AgentResponse, AirportPickupEvent, AirportPickupTaskState } from '@canvasflow/schema'
import { advanceMainFlowStep, mainFlowTimeline } from './main-flow'
import { AgentApiClient } from './agent-client'
import { UISpecRenderer } from './UISpecRenderer'

const defaultClient = new AgentApiClient('/v1')
type DemoAgentApi = Pick<AgentApiClient, 'create' | 'event' | 'action' | 'confirmation'>

const demoRuntime = createSideEffectRuntime()

export default function App({
  api = defaultClient,
  initialTask,
  composeContext = {},
}: {
  api?: DemoAgentApi
  initialTask?: AirportPickupTaskState
  composeContext?: ComposerContext
}) {
  const localOnly = initialTask !== undefined || Object.keys(composeContext).length > 0
  const [response, setResponse] = useState<AgentResponse>()
  const [text, setText] = useState('我现在要去机场接妈妈和豆豆')
  const [stepIndex, setStepIndex] = useState(0)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [localTask, setLocalTask] = useState<AirportPickupTaskState | undefined>(
    localOnly ? (initialTask ?? mainFlowTimeline.initialTaskState) : undefined,
  )
  // Fixture-only injection is used by unit tests; the shipped demo leaves these props unset.
  const task = response?.task ?? localTask
  const localSpec = useMemo(() => task ? composePickupSpec(task, {
    ...composeContext,
    landingMessageRetryAvailable: composeContext.landingMessageRetryAvailable
      ?? Boolean(resolveAuthorizedLandingContact(task.passengers.memberIds, demoRuntime.preferences)),
  }) : undefined, [composeContext, task])
  const spec = response?.ui ?? localSpec
  const effects = useMemo(() => response?.effects ?? [], [response])

  async function run(operation: () => Promise<AgentResponse>): Promise<AgentResponse | undefined> {
    if (pendingRef.current) return undefined
    pendingRef.current = true
    setPending(true)
    setError(undefined)
    try {
      const next = await operation()
      setResponse(next)
      return next
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请求失败')
      return undefined
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  function submitText() {
    const value = text.trim()
    if (!value || pendingRef.current) return
    if (!response && !localOnly) {
      void run(() => api.create(value)).then((created) => {
        if (created) {
          setStepIndex(1)
          setText('')
        }
      })
    } else if (!response) {
      setLocalTask((current) => current ? applyEvent(current, {
        eventId: `demo-input-${Date.now()}`,
        type: 'user.input',
        text: value,
        timestamp: new Date().toISOString(),
      }, demoRuntime.preferences) : current)
      setText('')
    } else {
      const nextTimelineIndex = nextIndexForTimelineEvent('user.input')
      void run(() => api.event(response.task, { type: 'user.input', text: value })).then((next) => {
        if (next) {
          if (nextTimelineIndex !== undefined) setStepIndex(nextTimelineIndex)
          setText('')
        }
      })
    }
  }

  function advance() {
    if (pendingRef.current) return
    if (!response) {
      if (!localOnly) return
      setLocalTask((current) => current ? advanceMainFlowStep(current, demoRuntime.preferences) : current)
      return
    }
    const step = mainFlowTimeline.steps.slice(stepIndex).find((candidate) => !candidate.advisory)
    if (!step) return
    const index = mainFlowTimeline.steps.indexOf(step)
    const request = step.event.type === 'navigation.started'
      ? api.action(response, 'start-navigation', 'navigation-plan')
      : api.event(response.task, { ...step.event, timestamp: undefined })
    void run(() => request).then((next) => {
      if (next) setStepIndex(index + 1)
    })
  }

  function handleAction(actionId: string, componentId: string) {
    if (pendingRef.current) return
    if (!response) {
      if (!localOnly) return
      setLocalTask((current) => {
        if (!current) return current
        if (actionId === 'save-trip-preferences') return resolveConfirmation(current, `${current.taskId}:save-memory`)
        if (actionId === 'retry-landing-message') return armLandingMessageRetry(current, demoRuntime) ?? current
        if (actionId === 'confirm-retry-landing-message') {
          const confirmationId = current.pendingConfirmation?.confirmationId
          if (!confirmationId) return current
          const resolved = resolveLandingMessageRetry(current, demoRuntime, confirmationId, 'accept', new Date().toISOString())
          if (!resolved || resolved.decision === 'reject') return resolved?.task ?? current
          return applyEvent(resolved.task, resolved.event, demoRuntime.preferences)
        }
        return current
      })
      return
    }
    const action = response.ui.actions.find((candidate) => candidate.id === actionId)
    const actionEvent = action?.event
    if (actionEvent?.type === 'confirmation') {
      void run(() => api.confirmation(response.task, actionEvent.confirmationId, actionEvent.decision))
    } else {
      const nextTimelineIndex = actionId === 'start-navigation'
        ? nextIndexForTimelineEvent('navigation.started')
        : undefined
      void run(() => api.action(response, actionId, componentId)).then((next) => {
        if (next && nextTimelineIndex !== undefined) setStepIndex(nextTimelineIndex)
      })
    }
  }

  function nextIndexForTimelineEvent(type: AirportPickupEvent['type']): number | undefined {
    const index = mainFlowTimeline.steps.findIndex((step, candidateIndex) =>
      candidateIndex >= stepIndex && !step.advisory && step.event.type === type,
    )
    return index === -1 ? undefined : index + 1
  }

  return <main className="demo-shell">
    <header><p className="eyebrow">CanvasFlow / Agent API</p><h1>机场接人任务卡片</h1><p>文本、Action、confirmation 与时间线事件统一通过 Gateway。</p></header>
    <section className="prompt" aria-label="Agent input"><input aria-label="任务输入" value={text} disabled={pending} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitText() }} placeholder="告诉我接谁、航班号或下一步" /><button type="button" onClick={submitText} disabled={pending}>发送</button></section>
    <section className="console" aria-label="Event console"><div><span className="label">阶段</span><strong>{spec?.title ?? '等待创建任务'}</strong><small>{task ? `${task.phase} · taskRevision ${task.taskRevision} · uiRevision ${spec?.uiRevision}` : '尚无任务'}</small></div><button type="button" onClick={advance} disabled={pending || (!response && !localOnly) || !task || task.phase === 'completed' || task.phase === 'cancelled'}>推进下一事件</button></section>
    {error && <p role="alert">{error}</p>}
    {spec && task && <UISpecRenderer onAction={handleAction} pending={pending} spec={spec} />}
    {effects.length > 0 && <p className="effects" aria-label="Effect receipts">{effects.map((effect) => `${effect.type}:${effect.status}`).join(' · ')}</p>}
  </main>
}
