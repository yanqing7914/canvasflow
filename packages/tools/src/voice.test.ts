import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { voiceTranscriptionResponseSchema } from '@canvasflow/schema'
import {
  createVoiceProvider,
  loadVoiceFixtureManifest,
  voiceFixtureManifestSchema,
  type VoiceFixtureEntry,
} from './voice'

const fixtureDirectory = resolve(process.cwd(), 'fixtures/airport-pickup/voice')
const manifest = loadVoiceFixtureManifest()

function entry(fixtureId: string): VoiceFixtureEntry {
  const fixture = manifest.fixtures.find((candidate) => candidate.fixtureId === fixtureId)
  if (!fixture) throw new Error(`Missing voice fixture: ${fixtureId}`)
  return fixture
}

function audio(fixtureId: string): Uint8Array {
  return readFileSync(resolve(fixtureDirectory, entry(fixtureId).file))
}

function wavDurationMs(value: Uint8Array): number {
  const data = Buffer.from(value)
  const channels = data.readUInt16LE(22)
  const sampleRateHz = data.readUInt32LE(24)
  const bitsPerSample = data.readUInt16LE(34)
  const dataBytes = data.readUInt32LE(40)
  return Math.round((dataBytes / (channels * (bitsPerSample / 8) * sampleRateHz)) * 1000)
}

describe('voice fixture manifest', () => {
  it('validates every fixture and keeps ids, files, and hashes unique', () => {
    expect(voiceFixtureManifestSchema.parse(manifest)).toEqual(manifest)
    expect(new Set(manifest.fixtures.map((fixture) => fixture.fixtureId)).size).toBe(manifest.fixtures.length)
    expect(new Set(manifest.fixtures.map((fixture) => fixture.file)).size).toBe(manifest.fixtures.length)
    expect(new Set(manifest.fixtures.map((fixture) => fixture.sha256)).size).toBe(manifest.fixtures.length)
  })

  it('keeps successful partial sequences non-empty and ending at the final transcript', () => {
    for (const fixture of manifest.fixtures) {
      if (fixture.outcome.kind !== 'success') continue
      expect(fixture.outcome.partials.length, fixture.fixtureId).toBeGreaterThan(0)
      expect(fixture.outcome.partials.at(-1), fixture.fixtureId).toBe(fixture.outcome.transcript)
    }
  })

  it('matches every reviewed WAV by content hash and recorded duration', () => {
    for (const fixture of manifest.fixtures) {
      const value = audio(fixture.fixtureId)
      expect(createHash('sha256').update(value).digest('hex'), fixture.fixtureId).toBe(fixture.sha256)
      expect(wavDurationMs(value), fixture.fixtureId).toBe(fixture.durationMs)
    }
  })
})

