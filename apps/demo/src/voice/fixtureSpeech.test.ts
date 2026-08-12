import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import transcripts from '../../../../fixtures/airport-pickup/voice/transcripts.json'
import {
  createFixtureRecognition,
  playFixtureSampleAudio,
  voiceFixtureSamples,
  type FixtureAudioLike,
  type VoiceFixtureSample,
} from './fixtureSpeech'

class FakeFixtureAudio implements FixtureAudioLike {
  played = 0
  paused = 0
  playRejects = false
  onended: (() => void) | null = null
  onerror: (() => void) | null = null

  play() {
    this.played += 1
    return this.playRejects ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve()
  }

  pause() { this.paused += 1 }

  end() { this.onended?.() }
}

const sample: VoiceFixtureSample = {
  id: 'create-airport-pickup',
  text: '我现在要去机场接妈妈和豆豆',
  confidence: 0.96,
  requiresConfirmation: false,
  label: '接机指令',
  audioUrl: '/voice/create-airport-pickup.wav',
}

type Callbacks = {
  partials: string[]
  finals: Array<{ transcript: string; confidence?: number }>
  ended: number
}

function wire(engine: ReturnType<typeof createFixtureRecognition>): Callbacks {
  const seen: Callbacks = { partials: [], finals: [], ended: 0 }
  engine.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]
      if (!result) continue
      const alternative = result[0]
      if (!alternative) continue
      if (result.isFinal) seen.finals.push({ transcript: alternative.transcript, confidence: alternative.confidence })
      else seen.partials.push(alternative.transcript)
    }
  }
  engine.onend = () => { seen.ended += 1 }
  return seen
}

const microtasks = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
const voiceFixtureDirectory = resolve(process.cwd(), 'fixtures/airport-pickup/voice')

function readWavHeader(file: string) {
  const data = readFileSync(resolve(voiceFixtureDirectory, file))
  expect(data.subarray(0, 4).toString('ascii'), file).toBe('RIFF')
  expect(data.subarray(8, 12).toString('ascii'), file).toBe('WAVE')
  expect(data.subarray(12, 16).toString('ascii'), file).toBe('fmt ')
  return {
    audioFormat: data.readUInt16LE(20),
    channels: data.readUInt16LE(22),
    sampleRateHz: data.readUInt32LE(24),
    bitsPerSample: data.readUInt16LE(34),
  }
}

describe('voiceFixtureSamples', () => {
  it('exposes every catalog sample with presentation and availability copy', () => {
    expect(voiceFixtureSamples).toHaveLength(transcripts.samples.length)
    expect(voiceFixtureSamples.map((entry) => entry.id)).toEqual(transcripts.samples.map((entry) => entry.id))
    expect(new Set(transcripts.samples.map((entry) => entry.id)).size).toBe(transcripts.samples.length)
    expect(new Set(transcripts.samples.map((entry) => entry.file)).size).toBe(transcripts.samples.length)

    for (const [index, entry] of voiceFixtureSamples.entries()) {
      const catalogEntry = transcripts.samples[index]
      expect(catalogEntry).toBeDefined()
      expect(entry).toMatchObject({
        id: catalogEntry?.id,
        text: catalogEntry?.text,
        confidence: catalogEntry?.confidence,
        requiresConfirmation: catalogEntry?.requiresConfirmation,
      })
      expect(entry.label).not.toBe('')
      expect(entry.audioUrl).not.toBe('')
      expect(entry.text).not.toBe('')
      expect(entry.unavailableHint).not.toBe('')
    }
    // The noise-augmented sample is the one that exercises the confirmation
    // rule; losing the flag would let a refactor auto-submit it unnoticed.
    expect(voiceFixtureSamples.find((entry) => entry.id === 'noisy-create')?.requiresConfirmation).toBe(true)
  })

  it('ships exactly the catalog WAVs as 16 kHz mono PCM', () => {
    const catalogFiles = transcripts.samples.map((entry) => entry.file).sort()
    const shippedFiles = readdirSync(voiceFixtureDirectory)
      .filter((file) => extname(file) === '.wav')
      .sort()

    expect(shippedFiles).toEqual(catalogFiles)
    for (const file of catalogFiles) {
      expect(readWavHeader(file)).toEqual({
        audioFormat: 1,
        channels: transcripts.channels,
        sampleRateHz: transcripts.sampleRateHz,
        bitsPerSample: 16,
      })
    }
  })
})

describe('createFixtureRecognition', () => {
  it('plays the recording, then delivers interim words and a confident final', async () => {
    const audio = new FakeFixtureAudio()
    const engine = createFixtureRecognition(sample, () => audio)
    const seen = wire(engine)

    engine.start()
    await microtasks()
    expect(audio.played).toBe(1)
    expect(seen.partials).toEqual([sample.text])
    expect(seen.finals).toEqual([])

    audio.end()
    expect(seen.finals).toEqual([{ transcript: sample.text, confidence: sample.confidence }])
    expect(seen.ended).toBe(1)
  })

  it('still delivers the transcript when playback cannot start', async () => {
    const audio = new FakeFixtureAudio()
    audio.playRejects = true
    const engine = createFixtureRecognition(sample, () => audio)
    const seen = wire(engine)

    engine.start()
    await microtasks()
    // The recording is presentation; the transcript is the payload.
    expect(seen.finals).toEqual([{ transcript: sample.text, confidence: sample.confidence }])
    expect(seen.ended).toBe(1)
  })

  it('delivers the transcript when no audio element is available at all', async () => {
    const engine = createFixtureRecognition(sample, () => null)
    const seen = wire(engine)

    engine.start()
    await microtasks()
    expect(seen.finals).toEqual([{ transcript: sample.text, confidence: sample.confidence }])
    expect(seen.ended).toBe(1)
  })

  it('never delivers twice, and an aborted turn silences the recording', async () => {
    const audio = new FakeFixtureAudio()
    const engine = createFixtureRecognition(sample, () => audio)
    const seen = wire(engine)

    engine.start()
    await microtasks()
    engine.abort?.()
    expect(audio.paused).toBe(1)

    // Late engine callbacks must find the turn already settled.
    audio.end()
    expect(seen.finals).toEqual([])
    expect(seen.ended).toBe(0)
  })
})

describe('playFixtureSampleAudio', () => {
  it('plays the sample and settles once when playback fails', async () => {
    const audio = new FakeFixtureAudio()
    audio.playRejects = true
    const settled = vi.fn()
    expect(playFixtureSampleAudio(sample, () => audio, settled)).toBe(audio)
    expect(audio.played).toBe(1)
    await microtasks()
    expect(settled).toHaveBeenCalledOnce()
    audio.onerror?.()
    audio.onended?.()
    expect(settled).toHaveBeenCalledOnce()
  })

  it('settles immediately when the factory yields no element', () => {
    const factory = vi.fn().mockReturnValue(null)
    const settled = vi.fn()
    expect(playFixtureSampleAudio(sample, factory, settled)).toBeNull()
    expect(factory).toHaveBeenCalledWith(sample.audioUrl)
    expect(settled).toHaveBeenCalledOnce()
  })
})
