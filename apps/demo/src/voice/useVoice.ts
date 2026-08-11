import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createSpeechController,
  createVoiceMachine,
  isRecognitionSupported,
  isSecureContextOk,
  voiceError,
  type SpeechControllerDeps,
  type VoiceMachineSnapshot,
} from '@canvasflow/voice'

export type VoiceSubmitMeta = { source: 'voice'; confidence?: number }

/** Optional copy to speak back once the transcript has been handled. */
type TranscriptReply = string | undefined | void

export type UseVoiceOptions = {
  /** Explicitly disables the voice entry point regardless of browser support. */
  enabled?: boolean
  /**
   * The seam. Receives a confirmed transcript and returns optional copy to
   * speak back, synchronously or as a promise. A throw or rejection ends the
   * turn quietly — the caller owns its own error reporting.
   */
  onTranscript?: (text: string, meta: VoiceSubmitMeta) => TranscriptReply | Promise<TranscriptReply>
  /** Test hook: swaps in fake Web Speech engines. */
  speech?: SpeechControllerDeps
}

const INITIAL_SNAPSHOT: VoiceMachineSnapshot = {
  state: 'idle',
  transcript: '',
  interim: '',
  display: '',
}

/**
 * Binds the pure voice machine to the browser's speech peripherals and exposes
 * the slice of state the header UI renders. All task meaning lives behind
 * `onTranscript`; this hook only moves text.
 */
export function useVoice(options: UseVoiceOptions = {}) {
  const { enabled = true, onTranscript, speech } = options
  const [snapshot, setSnapshot] = useState<VoiceMachineSnapshot>(INITIAL_SNAPSHOT)

  // Keep the seam and the engine factories in refs so a new object identity on
  // either one never tears down a live listening turn.
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript
  const speechRef = useRef(speech)
  speechRef.current = speech

  const injected = Boolean(speech?.createRecognition)
  const supported = useMemo(() => injected || isRecognitionSupported(), [injected])
  const secure = useMemo(() => injected || isSecureContextOk(), [injected])
  const available = enabled && supported && secure

  const loopRef = useRef<{
    machine: ReturnType<typeof createVoiceMachine>
    controller: ReturnType<typeof createSpeechController>
  } | null>(null)

  useEffect(() => {
    if (!available) {
      loopRef.current = null
      setSnapshot(INITIAL_SNAPSHOT)
      return undefined
    }

    // The machine and the controller reference each other, so the machine is
    // reached through a holder that is filled once both exist. Every read happens
    // inside a callback, never during construction.
    const holder: { machine?: ReturnType<typeof createVoiceMachine> } = {}
    const on = <A extends unknown[]>(
      run: (machine: ReturnType<typeof createVoiceMachine>, ...args: A) => void,
    ) => (...args: A) => {
      const machine = holder.machine
      if (!machine) return
      run(machine, ...args)
      setSnapshot(machine.snapshot())
    }

    const controller = createSpeechController({
      ...speechRef.current,
      handlers: {
        onPartial: on<[string]>((machine, text) => machine.asrPartial(text)),
        onFinal: on<[string, number | undefined]>((machine, text, confidence) =>
          machine.asrFinal(text, confidence)),
        onError: on<[Parameters<ReturnType<typeof createVoiceMachine>['asrError']>[0]]>(
          (machine, kind) => machine.asrError(kind)),
        onEnd: on((machine) => machine.asrEnd()),
        onSpeakEnd: on((machine) => machine.speakEnd()),
        onSpeakError: on((machine) => machine.speakError()),
      },
    })

    const machine = createVoiceMachine({
      effects: {
        openAsr: () => {
          if (!controller.startListening()) {
            // Report asynchronously: the machine is mid-transition into listening.
            queueMicrotask(on((current) => current.asrError('recognition')))
          }
        },
        closeAsr: () => { controller.stopListening() },
        stopSpeak: () => { controller.stopSpeaking() },
        speak: (text) => {
          if (!controller.speak(text)) {
            queueMicrotask(on((current) => current.speakEnd()))
          }
        },
        submit: (text, meta) => {
          // Always resolve out of band so `submitting` is observable even when
          // the seam answers synchronously.
          const finish = on<[string | undefined]>((current, reply) => { current.submitDone(reply) })
          let result: TranscriptReply | Promise<TranscriptReply>
          try {
            result = onTranscriptRef.current?.(text, meta)
          } catch {
            queueMicrotask(() => finish(undefined))
            return
          }
          void Promise.resolve(result).then(
            (reply) => finish(typeof reply === 'string' ? reply : undefined),
            () => finish(undefined),
          )
        },
      },
    })

    holder.machine = machine
    loopRef.current = { machine, controller }
    setSnapshot(machine.snapshot())

    return () => {
      // Clearing the holder makes every queued callback a no-op after teardown.
      holder.machine = undefined
      loopRef.current = null
      machine.dispose()
      controller.dispose()
    }
  }, [available])

  const act = useCallback((run: (machine: ReturnType<typeof createVoiceMachine>) => void) => {
    const loop = loopRef.current
    if (!loop) return
    run(loop.machine)
    setSnapshot(loop.machine.snapshot())
  }, [])

  const press = useCallback(() => { act((machine) => machine.press()) }, [act])
  const cancel = useCallback(() => { act((machine) => machine.cancel()) }, [act])
  const reset = useCallback(() => { act((machine) => machine.reset()) }, [act])
  const edit = useCallback((text: string) => { act((machine) => machine.edit(text)) }, [act])
  const submit = useCallback((text?: string) => { act((machine) => machine.submit(text)) }, [act])
  /**
   * Play a line the driver did not ask for. Safe to call on every response: the
   * machine refuses anything that would talk over a turn in progress, so a
   * caller does not have to know which entry point produced the response. A
   * blank line and an unavailable voice are both no-ops.
   */
  const announce = useCallback((text?: string) => {
    if (!text) return
    act((machine) => machine.announce(text))
  }, [act])

  /**
   * The error shown when voice is unavailable. Derived rather than stored so the
   * capability copy never depends on effect ordering.
   */
  const unavailableError = useMemo(() => {
    if (!enabled) return undefined
    if (!supported) return voiceError('unsupported')
    if (!secure) return voiceError('insecure-context')
    return undefined
  }, [enabled, secure, supported])

  return {
    available,
    state: available ? snapshot.state : 'idle',
    transcript: snapshot.transcript,
    interim: snapshot.interim,
    display: snapshot.display,
    confidence: snapshot.confidence,
    speaking: snapshot.speaking,
    error: available ? snapshot.error : unavailableError,
    press,
    cancel,
    reset,
    edit,
    submit,
    announce,
  } as const
}
