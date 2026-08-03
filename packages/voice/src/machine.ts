import {
  isBlankTranscript,
  mergeInterim,
  normalizeConfidence,
  normalizeTranscript,
} from './transcript'
import {
  voiceError,
  type VoiceEffects,
  type VoiceError,
  type VoiceErrorKind,
  type VoiceMachineConfig,
  type VoiceState,
} from './types'

export type VoiceMachineSnapshot = {
  state: VoiceState
  /** Confirmed transcript awaiting the user's edit/confirm. */
  transcript: string
  /** In-flight partial result; cleared once the turn finalizes. */
  interim: string
  /** Transcript + interim, ready to render. */
  display: string
  confidence?: number
  error?: VoiceError
  /** Text queued for playback, kept so the UI can show it alongside the audio. */
  speaking?: string
}

export type VoiceMachineDeps = {
  effects?: VoiceEffects
  config?: VoiceMachineConfig
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type TimerName = 'listen' | 'submit'

const DEFAULT_LISTEN_MAX_MS = 12_000
const DEFAULT_SUBMIT_MAX_MS = 15_000

/**
 * The voice loop as a pure, dependency-injected state machine: no DOM, no
 * timers of its own, no task knowledge. Everything observable happens through
 * injected effects, which is what makes the whole loop testable in Node.
 *
 * Modeled on the cockpit-agent voice FSM, reduced to the P0 states.
 */
export function createVoiceMachine(deps: VoiceMachineDeps = {}) {
  const effects = deps.effects ?? {}
  const listenMaxMs = deps.config?.listenMaxMs ?? DEFAULT_LISTEN_MAX_MS
  const submitMaxMs = deps.config?.submitMaxMs ?? DEFAULT_SUBMIT_MAX_MS
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))

  let state: VoiceState = 'idle'
  let transcript = ''
  let interim = ''
  let confidence: number | undefined
  let error: VoiceError | undefined
  let speaking: string | undefined
  const timers = new Map<TimerName, unknown>()

  function setNamedTimer(name: TimerName, fn: () => void, ms: number) {
    clearNamedTimer(name)
    timers.set(name, setTimer(fn, ms))
  }

  function clearNamedTimer(name: TimerName) {
    const handle = timers.get(name)
    if (handle === undefined) return
    clearTimer(handle)
    timers.delete(name)
  }

  function clearAllTimers() {
    for (const name of [...timers.keys()]) clearNamedTimer(name)
  }

  function transition(next: VoiceState) {
    if (next === state) return
    const previous = state
    state = next
    effects.onState?.(next, previous)
  }

  function fail(kind: VoiceErrorKind) {
    clearAllTimers()
    effects.closeAsr?.()
    error = voiceError(kind)
    interim = ''
    speaking = undefined
    transition('error')
    effects.onError?.(error)
  }

  function beginListening() {
    clearAllTimers()
    error = undefined
    transcript = ''
    interim = ''
    confidence = undefined
    speaking = undefined
    transition('listening')
    effects.openAsr?.()
    setNamedTimer('listen', () => fail('timeout'), listenMaxMs)
  }

  function goIdle() {
    clearAllTimers()
    interim = ''
    speaking = undefined
    transition('idle')
  }

  function reviewTranscript(text: string, rawConfidence?: unknown) {
    clearAllTimers()
    if (state === 'listening') effects.closeAsr?.()
    if (state === 'speaking') effects.stopSpeak?.()
    const normalized = normalizeTranscript(text)
    interim = ''
    speaking = undefined
    error = undefined
    confidence = normalizeConfidence(rawConfidence)
    if (isBlankTranscript(normalized)) {
      fail('no-speech')
      return
    }
    transcript = normalized
    transition('transcribing')
  }

  return {
    snapshot(): VoiceMachineSnapshot {
      return {
        state,
        transcript,
        interim,
        display: mergeInterim(transcript, interim),
        confidence,
        error,
        speaking,
      }
    },

    /** Microphone button. Also the barge-in path while speaking. */
    press() {
      switch (state) {
        case 'idle':
        case 'error':
          beginListening()
          return
        case 'listening':
          // Second press ends the turn: keep whatever was heard so far.
          clearNamedTimer('listen')
          effects.closeAsr?.()
          if (isBlankTranscript(mergeInterim(transcript, interim))) {
            fail('no-speech')
            return
          }
          transcript = normalizeTranscript(mergeInterim(transcript, interim))
          interim = ''
          transition('transcribing')
          return
        case 'speaking':
          // Barge-in: cut the playback and start a new turn immediately.
          effects.stopSpeak?.()
          beginListening()
          return
        case 'transcribing':
        case 'submitting':
          // Ignore: the user is mid-confirm or mid-submit.
          return
      }
    },

    /** Engine reported an in-flight partial result. */
    asrPartial(text: string) {
      if (state !== 'listening') return
      interim = text
    },

    /** Engine reported a stable segment. Ends the listening turn. */
    asrFinal(text: string, rawConfidence?: unknown) {
      if (state !== 'listening') return
      reviewTranscript(mergeInterim(transcript, text), rawConfidence)
    },

    /** Loads a deterministic fallback transcript for review without an ASR engine. */
    loadTranscript(text: string, rawConfidence?: unknown) {
      reviewTranscript(text, rawConfidence)
    },

    asrError(kind: Extract<VoiceErrorKind, 'permission' | 'no-speech' | 'recognition'>) {
      if (state !== 'listening') return
      fail(kind)
    },

    /** Engine closed the stream without a final result. */
    asrEnd() {
      if (state !== 'listening') return
      clearNamedTimer('listen')
      const merged = normalizeTranscript(mergeInterim(transcript, interim))
      interim = ''
      if (isBlankTranscript(merged)) {
        fail('no-speech')
        return
      }
      transcript = merged
      transition('transcribing')
    },

    /** User edited the transcript before confirming. */
    edit(text: string) {
      if (state !== 'transcribing') return
      transcript = text
      // A hand-edited transcript is no longer the engine's guess.
      confidence = undefined
    },

    /**
     * Confirm and hand the transcript to the seam. `text` overrides the stored
     * transcript so a controlled input can submit without an extra edit round.
     */
    submit(text?: string) {
      if (state !== 'transcribing') return
      const candidate = normalizeTranscript(text ?? transcript)
      if (isBlankTranscript(candidate)) return
      transcript = candidate
      transition('submitting')
      setNamedTimer('submit', () => fail('timeout'), submitMaxMs)
      effects.submit?.(candidate, { source: 'voice', confidence })
    },

    /**
     * The seam finished. Passing `speakText` moves to playback; otherwise the
     * loop returns to idle. Never touches the transcript's task meaning.
     */
    submitDone(speakText?: string) {
      if (state !== 'submitting') return
      clearNamedTimer('submit')
      transcript = ''
      confidence = undefined
      if (speakText && !isBlankTranscript(speakText)) {
        speaking = speakText
        transition('speaking')
        effects.speak?.(speakText)
        return
      }
      goIdle()
    },

    /** Playback finished on its own. */
    speakEnd() {
      if (state !== 'speaking') return
      goIdle()
    },

    speakError() {
      if (state !== 'speaking') return
      fail('speak')
    },

    /** Explicit cancel: drop the turn without submitting anything. */
    cancel() {
      if (state === 'idle') return
      if (state === 'listening') effects.closeAsr?.()
      if (state === 'speaking') effects.stopSpeak?.()
      transcript = ''
      confidence = undefined
      error = undefined
      goIdle()
    },

    /** Dismiss an error back to idle without starting a turn. */
    reset() {
      transcript = ''
      confidence = undefined
      error = undefined
      goIdle()
    },

    /** Capability failures discovered outside the loop (no API, http://). */
    unavailable(kind: Extract<VoiceErrorKind, 'unsupported' | 'insecure-context'>) {
      fail(kind)
    },

    dispose() {
      clearAllTimers()
      if (state === 'listening') effects.closeAsr?.()
      if (state === 'speaking') effects.stopSpeak?.()
    },
  }
}

export type VoiceMachine = ReturnType<typeof createVoiceMachine>
