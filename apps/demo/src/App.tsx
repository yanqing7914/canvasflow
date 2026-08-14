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
  NavigationCommandSnapshot,
  TaskUpdateEnvelope,
  UISpec,
  VehicleContext,
} from '@canvasflow/schema'
import type { NavigationSpeechCoordinator, NavigationVoiceCommand, SpeechControllerDeps, SpeechRecognitionLike, VoiceRecognitionSource, WakeSessionSnapshot } from '@canvasflow/voice'
import {
  createWakeSession,
  createBrowserRecognition,
  createNavigationSpeechCoordinator,
  createSpeechController,
  isRecognitionSupported,
  isSecureContextOk,
} from '@canvasflow/voice'
import { advanceMainFlowStep, mainFlowTimeline } from './main-flow'
import { AgentApiClient, AgentApiError, demoVehicleContext, isNightAt, type AgentEventInput } from './agent-client'
import { ArrowRightIcon, CloseIcon, ControlsIcon, KeyboardIcon, MicIcon } from './ui/icons'
import { UISpecRenderer } from './ui'
import { NavigationWorkspace, navigationSketchForTask } from './ui/navigation/NavigationWorkspace'
import { cockpitContractPhase, runtimeWindows, windowUISpec, type CockpitUISpec, type RuntimeNavigationTask } from './ui/navigation/contracts'
import type { NavigationClock, NavigationLeg, NavigationSnapshot } from './ui/navigation/simulator'
import { WindowManager } from './ui/navigation/WindowManager'
import { GLASS_TIERS, useGlassTier } from './ui/glass-capability'
import { useVoice, type VoiceSubmitMeta } from './voice/useVoice'
import { matchWakeWord } from '@canvasflow/voice'
import { CockpitStatusBar, CockpitWorkspace, deriveCockpitView } from './ui/cockpit'
import { PersistentMapLayer } from './ui/cockpit/PersistentMapLayer'
import { createLocalHandsFreeController, type LocalHandsFreeController } from './voice/localHandsFreeController'
import { amapLoaderSnapshot, retryAMap, subscribeAMapLoader, switchAMapKey, type AMapLoaderSnapshot } from './ui/amap/loader'
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
  & Partial<Pick<AgentApiClient, 'cancel'>>

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
  'collecting-airport': '确认机场',
  'choosing-flight': '选择航班',
  'confirming-outbound': '确认出发',
  'outbound-driving': '前往机场',
  'passengers-onboard': '乘客已上车',
  'confirming-return': '确认返程',
  'return-driving': '返回家中',
  'collecting-information': '准备接机',
  preparing: '准备出发',
  'driving-to-airport': '途中',
  'approaching-airport': '即将到达',
  'waiting-for-passengers': '等待家人',
  'returning-home': '家人已上车',
  completed: '行程结束',
  cancelled: '行程已取消',
}

const journeyStages = [
  { id: 'prepare', label: '准备', detail: '确认航班与出发方案' },
  { id: 'pickup', label: '接机', detail: '前往机场并接到家人' },
  { id: 'return', label: '返程', detail: '送家人安全回家' },
  { id: 'home', label: '到家', detail: '总结行程与偏好' },
] as const

const journeyStageByPhase: Record<AirportPickupTaskState['phase'], number | undefined> = {
  'collecting-airport': 0,
  'choosing-flight': 0,
  'confirming-outbound': 0,
  'collecting-information': 0,
  preparing: 0,
  'outbound-driving': 1,
  'driving-to-airport': 1,
  'approaching-airport': 1,
  'waiting-for-passengers': 1,
  'passengers-onboard': 2,
  'confirming-return': 2,
  'return-driving': 2,
  'returning-home': 2,
  completed: 3,
  cancelled: undefined,
}

