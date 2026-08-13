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
  const capability = request(options.capabilitiesEndpoint ?? '/v1/voice/capabilities', {
    headers: { accept: 'application/json' },
  }).then(async (response) => {
    if (!response.ok) return false
    const body = await response.json() as { pcmAsr?: unknown }
    return body.pcmAsr === true
  }).catch(() => false)
  const pcm = createPcmCommandRecognizer(options.pcm)
  const fallback = createWebSpeechCommandRecognizer(options.webSpeech)

  return {
    async start(listener, config) {
      const recognizer = await capability ? pcm : fallback
      return await recognizer.start(listener, config)
    },
  }
}
