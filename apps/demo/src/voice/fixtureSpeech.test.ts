import { describe, expect, it, vi } from 'vitest'
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

describe('voiceFixtureSamples', () => {
  it('exposes every sample from transcripts.json with a label and an audio URL', () => {
    expect(voiceFixtureSamples.map((entry) => entry.id))
      .toEqual(['create-airport-pickup', 'flight-number', 'noisy-create'])
    for (const entry of voiceFixtureSamples) {
      expect(entry.label).not.toBe('')
      expect(entry.audioUrl).not.toBe('')
      expect(entry.text).not.toBe('')
    }
    // The noise-augmented sample is the one that exercises the confirmation
    // rule; losing the flag would let a refactor auto-submit it unnoticed.
    expect(voiceFixtureSamples.find((entry) => entry.id === 'noisy-create')?.requiresConfirmation).toBe(true)
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
  it('plays the sample and swallows playback failures', () => {
    const audio = new FakeFixtureAudio()
    audio.playRejects = true
    expect(() => playFixtureSampleAudio(sample, () => audio)).not.toThrow()
    expect(audio.played).toBe(1)
  })

  it('does nothing when the factory yields no element', () => {
    const factory = vi.fn().mockReturnValue(null)
    expect(() => playFixtureSampleAudio(sample, factory)).not.toThrow()
    expect(factory).toHaveBeenCalledWith(sample.audioUrl)
  })
})
