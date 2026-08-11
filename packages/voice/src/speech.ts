import { normalizeConfidence } from './transcript'
import type { VoiceErrorKind } from './types'

/**
 * Minimal structural types for the Web Speech API. TypeScript's DOM lib does
 * not ship `SpeechRecognition`, and declaring only what we touch keeps the fake
 * engines used in tests small.
 */
export type SpeechRecognitionAlternativeLike = {
  transcript: string
  confidence?: number
}

export type SpeechRecognitionResultLike = {
  isFinal: boolean
  length: number
  0: SpeechRecognitionAlternativeLike
}

export type SpeechRecognitionEventLike = {
  resultIndex: number
  results: { length: number } & Record<number, SpeechRecognitionResultLike>
}

export type SpeechRecognitionErrorEventLike = { error?: string }

export type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives?: number
  start: () => void
  stop: () => void
  abort?: () => void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  onstart?: (() => void) | null
}

export type SpeechUtteranceLike = {
  lang: string
  onend: (() => void) | null
  onerror: (() => void) | null
}

export type SpeechSynthesisLike = {
  speak: (utterance: SpeechUtteranceLike) => void
  cancel: () => void
}

export type SpeechControllerHandlers = {
  onPartial?: (text: string) => void
  onFinal?: (text: string, confidence?: number) => void
  onError?: (kind: Extract<VoiceErrorKind, 'permission' | 'no-speech' | 'recognition'>) => void
  onEnd?: () => void
  onSpeakEnd?: () => void
  onSpeakError?: () => void
}

export type SpeechControllerDeps = {
  createRecognition?: () => SpeechRecognitionLike | null
  getSynthesis?: () => SpeechSynthesisLike | null
  createUtterance?: (text: string) => SpeechUtteranceLike | null
  lang?: string
  handlers?: SpeechControllerHandlers
}

type RecognitionCtor = new () => SpeechRecognitionLike

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined
  const scope = window as unknown as Record<string, RecognitionCtor | undefined>
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

/** True when this browser exposes a speech recognition implementation. */
export function isRecognitionSupported(): boolean {
  return recognitionCtor() !== undefined
}

/**
 * Creates the browser's native recognition engine, or null when unsupported.
 * Exposed so a caller composing its own `createRecognition` (e.g. swapping in a
 * fixture engine for one turn) can still fall through to the real one.
 */
export function createBrowserRecognition(): SpeechRecognitionLike | null {
  const Ctor = recognitionCtor()
  return Ctor ? new Ctor() : null
}

/** True when this browser exposes speech synthesis. */
export function isSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * Web Speech needs a secure context for microphone access. `localhost` counts
 * as secure, which is what the dev server serves from.
 */
export function isSecureContextOk(): boolean {
  if (typeof window === 'undefined') return false
  if (window.isSecureContext) return true
  const host = window.location?.hostname ?? ''
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/** Maps Web Speech error codes onto the voice layer's error kinds. */
function mapRecognitionError(
  code: string | undefined,
): Extract<VoiceErrorKind, 'permission' | 'no-speech' | 'recognition'> {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'permission'
    case 'no-speech':
      return 'no-speech'
    default:
      return 'recognition'
  }
}

/**
 * Drives the real browser peripherals for the voice loop.
 *
 * Two generation guards. The recognition one is carried over from the
 * cockpit-agent hands-free controller, identifiers included; the playback one
 * applies the same technique, which upstream keeps in its TTS queue rather than
 * in the controller. See THIRD-PARTY-NOTICES.md for the exact comparison.
 *
 * - `asrGen` — every `startListening()` takes a new generation, and every
 *   recognition callback drops out unless it still owns the current one. A late
 *   `onresult` from the previous turn can therefore never hijack the next one.
 * - `speakGen` — same idea for playback, so a barge-in's `cancel()` cannot be
 *   followed by the aborted utterance's `onend` firing into the new turn.
 *
 * `dispose()` latches the controller closed so a React StrictMode remount
 * cannot revive a stale instance's peripherals.
 */
