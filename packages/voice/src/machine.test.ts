import { describe, expect, it } from 'vitest'
import { createVoiceMachine, type VoiceMachineDeps } from './machine'
import type { VoiceState } from './types'

type Call = { name: string; args: unknown[] }

/** A machine wired to recorded effects and a manually driven clock. */
function harness(config?: VoiceMachineDeps['config']) {
  const calls: Call[] = []
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }) }
  const states: VoiceState[] = []
  let nextHandle = 1
  const timers = new Map<number, () => void>()

  const machine = createVoiceMachine({
    config,
    setTimer: (fn) => {
      const handle = nextHandle
      nextHandle += 1
      timers.set(handle, fn)
      return handle
    },
    clearTimer: (handle) => { timers.delete(handle as number) },
    effects: {
      onState: (state) => { states.push(state) },
      openAsr: record('openAsr'),
      closeAsr: record('closeAsr'),
      submit: record('submit'),
      speak: record('speak'),
      stopSpeak: record('stopSpeak'),
      onError: record('onError'),
    },
  })

  return {
    machine,
    states,
    calls,
    names: () => calls.map((call) => call.name),
    countOf: (name: string) => calls.filter((call) => call.name === name).length,
    lastArgs: (name: string) => calls.filter((call) => call.name === name).at(-1)?.args,
    /** Fires every pending timer, newest first, like a run-to-completion flush. */
    fireTimers: () => {
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, fn] of pending) fn()
    },
    pendingTimerCount: () => timers.size,
  }
}

describe('voice machine — happy path', () => {
  it('walks idle → listening → transcribing → submitting → speaking → idle', () => {
    const h = harness()
    expect(h.machine.snapshot().state).toBe('idle')

    h.machine.press()
    expect(h.machine.snapshot().state).toBe('listening')
    expect(h.countOf('openAsr')).toBe(1)

    h.machine.asrPartial('去机场')
    expect(h.machine.snapshot().display).toBe('去机场')

    h.machine.asrFinal('去机场接妈妈和豆豆', 0.92)
    const afterFinal = h.machine.snapshot()
    expect(afterFinal.state).toBe('transcribing')
    expect(afterFinal.transcript).toBe('去机场接妈妈和豆豆')
    expect(afterFinal.interim).toBe('')
    expect(afterFinal.confidence).toBe(0.92)
    expect(h.countOf('closeAsr')).toBe(1)

    h.machine.submit()
    expect(h.machine.snapshot().state).toBe('submitting')
    expect(h.lastArgs('submit')).toEqual([
      '去机场接妈妈和豆豆',
      { source: 'voice', confidence: 0.92 },
    ])

    h.machine.submitDone('好的，请告诉我她们的航班号。')
    expect(h.machine.snapshot().state).toBe('speaking')
    expect(h.machine.snapshot().speaking).toBe('好的，请告诉我她们的航班号。')
    expect(h.lastArgs('speak')).toEqual(['好的，请告诉我她们的航班号。'])

    h.machine.speakEnd()
    expect(h.machine.snapshot().state).toBe('idle')
    expect(h.states).toEqual(['listening', 'transcribing', 'submitting', 'speaking', 'idle'])
  })

  it('returns straight to idle when there is nothing to speak', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('MU5102')
    h.machine.submit()
    h.machine.submitDone()
    expect(h.machine.snapshot().state).toBe('idle')
    expect(h.countOf('speak')).toBe(0)
  })

  it('leaves no timers pending after a completed turn', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('MU5102')
    h.machine.submit()
    h.machine.submitDone()
    expect(h.pendingTimerCount()).toBe(0)
  })
})

describe('voice machine — transcript editing', () => {
  it('submits the edited text and drops the engine confidence', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('MU 5102', 0.4)
    h.machine.edit('MU5102')
    expect(h.machine.snapshot().confidence).toBeUndefined()

    h.machine.submit()
    expect(h.lastArgs('submit')).toEqual(['MU5102', { source: 'voice', confidence: undefined }])
  })

  it('accepts an inline override at submit time', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('MU 5102')
    h.machine.submit('MU5102')
    expect(h.lastArgs('submit')?.[0]).toBe('MU5102')
  })

  it('ignores a blank submit instead of sending empty text', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('MU5102')
    h.machine.submit('   ')
    expect(h.countOf('submit')).toBe(0)
    expect(h.machine.snapshot().state).toBe('transcribing')
  })

  it('ignores edits outside the transcribing state', () => {
    const h = harness()
    h.machine.edit('偷偷改')
    expect(h.machine.snapshot().transcript).toBe('')
  })
})

