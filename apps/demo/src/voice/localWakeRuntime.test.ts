import { createAudioCapture } from './audioCapture'
import { createLocalWakeRuntime, type WakeDetector } from './localWakeRuntime'
import type { AudioCaptureSnapshot } from './audioCapture'

function fakeCapture() {
  let listener: ((samples: Float32Array, epoch: number) => void) | undefined
  let current: AudioCaptureSnapshot = { state: 'idle', epoch: 0, outputSampleRate: 16_000 }
  const preRoll = Float32Array.of(0.1, 0.2)
  return {
    capture: {
      enable: vi.fn(async () => {
        current = { state: 'running', epoch: current.epoch + 1, outputSampleRate: 16_000 }
        return current
      }),
      disable: vi.fn(async () => { current = { state: 'idle', epoch: current.epoch + 1, outputSampleRate: 16_000 } }),
      dispose: vi.fn(async () => { current = { state: 'disposed', epoch: current.epoch + 1, outputSampleRate: 16_000 } }),
      snapshot: () => current,
      preRoll: () => preRoll,
      subscribe: vi.fn((next: (samples: Float32Array, epoch: number) => void) => {
        listener = next
        return () => { listener = undefined }
      }),
    },
    emit: (samples: Float32Array, epoch = current.epoch) => listener?.(samples, epoch),
  }
}

