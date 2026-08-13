import type { SpeechRecognitionLike } from '@canvasflow/voice'
import { createLocalHandsFreeController } from './localHandsFreeController'

function recognition(): SpeechRecognitionLike {
  return {
    lang: '',
    continuous: false,
    interimResults: false,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    onresult: null,
    onerror: null,
    onend: null,
    onstart: null,
  }
}

describe('local hands-free controller', () => {
  it('keeps Web Speech behind the command-recognizer seam', () => {
    const createRecognition = vi.fn(recognition)
    const controller = createLocalHandsFreeController({
      createRecognition,
      onSubmit: vi.fn(() => false),
    })

    expect(createRecognition).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('uses the shared PCM recognizer by default', () => {
    const createPcmRecognizer = vi.fn(() => ({ start: vi.fn() }))
    const controller = createLocalHandsFreeController({
      createPcmRecognizer: createPcmRecognizer as never,
      onSubmit: vi.fn(() => false),
    })

    expect(createPcmRecognizer).toHaveBeenCalledWith(expect.objectContaining({ capture: expect.anything() }))
    controller.dispose()
  })

  it('keeps the shared microphone alive when command recognition fails', async () => {
    const capture = {
      enable: vi.fn(async () => ({ state: 'running', epoch: 1, outputSampleRate: 16_000 } as const)),
      disable: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({ state: 'running', epoch: 1, outputSampleRate: 16_000 } as const)),
      preRoll: vi.fn(() => new Float32Array()),
      subscribe: vi.fn(() => () => undefined),
    }
    let wake: (() => void) | undefined
    const errors: string[] = []
    const controller = createLocalHandsFreeController({
      createCapture: () => capture as never,
      createWakeDetector: () => ({
        load: vi.fn(async () => undefined),
        start: vi.fn(async (listener: (match: { keyword: string }) => void) => { wake = () => listener({ keyword: '小南' }) }),
        pushFrame: vi.fn(),
        stop: vi.fn(),
        dispose: vi.fn(),
      }),
      createVadDetector: () => ({
        start: vi.fn(() => ({ stop: vi.fn() })),
        load: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      }),
      createCommandRecognizer: () => ({
        start: vi.fn((listener) => {
          queueMicrotask(() => listener.onError(new Error('command ASR failed')))
          return { stop: vi.fn(), endUtterance: vi.fn() }
        }),
      }),
      onSubmit: vi.fn(() => false),
      onError: (message) => errors.push(message),
    })

    await expect(controller.enable()).resolves.toBe(true)
    wake?.()
    await vi.waitFor(() => expect(errors).toContain('command ASR failed'))

    expect(capture.disable).not.toHaveBeenCalled()
    expect(controller.snapshot().state).toBe('ARMED')
    controller.dispose()
  })
})
