import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const sampleRateHz = 16_000
const outputDirectory = resolve(process.cwd(), 'fixtures/airport-pickup/voice')
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'canvasflow-voice-'))

const fixtures = [
  successFixture('clear-airport-pickup', '接妈妈和豆豆，航班 M U 五一零二', {
    transcript: '接妈妈和豆豆，航班 MU5102',
    confidence: 0.96,
    partials: ['接妈妈', '接妈妈和豆豆', '接妈妈和豆豆，航班', '接妈妈和豆豆，航班 MU5102'],
  }),
  successFixture('missing-flight-number', '我现在要去机场接妈妈和豆豆', {
    transcript: '我现在要去机场接妈妈和豆豆',
    confidence: 0.95,
    partials: ['我现在要去机场', '我现在要去机场接妈妈', '我现在要去机场接妈妈和豆豆'],
  }),
  successFixture('noisy-airport-pickup', '接妈妈和豆豆，航班 M U 五一零二', {
    transcript: '接妈妈和豆豆，航班 MU5102',
    confidence: 0.52,
    warnings: ['BACKGROUND_NOISE', 'LOW_CONFIDENCE'],
    partials: ['接妈妈', '接妈妈和豆豆', '接妈妈和豆豆，航班 MU5102'],
    transform: addDeterministicNoise,
  }),
  errorFixture('no-speech', () => silence(1800), {
    code: 'NO_SPEECH_DETECTED',
    message: '没有检测到可识别的人声',
    retryable: true,
  }),
  successFixture('misunderstood-flight', '接妈妈和豆豆，航班 M U 五一零七', {
    transcript: '接妈妈和豆豆，航班 MU5101',
    confidence: 0.64,
    warnings: ['LOW_CONFIDENCE'],
    partials: ['接妈妈和豆豆', '接妈妈和豆豆，航班 MU5101'],
  }),
  errorFixture('timeout', '语音服务超时测试，接妈妈和豆豆，航班 M U 五一零二', {
    code: 'TRANSCRIPTION_TIMEOUT',
    message: '语音转写服务超时，请重试或使用文本输入',
    retryable: true,
  }),
  errorFixture('short-noise', () => deterministicNoise(180), {
    code: 'NO_SPEECH_DETECTED',
    message: '录音过短，未检测到有效人声',
    retryable: true,
  }),
  successFixture('truncated-utterance', '接妈妈和豆豆，航班', {
    transcript: '接妈妈和豆豆，航班',
    confidence: 0.78,
    warnings: ['POSSIBLE_TRUNCATION'],
    partials: ['接妈妈', '接妈妈和豆豆', '接妈妈和豆豆，航班'],
  }),
  successFixture('flight-number-spoken-digits', '航班号 M U 五一零二，接妈妈和豆豆', {
    transcript: '接妈妈和豆豆，航班 MU5102',
    confidence: 0.91,
    warnings: ['NORMALIZED_FLIGHT_NUMBER'],
    partials: ['接妈妈和豆豆', '接妈妈和豆豆，航班 MU 五一零二', '接妈妈和豆豆，航班 MU5102'],
  }),
]

try {
  mkdirSync(outputDirectory, { recursive: true })
  const entries = fixtures.map(generateFixture)
  writeFileSync(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify({
    version: '1.0',
    generatedAt: '2026-07-22T12:00:00+08:00',
    fixtures: entries,
  }, null, 2)}\n`)
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}

function successFixture(fixtureId, source, options) {
  return {
    fixtureId,
    source,
    transform: options.transform,
    outcome: {
      kind: 'success',
      transcript: options.transcript,
      confidence: options.confidence,
      language: 'zh-CN',
      warnings: options.warnings ?? [],
      partials: options.partials,
    },
  }
}

function errorFixture(fixtureId, source, outcome) {
  return { fixtureId, source, outcome: { kind: 'error', ...outcome } }
}

function generateFixture(fixture) {
  const samples = typeof fixture.source === 'function'
    ? fixture.source()
    : synthesize(fixture.fixtureId, fixture.source)
  const transformed = fixture.transform ? fixture.transform(samples) : samples
  const wav = encodeWav(transformed)
  const file = `${fixture.fixtureId}.wav`
  writeFileSync(resolve(outputDirectory, file), wav)
  return {
    fixtureId: fixture.fixtureId,
    file,
    sha256: createHash('sha256').update(wav).digest('hex'),
    mimeType: 'audio/wav',
    sampleRateHz,
    channels: 1,
    durationMs: Math.round((transformed.length / sampleRateHz) * 1000),
    model: 'fixture-manifest-v1',
    outcome: fixture.outcome,
  }
}

function synthesize(fixtureId, text) {
  const path = resolve(temporaryDirectory, `${fixtureId}.wav`)
  execFileSync('/usr/bin/say', [
    '-v', 'Tingting',
    '--data-format=LEI16@16000',
    '-o', path,
    text,
  ])
  return decodeWav(readFileSync(path))
}

function decodeWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a RIFF/WAVE file')
  }
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'data') {
      const sampleCount = Math.floor(size / 2)
      const samples = new Int16Array(sampleCount)
      for (let index = 0; index < sampleCount; index += 1) {
        samples[index] = buffer.readInt16LE(start + index * 2)
      }
      return samples
    }
    offset = start + size + (size % 2)
  }
  throw new Error('WAV data chunk not found')
}

function encodeWav(samples) {
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRateHz, 24)
  buffer.writeUInt32LE(sampleRateHz * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * 2)
  }
  return buffer
}

function silence(durationMs) {
  return new Int16Array(Math.round((durationMs / 1000) * sampleRateHz))
}

function deterministicNoise(durationMs) {
  const samples = silence(durationMs)
  let state = 0x5102
  for (let index = 0; index < samples.length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    samples[index] = ((state >>> 16) & 0x7fff) - 0x4000
  }
  return samples
}

function addDeterministicNoise(samples) {
  const output = new Int16Array(samples.length)
  let state = 0x7914
  for (let index = 0; index < samples.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const noise = (((state >>> 16) & 0xffff) - 0x8000) * 0.18
    output[index] = clampInt16(samples[index] * 0.72 + noise)
  }
  return output
}

function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)))
}
