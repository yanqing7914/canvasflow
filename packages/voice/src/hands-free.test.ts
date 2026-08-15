import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HANDS_FREE_STATE,
  createHandsFreeMachine,
  type CommandRecognitionOptions,
  type CommandRecognitionSession,
  type CommandRecognizer,
  type CommandRecognizerListener,
  type HandsFreeConfig,
  type HandsFreeEffects,
  type VadDetector,
  type VadDetectorListener,
  type WakeDetector,
  type WakeDetectorListener,
} from './hands-free'

type Call = { name: string; args: unknown[] }

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function harness(options: {
  config?: HandsFreeConfig
  wakeStart?: (listener: WakeDetectorListener) => ReturnType<WakeDetector['start']>
  vadStart?: (listener: VadDetectorListener) => ReturnType<VadDetector['start']>
  recognitionStart?: (
    listener: CommandRecognizerListener,
    options: CommandRecognitionOptions,
  ) => ReturnType<CommandRecognizer['start']>
  useDefaultTimers?: boolean
} = {}) {
  const calls: Call[] = []
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }) }
  const wakeListeners: WakeDetectorListener[] = []
  const vadListeners: VadDetectorListener[] = []
  const recognitions: Array<{
    listener: CommandRecognizerListener
    options: CommandRecognitionOptions
    session?: CommandRecognitionSession
  }> = []
  let wakeStops = 0
  let vadStops = 0
  let recognizerStops = 0
  let recognizerEndUtterances = 0
  let nextTimerId = 1
  const timers = new Map<number, { fn: () => void; ms: number }>()

  const wakeDetector: WakeDetector = {
    start(listener) {
      wakeListeners.push(listener)
      if (options.wakeStart) return options.wakeStart(listener)
      return { stop: () => { wakeStops += 1 } }
    },
  }
  const vadDetector: VadDetector = {
    start(listener) {
      vadListeners.push(listener)
      if (options.vadStart) return options.vadStart(listener)
      return { stop: () => { vadStops += 1 } }
    },
  }
  const commandRecognizer: CommandRecognizer = {
    start(listener, recognitionOptions) {
      const item = { listener, options: recognitionOptions, session: undefined as CommandRecognitionSession | undefined }
      recognitions.push(item)
      if (options.recognitionStart) return options.recognitionStart(listener, recognitionOptions)
      const session: CommandRecognitionSession = {
        stop: () => { recognizerStops += 1 },
        endUtterance: () => { recognizerEndUtterances += 1 },
      }
      item.session = session
      return session
    },
  }
  const effects: HandsFreeEffects = {
    onState: record('onState'),
    onWake: record('onWake'),
    onFalseWake: record('onFalseWake'),
    submitCommand: record('submitCommand'),
    stopSpeaking: record('stopSpeaking'),
    cancelTurn: record('cancelTurn'),
    onError: record('onError'),
  }
  const machine = createHandsFreeMachine({
    wakeDetector,
    vadDetector,
    commandRecognizer,
    effects,
    config: options.config,
    ...options.useDefaultTimers
      ? {}
      : {
          setTimer: (fn: () => void, ms: number) => {
            const id = nextTimerId
            nextTimerId += 1
            timers.set(id, { fn, ms })
            return id
          },
          clearTimer: (handle: unknown) => { timers.delete(handle as number) },
        },
  })

  return {
    machine,
    calls,
    names: () => calls.map((call) => call.name),
    lastArgs: (name: string) => calls.filter((call) => call.name === name).at(-1)?.args,
    countOf: (name: string) => calls.filter((call) => call.name === name).length,
    wake: (index = -1) => wakeListeners.at(index)!.onWake(),
    wakeError: (error: unknown, index = -1) => wakeListeners.at(index)!.onError(error),
    speechStart: (index = -1) => vadListeners.at(index)!.onSpeechStart(),
    speechEnd: (index = -1) => vadListeners.at(index)!.onSpeechEnd(),
    vadError: (error: unknown, index = -1) => vadListeners.at(index)!.onError(error),
    asrPartial: (text: string, index = -1) => recognitions.at(index)!.listener.onPartial(text),
    asrFinal: (text: string, confidence?: number, index = -1) => recognitions.at(index)!.listener.onFinal(text, confidence),
    recognizerError: (error: unknown, index = -1) => recognitions.at(index)!.listener.onError(error),
    recognitionOptions: (index = -1) => recognitions.at(index)?.options,
    wakeStops: () => wakeStops,
    vadStops: () => vadStops,
    recognizerStops: () => recognizerStops,
    recognizerEndUtterances: () => recognizerEndUtterances,
    pendingTimerMs: () => [...timers.values()].map(({ ms }) => ms),
    fireOldest: () => {
      const next = timers.entries().next().value as [number, { fn: () => void; ms: number }] | undefined
      if (!next) throw new Error('no pending timer')
      timers.delete(next[0])
      next[1].fn()
    },
    pendingTimers: () => timers.size,
  }
}

