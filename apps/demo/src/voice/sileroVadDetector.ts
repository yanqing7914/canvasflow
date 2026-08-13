import type { InferenceSession, Tensor as OrtTensor } from 'onnxruntime-common'
import * as ort from 'onnxruntime-web/wasm'
import type { DetectorSession, VadDetector, VadDetectorListener } from '@canvasflow/voice'
import type { AudioCapture } from './audioCapture'

const DEFAULT_MODEL_URL = '/voice/models/silero_vad.onnx'
const FRAME_SIZE = 512
const SAMPLE_RATE = 16_000

export type SileroVadConfig = {
  threshold?: number
  negativeThreshold?: number
  speechPadMs?: number
  silenceTailMs?: number
}

export type SileroVadDetectorOptions = {
  capture: Pick<AudioCapture, 'subscribe'>
  modelUrl?: string
  config?: SileroVadConfig
  createSession?: (modelUrl: string) => Promise<InferenceSession>
}

export type SileroVadDetector = VadDetector & {
  load: () => Promise<void>
  dispose: () => Promise<void>
}

type EndpointEvent = 'start' | 'end' | undefined

class SileroEndpoint {
  private readonly threshold: number
  private readonly negativeThreshold: number
  private readonly speechStartFrames: number
  private readonly silenceFrames: number
  private positiveFrames = 0
  private negativeFrames = 0
  private active = false

  constructor(config: SileroVadConfig = {}) {
    this.threshold = config.threshold ?? 0.5
    this.negativeThreshold = config.negativeThreshold ?? 0.35
    const frameMs = FRAME_SIZE / SAMPLE_RATE * 1000
    this.speechStartFrames = Math.max(1, Math.ceil((config.speechPadMs ?? 64) / frameMs))
    this.silenceFrames = Math.max(1, Math.ceil((config.silenceTailMs ?? 800) / frameMs))
  }

  accept(probability: number): EndpointEvent {
    if (probability >= this.threshold) {
      this.negativeFrames = 0
      if (this.active) return undefined
      this.positiveFrames += 1
      if (this.positiveFrames < this.speechStartFrames) return undefined
      this.positiveFrames = 0
      this.active = true
      return 'start'
    }
    if (probability < this.negativeThreshold) {
      this.positiveFrames = 0
      if (!this.active) return undefined
      this.negativeFrames += 1
      if (this.negativeFrames < this.silenceFrames) return undefined
      this.negativeFrames = 0
      this.active = false
      return 'end'
    }
    return undefined
  }

  reset() {
    this.positiveFrames = 0
    this.negativeFrames = 0
    this.active = false
  }
}

function zeroState(): OrtTensor {
  return new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64])
}

function defaultCreateSession(modelUrl: string): Promise<InferenceSession> {
  ort.env.wasm.numThreads = 1
  return ort.InferenceSession.create(modelUrl)
}

/** Local Silero VAD over the shared 16 kHz AudioCapture stream. */
export function createSileroVadDetector(options: SileroVadDetectorOptions): SileroVadDetector {
  const endpoint = new SileroEndpoint(options.config)
  const createSession = options.createSession ?? defaultCreateSession
  const modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL

  let disposed = false
  let session: InferenceSession | null = null
  let sessionPromise: Promise<InferenceSession> | null = null
  let h = zeroState()
  let c = zeroState()
  let pending = new Float32Array()
  let generation = 0

  async function load() {
    if (disposed) throw new Error('VAD detector is disposed')
    if (session) return
    const pendingSession = sessionPromise ?? createSession(modelUrl)
    sessionPromise = pendingSession
    try {
      const loaded = await pendingSession
      if (disposed) {
        await loaded.release()
        throw new Error('VAD detector is disposed')
      }
      if (sessionPromise !== pendingSession) {
        await loaded.release()
        return
      }
      session = loaded
    } catch (error) {
      if (sessionPromise === pendingSession) sessionPromise = null
      throw error
    }
  }

  function start(listener: VadDetectorListener): DetectorSession {
    if (disposed) throw new Error('VAD detector is disposed')
    const activeGeneration = ++generation
    let stopped = false
    let chain = Promise.resolve()
    endpoint.reset()
    h = zeroState()
    c = zeroState()
    pending = new Float32Array()

    const fail = (error: unknown) => {
      if (stopped || activeGeneration !== generation) return
      stopped = true
      listener.onError(error)
    }

    void load().catch(fail)

    const unsubscribe = options.capture.subscribe((samples) => {
      if (stopped || activeGeneration !== generation || samples.length === 0) return
      const data = new Float32Array(pending.length + samples.length)
      data.set(pending)
      data.set(samples, pending.length)
      let offset = 0
      while (offset + FRAME_SIZE <= data.length) {
        const frame = data.slice(offset, offset + FRAME_SIZE)
        offset += FRAME_SIZE
        chain = chain.then(async () => {
          if (stopped || activeGeneration !== generation) return
          await load()
          if (!session || stopped || activeGeneration !== generation) return
          const output = await session.run({
            x: new ort.Tensor('float32', frame, [1, FRAME_SIZE]),
            h,
            c,
          })
          h = output.new_h as OrtTensor
          c = output.new_c as OrtTensor
          const probability = Number((output.prob?.data as Float32Array | undefined)?.[0] ?? 0)
          const event = endpoint.accept(probability)
          if (event === 'start') listener.onSpeechStart()
          else if (event === 'end') listener.onSpeechEnd()
        }).catch(fail)
      }
      pending = data.slice(offset)
    })

    return {
      stop() {
        if (stopped) return
        stopped = true
        generation += 1
        unsubscribe()
        endpoint.reset()
        pending = new Float32Array()
      },
    }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    generation += 1
    endpoint.reset()
    pending = new Float32Array()
    const activeSession = session
    session = null
    // A pending load observes `disposed` and releases its own session. Keeping
    // the promise identity until it settles avoids double-releasing one owner.
    if (activeSession) await activeSession.release()
  }

  return { start, load, dispose }
}

export { SileroEndpoint }
