import type {
  CommandRecognitionSession,
  CommandRecognizer,
  CommandRecognizerListener,
  SpeechRecognitionLike,
} from '@canvasflow/voice'
import {
  createBrowserRecognition,
  isRecognitionSupported,
  isSecureContextOk,
} from '@canvasflow/voice'

export type WebSpeechCommandRecognizerOptions = {
  createRecognition?: () => SpeechRecognitionLike | null
  language?: string
  supported?: () => boolean
  secureContext?: () => boolean
}

/**
 * Transitional command ASR. It starts only after local KWS wake, so Web Speech
 * no longer owns the always-on wake path. The product path will replace this
 * adapter with shared-PCM streaming ASR.
 */
export function createWebSpeechCommandRecognizer(
  options: WebSpeechCommandRecognizerOptions = {},
): CommandRecognizer {
  const createRecognition = options.createRecognition ?? createBrowserRecognition
  const supported = options.supported ?? isRecognitionSupported
  const secure = options.secureContext ?? isSecureContextOk
  const language = options.language ?? 'zh-CN'

  return {
    start(listener: CommandRecognizerListener): CommandRecognitionSession {
      if (!supported() || !secure()) throw new Error('Web Speech command recognition is unavailable')
      const engine = createRecognition()
      if (!engine) throw new Error('Web Speech command recognition is unavailable')
      let stopped = false
      let finalText = ''

      const detach = () => {
        engine.onresult = null
        engine.onerror = null
        engine.onend = null
        if ('onstart' in engine) engine.onstart = null
      }
      const stopEngine = (abort: boolean) => {
        if (stopped) return
        stopped = true
        detach()
        try {
          if (abort && engine.abort) engine.abort()
          else engine.stop()
        } catch { /* already stopped */ }
      }

      engine.lang = language
      engine.continuous = true
      engine.interimResults = true
      engine.maxAlternatives = 1
      engine.onresult = (event) => {
        if (stopped) return
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]
          const alternative = result?.[0]
          if (!alternative?.transcript) continue
          if (result.isFinal) {
            finalText = `${finalText} ${alternative.transcript}`.trim()
            listener.onFinal(finalText, alternative.confidence)
          } else {
            listener.onPartial(alternative.transcript)
          }
        }
      }
      engine.onerror = (event) => {
        if (stopped) return
        listener.onError(new Error(`Web Speech error: ${event.error ?? 'recognition'}`))
      }
      engine.onend = () => {
        if (stopped) return
        if (!finalText.trim()) listener.onFinal('')
      }

      try {
        engine.start()
      } catch (error) {
        stopEngine(true)
        throw error
      }

      return {
        stop: () => stopEngine(true),
        endUtterance: () => {
          if (stopped) return
          try { engine.stop() } catch (error) { listener.onError(error) }
        },
      }
    },
  }
}