async function enable(h: ReturnType<typeof harness>) {
  await expect(h.machine.enable()).resolves.toBe(true)
  expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.ARMED)
}

function submitOneTurn(h: ReturnType<typeof harness>, text = '查天气') {
  h.wake()
  h.speechStart()
  h.speechEnd()
  h.asrFinal(text)
  expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.THINKING)
  return h.machine.snapshot().activeTurnGeneration!
}

describe('hands-free machine', () => {
  it('starts detectors before exposing ARMED and reuses one concurrent enable', async () => {
    const vad = deferred<{ stop: () => void }>()
    const wake = deferred<{ stop: () => void }>()
    const h = harness({
      vadStart: () => vad.promise,
      wakeStart: () => wake.promise,
    })

    const first = h.machine.enable()
    const second = h.machine.enable()
    expect(first).toBe(second)
    expect(h.machine.snapshot()).toMatchObject({ state: HANDS_FREE_STATE.IDLE, enabled: false })

    vad.resolve({ stop: () => undefined })
    await Promise.resolve()
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.IDLE)
    wake.resolve({ stop: () => undefined })
    await expect(first).resolves.toBe(true)
    expect(h.machine.snapshot()).toMatchObject({ state: HANDS_FREE_STATE.ARMED, enabled: true })
  })

  it('walks the complete no-TTS turn and uses the 8-second follow-up window', async () => {
    const h = harness()
    await enable(h)

    const generation = submitOneTurn(h)
    expect(h.lastArgs('submitCommand')).toEqual([
      { generation, source: 'wake', text: '查天气' },
    ])
    expect(h.recognizerEndUtterances()).toBe(1)

    h.machine.turnEnded(generation)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.FOLLOW_UP)
    expect(h.pendingTimerMs()).toEqual([8_000])
    h.fireOldest()
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.ARMED)
  })

  it('runs THINKING → SPEAKING → FOLLOW_UP and accepts a wake-free continuation', async () => {
    const h = harness()
    await enable(h)
    const generation = submitOneTurn(h)

    h.machine.ttsStarted(generation)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.SPEAKING)
    h.machine.ttsEnded(generation)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.FOLLOW_UP)

    h.speechStart()
    expect(h.machine.snapshot()).toMatchObject({
      state: HANDS_FREE_STATE.LISTENING,
      listeningSource: 'follow-up',
      speechActive: true,
    })
    expect(h.recognitionOptions()).toMatchObject({ source: 'follow-up', speechAlreadyStarted: true })
    h.asrFinal('继续')
    expect(h.lastArgs('submitCommand')).toEqual([
      { generation: generation + 1, source: 'follow-up', text: '继续' },
    ])
  })

  it('keeps continuous follow-up open without an expiry timer', async () => {
    const h = harness({ config: { continuousFollowUp: true } })
    await enable(h)
    const generation = submitOneTurn(h)

    h.machine.turnEnded(generation)

    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.FOLLOW_UP)
    expect(h.pendingTimerMs()).toEqual([])
    h.speechStart()
    expect(h.machine.snapshot()).toMatchObject({
      state: HANDS_FREE_STATE.LISTENING,
      listeningSource: 'follow-up',
    })
  })

  it('treats an explicit wake during FOLLOW_UP as a fresh wake utterance', async () => {
    const h = harness()
    await enable(h)
    const generation = submitOneTurn(h)
    h.machine.turnEnded(generation)

    h.wake()
    expect(h.machine.snapshot()).toMatchObject({
      state: HANDS_FREE_STATE.LISTENING,
      listeningSource: 'wake',
      speechActive: false,
    })
    expect(h.recognitionOptions()).toMatchObject({ source: 'wake', speechAlreadyStarted: false })
    expect(h.pendingTimerMs()).toEqual([5_000])
  })

  it('silently re-arms a wake with no speech after five seconds', async () => {
    const h = harness()
    await enable(h)
    h.wake()
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.LISTENING)
    expect(h.pendingTimerMs()).toEqual([5_000])

    h.fireOldest()
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.ARMED)
    expect(h.countOf('onFalseWake')).toBe(1)
    expect(h.countOf('submitCommand')).toBe(0)
  })

  it('clears false-wake when VAD or ASR observes speech', async () => {
    const h = harness()
    await enable(h)
    h.wake()
    h.asrPartial('查')
    expect(h.pendingTimers()).toBe(0)
    expect(h.machine.snapshot().speechActive).toBe(true)
  })

  it('asks the recognizer to finalize on VAD speech end', async () => {
    const h = harness()
    await enable(h)
    h.wake()
    h.speechStart()
    h.speechEnd()
    expect(h.recognizerEndUtterances()).toBe(1)
  })

  it('keeps a wake inside an already active utterance open until the VAD endpoint', async () => {
    const h = harness()
    await enable(h)

    // In real KWS the VAD sees the beginning of "小南" before the keyword
    // decoder can emit a match. The command recognizer must inherit that active
    // speech state or the later endpoint is ignored.
    h.speechStart()
    h.wake()

    expect(h.machine.snapshot()).toMatchObject({
      state: HANDS_FREE_STATE.LISTENING,
      listeningSource: 'wake',
      speechActive: true,
    })
    expect(h.recognitionOptions()).toMatchObject({ source: 'wake', speechAlreadyStarted: true })
    expect(h.pendingTimers()).toBe(0)

    h.speechEnd()
    expect(h.recognizerEndUtterances()).toBe(1)
  })

  it('delivers a VAD endpoint that arrives before an async recognizer session', async () => {
    const recognition = deferred<CommandRecognitionSession>()
    let endUtterances = 0
    const h = harness({ recognitionStart: () => recognition.promise })
    await enable(h)
    h.wake()
    h.speechStart()
    h.speechEnd()
    expect(h.recognizerEndUtterances()).toBe(0)

    recognition.resolve({
      stop: () => undefined,
      endUtterance: () => { endUtterances += 1 },
    })
    await Promise.resolve()
    expect(endUtterances).toBe(1)
  })

  it('treats an empty final as an open follow-up, not a submitted command', async () => {
    const h = harness()
    await enable(h)
    h.wake()
    h.asrFinal('   ')
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.FOLLOW_UP)
    expect(h.countOf('submitCommand')).toBe(0)
  })

  it('carries recognizer confidence to the submitted voice command', async () => {
    const h = harness()
    await enable(h)
    h.wake()

    h.asrFinal('查天气', 0.86)

    expect(h.lastArgs('submitCommand')).toEqual([{
      generation: 1,
      source: 'wake',
      text: '查天气',
      confidence: 0.86,
    }])
  })

  it('requires 300 ms sustained speech before VAD barge-in', async () => {
    const h = harness()
    await enable(h)
    const generation = submitOneTurn(h)
    h.machine.ttsStarted(generation)

    h.speechStart()
    expect(h.pendingTimerMs()).toEqual([300])
    h.fireOldest()
    expect(h.machine.snapshot()).toMatchObject({
      state: HANDS_FREE_STATE.LISTENING,
      listeningSource: 'barge-in',
      speechActive: true,
    })
    expect(h.lastArgs('stopSpeaking')).toEqual([generation])
    expect(h.countOf('cancelTurn')).toBe(0)
  })

  it('does not barge in when speech ends before 300 ms', async () => {
    const h = harness()
    await enable(h)
    const generation = submitOneTurn(h)
    h.machine.ttsStarted(generation)
    h.speechStart()
    h.speechEnd()
    expect(h.pendingTimers()).toBe(0)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.SPEAKING)
    expect(h.countOf('stopSpeaking')).toBe(0)
  })

  it('uses an explicit wake to interrupt THINKING or SPEAKING immediately', async () => {
    const h = harness()
    await enable(h)
    const first = submitOneTurn(h)
    h.wake()
    expect(h.lastArgs('cancelTurn')).toEqual([first])
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.LISTENING)

    h.asrFinal('第二轮')
    const second = h.machine.snapshot().activeTurnGeneration!
    h.machine.ttsStarted(second)
    h.wake()
    expect(h.lastArgs('stopSpeaking')).toEqual([second])
    expect(h.countOf('cancelTurn')).toBe(1)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.LISTENING)
  })

  it('drops stale ASR, turn, and TTS callbacks after a new generation starts', async () => {
    const h = harness()
    await enable(h)
    h.wake()
    const staleRecognition = h.recognitionOptions()!.generation
    h.asrFinal('第一轮')
    const firstTurn = h.machine.snapshot().activeTurnGeneration!
    h.wake()

    h.asrFinal('迟到旧稿', undefined, -2)
    h.machine.ttsStarted(firstTurn)
    h.machine.ttsEnded(firstTurn)
    h.machine.turnEnded(firstTurn)
    expect(h.countOf('submitCommand')).toBe(1)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.LISTENING)
    expect(h.recognitionOptions()!.generation).not.toBe(staleRecognition)
  })

  it('stops a recognizer session that resolves after the listen was invalidated', async () => {
    const recognition = deferred<CommandRecognitionSession>()
    let stopped = 0
    const h = harness({ recognitionStart: () => recognition.promise })
    await enable(h)
    h.wake()
    h.machine.disable()
    recognition.resolve({
      stop: () => { stopped += 1 },
      endUtterance: () => undefined,
    })
    await Promise.resolve()
    expect(stopped).toBe(1)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.IDLE)
  })

  it('stops a detector that resolves after disable during startup', async () => {
    const vad = deferred<{ stop: () => void }>()
    let stopped = 0
    const h = harness({ vadStart: () => vad.promise })
    const enabling = h.machine.enable()
    h.machine.disable()
    vad.resolve({ stop: () => { stopped += 1 } })

    await expect(enabling).resolves.toBe(false)
    expect(stopped).toBe(1)
    expect(h.machine.snapshot()).toMatchObject({ state: HANDS_FREE_STATE.IDLE, enabled: false })
  })

  it('cleans VAD when wake detector startup rejects', async () => {
    let vadStops = 0
    const h = harness({
      vadStart: () => ({ stop: () => { vadStops += 1 } }),
      wakeStart: () => Promise.reject(new Error('kws load failed')),
    })

    await expect(h.machine.enable()).resolves.toBe(false)
    expect(vadStops).toBe(1)
    expect(h.lastArgs('onError')).toEqual(['wake-detector', new Error('kws load failed')])
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.IDLE)
  })

  it('reports a synchronous VAD startup failure without starting wake detection', async () => {
    let wakeStarts = 0
    const failure = new Error('vad init failed')
    const h = harness({
      vadStart: () => { throw failure },
      wakeStart: () => {
        wakeStarts += 1
        return { stop: () => undefined }
      },
    })

    await expect(h.machine.enable()).resolves.toBe(false)
    expect(wakeStarts).toBe(0)
    expect(h.lastArgs('onError')).toEqual(['vad-detector', failure])
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.IDLE)
  })

  it('re-arms when asynchronous recognizer startup rejects', async () => {
    const recognition = deferred<CommandRecognitionSession>()
    const failure = new Error('asr init failed')
    const h = harness({ recognitionStart: () => recognition.promise })
    await enable(h)
    h.wake()

    recognition.reject(failure)
    await Promise.resolve()
    expect(h.lastArgs('onError')).toEqual(['recognizer', failure])
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.ARMED)
  })

  it('reports live detector and recognizer errors at their interface boundary', async () => {
    const h = harness()
    await enable(h)
    h.vadError(new Error('vad died'))
    expect(h.lastArgs('onError')).toEqual(['vad-detector', new Error('vad died')])
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.IDLE)

    await enable(h)
    h.wake()
    h.recognizerError(new Error('asr died'))
    expect(h.lastArgs('onError')).toEqual(['recognizer', new Error('asr died')])
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.ARMED)
  })

  it('disable and dispose stop resources, clear timers, and ignore stale callbacks', async () => {
    const h = harness()
    await enable(h)
    h.wake()
    h.machine.disable()

    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.IDLE)
    expect(h.pendingTimers()).toBe(0)
    expect(h.wakeStops()).toBe(1)
    expect(h.vadStops()).toBe(1)
    expect(h.recognizerStops()).toBe(1)
    h.wake()
    h.speechStart()
    h.asrFinal('迟到')
    expect(h.countOf('submitCommand')).toBe(0)

    await enable(h)
    h.machine.dispose()
    h.machine.dispose()
    await expect(h.machine.enable()).resolves.toBe(false)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.IDLE)
  })

  it('cancels THINKING work but only stops playback when disabled during SPEAKING', async () => {
    const h = harness()
    await enable(h)
    const thinkingGeneration = submitOneTurn(h)
    h.machine.disable()
    expect(h.lastArgs('cancelTurn')).toEqual([thinkingGeneration])
    expect(h.countOf('stopSpeaking')).toBe(0)

    await enable(h)
    const speakingGeneration = submitOneTurn(h, '播放音乐')
    h.machine.ttsStarted(speakingGeneration)
    h.machine.disable()
    expect(h.lastArgs('stopSpeaking')).toEqual([speakingGeneration])
    expect(h.countOf('cancelTurn')).toBe(1)
  })

  it('honors injected timing configuration', async () => {
    const h = harness({ config: { falseWakeMs: 2_000, followUpMs: 3_000, bargeInMs: 400 } })
    await enable(h)
    h.wake()
    expect(h.pendingTimerMs()).toEqual([2_000])
    h.speechStart()
    h.asrFinal('查天气')
    const generation = h.machine.snapshot().activeTurnGeneration!
    h.machine.ttsStarted(generation)
    h.speechStart()
    expect(h.pendingTimerMs()).toEqual([400])
    h.speechEnd()
    h.machine.ttsEnded(generation)
    expect(h.pendingTimerMs()).toEqual([3_000])
  })
})

