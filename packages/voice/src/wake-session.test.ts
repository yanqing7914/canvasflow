import { describe, expect, it } from 'vitest'
import { createWakeSession } from './wake-session'

function harness() {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const scheduledMs: number[] = []
  let timer: (() => void) | undefined
  const session = createWakeSession({
    setTimer: (fn, ms) => { timer = fn; scheduledMs.push(ms); return 1 },
    clearTimer: () => { timer = undefined },
    effects: {
      requestRecognition: () => calls.push({ name: 'requestRecognition', args: [] }),
      stopSpeaking: () => calls.push({ name: 'stopSpeaking', args: [] }),
      speak: (text) => calls.push({ name: 'speak', args: [text] }),
      submit: (...args) => calls.push({ name: 'submit', args }),
      reset: () => calls.push({ name: 'reset', args: [] }),
      resetCancelled: (reason) => calls.push({ name: 'resetCancelled', args: [reason] }),
      onTimeout: (kind) => calls.push({ name: 'onTimeout', args: [kind] }),
    },
  })
  return { session, calls, scheduledMs, fireTimer: () => timer?.() }
}

describe('wake session', () => {
  it('requires native recognition onstart before waiting for a wake word', () => {
    const h = harness()
    expect(h.session.snapshot().state).toBe('needs-authorization')
    h.session.recognitionStarted()
    expect(h.session.snapshot().state).toBe('needs-authorization')
    h.session.authorize()
    h.session.authorize()
    expect(h.session.snapshot().state).toBe('authorizing')
    expect(h.calls.map((call) => call.name)).toEqual(['requestRecognition'])
    h.session.recognitionStarted()
    expect(h.session.snapshot().state).toBe('waiting-wake')
  })

  it('re-arms authorization when continuous recognition fails after it was live', () => {
    const h = harness()
    h.session.authorize()
    h.session.recognitionStarted()
    h.session.receive('小南')
    expect(h.session.snapshot().state).toBe('follow-up')

    h.session.recognitionFailed()

    expect(h.session.snapshot()).toEqual({ state: 'needs-authorization', speaking: false })
    expect(h.calls).toContainEqual({ name: 'stopSpeaking', args: [] })
    h.session.authorize()
    expect(h.calls.at(-1)).toEqual({ name: 'requestRecognition', args: [] })
  })

  it('ignores ordinary speech and submits same-utterance commands', () => {
    const h = harness()
    h.session.authorize()
    h.session.recognitionStarted()
    h.session.receive('我今天想去机场')
    expect(h.calls.some((call) => call.name === 'submit')).toBe(false)
    h.session.receive('小南，我要去机场接人')
    expect(h.calls.at(-1)?.name).toBe('submit')
    expect(h.calls.at(-1)?.args[0]).toBe('我要去机场接人')
    expect(h.session.snapshot().state).toBe('waiting-wake')
  })

  it('preserves ASR confidence on submitted wake commands', () => {
    const h = harness()
    h.session.authorize()
    h.session.recognitionStarted()

    h.session.receive('小南，我要去机场接人', { recognitionSource: 'microphone', confidence: 0.51 })

    expect(h.calls).toContainEqual({
      name: 'submit',
      args: ['我要去机场接人', { source: 'voice', recognitionSource: 'microphone', confidence: 0.51 }],
    })
  })

  it('opens one five-second follow-up after a wake-only utterance', () => {
    const h = harness()
    h.session.authorize()
    h.session.recognitionStarted()
    h.session.receive('小南')
    expect(h.session.snapshot().state).toBe('follow-up')
    expect(h.calls).toContainEqual({ name: 'speak', args: ['我在'] })
    h.session.receive('查天气', { recognitionSource: 'microphone', confidence: 0.62 })
    expect(h.scheduledMs).toEqual([5_000])
    expect(h.calls.at(-1)?.name).toBe('submit')
    expect(h.calls.at(-1)?.args).toEqual([
      '查天气',
      { source: 'voice', recognitionSource: 'microphone', confidence: 0.62 },
    ])
    expect(h.session.snapshot().state).toBe('waiting-wake')
  })

  it('returns to waiting wake after follow-up timeout', () => {
    const h = harness()
    h.session.authorize()
    h.session.recognitionStarted()
    h.session.receive('小南')
    h.fireTimer()
    expect(h.session.snapshot().state).toBe('waiting-wake')
    expect(h.calls.at(-1)).toMatchObject({ name: 'onTimeout', args: ['follow-up'] })
  })

  it('requires explicit reset confirmation and supports confirm/cancel/timeout', () => {
    const h = harness()
    h.session.authorize()
    h.session.recognitionStarted()
    h.session.receive('小南，重新开始')
    expect(h.session.snapshot().state).toBe('reset-confirmation')
    expect(h.calls).toContainEqual({ name: 'speak', args: ['当前任务还没有完成，确定要重新开始吗？'] })
    h.session.receive('确定')
    expect(h.calls.at(-1)?.name).toBe('reset')
    expect(h.session.snapshot().state).toBe('waiting-wake')

    h.session.receive('小南，重新开始')
    const stopsBeforeCancel = h.calls.filter((call) => call.name === 'stopSpeaking').length
    h.session.receive('小南，取消')
    expect(h.calls.at(-1)).toMatchObject({ name: 'resetCancelled', args: ['cancelled'] })
    expect(h.calls.filter((call) => call.name === 'stopSpeaking')).toHaveLength(stopsBeforeCancel + 1)
    expect(h.session.snapshot()).toEqual({ state: 'waiting-wake', speaking: false })

    h.session.receive('小南，重新开始')
    h.fireTimer()
    expect(h.session.snapshot().state).toBe('waiting-wake')
    expect(h.calls).toContainEqual({ name: 'resetCancelled', args: ['timeout'] })
    expect(h.calls.at(-1)).toMatchObject({ name: 'onTimeout', args: ['reset-confirmation'] })
  })

  it('drops trusted system TTS and stops playback on a real wake', () => {
    const h = harness()
    h.session.authorize()
    h.session.recognitionStarted()
    h.session.receive('小南，重新开始', { recognitionSource: 'system-tts' })
    expect(h.session.snapshot().state).toBe('waiting-wake')
    h.session.setSpeaking(true)
    h.session.receive('小南，查天气', { recognitionSource: 'microphone' })
    expect(h.calls.at(-2)).toMatchObject({ name: 'stopSpeaking' })
    expect(h.calls.at(-1)?.name).toBe('submit')
    expect(h.calls.at(-1)?.args).toEqual([
      '查天气',
      { source: 'voice', recognitionSource: 'microphone' },
    ])
  })
})
