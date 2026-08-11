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
  type VoiceRecognitionSource,
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
  recognitionSource?: VoiceRecognitionSource
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type TimerName = 'listen' | 'submit'

const DEFAULT_SILENCE_MS = 5_000
const DEFAULT_SUBMIT_MAX_MS = 15_000

/**
 * The voice loop as a pure, dependency-injected state machine: no DOM, no
 * timers of its own, no task knowledge. Everything observable happens through
 * injected effects, which is what makes the whole loop testable in Node.
 *
 * Modeled on the cockpit-agent voice FSM, reduced to the P0 states. The states
 * and transitions are this project's own; see THIRD-PARTY-NOTICES.md for what
 * was and was not taken.
 */
export function createVoiceMachine(deps: VoiceMachineDeps = {}) {
  const effects = deps.effects ?? {}
  const silenceMs = deps.config?.silenceMs
    ?? deps.config?.listenMaxMs
    ?? DEFAULT_SILENCE_MS
  const autoSubmit = deps.config?.autoSubmit ?? true
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

  function submitTranscript(candidate: string) {
    transcript = normalizeTranscript(candidate)
    transition('submitting')
    setNamedTimer('submit', () => fail('timeout'), submitMaxMs)
    effects.submit?.(transcript, {
      source: 'voice',
      confidence,
      ...(deps.recognitionSource ? { recognitionSource: deps.recognitionSource } : {}),
    })
  }

  function finishListening(candidate: string) {
    clearNamedTimer('listen')
    interim = ''
    const normalized = normalizeTranscript(candidate)
    if (isBlankTranscript(normalized)) {
      fail('no-speech')
      return
    }
    effects.closeAsr?.()
    transcript = normalized
    if (autoSubmit) {
      submitTranscript(normalized)
      return
    }
    transition('transcribing')
  }

  function silenceElapsed() {
    if (state !== 'listening') return
    finishListening(mergeInterim(transcript, interim))
  }

  function resetSilenceTimer() {
    setNamedTimer('listen', silenceElapsed, silenceMs)
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
    resetSilenceTimer()
  }

  function goIdle() {
    clearAllTimers()
    interim = ''
    speaking = undefined
    transition('idle')
  }

  function reportSpeakFailure() {
    const playbackError = voiceError('speak')
    error = playbackError
    speaking = undefined
    transition('idle')
    effects.onError?.(playbackError)
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
          finishListening(mergeInterim(transcript, interim))
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
      if (!isBlankTranscript(text)) resetSilenceTimer()
    },

    /** Engine reported a stable segment. Keep listening until five seconds of silence. */
    asrFinal(text: string, rawConfidence?: unknown) {
      if (state !== 'listening') return
      const merged = normalizeTranscript(mergeInterim(transcript, text || interim))
      interim = ''
      confidence = normalizeConfidence(rawConfidence)
      if (isBlankTranscript(merged)) {
        fail('no-speech')
        return
      }
      transcript = merged
      if (!autoSubmit) {
        finishListening(merged)
        return
      }
      resetSilenceTimer()
    },

    asrError(kind: Extract<VoiceErrorKind, 'permission' | 'no-speech' | 'recognition'>) {
      if (state !== 'listening') return
      fail(kind)
    },

    /** Engine closed the stream without a final result. */
    asrEnd() {
      if (state !== 'listening') return
      const merged = normalizeTranscript(mergeInterim(transcript, interim))
      if (!autoSubmit) {
        finishListening(merged)
        return
      }
      if (isBlankTranscript(merged)) {
        fail('no-speech')
        return
      }
      // Continuous engines should remain open, but browsers can still end a
      // stream after a final result. Preserve the words and let the same silence
      // timer finish the turn instead of treating engine closure as user intent.
      transcript = merged
      interim = ''
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
      submitTranscript(candidate)
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
        try {
          if (!effects.speak || effects.speak(speakText) === false) reportSpeakFailure()
        } catch {
          reportSpeakFailure()
        }
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
      reportSpeakFailure()
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
