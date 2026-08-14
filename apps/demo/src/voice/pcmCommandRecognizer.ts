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
  streamingEndpoint?: string
  fetch?: typeof fetch
  webSocket?: typeof WebSocket
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
  const streamingEndpoint = options.streamingEndpoint ?? '/v1/voice/stream'
  const request = options.fetch ?? globalThis.fetch.bind(globalThis)
  const WebSocketImpl = options.webSocket ?? globalThis.WebSocket
  const sampleRate = options.sampleRate ?? 16_000
  const preRollMs = options.preRollMs ?? 200

  return {
    start(listener: CommandRecognizerListener, config: CommandRecognitionOptions): CommandRecognitionSession {
      const controller = new AbortController()
      let stopped = false
      let ended = false
      let finalReceived = false
      let fallbackStarted = false
      let streamFailed = false
      const chunks: Float32Array[] = []
      const pendingPackets: ArrayBuffer[] = []
      let initialPreRoll: Float32Array | undefined
      // A wake match occurs near the end of the keyword. Replaying pre-roll on
      // that path feeds "小南" into command ASR; future PCM still captures the
      // command that follows. Follow-up/barge-in do need pre-roll for first-word
      // recovery because they have no keyword to exclude.
      if (config.speechAlreadyStarted && config.source !== 'wake') {
        const preRoll = options.capture.preRoll(Math.round(sampleRate * preRollMs / 1000))
        if (preRoll.length > 0) {
          initialPreRoll = preRoll
          chunks.push(preRoll)
        }
      }
      const streamUrl = new URL(streamingEndpoint, globalThis.location?.href ?? 'http://localhost')
      streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocketImpl(streamUrl)
      socket.binaryType = 'arraybuffer'

      const sendPacket = (samples: Float32Array) => {
        const packet = pcm16le(samples).buffer
        if (socket.readyState === WebSocketImpl.OPEN) socket.send(packet)
        else pendingPackets.push(packet)
      }
      if (initialPreRoll) sendPacket(initialPreRoll)

      const unsubscribe = options.capture.subscribe((samples) => {
        if (stopped || ended || samples.length === 0) return
        chunks.push(samples.slice())
        sendPacket(samples)
      })

      socket.addEventListener('open', () => {
        if (stopped) return socket.close()
        socket.send(JSON.stringify({ type: 'start', generation: config.generation }))
        for (const packet of pendingPackets.splice(0)) socket.send(packet)
        if (ended) socket.send(JSON.stringify({ type: 'stop' }))
      })

      socket.addEventListener('message', (event) => {
        if (stopped || finalReceived || typeof event.data !== 'string') return
        try {
          const body = JSON.parse(event.data) as { type?: unknown; text?: unknown; generation?: unknown }
          if (body.generation !== config.generation) return
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (body.type === 'partial' && text) listener.onPartial(text)
          if (body.type === 'final') {
            finalReceived = true
            if (text) listener.onFinal(text)
            else listener.onFinal('')
          }
          if (body.type === 'error') {
            streamFailed = true
            if (ended) void fallback()
          }
        } catch {
          streamFailed = true
          if (ended) void fallback()
        }
      })

      socket.addEventListener('error', () => {
        streamFailed = true
        if (ended) void fallback()
      })
      socket.addEventListener('close', () => {
        streamFailed = true
        if (ended && !stopped && !finalReceived) void fallback()
      })

      const fallback = async () => {
        if (stopped || finalReceived || fallbackStarted) return
        fallbackStarted = true
        const samples = chunks.length === 1
          ? chunks[0]!
          : (() => {
              const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
              const merged = new Float32Array(length)
              let offset = 0
              for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
              return merged
            })()
        try {
          const response = await request(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'audio/pcm;format=s16le;rate=16000;channels=1',
            'x-voice-generation': String(config.generation),
          },
          body: pcm16le(samples).buffer,
          })
          if (!response.ok) throw new Error(`PCM ASR request failed (${response.status})`)
          const body = await response.json() as TranscriptionResponse
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          const confidence = typeof body.confidence === 'number' ? body.confidence : undefined
          finalReceived = true
          if (text) listener.onFinal(text, confidence)
          else listener.onFinal('')
        } catch (error) {
          if (!stopped && !controller.signal.aborted) listener.onError(error)
        }
      }

      const finish = () => {
        if (stopped || ended) return
        ended = true
        unsubscribe()
        if (streamFailed) void fallback()
        else if (socket.readyState === WebSocketImpl.OPEN) socket.send(JSON.stringify({ type: 'stop' }))
      }

      return {
        stop() {
          if (stopped) return
          stopped = true
          unsubscribe()
          controller.abort()
          socket.close()
        },
        endUtterance: finish,
      }
    },
  }
}

export { pcm16le }
