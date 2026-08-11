import { describe, expect, it, vi } from 'vitest'
import {
  createSpeechController,
  type SpeechControllerHandlers,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
  type SpeechSynthesisLike,
  type SpeechUtteranceLike,
} from './speech'

/** A hand-driven stand-in for the browser recogniser. */
class FakeRecognition implements SpeechRecognitionLike {
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 0
  started = 0
  stopped = 0
  aborted = 0
  startThrows = false
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null
  onerror: ((event: { error?: string }) => void) | null = null
  onend: (() => void) | null = null
  onstart: (() => void) | null = null

  start() {
    this.started += 1
    if (this.startThrows) throw new Error('already started')
  }

  stop() { this.stopped += 1 }
  abort() { this.aborted += 1 }

  /** Pushes one result through whatever handler is currently attached. */
  emit(transcript: string, isFinal: boolean, confidence?: number) {
    this.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal, length: 1, 0: { transcript, confidence } } },
    })
  }
}

class FakeSynthesis implements SpeechSynthesisLike {
  spoken: SpeechUtteranceLike[] = []
  cancelled = 0
  speakThrows = false
  speak(utterance: SpeechUtteranceLike) {
    if (this.speakThrows) throw new Error('synthesis start failed')
    this.spoken.push(utterance)
  }
  cancel() { this.cancelled += 1 }
}

function setup(handlers: SpeechControllerHandlers = {}) {
  const engines: FakeRecognition[] = []
  const synthesis = new FakeSynthesis()
  const controller = createSpeechController({
    createRecognition: () => {
      const engine = new FakeRecognition()
      engines.push(engine)
      return engine
    },
    getSynthesis: () => synthesis,
    createUtterance: () => ({ lang: '', onend: null, onerror: null }),
    handlers,
  })
  return { controller, engines, synthesis, engine: () => engines.at(-1)! }
}