describe('fixture voice provider', () => {
  it('returns deterministic high-confidence transcription for the clear sample', async () => {
    const provider = createVoiceProvider()
    const input = {
      audio: audio('clear-airport-pickup'),
      mimeType: 'audio/wav' as const,
      fixtureId: 'clear-airport-pickup',
    }
    const first = await provider.transcribe({ requestId: 'voice-1' }, input)
    const second = await provider.transcribe({ requestId: 'voice-2' }, input)

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      ok: true,
      result: {
        transcript: '接妈妈和豆豆，航班 MU5102',
        confidence: 0.96,
        provider: 'fixture',
        fixtureId: 'clear-airport-pickup',
      },
    })
    expect(() => voiceTranscriptionResponseSchema.parse(first)).not.toThrow()
  })

  it('can resolve a reviewed fixture by audio hash without trusting its filename', async () => {
    const result = await createVoiceProvider().transcribe(
      { requestId: 'voice-by-hash' },
      { audio: audio('missing-flight-number'), mimeType: 'audio/wav' },
    )
    expect(result).toMatchObject({
      ok: true,
      result: { fixtureId: 'missing-flight-number', transcript: '我现在要去机场接妈妈和豆豆' },
    })
  })

  it('returns low-confidence warnings for the noisy sample', async () => {
    const result = await createVoiceProvider().transcribe(
      { requestId: 'voice-noisy' },
      { audio: audio('noisy-airport-pickup'), mimeType: 'audio/wav', fixtureId: 'noisy-airport-pickup' },
    )
    expect(result).toMatchObject({
      ok: true,
      result: {
        confidence: 0.52,
        warnings: ['BACKGROUND_NOISE', 'LOW_CONFIDENCE'],
      },
    })
  })

  it.each([
    ['no-speech', 'NO_SPEECH_DETECTED', true],
    ['short-noise', 'NO_SPEECH_DETECTED', true],
    ['timeout', 'TRANSCRIPTION_TIMEOUT', true],
  ] as const)('replays %s as a stable error', async (fixtureId, code, retryable) => {
    const result = await createVoiceProvider().transcribe(
      { requestId: `voice-${fixtureId}` },
      { audio: audio(fixtureId), mimeType: 'audio/wav', fixtureId },
    )
    expect(result).toMatchObject({ ok: false, error: { code, retryable } })
  })

  it('rejects unknown, empty, mismatched, and unsupported audio', async () => {
    const provider = createVoiceProvider()
    await expect(provider.transcribe(
      { requestId: 'voice-empty' },
      { audio: new Uint8Array(), mimeType: 'audio/wav' },
    )).resolves.toMatchObject({ ok: false, error: { code: 'TRANSCRIPTION_FAILED' } })
    await expect(provider.transcribe(
      { requestId: 'voice-unknown' },
      { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
    )).resolves.toMatchObject({ ok: false, error: { code: 'TRANSCRIPTION_FAILED' } })
    await expect(provider.transcribe(
      { requestId: 'voice-mismatch' },
      { audio: audio('clear-airport-pickup'), mimeType: 'audio/wav', fixtureId: 'timeout' },
    )).resolves.toMatchObject({ ok: false, error: { code: 'TRANSCRIPTION_FAILED' } })
    await expect(provider.transcribe(
      { requestId: 'voice-format' },
      { audio: audio('clear-airport-pickup'), mimeType: 'audio/webm', fixtureId: 'clear-airport-pickup' },
    )).resolves.toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_AUDIO_FORMAT' } })
  })

  it('marks mock responses without changing deterministic fixture behavior', async () => {
    const result = await createVoiceProvider({ mode: 'mock' }).transcribe(
      { requestId: 'voice-mock' },
      { audio: audio('flight-number-spoken-digits'), mimeType: 'audio/wav' },
    )
    expect(result).toMatchObject({
      ok: true,
      result: {
        provider: 'mock',
        transcript: '接妈妈和豆豆，航班 MU5102',
        warnings: ['NORMALIZED_FLIGHT_NUMBER'],
      },
    })
  })

  it('replays every manifest entry deterministically', async () => {
    const provider = createVoiceProvider()
    for (const fixture of manifest.fixtures) {
      const input = {
        audio: audio(fixture.fixtureId),
        mimeType: fixture.mimeType,
        fixtureId: fixture.fixtureId,
      }
      const first = await provider.transcribe({ requestId: `${fixture.fixtureId}-1` }, input)
      const second = await provider.transcribe({ requestId: `${fixture.fixtureId}-2` }, input)
      expect(second, fixture.fixtureId).toEqual(first)
      if (fixture.outcome.kind === 'success') {
        expect(first, fixture.fixtureId).toMatchObject({
          ok: true,
          result: {
            transcript: fixture.outcome.transcript,
            confidence: fixture.outcome.confidence,
            warnings: fixture.outcome.warnings,
          },
        })
      } else {
        expect(first, fixture.fixtureId).toMatchObject({
          ok: false,
          error: {
            code: fixture.outcome.code,
            retryable: fixture.outcome.retryable,
          },
        })
      }
    }
  })
})
