import { PcmRing } from './pcmRing'
import { StreamingMonoResampler } from './pcmResampler'

export const TARGET_SAMPLE_RATE = 16_000
export const DEFAULT_PRE_ROLL_SECONDS = 1.5

export type AudioCaptureState = 'idle' | 'starting' | 'running' | 'disabled' | 'error' | 'disposed'

export type AudioCaptureErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'capture-failed'
  | 'worklet-unavailable'
  | 'disposed'

export type AudioCaptureError = {
  code: AudioCaptureErrorCode
  message: string
  cause?: unknown
}

export type AudioCaptureSnapshot = {
  state: AudioCaptureState
  epoch: number
  inputSampleRate?: number
  outputSampleRate: number
  pipeline?: 'audio-worklet' | 'script-processor'
  error?: AudioCaptureError
}

export type MediaStreamTrackLike = { stop: () => void; readyState?: string }

export type MediaStreamLike = {
  getTracks: () => MediaStreamTrackLike[]
}

export type MediaDevicesLike = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>
}

export type AudioBufferLike = {
  getChannelData: (channel: number) => Float32Array
  numberOfChannels?: number
}

export type AudioProcessingEventLike = { inputBuffer: AudioBufferLike; outputBuffer?: AudioBufferLike }

export type AudioNodeLike = {
  connect: (destination: unknown) => unknown
  disconnect?: () => void
}

export type AudioWorkletPortLike = {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage?: (message: unknown, transfer?: Transferable[]) => void
}

export type AudioWorkletNodeLike = AudioNodeLike & { port: AudioWorkletPortLike }

export type AudioContextLike = {
  sampleRate: number
  destination: unknown
  state?: string
  audioWorklet?: { addModule: (url: string) => Promise<void> }
  createMediaStreamSource: (stream: MediaStreamLike) => AudioNodeLike
  createGain?: () => AudioNodeLike & { gain: { value: number } }
  createScriptProcessor?: (bufferSize?: number, inputChannels?: number, outputChannels?: number) => AudioNodeLike & {
    onaudioprocess: ((event: AudioProcessingEventLike) => void) | null
  }
  resume?: () => Promise<void>
  close?: () => Promise<void>
}

export type AudioWorkletNodeFactory = (
  context: AudioContextLike,
  name: string,
  options?: Record<string, unknown>,
) => AudioWorkletNodeLike

export type AudioCaptureListener = (pcm: Float32Array, epoch: number) => void

export type AudioCaptureOptions = {
  /** Dependency seam; defaults to navigator.mediaDevices in a browser. */
  mediaDevices?: MediaDevicesLike | null
  /** Dependency seam; defaults to the browser AudioContext constructor. */
  createAudioContext?: () => AudioContextLike
  /** Dependency seam; defaults to window.AudioWorkletNode when available. */
  createAudioWorkletNode?: AudioWorkletNodeFactory
  /** Optional externally hosted module. The default is an owned Blob module. */
  workletModuleUrl?: string
  workletNodeName?: string
  preferAudioWorklet?: boolean
  /**
   * Explicit experimental compatibility path. Production capture defaults to
   * AudioWorklet-only because ScriptProcessor runs audio on the main thread.
   */
  allowScriptProcessorFallback?: boolean
  preRollSeconds?: number
  onStateChange?: (snapshot: AudioCaptureSnapshot) => void
}

export type AudioCapture = ReturnType<typeof createAudioCapture>

const DEFAULT_WORKLET_NAME = 'canvasflow-voice-capture'

function captureWorkletSource(name: string): string {
  return `
class CanvasFlowVoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0]
    if (channels && channels[0]) {
      const copy = channels[0].slice()
      this.port.postMessage(copy, [copy.buffer])
    }
    return true
  }
}
registerProcessor(${JSON.stringify(name)}, CanvasFlowVoiceCaptureProcessor)
`
}

function browserMediaDevices(): MediaDevicesLike | null {
  if (typeof navigator === 'undefined') return null
  return (navigator.mediaDevices as unknown as MediaDevicesLike | undefined) ?? null
}

function browserAudioContext(): AudioContextLike {
  if (typeof window === 'undefined') throw new Error('AudioContext is unavailable outside a browser')
  const scope = window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext
  if (!Constructor) throw new Error('AudioContext is unavailable in this browser')
  return new Constructor()
}

