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

type TimerName = 'listen' | 'submit' | 'speak'

const DEFAULT_LISTEN_MAX_MS = 12_000
const DEFAULT_SUBMIT_MAX_MS = 15_000
/**
 * Generous enough that it never cuts a line short — the longest copy the Agent
 * authors is a sentence or two — and short enough that a mute engine does not
 * strand the loop for the rest of the drive.
 */
const DEFAULT_SPEAK_MAX_MS = 20_000

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
  const listenMaxMs = deps.config?.listenMaxMs ?? DEFAULT_LISTEN_MAX_MS
  const submitMaxMs = deps.config?.submitMaxMs ?? DEFAULT_SUBMIT_MAX_MS
  const speakMaxMs = deps.config?.speakMaxMs ?? DEFAULT_SPEAK_MAX_MS
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))

  let state: VoiceState = 'idle'
  let transcript = ''
  let interim = ''
  let confidence: number | undefined
  let error: VoiceError | undefined
  let speaking: string | undefined
  /**
   * Lines waiting behind the one being spoken. The queue lives here rather than
   * in the speech controller so `speaking` always names the line that is
   * actually audible: the machine hands the controller exactly one utterance and
   * does not hand it the next until that one ends. A controller-side queue would
   * play the right audio while the live region read the wrong line.
   */
  let pending: string[] = []
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
    pending = []
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
    pending = []
    transition('listening')
    effects.openAsr?.()
    setNamedTimer('listen', () => fail('timeout'), listenMaxMs)
  }

  function goIdle() {
    clearAllTimers()
    interim = ''
    speaking = undefined
    pending = []
    transition('idle')
  }

  /** Starts playback of one line. The caller owns the state it is starting from. */
  function beginSpeaking(text: string) {
    speaking = text
    transition('speaking')
    effects.speak?.(text)
    // A synthesis engine can accept an utterance and then report nothing at all:
    // a browser with no installed voices leaves `speaking` true and fires neither
    // `end` nor `error`. Without this the loop would never leave `speaking`, the
    // live region would read 正在播报 for the rest of the drive, and every later
    // announcement would queue behind a line that already finished being silent.
    setNamedTimer('speak', () => {
      if (state !== 'speaking') return
      // Silence the engine before moving on, in case it is merely slow rather
      // than mute and would otherwise talk over the next line.
      effects.stopSpeak?.()
      finishSpeaking()
    }, speakMaxMs)
  }

  /**
   * Ends the current utterance and takes the next queued line, if any. Reached
   * both when the engine reports the end and when the watchdog gives up on it:
   * an inaudible line is still a line that is over, and the content it carried is
   * on screen regardless, so this is deliberately not an error path.
   */
  function finishSpeaking() {
    clearNamedTimer('speak')
    const next = pending.shift()
    if (next !== undefined) {
      beginSpeaking(next)
      return
    }
    goIdle()
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
      clearNamedTimer('listen')
      const merged = normalizeTranscript(mergeInterim(transcript, text))
      interim = ''
      confidence = normalizeConfidence(rawConfidence)
      effects.closeAsr?.()
      if (isBlankTranscript(merged)) {
        fail('no-speech')
        return
      }
      transcript = merged
      transition('transcribing')
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
        beginSpeaking(speakText)
        return
      }
      goIdle()
    },

    /**
     * The Agent speaking on its own account — a turn the driver did not open.
     * Only `idle` and `speaking` accept it, and every refusal is deliberate:
     *
     * - `listening` — playback would go straight back into the open microphone.
     * - `transcribing` — the driver is reading the transcript to confirm it, and
     *   talking over that is talking over the thing being checked.
     * - `submitting` — the reply to that turn arrives through `submitDone`, which
     *   owns the playback. This is also what keeps a client that announces every
     *   response from speaking a voice turn's reply twice.
     * - `error` — starting playback would clear the error, and the error is what
     *   holds the text fallback open. A line is not worth costing the driver the
     *   only way left to answer.
     *
     * A refusal is silent: the line is on screen as a card either way, and voice
     * is never the only way the cabin says something.
     */
    announce(text: string) {
      if (isBlankTranscript(text)) return
      if (state === 'speaking') {
        // Queued rather than dropped: an advisory that arrives while the car is
        // finishing a sentence is still worth hearing a moment later.
        pending.push(text)
        return
      }
      if (state !== 'idle') return
      beginSpeaking(text)
    },

    /** Playback finished on its own. */
    speakEnd() {
      if (state !== 'speaking') return
      finishSpeaking()
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
