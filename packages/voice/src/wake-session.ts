import { normalizeTranscript } from './transcript'
import { matchWakeWord } from './wake-word'
import type { VoiceRecognitionSource, VoiceSubmitMeta } from './types'

export type WakeSessionState =
  | 'needs-authorization'
  | 'authorizing'
  | 'waiting-wake'
  | 'follow-up'
  | 'reset-confirmation'

export type WakeSessionSnapshot = {
  state: WakeSessionState
  speaking: boolean
}

export type WakeSessionEffects = {
  requestRecognition?: () => void
  speak?: (text: string) => void
  stopSpeaking?: () => void
  submit?: (text: string, meta: VoiceSubmitMeta) => void
  reset?: () => void
  resetCancelled?: (reason: 'cancelled' | 'timeout') => void
  onTimeout?: (kind: 'follow-up' | 'reset-confirmation') => void
  onState?: (state: WakeSessionState, previous: WakeSessionState) => void
}

export type WakeSessionDeps = {
  effects?: WakeSessionEffects
  followUpMs?: number
  resetConfirmMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const DEFAULT_FOLLOW_UP_MS = 5_000
const DEFAULT_RESET_CONFIRM_MS = 5_000
const RESET_PROMPT = '当前任务还没有完成，确定要重新开始吗？'

function isResetCommand(text: string) {
  const normalized = normalizeTranscript(text).replace(/[，,。.!！?？：:；;]+$/u, '')
  return /^(?:重新开始|重来|重置)$/u.test(normalized)
}

function resetDecision(text: string): 'confirm' | 'cancel' | undefined {
  const normalized = normalizeTranscript(text).replace(/[，,。.!！?？：:；;]+$/u, '')
  if (/^(?:确定|是)$/u.test(normalized)) return 'confirm'
  if (/^取消$/u.test(normalized)) return 'cancel'
  return undefined
}

export function createWakeSession(deps: WakeSessionDeps = {}) {
  const effects = deps.effects ?? {}
  const followUpMs = deps.followUpMs ?? DEFAULT_FOLLOW_UP_MS
  const resetConfirmMs = deps.resetConfirmMs ?? DEFAULT_RESET_CONFIRM_MS
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))

  let state: WakeSessionState = 'needs-authorization'
  let speaking = false
  let timer: unknown

  function clearSessionTimer() {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  function transition(next: WakeSessionState) {
    if (state === next) return
    const previous = state
    state = next
    effects.onState?.(next, previous)
  }

  function armTimer(fn: () => void, ms: number) {
    clearSessionTimer()
    timer = setTimer(() => {
      timer = undefined
      fn()
    }, ms)
  }

  function speak(text: string) {
    if (!effects.speak) return
    speaking = true
    effects.speak(text)
  }

  function submit(command: string, recognitionSource?: VoiceRecognitionSource) {
    const text = normalizeTranscript(command)
    if (!text) return
    clearSessionTimer()
    transition('waiting-wake')
    effects.submit?.(text, {
      source: 'voice',
      ...(recognitionSource ? { recognitionSource } : {}),
    })
  }

  function askResetConfirmation() {
    clearSessionTimer()
    transition('reset-confirmation')
    speak(RESET_PROMPT)
    armTimer(() => {
      if (speaking) effects.stopSpeaking?.()
      speaking = false
      transition('waiting-wake')
      effects.resetCancelled?.('timeout')
      effects.onTimeout?.('reset-confirmation')
    }, resetConfirmMs)
  }

  function beginFollowUp() {
    clearSessionTimer()
    transition('follow-up')
    speak('我在')
    armTimer(() => {
      if (speaking) effects.stopSpeaking?.()
      speaking = false
      transition('waiting-wake')
      effects.onTimeout?.('follow-up')
    }, followUpMs)
  }

  function receiveCommand(command: string, source?: VoiceRecognitionSource) {
    if (isResetCommand(command)) {
      askResetConfirmation()
      return
    }
    submit(command, source)
  }

  return {
    snapshot(): WakeSessionSnapshot {
      return { state, speaking }
    },

    /** User gesture that authorizes recognition; onstart must follow separately. */
    authorize() {
      if (state !== 'needs-authorization') return
      transition('authorizing')
      effects.requestRecognition?.()
    },

    /** Native SpeechRecognition onstart callback. This is the authorization gate. */
    recognitionStarted() {
      if (state === 'authorizing') transition('waiting-wake')
    },

    recognitionFailed() {
      if (state === 'authorizing') transition('needs-authorization')
    },

    setSpeaking(active: boolean) {
      speaking = active
    },

    receive(input: string, options: { recognitionSource?: VoiceRecognitionSource } = {}) {
      if (options.recognitionSource === 'system-tts') return 'ignored' as const
      if (state === 'needs-authorization' || state === 'authorizing') return 'ignored' as const

      const source = options.recognitionSource
      if (state === 'reset-confirmation') {
        const wake = matchWakeWord(input)
        const text = wake.matched ? wake.command : normalizeTranscript(input)
        const decision = resetDecision(text)
        if (decision === 'confirm') {
          clearSessionTimer()
          if (speaking) effects.stopSpeaking?.()
          speaking = false
          transition('waiting-wake')
          effects.reset?.()
          return 'reset-confirmed' as const
        }
        if (decision === 'cancel') {
          clearSessionTimer()
          transition('waiting-wake')
          effects.resetCancelled?.('cancelled')
          return 'reset-cancelled' as const
        }
        return 'ignored' as const
      }

      if (state === 'follow-up') {
        const wake = matchWakeWord(input)
        const command = wake.matched ? wake.command : normalizeTranscript(input)
        if (!command) return 'ignored' as const
        if (speaking) effects.stopSpeaking?.()
        speaking = false
        receiveCommand(command, source)
        return 'accepted' as const
      }

      const wake = matchWakeWord(input)
      if (!wake.matched) return 'ignored' as const
      if (speaking) effects.stopSpeaking?.()
      speaking = false
      if (!wake.command) beginFollowUp()
      else receiveCommand(wake.command, source)
      return 'accepted' as const
    },

    requestResetConfirmation: askResetConfirmation,

    cancel() {
      clearSessionTimer()
      if (speaking) effects.stopSpeaking?.()
      speaking = false
      transition('waiting-wake')
    },

    dispose() {
      clearSessionTimer()
      if (speaking) effects.stopSpeaking?.()
      speaking = false
    },
  }
}

export type WakeSession = ReturnType<typeof createWakeSession>
