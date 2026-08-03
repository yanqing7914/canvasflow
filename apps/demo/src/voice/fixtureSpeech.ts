import type { SpeechRecognitionLike } from '@canvasflow/voice'
import transcripts from '../../../../fixtures/airport-pickup/voice/transcripts.json'
import createAirportPickupWav from '../../../../fixtures/airport-pickup/voice/create-airport-pickup.wav?url'
import flightNumberWav from '../../../../fixtures/airport-pickup/voice/flight-number.wav?url'
import noisyCreateWav from '../../../../fixtures/airport-pickup/voice/noisy-create.wav?url'

/**
 * The offline voice fallback: each fixture sample pairs a pre-recorded WAV with
 * its canonical transcript from `transcripts.json`. The recording is what the
 * audience hears; the transcript is the payload the task actually receives, so
 * a broken speaker or a blocked autoplay never blocks the demo.
 */
export type VoiceFixtureSample = {
  id: string
  /** Canonical transcript delivered as the recognition result. */
  text: string
  /** Confidence recorded with the sample; travels with the submit meta. */
  confidence: number
  /** The sample must stop at the transcript-confirmation step. */
  requiresConfirmation: boolean
  /** Chinese label shown on the demo drawer's replay button. */
  label: string
  audioUrl: string
}

/** The slice of `HTMLAudioElement` the fixture engine drives. */
export type FixtureAudioLike = {
  play: () => void | Promise<void>
  pause: () => void
  onended: (() => void) | null
  onerror: (() => void) | null
}

export type FixtureAudioFactory = (url: string) => FixtureAudioLike | null

const audioUrls: Record<string, string> = {
  'create-airport-pickup.wav': createAirportPickupWav,
  'flight-number.wav': flightNumberWav,
  'noisy-create.wav': noisyCreateWav,
}

const sampleLabels: Record<string, string> = {
  'create-airport-pickup': '接机指令',
  'flight-number': '补充航班号',
  'noisy-create': '嘈杂样本（需确认）',
}

export const voiceFixtureSamples: VoiceFixtureSample[] = transcripts.samples.map((sample) => ({
  id: sample.id,
  text: sample.text,
  confidence: sample.confidence,
  requiresConfirmation: sample.requiresConfirmation,
  label: sampleLabels[sample.id] ?? sample.id,
  audioUrl: audioUrls[sample.file] ?? '',
}))

function defaultAudioFactory(url: string): FixtureAudioLike | null {
  if (typeof Audio === 'undefined' || !url) return null
  const element = new Audio(url)
  const adapter: FixtureAudioLike = {
    play: () => element.play(),
    pause: () => element.pause(),
    onended: null,
    onerror: null,
  }
  element.onended = () => adapter.onended?.()
  element.onerror = () => adapter.onerror?.()
  return adapter
}

/**
 * A recognition engine backed by one fixture sample instead of a microphone.
 *
 * It honours the `SpeechRecognitionLike` surface, so the existing controller,
 * machine and composer run unchanged: the transcript arrives first as an
 * interim result (a second press keeps it, same as a live turn), and the final
 * result carries the sample's recorded confidence.
 *
 * Playback is presentation only. When the audio cannot start or errors, the
 * transcript is still delivered — the fallback's one job is that the words
 * reach the task deterministically.
 */
export function createFixtureRecognition(
  sample: VoiceFixtureSample,
  createAudio: FixtureAudioFactory = defaultAudioFactory,
): SpeechRecognitionLike {
  let audio: FixtureAudioLike | null = null
  let settled = false

  const engine: SpeechRecognitionLike = {
    lang: 'zh-CN',
    continuous: false,
    interimResults: true,
    onresult: null,
    onerror: null,
    onend: null,
    onstart: null,

    start() {
      const finish = () => {
        if (settled) return
        settled = true
        engine.onresult?.({
          resultIndex: 0,
          results: {
            length: 1,
            0: { isFinal: true, length: 1, 0: { transcript: sample.text, confidence: sample.confidence } },
          },
        })
        engine.onend?.()
      }

      // Deliver the words as an interim result up front, mirroring a live
      // engine: the status line shows them while the audio plays, and stopping
      // the turn early still keeps them.
      queueMicrotask(() => {
        if (settled) return
        engine.onresult?.({
          resultIndex: 0,
          results: {
            length: 1,
            0: { isFinal: false, length: 1, 0: { transcript: sample.text } },
          },
        })
      })

      try {
        audio = createAudio(sample.audioUrl)
      } catch {
        audio = null
      }
      if (!audio) {
        queueMicrotask(finish)
        return
      }
      audio.onended = finish
      audio.onerror = finish
      try {
        const played = audio.play()
        if (played && typeof played.then === 'function') void played.then(undefined, finish)
      } catch {
        finish()
      }
    },

    stop() {
      settled = true
      try {
        audio?.pause()
      } catch {
        // The element may already be gone; nothing left to silence.
      }
    },

    abort() {
      engine.stop()
    },
  }

  return engine
}

/**
 * Plays a sample's recording without a recognition turn — the degraded path for
 * a browser with no speech engine at all, where the transcript is parked in the
 * text field instead. Failure to play is deliberately silent: the transcript is
 * already on screen.
 */
export function playFixtureSampleAudio(
  sample: VoiceFixtureSample,
  createAudio: FixtureAudioFactory = defaultAudioFactory,
): void {
  let audio: FixtureAudioLike | null = null
  try {
    audio = createAudio(sample.audioUrl)
  } catch {
    return
  }
  if (!audio) return
  try {
    const played = audio.play()
    if (played && typeof played.then === 'function') void played.then(undefined, () => {})
  } catch {
    // Presentation only; the parked transcript carries the demo.
  }
}
