import type {
  AudioCapture,
  AudioCaptureSnapshot,
  AudioCaptureListener,
} from './audioCapture'

export type WakeDetectorMatch = {
  /** The configured local keyword, not a command transcript. */
  keyword: string
  confidence?: number
}

export type WakeDetectorFrame = {
  samples: Float32Array
  sampleRate: 16_000
  epoch: number
  sequence: number
}

/**
 * Adapter boundary for a local KWS implementation (for example a WASM/Worker
 * sherpa runtime). The runtime never creates a model or performs a network
 * request; production code must inject a concrete detector explicitly.
 */
export type WakeDetector = {
  load: () => Promise<void>
  start: (onMatch: (match: WakeDetectorMatch) => void) => Promise<void> | void
  pushFrame: (frame: WakeDetectorFrame) => void
  stop: () => void
  dispose?: () => void | Promise<void>
}

export type LocalWakeCapture = Pick<AudioCapture, 'enable' | 'disable' | 'dispose' | 'snapshot' | 'preRoll' | 'subscribe'>

export type LocalWakeRuntimeState = 'idle' | 'loading' | 'starting' | 'armed' | 'error' | 'disabled' | 'disposed'

export type LocalWakeRuntimeErrorCode =
  | 'detector-unavailable'
  | 'detector-load-failed'
  | 'detector-start-failed'
  | 'capture-unavailable'
  | 'capture-failed'
  | 'disposed'

export type LocalWakeRuntimeError = {
  code: LocalWakeRuntimeErrorCode
  message: string
  cause?: unknown
}

export type LocalWakeEvent = {
  type: 'wake'
  keyword: string
  confidence?: number
  epoch: number
  sequence: number
  /** Local-only pre-roll; never uploaded by this module. */
  preRoll: Float32Array
}

export type LocalWakeRuntimeEvent =
  | { type: 'state'; state: LocalWakeRuntimeState; epoch: number; capture: AudioCaptureSnapshot }
  | LocalWakeEvent
  | { type: 'error'; error: LocalWakeRuntimeError; epoch: number }

export type LocalWakeRuntimeSnapshot = {
  state: LocalWakeRuntimeState
  epoch: number
  sequence: number
  capture: AudioCaptureSnapshot
  error?: LocalWakeRuntimeError
}

export type LocalWakeRuntimeOptions = {
  capture: LocalWakeCapture
  /** Required: absence is a visible disabled state, never a silent fallback. */
  detector?: WakeDetector | null
  onEvent?: (event: LocalWakeRuntimeEvent) => void
  /** Runtime owns the capture lease by default. */
  releaseCaptureOnStop?: boolean
  /** Bound startup buffering while the detector is loading. */
  maxBufferedFrames?: number
}

export type LocalWakeRuntime = ReturnType<typeof createLocalWakeRuntime>

function runtimeError(code: LocalWakeRuntimeErrorCode, cause?: unknown): LocalWakeRuntimeError {
  const message = code === 'detector-unavailable'
    ? '本地唤醒模型未配置，已关闭语音唤醒。'
    : code === 'detector-load-failed'
      ? '本地唤醒模型加载失败，已关闭语音唤醒。'
      : code === 'detector-start-failed'
        ? '本地唤醒引擎启动失败，已关闭语音唤醒。'
        : code === 'capture-unavailable'
          ? '麦克风不可用，已关闭语音唤醒。'
          : code === 'capture-failed'
            ? '麦克风采集失败，已关闭语音唤醒。'
            : '语音唤醒已释放。'
  return { code, message, cause }
}

function captureIsUsable(capture: AudioCaptureSnapshot): boolean {
  return capture.state === 'running' && capture.outputSampleRate === 16_000
}

/**
 * Wires one local detector to one AudioCapture owner. All callbacks carry an
 * epoch and are ignored after stop/restart, which prevents stale Worker/WASM
 * messages from waking a later turn. There is intentionally no fetch, Web
 * Speech, or remote ASR fallback in this module.
 */