describe('voice machine — barge-in and cancel', () => {
  it('cuts playback and starts a new turn on press while speaking', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.machine.submit()
    h.machine.submitDone('好的。')
    expect(h.machine.snapshot().state).toBe('speaking')

    h.machine.press()
    expect(h.machine.snapshot().state).toBe('listening')
    expect(h.countOf('stopSpeak')).toBe(1)
    expect(h.countOf('openAsr')).toBe(2)
    expect(h.machine.snapshot().speaking).toBeUndefined()
  })

  it('ignores a stale speakEnd arriving after a barge-in', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.machine.submit()
    h.machine.submitDone('好的。')
    h.machine.press()

    h.machine.speakEnd()
    expect(h.machine.snapshot().state).toBe('listening')
  })

  it('ends the listening turn on a second press, keeping what was heard', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrPartial('先检查是否需要补能')
    h.machine.press()
    expect(h.machine.snapshot().state).toBe('transcribing')
    expect(h.machine.snapshot().transcript).toBe('先检查是否需要补能')
    expect(h.countOf('closeAsr')).toBe(1)
  })

  it('reports no-speech when a second press finds nothing heard', () => {
    const h = harness()
    h.machine.press()
    h.machine.press()
    expect(h.machine.snapshot().state).toBe('error')
    expect(h.machine.snapshot().error?.kind).toBe('no-speech')
  })

  it('cancel drops the transcript and returns to idle', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.machine.cancel()
    const snapshot = h.machine.snapshot()
    expect(snapshot.state).toBe('idle')
    expect(snapshot.transcript).toBe('')
    expect(h.countOf('submit')).toBe(0)
  })

  it('cancel while listening closes the engine', () => {
    const h = harness()
    h.machine.press()
    h.machine.cancel()
    expect(h.countOf('closeAsr')).toBe(1)
    expect(h.machine.snapshot().state).toBe('idle')
  })

  it('cancel while speaking stops playback', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.machine.submit()
    h.machine.submitDone('好的。')
    h.machine.cancel()
    expect(h.countOf('stopSpeak')).toBe(1)
    expect(h.machine.snapshot().state).toBe('idle')
  })

  it('press during submitting is ignored so a request cannot be raced', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.machine.submit()
    h.machine.press()
    expect(h.machine.snapshot().state).toBe('submitting')
    expect(h.countOf('openAsr')).toBe(1)
  })
})

describe('voice machine — errors', () => {
  it('maps a permission failure to the error state with fallback copy', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrError('permission')
    const snapshot = h.machine.snapshot()
    expect(snapshot.state).toBe('error')
    expect(snapshot.error?.kind).toBe('permission')
    expect(snapshot.error?.suggestTextFallback).toBe(true)
    expect(snapshot.error?.retryable).toBe(true)
    expect(h.countOf('closeAsr')).toBe(1)
  })

  it('recovers from error on the next press', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrError('recognition')
    h.machine.press()
    expect(h.machine.snapshot().state).toBe('listening')
    expect(h.machine.snapshot().error).toBeUndefined()
  })

  it('reset dismisses the error without opening the microphone', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrError('recognition')
    h.machine.reset()
    expect(h.machine.snapshot().state).toBe('idle')
    expect(h.machine.snapshot().error).toBeUndefined()
    expect(h.countOf('openAsr')).toBe(1)
  })

  it('surfaces capability failures as non-retryable errors', () => {
    const h = harness()
    h.machine.unavailable('unsupported')
    const snapshot = h.machine.snapshot()
    expect(snapshot.state).toBe('error')
    expect(snapshot.error?.retryable).toBe(false)
    expect(snapshot.error?.suggestTextFallback).toBe(true)
  })

  it('treats an empty engine close as no-speech', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrEnd()
    expect(h.machine.snapshot().error?.kind).toBe('no-speech')
  })

  it('promotes a partial to a transcript when the engine closes early', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrPartial('先检查是否需要补能')
    h.machine.asrEnd()
    expect(h.machine.snapshot().state).toBe('transcribing')
    expect(h.machine.snapshot().transcript).toBe('先检查是否需要补能')
  })

  it('rejects punctuation-only results as no-speech', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('。')
    expect(h.machine.snapshot().error?.kind).toBe('no-speech')
  })

  it('reports a speak failure without losing the loop', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.machine.submit()
    h.machine.submitDone('好的。')
    h.machine.speakError()
    expect(h.machine.snapshot().error?.kind).toBe('speak')
    h.machine.press()
    expect(h.machine.snapshot().state).toBe('listening')
  })
})

describe('voice machine — timeout backstops', () => {
  it('times out a listening turn that never finalizes', () => {
    const h = harness({ listenMaxMs: 100 })
    h.machine.press()
    h.fireTimers()
    expect(h.machine.snapshot().state).toBe('error')
    expect(h.machine.snapshot().error?.kind).toBe('timeout')
    expect(h.countOf('closeAsr')).toBe(1)
  })

  it('times out a submit that never resolves', () => {
    const h = harness({ submitMaxMs: 100 })
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.machine.submit()
    h.fireTimers()
    expect(h.machine.snapshot().state).toBe('error')
    expect(h.machine.snapshot().error?.kind).toBe('timeout')
  })

  it('clears the listen timer once the turn finalizes', () => {
    const h = harness({ listenMaxMs: 100 })
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.fireTimers()
    expect(h.machine.snapshot().state).toBe('transcribing')
  })

  it('ignores a late submitDone after a submit timeout', () => {
    const h = harness({ submitMaxMs: 100 })
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.machine.submit()
    h.fireTimers()
    h.machine.submitDone('好的。')
    expect(h.machine.snapshot().state).toBe('error')
    expect(h.countOf('speak')).toBe(0)
  })
})

describe('voice machine — stale engine callbacks', () => {
  it('ignores partial and final results once the turn ended', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('MU5102')
    h.machine.asrPartial('迟到的分片')
    h.machine.asrFinal('迟到的结果')
    expect(h.machine.snapshot().transcript).toBe('MU5102')
  })

  it('ignores an engine error raised after the turn ended', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('MU5102')
    h.machine.asrError('recognition')
    expect(h.machine.snapshot().state).toBe('transcribing')
  })
})

describe('voice machine — dispose', () => {
  it('releases the microphone when disposed mid-turn', () => {
    const h = harness()
    h.machine.press()
    h.machine.dispose()
    expect(h.countOf('closeAsr')).toBe(1)
    expect(h.pendingTimerCount()).toBe(0)
  })

  it('stops playback when disposed while speaking', () => {
    const h = harness()
    h.machine.press()
    h.machine.asrFinal('去机场接妈妈')
    h.machine.submit()
    h.machine.submitDone('好的。')
    h.machine.dispose()
    expect(h.countOf('stopSpeak')).toBe(1)
  })
})
