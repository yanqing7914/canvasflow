import type { SpeechRecognitionLike } from '@canvasflow/voice'
import { createWebSpeechCommandRecognizer } from './webSpeechCommandRecognizer'

function engine(): SpeechRecognitionLike {
  return {
    lang: '',
    continuous: false,
    interimResults: false,
    maxAlternatives: 0,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    onresult: null,
    onerror: null,
    onend: null,
    onstart: null,
  }
}

describe('Web Speech command recognizer', () => {
  it('opens only an explicit command turn', async () => {
    const recognition = engine()
    const recognizer = createWebSpeechCommandRecognizer({
      createRecognition: () => recognition,
      supported: () => true,
      secureContext: () => true,
    })
    const listener = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() }

    const session = await recognizer.start(listener, { generation: 1, source: 'wake', speechAlreadyStarted: false })

    expect(recognition.start).toHaveBeenCalledTimes(1)
    expect(recognition.continuous).toBe(true)
    expect(recognition.interimResults).toBe(true)
    session.stop()
    expect(recognition.abort).toHaveBeenCalledTimes(1)
  })

  it('forwards partial and final command text', () => {
    const recognition = engine()
    const recognizer = createWebSpeechCommandRecognizer({
      createRecognition: () => recognition,
      supported: () => true,
      secureContext: () => true,
    })
    const listener = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() }
    recognizer.start(listener, { generation: 1, source: 'wake', speechAlreadyStarted: false })

    recognition.onresult?.({
      resultIndex: 0,
      results: Object.assign({ length: 2 }, {
        0: Object.assign({ isFinal: false, length: 1 }, { 0: { transcript: '查' } }),
        1: Object.assign({ isFinal: true, length: 1 }, { 0: { transcript: '查天气' } }),
      }),
    })

    expect(listener.onPartial).toHaveBeenCalledWith('查')
    expect(listener.onFinal).toHaveBeenCalledWith('查天气', undefined)
  })

  it('fails before creating an engine when Web Speech is unavailable', () => {
    const createRecognition = vi.fn(() => engine())
    const recognizer = createWebSpeechCommandRecognizer({
      createRecognition,
      supported: () => false,
      secureContext: () => true,
    })

    expect(() => recognizer.start(
      { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() },
      { generation: 1, source: 'wake', speechAlreadyStarted: false },
    )).toThrow('unavailable')
    expect(createRecognition).not.toHaveBeenCalled()
  })
})
