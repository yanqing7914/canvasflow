import type {
  SpeechControllerDeps,
  SpeechRecognitionEventLike,
  SpeechRecognitionLike,
  SpeechSynthesisLike,
  SpeechUtteranceLike,
} from '@canvasflow/voice'

/**
 * Hand-driven Web Speech stand-ins. jsdom ships neither `SpeechRecognition` nor
 * `speechSynthesis`, so every voice test supplies its own engines through the
 * `speech` prop.
 */
export class FakeRecognition implements SpeechRecognitionLike {
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 0
  started = 0
  aborted = 0
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null
  onerror: ((event: { error?: string }) => void) | null = null
  onend: (() => void) | null = null
  onstart: (() => void) | null = null

  start() { this.started += 1 }
  stop() { this.aborted += 1 }
  abort() { this.aborted += 1 }

  emit(transcript: string, isFinal: boolean, confidence?: number) {
    this.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal, length: 1, 0: { transcript, confidence } } },
    })
  }

  fail(code: string) { this.onerror?.({ error: code }) }
}

export class FakeSynthesis implements SpeechSynthesisLike {
  spoken: SpeechUtteranceLike[] = []
  cancelled = 0
  speak(utterance: SpeechUtteranceLike) { this.spoken.push(utterance) }
  cancel() { this.cancelled += 1 }
}

export type FakeSpeech = {
  /** Pass straight into `<App speech={...} />`. */
  deps: SpeechControllerDeps
  engines: FakeRecognition[]
  /** The engine backing the current listening turn. */
  engine: () => FakeRecognition
  synthesis: FakeSynthesis
  /** Make the next N recognition creations fail before a later retry succeeds. */
  failNextRecognitionStarts: (count?: number) => void
}

export function createFakeSpeech(): FakeSpeech {
  const engines: FakeRecognition[] = []
  const synthesis = new FakeSynthesis()
  let failedStarts = 0
  return {
    engines,
    synthesis,
    failNextRecognitionStarts: (count = 1) => { failedStarts += count },
    engine: () => {
      const current = engines.at(-1)
      if (!current) throw new Error('no recognition turn has been started yet')
      return current
    },
    deps: {
      createRecognition: () => {
        if (failedStarts > 0) {
          failedStarts -= 1
          return null
        }
        const engine = new FakeRecognition()
        engines.push(engine)
        return engine
      },
      getSynthesis: () => synthesis,
      createUtterance: () => ({ lang: '', onend: null, onerror: null }),
    },
  }
}
