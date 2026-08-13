import type {
  CommandRecognitionOptions,
  CommandRecognitionSession,
  CommandRecognizer,
  CommandRecognizerListener,
} from '@canvasflow/voice'
import type { AudioCapture } from './audioCapture'

export type PcmCommandRecognizerOptions = {
  capture: Pick<AudioCapture, 'subscribe' | 'preRoll'>
  endpoint?: string
  fetch?: typeof fetch
  sampleRate?: number
  preRollMs?: number
}

type TranscriptionResponse = { text?: unknown; confidence?: unknown }

function pcm16le(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(samples.length * 2)
  const view = new DataView(output.buffer)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }
  return output
}

/**
 * Shared-PCM command recognizer. The server contract accepts raw PCM16LE and
 * returns `{text, confidence}`; no browser speech service is involved.
 */
export function createPcmCommandRecognizer(options: PcmCommandRecognizerOptions): CommandRecognizer {
  const endpoint = options.endpoint ?? '/v1/voice/transcribe'
  const request = options.fetch ?? globalThis.fetch.bind(globalThis)
  const sampleRate = options.sampleRate ?? 16_000
  const preRollMs = options.preRollMs ?? 200

  return {
    start(listener: CommandRecognizerListener, config: CommandRecognitionOptions): CommandRecognitionSession {
      const controller = new AbortController()
      let stopped = false
      let ended = false
      const chunks: Float32Array[] = []
      // A wake match occurs near the end of the keyword. Replaying pre-roll on
      // that path feeds "小南" into command ASR; future PCM still captures the
      // command that follows. Follow-up/barge-in do need pre-roll for first-word
      // recovery because they have no keyword to exclude.
      if (config.speechAlreadyStarted && config.source !== 'wake') {
        const preRoll = options.capture.preRoll(Math.round(sampleRate * preRollMs / 1000))
        if (preRoll.length > 0) chunks.push(preRoll)
      }
      const unsubscribe = options.capture.subscribe((samples) => {
        if (stopped || ended || samples.length === 0) return
        chunks.push(samples.slice())
      })

      const finish = () => {
        if (stopped || ended) return
        ended = true
        unsubscribe()
        const samples = chunks.length === 1
          ? chunks[0]!
          : (() => {
              const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
              const merged = new Float32Array(length)
              let offset = 0
              for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
              return merged
            })()
        void request(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'audio/pcm;format=s16le;rate=16000;channels=1',
            'x-voice-generation': String(config.generation),
          },
          body: pcm16le(samples).buffer,
        }).then(async (response) => {
          if (!response.ok) throw new Error(`PCM ASR request failed (${response.status})`)
          const body = await response.json() as TranscriptionResponse
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          const confidence = typeof body.confidence === 'number' ? body.confidence : undefined
          if (text) listener.onFinal(text, confidence)
          else listener.onFinal('')
        }).catch((error) => {
          if (!stopped && !controller.signal.aborted) listener.onError(error)
        })
      }

      return {
        stop() {
          if (stopped) return
          stopped = true
          unsubscribe()
          controller.abort()
        },
        endUtterance: finish,
      }
    },
  }
}

export { pcm16le }
