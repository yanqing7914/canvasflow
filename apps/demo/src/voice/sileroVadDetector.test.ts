import { createSileroVadDetector, SileroEndpoint } from './sileroVadDetector'

describe('Silero endpoint', () => {
  it('requires sustained speech before starting', () => {
    const endpoint = new SileroEndpoint({ speechPadMs: 64, silenceTailMs: 800 })

    expect(endpoint.accept(0.9)).toBeUndefined()
    expect(endpoint.accept(0.9)).toBe('start')
  })

  it('uses hysteresis and ignores the middle band', () => {
    const endpoint = new SileroEndpoint({ speechPadMs: 32, silenceTailMs: 64 })

    expect(endpoint.accept(0.9)).toBe('start')
    expect(endpoint.accept(0.4)).toBeUndefined()
    expect(endpoint.accept(0.2)).toBeUndefined()
    expect(endpoint.accept(0.4)).toBeUndefined()
    expect(endpoint.accept(0.2)).toBe('end')
  })

  it('ends only after the configured silence tail', () => {
    const endpoint = new SileroEndpoint({ speechPadMs: 32, silenceTailMs: 96 })

    expect(endpoint.accept(0.8)).toBe('start')
    expect(endpoint.accept(0.1)).toBeUndefined()
    expect(endpoint.accept(0.1)).toBeUndefined()
    expect(endpoint.accept(0.1)).toBe('end')
  })

  it('reset clears active and pending state', () => {
    const endpoint = new SileroEndpoint({ speechPadMs: 64, silenceTailMs: 64 })
    endpoint.accept(0.9)
    endpoint.reset()

    expect(endpoint.accept(0.9)).toBeUndefined()
  })

  it('releases the ORT session and rejects use after disposal', async () => {
    const release = vi.fn(async () => undefined)
    const detector = createSileroVadDetector({
      capture: { subscribe: () => () => undefined },
      createSession: vi.fn(async () => ({ release }) as never),
    })

    await detector.load()
    await detector.dispose()

    expect(release).toHaveBeenCalledTimes(1)
    await expect(detector.load()).rejects.toThrow('disposed')
    expect(() => detector.start({
      onSpeechStart: vi.fn(),
      onSpeechEnd: vi.fn(),
      onError: vi.fn(),
    })).toThrow('disposed')
  })

  it('releases a session that finishes loading after disposal', async () => {
    let resolveSession!: (session: { release: ReturnType<typeof vi.fn> }) => void
    const pending = new Promise<{ release: ReturnType<typeof vi.fn> }>((resolve) => {
      resolveSession = resolve
    })
    const release = vi.fn(async () => undefined)
    const detector = createSileroVadDetector({
      capture: { subscribe: () => () => undefined },
      createSession: vi.fn(() => pending) as never,
    })

    const loading = detector.load()
    const disposing = detector.dispose()
    resolveSession({ release })

    await expect(loading).rejects.toThrow('disposed')
    await disposing
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('retries after a model load failure', async () => {
    const release = vi.fn(async () => undefined)
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockResolvedValueOnce({ release })
    const detector = createSileroVadDetector({
      capture: { subscribe: () => () => undefined },
      createSession: createSession as never,
    })

    await expect(detector.load()).rejects.toThrow('model unavailable')
    await expect(detector.load()).resolves.toBeUndefined()
    expect(createSession).toHaveBeenCalledTimes(2)

    await detector.dispose()
  })
})
