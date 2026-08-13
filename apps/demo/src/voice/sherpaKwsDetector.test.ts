import { createSherpaKwsDetector, XIAONAN_KEYWORD } from './sherpaKwsDetector'

function harness() {
  let runtimeReady: (() => void) | undefined
  let result = { keyword: '' }
  const stream = {
    acceptWaveform: vi.fn(),
    free: vi.fn(),
  }
  const spotter = {
    createStream: vi.fn(() => stream),
    isReady: vi.fn(() => false),
    decode: vi.fn(),
    getResult: vi.fn(() => result),
    reset: vi.fn(),
    free: vi.fn(),
  }
  const scope = {
    crossOriginIsolated: true,
  } as typeof globalThis & {
    Module?: { onRuntimeInitialized?: () => void }
    createKws?: (module: unknown, config: unknown) => typeof spotter
  }
  const injectScript = vi.fn(async (url: string) => {
    if (url.endsWith('sherpa-onnx-kws.js')) {
      scope.createKws = vi.fn(() => spotter)
      return
    }
    runtimeReady = () => scope.Module?.onRuntimeInitialized?.()
    queueMicrotask(() => runtimeReady?.())
  })
  return {
    scope,
    stream,
    spotter,
    injectScript,
    setKeyword(keyword: string) { result = { keyword } },
  }
}

describe('sherpa KWS detector', () => {
  it('loads the wrapper/runtime once and configures the Xiaonan token string', async () => {
    const h = harness()
    const detector = createSherpaKwsDetector({
      scope: h.scope,
      injectScript: h.injectScript,
      baseUrl: '/voice/kws/feed-test/',
    })

    await detector.load()
    await detector.load()

    expect(h.injectScript).toHaveBeenCalledTimes(2)
    expect(h.scope.createKws).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      keywords: XIAONAN_KEYWORD,
      keywordsScore: 2,
      keywordsThreshold: 0.2,
    }))
  })

  it('feeds 16 kHz PCM and emits a match only for a non-empty keyword', async () => {
    const h = harness()
    const matches: unknown[] = []
    const detector = createSherpaKwsDetector({
      scope: h.scope,
      injectScript: h.injectScript,
      baseUrl: '/voice/kws/dispose-test/',
    })
    await detector.start((match) => matches.push(match))
    h.spotter.isReady
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)

    detector.pushFrame({ samples: Float32Array.of(0.1, -0.1), sampleRate: 16_000, epoch: 1, sequence: 1 })
    expect(matches).toEqual([])
    expect(h.stream.acceptWaveform).toHaveBeenCalledWith(16_000, Float32Array.of(0.1, -0.1))

    h.setKeyword('小南')
    detector.pushFrame({ samples: Float32Array.of(0.2), sampleRate: 16_000, epoch: 1, sequence: 2 })
    expect(matches).toEqual([{ keyword: '小南' }])
    expect(h.spotter.reset).toHaveBeenCalledTimes(1)
  })

  it('does not lose a keyword found before a later decoder step', async () => {
    const h = harness()
    const matches: unknown[] = []
    let readyChecks = 0
    h.spotter.isReady.mockImplementation(() => readyChecks++ < 2)
    h.spotter.getResult
      .mockReturnValueOnce({ keyword: '小南' })
      .mockReturnValueOnce({ keyword: '' })
    const detector = createSherpaKwsDetector({
      scope: h.scope,
      injectScript: h.injectScript,
      baseUrl: '/voice/kws/multi-decode-test/',
    })
    await detector.start((match) => matches.push(match))

    detector.pushFrame({ samples: Float32Array.of(0.2), sampleRate: 16_000, epoch: 1, sequence: 1 })

    expect(matches).toEqual([{ keyword: '小南' }])
    expect(h.spotter.decode).toHaveBeenCalledTimes(1)
    expect(h.spotter.reset).toHaveBeenCalledTimes(1)
  })

  it('fails closed when cross-origin isolation is unavailable', async () => {
    const h = harness()
    h.scope.crossOriginIsolated = false
    const detector = createSherpaKwsDetector({ scope: h.scope, injectScript: h.injectScript })

    await expect(detector.load()).rejects.toThrow('cross-origin isolation')
    expect(h.injectScript).not.toHaveBeenCalled()
  })

  it('releases the stream and spotter on disposal', async () => {
    const h = harness()
    const detector = createSherpaKwsDetector({
      scope: h.scope,
      injectScript: h.injectScript,
      baseUrl: '/voice/kws/test/',
    })
    await detector.start(() => undefined)

    await detector.dispose?.()

    expect(h.stream.free).toHaveBeenCalledTimes(1)
    expect(h.spotter.free).toHaveBeenCalledTimes(1)
  })
})
