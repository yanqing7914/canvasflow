import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyEvent,
  resolveConfirmation,
} from '@canvasflow/agent'
import { createSideEffectRuntime, resolveAuthorizedLandingContact } from '@canvasflow/tools'
import { composePickupSpec, type ComposerContext } from '@canvasflow/ui'
import type {
  AgentResponse,
  AirportPickupEvent,
  AirportPickupTaskState,
  TaskUpdateEnvelope,
  UISpec,
  VehicleContext,
} from '@canvasflow/schema'
import type { SpeechControllerDeps } from '@canvasflow/voice'
import { advanceMainFlowStep, mainFlowTimeline } from './main-flow'
import { AgentApiClient, defaultDemoVehicleContext } from './agent-client'
import { ArrowRightIcon, CloseIcon, ControlsIcon, MicIcon } from './ui/icons'
import { UISpecRenderer } from './ui'
import { useVoice, type VoiceSubmitMeta } from './voice/useVoice'

const defaultClient = new AgentApiClient('/v1')
type DemoAgentApi = Pick<AgentApiClient, 'create' | 'event' | 'action' | 'confirmation'>
  & Partial<Pick<AgentApiClient, 'subscribeTaskUpdates'>>

const demoRuntime = createSideEffectRuntime()

const playableEventIds = new Set(
  mainFlowTimeline.steps
    .filter((step) => !step.advisory)
    .map((step) => step.event.eventId),
)
const playableEventCount = playableEventIds.size

/**
 * The driver never reads a raw phase. This is a private display mapping; the
 * enum itself stays in the demo drawer where an engineer looks for it.
 */
const phaseIdentityLabels: Record<AirportPickupTaskState['phase'], string> = {
  'collecting-information': '准备接机',
  preparing: '准备出发',
  'driving-to-airport': '途中',
  'approaching-airport': '即将到达',
  'waiting-for-passengers': '等待家人',
  'returning-home': '家人已上车',
  completed: '行程结束',
  cancelled: '行程已取消',
}

const conclusionComponentTypes = new Set<UISpec['components'][number]['type']>([
  'flight-status',
  'navigation-summary',
  'charging-recommendation',
  'passenger-status',
  'message-preview',
  'cabin-profile',
  'status-banner',
  'alert',
])

const focusableControlSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function hasContextualTripTitle(spec: UISpec): boolean {
  // Keep the initial instruction and the completed result as the page title; elsewhere
  // the current card conclusion leads and the title steps back into trip context.
  if (spec.phase === 'collecting-information' && spec.meta.generatedBy !== 'fallback') return false
  if (spec.phase === 'completed') return false
  return spec.components.some((component) => conclusionComponentTypes.has(component.type))
}

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
  const [controlsOpen, setControlsOpen] = useState(false)
  const pendingRef = useRef(false)
  const streamCursorRef = useRef(0)
  const controlsTriggerRef = useRef<HTMLButtonElement>(null)
  const controlsDrawerRef = useRef<HTMLElement>(null)
  const controlsCloseRef = useRef<HTMLButtonElement>(null)
  const restoreControlsFocusRef = useRef(false)
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
  // While the microphone is capturing or its transcript is in flight, the field
  // still holds the *previous* turn's words. Sending those would create a task
  // from something the driver never meant to send, so the text path is closed
  // until the voice turn hands the words back. `transcribing` stays open on
  // purpose: that is where 发送 confirms.
  const textPathLocked = voice.state === 'listening' || voice.state === 'submitting'

  // A finished transcript lands in the existing text field rather than in a
  // second input: one place to read, one place to correct, one 发送 to confirm.
  useEffect(() => {
    if (voiceTranscript === undefined) return
    setText(voiceTranscript)
  }, [voiceTranscript])

  function submitText() {
    // The microphone owns the turn while it is capturing or submitting, so 发送
    // must not race it. See `textPathLocked`.
    if (textPathLocked) return
    // While a transcript is awaiting confirmation, 发送 confirms it through the
    // machine so the voice loop keeps its state instead of being bypassed.
    if (voice.state === 'transcribing') {
      voice.submit(text)
      return
    }
    // Answering by hand during playback is a barge-in too: stop talking first.
    if (voice.state === 'speaking') voice.cancel()
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

  const closeControls = useCallback(() => {
    restoreControlsFocusRef.current = true
    setControlsOpen(false)
  }, [])

  function toggleControls() {
    if (controlsOpen) {
      closeControls()
      return
    }
    setControlsOpen(true)
  }

  useEffect(() => {
    if (controlsOpen) {
      controlsCloseRef.current?.focus()
      return
    }
    if (restoreControlsFocusRef.current) {
      controlsTriggerRef.current?.focus()
      restoreControlsFocusRef.current = false
    }
  }, [controlsOpen])

  useEffect(() => {
    if (!controlsOpen) return undefined

    const handleDrawerKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeControls()
        return
      }
      if (event.key !== 'Tab') return

      const drawer = controlsDrawerRef.current
      if (!drawer) return
      const focusableControls = Array.from(
        drawer.querySelectorAll<HTMLElement>(focusableControlSelector),
      )
      const firstControl = focusableControls[0]
      const lastControl = focusableControls.at(-1)
      if (!firstControl || !lastControl) {
        event.preventDefault()
        return
      }

      const activeElement = document.activeElement
      if (event.shiftKey) {
        if (activeElement === firstControl || !drawer.contains(activeElement)) {
          event.preventDefault()
          lastControl.focus()
        }
      } else if (activeElement === lastControl || !drawer.contains(activeElement)) {
        event.preventDefault()
        firstControl.focus()
      }
    }

    document.addEventListener('keydown', handleDrawerKeyDown)
    return () => document.removeEventListener('keydown', handleDrawerKeyDown)
  }, [closeControls, controlsOpen])

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

  const isCompleted = task?.phase === 'completed'
  const isTerminal = task?.phase === 'completed' || task?.phase === 'cancelled'
  const playedEventCount = task
    ? task.processedEventIds.filter((eventId) => playableEventIds.has(eventId)).length
    : 0
  const displayedEventCount = isCompleted ? playableEventCount : playedEventCount
  const progressPercent = playableEventCount === 0
    ? 0
    : isCompleted ? 100 : Math.min(100, (displayedEventCount / playableEventCount) * 100)
  const progressLabel = isCompleted ? '播放完成' : task?.phase === 'cancelled' ? '已取消' : '播放进度'
  const advanceLabel = isCompleted ? '行程已完成' : task?.phase === 'cancelled' ? '行程已取消' : '推进下一事件'

  // Before the first task there is no phase to name, so the brief says what it is
  // waiting for rather than borrowing a phase label it does not have.
  const phaseIdentity = task ? phaseIdentityLabels[task.phase] : '等待创建任务'
  const tripTitleIsContextual = spec ? hasContextualTripTitle(spec) : false
  const tripTitle = spec?.title || '机场接人'

  return (
    <main
      className="demo-shell"
      data-controls-open={controlsOpen}
      data-phase={task?.phase}
      data-density={spec?.presentation.density}
      data-theme={spec?.presentation.theme}
      data-priority={spec?.presentation.priority}
    >
      <section className="cockpit-stage" aria-label="机场接人任务">
        <section
          id="task-surface"
          className="task-surface"
          aria-label="当前行程"
          data-trip-brief
          data-phase={task?.phase}
          data-phase-label={phaseIdentity}
        >
          <header className="trip-brief__header">
            <a className="brand-lockup" href="#trip-brief-title" aria-label={`carHer ${phaseIdentity}`}>
              <span className="brand-wordmark">carHer</span>
              <span className="brand-separator" aria-hidden="true">·</span>
              <span className="trip-brief__phase" data-phase-identity>{phaseIdentity}</span>
            </a>
            <div className="header-actions">
              <button
                className={`mic-button mic-${micState}`}
                type="button"
                aria-label={microphoneCopy.aria}
                aria-pressed={micState === 'listening'}
                disabled={!voice.available || pending || micState === 'submitting'}
                onClick={pressMicrophone}
              >
                <MicIcon size={22} />
                <span>{microphoneCopy.text}</span>
              </button>
              <button
                ref={controlsTriggerRef}
                className="control-toggle"
                type="button"
                aria-expanded={controlsOpen}
                aria-controls="event-console"
                aria-haspopup="dialog"
                aria-label={controlsOpen ? '收起演示控制' : '打开演示控制'}
                onClick={toggleControls}
              >
                <ControlsIcon size={22} />
                <span>演示控制</span>
              </button>
            </div>
          </header>

          {/* Rendered unconditionally so the region exists before the first announcement. */}
          <p className="voice-status" role="status" aria-label="语音状态" aria-live="polite">{voiceStatus}</p>

          <form
            className="voice-composer"
            data-voice-state={micState}
            aria-label="Agent input"
            onSubmit={(event) => { event.preventDefault(); submitText() }}
          >
            <div className="voice-composer__row">
              <input
                className="voice-composer__input"
                type="text"
                aria-label="任务输入"
                value={text}
                disabled={pending || textPathLocked}
                placeholder="告诉我接谁、航班号或下一步"
                onChange={(event) => changeText(event.target.value)}
              />
              <button
                className="voice-composer__send"
                type="submit"
                disabled={pending || textPathLocked}
              >
                发送
              </button>
            </div>
          </form>

          {/* A failed request is not a trip fact, but the driver still has to learn
              that what they pressed did not go through. */}
          {error && <p className="brief-error" role="alert">{error}</p>}

          <div className="trip-brief__content" key={spec?.phase} data-phase-transition={spec?.phase}>
            <header
              className={`task-heading task-heading--${spec?.phase ?? 'idle'}${tripTitleIsContextual ? ' task-heading--contextual' : ''}`}
              data-title-role={tripTitleIsContextual ? 'context' : 'primary'}
            >
              <h1 id="trip-brief-title">{tripTitle}</h1>
            </header>
            {spec && task
              ? <UISpecRenderer
                driving={vehicleContext.speedKph > 0 || vehicleContext.gear !== 'P'}
                onAction={handleAction}
                pending={pending}
                spec={spec}
              />
              : <p className="brief-placeholder">告诉我接谁，我来安排这趟行程。</p>}
          </div>
        </section>
      </section>

      {controlsOpen ? (
        <>
          <button
            className="drawer-scrim"
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeControls}
          />
          <aside
            ref={controlsDrawerRef}
            id="event-console"
            className="event-console"
            role="dialog"
            aria-modal="true"
            aria-labelledby="event-console-title"
            aria-label="Event console"
          >
            <div className="console-heading">
              <div>
                <span className="console-kicker">演示控制</span>
                <h2 id="event-console-title">演示控制</h2>
              </div>
              <button
                ref={controlsCloseRef}
                className="console-close"
                type="button"
                aria-label="关闭演示控制"
                onClick={closeControls}
              >
                <CloseIcon size={24} />
              </button>
            </div>

            <div className="console-phase">
              <span>当前阶段</span>
              <strong>{task ? task.phase : '尚无任务'}</strong>
            </div>

            <dl className="revision-grid">
              <div><dt>任务 ID</dt><dd>{task?.taskId ?? '—'}</dd></div>
              <div><dt>任务版本</dt><dd>{task ? `taskRevision ${task.taskRevision}` : '—'}</dd></div>
              <div><dt>界面版本</dt><dd>{spec ? `uiRevision ${spec.uiRevision}` : '—'}</dd></div>
              <div><dt>信息密度</dt><dd>{spec?.presentation.density ?? '—'}</dd></div>
              <div><dt>优先级</dt><dd>{spec?.presentation.priority ?? '—'}</dd></div>
            </dl>

            <div
              className="console-progress"
              aria-label="演示进度"
              data-playable-event-count={playableEventCount}
            >
              <div className="console-progress__copy">
                <span>{progressLabel}</span>
                <strong>{displayedEventCount} / {playableEventCount}</strong>
              </div>
              <div className="progress-track" aria-hidden="true">
                <span style={{ width: `${progressPercent}%` }} />
              </div>
            </div>

            {effects.length > 0 && (
              <p className="console-effects" aria-label="Effect receipts">
                {effects.map((effect) => `${effect.type}:${effect.status}`).join(' · ')}
              </p>
            )}

            <button
              className="advance-button"
              type="button"
              onClick={advance}
              disabled={pending || (!response && !localOnly) || !task || isTerminal}
            >
              <span>{advanceLabel}</span>
              <ArrowRightIcon size={24} />
            </button>
            <p className="console-hint">此面板仅用于演示，不会改变行程事实或跳过操作确认。</p>
          </aside>
        </>
      ) : null}
    </main>
  )
}