function browserWorkletNode(context: AudioContextLike, name: string, options?: Record<string, unknown>): AudioWorkletNodeLike {
  if (typeof window === 'undefined') throw new Error('AudioWorkletNode is unavailable outside a browser')
  const Constructor = (window as unknown as { AudioWorkletNode?: new (context: AudioContextLike, name: string, options?: Record<string, unknown>) => AudioWorkletNodeLike }).AudioWorkletNode
  if (!Constructor) throw new Error('AudioWorkletNode is unavailable in this browser')
  return new Constructor(context, name, options)
}

function ownedWorkletUrl(name: string): { url: string; revoke: () => void } | null {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  const url = URL.createObjectURL(new Blob([captureWorkletSource(name)], { type: 'text/javascript' }))
  let revoked = false
  return {
    url,
    revoke: () => {
      if (revoked) return
      revoked = true
      try { URL.revokeObjectURL(url) } catch { /* best-effort browser cleanup */ }
    },
  }
}

function audioError(code: AudioCaptureErrorCode, cause?: unknown): AudioCaptureError {
  const message = code === 'permission-denied'
    ? '麦克风权限未开启，请在浏览器设置中允许后重试。'
    : code === 'unsupported'
      ? '当前浏览器不支持麦克风采集。'
      : code === 'worklet-unavailable'
        ? '本地语音采集模块不可用，请启用 AudioWorklet 或明确使用兼容回退。'
        : code === 'disposed'
          ? '语音采集已释放。'
          : '麦克风采集失败，请重试。'
  return { code, message, cause }
}

function isPermissionError(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name)
    : ''
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError'
}

function toMono(data: unknown): Float32Array | null {
  if (data instanceof Float32Array) return data.slice()
  if (data instanceof ArrayBuffer) return new Float32Array(data.slice(0))
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView
    return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  }
  if (typeof data === 'object' && data !== null) {
    const samples = (data as { samples?: unknown; pcm?: unknown }).samples ?? (data as { pcm?: unknown }).pcm
    return toMono(samples)
  }
  return null
}

/**
 * Owns the browser microphone and converts every input packet to 16 kHz mono.
 * One instance has one in-flight enable operation; stale async completions are
 * rejected by the epoch guard and their tracks are immediately stopped.
 */
