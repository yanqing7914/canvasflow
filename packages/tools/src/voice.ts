import {
  providerModeSchema,
  voiceMimeTypeSchema,
  voiceTranscriptionResponseSchema,
  voiceWarningSchema,
  type ProviderMode,
  type VoiceMimeType,
  type VoiceTranscriptionResponse,
  type VoiceTranscriptionResult,
} from '@canvasflow/schema'
import { z } from 'zod'
import rawVoiceFixtureManifest from '../../../fixtures/airport-pickup/voice/manifest.json'

const voiceFixtureOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('success'),
    transcript: z.string().min(1),
    confidence: z.number().finite().min(0).max(1),
    language: z.string().min(1),
    warnings: z.array(voiceWarningSchema),
    partials: z.array(z.string().min(1)),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.enum(['NO_SPEECH_DETECTED', 'TRANSCRIPTION_TIMEOUT', 'TRANSCRIPTION_FAILED']),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
])

export const voiceFixtureEntrySchema = z.object({
  fixtureId: z.string().min(1),
  file: z.string().regex(/^[a-z0-9-]+\.wav$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.literal('audio/wav'),
  sampleRateHz: z.number().int().positive(),
  channels: z.literal(1),
  durationMs: z.number().int().positive(),
  model: z.literal('fixture-manifest-v1'),
  outcome: voiceFixtureOutcomeSchema,
})

export const voiceFixtureManifestSchema = z.object({
  version: z.literal('1.0'),
  generatedAt: z.iso.datetime({ offset: true }),
  fixtures: z.array(voiceFixtureEntrySchema).min(1),
})

export type VoiceFixtureEntry = z.infer<typeof voiceFixtureEntrySchema>
export type VoiceFixtureManifest = z.infer<typeof voiceFixtureManifestSchema>

export type VoiceTranscriptionInput = {
  audio: Uint8Array
  mimeType: VoiceMimeType
  language?: string
  fixtureId?: string
}

export type VoiceProviderContext = {
  requestId: string
}

export interface VoiceProvider {
  readonly mode: ProviderMode
  transcribe(context: VoiceProviderContext, input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResponse>
}

export type CreateVoiceProviderOptions = {
  mode?: Exclude<ProviderMode, 'live'>
  manifest?: VoiceFixtureManifest
}

export function loadVoiceFixtureManifest(raw: unknown = rawVoiceFixtureManifest): VoiceFixtureManifest {
  return voiceFixtureManifestSchema.parse(raw)
}

export function createVoiceProvider(options: CreateVoiceProviderOptions = {}): VoiceProvider {
  const mode = providerModeSchema.parse(options.mode ?? 'fixture') as Exclude<ProviderMode, 'live'>
  const manifest = options.manifest ?? loadVoiceFixtureManifest()
  const byId = new Map(manifest.fixtures.map((entry) => [entry.fixtureId, entry]))
  const byHash = new Map(manifest.fixtures.map((entry) => [entry.sha256, entry]))

  return {
    mode,
    async transcribe(_context, input) {
      const mimeType = voiceMimeTypeSchema.safeParse(input.mimeType)
      if (!mimeType.success) {
        return failure('UNSUPPORTED_AUDIO_FORMAT', `不支持的音频格式：${String(input.mimeType)}`, false)
      }
      if (input.audio.byteLength === 0) {
        return failure('TRANSCRIPTION_FAILED', '音频内容为空', false)
      }

      const digest = await sha256(input.audio)
      const fixture = input.fixtureId ? byId.get(input.fixtureId) : byHash.get(digest)
      if (!fixture) {
        return failure('TRANSCRIPTION_FAILED', '音频不在已审核的 Fixture 清单中', false)
      }
      if (fixture.sha256 !== digest) {
        return failure('TRANSCRIPTION_FAILED', `Fixture ${fixture.fixtureId} 的音频摘要不匹配`, false)
      }
      if (fixture.mimeType !== mimeType.data) {
        return failure('UNSUPPORTED_AUDIO_FORMAT', `Fixture ${fixture.fixtureId} 需要 ${fixture.mimeType}`, false)
      }

      if (fixture.outcome.kind === 'error') {
        return failure(
          fixture.outcome.code,
          fixture.outcome.message,
          fixture.outcome.retryable,
        )
      }

      const result: VoiceTranscriptionResult = {
        audioId: `audio-${fixture.fixtureId}-${fixture.sha256.slice(0, 12)}`,
        transcript: fixture.outcome.transcript,
        confidence: fixture.outcome.confidence,
        language: input.language ?? fixture.outcome.language,
        durationMs: fixture.durationMs,
        provider: mode,
        model: fixture.model,
        fixtureId: fixture.fixtureId,
        warnings: fixture.outcome.warnings,
      }
      return voiceTranscriptionResponseSchema.parse({ ok: true, result, error: null })
    },
  }
}

function failure(
  code: 'NO_SPEECH_DETECTED' | 'TRANSCRIPTION_TIMEOUT' | 'TRANSCRIPTION_FAILED' | 'UNSUPPORTED_AUDIO_FORMAT',
  message: string,
  retryable: boolean,
): VoiceTranscriptionResponse {
  return voiceTranscriptionResponseSchema.parse({
    ok: false,
    result: null,
    error: { code, message, retryable },
  })
}

async function sha256(value: Uint8Array): Promise<string> {
  const source = Uint8Array.from(value)
  const digest = await crypto.subtle.digest('SHA-256', source)
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')
}