function detectorHarness() {
  let onMatch: ((match: { keyword: string; confidence?: number }) => void) | undefined
  const pushFrame = vi.fn()
  const detector: WakeDetector = {
    load: vi.fn(async () => undefined),
    start: vi.fn(async (next) => { onMatch = next }),
    pushFrame,
    stop: vi.fn(),
    dispose: vi.fn(async () => undefined),
  }
  return { detector, pushFrame, match: (keyword: string, confidence?: number) => onMatch?.({ keyword, confidence }) }
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

describe('local wake runtime', () => {
  it('is visibly disabled when no detector is injected', async () => {
    const h = fakeCapture()
    const events: unknown[] = []
    const runtime = createLocalWakeRuntime({ capture: h.capture, onEvent: (event) => events.push(event) })

    await expect(runtime.start()).resolves.toMatchObject({ state: 'disabled' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 'detector-unavailable' }) }))
    expect(h.capture.enable).not.toHaveBeenCalled()
  })

  it('loads and arms an injected detector without any network seam', async () => {
    const h = fakeCapture()
    const d = detectorHarness()
    const events: unknown[] = []
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d.detector, onEvent: (event) => events.push(event) })

    await runtime.start()
    expect(runtime.snapshot().state).toBe('armed')
    expect(d.detector.load).toHaveBeenCalledTimes(1)
    expect(d.detector.start).toHaveBeenCalledTimes(1)
    expect(h.capture.enable).toHaveBeenCalledTimes(1)
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'network' }))
  })

  it('forwards local PCM frames and emits a local-only wake event with pre-roll', async () => {
    const h = fakeCapture()
    const d = detectorHarness()
    const events: unknown[] = []
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d.detector, onEvent: (event) => events.push(event) })
    await runtime.start()

    h.emit(Float32Array.of(1, 2, 3))
    expect(d.detector.pushFrame).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 16_000, sequence: 1 }))
    d.match('小南', 0.93)

    expect(events).toContainEqual(expect.objectContaining({
      type: 'wake', keyword: '小南', confidence: 0.93, preRoll: Float32Array.of(0.1, 0.2),
    }))
  })

  it('buffers PCM emitted while the detector is still starting', async () => {
    const h = fakeCapture()
    const starting = deferred<void>()
    const d = detectorHarness()
    d.detector.start = vi.fn(async (onMatch) => {
      await starting.promise
      void onMatch
    })
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d.detector })

    const pendingStart = runtime.start()
    await vi.waitFor(() => expect(d.detector.start).toHaveBeenCalledTimes(1))
    h.emit(Float32Array.of(1, 2, 3))
    expect(d.detector.pushFrame).not.toHaveBeenCalled()
    starting.resolve()
    await pendingStart

    expect(d.detector.pushFrame).toHaveBeenCalledWith(expect.objectContaining({
      samples: Float32Array.of(1, 2, 3),
      sampleRate: 16_000,
      sequence: 1,
    }))
  })

  it('bounds detector startup buffering and preserves chronological order', async () => {
    const h = fakeCapture()
    const starting = deferred<void>()
    const d = detectorHarness()
    d.detector.start = vi.fn(async () => starting.promise)
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d.detector, maxBufferedFrames: 2 })

    const pendingStart = runtime.start()
    await vi.waitFor(() => expect(d.detector.start).toHaveBeenCalledTimes(1))
    h.emit(Float32Array.of(1))
    h.emit(Float32Array.of(2))
    h.emit(Float32Array.of(3))
    starting.resolve()
    await pendingStart

    expect(d.pushFrame.mock.calls.map(([frame]) => frame.samples[0])).toEqual([2, 3])
  })

  it('drops stale matches and frames after stop', async () => {
    const h = fakeCapture()
    const d = detectorHarness()
    const events: unknown[] = []
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d.detector, onEvent: (event) => events.push(event) })
    await runtime.start()
    await runtime.stop()
    h.emit(Float32Array.of(1, 2, 3))
    d.match('小南')

    expect(d.detector.pushFrame).not.toHaveBeenCalled()
    expect(events.filter((event) => (event as { type?: string }).type === 'wake')).toHaveLength(0)
    expect(h.capture.disable).toHaveBeenCalledTimes(1)
  })

  it('does not let a late detector load resurrect a disposed runtime', async () => {
    const h = fakeCapture()
    let resolveLoad: (() => void) | undefined
    const d: WakeDetector = {
      load: vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve })),
      start: vi.fn(), pushFrame: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
    }
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d })
    const starting = runtime.start()
    await runtime.dispose()
    resolveLoad?.()
    await starting

    expect(runtime.snapshot().state).toBe('disposed')
    expect(h.capture.enable).not.toHaveBeenCalled()
    expect(d.start).not.toHaveBeenCalled()
  })

  it('stops a detector that finishes starting after runtime stop', async () => {
    const h = fakeCapture()
    const starting = deferred<void>()
    const d = detectorHarness()
    d.detector.start = vi.fn(async () => starting.promise)
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d.detector })

    const pendingStart = runtime.start()
    await vi.waitFor(() => expect(d.detector.start).toHaveBeenCalledTimes(1))
    await runtime.stop()
    starting.resolve()
    await pendingStart

    expect(runtime.snapshot().state).toBe('idle')
    expect(d.detector.stop).toHaveBeenCalled()
    expect(h.capture.disable).toHaveBeenCalledTimes(1)
  })

  it('queues a restart requested while an old detector load is unwinding', async () => {
    const h = fakeCapture()
    const firstLoad = deferred<void>()
    const d = detectorHarness()
    d.detector.load = vi.fn()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce(undefined)
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d.detector })

    const staleStart = runtime.start()
    await vi.waitFor(() => expect(d.detector.load).toHaveBeenCalledTimes(1))
    await runtime.stop()
    const restarted = runtime.start()
    firstLoad.resolve()

    await staleStart
    await expect(restarted).resolves.toMatchObject({ state: 'armed' })
    expect(d.detector.load).toHaveBeenCalledTimes(2)
    expect(h.capture.enable).toHaveBeenCalledTimes(1)
    expect(d.detector.start).toHaveBeenCalledTimes(1)
  })

  it('publishes stop synchronously so a non-awaited stop can still queue restart', async () => {
    const h = fakeCapture()
    const firstLoad = deferred<void>()
    const releaseCapture = deferred<void>()
    h.capture.disable.mockImplementationOnce(async () => {
      await releaseCapture.promise
    })
    const d = detectorHarness()
    d.detector.load = vi.fn()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce(undefined)
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d.detector })

    const staleStart = runtime.start()
    await vi.waitFor(() => expect(d.detector.load).toHaveBeenCalledTimes(1))
    const stopping = runtime.stop()
    expect(runtime.snapshot().state).toBe('idle')
    const restarted = runtime.start()
    firstLoad.resolve()
    releaseCapture.resolve()

    await stopping
    await staleStart
    await expect(restarted).resolves.toMatchObject({ state: 'armed' })
    expect(d.detector.load).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes when capture cannot arm', async () => {
    const h = fakeCapture()
    h.capture.enable.mockImplementation(async () => ({
      state: 'disabled', epoch: 1, outputSampleRate: 16_000, error: { code: 'unsupported', message: 'unsupported' },
    }))
    const d = detectorHarness()
    const runtime = createLocalWakeRuntime({ capture: h.capture, detector: d.detector })

    await runtime.start()
    h.emit(Float32Array.of(1, 2, 3), 1)

    expect(runtime.snapshot().state).toBe('disabled')
    expect(d.detector.pushFrame).not.toHaveBeenCalled()
    expect(d.detector.start).not.toHaveBeenCalled()
    expect(h.capture.disable).toHaveBeenCalledTimes(1)
  })

  it('disables when capture cannot provide 16 kHz output', async () => {
    const capture = createAudioCapture({ mediaDevices: null })
    const d = detectorHarness()
    const runtime = createLocalWakeRuntime({ capture, detector: d.detector })

    await expect(runtime.start()).resolves.toMatchObject({ state: 'disabled', error: { code: 'capture-unavailable' } })
    expect(d.detector.start).not.toHaveBeenCalled()
  })
})
