export const HANDS_FREE_STATE = {
  IDLE: 'IDLE',
  ARMED: 'ARMED',
  LISTENING: 'LISTENING',
  THINKING: 'THINKING',
  SPEAKING: 'SPEAKING',
  FOLLOW_UP: 'FOLLOW_UP',
} as const

export type HandsFreeState = typeof HANDS_FREE_STATE[keyof typeof HANDS_FREE_STATE]

export type HandsFreeInputSource = 'wake' | 'follow-up' | 'barge-in'

export type DetectorSession = {
  stop: () => void
}

export type WakeDetectorListener = {
  onWake: () => void
  onError: (error: unknown) => void
}

/** Always-on keyword detector. Browser, WASM, and vehicle DSP adapters share this seam. */
export interface WakeDetector {
  start(listener: WakeDetectorListener): DetectorSession | Promise<DetectorSession>
}

export type VadDetectorListener = {
  onSpeechStart: () => void
  onSpeechEnd: () => void
  onError: (error: unknown) => void
}

/** Always-on voice activity detector. It owns capture, not the state machine. */
export interface VadDetector {
  start(listener: VadDetectorListener): DetectorSession | Promise<DetectorSession>
}

export type CommandRecognitionOptions = {
  generation: number
  source: HandsFreeInputSource
  /** True for follow-up and barge-in so an adapter may inject microphone pre-roll. */
  speechAlreadyStarted: boolean
}

export type CommandRecognizerListener = {
  onPartial: (text: string) => void
  onFinal: (text: string, confidence?: number) => void
  onError: (error: unknown) => void
}

export interface CommandRecognitionSession extends DetectorSession {
  /** VAD found the endpoint; ask the recognizer to flush its final transcript. */
  endUtterance: () => void
}

/** Per-utterance ASR seam. Implementations may use Web Speech, streaming ASR, or fixtures. */
export interface CommandRecognizer {
  start(
    listener: CommandRecognizerListener,
    options: CommandRecognitionOptions,
  ): CommandRecognitionSession | Promise<CommandRecognitionSession>
}

export type HandsFreeCommand = {
  generation: number
  source: HandsFreeInputSource
  text: string
  confidence?: number
}

export type HandsFreeErrorStage = 'wake-detector' | 'vad-detector' | 'recognizer'

export type HandsFreeEffects = {
  onState?: (state: HandsFreeState, previous: HandsFreeState) => void
  onWake?: () => void
  onFalseWake?: () => void
  submitCommand?: (command: HandsFreeCommand) => void
  stopSpeaking?: (generation: number) => void
  cancelTurn?: (generation: number) => void
  onError?: (stage: HandsFreeErrorStage, error: unknown) => void
}

export type HandsFreeConfig = {
  falseWakeMs?: number
  followUpMs?: number
  bargeInMs?: number
}

export type HandsFreeMachineDeps = {
  wakeDetector: WakeDetector
  vadDetector: VadDetector
  commandRecognizer: CommandRecognizer
  effects?: HandsFreeEffects
  config?: HandsFreeConfig
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type HandsFreeSnapshot = {
  state: HandsFreeState
  enabled: boolean
  speechActive: boolean
  listeningSource?: HandsFreeInputSource
  activeTurnGeneration?: number
}

type TimerName = 'false-wake' | 'follow-up' | 'barge-in'

const DEFAULT_FALSE_WAKE_MS = 5_000
const DEFAULT_FOLLOW_UP_MS = 8_000
const DEFAULT_BARGE_IN_MS = 300

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function'
}

/**
 * Pure hands-free core. Hardware and browser APIs live behind injected ports;
 * every detector, recognizer, timer, and turn callback is generation-guarded.
 */
