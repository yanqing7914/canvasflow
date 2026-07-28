import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyEvent,
  resolveConfirmation,
} from '@canvasflow/agent'
import { createSideEffectRuntime, resolveAuthorizedLandingContact } from '@canvasflow/tools'
import { composePickupSpec, type ComposerContext } from '@canvasflow/ui'
import type { AgentResponse, AirportPickupEvent, AirportPickupTaskState, TaskUpdateEnvelope, VehicleContext } from '@canvasflow/schema'
import type { SpeechControllerDeps } from '@canvasflow/voice'
import { advanceMainFlowStep, mainFlowTimeline } from './main-flow'
import { AgentApiClient, defaultDemoVehicleContext } from './agent-client'
import { UISpecRenderer } from './UISpecRenderer'
import { useVoice, type VoiceSubmitMeta } from './voice/useVoice'

const defaultClient = new AgentApiClient('/v1')
type DemoAgentApi = Pick<AgentApiClient, 'create' | 'event' | 'action' | 'confirmation'>
  & Partial<Pick<AgentApiClient, 'subscribeTaskUpdates'>>

const demoRuntime = createSideEffectRuntime()

/** Whether the Gateway accepted the input, plus any reply worth speaking. */
type InputOutcome = { sent: boolean; speak?: string }

/** Microphone copy per voice state, plus the disabled-entry case. */
const voiceButtonLabels = {
  unavailable: { aria: '语音入口暂不可用', text: '语音不可用' },
  idle: { aria: '开始语音输入', text: '语音' },
  listening: { aria: '停止语音输入', text: '正在聆听' },
  transcribing: { aria: '放弃这次语音输入', text: '待确认' },
  submitting: { aria: '正在提交语音内容', text: '提交中' },
  speaking: { aria: '打断语音播报并重新输入', text: '正在播报' },
  error: { aria: '重试语音输入', text: '语音出错' },
} as const

