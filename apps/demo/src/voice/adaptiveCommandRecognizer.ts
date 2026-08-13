import type { CommandRecognizer } from '@canvasflow/voice'
import { createPcmCommandRecognizer, type PcmCommandRecognizerOptions } from './pcmCommandRecognizer'
import { createWebSpeechCommandRecognizer, type WebSpeechCommandRecognizerOptions } from './webSpeechCommandRecognizer'

export type AdaptiveCommandRecognizerOptions = {
  pcm: PcmCommandRecognizerOptions
  webSpeech?: WebSpeechCommandRecognizerOptions
  capabilitiesEndpoint?: string
  fetch?: typeof fetch
}

/** Selects shared PCM when the server has an ASR provider, otherwise Web Speech. */
export function createAdaptiveCommandRecognizer(options: AdaptiveCommandRecognizerOptions): CommandRecognizer {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis)
  const pcm = createPcmCommandRecognizer(options.pcm)
  const fallback = createWebSpeechCommandRecognizer(options.webSpeech)

  async function pcmAvailable(): Promise<boolean> {
    try {
      const response = await request(options.capabilitiesEndpoint ?? '/v1/voice/capabilities', {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return false
      const body = await response.json() as { pcmAsr?: unknown }
      return body.pcmAsr === true
    } catch {
      // A capability outage is transient. Do not cache the fallback decision;
      // the next command turn gets a fresh chance to use the PCM provider.
      return false
    }
  }

  return {
    async start(listener, config) {
      const recognizer = await pcmAvailable() ? pcm : fallback
      return await recognizer.start(listener, config)
    },
  }
}
