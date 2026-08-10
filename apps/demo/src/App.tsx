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
import { createBrowserRecognition, isRecognitionSupported, isSecureContextOk } from '@canvasflow/voice'
import { advanceMainFlowStep, mainFlowTimeline } from './main-flow'
import { AgentApiClient, demoVehicleContext, isNightAt } from './agent-client'
import { ArrowRightIcon, CloseIcon, ControlsIcon, KeyboardIcon, MicIcon } from './ui/icons'
import { UISpecRenderer } from './ui'
import { GLASS_TIERS, useGlassTier } from './ui/glass-capability'
import { useVoice, type VoiceSubmitMeta } from './voice/useVoice'
import {
  createFixtureRecognition,
  playFixtureSampleAudio,
  voiceFixtureSamples,
  type FixtureAudioFactory,
  type VoiceFixtureSample,
} from './voice/fixtureSpeech'

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

function isDrivingVehicle(vehicle: VehicleContext): boolean {
  return vehicle.speedKph > 0 || vehicle.gear !== 'P'
}

function visibleComponent(
  spec: UISpec,
  componentId: string,
  driving: boolean,
): UISpec['components'][number] | undefined {
  const laidOutIds = new Set(Object.values(spec.layout.slots).flat())
  const component = spec.components.find((candidate) => candidate.id === componentId)
  if (!component || !laidOutIds.has(component.id)) return undefined
  if (component.visibility === 'driving-only' && !driving) return undefined
  if (component.visibility === 'parked-only' && driving) return undefined
  return component
}

function registeredAction(spec: UISpec, actionId: string): UISpec['actions'][number] | undefined {
  // The renderer's action map is first-wins for duplicate ids; capability
  // checks must resolve the same action the visible button would dispatch.
  return spec.actions.find((action) => action.id === actionId)
}

function hasStartNavigationCapability(spec: UISpec, driving: boolean): boolean {
  const component = visibleComponent(spec, 'navigation-plan', driving)
  if (component?.type !== 'navigation-summary' || !component.actions?.includes('start-navigation')) return false
  const action = registeredAction(spec, 'start-navigation')
  return action?.event.type === 'tool-request' && action.event.actionToken === 'start-navigation'
}

function hasFlightChoiceCapability(spec: UISpec, driving: boolean): boolean {
  const component = visibleComponent(spec, 'flight-choices', driving)
  if (component?.type !== 'flight-choices') return false
  const firstChoice = component.props.choices[0]
  if (!firstChoice) return false
  const action = registeredAction(spec, firstChoice.actionId)
  return action?.event.type === 'agent-message'
    && action.event.text.replace(/\s+/g, '') === `航班号${firstChoice.flightNumber}`
}

function hasWeatherAdvisoryCapability(
  spec: UISpec,
  driving: boolean,
  actionId: 'send-umbrella-reminder' | 'dismiss-advisory-weather',
  expectedText: string,
): boolean {
  const component = visibleComponent(spec, 'weather-advisory', driving)
  if (component?.type !== 'weather-card' || !component.actions?.includes(actionId)) return false
  const action = registeredAction(spec, actionId)
  return action?.event.type === 'agent-message' && action.event.text === expectedText
}

/** Whether the Gateway accepted the input, plus any reply worth speaking. */
type InputOutcome = { sent: boolean; speak?: string }

/**
 * Why the composer is on screen. The composer is not a permanent input row: it
 * opens when the turn actually needs a keyboard, and the reason it opened is
 * what decides its notice and whether closing it is allowed.
 *
 * - `transcript`  — recognised words are waiting to be confirmed or corrected.
 * - `unavailable` — voice cannot run at all, so text is the only path there is.
 * - `error`       — this voice turn failed; text has to finish it.
 * - `text`        — the driver asked for the keyboard, or words were handed back
 *                   to them after a turn the microphone could not complete.
 *
 * Only `text` is dismissible. The other three mean the turn cannot be finished
 * without the field, and closing it would strand the driver.
 */