export default function App({
  api = defaultClient,
  initialTask,
  composeContext = {},
  initialVehicleContext = defaultDemoVehicleContext,
  voiceEnabled = true,
  speech,
}: {
  api?: DemoAgentApi
  initialTask?: AirportPickupTaskState
  composeContext?: ComposerContext
  initialVehicleContext?: VehicleContext
  /** Lets a test or a kiosk build turn the voice entry point off entirely. */
  voiceEnabled?: boolean
  /** Test seam for injecting fake Web Speech engines. */
  speech?: SpeechControllerDeps
}) {
  const localOnly = initialTask !== undefined || Object.keys(composeContext).length > 0
  const [response, setResponse] = useState<AgentResponse>()
  const [text, setText] = useState('我现在要去机场接妈妈和豆豆')
  const [stepIndex, setStepIndex] = useState(0)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [vehicleContext, setVehicleContext] = useState(initialVehicleContext)
  const pendingRef = useRef(false)
  const streamCursorRef = useRef(0)
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
  const remoteTaskId = response?.task.taskId

  useEffect(() => {
    if (localOnly || !remoteTaskId || !api.subscribeTaskUpdates) return
    const taskId = remoteTaskId
    streamCursorRef.current = 0
    const subscription = api.subscribeTaskUpdates(taskId, (update: TaskUpdateEnvelope) => {
      if (update.cursor <= streamCursorRef.current) return
      streamCursorRef.current = update.cursor
      setResponse((current) => {
        if (!current || current.task.taskId !== taskId) return current
        const taskChanged = update.snapshot.task.taskRevision > current.task.taskRevision
        const uiChanged = update.snapshot.ui.uiRevision > current.ui.uiRevision
        if (!taskChanged && !uiChanged) return current
        // SSE snapshots intentionally omit mutation effects; do not show stale receipts.
        return { ...current, task: update.snapshot.task, ui: update.snapshot.ui, effects: [] }
      })
    })
    return () => subscription.close()
  }, [api, localOnly, remoteTaskId])

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

  /** The Agent decides what to say; the client only decides whether to play it. */
  function spokenReply(next: AgentResponse): string | undefined {
    return next.assistant?.shouldSpeak ? next.assistant.text : undefined
  }

  /**
   * The single input path. Text and voice both arrive here, so voice never gets
   * its own interpretation of what the driver said — `meta` only tells the
   * Gateway where the words came from.
   */
  async function sendInput(value: string, meta?: VoiceSubmitMeta): Promise<InputOutcome> {
    const trimmed = value.trim()
    if (!trimmed || pendingRef.current) return { sent: false }
    if (!response && !localOnly) {
      const created = await run(() => api.create(trimmed, {
        vehicleContext,
        ...(meta ? { source: meta.source } : {}),
        ...(meta?.confidence === undefined ? {} : { confidence: meta.confidence }),
      }))
      if (!created) return { sent: false }
      setStepIndex(1)
      setText('')
      return { sent: true, speak: spokenReply(created) }
    }
    if (!response) {
      setLocalTask((current) => current ? applyEvent(current, {
        eventId: `demo-input-${Date.now()}`,
        type: 'user.input',
        text: trimmed,
        timestamp: new Date().toISOString(),
      }, demoRuntime.preferences) : current)
      setText('')
      return { sent: true }
    }
    const nextTimelineIndex = nextIndexForTimelineEvent('user.input')
    const next = await run(() => api.event(response.task, { type: 'user.input', text: trimmed }))
    if (!next) return { sent: false }
    if (nextTimelineIndex !== undefined) setStepIndex(nextTimelineIndex)
    setText('')
    return { sent: true, speak: spokenReply(next) }
  }

  async function submitVoiceTranscript(transcript: string, meta: VoiceSubmitMeta) {
    const outcome = await sendInput(transcript, meta)
    // A refused turn must not lose what the driver said: park the transcript in
    // the text field so 发送 can retry it without speaking again.
    if (!outcome.sent) setText(transcript)
    return outcome.speak
  }

  const voice = useVoice({
    enabled: voiceEnabled,
    onTranscript: submitVoiceTranscript,
    speech,
  })
  const voiceTranscript = voice.state === 'transcribing' ? voice.transcript : undefined

  // A finished transcript lands in the existing text field rather than in a
  // second input: one place to read, one place to correct, one 发送 to confirm.
  useEffect(() => {
    if (voiceTranscript === undefined) return
    setText(voiceTranscript)
  }, [voiceTranscript])

  function submitText() {
    // While a transcript is awaiting confirmation, 发送 confirms it through the
    // machine so the voice loop keeps its state instead of being bypassed.
    if (voice.state === 'transcribing') {
      voice.submit(text)
      return
    }
    void sendInput(text)
  }

  function changeText(value: string) {
    setText(value)
    // Editing a transcript is still the same turn; tell the machine so the
    // engine's confidence is dropped along with its guess.
    if (voice.state === 'transcribing') voice.edit(value)
  }

  function pressMicrophone() {
    // Confirming is 发送's job, so here the button only leaves the voice turn.
    // The transcript stays in the text field on purpose.
    if (voice.state === 'transcribing') {
      voice.cancel()
      return
    }
    voice.press()
  }

  function advance() {
    if (pendingRef.current) return
    if (!response) {
      if (!localOnly) return
      setLocalTask((current) => current ? advanceMainFlowStep(current, demoRuntime.preferences) : current)
      return
    }
    void advanceApiFlow(response)
  }

  async function advanceApiFlow(current: AgentResponse) {
    const index = stepIndex
    const step = mainFlowTimeline.steps[index]
    if (!step) return
    const request = step.event.type === 'navigation.started'
      ? api.action(current, 'start-navigation', 'navigation-plan')
      : api.event(current.task, { ...step.event, timestamp: undefined })
    const next = await run(() => request)
    if (!next) return
    updateVehicleContext(step.event)
    setStepIndex(consumeAdvisoryContext(index + 1))
  }

  function consumeAdvisoryContext(startIndex: number) {
    let index = startIndex
    let step = mainFlowTimeline.steps[index]
    while (step?.advisory) {
      updateVehicleContext(step.event)
      index += 1
      step = mainFlowTimeline.steps[index]
    }
    return index
  }

  function updateVehicleContext(event: AirportPickupEvent) {
    if (event.type === 'vehicle.moving') {
      setVehicleContext((current) => ({ ...current, speedKph: event.speedKph, gear: 'D' }))
    } else if (event.type === 'vehicle.parked') {
      setVehicleContext((current) => ({ ...current, speedKph: 0, gear: 'P' }))
    }
  }

  function handleAction(actionId: string, componentId: string) {
    if (pendingRef.current) return
    if (!response) {
      if (!localOnly) return
      setLocalTask((current) => {
        if (!current) return current
        if (actionId === 'save-trip-preferences') return resolveConfirmation(current, `${current.taskId}:save-memory`)
        // Provider-backed retries are only executable through the Agent API.
        if (actionId === 'retry-landing-message' || actionId === 'confirm-retry-landing-message') return current
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
        if (!next || nextTimelineIndex === undefined) return
        setStepIndex(consumeAdvisoryContext(nextTimelineIndex))
      })
    }
  }

  function nextIndexForTimelineEvent(type: AirportPickupEvent['type']): number | undefined {
    const index = mainFlowTimeline.steps.findIndex((step, candidateIndex) =>
      candidateIndex >= stepIndex && !step.advisory && step.event.type === type,
    )
    return index === -1 ? undefined : index + 1
  }

  const micState = voice.available ? voice.state : 'unavailable'
  const microphoneCopy = voiceButtonLabels[micState]
  // One polite live region for the whole voice loop, so the mic state and the
  // interim words reach a screen reader without competing announcements.
  const voiceStatus = voice.error?.message
    ?? (voice.state === 'listening'
      ? voice.display || '正在聆听…'
      : voice.state === 'transcribing'
        ? '已转写，确认或编辑后发送。'
        : voice.state === 'submitting'
          ? '正在提交…'
          : voice.state === 'speaking'
            ? voice.speaking ?? '正在播报'
            : '')

  return <main className="demo-shell">
    <header><p className="eyebrow">CanvasFlow / Agent API</p><h1>机场接人任务卡片</h1><p>文本、Action、confirmation 与时间线事件统一通过 Gateway。</p></header>
    <section className="prompt" aria-label="Agent input"><input aria-label="任务输入" value={text} disabled={pending} onChange={(event) => changeText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitText() }} placeholder="告诉我接谁、航班号或下一步" /><button
      type="button"
      className={`mic-button mic-${micState}`}
      aria-label={microphoneCopy.aria}
      aria-pressed={micState === 'listening'}
      disabled={!voice.available || pending || micState === 'submitting'}
      onClick={pressMicrophone}
    >{microphoneCopy.text}</button><button type="button" onClick={submitText} disabled={pending}>发送</button></section>
    {/* Rendered unconditionally so the region exists before the first announcement. */}
    <p className="voice-status" role="status" aria-label="语音状态" aria-live="polite">{voiceStatus}</p>
    <section className="console" aria-label="Event console"><div><span className="label">阶段</span><strong>{spec?.title ?? '等待创建任务'}</strong><small>{task ? `${task.phase} · taskRevision ${task.taskRevision} · uiRevision ${spec?.uiRevision}` : '尚无任务'}</small></div><button type="button" onClick={advance} disabled={pending || (!response && !localOnly) || !task || task.phase === 'completed' || task.phase === 'cancelled'}>推进下一事件</button></section>
    {error && <p role="alert">{error}</p>}
    {spec && task && <UISpecRenderer
      driving={vehicleContext.speedKph > 0 || vehicleContext.gear !== 'P'}
      onAction={handleAction}
      pending={pending}
      spec={spec}
    />}
    {effects.length > 0 && <p className="effects" aria-label="Effect receipts">{effects.map((effect) => `${effect.type}:${effect.status}`).join(' · ')}</p>}
  </main>
}