describe('hands-free default timing windows', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('uses a five-second false-wake timeout', async () => {
    const h = harness({ useDefaultTimers: true })
    await enable(h)
    h.wake()

    vi.advanceTimersByTime(4_999)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.LISTENING)
    vi.advanceTimersByTime(1)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.ARMED)
    expect(h.countOf('onFalseWake')).toBe(1)
  })

  it('keeps follow-up open for eight seconds', async () => {
    const h = harness({ useDefaultTimers: true })
    await enable(h)
    const generation = submitOneTurn(h)
    h.machine.turnEnded(generation)

    vi.advanceTimersByTime(7_999)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.FOLLOW_UP)
    vi.advanceTimersByTime(1)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.ARMED)
  })

  it('requires 300 milliseconds of continuous speech for barge-in', async () => {
    const h = harness({ useDefaultTimers: true })
    await enable(h)
    const generation = submitOneTurn(h)
    h.machine.ttsStarted(generation)
    h.speechStart()

    vi.advanceTimersByTime(299)
    expect(h.machine.snapshot().state).toBe(HANDS_FREE_STATE.SPEAKING)
    vi.advanceTimersByTime(1)
    expect(h.machine.snapshot()).toMatchObject({
      state: HANDS_FREE_STATE.LISTENING,
      listeningSource: 'barge-in',
    })
    expect(h.lastArgs('stopSpeaking')).toEqual([generation])
  })
})
