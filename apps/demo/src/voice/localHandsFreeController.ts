import {
  createHandsFreeMachine,
  type HandsFreeSnapshot,
  type SpeechRecognitionLike,
  type VoiceSubmitMeta,
  type VoiceMetricName,
} from '@canvasflow/voice'
import { createAudioCapture } from './audioCapture'
import { createLocalWakeRuntime } from './localWakeRuntime'
import { createSherpaKwsDetector } from './sherpaKwsDetector'
import { createSileroVadDetector } from './sileroVadDetector'
import { createPcmCommandRecognizer } from './pcmCommandRecognizer'
import { createAdaptiveCommandRecognizer } from './adaptiveCommandRecognizer'
import { createWebSpeechCommandRecognizer } from './webSpeechCommandRecognizer'

export type LocalHandsFreeControllerOptions = {
  createRecognition?: () => SpeechRecognitionLike | null
  createCapture?: typeof createAudioCapture
  createWakeDetector?: typeof createSherpaKwsDetector
  createVadDetector?: typeof createSileroVadDetector
  createCommandRecognizer?: typeof createWebSpeechCommandRecognizer
  createPcmRecognizer?: typeof createPcmCommandRecognizer
  createAdaptiveRecognizer?: typeof createAdaptiveCommandRecognizer
  pcmAsrEndpoint?: string
  onSnapshot?: (snapshot: HandsFreeSnapshot) => void
  onWake?: () => void
  onError?: (message: string) => void
  /** Return true only when a safety confirmation must keep listening. */
  onSubmit: (text: string, meta: VoiceSubmitMeta) => boolean | Promise<boolean>
  stopSpeaking?: () => void
  onMetric?: (name: VoiceMetricName, value?: number) => void
}

export type LocalHandsFreeController = ReturnType<typeof createLocalHandsFreeController>

const sourceToRecognitionSource = () => 'microphone' as const

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error ? errorMessage(error.cause) : ''
    return cause && cause !== 'undefined' ? `${error.message}（${cause}）` : error.message
  }
  if (typeof error === 'object' && error) {
    const message = 'message' in error ? String(error.message) : ''
    const cause = 'cause' in error ? errorMessage(error.cause) : ''
    if (message && cause && cause !== 'undefined') return `${message}（${cause}）`
    if (message) return message
    if (cause && cause !== 'undefined') return cause
  }
  return String(error)
}

/**
 * Product integration boundary for the local wake rebuild. It owns exactly one
 * AudioCapture and wires local KWS + Silero VAD into the pure hands-free FSM.
 */
export function createLocalHandsFreeController(options: LocalHandsFreeControllerOptions) {
  const capture = (options.createCapture ?? createAudioCapture)()
  const detector = (options.createWakeDetector ?? createSherpaKwsDetector)()
  let runtime: ReturnType<typeof createLocalWakeRuntime> | null = null
  const wakeDetector = {
    async start(listener: { onWake: () => void; onError: (error: unknown) => void }) {
      let stopped = false
      const activeRuntime = createLocalWakeRuntime({
        capture,
        detector,
        releaseCaptureOnStop: false,
        onEvent: (event) => {
          if (event.type === 'wake') listener.onWake()
          else if (event.type === 'error') listener.onError(event.error)
        },
      })
      runtime = activeRuntime
      const snapshot = await activeRuntime.start()
      if (stopped) {
        await activeRuntime.stop()
        return { stop: () => undefined }
      }
      if (snapshot.state !== 'armed') {
        if (runtime === activeRuntime) runtime = null
        await activeRuntime.stop()
        const failure = snapshot.error
        if (failure) throw new Error(failure.message, { cause: failure.cause })
        throw new Error('本地唤醒未能进入待命状态')
      }
      return {
        stop: () => {
          stopped = true
          if (runtime === activeRuntime) runtime = null
          void activeRuntime.stop()
        },
      }
    },
  }

  const vadDetector = (options.createVadDetector ?? createSileroVadDetector)({ capture })
  const commandRecognizer = options.createCommandRecognizer
    ? options.createCommandRecognizer({
        ...(options.createRecognition ? { createRecognition: options.createRecognition } : {}),
      })
    : options.createPcmRecognizer
      ? options.createPcmRecognizer({ capture, ...(options.pcmAsrEndpoint ? { endpoint: options.pcmAsrEndpoint } : {}) })
    : (options.createAdaptiveRecognizer ?? createAdaptiveCommandRecognizer)({
        pcm: {
          capture,
          ...(options.pcmAsrEndpoint ? { endpoint: options.pcmAsrEndpoint } : {}),
        },
        webSpeech: {
          ...(options.createRecognition ? { createRecognition: options.createRecognition } : {}),
        },
      })

  const machine = createHandsFreeMachine({
    wakeDetector,
    vadDetector,
    commandRecognizer,
    config: { continuousFollowUp: true },
    effects: {
      onState: () => options.onSnapshot?.(machine.snapshot()),
      onWake: options.onWake,
      onFalseWake: () => options.onMetric?.('false-wake'),
      submitCommand: (command) => {
        options.onMetric?.('asr-submit')
        void Promise.resolve(options.onSubmit(command.text, {
          source: 'voice',
          recognitionSource: sourceToRecognitionSource(),
          ...(command.confidence === undefined ? {} : { confidence: command.confidence }),
        })).then(
          (keepListening) => machine.turnEnded(command.generation, keepListening),
          (error) => {
            options.onMetric?.('asr-error')
            machine.turnEnded(command.generation, false)
            options.onError?.(errorMessage(error))
          },
        )
      },
      stopSpeaking: () => {
        options.onMetric?.('barge-in')
        options.stopSpeaking?.()
      },
      onError: (_stage, error) => {
        options.onError?.(errorMessage(error))
      },
    },
  })

  return {
    async enable() {
      const enabled = await machine.enable()
      options.onSnapshot?.(machine.snapshot())
      return enabled
    },
    async disable() {
      machine.disable()
      await capture.disable()
      options.onSnapshot?.(machine.snapshot())
    },
    snapshot: () => machine.snapshot(),
    turnEnded: (generation: number) => machine.turnEnded(generation),
    ttsStarted: (generation: number) => machine.ttsStarted(generation),
    ttsEnded: (generation: number) => machine.ttsEnded(generation),
    dispose() {
      machine.dispose()
      const activeRuntime = runtime
      runtime = null
      if (activeRuntime) void activeRuntime.dispose()
      else void detector.dispose?.()
      void vadDetector.dispose()
      void capture.dispose()
    },
  }
}
