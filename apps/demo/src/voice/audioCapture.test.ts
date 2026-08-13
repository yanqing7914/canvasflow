import { createAudioCapture, type AudioContextLike, type AudioNodeLike, type AudioWorkletNodeLike, type MediaStreamLike } from './audioCapture'

function createHarness(sampleRate = 48_000) {
  const constraints: MediaStreamConstraints[] = []
  const stopped: number[] = []
  const source: AudioNodeLike = { connect: vi.fn(), disconnect: vi.fn() }
  const scriptNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null,
  }
  const workletNode: AudioWorkletNodeLike = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: { onmessage: null },
  }
  const addModule = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  const resume = vi.fn(async () => undefined)
  const context: AudioContextLike = {
    sampleRate,
    destination: {},
    audioWorklet: { addModule },
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } })),
    createScriptProcessor: vi.fn(() => scriptNode),
    close,
    resume,
  }
  const track = { stop: vi.fn(() => stopped.push(1)) }
  const stream: MediaStreamLike = { getTracks: () => [track] }
  const getUserMedia = vi.fn(async (next: MediaStreamConstraints) => {
    constraints.push(next)
    return stream
  })

  return {
    constraints,
    stopped,
    source,
    scriptNode,
    workletNode,
    addModule,
    close,
    resume,
    context,
    stream,
    track,
    getUserMedia,
    capture: createAudioCapture({
      mediaDevices: { getUserMedia },
      createAudioContext: () => context,
      createAudioWorkletNode: () => workletNode,
      workletModuleUrl: '/test-worklet.js',
    }),
  }
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