export function createSpeechController(deps: SpeechControllerDeps = {}) {
  const lang = deps.lang ?? 'zh-CN'
  const handlers = deps.handlers ?? {}
  const createRecognition = deps.createRecognition ?? createBrowserRecognition
  const getSynthesis = deps.getSynthesis ?? (() =>
    (typeof window !== 'undefined' && 'speechSynthesis' in window
      ? (window.speechSynthesis as unknown as SpeechSynthesisLike)
      : null))
  const createUtterance = deps.createUtterance ?? ((text: string) =>
    (typeof SpeechSynthesisUtterance === 'undefined'
      ? null
      : (new SpeechSynthesisUtterance(text) as unknown as SpeechUtteranceLike)))

  let disposed = false
  let asrGen = 0
  let speakGen = 0
  let recognition: SpeechRecognitionLike | null = null

  function detach(target: SpeechRecognitionLike) {
    target.onresult = null
    target.onerror = null
    target.onend = null
    if ('onstart' in target) target.onstart = null
  }

  function teardownRecognition() {
    const target = recognition
    recognition = null
    if (!target) return
    detach(target)
    try {
      if (target.abort) target.abort()
      else target.stop()
    } catch {
      // The engine may already be closed; nothing left to release.
    }
  }

  return {
    /** Opens a recognition turn. Returns false when nothing could be started. */
    startListening(): boolean {
      if (disposed) return false
      // Invalidate the previous turn before touching the engine, so its late
      // callbacks are already stale by the time this one wires up.
      const gen = ++asrGen
      const fresh = () => gen === asrGen && !disposed
      teardownRecognition()

      let engine: SpeechRecognitionLike | null = null
      try {
        engine = createRecognition()
      } catch {
        engine = null
      }
      if (!engine || !fresh()) {
        if (engine) detach(engine)
        return false
      }

      engine.lang = lang
      // The turn ends by the machine's silence policy, not by the first final
      // segment. This lets later phrases reset the five-second window.
      engine.continuous = true
      engine.interimResults = true
      if ('maxAlternatives' in engine) engine.maxAlternatives = 1

      engine.onresult = (event) => {
        if (!fresh()) return
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]
          if (!result) continue
          const alternative = result[0]
          if (!alternative) continue
          if (result.isFinal) {
            handlers.onFinal?.(alternative.transcript, normalizeConfidence(alternative.confidence))
          } else {
            handlers.onPartial?.(alternative.transcript)
          }
        }
      }
      engine.onerror = (event) => {
        if (!fresh()) return
        handlers.onError?.(mapRecognitionError(event?.error))
      }
      engine.onend = () => {
        if (!fresh()) return
        handlers.onEnd?.()
      }

      recognition = engine
      try {
        engine.start()
      } catch {
        // A double start throws in Chrome; treat it as a failed turn.
        if (fresh()) {
          teardownRecognition()
          handlers.onError?.('recognition')
        }
        return false
      }
      return true
    },

    /** Closes the current recognition turn and invalidates its callbacks. */
    stopListening() {
      asrGen += 1
      teardownRecognition()
    },

    /** Speaks one utterance. Returns false when synthesis is unavailable. */
    speak(text: string): boolean {
      if (disposed) return false
      const gen = ++speakGen
      const fresh = () => gen === speakGen && !disposed
      const synth = getSynthesis()
      const utterance = synth ? createUtterance(text) : null
      if (!synth || !utterance) return false

      utterance.lang = lang
      utterance.onend = () => {
        if (!fresh()) return
        handlers.onSpeakEnd?.()
      }
      utterance.onerror = () => {
        if (!fresh()) return
        handlers.onSpeakError?.()
      }

      try {
        synth.cancel()
        synth.speak(utterance)
      } catch {
        if (fresh()) handlers.onSpeakError?.()
        return false
      }
      return true
    },

    /** Cuts playback. The aborted utterance's callbacks become stale. */
    stopSpeaking() {
      speakGen += 1
      try {
        getSynthesis()?.cancel()
      } catch {
        // Nothing to cancel.
      }
    },

    dispose() {
      disposed = true
      asrGen += 1
      speakGen += 1
      teardownRecognition()
      try {
        getSynthesis()?.cancel()
      } catch {
        // Nothing to cancel.
      }
    },
  }
}

export type SpeechController = ReturnType<typeof createSpeechController>
