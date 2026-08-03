import { voiceFallbackManifest } from '@canvasflow/tools/demo-fixtures'

const fixtureUrls: Record<string, string> = {
  'create-airport-pickup.wav': new URL(
    '../../../../fixtures/airport-pickup/voice/create-airport-pickup.wav',
    import.meta.url,
  ).href,
  'flight-number.wav': new URL(
    '../../../../fixtures/airport-pickup/voice/flight-number.wav',
    import.meta.url,
  ).href,
  'noisy-create.wav': new URL(
    '../../../../fixtures/airport-pickup/voice/noisy-create.wav',
    import.meta.url,
  ).href,
}

const fixtureLabels: Record<string, string> = {
  'create-airport-pickup': '标准任务',
  'flight-number': '补充航班号',
  'noisy-create': '车内噪声',
}

export const demoVoiceFixtures = voiceFallbackManifest.samples.map((sample) => ({
  ...sample,
  label: fixtureLabels[sample.id] ?? sample.id,
  url: fixtureUrls[sample.file],
}))

export type DemoVoiceFixture = (typeof demoVoiceFixtures)[number]
