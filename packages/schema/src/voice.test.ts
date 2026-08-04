import { describe, expect, it } from 'vitest'
import {
  voiceErrorCodeSchema,
  voiceTranscriptionResponseSchema,
  voiceTranscriptionHttpResponseSchema,
  voiceTranscriptionResultSchema,
  voiceTranscriptionStreamEventSchema,
} from './voice'

const result = {
  audioId: 'audio-clear-airport-pickup',
  transcript: '接妈妈和豆豆，航班 MU5102',
  confidence: 0.96,
  language: 'zh-CN',
  durationMs: 2300,
  provider: 'fixture' as const,
  model: 'fixture-manifest-v1',
  fixtureId: 'clear-airport-pickup',
  warnings: [],
}

describe('voice schemas', () => {
  it('validates deterministic transcription results', () => {
    expect(voiceTranscriptionResultSchema.parse(result)).toEqual(result)
    expect(voiceTranscriptionResponseSchema.parse({ ok: true, result, error: null })).toEqual({
      ok: true,
      result,
      error: null,
    })
  })

  it('rejects empty audio ids and invalid confidence values', () => {
    expect(voiceTranscriptionResultSchema.safeParse({ ...result, audioId: '' }).success).toBe(false)
    expect(voiceTranscriptionResultSchema.safeParse({ ...result, confidence: -0.01 }).success).toBe(false)
    expect(voiceTranscriptionResultSchema.safeParse({ ...result, confidence: 1.01 }).success).toBe(false)
    expect(voiceTranscriptionResultSchema.safeParse({ ...result, confidence: Number.NaN }).success).toBe(false)
  })

  it('validates ordered stream events and rejects empty partials', () => {
    expect(voiceTranscriptionStreamEventSchema.parse({
      type: 'partial',
      sessionId: 'voice-session-1',
      sequence: 1,
      transcript: '接妈妈',
    })).toMatchObject({ type: 'partial', sequence: 1 })
    expect(voiceTranscriptionStreamEventSchema.safeParse({
      type: 'partial',
      sessionId: 'voice-session-1',
      sequence: 2,
      transcript: '',
    }).success).toBe(false)
  })

  it('keeps failure envelopes distinct from successful results', () => {
    expect(voiceTranscriptionResponseSchema.parse({
      ok: false,
      result: null,
      error: {
        code: 'NO_SPEECH_DETECTED',
        message: '没有检测到可识别的人声',
        retryable: true,
      },
    })).toMatchObject({ ok: false, error: { code: 'NO_SPEECH_DETECTED' } })
  })

  it('keeps transcription, TTS, and playback failures in one stable code set', () => {
    expect(voiceErrorCodeSchema.options).toEqual(expect.arrayContaining([
      'TRANSCRIPTION_FAILED',
      'TRANSCRIPTION_TIMEOUT',
      'TTS_FAILED',
      'TTS_TIMEOUT',
      'PLAYBACK_FAILED',
    ]))
  })

  it('requires request ids on HTTP response envelopes', () => {
    expect(voiceTranscriptionHttpResponseSchema.parse({
      requestId: 'voice-http-1',
      ok: true,
      result,
      error: null,
    })).toMatchObject({ requestId: 'voice-http-1', ok: true })
    expect(voiceTranscriptionHttpResponseSchema.safeParse({ ok: true, result, error: null }).success).toBe(false)
  })
})