describe('browser audio capture', () => {
  it('explicitly disables itself when microphone APIs are missing', async () => {
    const capture = createAudioCapture({ mediaDevices: null })

    await expect(capture.enable()).resolves.toMatchObject({
      state: 'disabled',
      error: { code: 'unsupported' },
    })
  })

  it('reports permission denial without opening an AudioContext', async () => {
    const createAudioContext = vi.fn()
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('blocked', 'NotAllowedError')
    })
    const capture = createAudioCapture({ mediaDevices: { getUserMedia }, createAudioContext })

    await expect(capture.enable()).resolves.toMatchObject({
      state: 'error',
      error: { code: 'permission-denied' },
    })
    expect(createAudioContext).not.toHaveBeenCalled()
  })

  it('is the sole getUserMedia owner and applies browser audio processing constraints', async () => {
    const h = createHarness()

    const [first, second] = await Promise.all([h.capture.enable(), h.capture.enable()])

    expect(first).toEqual(second)
    expect(h.getUserMedia).toHaveBeenCalledTimes(1)
    expect(h.constraints).toEqual([{
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    }])
    expect(first).toMatchObject({
      state: 'running',
      inputSampleRate: 48_000,
      outputSampleRate: 16_000,
      pipeline: 'audio-worklet',
    })
  })

  it('uses the actual AudioContext rate and emits 16 kHz mono PCM', async () => {
    const h = createHarness(48_000)
    const frames: Float32Array[] = []
    h.capture.subscribe((frame) => frames.push(frame))
    await h.capture.enable()

    h.workletNode.port.onmessage?.({ data: { samples: Float32Array.from({ length: 481 }, (_, index) => index / 480) } })

    expect(frames).toHaveLength(1)
    expect(frames[0]).toHaveLength(160)
    expect(frames[0]?.[0]).toBeCloseTo(0)
    expect(frames[0]?.at(-1)).toBeCloseTo(477 / 480)
    expect(h.capture.preRoll()).toHaveLength(160)
  })

  it('falls back explicitly when AudioWorklet loading fails', async () => {
    const h = createHarness()
    h.addModule.mockRejectedValueOnce(new Error('missing worklet'))
    const capture = createAudioCapture({
      mediaDevices: { getUserMedia: h.getUserMedia },
      createAudioContext: () => h.context,
      createAudioWorkletNode: () => h.workletNode,
      workletModuleUrl: '/test-worklet.js',
      allowScriptProcessorFallback: true,
    })

    await expect(capture.enable()).resolves.toMatchObject({
      state: 'running',
      pipeline: 'script-processor',
    })
    expect(h.context.createScriptProcessor).toHaveBeenCalledWith(4096, 1, 1)
  })

  it('can disable rather than silently falling back when Worklet is unavailable', async () => {
    const h = createHarness()
    h.addModule.mockRejectedValueOnce(new Error('missing worklet'))
    const capture = createAudioCapture({
      mediaDevices: { getUserMedia: h.getUserMedia },
      createAudioContext: () => h.context,
      createAudioWorkletNode: () => h.workletNode,
      workletModuleUrl: '/test-worklet.js',
      allowScriptProcessorFallback: false,
    })

    await expect(capture.enable()).resolves.toMatchObject({
      state: 'disabled',
      error: { code: 'worklet-unavailable' },
    })
    expect(h.track.stop).toHaveBeenCalledTimes(1)
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('invalidates a pending permission request and stops its late stream', async () => {
    let resolveStream: ((stream: MediaStreamLike) => void) | undefined
    const streamPromise = new Promise<MediaStreamLike>((resolve) => { resolveStream = resolve })
    const track = { stop: vi.fn() }
    const capture = createAudioCapture({
      mediaDevices: { getUserMedia: vi.fn(() => streamPromise) },
      createAudioContext: vi.fn(() => { throw new Error('must not open') }),
    })

    const starting = capture.enable()
    await capture.disable()
    resolveStream?.({ getTracks: () => [track] })
    await starting

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(capture.snapshot().state).toBe('idle')
  })

  it('does not let a stale Worklet completion tear down a newer capture', async () => {
    const modules = [deferred<void>(), deferred<void>()]
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }]
    const contexts = modules.map((module, index) => {
      const source: AudioNodeLike = { connect: vi.fn(), disconnect: vi.fn() }
      return {
        sampleRate: 48_000,
        destination: {},
        audioWorklet: { addModule: vi.fn(() => module.promise) },
        createMediaStreamSource: vi.fn(() => source),
        createGain: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } })),
        close: vi.fn(async () => undefined),
        resume: vi.fn(async () => undefined),
        source,
        index,
      } satisfies AudioContextLike & { source: AudioNodeLike; index: number }
    })
    const worklets = contexts.map((): AudioWorkletNodeLike => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      port: { onmessage: null },
    }))
    let contextIndex = 0
    let workletIndex = 0
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [tracks[getUserMedia.mock.calls.length - 1]!],
    }))
    const capture = createAudioCapture({
      mediaDevices: { getUserMedia },
      createAudioContext: () => contexts[contextIndex++]!,
      createAudioWorkletNode: () => worklets[workletIndex++]!,
      workletModuleUrl: '/test-worklet.js',
    })

    const staleStart = capture.enable()
    await vi.waitFor(() => expect(contexts[0]?.audioWorklet?.addModule).toHaveBeenCalled())
    await capture.disable()
    const freshStart = capture.enable()
    await vi.waitFor(() => expect(contexts[1]?.audioWorklet?.addModule).toHaveBeenCalled())
    modules[1]?.resolve()
    await expect(freshStart).resolves.toMatchObject({ state: 'running', epoch: 3 })

    modules[0]?.resolve()
    await staleStart

    expect(capture.snapshot()).toMatchObject({ state: 'running', epoch: 3 })
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1)
    expect(tracks[1]?.stop).not.toHaveBeenCalled()
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
    expect(contexts[1]?.close).not.toHaveBeenCalled()
  })

  it('does not let a stale failure overwrite a newer running capture', async () => {
    const permissions = [deferred<MediaStreamLike>(), deferred<MediaStreamLike>()]
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }]
    let requestIndex = 0
    const getUserMedia = vi.fn(() => permissions[requestIndex++]!.promise)
    const h = createHarness()
    const capture = createAudioCapture({
      mediaDevices: { getUserMedia },
      createAudioContext: () => h.context,
      createAudioWorkletNode: () => h.workletNode,
      workletModuleUrl: '/test-worklet.js',
    })

    const staleStart = capture.enable()
    await capture.disable()
    const freshStart = capture.enable()
    permissions[1]?.resolve({ getTracks: () => [tracks[1]!] })
    await expect(freshStart).resolves.toMatchObject({ state: 'running', epoch: 3 })

    permissions[0]?.reject(new DOMException('blocked', 'NotAllowedError'))
    await staleStart

    expect(capture.snapshot()).toMatchObject({ state: 'running', epoch: 3 })
    expect(tracks[1]?.stop).not.toHaveBeenCalled()
  })

  it('does not clear fresh pre-roll when an old disable finishes late', async () => {
    const closeOldContext = deferred<void>()
    const contexts = [
      { ...createHarness().context, close: vi.fn(() => closeOldContext.promise) },
      createHarness().context,
    ]
    const worklets: AudioWorkletNodeLike[] = contexts.map(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      port: { onmessage: null },
    }))
    let contextIndex = 0
    let workletIndex = 0
    const capture = createAudioCapture({
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
      createAudioContext: () => contexts[contextIndex++]!,
      createAudioWorkletNode: () => worklets[workletIndex++]!,
      workletModuleUrl: '/test-worklet.js',
    })

    await capture.enable()
    const stopping = capture.disable()
    await capture.enable()
    worklets[1]?.port.onmessage?.({ data: Float32Array.from({ length: 481 }, () => 0.25) })
    expect(capture.preRoll()).toHaveLength(160)

    closeOldContext.resolve()
    await stopping

    expect(capture.snapshot().state).toBe('running')
    expect(capture.preRoll()).toHaveLength(160)
  })

  it('revokes an owned Worklet Blob URL after module loading', async () => {
    const h = createHarness()
    const previousCreateObjectURL = URL.createObjectURL
    const previousRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:test-worklet')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    try {
      const capture = createAudioCapture({
        mediaDevices: { getUserMedia: h.getUserMedia },
        createAudioContext: () => h.context,
        createAudioWorkletNode: () => h.workletNode,
        workletNodeName: 'custom-voice-capture',
      })

      await expect(capture.enable()).resolves.toMatchObject({ state: 'running' })

      expect(h.addModule).toHaveBeenCalledWith('blob:test-worklet')
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-worklet')
    } finally {
      if (previousCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: previousCreateObjectURL })
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (previousRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: previousRevokeObjectURL })
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })

  it('isolates listener failures from other PCM consumers', async () => {
    const h = createHarness(48_000)
    const healthy = vi.fn()
    h.capture.subscribe(() => { throw new Error('consumer failed') })
    h.capture.subscribe(healthy)
    await h.capture.enable()

    expect(() => h.workletNode.port.onmessage?.({ data: Float32Array.from({ length: 481 }, () => 0.25) })).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  it('releases nodes, tracks, context, callbacks and buffered PCM', async () => {
    const h = createHarness()
    await h.capture.enable()
    h.workletNode.port.onmessage?.({ data: Float32Array.from({ length: 481 }, () => 0.25) })
    expect(h.capture.preRoll().length).toBeGreaterThan(0)

    await h.capture.dispose()

    expect(h.track.stop).toHaveBeenCalledTimes(1)
    expect(h.source.disconnect).toHaveBeenCalledTimes(1)
    expect(h.workletNode.disconnect).toHaveBeenCalledTimes(1)
    expect(h.close).toHaveBeenCalledTimes(1)
    expect(h.workletNode.port.onmessage).toBeNull()
    expect(h.capture.preRoll()).toHaveLength(0)
    expect(h.capture.snapshot().state).toBe('disposed')
  })
})