export function createAudioCapture(options: AudioCaptureOptions = {}) {
  const mediaDevices = options.mediaDevices === undefined ? browserMediaDevices() : options.mediaDevices
  const createContext = options.createAudioContext ?? browserAudioContext
  const createWorklet = options.createAudioWorkletNode ?? browserWorkletNode
  const preferWorklet = options.preferAudioWorklet ?? true
  const allowFallback = options.allowScriptProcessorFallback ?? false
  const workletName = options.workletNodeName ?? DEFAULT_WORKLET_NAME
  const ring = new PcmRing(TARGET_SAMPLE_RATE, options.preRollSeconds ?? DEFAULT_PRE_ROLL_SECONDS)
  const listeners = new Set<AudioCaptureListener>()

  let snapshot: AudioCaptureSnapshot = { state: 'idle', epoch: 0, outputSampleRate: TARGET_SAMPLE_RATE }
  let startPromise: Promise<AudioCaptureSnapshot> | null = null
  let startToken = 0
  let disposed = false

  type ProcessorNode =
    | (AudioNodeLike & { onaudioprocess: ((event: AudioProcessingEventLike) => void) | null })
    | AudioWorkletNodeLike
  type CaptureResources = {
    epoch: number
    stream: MediaStreamLike | null
    context: AudioContextLike | null
    source: AudioNodeLike | null
    sink: AudioNodeLike | null
    processor: ProcessorNode | null
    resampler: StreamingMonoResampler | null
    revokeWorkletUrl: (() => void) | null
    released: boolean
  }

  const resourceOwners = new Set<CaptureResources>()
  let activeResources: CaptureResources | null = null

  const publish = (next: AudioCaptureSnapshot) => {
    snapshot = next
    options.onStateChange?.(next)
  }

  const releaseResources = async (resources: CaptureResources) => {
    if (resources.released) return
    resources.released = true
    resourceOwners.delete(resources)
    if (activeResources === resources) activeResources = null

    const revokeWorkletUrl = resources.revokeWorkletUrl
    resources.revokeWorkletUrl = null
    revokeWorkletUrl?.()

    const node = resources.processor
    resources.processor = null
    if (node) {
      if ('onaudioprocess' in node) node.onaudioprocess = null
      if ('port' in node) node.port.onmessage = null
      try { node.disconnect?.() } catch { /* already disconnected */ }
    }
    try { resources.source?.disconnect?.() } catch { /* already disconnected */ }
    resources.source = null
    try { resources.sink?.disconnect?.() } catch { /* already disconnected */ }
    resources.sink = null
    for (const track of resources.stream?.getTracks() ?? []) {
      try { track.stop() } catch { /* already stopped */ }
    }
    resources.stream = null
    const oldContext = resources.context
    resources.context = null
    resources.resampler = null
    if (oldContext?.close) {
      try { await oldContext.close() } catch { /* context may already be closed */ }
    }
  }

  const releaseAllResources = async () => {
    const resources = [...resourceOwners]
    activeResources = null
    await Promise.all(resources.map(releaseResources))
  }

  const emitPcm = (input: Float32Array, resources: CaptureResources) => {
    if (
      disposed
      || resources.released
      || activeResources !== resources
      || snapshot.state !== 'running'
      || snapshot.epoch !== resources.epoch
    ) return
    const converter = resources.resampler
    if (!converter) return
    const pcm = converter.push(input)
    if (pcm.length === 0) return
    ring.append(pcm)
    for (const listener of listeners) {
      try { listener(pcm.slice(), resources.epoch) } catch { /* isolate capture consumers */ }
    }
  }

  async function setupPipeline(resources: CaptureResources): Promise<AudioCaptureSnapshot> {
    const { epoch } = resources
    const nextContext = createContext()
    resources.context = nextContext
    if (!Number.isFinite(nextContext.sampleRate) || nextContext.sampleRate <= 0) {
      throw audioError('capture-failed', new Error('AudioContext did not expose a valid sampleRate'))
    }
    if (disposed || resources.released || snapshot.epoch !== epoch || snapshot.state !== 'starting') {
      await releaseResources(resources)
      return snapshot
    }

    const nextStream = resources.stream
    if (!nextStream) return snapshot
    resources.source = nextContext.createMediaStreamSource(nextStream)
    resources.resampler = new StreamingMonoResampler(nextContext.sampleRate, TARGET_SAMPLE_RATE)
    let pipeline: 'audio-worklet' | 'script-processor' | undefined
    let node: ProcessorNode | null = null

    if (preferWorklet && nextContext.audioWorklet?.addModule) {
      const ownedModule = options.workletModuleUrl ? null : ownedWorkletUrl(workletName)
      resources.revokeWorkletUrl = ownedModule?.revoke ?? null
      const workletUrl = options.workletModuleUrl ?? ownedModule?.url
      if (!workletUrl) {
        if (!allowFallback) throw audioError('worklet-unavailable')
      }
      try {
        if (!workletUrl) throw new Error('AudioWorklet module URL is unavailable')
        await nextContext.audioWorklet.addModule(workletUrl)
        if (disposed || resources.released || snapshot.epoch !== epoch || snapshot.state !== 'starting') {
          await releaseResources(resources)
          return snapshot
        }
        node = createWorklet(nextContext, workletName, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
        resources.processor = node
        node.port.onmessage = (event) => {
          const samples = toMono(event.data)
          if (samples) emitPcm(samples, resources)
        }
        pipeline = 'audio-worklet'
      } catch (error) {
        node = null
        if (!allowFallback) throw audioError('worklet-unavailable', error)
      } finally {
        ownedModule?.revoke()
        resources.revokeWorkletUrl = null
      }
    } else if (!allowFallback) {
      throw audioError('worklet-unavailable')
    }

    if (!node) {
      const createProcessor = nextContext.createScriptProcessor
      if (!allowFallback || !createProcessor) throw audioError('worklet-unavailable')
      const fallback = createProcessor.call(nextContext, 4096, 1, 1)
      fallback.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0)
        emitPcm(samples, resources)
        for (let channel = 0; channel < (event.outputBuffer?.numberOfChannels ?? 0); channel += 1) {
          event.outputBuffer?.getChannelData(channel).fill(0)
        }
      }
      node = fallback
      resources.processor = node
      pipeline = 'script-processor'
    }

    resources.source.connect(node)
    const createGain = nextContext.createGain
    if (!createGain) throw audioError('worklet-unavailable', new Error('Audio capture requires a zero-gain sink'))
    resources.sink = createGain.call(nextContext)
    if ('gain' in resources.sink && resources.sink.gain && typeof resources.sink.gain === 'object' && 'value' in resources.sink.gain) {
      resources.sink.gain.value = 0
    }
    node.connect(resources.sink)
    resources.sink.connect(nextContext.destination)
    try {
      await nextContext.resume?.()
    } catch (cause) {
      throw audioError('capture-failed', cause)
    }
    if (disposed || resources.released || snapshot.epoch !== epoch || snapshot.state !== 'starting') {
      await releaseResources(resources)
      return snapshot
    }
    activeResources = resources
    publish({ state: 'running', epoch, inputSampleRate: nextContext.sampleRate, outputSampleRate: TARGET_SAMPLE_RATE, pipeline })
    return snapshot
  }

  async function enable(): Promise<AudioCaptureSnapshot> {
    if (disposed) {
      const error = audioError('disposed')
      publish({ ...snapshot, state: 'error', error })
      return snapshot
    }
    if (snapshot.state === 'running') return snapshot
    if (startPromise) return startPromise
    if (!mediaDevices?.getUserMedia) {
      const error = audioError('unsupported')
      publish({ ...snapshot, state: 'disabled', error })
      return snapshot
    }

    const epoch = snapshot.epoch + 1
    const token = ++startToken
    ring.clear()
    publish({ state: 'starting', epoch, outputSampleRate: TARGET_SAMPLE_RATE })
    startPromise = (async () => {
      let resources: CaptureResources | null = null
      try {
        const nextStream = await mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        })
        resources = {
          epoch,
          stream: nextStream,
          context: null,
          source: null,
          sink: null,
          processor: null,
          resampler: null,
          revokeWorkletUrl: null,
          released: false,
        }
        resourceOwners.add(resources)
        if (disposed || snapshot.epoch !== epoch || snapshot.state !== 'starting') {
          await releaseResources(resources)
          return snapshot
        }
        return await setupPipeline(resources)
      } catch (cause) {
        if (resources) await releaseResources(resources)
        if (disposed || snapshot.epoch !== epoch || snapshot.state !== 'starting') return snapshot
        const error = cause && typeof cause === 'object' && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string'
          && ['unsupported', 'permission-denied', 'capture-failed', 'worklet-unavailable', 'disposed'].includes((cause as { code: string }).code)
          ? cause as AudioCaptureError
          : audioError(isPermissionError(cause) ? 'permission-denied' : 'capture-failed', cause)
        publish({ state: error.code === 'unsupported' || error.code === 'worklet-unavailable' ? 'disabled' : 'error', epoch, outputSampleRate: TARGET_SAMPLE_RATE, error })
        return snapshot
      } finally {
        if (startToken === token) startPromise = null
      }
    })()
    return startPromise
  }

  async function disable(): Promise<void> {
    if (disposed) return
    // Do not let a late permission result occupy the single-start slot for a
    // new enable call. Its own epoch check will stop any stream it returns.
    startToken += 1
    startPromise = null
    // Incrementing the epoch invalidates getUserMedia and worklet callbacks
    // which resolve after the caller has already disabled the capture.
    const nextEpoch = snapshot.epoch + 1
    publish({ state: 'idle', epoch: nextEpoch, outputSampleRate: TARGET_SAMPLE_RATE })
    ring.clear()
    await releaseAllResources()
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    startToken += 1
    startPromise = null
    const nextEpoch = snapshot.epoch + 1
    publish({ state: 'disposed', epoch: nextEpoch, outputSampleRate: TARGET_SAMPLE_RATE })
    listeners.clear()
    ring.clear()
    await releaseAllResources()
  }

  return {
    enable,
    disable,
    dispose,
    snapshot: () => snapshot,
    preRoll: (sampleCount?: number) => ring.readLatest(sampleCount),
    subscribe(listener: AudioCaptureListener): () => void {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