export function createLocalWakeRuntime(options: LocalWakeRuntimeOptions) {
  const capture = options.capture
  const detector = options.detector ?? null
  const releaseCapture = options.releaseCaptureOnStop ?? true
  const maxBufferedFrames = Math.max(0, Math.floor(options.maxBufferedFrames ?? 64))

  let disposed = false
  let startPromise: Promise<LocalWakeRuntimeSnapshot> | null = null
  let unsubscribe: (() => void) | null = null
  let bufferedFrames: WakeDetectorFrame[] = []
  let detectorStarted = false
  let activeCaptureEpoch: number | undefined
  let sequence = 0
  let snapshot: LocalWakeRuntimeSnapshot = {
    state: 'idle',
    epoch: 0,
    sequence: 0,
    capture: capture.snapshot(),
  }

  const emit = (event: LocalWakeRuntimeEvent) => options.onEvent?.(event)
  const publish = (state: LocalWakeRuntimeState, epoch = snapshot.epoch, error?: LocalWakeRuntimeError) => {
    snapshot = { state, epoch, sequence, capture: capture.snapshot(), ...(error ? { error } : {}) }
    emit({ type: 'state', state, epoch, capture: snapshot.capture })
  }

  const frameListener: AudioCaptureListener = (samples, captureEpoch) => {
    if (disposed || snapshot.state !== 'starting' && snapshot.state !== 'armed') return
    if (samples.length === 0) return
    if (activeCaptureEpoch === undefined) activeCaptureEpoch = captureEpoch
    if (captureEpoch !== activeCaptureEpoch) return
    const frame: WakeDetectorFrame = {
      samples: samples.slice(),
      sampleRate: 16_000,
      epoch: snapshot.epoch,
      sequence: ++sequence,
    }
    snapshot = { ...snapshot, sequence }
    if (!detectorStarted) {
      if (maxBufferedFrames > 0) {
        bufferedFrames.push(frame)
        if (bufferedFrames.length > maxBufferedFrames) bufferedFrames.shift()
      }
      return
    }
    try {
      detector?.pushFrame(frame)
    } catch (cause) {
      detectorStarted = false
      bufferedFrames = []
      unsubscribe?.()
      unsubscribe = null
      try { detector?.stop() } catch { /* detector may already be stopped */ }
      if (releaseCapture) void capture.disable()
      const error = runtimeError('detector-start-failed', cause)
      publish('error', snapshot.epoch, error)
      emit({ type: 'error', error, epoch: snapshot.epoch })
    }
  }

  const handleMatch = (match: WakeDetectorMatch, epoch: number) => {
    if (disposed || snapshot.state !== 'armed' || snapshot.epoch !== epoch) return
    if (!match || typeof match.keyword !== 'string' || match.keyword.trim() === '') return
    const event: LocalWakeEvent = {
      type: 'wake',
      keyword: match.keyword,
      ...(typeof match.confidence === 'number' ? { confidence: match.confidence } : {}),
      epoch,
      sequence,
      preRoll: capture.preRoll().slice(),
    }
    emit(event)
  }

  async function start(): Promise<LocalWakeRuntimeSnapshot> {
    if (disposed) {
      const error = runtimeError('disposed')
      publish('error', snapshot.epoch, error)
      emit({ type: 'error', error, epoch: snapshot.epoch })
      return snapshot
    }
    if (!detector) {
      const error = runtimeError('detector-unavailable')
      publish('disabled', snapshot.epoch, error)
      emit({ type: 'error', error, epoch: snapshot.epoch })
      return snapshot
    }
    if (snapshot.state === 'armed') return snapshot
    if (startPromise) {
      const pendingStart = startPromise
      if (snapshot.state === 'loading' || snapshot.state === 'starting') return pendingStart
      await pendingStart
      return start()
    }

    const epoch = snapshot.epoch + 1
    bufferedFrames = []
    detectorStarted = false
    activeCaptureEpoch = undefined
    publish('loading', epoch)
    startPromise = (async () => {
      try {
        await detector.load()
        if (disposed || snapshot.epoch !== epoch || snapshot.state !== 'loading') return snapshot

        unsubscribe = capture.subscribe(frameListener)
        publish('starting', epoch)
        const captureSnapshot = await capture.enable()
        if (disposed || snapshot.epoch !== epoch) return snapshot
        if (!captureIsUsable(captureSnapshot)) {
          unsubscribe?.()
          unsubscribe = null
          activeCaptureEpoch = undefined
          if (releaseCapture) {
            try { await capture.disable() } catch { /* capture already failed closed */ }
          }
          const error = runtimeError(captureSnapshot.error?.code === 'unsupported' ? 'capture-unavailable' : 'capture-failed', captureSnapshot.error)
          publish(captureSnapshot.state === 'disabled' ? 'disabled' : 'error', epoch, error)
          emit({ type: 'error', error, epoch })
          return snapshot
        }
        activeCaptureEpoch = captureSnapshot.epoch

        await detector.start((match) => handleMatch(match, epoch))
        if (disposed || snapshot.epoch !== epoch) {
          try { detector.stop() } catch { /* detector may have started late */ }
          return snapshot
        }
        detectorStarted = true
        const queued = bufferedFrames
        bufferedFrames = []
        for (const frame of queued) detector.pushFrame(frame)
        publish('armed', epoch)
        return snapshot
      } catch (cause) {
        unsubscribe?.()
        unsubscribe = null
        activeCaptureEpoch = undefined
        try { detector.stop() } catch { /* detector may not have started */ }
        if (releaseCapture) await capture.disable()
        if (disposed) return snapshot
        const code: LocalWakeRuntimeErrorCode = snapshot.state === 'loading' ? 'detector-load-failed' : snapshot.state === 'starting' && !captureIsUsable(capture.snapshot()) ? 'capture-failed' : 'detector-start-failed'
        const error = runtimeError(code, cause)
        publish(code === 'capture-failed' ? 'error' : 'disabled', epoch, error)
        emit({ type: 'error', error, epoch })
        return snapshot
      } finally {
        startPromise = null
      }
    })()
    return startPromise
  }

  async function stop(): Promise<void> {
    if (disposed) return
    const epoch = snapshot.epoch + 1
    detectorStarted = false
    activeCaptureEpoch = undefined
    bufferedFrames = []
    unsubscribe?.()
    unsubscribe = null
    try { detector?.stop() } catch { /* detector may already be stopped */ }
    const releasingCapture = releaseCapture ? capture.disable() : Promise.resolve()
    publish('idle', epoch)
    try { await releasingCapture } catch { /* capture stop is best-effort */ }
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    detectorStarted = false
    activeCaptureEpoch = undefined
    bufferedFrames = []
    unsubscribe?.()
    unsubscribe = null
    try { detector?.stop() } catch { /* noop */ }
    let releasingDetector: void | Promise<void>
    try { releasingDetector = detector?.dispose?.() } catch { releasingDetector = undefined }
    let releasingCapture: void | Promise<void>
    try { releasingCapture = releaseCapture ? capture.dispose() : undefined } catch { releasingCapture = undefined }
    publish('disposed', snapshot.epoch + 1)
    try { await releasingDetector } catch { /* noop */ }
    try { await releasingCapture } catch { /* noop */ }
  }

  return {
    start,
    stop,
    dispose,
    snapshot: () => snapshot,
  }
}