export function createHandsFreeMachine(deps: HandsFreeMachineDeps) {
  const effects = deps.effects ?? {}
  const falseWakeMs = deps.config?.falseWakeMs ?? DEFAULT_FALSE_WAKE_MS
  const followUpMs = deps.config?.followUpMs ?? DEFAULT_FOLLOW_UP_MS
  const bargeInMs = deps.config?.bargeInMs ?? DEFAULT_BARGE_IN_MS
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))

  let state: HandsFreeState = HANDS_FREE_STATE.IDLE
  let disposed = false
  let starting = false
  let enablePromise: Promise<boolean> | undefined
  // Track the physical VAD signal independently from the current FSM state.
  // KWS normally fires after speech has already started; carrying that fact
  // into LISTENING lets the same utterance reach its endpoint correctly.
  let vadSpeechActive = false
  let speechActive = false
  let listeningSource: HandsFreeInputSource | undefined
  let activeTurnGeneration: number | undefined
  let lifecycleGeneration = 0
  let recognitionGeneration = 0
  let nextTurnGeneration = 0
  let pendingEndpointGeneration: number | undefined
  let wakeSession: DetectorSession | undefined
  let vadSession: DetectorSession | undefined
  let recognitionSession: CommandRecognitionSession | undefined
  const timers = new Map<TimerName, unknown>()

  function snapshot(): HandsFreeSnapshot {
    return {
      state,
      enabled: state !== HANDS_FREE_STATE.IDLE,
      speechActive,
      listeningSource,
      activeTurnGeneration,
    }
  }

  function transition(next: HandsFreeState) {
    if (next === state) return
    const previous = state
    state = next
    effects.onState?.(next, previous)
  }

  function clearNamedTimer(name: TimerName) {
    const handle = timers.get(name)
    if (handle === undefined) return
    timers.delete(name)
    clearTimer(handle)
  }

  function setNamedTimer(name: TimerName, fn: () => void, ms: number) {
    clearNamedTimer(name)
    const handle = setTimer(() => {
      timers.delete(name)
      fn()
    }, ms)
    timers.set(name, handle)
  }

  function clearAllTimers() {
    for (const name of [...timers.keys()]) clearNamedTimer(name)
  }

  function reportError(stage: HandsFreeErrorStage, error: unknown) {
    effects.onError?.(stage, error)
  }

  function stopSession(session: DetectorSession | undefined, stage: HandsFreeErrorStage) {
    if (!session) return
    try {
      session.stop()
    } catch (error) {
      reportError(stage, error)
    }
  }

  function closeRecognizer() {
    recognitionGeneration += 1
    pendingEndpointGeneration = undefined
    const session = recognitionSession
    recognitionSession = undefined
    stopSession(session, 'recognizer')
  }

  function invalidateTurn(cancel: boolean) {
    const generation = activeTurnGeneration
    activeTurnGeneration = undefined
    if (cancel && generation !== undefined) effects.cancelTurn?.(generation)
  }

  function goArmed() {
    clearAllTimers()
    closeRecognizer()
    speechActive = false
    listeningSource = undefined
    invalidateTurn(false)
    transition(HANDS_FREE_STATE.ARMED)
  }

  function goFollowUp() {
    clearAllTimers()
    closeRecognizer()
    speechActive = false
    listeningSource = undefined
    invalidateTurn(false)
    transition(HANDS_FREE_STATE.FOLLOW_UP)
    const lifecycle = lifecycleGeneration
    setNamedTimer('follow-up', () => {
      if (lifecycle !== lifecycleGeneration || state !== HANDS_FREE_STATE.FOLLOW_UP) return
      goArmed()
    }, followUpMs)
  }

  function recognitionFailed(error: unknown, generation: number) {
    if (
      generation !== recognitionGeneration
      || state !== HANDS_FREE_STATE.LISTENING
    ) return
    reportError('recognizer', error)
    goArmed()
  }

  function acceptFinal(text: string, generation: number, confidence?: number) {
    if (
      generation !== recognitionGeneration
      || state !== HANDS_FREE_STATE.LISTENING
    ) return

    const normalized = text.trim()
    const source = listeningSource ?? 'wake'
    clearAllTimers()
    closeRecognizer()
    speechActive = false

    if (!normalized) {
      goFollowUp()
      return
    }

    const turnGeneration = ++nextTurnGeneration
    activeTurnGeneration = turnGeneration
    listeningSource = undefined
    transition(HANDS_FREE_STATE.THINKING)
    effects.submitCommand?.({
      generation: turnGeneration,
      source,
      text: normalized,
      ...(confidence === undefined ? {} : { confidence }),
    })
  }

  function endRecognitionSession(session: CommandRecognitionSession, generation: number) {
    if (
      generation !== recognitionGeneration
      || session !== recognitionSession
      || state !== HANDS_FREE_STATE.LISTENING
    ) return
    try {
      session.endUtterance()
    } catch (error) {
      recognitionFailed(error, generation)
    }
  }

  function installRecognitionSession(session: CommandRecognitionSession, generation: number) {
    if (
      generation !== recognitionGeneration
      || state !== HANDS_FREE_STATE.LISTENING
    ) {
      stopSession(session, 'recognizer')
      return
    }
    recognitionSession = session
    if (pendingEndpointGeneration !== generation) return
    pendingEndpointGeneration = undefined
    endRecognitionSession(session, generation)
  }

  function openRecognizer(source: HandsFreeInputSource, speechAlreadyStarted: boolean) {
    clearAllTimers()
    closeRecognizer()
    listeningSource = source
    speechActive = speechAlreadyStarted
    transition(HANDS_FREE_STATE.LISTENING)

    const generation = recognitionGeneration
    if (!speechAlreadyStarted) {
      const lifecycle = lifecycleGeneration
      setNamedTimer('false-wake', () => {
        if (
          lifecycle !== lifecycleGeneration
          || generation !== recognitionGeneration
          || state !== HANDS_FREE_STATE.LISTENING
          || speechActive
        ) return
        effects.onFalseWake?.()
        goArmed()
      }, falseWakeMs)
    }

    const listener: CommandRecognizerListener = {
      onPartial: (text) => {
        if (
          generation !== recognitionGeneration
          || state !== HANDS_FREE_STATE.LISTENING
          || !text.trim()
        ) return
        speechActive = true
        clearNamedTimer('false-wake')
      },
      onFinal: (text, confidence) => { acceptFinal(text, generation, confidence) },
      onError: (error) => { recognitionFailed(error, generation) },
    }

    let started: CommandRecognitionSession | Promise<CommandRecognitionSession>
    try {
      started = deps.commandRecognizer.start(listener, {
        generation,
        source,
        speechAlreadyStarted,
      })
    } catch (error) {
      recognitionFailed(error, generation)
      return
    }

    if (!isPromiseLike(started)) {
      installRecognitionSession(started, generation)
      return
    }
    void started.then(
      (session) => { installRecognitionSession(session, generation) },
      (error) => { recognitionFailed(error, generation) },
    )
  }

  function wake() {
    if (disposed) return
    switch (state) {
      case HANDS_FREE_STATE.ARMED:
      case HANDS_FREE_STATE.FOLLOW_UP:
        effects.onWake?.()
        openRecognizer('wake', vadSpeechActive)
        return
      case HANDS_FREE_STATE.THINKING:
        invalidateTurn(true)
        effects.onWake?.()
        openRecognizer('wake', vadSpeechActive)
        return
      case HANDS_FREE_STATE.SPEAKING: {
        const generation = activeTurnGeneration
        invalidateTurn(false)
        if (generation !== undefined) effects.stopSpeaking?.(generation)
        effects.onWake?.()
        openRecognizer('wake', vadSpeechActive)
        return
      }
      default:
        return
    }
  }

  function speechStarted() {
    if (disposed) return
    vadSpeechActive = true
    switch (state) {
      case HANDS_FREE_STATE.LISTENING:
        speechActive = true
        clearNamedTimer('false-wake')
        return
      case HANDS_FREE_STATE.FOLLOW_UP:
        openRecognizer('follow-up', true)
        return
      case HANDS_FREE_STATE.SPEAKING: {
        if (speechActive) return
        speechActive = true
        const lifecycle = lifecycleGeneration
        const turnGeneration = activeTurnGeneration
        setNamedTimer('barge-in', () => {
          if (
            lifecycle !== lifecycleGeneration
            || state !== HANDS_FREE_STATE.SPEAKING
            || !speechActive
            || turnGeneration === undefined
            || turnGeneration !== activeTurnGeneration
          ) return
          invalidateTurn(false)
          effects.stopSpeaking?.(turnGeneration)
          openRecognizer('barge-in', true)
        }, bargeInMs)
        return
      }
      default:
        return
    }
  }

  function speechEnded() {
    if (disposed) return
    vadSpeechActive = false
    if (state === HANDS_FREE_STATE.SPEAKING) {
      speechActive = false
      clearNamedTimer('barge-in')
      return
    }
    if (state !== HANDS_FREE_STATE.LISTENING || !speechActive) return
    speechActive = false
    const generation = recognitionGeneration
    if (!recognitionSession) {
      pendingEndpointGeneration = generation
      return
    }
    endRecognitionSession(recognitionSession, generation)
  }

  function shutdown() {
    lifecycleGeneration += 1
    starting = false
    enablePromise = undefined
    clearAllTimers()
    closeRecognizer()

    const wake = wakeSession
    const vad = vadSession
    wakeSession = undefined
    vadSession = undefined

    const stoppedState = state
    const stoppedTurnGeneration = activeTurnGeneration
    activeTurnGeneration = undefined
    if (stoppedTurnGeneration !== undefined) {
      if (stoppedState === HANDS_FREE_STATE.SPEAKING) {
        effects.stopSpeaking?.(stoppedTurnGeneration)
      } else if (stoppedState === HANDS_FREE_STATE.THINKING) {
        effects.cancelTurn?.(stoppedTurnGeneration)
      }
    }
    stopSession(wake, 'wake-detector')
    stopSession(vad, 'vad-detector')
    vadSpeechActive = false
    speechActive = false
    listeningSource = undefined
    transition(HANDS_FREE_STATE.IDLE)
  }

  function detectorFailed(
    stage: Extract<HandsFreeErrorStage, 'wake-detector' | 'vad-detector'>,
    error: unknown,
    generation: number,
  ) {
    if (generation !== lifecycleGeneration || disposed) return
    reportError(stage, error)
    shutdown()
  }

  async function startDetectors(generation: number): Promise<boolean> {
    let stage: Extract<HandsFreeErrorStage, 'wake-detector' | 'vad-detector'> = 'vad-detector'
    try {
      const vad = await deps.vadDetector.start({
        onSpeechStart: () => {
          if (generation === lifecycleGeneration) speechStarted()
        },
        onSpeechEnd: () => {
          if (generation === lifecycleGeneration) speechEnded()
        },
        onError: (error) => { detectorFailed('vad-detector', error, generation) },
      })
      if (generation !== lifecycleGeneration || disposed) {
        stopSession(vad, 'vad-detector')
        return false
      }
      vadSession = vad

      stage = 'wake-detector'
      const wakeDetectorSession = await deps.wakeDetector.start({
        onWake: () => {
          if (generation === lifecycleGeneration) wake()
        },
        onError: (error) => { detectorFailed('wake-detector', error, generation) },
      })
      if (generation !== lifecycleGeneration || disposed) {
        stopSession(wakeDetectorSession, 'wake-detector')
        return false
      }
      wakeSession = wakeDetectorSession
      starting = false
      transition(HANDS_FREE_STATE.ARMED)
      return true
    } catch (error) {
      if (generation !== lifecycleGeneration || disposed) return false
      reportError(stage, error)
      shutdown()
      return false
    }
  }

  function enable(): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    if (state !== HANDS_FREE_STATE.IDLE) return Promise.resolve(true)
    if (enablePromise) return enablePromise

    const generation = ++lifecycleGeneration
    starting = true
    const pending = startDetectors(generation)
    enablePromise = pending
    void pending.finally(() => {
      if (enablePromise === pending) enablePromise = undefined
      if (generation === lifecycleGeneration) starting = false
    })
    return pending
  }

  function disable() {
    if (
      state === HANDS_FREE_STATE.IDLE
      && !starting
      && !wakeSession
      && !vadSession
      && !recognitionSession
      && timers.size === 0
    ) return
    shutdown()
  }

  function isFreshTurn(generation: number) {
    return generation === activeTurnGeneration
  }

  return {
    snapshot,
    enable,
    disable,
    wake,
    speechStarted,
    speechEnded,

    turnEnded(generation: number, followUp = true) {
      if (!isFreshTurn(generation) || state !== HANDS_FREE_STATE.THINKING) return
      if (followUp) goFollowUp()
      else goArmed()
    },

    ttsStarted(generation: number) {
      if (!isFreshTurn(generation) || state !== HANDS_FREE_STATE.THINKING) return
      clearAllTimers()
      speechActive = false
      transition(HANDS_FREE_STATE.SPEAKING)
    },

    ttsEnded(generation: number) {
      if (
        !isFreshTurn(generation)
        || (
          state !== HANDS_FREE_STATE.THINKING
          && state !== HANDS_FREE_STATE.SPEAKING
        )
      ) return
      goFollowUp()
    },

    dispose() {
      if (disposed) return
      disposed = true
      shutdown()
    },
  }
}

export type HandsFreeMachine = ReturnType<typeof createHandsFreeMachine>
