import { z } from 'zod'
import { providerModeSchema } from './tool'

export const voiceMimeTypeSchema = z.enum([
  'audio/wav',
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/mpeg',
])

export const voiceErrorCodeSchema = z.enum([
  'VOICE_PERMISSION_DENIED',
  'AUDIO_TOO_SHORT',
  'AUDIO_TOO_LONG',
  'UNSUPPORTED_AUDIO_FORMAT',
  'NO_SPEECH_DETECTED',
  'TRANSCRIPTION_FAILED',
  'TRANSCRIPTION_TIMEOUT',
  'LOW_CONFIDENCE',
  'STREAM_DISCONNECTED',
  'TTS_FAILED',
  'TTS_TIMEOUT',
  'PLAYBACK_FAILED',
])

export const voiceWarningSchema = z.enum([
  'BACKGROUND_NOISE',
  'LOW_CONFIDENCE',
  'POSSIBLE_TRUNCATION',
  'NORMALIZED_FLIGHT_NUMBER',
])

export const voiceTranscriptionResultSchema = z.object({
  audioId: z.string().min(1),
  transcript: z.string(),
  confidence: z.number().finite().min(0).max(1),
  language: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  provider: providerModeSchema,
  model: z.string().min(1),
  fixtureId: z.string().min(1).optional(),
  warnings: z.array(voiceWarningSchema),
})

export const voiceTranscriptionErrorSchema = z.object({
  code: voiceErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
})

export const voiceTranscriptionResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    result: voiceTranscriptionResultSchema,
    error: z.null(),
  }),
  z.object({
    ok: z.literal(false),
    result: z.null(),
    error: voiceTranscriptionErrorSchema,
  }),
])

export const voiceFixtureTranscriptionRequestSchema = z.object({
  fixtureId: z.string().min(1),
  language: z.string().min(1).optional(),
})

export const voiceTranscriptionMetadataSchema = z.object({
  fixtureId: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
})

export const voiceTranscriptionHttpResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    requestId: z.string().min(1),
    ok: z.literal(true),
    result: voiceTranscriptionResultSchema,
    error: z.null(),
  }),
  z.object({
    requestId: z.string().min(1),
    ok: z.literal(false),
    result: z.null(),
    error: voiceTranscriptionErrorSchema,
  }),
])

const voiceStreamBaseSchema = z.object({
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
})

export const voiceTranscriptionStreamEventSchema = z.discriminatedUnion('type', [
  voiceStreamBaseSchema.extend({ type: z.literal('started') }),
  voiceStreamBaseSchema.extend({
    type: z.literal('partial'),
    transcript: z.string().min(1),
  }),
  voiceStreamBaseSchema.extend({
    type: z.literal('final'),
    result: voiceTranscriptionResultSchema,
  }),
  voiceStreamBaseSchema.extend({
    type: z.literal('error'),
    error: voiceTranscriptionErrorSchema,
  }),
  voiceStreamBaseSchema.extend({ type: z.literal('closed') }),
])

export type VoiceMimeType = z.infer<typeof voiceMimeTypeSchema>
export type VoiceErrorCode = z.infer<typeof voiceErrorCodeSchema>
export type VoiceWarning = z.infer<typeof voiceWarningSchema>
export type VoiceTranscriptionResult = z.infer<typeof voiceTranscriptionResultSchema>
export type VoiceTranscriptionError = z.infer<typeof voiceTranscriptionErrorSchema>
export type VoiceTranscriptionResponse = z.infer<typeof voiceTranscriptionResponseSchema>
export type VoiceFixtureTranscriptionRequest = z.infer<typeof voiceFixtureTranscriptionRequestSchema>
export type VoiceTranscriptionMetadata = z.infer<typeof voiceTranscriptionMetadataSchema>
export type VoiceTranscriptionHttpResponse = z.infer<typeof voiceTranscriptionHttpResponseSchema>
export type VoiceTranscriptionStreamEvent = z.infer<typeof voiceTranscriptionStreamEventSchema>
