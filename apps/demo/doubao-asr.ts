import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import WebSocket from 'ws'

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
const DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration'

const CLIENT_FULL_REQUEST = 0x1
const CLIENT_AUDIO_ONLY_REQUEST = 0x2
const SERVER_FULL_RESPONSE = 0x9
const SERVER_ERROR_RESPONSE = 0xf
const POSITIVE_SEQUENCE = 0x1
const NEGATIVE_WITH_SEQUENCE = 0x3
const JSON_SERIALIZATION = 0x1
const GZIP_COMPRESSION = 0x1

export type DoubaoAsrEnvironment = Pick<NodeJS.ProcessEnv,
  'DOUBAO_ASR_API_KEY' | 'DOUBAO_ASR_RESOURCE_ID' | 'DOUBAO_ASR_URL'
>

export type DoubaoAsrMessage = {
  text: string
  final: boolean
  definite: boolean
  sequence: number
}

export function doubaoAsrConfigured(environment: DoubaoAsrEnvironment = process.env): boolean {
  return Boolean(environment.DOUBAO_ASR_API_KEY)
}

function header(messageType: number, flags: number, serialization = 0, compression = GZIP_COMPRESSION) {
  return Buffer.from([
    0x11,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ])
}

function sequence(value: number) {
  const output = Buffer.allocUnsafe(4)
  output.writeInt32BE(value)
  return output
}

function sized(payload: Buffer) {
  const size = Buffer.allocUnsafe(4)
  size.writeUInt32BE(payload.length)
  return Buffer.concat([size, payload])
}

export function createDoubaoFullRequest(seq = 1): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify({
    user: { uid: 'canvasflow-cockpit' },
    audio: { format: 'pcm', codec: 'raw', rate: 16_000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      enable_nonstream: true,
      end_window_size: 800,
    },
  })))
  return Buffer.concat([
    header(CLIENT_FULL_REQUEST, POSITIVE_SEQUENCE, JSON_SERIALIZATION),
    sequence(seq),
    sized(payload),
  ])
}

export function createDoubaoAudioRequest(seq: number, pcm: Buffer, final = false): Buffer {
  const payload = gzipSync(pcm)
  return Buffer.concat([
    header(CLIENT_AUDIO_ONLY_REQUEST, final ? NEGATIVE_WITH_SEQUENCE : POSITIVE_SEQUENCE),
    sequence(final ? -seq : seq),
    sized(payload),
  ])
}

export type ParsedDoubaoResponse = {
  code: number
  sequence: number
  last: boolean
  payload?: Record<string, unknown>
}

export function parseDoubaoResponse(data: Buffer): ParsedDoubaoResponse {
  if (data.length < 4) throw new Error('Doubao ASR returned a truncated frame')
  const headerBytes = (data[0]! & 0x0f) * 4
  const messageType = data[1]! >> 4
  const flags = data[1]! & 0x0f
  const serialization = data[2]! >> 4
  const compression = data[2]! & 0x0f
  let offset = headerBytes
  let payloadSequence = 0
  let code = 0
  if (flags & 0x1) {
    payloadSequence = data.readInt32BE(offset)
    offset += 4
  }
  const last = Boolean(flags & 0x2)
  if (flags & 0x4) offset += 4
  if (messageType === SERVER_FULL_RESPONSE) {
    offset += 4
  } else if (messageType === SERVER_ERROR_RESPONSE) {
    code = data.readInt32BE(offset)
    offset += 8
  } else {
    throw new Error(`Doubao ASR returned unsupported message type ${messageType}`)
  }
  let payload = data.subarray(offset)
  if (compression === GZIP_COMPRESSION && payload.length > 0) payload = gunzipSync(payload)
  const parsed = serialization === JSON_SERIALIZATION && payload.length > 0
    ? JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    : undefined
  return { code, sequence: payloadSequence, last, payload: parsed }
}

function resultFromPayload(payload: Record<string, unknown> | undefined) {
  const result = payload?.result
  return result && typeof result === 'object' ? result as Record<string, unknown> : undefined
}

export function doubaoMessageFromResponse(response: ParsedDoubaoResponse): DoubaoAsrMessage | undefined {
  if (response.code !== 0) {
    const message = typeof response.payload?.message === 'string' ? response.payload.message : `code ${response.code}`
    throw new Error(`Doubao ASR failed: ${message}`)
  }
  const result = resultFromPayload(response.payload)
  const text = typeof result?.text === 'string' ? result.text.trim() : ''
  if (!text && !response.last) return undefined
  const utterances = Array.isArray(result?.utterances) ? result.utterances : []
  const definite = utterances.some((utterance) => (
    utterance && typeof utterance === 'object' && (utterance as Record<string, unknown>).definite === true
  ))
  return { text, final: response.last, definite, sequence: response.sequence }
}

export type DoubaoAsrSession = {
  send(pcm: Buffer): void
  finish(): void
  close(): void
}

export function createDoubaoAsrSession(
  callbacks: { onMessage(message: DoubaoAsrMessage): void; onError(error: Error): void },
  environment: DoubaoAsrEnvironment = process.env,
): DoubaoAsrSession {
  const apiKey = environment.DOUBAO_ASR_API_KEY
  if (!apiKey) throw new Error('DOUBAO_ASR_API_KEY is not configured')
  const socket = new WebSocket(environment.DOUBAO_ASR_URL ?? DEFAULT_ENDPOINT, {
    headers: {
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': environment.DOUBAO_ASR_RESOURCE_ID ?? DEFAULT_RESOURCE_ID,
      'X-Api-Request-Id': randomUUID(),
      'X-Api-Sequence': '-1',
    },
  })
  let seq = 1
  let opened = false
  let initialized = false
  let finished = false
  const pending: Buffer[] = []

  const fail = (error: unknown) => callbacks.onError(error instanceof Error ? error : new Error(String(error)))
  socket.once('open', () => {
    opened = true
    socket.send(createDoubaoFullRequest(seq++))
  })
  socket.on('message', (data, binary) => {
    if (!binary) return
    try {
      const response = parseDoubaoResponse(Buffer.from(data as ArrayBuffer))
      if (!initialized) {
        initialized = true
        for (const packet of pending.splice(0)) socket.send(createDoubaoAudioRequest(seq++, packet))
        if (finished) socket.send(createDoubaoAudioRequest(seq, Buffer.alloc(0), true))
      }
      const message = doubaoMessageFromResponse(response)
      if (message) callbacks.onMessage(message)
    } catch (error) {
      fail(error)
    }
  })
  socket.once('error', fail)

  return {
    send(pcm) {
      if (finished || pcm.length === 0) return
      if (!opened || !initialized) pending.push(Buffer.from(pcm))
      else socket.send(createDoubaoAudioRequest(seq++, pcm))
    },
    finish() {
      if (finished) return
      finished = true
      if (initialized) socket.send(createDoubaoAudioRequest(seq, Buffer.alloc(0), true))
    },
    close() {
      finished = true
      pending.length = 0
      socket.close()
    },
  }
}
