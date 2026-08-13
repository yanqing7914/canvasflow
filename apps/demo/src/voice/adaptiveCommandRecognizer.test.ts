import { createAdaptiveCommandRecognizer } from './adaptiveCommandRecognizer'

describe('adaptive command recognizer', () => {
  it('uses PCM when the server advertises an ASR provider', async () => {
    const listeners = new Set<(samples: Float32Array) => void>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"pcmAsr":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"text":"查天气"}', { status: 200 }))
    const final = vi.fn()
    const recognizer = createAdaptiveCommandRecognizer({
      fetch: fetchMock as never,
      pcm: {
        capture: {
          preRoll: () => new Float32Array(),
          subscribe: (listener) => { listeners.add((samples) => listener(samples, 1)); return () => undefined },
        },
        fetch: fetchMock as never,
      },
      webSpeech: { supported: () => false },
    })
    const session = await recognizer.start({ onPartial: vi.fn(), onFinal: final, onError: vi.fn() }, {
      generation: 1, source: 'wake', speechAlreadyStarted: false,
    })
    for (const listener of listeners) listener(new Float32Array([0.2]))
    session.endUtterance()
    await vi.waitFor(() => expect(final).toHaveBeenCalledWith('查天气', undefined))
  })

  it('selects Web Speech before the command when PCM ASR is unavailable', async () => {
    const engine = {
      lang: '', continuous: false, interimResults: false, maxAlternatives: 1,
      start: vi.fn(), stop: vi.fn(), abort: vi.fn(),
      onresult: null, onerror: null, onend: null, onstart: null,
    }
    const recognizer = createAdaptiveCommandRecognizer({
      fetch: vi.fn(async () => new Response('{"pcmAsr":false}', { status: 200 })) as never,
      pcm: { capture: { preRoll: () => new Float32Array(), subscribe: () => () => undefined } },
      webSpeech: { createRecognition: () => engine, supported: () => true, secureContext: () => true },
    })
    await recognizer.start({ onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() }, {
      generation: 1, source: 'wake', speechAlreadyStarted: false,
    })
    expect(engine.start).toHaveBeenCalledTimes(1)
  })

  it('retries a failed capability probe on the next command turn', async () => {
    const engine = {
      lang: '', continuous: false, interimResults: false, maxAlternatives: 1,
      start: vi.fn(), stop: vi.fn(), abort: vi.fn(),
      onresult: null, onerror: null, onend: null, onstart: null,
    }
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Agent is starting'))
      .mockResolvedValueOnce(new Response('{"pcmAsr":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"text":"查天气"}', { status: 200 }))
    const listeners = new Set<(samples: Float32Array) => void>()
    const recognizer = createAdaptiveCommandRecognizer({
      fetch: fetchMock as never,
      pcm: {
        capture: {
          preRoll: () => new Float32Array(),
          subscribe: (listener) => { listeners.add((samples) => listener(samples, 1)); return () => undefined },
        },
        fetch: fetchMock as never,
      },
      webSpeech: { createRecognition: () => engine, supported: () => true, secureContext: () => true },
    })

    const first = await recognizer.start({ onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() }, {
      generation: 1, source: 'wake', speechAlreadyStarted: false,
    })
    expect(engine.start).toHaveBeenCalledOnce()
    first.stop()

    const secondFinal = vi.fn()
    const second = await recognizer.start({ onPartial: vi.fn(), onFinal: secondFinal, onError: vi.fn() }, {
      generation: 2, source: 'wake', speechAlreadyStarted: false,
    })
    for (const listener of listeners) listener(new Float32Array([0.2]))
    second.endUtterance()
    await vi.waitFor(() => expect(secondFinal).toHaveBeenCalledWith('查天气', undefined))
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