describe('speech controller — recognition lifecycle', () => {
  it('configures and starts an engine for zh-CN', () => {
    const { controller, engine } = setup()
    expect(controller.startListening()).toBe(true)
    expect(engine().lang).toBe('zh-CN')
    expect(engine().continuous).toBe(true)
    expect(engine().interimResults).toBe(true)
    expect(engine().started).toBe(1)
  })

  it('forwards native onstart so authorization can enter waiting-wake', () => {
    const onStart = vi.fn()
    const { controller, engine } = setup({ onStart })
    controller.startListening()
    engine().onstart?.()
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('forwards partial and final results with clamped confidence', () => {
    const onPartial = vi.fn()
    const onFinal = vi.fn()
    const { controller, engine } = setup({ onPartial, onFinal })
    controller.startListening()

    engine().emit('去机场', false)
    engine().emit('去机场接妈妈', true, 1.5)

    expect(onPartial).toHaveBeenCalledWith('去机场')
    expect(onFinal).toHaveBeenCalledWith('去机场接妈妈', 1)
  })

  it('maps engine error codes onto voice error kinds', () => {
    const onError = vi.fn()
    const { controller, engine } = setup({ onError })

    controller.startListening()
    engine().onerror?.({ error: 'not-allowed' })
    expect(onError).toHaveBeenLastCalledWith('permission')

    controller.startListening()
    engine().onerror?.({ error: 'no-speech' })
    expect(onError).toHaveBeenLastCalledWith('no-speech')

    controller.startListening()
    engine().onerror?.({ error: 'audio-capture' })
    expect(onError).toHaveBeenLastCalledWith('recognition')
  })

  it('reports a failed start as a recognition error', () => {
    const onError = vi.fn()
    const engines: FakeRecognition[] = []
    const controller = createSpeechController({
      createRecognition: () => {
        const engine = new FakeRecognition()
        engine.startThrows = true
        engines.push(engine)
        return engine
      },
      getSynthesis: () => new FakeSynthesis(),
      handlers: { onError },
    })

    expect(controller.startListening()).toBe(false)
    expect(onError).toHaveBeenCalledWith('recognition')
  })

  it('returns false when the browser has no recogniser', () => {
    const controller = createSpeechController({
      createRecognition: () => null,
      getSynthesis: () => new FakeSynthesis(),
    })
    expect(controller.startListening()).toBe(false)
  })
})

describe('speech controller — generation guards', () => {
  it('drops results from the previous turn after a restart', () => {
    const onFinal = vi.fn()
    const { controller, engines } = setup({ onFinal })
    controller.startListening()
    const first = engines[0]!

    controller.startListening()
    // The old engine's callbacks were detached, but even a retained reference
    // to the handler must not reach the new turn.
    first.emit('上一轮的迟到结果', true)
    expect(onFinal).not.toHaveBeenCalled()

    engines[1]!.emit('本轮结果', true)
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('本轮结果', undefined)
  })

  it('releases the previous engine when a new turn starts', () => {
    const { controller, engines } = setup()
    controller.startListening()
    controller.startListening()
    expect(engines[0]!.aborted).toBe(1)
    expect(engines[0]!.onresult).toBeNull()
    expect(engines[0]!.onend).toBeNull()
  })

  it('drops a late onend after stopListening', () => {
    const onEnd = vi.fn()
    const { controller, engines } = setup({ onEnd })
    controller.startListening()
    const engine = engines[0]!
    const retained = engine.onend
    controller.stopListening()

    retained?.()
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('drops a late onerror after stopListening', () => {
    const onError = vi.fn()
    const { controller, engines } = setup({ onError })
    controller.startListening()
    const retained = engines[0]!.onerror
    controller.stopListening()

    retained?.({ error: 'not-allowed' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('drops a late onstart after stopListening', () => {
    const onStart = vi.fn()
    const { controller, engines } = setup({ onStart })
    controller.startListening()
    const retained = engines[0]!.onstart
    controller.stopListening()

    retained?.()
    expect(onStart).not.toHaveBeenCalled()
  })
})

describe('speech controller — synthesis', () => {
  it('cancels any current playback before speaking', () => {
    const { controller, synthesis } = setup()
    expect(controller.speak('好的。')).toBe(true)
    expect(synthesis.cancelled).toBe(1)
    expect(synthesis.spoken).toHaveLength(1)
    expect(synthesis.spoken[0]!.lang).toBe('zh-CN')
  })

  it('reports playback completion', () => {
    const onSpeakEnd = vi.fn()
    const { controller, synthesis } = setup({ onSpeakEnd })
    controller.speak('好的。')
    synthesis.spoken[0]!.onend?.()
    expect(onSpeakEnd).toHaveBeenCalledTimes(1)
  })

  it('drops the aborted utterance callback after a barge-in', () => {
    const onSpeakEnd = vi.fn()
    const { controller, synthesis } = setup({ onSpeakEnd })
    controller.speak('好的。')
    const aborted = synthesis.spoken[0]!
    controller.stopSpeaking()

    aborted.onend?.()
    expect(onSpeakEnd).not.toHaveBeenCalled()
  })

  it('drops the previous utterance callback when a new one starts', () => {
    const onSpeakEnd = vi.fn()
    const { controller, synthesis } = setup({ onSpeakEnd })
    controller.speak('第一句。')
    controller.speak('第二句。')

    synthesis.spoken[0]!.onend?.()
    expect(onSpeakEnd).not.toHaveBeenCalled()

    synthesis.spoken[1]!.onend?.()
    expect(onSpeakEnd).toHaveBeenCalledTimes(1)
  })

  it('returns false when synthesis is unavailable', () => {
    const controller = createSpeechController({
      createRecognition: () => new FakeRecognition(),
      getSynthesis: () => null,
    })
    expect(controller.speak('好的。')).toBe(false)
  })

  it('reports a synthesis failure', () => {
    const onSpeakError = vi.fn()
    const { controller, synthesis } = setup({ onSpeakError })
    controller.speak('好的。')
    synthesis.spoken[0]!.onerror?.()
    expect(onSpeakError).toHaveBeenCalledTimes(1)
  })

  it('returns false without also firing the async error callback when start throws', () => {
    const onSpeakError = vi.fn()
    const { controller, synthesis } = setup({ onSpeakError })
    synthesis.speakThrows = true

    expect(controller.speak('好的。')).toBe(false)
    expect(onSpeakError).not.toHaveBeenCalled()
  })
})

describe('speech controller — dispose', () => {
  it('releases the engine and refuses further work', () => {
    const { controller, engines, synthesis } = setup()
    controller.startListening()
    controller.dispose()

    expect(engines[0]!.aborted).toBe(1)
    expect(synthesis.cancelled).toBe(1)
    expect(controller.startListening()).toBe(false)
    expect(controller.speak('好的。')).toBe(false)
    expect(engines).toHaveLength(1)
  })

  it('drops callbacks retained from before dispose', () => {
    const onFinal = vi.fn()
    const onSpeakEnd = vi.fn()
    const { controller, engines, synthesis } = setup({ onFinal, onSpeakEnd })
    controller.startListening()
    controller.speak('好的。')
    const retainedResult = engines[0]!.onresult
    const retainedUtterance = synthesis.spoken[0]!
    controller.dispose()

    retainedResult?.({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: '迟到' } } },
    })
    retainedUtterance.onend?.()

    expect(onFinal).not.toHaveBeenCalled()
    expect(onSpeakEnd).not.toHaveBeenCalled()
  })
})