function JourneyPhaseRail({ phase }: { phase: AirportPickupTaskState['phase'] }) {
  const currentStage = journeyStageByPhase[phase]
  const cancelled = phase === 'cancelled'

  return (
    <ol className="journey-rail" aria-label="接机行程阶段" data-cancelled={cancelled || undefined}>
      {journeyStages.map((stage, index) => {
        const state = currentStage === undefined
          ? 'upcoming'
          : index < currentStage ? 'completed' : index === currentStage ? 'current' : 'upcoming'
        return (
          <li
            className="journey-rail__stage"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            key={stage.id}
          >
            <span className="journey-rail__marker" aria-hidden="true">
              <span>{index + 1}</span>
            </span>
            <span className="journey-rail__copy">
              <strong data-journey-label>{stage.label}</strong>
              <small>{cancelled ? '行程已停止' : stage.detail}</small>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

const focusableControlSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

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

function normalizedVoiceChoice(input: string): string {
  return input.replace(/\s+/g, '').replace(/[，,。.!！?？：:；;]+$/u, '')
}

function memoryConfirmationDecision(input: string): 'accept' | 'reject' | undefined {
  const compact = normalizedVoiceChoice(input)
  return compact === '保存本次偏好'
    ? 'accept'
    : compact === '暂不保存'
      ? 'reject'
      : undefined
}

/**
 * Spoken confirmation uses the exact action the current generated window owns.
 * The browser does not invent parameters or bypass Policy: it resolves the
 * visible action id and sends the same action/component pair a click would.
 */
function cockpitActionForVoice(
  task: AirportPickupTaskState,
  spec: CockpitUISpec,
  input: string,
): { actionId: string; componentId: string } | undefined {
  const compact = normalizedVoiceChoice(input)
  const wanted = task.phase === 'confirming-outbound' && /^(?:现在出发|开始导航|出发)$/.test(compact)
    ? { actionId: 'start-outbound', componentId: 'outbound-confirmation' }
    : task.phase === 'confirming-return' && /^(?:开始返程|确认返程)$/.test(compact)
      ? { actionId: 'start-return', componentId: 'return-confirmation' }
      : undefined
  if (!wanted) return undefined
  const window = spec.windows?.find((candidate) => candidate.componentIds.includes(wanted.componentId))
  const component = spec.components.find((candidate) => candidate.id === wanted.componentId)
  const action = registeredAction(spec, wanted.actionId)
  // Primary confirmation surfaces are intentionally not floating windows. They
  // still own the same signed tool action, so the absence of `windows` metadata
  // must not downgrade a spoken confirmation to generic user.input.
  const ownsAction = window?.actionIds?.includes(wanted.actionId)
    || (task.phase === 'confirming-outbound' && wanted.componentId === 'outbound-confirmation')
    || (task.phase === 'confirming-return' && wanted.componentId === 'return-confirmation')
  if (!ownsAction
    || !component?.actions?.includes(wanted.actionId)
    || action?.event.type !== 'tool-request'
    || action.event.actionToken !== wanted.actionId) return undefined
  return wanted
}

/**
 * Spoken completion choices are confirmations, not ordinary planner input.
 * Resolve the current generated action and its one-shot credential before
 * calling the same confirmation endpoint that a visible button uses.
 */
function confirmationActionForVoice(
  task: AirportPickupTaskState,
  spec: UISpec,
  input: string,
): { confirmationId: string; decision: 'accept' | 'reject' } | undefined {
  if (task.phase !== 'completed' || task.pendingConfirmation?.action !== 'save-memory') return undefined
  const decision = memoryConfirmationDecision(input)
  if (!decision) return undefined
  const confirmationId = task.pendingConfirmation.confirmationId
  const candidate = spec.actions.find((action) => (
    action.event.type === 'confirmation'
    && action.event.confirmationId === confirmationId
    && action.event.decision === decision
  ))
  const action = candidate ? registeredAction(spec, candidate.id) : undefined
  return action?.event.type === 'confirmation'
    && action.event.confirmationId === confirmationId
    && action.event.decision === decision
    ? { confirmationId: action.event.confirmationId, decision: action.event.decision }
    : undefined
}

function hasStartNavigationCapability(spec: UISpec, driving: boolean): boolean {
  const component = visibleComponent(spec, 'navigation-plan', driving)
  if (component?.type !== 'navigation-summary' || !component.actions?.includes('start-navigation')) return false
  const action = registeredAction(spec, 'start-navigation')
  return action?.event.type === 'tool-request' && action.event.actionToken === 'start-navigation'
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
type NavigationVoiceIntent =
  | 'speed-up'
  | 'speed-down'
  | 'weather'
  | 'calendar'
  | 'flight-detail'
  | 'vehicle-status'
  | 'hide-hud'
  | 'show-hud'
  | 'passengers-onboard'
  | 'start-return'
  | 'other'
type QueuedNavigationCommand = NavigationVoiceCommand<NavigationVoiceIntent>
type VoiceTurnConfig = {
  autoSubmit: boolean
  recognitionSource: VoiceRecognitionSource
}
type CockpitOperationKind = 'weather' | 'calendar' | 'flight-detail' | 'vehicle-status' | 'return-route' | 'flight-query' | 'generic'
type CockpitOperation = {
  id: string
  attempt: number
  state: 'processing' | 'error'
  kind: CockpitOperationKind
  title: string
  message: string
  retryable: boolean
  taskId: string
  leg?: NavigationLeg
  retry: () => Promise<AgentResponse>
}

function cockpitOperationForInput(text: string): Pick<CockpitOperation, 'kind' | 'title' | 'message'> | undefined {
  const compact = text.replace(/\s+/g, '')
  if (/查(?:最近)?航班|航班列表|查航班/.test(compact)) return { kind: 'flight-query', title: '正在查询最近航班', message: '正在生成一批新的到达航班，当前任务不会改变。' }
  if (/天气/.test(compact)) return { kind: 'weather', title: '正在查询天气', message: '按当前模拟位置查询，地图和车辆继续运行。' }
  if (/日历|日程/.test(compact)) return { kind: 'calendar', title: '正在生成日历', message: '正在读取今天的全部日程。' }
  if (/航班详情/.test(compact)) return { kind: 'flight-detail', title: '正在读取航班详情', message: '当前选中的航班保持不变。' }
  if (/车辆状态|电量/.test(compact)) return { kind: 'vehicle-status', title: '正在读取车辆状态', message: '窗口将使用最新模拟车辆数据。' }
  if (/开始回家|送我们回家/.test(compact)) return { kind: 'return-route', title: '正在规划返程路线', message: '车辆仍停在机场，等待你确认返程。' }
  return undefined
}
function navigationVoiceIntent(text: string): NavigationVoiceIntent {
  const compact = text.replace(/\s+/g, '')
  if (/跑快点|快一点|加速/.test(compact)) return 'speed-up'
  if (/跑慢点|慢一点|减速/.test(compact)) return 'speed-down'
  if (/天气/.test(compact)) return 'weather'
  if (/日历|日程/.test(compact)) return 'calendar'
  if (/航班详情/.test(compact)) return 'flight-detail'
  if (/车辆状态|电量/.test(compact)) return 'vehicle-status'
  if (/隐藏导航信息/.test(compact)) return 'hide-hud'
  if (/显示导航信息/.test(compact)) return 'show-hud'
  if (/接到人|上车/.test(compact)) return 'passengers-onboard'
  if (/开始回家|送我们回家/.test(compact)) return 'start-return'
  return 'other'
}

// ASR commonly adds punctuation or changes spacing around numbers. Use a
// conservative echo fingerprint only for matching the current system utterance;
// microphone matches are parked for explicit confirmation rather than dropped.
function normalizeVoiceEcho(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[\s。，、．,.!！?？…~～:：;；“”"'‘’()（）【】[\]{}]/gu, '')
}

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
  listening: { aria: '取消聆听', text: '取消聆听' },
  transcribing: { aria: '放弃这次语音输入', text: '待确认' },
  submitting: { aria: '正在提交语音内容', text: '提交中' },
  speaking: { aria: '打断语音播报并重新输入', text: '正在播报' },
  error: { aria: '重试语音输入', text: '语音出错' },
} as const

const wakeButtonLabels: Record<WakeSessionSnapshot['state'], { aria: string; text: string }> = {
  'needs-authorization': { aria: '启用小南语音唤醒', text: '启用小南' },
  authorizing: { aria: '正在请求麦克风权限', text: '正在授权' },
  'waiting-wake': { aria: '小南正在等待唤醒', text: '等待唤醒' },
  'follow-up': { aria: '小南正在聆听指令', text: '正在聆听' },
  'reset-confirmation': { aria: '小南正在等待重置确认', text: '等待确认' },
}

function isProductResetCommand(text: string): boolean {
  return /^(?:重新开始|重来|重置)$/u.test(text.trim().replace(/[，,。.!！?？：:；;]+$/u, ''))
}

function completedPreferenceResolved(
  before: AirportPickupTaskState,
  after: AirportPickupTaskState,
): boolean {
  return before.phase === 'completed'
    && before.pendingConfirmation?.action === 'save-memory'
    && after.taskId === before.taskId
    && after.phase === 'completed'
    && after.pendingConfirmation === undefined
}

export default function App({
  api = defaultClient,
  initialTask,
  composeContext = {},
  initialVehicleContext,
  voiceEnabled = true,
  speech,
  fixtureAudio,
  navigationClock,
  onNavigationLegComplete,
  initialNavigationReminder,
  initialText = '',
  voiceAutoSubmit = true,
  wakeWordEnabled = true,
  localHandsFreeFactory = createLocalHandsFreeController,
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
  /** Deterministic scheduler seam for the continuous navigation simulator. */
  navigationClock?: NavigationClock
  /** Main integrates this typed completion with outbound/return arrival events. */
  onNavigationLegComplete?: (leg: NavigationLeg) => boolean | void | Promise<boolean | void>
  /** Test seam for exercising system navigation TTS without waiting for route progress. */
  initialNavigationReminder?: string
  /** Explicit preview/test seed; the shipped cockpit starts empty. */
  initialText?: string
  /** Test/legacy seam; production voice turns submit hands-free. */
  voiceAutoSubmit?: boolean
  /** Compatibility seam for legacy fixture tests; the shipped UI requires Xiaonan. */
  wakeWordEnabled?: boolean
  /** Test seam for the local KWS/VAD product runtime. */
  localHandsFreeFactory?: typeof createLocalHandsFreeController
}) {
  const localOnly = initialTask !== undefined || Object.keys(composeContext).length > 0
  const [startingVehicleContext] = useState<VehicleContext>(() => initialVehicleContext ?? demoVehicleContext())
  const [response, setResponse] = useState<AgentResponse>()
  const [text, setText] = useState(initialText)
  const [stepIndex, setStepIndex] = useState(0)
  // `initialText` is a test/preview seed, not part of the shipped idle shell.
  // Once a real task returns to idle, the production shell should own the empty
  // state instead of reviving the seed's preview layout.
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [cockpitOperation, setCockpitOperation] = useState<CockpitOperation>()
  const [retryNavigationLeg, setRetryNavigationLeg] = useState<{ leg: NavigationLeg; nonce: number }>()
  const [wakeSession, setWakeSession] = useState<WakeSessionSnapshot>({ state: 'needs-authorization', speaking: false })
  const [wakeError, setWakeError] = useState<string>()
  const [queuedVoiceNotice, setQueuedVoiceNotice] = useState<string>()
  const [idleNotice, setIdleNotice] = useState<string>()
  const [mapLoader, setMapLoader] = useState<AMapLoaderSnapshot>(() => amapLoaderSnapshot())
  const [mapRetryNonce, setMapRetryNonce] = useState(0)
  const [mapRuntimeFailed, setMapRuntimeFailed] = useState(false)
  const [vehicleContext, setVehicleContext] = useState(startingVehicleContext)
  const [latestNavigationSnapshot, setLatestNavigationSnapshot] = useState<NavigationSnapshot>()
  const [mapFollowing, setMapFollowing] = useState(true)
  // Which light condition the car reports. `auto` is what a car does — read the
  // world and say what it sees; the two pinned values exist so a walkthrough or
  // a screenshot can show either cabin at any hour of the day.
  const [lighting, setLighting] = useState<'auto' | 'day' | 'night'>(
    initialVehicleContext ? (initialVehicleContext.isNight ? 'night' : 'day') : 'auto',
  )
  const [controlsOpen, setControlsOpen] = useState(false)
  const [keyboardRequested, setKeyboardRequested] = useState(false)
  const pendingRef = useRef(false)
  const mutationGenerationRef = useRef(0)
  const resetInFlightRef = useRef(false)
  const responseRef = useRef<AgentResponse | undefined>(undefined)
  const navigationActiveRef = useRef(false)
  const navigationSnapshotRef = useRef<NavigationCommandSnapshot | undefined>(undefined)
  const speechCoordinatorRef = useRef<NavigationSpeechCoordinator<QueuedNavigationCommand> | null>(null)
  const sendInputRef = useRef<(value: string, meta?: VoiceSubmitMeta) => Promise<InputOutcome>>(async () => ({ sent: false }))
  const wakeCommandQueueRef = useRef<Array<{
    transcript: string
    meta: VoiceSubmitMeta
    generation: number
    resolve?: (outcome: InputOutcome) => void
  }>>([])
  const wakeCommandDrainingRef = useRef(false)
  const wakeCommandDrainGenerationRef = useRef(0)
  const enqueueWakeCommandRef = useRef<(transcript: string, meta: VoiceSubmitMeta) => Promise<InputOutcome>>(async () => ({ sent: false }))
  const systemUtteranceSequenceRef = useRef(0)
  const cockpitOperationSequenceRef = useRef(0)
  const arrivalEventIdsRef = useRef(new Map<NavigationLeg, string>())
  const wakeSessionRef = useRef<ReturnType<typeof createWakeSession> | null>(null)
  const localHandsFreeRef = useRef<LocalHandsFreeController | null>(null)
  const wakeRecognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const wakeRecognitionSourceRef = useRef<VoiceRecognitionSource>('microphone')
  const wakeRestartRef = useRef(false)
  const wakeRestartTimerRef = useRef<number | undefined>(undefined)
  const wakeTransientFailuresRef = useRef(0)
  const fixtureReplayRef = useRef(0)
  const confirmProductResetRef = useRef<() => Promise<void>>(async () => {})
  const openWakeRecognitionRef = useRef<() => boolean>(() => false)
  const voiceTurnConfigRef = useRef<VoiceTurnConfig>({
    autoSubmit: voiceAutoSubmit,
    recognitionSource: 'microphone',
  })
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
  const parkedVoiceMetaRef = useRef<VoiceSubmitMeta | undefined>(undefined)
  // Fixture-only injection is used by unit tests; the shipped demo leaves these props unset.
  const task = response?.task ?? localTask
  responseRef.current = response
  const localSpec = useMemo(() => {
    if (!task || response) return undefined
    return composePickupSpec(task, {
      ...composeContext,
      landingMessageRetryAvailable: composeContext.landingMessageRetryAvailable
        ?? Boolean(resolveAuthorizedLandingContact(task.passengers.memberIds, demoRuntime.preferences)),
    })
  }, [composeContext, response, task])
  const spec = response?.ui ?? localSpec
  // Agent-authored presentation owns task themes. Before the first task, the
  // shell and map follow the vehicle's sensed cabin light so demo controls have
  // an immediate visual effect without fabricating a task/spec.
  const cockpitTheme = task && spec
    ? spec.presentation.theme
    : (vehicleContext.isNight ? 'dark' : 'light')
  const effects = useMemo(() => response?.effects ?? [], [response])
  const remoteTaskId = response?.task.taskId
  const runtimeTask = task as unknown as RuntimeNavigationTask | undefined
  const navigationStatus = runtimeTask?.navigation?.status
  const cockpitWindows = spec ? runtimeWindows(spec) : []
  const newCockpitContract = Boolean(runtimeTask && (
    runtimeTask.pickupAirport
    || runtimeTask.navigationSimulation
    || runtimeTask.cockpit
    || ['collecting-airport', 'choosing-flight', 'confirming-outbound', 'outbound-driving', 'passengers-onboard', 'confirming-return', 'return-driving'].includes(runtimeTask.phase)
  ))
  const cockpitContract = Boolean(runtimeTask && spec && (
    (newCockpitContract && cockpitContractPhase(runtimeTask.phase))
    || runtimeTask.pickupAirport
    || cockpitWindows.length > 0
  ))
  const navigationActive = Boolean(runtimeTask && spec
    && runtimeTask.phase !== 'completed'
    && runtimeTask.phase !== 'cancelled'
    && newCockpitContract
    && (navigationStatus === 'active' || navigationStatus === 'arrived'
      || runtimeTask.phase === 'outbound-driving'
      || runtimeTask.phase === 'waiting-for-passengers'
      || runtimeTask.phase === 'passengers-onboard'
      || runtimeTask.phase === 'confirming-return'
      || runtimeTask.phase === 'return-driving'))
  navigationActiveRef.current = navigationActive

  useEffect(() => subscribeAMapLoader(setMapLoader), [])

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
        const next = {
          ...current,
          task: taskChanged ? update.snapshot.task : current.task,
          ui: uiChanged ? update.snapshot.ui : current.ui,
          effects: [],
        }
        responseRef.current = next
        return next
      })
    })
    return () => subscription.close()
  }, [api, localOnly, remoteTaskId])

  async function run(operation: () => Promise<AgentResponse>): Promise<AgentResponse | undefined> {
    if (pendingRef.current) return undefined
    const generation = mutationGenerationRef.current
    pendingRef.current = true
    setPending(true)
    setError(undefined)
    const baselineTaskId = responseRef.current?.task.taskId
    try {
      const candidate = await operation()
      if (generation !== mutationGenerationRef.current) return undefined
      const next = mergeResponseCandidate(candidate, baselineTaskId)
      if (!next) return undefined
      responseRef.current = next
      setResponse(next)
      return next
    } catch (cause) {
      if (generation !== mutationGenerationRef.current) return undefined
      setError(cause instanceof Error ? cause.message : '请求失败')
      return undefined
    } finally {
      if (generation === mutationGenerationRef.current) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }

  async function runCockpitOperation(
    descriptor: Pick<CockpitOperation, 'kind' | 'title' | 'message' | 'leg'>,
    operation: () => Promise<AgentResponse>,
    existing?: CockpitOperation,
  ): Promise<AgentResponse | undefined> {
    if (pendingRef.current) return undefined
    const generation = mutationGenerationRef.current
    const id = existing?.id ?? `cockpit-operation-${++cockpitOperationSequenceRef.current}`
    const attempt = (existing?.attempt ?? 0) + 1
    const taskId = existing?.taskId ?? responseRef.current?.task.taskId ?? 'new-task'
    const pendingOperation: CockpitOperation = {
      id, attempt, state: 'processing', retryable: true, taskId, retry: operation, ...descriptor,
    }
    setCockpitOperation(pendingOperation)
    pendingRef.current = true
    setPending(true)
    setError(undefined)
    const baselineTaskId = responseRef.current?.task.taskId
    try {
      const candidate = await operation()
      if (generation !== mutationGenerationRef.current) return undefined
      const next = mergeResponseCandidate(candidate, baselineTaskId)
      if (!next) return undefined
      responseRef.current = next
      setResponse(next)
      setCockpitOperation(undefined)
      return next
    } catch (cause) {
      if (generation !== mutationGenerationRef.current) return undefined
      if (cause instanceof AgentApiError && cause.latest) {
        const current = responseRef.current
        const next = current
          ? { ...current, task: cause.latest.task, ui: cause.latest.ui, effects: [] }
          : undefined
        const merged = next ? mergeResponseCandidate(next, current?.task.taskId) : undefined
        if (merged) {
          responseRef.current = merged
          setResponse(merged)
        }
      }
      const message = cause instanceof Error ? cause.message : '请求失败'
      setError(message)
      setCockpitOperation({
        ...pendingOperation,
        state: 'error',
        title: '操作未完成',
        message,
        retryable: !(cause instanceof AgentApiError) || cause.retryable,
      })
      return undefined
    } finally {
      if (generation === mutationGenerationRef.current) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }

  function retryCockpitOperation() {
    const operation = cockpitOperation
    if (!operation || operation.state !== 'error' || !operation.retryable || pendingRef.current) return
    const current = responseRef.current
    if (!current || current.task.taskId !== operation.taskId) {
      setCockpitOperation(undefined)
      return
    }
    if (operation.leg) {
      setRetryNavigationLeg({ leg: operation.leg, nonce: Date.now() })
      setCockpitOperation(undefined)
      return
    }
    void runCockpitOperation({ kind: operation.kind, title: operation.title, message: operation.message }, operation.retry, operation)
  }

  function mergeResponseCandidate(next: AgentResponse, baselineTaskId?: string): AgentResponse | undefined {
    const current = responseRef.current
    if (!current) return next
    if (baselineTaskId && current.task.taskId !== baselineTaskId) return undefined
    if (next.task.taskId !== current.task.taskId) {
      return current.task.phase === 'completed' || current.task.phase === 'cancelled' ? next : undefined
    }
    const taskRegressed = next.task.taskRevision < current.task.taskRevision
    const uiRegressed = next.ui.uiRevision < current.ui.uiRevision
    return {
      ...next,
      task: taskRegressed ? current.task : next.task,
      ui: uiRegressed ? current.ui : next.ui,
      effects: taskRegressed || uiRegressed ? [] : next.effects,
    }
  }

  /** The Agent decides what to say; the client only decides whether to play it. */
  function spokenReply(next: AgentResponse): string | undefined {
    return next.assistant?.shouldSpeak ? next.assistant.text : undefined
  }

  function enqueueSystemSpeech(text: string, kind = 'assistant') {
    systemUtteranceSequenceRef.current += 1
    wakeSessionRef.current?.setSpeaking(true)
    speechCoordinatorRef.current?.enqueueSystemUtterance({
      id: `${kind}-${systemUtteranceSequenceRef.current}`,
      text,
    })
  }

  function returnToIdle(notice?: string) {
    speechCoordinatorRef.current?.clear()
    stopDegradedFixtureAudio()
    responseRef.current = undefined
    setResponse(undefined)
    setLocalTask(undefined)
    setStepIndex(0)
    setError(undefined)
    setCockpitOperation(undefined)
    setWakeError(undefined)
    setQueuedVoiceNotice(undefined)
    mutationGenerationRef.current += 1
    for (const queued of wakeCommandQueueRef.current.splice(0)) queued.resolve?.({ sent: false })
    wakeCommandDrainGenerationRef.current += 1
    wakeCommandDrainingRef.current = false
    setRetryNavigationLeg(undefined)
    setLatestNavigationSnapshot(undefined)
    navigationSnapshotRef.current = undefined
    arrivalEventIdsRef.current.clear()
    setMapFollowing(true)
    setVehicleContext(startingVehicleContext)
    setText('')
    parkedVoiceMetaRef.current = undefined
    setDraftProtected(false)
    setKeyboardRequested(false)
    setControlsOpen(false)
    setIdleNotice(notice)
  }

  async function confirmProductReset() {
    if (resetInFlightRef.current) return
    const current = responseRef.current
    if (!current) {
      returnToIdle()
      return
    }
    if (!api.cancel) {
      setWakeError('当前运行环境无法重置任务，请改用文字输入或稍后重试。')
      return
    }
    resetInFlightRef.current = true
    mutationGenerationRef.current += 1
    // Reset supersedes every command from the previous task generation. Detach
    // an in-flight drain too: its request may never settle, but it must not keep
    // future wake commands blocked after reset succeeds or fails.
    for (const queued of wakeCommandQueueRef.current.splice(0)) queued.resolve?.({ sent: false })
    wakeCommandDrainGenerationRef.current += 1
    wakeCommandDrainingRef.current = false
    setQueuedVoiceNotice(undefined)
    setCockpitOperation({
      id: `cockpit-operation-${++cockpitOperationSequenceRef.current}`,
      attempt: 1,
      state: 'processing',
      kind: 'generic',
      title: '正在重新开始',
      message: '正在取消当前任务并清理临时窗口。',
      retryable: false,
      taskId: current.task.taskId,
      retry: () => api.cancel!(responseRef.current?.task ?? current.task, '用户确认重新开始'),
    })
    try {
      pendingRef.current = true
      setPending(true)
      setError(undefined)
      const resetTarget = responseRef.current?.task.taskId === current.task.taskId
        ? responseRef.current.task
        : current.task
      let cancelled: AgentResponse
      try {
        cancelled = await api.cancel(resetTarget, '用户确认重新开始')
      } catch (cause) {
        // A command already accepted by the Agent can advance the revision while
        // reset is being confirmed. Retry once with the authoritative same-task
        // snapshot; every other failure keeps its original error path.
        const latest = cause instanceof AgentApiError
          && cause.code === 'TASK_REVISION_CONFLICT'
          && cause.latest?.task.taskId === current.task.taskId
          ? cause.latest
          : undefined
        if (!latest) throw cause
        const refreshed: AgentResponse = {
          ...(responseRef.current ?? current),
          task: latest.task,
          ui: latest.ui,
          effects: [],
        }
        responseRef.current = refreshed
        setResponse(refreshed)
        cancelled = await api.cancel(latest.task, '用户确认重新开始')
      }
      if (cancelled.task.taskId !== current.task.taskId || cancelled.task.phase !== 'cancelled') {
        throw new Error('任务未能取消，请重试重新开始。')
      }
      returnToIdle()
      enqueueSystemSpeech('已重新开始', 'reset')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '重新开始失败，请稍后重试。'
      setError(message)
      setCockpitOperation({
        id: `cockpit-operation-${cockpitOperationSequenceRef.current}`,
        attempt: 1,
        state: 'error',
        kind: 'generic',
        title: '重新开始未完成',
        message,
        retryable: false,
        taskId: current.task.taskId,
        retry: () => api.cancel!(responseRef.current?.task ?? current.task, '用户确认重新开始'),
      })
    } finally {
      pendingRef.current = false
      setPending(false)
      resetInFlightRef.current = false
      if (wakeCommandQueueRef.current.length > 0) void drainWakeCommandQueue()
    }
  }
  confirmProductResetRef.current = confirmProductReset

  /**
   * The single input path. Text and voice both arrive here, so voice never gets
   * its own interpretation of what the driver said — `meta` only tells the
   * Gateway where the words came from.
   */
  async function sendInput(value: string, meta?: VoiceSubmitMeta): Promise<InputOutcome> {
    const trimmed = value.trim()
    if (!trimmed || pendingRef.current) return { sent: false }
    const currentResponse = responseRef.current
    // A completed cockpit task can still be waiting for a one-shot memory
    // decision. Resolve that before the terminal-state branch treats the words
    // as the start of a new task.
    const spokenConfirmation = currentResponse
      ? confirmationActionForVoice(currentResponse.task, currentResponse.ui, trimmed)
      : undefined
    if (currentResponse && spokenConfirmation) {
      const next = await run(() => api.confirmation(
        currentResponse.task,
        spokenConfirmation.confirmationId,
        spokenConfirmation.decision,
      ))
      if (!next) return { sent: false }
      const speak = spokenReply(next)
      setText('')
      setDraftProtected(false)
      if (completedPreferenceResolved(currentResponse.task, next.task)) returnToIdle('已到家')
      return { sent: true, speak }
    }
    // A stale or malformed UISpec must not turn a one-shot confirmation phrase
    // into a brand-new task. Refuse the turn so voice keeps the exact words for
    // retry, while typed input stays in the field unchanged.
    if (currentResponse?.task.phase === 'completed' && memoryConfirmationDecision(trimmed)) {
      return { sent: false }
    }
    const createNewTask = !currentResponse
      || currentResponse.task.phase === 'completed'
      || currentResponse.task.phase === 'cancelled'
    if (createNewTask && !localOnly) {
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
      const speak = spokenReply(created)
      setStepIndex(1)
      setText('')
      setDraftProtected(false)
      // Some replay/provider responses are terminal on creation. Return to the
      // persistent idle shell unless a follow-up confirmation still owns the turn.
      if ((created.task.phase === 'completed' || created.task.phase === 'cancelled')
        && !created.task.pendingConfirmation) {
        returnToIdle(speak ?? (created.task.phase === 'completed' ? '已到家' : undefined))
      }
      return { sent: true, speak }
    }
    if (!currentResponse) {
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
    const spokenAction = cockpitActionForVoice(
      currentResponse.task,
      currentResponse.ui as CockpitUISpec,
      trimmed,
    )
    if (spokenAction) {
      const next = await run(() => api.action(currentResponse, spokenAction.actionId, spokenAction.componentId))
      if (!next) return { sent: false }
      setText('')
      setDraftProtected(false)
      return { sent: true, speak: spokenReply(next) }
    }
    const registeredStartNavigation = hasStartNavigationCapability(
      currentResponse.ui,
      isDrivingVehicle(vehicleContext),
    )
    if (/^开始导航[。！!]?$/.test(trimmed.replace(/\s+/g, '')) && registeredStartNavigation) {
      const nextTimelineIndex = nextIndexForTimelineEvent('navigation.started')
      const next = await run(() => api.action(currentResponse, 'start-navigation', 'navigation-plan'))
      if (!next) return { sent: false }
      // An HTTP 200 with an unchanged task is a provider failure surfaced as a
      // fallback brief, not a started drive. The words stay in the field so 发送
      // can retry them — the same protection the drawer and card paths have.
      if (!navigationStarted(currentResponse, next)) return { sent: false }
      if (nextTimelineIndex !== undefined) {
        setStepIndex(consumeAdvisoryContext(nextTimelineIndex))
      }
      setText('')
      setDraftProtected(false)
      return { sent: true, speak: spokenReply(next) }
    }
    let nextTimelineIndex = timelineIndexForInput(trimmed)
    const descriptor = cockpitContract ? cockpitOperationForInput(trimmed) : undefined
    const activeNavigationSnapshot = navigationActiveRef.current
      && navigationSnapshotRef.current?.routeId === currentResponse.task.navigation?.routeId
      && (currentResponse.task.navigation?.status === 'active' || currentResponse.task.navigation?.status === 'arrived')
      ? navigationSnapshotRef.current
      : undefined
    const event = {
      type: 'user.input', text: trimmed, ...(meta ? { source: meta.source } : {}),
      ...(descriptor ? { eventId: `cockpit-event-${cockpitOperationSequenceRef.current + 1}` } : {}),
      ...(activeNavigationSnapshot
        ? { navigationSnapshot: activeNavigationSnapshot }
        : {}),
    } satisfies AgentEventInput
    const operation = () => api.event(responseRef.current?.task ?? currentResponse.task, event)
    const next = descriptor
      ? await runCockpitOperation(descriptor, operation)
      : await run(operation)
    if (!next) return { sent: false }
    if (nextTimelineIndex === undefined && attachedFlight(currentResponse, next)) {
      nextTimelineIndex = nextIndexForTimelineEvent('user.input')
    }
    if (nextTimelineIndex !== undefined && movedTheTrip(currentResponse, next)) setStepIndex(nextTimelineIndex)
    setText('')
    setDraftProtected(false)
    return { sent: true, speak: spokenReply(next) }
  }

  async function submitVoiceTranscript(transcript: string, meta: VoiceSubmitMeta) {
    if (navigationActiveRef.current && speechCoordinatorRef.current) {
      const queued = speechCoordinatorRef.current.enqueueCommand({
        intent: navigationVoiceIntent(transcript),
        transcript,
        meta: { ...meta, recognitionSource: meta.recognitionSource ?? 'microphone' },
      })
      if (queued === 'filtered' && meta.recognitionSource !== 'system-tts') {
        parkVoiceTranscript(transcript, '这句话可能来自当前播报，请确认后发送。', meta)
      }
      return undefined
    }
    const outcome = await sendInput(transcript, meta)
    if (!outcome.sent) parkVoiceTranscript(transcript, '语音指令未能提交，原话已保留，可直接重试。', meta)
    return outcome.speak
  }

  function parkVoiceTranscript(transcript: string, notice: string, meta?: VoiceSubmitMeta) {
    setText(transcript)
    setDraftProtected(true)
    setKeyboardRequested(true)
    setQueuedVoiceNotice(notice)
    parkedVoiceMetaRef.current = meta
  }

  async function drainWakeCommandQueue() {
    if (wakeCommandDrainingRef.current) return
    wakeCommandDrainingRef.current = true
    const drainGeneration = ++wakeCommandDrainGenerationRef.current
    try {
      while (drainGeneration === wakeCommandDrainGenerationRef.current && wakeCommandQueueRef.current.length > 0) {
        const command = wakeCommandQueueRef.current[0]!
        if (command.generation !== mutationGenerationRef.current) {
          wakeCommandQueueRef.current.shift()
          command.resolve?.({ sent: false })
          continue
        }
        if (pendingRef.current) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 80))
          continue
        }
        // Pop before the request begins. A terminal/reset transition invalidates
        // the drain generation and clears the queue; leaving this command at the
        // head would make that invalidation discard a newly queued command too.
        wakeCommandQueueRef.current.shift()
        const outcome = await sendInputRef.current(command.transcript, command.meta)
        command.resolve?.(outcome)
        if (drainGeneration !== wakeCommandDrainGenerationRef.current || command.generation !== mutationGenerationRef.current) return
        if (!outcome.sent) {
          parkVoiceTranscript(command.transcript, '语音指令未能提交，原话已保留，可直接重试。', command.meta)
          for (const queued of wakeCommandQueueRef.current.splice(0)) queued.resolve?.({ sent: false })
          break
        }
        setQueuedVoiceNotice(wakeCommandQueueRef.current.length > 0
          ? `正在处理下一条语音指令（剩余 ${wakeCommandQueueRef.current.length} 条）`
          : undefined)
        if (outcome.speak && !command.resolve) enqueueSystemSpeech(outcome.speak)
      }
    } finally {
      if (drainGeneration === wakeCommandDrainGenerationRef.current) wakeCommandDrainingRef.current = false
    }
  }

  function enqueueWakeCommand(transcript: string, meta: VoiceSubmitMeta): Promise<InputOutcome> {
    let resolve!: (outcome: InputOutcome) => void
    const completion = new Promise<InputOutcome>((next) => { resolve = next })
    wakeCommandQueueRef.current.push({ transcript, meta, generation: mutationGenerationRef.current, resolve })
    if (wakeCommandQueueRef.current.length > 1 || pendingRef.current) {
      setQueuedVoiceNotice(`已记住「${transcript}」，将在当前操作完成后执行。`)
    }
    void drainWakeCommandQueue()
    return completion
  }
  enqueueWakeCommandRef.current = enqueueWakeCommand

  // The navigation coordinator lives for the mounted App, while task/UI state
  // changes every turn. Keep queued commands pointed at the current input path.
  sendInputRef.current = sendInput

  // The next voice turn's engine. Arming a fixture sample makes exactly one
  // turn read from the recording instead of the microphone; the turn after
  // falls back to the real engine on its own.
  const armedFixtureRef = useRef<VoiceFixtureSample | null>(null)
  const fixtureAudioRef = useRef(fixtureAudio)
  const degradedFixtureAudioRef = useRef<ReturnType<typeof playFixtureSampleAudio>>(null)
  fixtureAudioRef.current = fixtureAudio

  useEffect(() => {
    const controller = createSpeechController({
      ...speech,
      createRecognition: () => null,
      handlers: {
        onSpeakEnd: () => {
          wakeSessionRef.current?.setSpeaking(false)
          const handsFree = localHandsFreeRef.current
          const generation = handsFree?.snapshot().activeTurnGeneration
          if (generation !== undefined) handsFree?.ttsEnded(generation)
          speechCoordinatorRef.current?.utteranceEnd()
        },
        onSpeakError: () => {
          wakeSessionRef.current?.setSpeaking(false)
          const handsFree = localHandsFreeRef.current
          const generation = handsFree?.snapshot().activeTurnGeneration
          if (generation !== undefined) handsFree?.ttsEnded(generation)
          speechCoordinatorRef.current?.utteranceError()
        },
      },
    })
    const coordinator = createNavigationSpeechCoordinator<QueuedNavigationCommand>({
      speak: ({ text: utterance }) => {
        const handsFree = localHandsFreeRef.current
        const generation = handsFree?.snapshot().activeTurnGeneration
        const started = controller.speak(utterance)
        if (started && generation !== undefined) handsFree?.ttsStarted(generation)
        return started
      },
      stopSpeaking: () => {
        controller.stopSpeaking()
      },
      executeCommand: async (command) => {
        const outcome = await sendInputRef.current(command.transcript, command.meta)
        if (outcome.speak && speechCoordinatorRef.current === coordinator) {
          systemUtteranceSequenceRef.current += 1
          coordinator.enqueueSystemUtterance({
            id: `assistant-${systemUtteranceSequenceRef.current}`,
            text: outcome.speak,
          })
        }
      },
      filterRecognition: (command, context) => {
        if (command.meta.recognitionSource === 'system-tts') return false
        const activeText = context.activeUtterance?.text
        return !activeText || normalizeVoiceEcho(command.transcript) !== normalizeVoiceEcho(activeText)
      },
    })
    speechCoordinatorRef.current = coordinator
    return () => {
      coordinator.dispose()
      controller.dispose()
      speechCoordinatorRef.current = null
    }
  // The controller reads the current command implementation through a ref and
  // the injected speech peripherals are fixed for one mounted App instance.
  }, [speech])

  useEffect(() => {
    speechCoordinatorRef.current?.clear()
  }, [remoteTaskId])

  useEffect(() => {
    if (task?.phase === 'completed' || task?.phase === 'cancelled') {
      speechCoordinatorRef.current?.clear()
    }
  }, [task?.phase])

  useEffect(() => {
    if (!initialNavigationReminder || !navigationActive || !speechCoordinatorRef.current) return
    let active = true
    queueMicrotask(() => {
      if (!active || !speechCoordinatorRef.current) return
      systemUtteranceSequenceRef.current += 1
      speechCoordinatorRef.current.enqueueSystemUtterance({
        id: `navigation-initial-${systemUtteranceSequenceRef.current}`,
        text: initialNavigationReminder,
      })
    })
    return () => { active = false }
  }, [initialNavigationReminder, navigationActive, remoteTaskId])

  function stopDegradedFixtureAudio() {
    fixtureReplayRef.current += 1
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

  function closeWakeRecognition() {
    wakeRestartRef.current = false
    if (wakeRestartTimerRef.current !== undefined) {
      window.clearTimeout(wakeRestartTimerRef.current)
      wakeRestartTimerRef.current = undefined
    }
    const engine = wakeRecognitionRef.current
    wakeRecognitionRef.current = null
    if (!engine) return
    engine.onresult = null
    engine.onerror = null
    engine.onend = null
    try {
      if (engine.abort) engine.abort()
      else engine.stop()
    } catch { /* recognition already closed */ }
  }

  // Local KWS owns the shipped always-on wake path. Keep an explicit kill
  // switch for hosts that cannot serve the model/COOP headers; missing assets
  // fail visibly instead of silently falling back to online Web Speech wake.
  const localWakeFeatureEnabled = localHandsFreeFactory !== createLocalHandsFreeController
    || import.meta.env.VITE_LOCAL_WAKE_ENABLED !== '0'
  const useLocalHandsFree = wakeWordEnabled
    && speech?.createRecognition === undefined
    && localWakeFeatureEnabled

  function restoreWakeRecognitionAfterFixture(replay: number, wasListening: boolean) {
    if (!wasListening || replay !== fixtureReplayRef.current) return
    wakeRecognitionSourceRef.current = 'microphone'
    if (openWakeRecognition()) return
    wakeSessionRef.current?.recognitionFailed()
    setWakeError('语音监听已中断，请点击「重试语音」继续，或改用文字输入。')
  }

  function openWakeRecognition(): boolean {
    closeWakeRecognition()
    const createRecognition = speech?.createRecognition
      ?? (isRecognitionSupported() && isSecureContextOk() ? createBrowserRecognition : undefined)
    if (!createRecognition) return false
    let engine: SpeechRecognitionLike | null = null
    try { engine = createRecognition() } catch { engine = null }
    if (!engine) return false
    engine.lang = 'zh-CN'
    engine.continuous = true
    engine.interimResults = true
    engine.maxAlternatives = 5
    engine.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (!result?.isFinal || !result.length) continue
        const alternatives = Array.from({ length: result.length }, (_, altIndex) => result[altIndex]).filter(
          (alternative): alternative is NonNullable<typeof alternative> => Boolean(alternative?.transcript),
        )
        const wakeAlternative = alternatives.find((alternative) => matchWakeWord(alternative.transcript).matched)
        const alternative = wakeAlternative ?? alternatives[0]
        if (!alternative) continue
        const transcript = alternative.transcript
        const activeSpeech = speechCoordinatorRef.current?.snapshot().activeUtterance?.text
        if (activeSpeech && normalizeVoiceEcho(transcript) === normalizeVoiceEcho(activeSpeech)) continue
        if (matchWakeWord(transcript).matched) speechCoordinatorRef.current?.clear()
        wakeSessionRef.current?.receive(transcript, {
          recognitionSource: wakeRecognitionSourceRef.current,
          ...(alternative.confidence === undefined ? {} : { confidence: alternative.confidence }),
        })
      }
    }
    engine.onerror = (event) => {
      // Chrome can report a transient network/service interruption even while
      // the microphone remains active. Let onend run the normal restart path;
      // permission and capture failures still surface as retryable errors.
      if ((event.error === 'no-speech' || event.error === 'network') && wakeRestartRef.current) {
        if (wakeTransientFailuresRef.current < 3) {
          wakeTransientFailuresRef.current += 1
          scheduleWakeRecognitionRestart()
          return
        }
      }
      wakeRestartRef.current = false
      wakeSessionRef.current?.recognitionFailed()
      setWakeError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? '麦克风权限未开启，请在浏览器设置中允许后点击「重试语音」，或使用文字输入。'
        : '语音识别服务暂时不可用，请点击「重试语音」或使用文字输入。')
    }
    engine.onend = () => {
      wakeRecognitionRef.current = null
      if (!wakeRestartRef.current) return
      scheduleWakeRecognitionRestart()
    }
    engine.onstart = () => {
      wakeTransientFailuresRef.current = 0
      wakeSessionRef.current?.recognitionStarted()
    }
    wakeRecognitionRef.current = engine
    wakeRestartRef.current = true
    try { engine.start() } catch {
      closeWakeRecognition()
      return false
    }
    return true
  }

  function scheduleWakeRecognitionRestart() {
    if (wakeRestartTimerRef.current !== undefined) return
    wakeRestartTimerRef.current = window.setTimeout(() => {
      wakeRestartTimerRef.current = undefined
      if (!wakeRestartRef.current) return
      if (!openWakeRecognition()) {
        wakeRestartRef.current = false
        wakeSessionRef.current?.recognitionFailed()
        setWakeError('语音监听已中断，请点击「重试语音」继续，或改用文字输入。')
      }
    }, 180)
  }
  openWakeRecognitionRef.current = openWakeRecognition

  useEffect(() => {
    const session = createWakeSession({
      effects: {
        requestRecognition: () => {
          if (useLocalHandsFree) {
            localHandsFreeRef.current?.dispose()
            const controller = localHandsFreeFactory({
              onWake: () => {
                speechCoordinatorRef.current?.clear()
                wakeSessionRef.current?.wakeDetected()
              },
              onSubmit: async (command, meta) => {
                const wakeSession = wakeSessionRef.current
                const wakeState = wakeSession?.snapshot().state
                const controlResult = wakeSession?.receive(command, { ...meta, controlsOnly: true })
                if (wakeState === 'reset-confirmation') {
                  const result = controlResult ?? 'ignored'
                  return result === 'ignored'
                }
                if (controlResult === 'accepted') return true
                const outcome = await enqueueWakeCommandRef.current(command, meta)
                if (!outcome.sent) return false
                if (outcome.speak) enqueueSystemSpeech(outcome.speak)
                return true
              },
              stopSpeaking: () => speechCoordinatorRef.current?.clear(),
              onError: (message) => {
                session.recognitionFailed()
                setWakeError(message)
              },
            })
            localHandsFreeRef.current = controller
            void controller.enable().then((enabled) => {
              if (localHandsFreeRef.current !== controller) return
              if (enabled) {
                session.recognitionStarted()
                setWakeError(undefined)
              } else if (session.snapshot().state !== 'needs-authorization') {
                session.recognitionFailed()
                setWakeError('本地语音唤醒启动失败，请点击「重试语音」或使用文字输入。')
              }
            })
            return
          }
          if (!openWakeRecognitionRef.current()) {
            session.recognitionFailed()
            setWakeError('当前浏览器无法启用语音唤醒，请使用文字输入。')
          }
        },
        stopSpeaking: () => speechCoordinatorRef.current?.clear(),
        submit: (command, meta) => {
          speechCoordinatorRef.current?.clear()
          enqueueWakeCommandRef.current(command, meta)
        },
        speak: (copy) => enqueueSystemSpeech(copy, 'xiaonan'),
        reset: () => { void confirmProductResetRef.current() },
        onState: () => setWakeSession(session.snapshot()),
      },
    })
    wakeSessionRef.current = session
    setWakeSession(session.snapshot())
    return () => {
      closeWakeRecognition()
      localHandsFreeRef.current?.dispose()
      localHandsFreeRef.current = null
      session.dispose()
      wakeSessionRef.current = null
    }
  }, [localHandsFreeFactory, speech, useLocalHandsFree])

  function enableWakeVoice() {
    setWakeError(undefined)
    wakeRecognitionSourceRef.current = 'microphone'
    if (wakeSession.state === 'needs-authorization') wakeSessionRef.current?.authorize()
    else if (useLocalHandsFree) {
      const controller = localHandsFreeRef.current
      if (!controller) wakeSessionRef.current?.recognitionFailed()
      else void controller.enable().then((enabled) => {
        if (enabled) {
          wakeSessionRef.current?.recognitionStarted()
          setWakeError(undefined)
        } else {
          wakeSessionRef.current?.recognitionFailed()
          setWakeError('本地语音唤醒启动失败，请点击「重试语音」或使用文字输入。')
        }
      })
    }
    else if (!openWakeRecognition()) {
      wakeSessionRef.current?.recognitionFailed()
      setWakeError('当前浏览器无法启用语音唤醒，请重试或使用文字输入。')
    }
  }

  function recoverMap(rotate: boolean) {
    setMapRuntimeFailed(false)
    setMapRetryNonce((current) => current + 1)
    void (rotate ? switchAMapKey() : retryAMap())
  }

  const voice = useVoice({
    enabled: voiceEnabled,
    onTranscript: submitVoiceTranscript,
    speech: voiceSpeech,
    // The recognition factory consumes the armed sample. Freeze its policy before
    // that happens so this machine turn retains fixture provenance and confirmation.
    autoSubmit: () => voiceTurnConfigRef.current.autoSubmit,
    recognitionSource: () => voiceTurnConfigRef.current.recognitionSource,
    speakReply: navigationActive
      ? (reply) => {
          systemUtteranceSequenceRef.current += 1
          speechCoordinatorRef.current?.enqueueSystemUtterance({
            id: `assistant-${systemUtteranceSequenceRef.current}`,
            text: reply,
          })
        }
      : undefined,
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
    if (wakeWordEnabled && wakeSession.state === 'reset-confirmation') {
      const result = wakeSessionRef.current?.receive(text)
      if (result === 'ignored') return
      setText('')
      setDraftProtected(false)
      setKeyboardRequested(false)
      return
    }
    if (wakeWordEnabled && isProductResetCommand(text)) {
      wakeSessionRef.current?.requestResetConfirmation()
      setText('')
      setDraftProtected(false)
      setKeyboardRequested(false)
      return
    }
    // While a transcript is awaiting confirmation, 发送 confirms it through the
    // machine so the voice loop keeps its state instead of being bypassed.
    if (voice.state === 'transcribing') {
      voice.submit(text)
      return
    }
    // Answering by hand during playback is a barge-in too: stop talking first.
    if (voice.state === 'speaking') voice.cancel()
    const parkedMeta = parkedVoiceMetaRef.current
    void sendInput(text, parkedMeta).then((outcome) => {
      // The words are gone, so the field that held them has done its job. Leaving
      // it open would put an empty input row back on screen permanently, which is
      // the thing the on-demand keyboard exists to avoid. A refused send keeps it:
      // `sendInput` leaves the text in place so 发送 can retry it.
      if (outcome.sent) {
        parkedVoiceMetaRef.current = undefined
        setKeyboardRequested(false)
      }
    })
  }

  function changeText(value: string) {
    setText(value)
    parkedVoiceMetaRef.current = undefined
    // Typing makes the words the driver's own; clearing the field by hand
    // releases them again.
    setDraftProtected(value.trim() !== '')
    // Editing a transcript is still the same turn; tell the machine so the
    // engine's confidence is dropped along with its guess.
    if (voice.state === 'transcribing') voice.edit(value)
  }

  function pressMicrophone() {
    if (wakeWordEnabled && (wakeSession.state === 'needs-authorization' || Boolean(wakeError))) {
      enableWakeVoice()
      return
    }
    if (wakeWordEnabled) return
    if (voice.state === 'listening') {
      voice.cancel()
      setText('')
      setDraftProtected(false)
      setKeyboardRequested(false)
      return
    }
    // Confirming is 发送's job, so here the button only leaves the voice turn.
    // Explicitly abandoning a confirmed transcript clears it just like cancelling
    // a live listening turn; fixture confirmation still keeps it until this action.
    if (voice.state === 'transcribing') {
      voice.cancel()
      setText('')
      setDraftProtected(false)
      setKeyboardRequested(false)
      return
    }
    // Starting a fresh voice turn is a decision to speak, so the keyboard the
    // driver may have opened earlier steps back out of the way.
    setKeyboardRequested(false)
    voiceTurnConfigRef.current = { autoSubmit: voiceAutoSubmit, recognitionSource: 'microphone' }
    voice.press()
  }

  async function completeNavigationLeg(leg: NavigationLeg): Promise<boolean> {
    if (onNavigationLegComplete) {
      try {
        return (await onNavigationLegComplete(leg)) !== false
      } catch {
        return false
      }
    }
    const currentResponse = responseRef.current
    if (!currentResponse) return true
    const snapshot = navigationSnapshotRef.current
    if (
      !snapshot
      || snapshot.routeId !== currentResponse.task.navigation?.routeId
      || snapshot.routeId !== currentResponse.task.navigationSimulation?.routeId
      || snapshot.leg !== leg
      || snapshot.leg !== currentResponse.task.navigationSimulation?.leg
      || snapshot.progress !== 1
      || snapshot.speedKph !== 0
    ) return false
    const event = leg === 'outbound'
      ? { type: 'navigation.outbound-arrived' as const, navigationSnapshot: snapshot }
      : { type: 'navigation.return-arrived' as const, navigationSnapshot: snapshot }
    const currentTask = currentResponse.task
    const descriptor = {
      kind: 'generic' as const,
      title: leg === 'outbound' ? '正在确认到达机场' : '正在确认已到家',
      message: '车辆已停止，地图和已打开窗口保持不变。',
      leg,
    }
    const eventId = arrivalEventIdsRef.current.get(leg) ?? `navigation-${leg}-arrived-${currentTask.taskId}`
    arrivalEventIdsRef.current.set(leg, eventId)
    const next = await runCockpitOperation(
      descriptor,
      async () => {
        const response = await api.event(responseRef.current?.task ?? currentTask, { ...event, eventId } as AgentEventInput)
        const expectedPhase = leg === 'outbound' ? 'waiting-for-passengers' : 'completed'
        if (response.task.phase !== expectedPhase) throw new Error('到达确认未推进任务，请重试。')
        return response
      },
    )
    if (!next) return false
    // A verified return-arrived event normally ends the visible journey. The
    // Agent may still own a one-shot preference confirmation; keep that compact
    // terminal turn visible until the driver accepts or declines it.
    if (leg === 'return' && !next.task.pendingConfirmation) returnToIdle('已到家')
    return true
  }

  function enqueueNavigationReminder(text: string) {
    systemUtteranceSequenceRef.current += 1
    speechCoordinatorRef.current?.enqueueSystemUtterance({
      id: `navigation-${systemUtteranceSequenceRef.current}`,
      text,
    })
  }

  function updateNavigationSnapshot(snapshot: NavigationSnapshot) {
    setLatestNavigationSnapshot(snapshot)
    const routeId = snapshot.routeId
      ?? runtimeTask?.navigationSimulation?.routeId
      ?? runtimeTask?.navigation?.routeId
    if (!snapshot.leg || !routeId) {
      navigationSnapshotRef.current = undefined
      return
    }
    navigationSnapshotRef.current = {
      routeId,
      leg: snapshot.leg,
      progress: snapshot.progress,
      speedKph: snapshot.speedKph,
      batteryPercent: snapshot.batteryPercent,
      remainingRangeKm: snapshot.remainingRangeKm,
      remainingDistanceKm: snapshot.remainingDistanceKm,
      eta: new Date(snapshot.etaMs ?? Date.now()).toISOString(),
      currentRoad: snapshot.road,
    }
  }

  useEffect(() => {
    if (!remoteTaskId || task?.phase === 'completed' || task?.phase === 'cancelled') {
      setCockpitOperation(undefined)
      setLatestNavigationSnapshot(undefined)
    }
  }, [remoteTaskId, task?.phase])

  const operationSpec = useMemo<UISpec | undefined>(() => {
    if (!spec || !cockpitOperation || cockpitOperation.taskId !== runtimeTask?.taskId) return spec
    const windowId = `${cockpitOperation.state}-${cockpitOperation.id}-${cockpitOperation.attempt}`
    const componentId = `${windowId}-status`
    const actionId = `${windowId}-retry`
    const error = cockpitOperation.state === 'error'
    return {
      ...spec,
      components: [...spec.components, {
        id: componentId,
        type: 'status-banner',
        ...(error && cockpitOperation.retryable ? { actions: [actionId] } : {}),
        props: {
          level: error ? 'error' : 'info',
          title: cockpitOperation.title,
          message: cockpitOperation.message,
        },
      }],
      actions: error && cockpitOperation.retryable
        ? [...spec.actions, { id: actionId, label: '重试', style: 'primary' as const, event: { type: 'dismiss' as const, targetId: cockpitOperation.id } }]
        : spec.actions,
      windows: [...runtimeWindows(spec), {
        id: windowId,
        kind: cockpitOperation.state,
        title: error ? '操作未完成' : cockpitOperation.title,
        componentIds: [componentId],
        ...(error && cockpitOperation.retryable ? { actionIds: [actionId] } : {}),
        size: 'compact',
        controls: { closable: error, minimizable: false, maximizable: false },
      }],
    }
  }, [cockpitOperation, runtimeTask?.taskId, spec])

  const windowSpec = operationSpec ?? spec
  const windowVehicle = latestNavigationSnapshot ?? (runtimeTask ? {
    leg: runtimeTask.navigationSimulation?.leg,
    routeId: runtimeTask.navigationSimulation?.routeId ?? runtimeTask.navigation?.routeId,
    runState: navigationActive ? 'driving' as const : runtimeTask.navigation?.status === 'arrived' ? 'arrived' as const : 'idle' as const,
    speedTier: runtimeTask.cockpit?.speedMode ?? 'normal',
    speedKph: navigationActive ? vehicleContext.speedKph : 0,
    progress: runtimeTask.cockpit?.routeProgress ?? 0,
    distanceKm: runtimeTask.navigationSimulation?.distanceKm ?? 0,
    travelledKm: 0,
    remainingDistanceKm: runtimeTask.navigationSimulation?.distanceKm ?? 0,
    batteryPercent: runtimeTask.navigationSimulation?.initialBatteryPercent ?? vehicleContext.batteryPercent,
    remainingRangeKm: vehicleContext.remainingRangeKm,
    remainingSeconds: 0,
    road: runtimeTask.cockpit?.currentRoad ?? '当前位置',
    maneuver: '等待开始导航',
    destination: runtimeTask.navigation?.destination ?? runtimeTask.pickupAirport?.label ?? '当前位置',
  } : undefined)

  function handleWindowAction(actionId: string, componentId: string) {
    if (cockpitOperation && actionId.includes(cockpitOperation.id) && actionId.endsWith('-retry')) {
      retryCockpitOperation()
      return
    }
    handleAction(actionId, componentId)
  }

  function setHudVisibility(visible: boolean) {
    const currentResponse = responseRef.current
    if (!currentResponse) return
    const text = visible ? '显示导航信息' : '隐藏导航信息'
    const operation = () => (api.event as unknown as (
      task: AirportPickupTaskState,
      event: { type: 'user.input'; text: string; source?: 'text' },
    ) => Promise<AgentResponse>)(responseRef.current?.task ?? currentResponse.task, { type: 'user.input', text, source: 'text' })
    void runCockpitOperation({ kind: 'generic', title: '正在调整导航信息', message: '车辆和地图继续运行。' }, operation)
  }

  // Replay may not steal a turn that is mid-capture or mid-confirm, and it may
  // not silently replace words someone could still lose — the driver's typing
  // or a parked transcript stay until they are sent or cleared by hand.
  const draftBlocksReplay = draftProtected && text.trim() !== ''
  const wakeBlocksReplay = wakeWordEnabled && (
    wakeSession.state === 'follow-up'
    || wakeSession.state === 'reset-confirmation'
    || wakeCommandDrainingRef.current
    || wakeCommandQueueRef.current.length > 0
  )
  const voiceFixtureReady = !pending && !draftBlocksReplay
    && !wakeBlocksReplay
    && (!voice.available || voice.state === 'idle' || voice.state === 'error' || voice.state === 'speaking')

  function isVoiceFixtureAvailable(sample: VoiceFixtureSample): boolean {
    // Reset confirmation is a live wake-session state rather than an Agent
    // input turn. Keep only its two dedicated fixtures reachable so replay can
    // feed the decision through wakeSession.receive without reopening ASR.
    if (wakeWordEnabled && wakeSession.state === 'reset-confirmation') {
      return !pending && !draftBlocksReplay && (sample.id === 'confirm-reset' || sample.id === 'cancel-reset')
    }
    if (!voiceFixtureReady) return false
    if (sample.id === 'create-airport-pickup' || sample.id === 'noisy-create') return !task
    if (!response || !spec) return false
    const derivedView = deriveCockpitView(spec)
    const driving = isDrivingVehicle(vehicleContext)
    if (sample.id === 'choose-hongqiao') return response.task.phase === 'collecting-airport'
    if (sample.id === 'select-first-flight' || sample.id === 'select-third-flight' || sample.id === 'refresh-flights') {
      return response.task.phase === 'choosing-flight' && derivedView.primaryWindow?.kind === 'flight-list'
    }
    if (sample.id === 'flight-number') {
      return response.task.phase === 'collecting-information' && response.task.flight === undefined
    }
    if (sample.id === 'check-weather' || sample.id === 'check-calendar' || sample.id === 'check-flight-detail' || sample.id === 'check-vehicle-status') {
      return response.task.phase !== 'completed' && response.task.phase !== 'cancelled'
    }
    if (sample.id === 'start-navigation') {
      return response.task.phase === 'confirming-outbound' && derivedView.primaryWindow?.kind === 'outbound-confirmation'
    }
    if (sample.id === 'speed-up' || sample.id === 'speed-down') {
      return response.task.phase === 'outbound-driving' || response.task.phase === 'return-driving'
    }
    if (sample.id === 'hide-hud') return driving && Boolean(response.task.cockpit?.hudVisible)
    if (sample.id === 'show-hud') return driving && response.task.cockpit?.hudVisible === false
    if (sample.id === 'send-weather-reminder') {
      return response.task.weatherAdvisory?.status === 'active'
        && hasWeatherAdvisoryCapability(spec, driving, 'send-umbrella-reminder', '提醒乘客带伞')
    }
    if (sample.id === 'dismiss-weather-advisory') {
      return response.task.weatherAdvisory?.status === 'active'
        && hasWeatherAdvisoryCapability(spec, driving, 'dismiss-advisory-weather', '暂不处理')
    }
    if (sample.id === 'keep-calendar-plan') return response.task.calendarAdvisory?.status === 'active'
    if (sample.id === 'passengers-onboard') return response.task.phase === 'waiting-for-passengers'
    if (sample.id === 'request-return') return response.task.phase === 'passengers-onboard'
    if (sample.id === 'start-return') return response.task.phase === 'confirming-return'
    if (sample.id === 'reset-trip') return Boolean(task) && !isTerminal
    if (sample.id === 'confirm-reset' || sample.id === 'cancel-reset') return wakeSession.state === 'reset-confirmation'
    if (sample.id === 'save-preferences' || sample.id === 'reject-preferences') {
      return response.task.phase === 'completed'
        && response.task.pendingConfirmation?.action === 'save-memory'
        && Boolean(confirmationActionForVoice(response.task, response.ui, sample.text))
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
    if (wakeWordEnabled) {
      stopDegradedFixtureAudio()
      setKeyboardRequested(false)
      setQueuedVoiceNotice(`正在回放「${sample.label}」`)
      const replay = fixtureReplayRef.current
      const wasListening = wakeRestartRef.current || Boolean(wakeRecognitionRef.current)
      closeWakeRecognition()
      let settled = false
      const settle = () => {
        if (settled || replay !== fixtureReplayRef.current) return
        settled = true
        degradedFixtureAudioRef.current = null
        if (sample.id === 'reset-trip') {
          wakeSessionRef.current?.requestResetConfirmation()
        } else if (sample.id === 'confirm-reset' || sample.id === 'cancel-reset') {
          wakeSessionRef.current?.receive(sample.text, { recognitionSource: 'fixture' })
        } else if (sample.requiresConfirmation) {
          parkVoiceTranscript(sample.text, '该样本需要确认，固定转写已保留，请按「发送」继续。', {
            source: 'voice',
            confidence: sample.confidence,
            recognitionSource: 'fixture',
          })
        } else {
          enqueueWakeCommand(sample.text, {
            source: 'voice',
            confidence: sample.confidence,
            recognitionSource: 'fixture',
          })
        }
        restoreWakeRecognitionAfterFixture(replay, wasListening)
      }
      degradedFixtureAudioRef.current = playFixtureSampleAudio(
        sample,
        fixtureAudioRef.current ?? undefined,
        settle,
      )
      return
    }
    if (voice.available) {
      stopDegradedFixtureAudio()
      setKeyboardRequested(false)
      armedFixtureRef.current = sample
      voiceTurnConfigRef.current = {
        autoSubmit: voiceAutoSubmit && !sample.requiresConfirmation,
        recognitionSource: 'fixture',
      }
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
    const currentResponse = responseRef.current
    if (!currentResponse) {
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
    const action = currentResponse.ui.actions.find((candidate) => candidate.id === actionId)
    const actionEvent = action?.event
    if (actionEvent?.type === 'confirmation') {
      const operation = () => api.confirmation(currentResponse.task, actionEvent.confirmationId, actionEvent.decision)
      void (cockpitContract
        ? runCockpitOperation({ kind: 'generic', title: '正在处理确认', message: '地图和已有窗口保持不变。' }, operation)
        : run(operation)).then((next) => {
        if (next && completedPreferenceResolved(currentResponse.task, next.task)) returnToIdle('已到家')
      })
    } else if (actionEvent?.type === 'agent-message') {
      // Pressing a row is the driver saying what it says. It travels as the same
      // user input the composer sends, so the planner sees one kind of answer and
      // a card can never set a slot that typing could not. The draft field is
      // left alone: the pick is not the sentence they were writing.
      const nextTimelineIndex = timelineIndexForInput(actionEvent.text)
      const latestSnapshot = navigationSnapshotRef.current
      const outboundArrivalSnapshot = latestSnapshot
        && actionId === 'confirm-passengers-onboard'
        && latestSnapshot.routeId === currentResponse.task.navigation?.routeId
        && latestSnapshot.leg === 'outbound'
        && latestSnapshot.progress === 1
          ? latestSnapshot
          : undefined
      const operation = () => api.event(responseRef.current?.task ?? currentResponse.task, {
        type: 'user.input', text: actionEvent.text,
        ...(outboundArrivalSnapshot ? { navigationSnapshot: outboundArrivalSnapshot } : {}),
      })
      void (cockpitContract
        ? runCockpitOperation({ kind: 'generic', title: '正在处理指令', message: '地图和车辆继续运行。' }, operation)
        : run(operation)).then((next) => {
        if (!next || nextTimelineIndex === undefined || !movedTheTrip(currentResponse, next)) return
        setStepIndex(nextTimelineIndex)
      })
    } else {
      const nextTimelineIndex = actionId === 'start-navigation'
        ? nextIndexForTimelineEvent('navigation.started')
        : undefined
      const operation = () => api.action(responseRef.current ?? currentResponse, actionId, componentId)
      void (cockpitContract
        ? runCockpitOperation({ kind: 'generic', title: '正在执行操作', message: '地图和车辆继续运行。' }, operation)
        : run(operation)).then((next) => {
        if (!next || nextTimelineIndex === undefined || !navigationStarted(currentResponse, next)) return
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

  // Local hands-free wake is an independent capability. Firefox and other
  // hosts may not expose SpeechRecognition while still providing the local
  // wake controller, so do not force the keyboard composer in that path.
  const voiceCapabilityUnavailable = !voice.available && !(voiceEnabled && wakeWordEnabled && useLocalHandsFree)
  const micState = voiceCapabilityUnavailable ? 'unavailable' : voice.state
  const microphoneCopy = wakeWordEnabled
    ? wakeError ? { aria: '重试语音唤醒', text: '重试语音' } : wakeButtonLabels[wakeSession.state]
    : voiceButtonLabels[micState]
  const microphoneDisabled = wakeWordEnabled
    ? !voiceEnabled || pending || (wakeSession.state !== 'needs-authorization' && !wakeError)
    : !voice.available || pending || micState === 'submitting'
  // One polite live region for the whole voice loop, so the mic state and the
  // interim words reach a screen reader without competing announcements.
  const voiceStatus = wakeWordEnabled && (wakeError || queuedVoiceNotice)
    ? wakeError ?? queuedVoiceNotice ?? ''
    : voice.error?.message
      ?? (voice.state === 'listening'
      ? voice.display || '正在聆听…'
      : voice.state === 'transcribing'
        ? '已转写，确认或编辑后发送。'
        : voice.state === 'submitting'
          ? '正在提交…'
          : voice.state === 'speaking'
            ? voice.speaking ?? '正在播报'
            : (voiceCapabilityUnavailable ? '语音不可用，请用文字告诉我。' : ''))

  // The keyboard is not a permanent fixture of the cabin. It appears when the
  // turn genuinely needs it and steps back out when it does not, so the journey
  // content keeps the space by default. Order matters: an unfinished transcript
  // is the most specific reason, and a missing capability the most absolute.
  // `submitting` keeps the field: the words the driver just confirmed stay on
  // screen until the Gateway accepts them, rather than blinking out and back.
  const composerReason: ComposerReason | undefined = voice.state === 'transcribing' || voice.state === 'submitting'
    ? 'transcript'
    : voiceCapabilityUnavailable
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
  const phaseIdentity = task ? phaseIdentityLabels[task.phase] : undefined
  // Model provenance comes straight from the Agent's response envelope: it is only
  // present when a validated model plan was actually applied, so showing it never
  // overstates what the model did. Rules-only turns render nothing.
  const modelUsed = response?.meta.modelUsed

  // How expensive the floating panel's blur is allowed to be on this machine.
  // Decided from what the device reports about itself rather than from which
  // engine is running, so a capable browser is never punished for being the
  // minority one — see `glass-capability.ts`.
  const glassTier = useGlassTier()

  // Keep one cockpit shell and one map owner for every task revision. The
  // Agent may replace slot contents, but it must not replace the outer DOM.
  const cockpitSessionKeyRef = useRef(initialTask?.taskId ?? 'cockpit-session')
  const cockpitSessionKey = cockpitSessionKeyRef.current
  // Operation windows are transient feedback, not the task's primary step. Derive
  // the primary window from the base Agent spec so a processing/error response
  // cannot displace the airport question or confirmation. The synthetic window
  // is then appended to the auxiliary set for the floating WindowManager.
  const baseCockpitView = deriveCockpitView(spec)
  const operationWindows = cockpitOperation && windowSpec && windowSpec !== spec
    ? runtimeWindows(windowSpec).filter((window) => window.id.includes(cockpitOperation.id))
    : []
  const cockpitView = {
    ...baseCockpitView,
    auxiliaryWindows: [...baseCockpitView.auxiliaryWindows, ...operationWindows],
  }
  const terminalConfirmationVisible = task?.phase === 'completed' && Boolean(task.pendingConfirmation)
  const primarySpec = cockpitView.primaryWindow
    ? windowUISpec(spec ?? windowSpec!, cockpitView.primaryWindow)
    : (cockpitView.mode === 'primary' || terminalConfirmationVisible) ? spec : undefined
  const auxiliarySpec = windowSpec
    ? { ...windowSpec, windows: cockpitView.auxiliaryWindows } as CockpitUISpec
    : undefined
  // Legacy task fixtures can still carry a real route/navigation phase without
  // the newer cockpit simulation seed. Keep the persistent map faithful to that
  // fact; only NavigationWorkspace requires the richer cockpit contract.
  const mapRouteActive = Boolean(runtimeTask && spec && (
    navigationActive
    || ['driving-to-airport', 'approaching-airport', 'returning-home'].includes(runtimeTask.phase)
  ))
  const routeSketch = mapRouteActive && runtimeTask && spec
    ? navigationSketchForTask(runtimeTask, spec)
    : undefined
  const mapMode = routeSketch ? 'route' as const : 'idle' as const
  const mapRouteId = runtimeTask?.navigation?.routeId ?? runtimeTask?.navigationSimulation?.routeId
  const mapLeg = runtimeTask?.cockpit?.activeLeg ?? runtimeTask?.navigationSimulation?.leg
  const mapSnapshotMatchesRoute = Boolean(
    mapRouteId
    && mapLeg
    && latestNavigationSnapshot?.routeId === mapRouteId
    && latestNavigationSnapshot.leg === mapLeg,
  )
  const mapProgress = mapSnapshotMatchesRoute
    ? latestNavigationSnapshot?.progress
    : runtimeTask?.navigation?.status === 'planned' ? 0 : undefined
  const mapRouteKey = mapRouteActive
    ? `${mapLeg ?? 'outbound'}:${mapRouteId ?? 'route'}`
    : 'idle'
  // The navigation HUD owns the full-screen driving surface, but waiting at
  // the airport and confirming the return still need their primary task card.
  const hideNavigationPrimary = navigationActive && cockpitView.mode === 'navigation'
    && task?.phase !== 'waiting-for-passengers'
    && task?.phase !== 'passengers-onboard'
    && task?.phase !== 'confirming-return'
  const entryContent = (
    <>
      <div className="header-actions">
        <button
          className={`mic-button mic-${micState}`}
          type="button"
          aria-label={wakeWordEnabled && wakeSession.state !== 'needs-authorization' && !wakeError
            ? '小南语音状态'
            : microphoneCopy.aria}
          title={microphoneCopy.aria}
          aria-pressed={wakeWordEnabled ? wakeSession.state === 'follow-up' : micState === 'listening'}
          disabled={microphoneDisabled}
          onClick={pressMicrophone}
        >
          <MicIcon size={22} /><span>{microphoneCopy.text}</span>
        </button>
        <button
          className={`keyboard-toggle${composerReason ? ' keyboard-toggle--open' : ''}`}
          type="button"
          aria-pressed={Boolean(composerReason)}
          aria-label={composerReason ? '收起文字输入' : '改用文字输入'}
          disabled={pending || textPathLocked || (Boolean(composerReason) && !composerDismissible)}
          onClick={toggleKeyboard}
        >
          <KeyboardIcon size={22} /><span>文字</span>
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
          <ControlsIcon size={22} /><span>演示控制</span>
        </button>
      </div>
      <p className="voice-status" role="status" aria-label="语音状态" aria-live="polite">
        {voiceStatus}
      </p>
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
            <button className="voice-composer__send" type="submit" disabled={pending || textPathLocked}>发送</button>
          </div>
        </form>
      ) : null}
    </>
  )

  return (
    <main
      className="demo-shell"
      data-controls-open={controlsOpen}
      data-phase={task?.phase}
      data-density={spec?.presentation.density}
      data-theme={cockpitTheme}
      data-priority={spec?.presentation.priority}
      data-glass={glassTier}
      data-navigation-toolbar={navigationActive ? (composerReason ? 'expanded' : 'compact') : undefined}
      style={GLASS_TIERS[glassTier]}
    >
      <CockpitWorkspace
        mode={cockpitView.mode}
        phase={cockpitView.phase}
        map={(
          <PersistentMapLayer
            mode={mapMode}
            sketch={routeSketch}
            progress={mapProgress}
            routeKey={mapRouteKey}
            theme={cockpitTheme}
            sessionKey={cockpitSessionKey}
            recoveryKey={task?.taskId ?? 'idle'}
            mapRetryNonce={mapRetryNonce}
            follow={mapFollowing}
            onManualInteraction={() => setMapFollowing(false)}
            onRecenter={() => setMapFollowing(true)}
            onRuntimeFailure={() => {
              setMapRuntimeFailed(true)
              setMapLoader(amapLoaderSnapshot())
            }}
            onRuntimeReady={() => setMapRuntimeFailed(false)}
          />
        )}
        status={<CockpitStatusBar vehicle={vehicleContext} phaseLabel={task ? phaseIdentity : undefined} />}
        feedback={(
          <>
            {!task && idleNotice ? <p className="cockpit-idle-notice" role="status">{idleNotice}</p> : null}
            {error ? <p className="brief-error" role="alert">{error}</p> : null}
          </>
        )}
        primary={hideNavigationPrimary || (cockpitView.mode === 'terminal' && !terminalConfirmationVisible) || (cockpitContract && Boolean(windowSpec) && !cockpitView.primaryWindow && !terminalConfirmationVisible)
          ? null
          : (
            <section
              className="cockpit-primary-panel"
              aria-label="当前行程"
              data-trip-brief
              data-primary-kind={cockpitView.primaryWindow?.kind}
              data-window-title={cockpitView.primaryWindow?.title ?? windowSpec?.title}
              data-phase={task?.phase}
              data-phase-label={phaseIdentity}
            >
              {task ? <JourneyPhaseRail phase={task.phase} /> : null}
              {primarySpec && task ? (
                <section className="cockpit-primary-panel__content" aria-label={`${cockpitView.primaryWindow?.title ?? windowSpec?.title ?? '当前行程'}窗口`}>
                  <UISpecRenderer
                    driving={isDrivingVehicle(vehicleContext)}
                    onAction={handleAction}
                    pending={pending}
                    spec={primarySpec}
                  />
                </section>
              ) : task ? <h1 className="sr-only">机场接人</h1> : (
                <section className="idle-cockpit" aria-label="空闲座舱">
                  <p className="idle-cockpit__location" aria-label="人民广场模拟车辆位置">模拟位置，非真实 GPS</p>
                </section>
              )}
            </section>
          )}
        hud={navigationActive && runtimeTask && spec ? (
          <NavigationWorkspace
            renderMap={false}
            task={runtimeTask!}
            spec={spec!}
            initialVehicle={startingVehicleContext}
            clock={navigationClock}
            pending={pending}
            onVehicleSnapshot={setVehicleContext}
            onSnapshot={updateNavigationSnapshot}
            onLegComplete={completeNavigationLeg}
            retryLeg={retryNavigationLeg}
            onReminder={enqueueNavigationReminder}
            onHudVisibilityChange={setHudVisibility}
          />
        ) : null}
        auxiliary={cockpitContract && auxiliarySpec && runtimeTask && windowVehicle ? (
          <WindowManager
            key={runtimeTask.taskId}
            spec={auxiliarySpec}
            pending={pending}
            driving={windowVehicle.runState === 'driving'}
            vehicle={windowVehicle}
            onAction={handleWindowAction}
            clear={runtimeTask.phase === 'completed'}
            preserveMissing={false}
            onWindowClose={(windowId) => {
              if (cockpitOperation && windowId.includes(cockpitOperation.id)) setCockpitOperation(undefined)
            }}
          />
        ) : null}
        entry={entryContent}
      />

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

            <div className="console-map-recovery" role="group" aria-label="地图恢复">
              <div className="console-map-recovery__copy">
                <span>地图服务</span>
                <strong>
                  {mapRuntimeFailed
                    ? '暂时不可用'
                    : mapLoader.state === 'ready'
                    ? `运行中 · Key ${Math.min((mapLoader.keyIndex ?? 0) + 1, Math.max(mapLoader.keyCount, 1))}`
                    : mapLoader.state === 'loading'
                      ? '正在恢复'
                      : mapLoader.state === 'failed'
                        ? '暂时不可用'
                        : mapLoader.keyCount > 0 ? '等待加载' : '未配置 Web JS Key'}
                </strong>
              </div>
              <div className="console-map-recovery__actions">
                <button type="button" disabled={mapLoader.state === 'loading'} onClick={() => recoverMap(false)}>
                  重新尝试地图
                </button>
                <button type="button" disabled={mapLoader.state === 'loading' || mapLoader.keyCount < 2} onClick={() => recoverMap(true)}>
                  切换 Key
                </button>
              </div>
              <p className="console-hint">只显示运行中的序号，不显示 Key 内容；失败时保留任务和语音状态。</p>
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