type ComposerReason = 'transcript' | 'unavailable' | 'error' | 'text'

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
  initialVehicleContext,
  voiceEnabled = true,
  speech,
  fixtureAudio,
}: {
  api?: DemoAgentApi
  initialTask?: AirportPickupTaskState
  composeContext?: ComposerContext
  initialVehicleContext?: VehicleContext
  /** Lets a test or a kiosk build turn the voice entry point off entirely. */
  voiceEnabled?: boolean
  /** Test seam for injecting fake Web Speech engines. */
  speech?: SpeechControllerDeps
  /** Test seam for the fixture replay's audio element. */
  fixtureAudio?: FixtureAudioFactory
}) {
  const localOnly = initialTask !== undefined || Object.keys(composeContext).length > 0
  const startingVehicleContext = initialVehicleContext ?? demoVehicleContext()
  const [response, setResponse] = useState<AgentResponse>()
  const [text, setText] = useState('我现在要去机场接妈妈和豆豆')
  const [stepIndex, setStepIndex] = useState(0)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [vehicleContext, setVehicleContext] = useState(startingVehicleContext)
  // Which light condition the car reports. `auto` is what a car does — read the
  // world and say what it sees; the two pinned values exist so a walkthrough or
  // a screenshot can show either cabin at any hour of the day.
  const [lighting, setLighting] = useState<'auto' | 'day' | 'night'>(
    initialVehicleContext ? (initialVehicleContext.isNight ? 'night' : 'day') : 'auto',
  )
  const [controlsOpen, setControlsOpen] = useState(false)
  const [keyboardRequested, setKeyboardRequested] = useState(false)
  const pendingRef = useRef(false)
  const streamCursorRef = useRef(0)
  const controlsTriggerRef = useRef<HTMLButtonElement>(null)
  const controlsDrawerRef = useRef<HTMLElement>(null)
  const controlsCloseRef = useRef<HTMLButtonElement>(null)
  const restoreControlsFocusRef = useRef(false)
  const composerInputRef = useRef<HTMLInputElement>(null)
  const focusComposerRef = useRef(false)
  const [localTask, setLocalTask] = useState<AirportPickupTaskState | undefined>(
    localOnly ? (initialTask ?? mainFlowTimeline.initialTaskState) : undefined,
  )
  // True while the field holds words someone could lose: the driver's own
  // typing, or a transcript parked for confirmation/retry. The pristine
  // placeholder suggestion is not protected — nobody authored it this turn.
  const [draftProtected, setDraftProtected] = useState(false)
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
      // Auto follows the clock at submission time, not at page-load time. A demo
      // left open across the day/night boundary must report the current cabin.
      const createVehicleContext = lighting === 'auto'
        ? { ...vehicleContext, isNight: isNightAt(new Date()) }
        : vehicleContext
      const created = await run(() => api.create(trimmed, {
        vehicleContext: createVehicleContext,
        ...(meta ? { source: meta.source } : {}),
        ...(meta?.confidence === undefined ? {} : { confidence: meta.confidence }),
      }))
      if (!created) return { sent: false }
      setStepIndex(1)
      setText('')
      setDraftProtected(false)
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
      setDraftProtected(false)
      return { sent: true }
    }
    const registeredStartNavigation = hasStartNavigationCapability(
      response.ui,
      isDrivingVehicle(vehicleContext),
    )
    if (/^开始导航[。！!]?$/.test(trimmed.replace(/\s+/g, '')) && registeredStartNavigation) {
      const nextTimelineIndex = nextIndexForTimelineEvent('navigation.started')
      const next = await run(() => api.action(response, 'start-navigation', 'navigation-plan'))
      if (!next) return { sent: false }
      if (nextTimelineIndex !== undefined && navigationStarted(response, next)) {
        setStepIndex(consumeAdvisoryContext(nextTimelineIndex))
      }
      setText('')
      setDraftProtected(false)
      return { sent: true, speak: spokenReply(next) }
    }
    let nextTimelineIndex = timelineIndexForInput(trimmed)
    const next = await run(() => api.event(response.task, { type: 'user.input', text: trimmed }))
    if (!next) return { sent: false }
    if (nextTimelineIndex === undefined && attachedFlight(response, next)) {
      nextTimelineIndex = nextIndexForTimelineEvent('user.input')
    }
    if (nextTimelineIndex !== undefined && movedTheTrip(response, next)) setStepIndex(nextTimelineIndex)
    setText('')
    setDraftProtected(false)
    return { sent: true, speak: spokenReply(next) }
  }

  async function submitVoiceTranscript(transcript: string, meta: VoiceSubmitMeta) {
    const outcome = await sendInput(transcript, meta)
    // A refused turn must not lose what the driver said: park the transcript in
    // the text field so 发送 can retry it without speaking again. The field has
    // to stay on screen for that, otherwise the words are parked out of sight.
    if (!outcome.sent) {
      setText(transcript)
      setDraftProtected(true)
      setKeyboardRequested(true)
    }
    return outcome.speak
  }

  // The next voice turn's engine. Arming a fixture sample makes exactly one
  // turn read from the recording instead of the microphone; the turn after
  // falls back to the real engine on its own.
  const armedFixtureRef = useRef<VoiceFixtureSample | null>(null)
  const fixtureAudioRef = useRef(fixtureAudio)
  const degradedFixtureAudioRef = useRef<ReturnType<typeof playFixtureSampleAudio>>(null)
  fixtureAudioRef.current = fixtureAudio

  function stopDegradedFixtureAudio() {
    try {
      degradedFixtureAudioRef.current?.pause()
    } catch {
      // Presentation audio may already have been released by the browser.
    }
    degradedFixtureAudioRef.current = null
  }

  useEffect(() => () => { stopDegradedFixtureAudio() }, [])

  // Voice runs when the browser has a real engine or a test injected one; a
  // browser with neither keeps today's disabled entry, and fixture replay
  // degrades to the text path below. The deps object consults the armed ref on
  // every turn, so replay needs no loop rebuild.
  const voiceSpeech = useMemo<SpeechControllerDeps | undefined>(() => {
    const createReal = speech?.createRecognition
      ?? (isRecognitionSupported() && isSecureContextOk() ? createBrowserRecognition : undefined)
    if (!createReal) return undefined
    return {
      ...speech,
      createRecognition: () => {
        const armed = armedFixtureRef.current
        armedFixtureRef.current = null
        if (armed) return createFixtureRecognition(armed, fixtureAudioRef.current ?? undefined)
        return createReal()
      },
    }
  }, [speech])

  const voice = useVoice({
    enabled: voiceEnabled,
    onTranscript: submitVoiceTranscript,
    speech: voiceSpeech,
  })
  const voiceTranscript = voice.state === 'transcribing' ? voice.transcript : undefined
  // The microphone owns the turn while it is capturing or while a confirmed
  // transcript is in flight, so nothing may be sent by hand in the meantime:
  // during `listening` the field would still hold the *previous* turn's words,
  // and during `submitting` the words on screen have already been sent once.
  // This closes both the 文字 entry and the field it would open. `transcribing`
  // stays open on purpose: that is where 发送 confirms.
  const textPathLocked = voice.state === 'listening' || voice.state === 'submitting'

  // A finished transcript lands in the same field the text path uses rather than
  // in a second input: one place to read, one place to correct, one 发送. Those
  // words are the driver's — from here on the field is protected content.
  useEffect(() => {
    if (voiceTranscript === undefined) return
    setText(voiceTranscript)
    setDraftProtected(true)
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
    void sendInput(text).then((outcome) => {
      // The words are gone, so the field that held them has done its job. Leaving
      // it open would put an empty input row back on screen permanently, which is
      // the thing the on-demand keyboard exists to avoid. A refused send keeps it:
      // `sendInput` leaves the text in place so 发送 can retry it.
      if (outcome.sent) setKeyboardRequested(false)
    })
  }

  function changeText(value: string) {
    setText(value)
    // Typing makes the words the driver's own; clearing the field by hand
    // releases them again.
    setDraftProtected(value.trim() !== '')
    // Editing a transcript is still the same turn; tell the machine so the
    // engine's confidence is dropped along with its guess.
    if (voice.state === 'transcribing') voice.edit(value)
  }

  function pressMicrophone() {
    // Confirming is 发送's job, so here the button only leaves the voice turn.
    // The transcript stays in the text field on purpose, so the field stays too.
    if (voice.state === 'transcribing') {
      voice.cancel()
      setKeyboardRequested(true)
      return
    }
    // Starting a fresh voice turn is a decision to speak, so the keyboard the
    // driver may have opened earlier steps back out of the way.
    setKeyboardRequested(false)
    voice.press()
  }

  // Replay may not steal a turn that is mid-capture or mid-confirm, and it may
  // not silently replace words someone could still lose — the driver's typing
  // or a parked transcript stay until they are sent or cleared by hand.
  const draftBlocksReplay = draftProtected && text.trim() !== ''
  const voiceFixtureReady = !pending && !draftBlocksReplay
    && (!voice.available || voice.state === 'idle' || voice.state === 'error' || voice.state === 'speaking')

  function isVoiceFixtureAvailable(sample: VoiceFixtureSample): boolean {
    if (!voiceFixtureReady) return false
    if (sample.id === 'create-airport-pickup' || sample.id === 'noisy-create') return !task
    if (!response || !spec) return false
    const driving = isDrivingVehicle(vehicleContext)
    if (sample.id === 'select-first-flight') {
      return hasFlightChoiceCapability(spec, driving)
    }
    if (sample.id === 'flight-number') {
      return response.task.phase === 'collecting-information' && response.task.flight === undefined
    }
    if (sample.id === 'check-weather') {
      return response.task.flight !== undefined
        && response.task.phase !== 'collecting-information'
        && response.task.phase !== 'completed'
        && response.task.phase !== 'cancelled'
    }
    if (sample.id === 'start-navigation') {
      return hasStartNavigationCapability(spec, driving)
    }
    if (sample.id === 'send-weather-reminder') {
      return response.task.weatherAdvisory?.status === 'active'
        && hasWeatherAdvisoryCapability(spec, driving, 'send-umbrella-reminder', sample.text)
    }
    if (sample.id === 'dismiss-weather-advisory') {
      return response.task.weatherAdvisory?.status === 'active'
        && hasWeatherAdvisoryCapability(spec, driving, 'dismiss-advisory-weather', sample.text)
    }
    return false
  }

  /**
   * The offline voice fallback (see fixtures/airport-pickup/voice): plays the
   * recorded utterance and delivers its canonical transcript. With a live voice
   * loop the sample runs as a normal turn — status line, confirmation, submit
   * meta and TTS all identical to the microphone path. Without one, the audio
   * still plays and the transcript parks in the text field, so the demo keeps
   * its determinism even in a browser with no speech engine at all. Either way
   * nothing auto-submits: every transcript waits for 发送.
   */
  function replayVoiceFixture(sample: VoiceFixtureSample) {
    if (!isVoiceFixtureAvailable(sample)) return
    closeControls()
    if (voice.available) {
      stopDegradedFixtureAudio()
      setKeyboardRequested(false)
      armedFixtureRef.current = sample
      voice.press()
      return
    }
    stopDegradedFixtureAudio()
    degradedFixtureAudioRef.current = playFixtureSampleAudio(sample, fixtureAudioRef.current ?? undefined)
    setText(sample.text)
    setDraftProtected(true)
    setKeyboardRequested(true)
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
    const navigationStep = step.event.type === 'navigation.started'
    const request = navigationStep
      ? api.action(current, 'start-navigation', 'navigation-plan')
      : api.event(current.task, { ...step.event, timestamp: undefined })
    const next = await run(() => request)
    if (!next) return
    // A Provider failure can still arrive as HTTP 200 with an unchanged task.
    // Keep the navigation step pending so the operator can retry it in place.
    if (navigationStep && !navigationStarted(current, next)) return
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

  /**
   * Restate the car's light condition. The client only reports what the car
   * senses — whether that becomes a dark cabin is the Agent's call, carried
   * back in `presentation.theme`, so nothing here touches the rendered theme.
   */
  function selectLighting(next: 'auto' | 'day' | 'night') {
    setLighting(next)
    setVehicleContext((current) => ({
      ...current,
      isNight: next === 'auto' ? isNightAt(new Date()) : next === 'night',
    }))
  }

  function handleAction(actionId: string, componentId: string) {
    if (pendingRef.current) return
    if (!response) {
      if (!localOnly) return
      setLocalTask((current) => {
        if (!current) return current
        if (actionId === 'save-trip-preferences') return resolveConfirmation(current, `${current.taskId}:save-memory`)
        // Declining still resolves the confirmation; only the Agent records which way it went.
        if (actionId === 'reject-trip-preferences') return resolveConfirmation(current, `${current.taskId}:save-memory`)
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
    } else if (actionEvent?.type === 'agent-message') {
      // Pressing a row is the driver saying what it says. It travels as the same
      // user input the composer sends, so the planner sees one kind of answer and
      // a card can never set a slot that typing could not. The draft field is
      // left alone: the pick is not the sentence they were writing.
      const nextTimelineIndex = timelineIndexForInput(actionEvent.text)
      void run(() => api.event(response.task, { type: 'user.input', text: actionEvent.text })).then((next) => {
        if (!next || nextTimelineIndex === undefined || !movedTheTrip(response, next)) return
        setStepIndex(nextTimelineIndex)
      })
    } else {
      const nextTimelineIndex = actionId === 'start-navigation'
        ? nextIndexForTimelineEvent('navigation.started')
        : undefined
      void run(() => api.action(response, actionId, componentId)).then((next) => {
        if (!next || nextTimelineIndex === undefined || !navigationStarted(response, next)) return
        setStepIndex(consumeAdvisoryContext(nextTimelineIndex))
      })
    }
  }

  /**
   * Whether a turn moved the trip, as opposed to answering a question about it.
   * Asking for the weather or the day's schedule is answered on the spot and the
   * task is deliberately left exactly as it was — same revision, nothing added to
   * the processed events. The demo player's cursor tracks the fixture timeline, so
   * a turn that did not move the trip must not move the cursor either: doing so
   * would spend a step the timeline still owes and strand the rest of the drive.
   */
  function movedTheTrip(before: AgentResponse, after: AgentResponse): boolean {
    return after.task.taskRevision !== before.task.taskRevision
      || after.task.processedEventIds.length !== before.task.processedEventIds.length
  }

  function navigationStarted(before: AgentResponse, after: AgentResponse): boolean {
    return movedTheTrip(before, after)
      && after.task.phase === 'driving-to-airport'
      && after.task.navigation?.status === 'active'
  }

  function attachedFlight(before: AgentResponse, after: AgentResponse): boolean {
    return before.task.phase === 'collecting-information'
      && before.task.flight === undefined
      && after.task.phase === 'preparing'
      && after.task.flight !== undefined
  }

  function nextIndexForTimelineEvent(type: AirportPickupEvent['type']): number | undefined {
    const index = mainFlowTimeline.steps.findIndex((step, candidateIndex) =>
      candidateIndex >= stepIndex && !step.advisory && step.event.type === type,
    )
    return index === -1 ? undefined : index + 1
  }

  function timelineIndexForInput(value: string): number | undefined {
    const compact = value.replace(/\s+/g, '')
    const choosingFlight = response?.task.phase === 'collecting-information'
      && response.task.flight === undefined
    if (
      choosingFlight
      && /^(?:请|麻烦)?(?:帮我)?(?:选|要|接|就)?(?:选)?第(?:一|二|两|三|四|五|1|2|3|4|5)(?:个|班|条|架)?(?:航班|飞机)?(?:吧|好了)?[?？。！!]?$/.test(compact)
    ) {
      return nextIndexForTimelineEvent('user.input')
    }
    if (choosingFlight && /^(?:航班(?:号)?)?[A-Z]{2}\d{4}[。！!]?$/.test(compact.toUpperCase())) {
      return nextIndexForTimelineEvent('user.input')
    }
    if (
      response?.task.phase === 'waiting-for-passengers'
      && /已经接到她们|接到她们了|家人(?:已经)?上车|她们(?:已经)?上车/.test(compact)
    ) {
      return nextIndexForTimelineEvent('user.confirmed-passengers-onboard')
    }
    if (response?.task.phase === 'returning-home' && /应用家庭座舱偏好/.test(compact)) {
      return nextIndexForTimelineEvent('user.input')
    }
    return undefined
  }

  function toggleKeyboard() {
    if (keyboardRequested) {
      setKeyboardRequested(false)
      return
    }
    // Asking for the keyboard should land the caret in it; a driver who pressed
    // 文字 should not have to find the field afterwards.
    focusComposerRef.current = true
    setKeyboardRequested(true)
  }

  useEffect(() => {
    if (!focusComposerRef.current) return
    focusComposerRef.current = false
    composerInputRef.current?.focus()
  }, [keyboardRequested])

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

  // The keyboard is not a permanent fixture of the cabin. It appears when the
  // turn genuinely needs it and steps back out when it does not, so the journey
  // content keeps the space by default. Order matters: an unfinished transcript
  // is the most specific reason, and a missing capability the most absolute.
  // `submitting` keeps the field: the words the driver just confirmed stay on
  // screen until the Gateway accepts them, rather than blinking out and back.
  const composerReason: ComposerReason | undefined = voice.state === 'transcribing' || voice.state === 'submitting'
    ? 'transcript'
    : !voice.available
      ? 'unavailable'
      : voice.error
        ? 'error'
        : keyboardRequested
          ? 'text'
          : undefined
  // A voice failure already states itself in the live region above the field;
  // repeating it inside the composer would say the same thing twice. Only the
  // absolute case needs its own line, because there is no turn to have failed.
  const composerNotice = composerReason === 'unavailable'
    ? voice.error?.message ?? '语音入口不可用，请用文字告诉我。'
    : undefined
  // Closing the field is only offered when nothing depends on it staying: the
  // other reasons mean the turn cannot be finished without it.
  const composerDismissible = composerReason === 'text'

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
  // Model provenance comes straight from the Agent's response envelope: it is only
  // present when a validated model plan was actually applied, so showing it never
  // overstates what the model did. Rules-only turns render nothing.
  const modelUsed = response?.meta.modelUsed

  // How expensive the floating panel's blur is allowed to be on this machine.
  // Decided from what the device reports about itself rather than from which
  // engine is running, so a capable browser is never punished for being the
  // minority one — see `glass-capability.ts`.
  const glassTier = useGlassTier()

  return (
    <main
      className="demo-shell"
      data-controls-open={controlsOpen}
      data-phase={task?.phase}
      data-density={spec?.presentation.density}
      data-theme={spec?.presentation.theme}
      data-priority={spec?.presentation.priority}
      data-glass={glassTier}
      style={GLASS_TIERS[glassTier]}
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
            <a className="brand-lockup" href="#trip-brief-title" aria-label={`pilotflow ${phaseIdentity}`}>
              <span className="brand-wordmark">pilotflow</span>
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
                className={`keyboard-toggle${composerReason ? ' keyboard-toggle--open' : ''}`}
                type="button"
                // Reports whether the field is on screen, not merely whether this
                // button put it there: a transcript or a failure opens it too.
                aria-pressed={Boolean(composerReason)}
                // Voice is an assistive utility, never the only way in. Even when
                // the microphone is working, the keyboard stays one press away.
                // It can only be taken back when nothing else depends on it.
                aria-label={composerReason ? '收起文字输入' : '改用文字输入'}
                disabled={pending || textPathLocked || (Boolean(composerReason) && !composerDismissible)}
                onClick={toggleKeyboard}
              >
                <KeyboardIcon size={22} />
                <span>文字</span>
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

          {/* Provenance is a task-level fact: the Agent persists the model ID with
              the task snapshot once a validated model plan is applied, so this line
              states participation, not per-turn authorship. Rules-only tasks leave
              meta.modelUsed unset and this line off screen. */}
          {modelUsed && (
            <p className="model-provenance" data-model-used={modelUsed} aria-label="模型参与说明">
              模型 <strong>{modelUsed}</strong> 参与了本任务的输入规范化
            </p>
          )}

          {composerReason ? (
            <form
              className="voice-composer"
              data-voice-state={micState}
              data-composer-reason={composerReason}
              aria-label="Agent input"
              onSubmit={(event) => { event.preventDefault(); submitText() }}
            >
              {composerNotice && <p className="voice-composer__notice">{composerNotice}</p>}
              <div className="voice-composer__row">
                <input
                  ref={composerInputRef}
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
          ) : null}

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
                driving={isDrivingVehicle(vehicleContext)}
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
              <div><dt>规划来源</dt><dd>{response ? (modelUsed ?? '规则') : '—'}</dd></div>
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

            {/* Always mounted with a fixed height: receipts stream in over SSE while
                the drawer is open, and a conditionally inserted line here used to
                shove the advance button mid-click — the demo player (and any human
                aiming at it) then pressed empty space. */}
            <p className="console-effects" aria-label="Effect receipts" data-empty={effects.length === 0 || undefined}>
              {effects.length > 0 ? effects.map((effect) => `${effect.type}:${effect.status}`).join(' · ') : '暂无回执'}
            </p>

            <div className="console-lighting" role="group" aria-label="车外光线">
              <span className="console-lighting__title">车外光线</span>
              <div className="console-lighting__actions">
                {([
                  { id: 'auto', label: '跟随时间' },
                  { id: 'day', label: '白天' },
                  { id: 'night', label: '夜间' },
                ] as const).map((option) => (
                  <button
                    key={option.id}
                    className="lighting-button"
                    type="button"
                    aria-pressed={lighting === option.id}
                    disabled={pending || Boolean(task)}
                    onClick={() => selectLighting(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="console-hint">
                {task
                  ? '光线条件已随任务固定。如需演示另一种光线，请重新开始任务。'
                  : '选择创建任务时车辆上报的光线；界面明暗由 Agent 决定。'}
              </p>
            </div>

            <button
              className="advance-button"
              type="button"
              onClick={advance}
              disabled={pending || (!response && !localOnly) || !task || isTerminal}
            >
              <span>{advanceLabel}</span>
              <ArrowRightIcon size={24} />
            </button>

            <div className="console-voice-fallback" role="group" aria-label="语音兜底回放">
              <span className="console-voice-fallback__title">语音兜底回放</span>
              <div className="console-voice-fallback__actions">
                {voiceFixtureSamples.map((sample) => (
                  (() => {
                    const available = isVoiceFixtureAvailable(sample)
                    const hintId = `${sample.id}-availability-hint`
                    return (
                      <span key={sample.id}>
                        <button
                          className="voice-fallback-button"
                          type="button"
                          disabled={!available}
                          aria-describedby={!available && sample.unavailableHint ? hintId : undefined}
                          title={available ? undefined : sample.unavailableHint}
                          onClick={() => replayVoiceFixture(sample)}
                        >
                          {sample.label}
                        </button>
                        {!available && sample.unavailableHint
                          ? <span id={hintId} className="sr-only">{sample.unavailableHint}</span>
                          : null}
                      </span>
                    )
                  })()
                ))}
              </div>
              <p className="console-hint">
                {draftBlocksReplay
                  ? '输入框里还有未发送的内容；先发送或清空它，回放才不会覆盖这些话。'
                  : '播放预录语音并交付固定转写；转写始终停在输入框，需按「发送」确认后才会提交。'}
              </p>
            </div>

            <p className="console-hint">此面板仅用于演示，不会改变行程事实或跳过操作确认。</p>
          </aside>
        </>
      ) : null}
    </main>
  )
}
