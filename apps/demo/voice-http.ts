import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import {
  voiceFixtureTranscriptionRequestSchema,
  voiceMimeTypeSchema,
  voiceTranscriptionHttpResponseSchema,
  voiceTranscriptionMetadataSchema,
  type VoiceErrorCode,
  type VoiceTranscriptionHttpResponse,
} from '@canvasflow/schema'
import {
  createVoiceProvider,
  loadVoiceFixtureManifest,
  type VoiceProvider,
} from '@canvasflow/tools'

const DEFAULT_AUDIO_LIMIT_BYTES = 2 * 1024 * 1024
const DEFAULT_JSON_LIMIT_BYTES = 16 * 1024
const VOICE_FIXTURE_DIRECTORY = resolve(process.cwd(), 'fixtures/airport-pickup/voice')

export type VoiceHttpOptions = {
  provider?: VoiceProvider
  createProvider?: () => VoiceProvider
  createRequestId?: () => string
  audioLimitBytes?: number
  jsonLimitBytes?: number
}

type VoiceHttpError = {
  status: number
  code: VoiceErrorCode
  message: string
  retryable: boolean
}

export function createConfiguredVoiceProvider(environment: NodeJS.ProcessEnv = process.env): VoiceProvider {
  const rawMode = environment.AGENT_VOICE_MODE ?? environment.AGENT_PROVIDER_MODE ?? 'fixture'
  if (rawMode === 'live') {
    throw new Error('AGENT_VOICE_MODE=live requires an explicitly injected VoiceProvider')
  }
  if (rawMode !== 'fixture' && rawMode !== 'mock') {
    throw new Error(`Unsupported AGENT_VOICE_MODE: ${rawMode}`)
  }
  return createVoiceProvider({ mode: rawMode })
}

export function createVoiceHttpHandler(options: VoiceHttpOptions) {
  const createRequestId = options.createRequestId ?? randomUUID
  const audioLimitBytes = positiveLimit(options.audioLimitBytes ?? DEFAULT_AUDIO_LIMIT_BYTES, 'audioLimitBytes')
  const jsonLimitBytes = positiveLimit(options.jsonLimitBytes ?? DEFAULT_JSON_LIMIT_BYTES, 'jsonLimitBytes')

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = headerRequestId(request, createRequestId)
    try {
      if (request.method !== 'POST') {
        writeJson(response, 405, failure(requestId, 'TRANSCRIPTION_FAILED', '只支持 POST 请求', false), {
          allow: 'POST',
        })
        return
      }

      const provider = resolveProvider(options)
      const contentType = singleHeader(request.headers['content-type'])
      const input = contentType?.toLowerCase().startsWith('application/json')
        ? await fixtureInput(request, jsonLimitBytes)
        : contentType?.toLowerCase().startsWith('multipart/form-data')
          ? await multipartInput(request, audioLimitBytes)
          : (() => { throw httpError(415, 'UNSUPPORTED_AUDIO_FORMAT', 'Content-Type 必须是 application/json 或 multipart/form-data', false) })()

      const result = await provider.transcribe({ requestId }, input)
      const body = voiceTranscriptionHttpResponseSchema.parse({ requestId, ...result })
      writeJson(response, transcriptionStatus(body), body)
    } catch (error) {
      const known = asVoiceHttpError(error)
      writeJson(response, known.status, failure(requestId, known.code, known.message, known.retryable))
    }
  }
}

function resolveProvider(options: VoiceHttpOptions): VoiceProvider {
  if (options.provider) return options.provider
  try {
    const provider = options.createProvider?.()
    if (provider) return provider
  } catch {
    // Provider configuration is deployment state, so do not expose its details.
  }
  throw httpError(503, 'TRANSCRIPTION_FAILED', '语音转写服务尚未配置', false)
}

async function fixtureInput(request: IncomingMessage, limitBytes: number) {
  const raw = await readBody(request, limitBytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown
  } catch {
    throw httpError(400, 'TRANSCRIPTION_FAILED', '请求体必须是有效 JSON', false)
  }
  const metadata = voiceFixtureTranscriptionRequestSchema.safeParse(parsed)
  if (!metadata.success) throw httpError(400, 'TRANSCRIPTION_FAILED', 'Fixture 请求参数无效', false)
  const fixture = loadVoiceFixtureManifest().fixtures.find((entry) => entry.fixtureId === metadata.data.fixtureId)
  if (!fixture) throw httpError(404, 'TRANSCRIPTION_FAILED', '语音 Fixture 不存在', false)
  return {
    audio: await readFile(resolve(VOICE_FIXTURE_DIRECTORY, fixture.file)),
    mimeType: fixture.mimeType,
    fixtureId: fixture.fixtureId,
    language: metadata.data.language,
  }
}

async function multipartInput(request: IncomingMessage, limitBytes: number) {
  const body = await readBody(request, limitBytes + 64 * 1024)
  const contentType = singleHeader(request.headers['content-type']) ?? ''
  const boundary = multipartBoundary(contentType)
  const parts = parseMultipart(body, boundary)
  const audio = parts.find((part) => part.name === 'audio' && part.filename !== undefined)
  if (!audio) throw httpError(400, 'TRANSCRIPTION_FAILED', '必须提供 audio 文件字段', false)
  if (audio.body.byteLength === 0) throw httpError(400, 'AUDIO_TOO_SHORT', '音频内容为空', false)
  if (audio.body.byteLength > limitBytes) throw httpError(413, 'AUDIO_TOO_LONG', `音频上传不得超过 ${limitBytes} 字节`, false)
  const mimeType = voiceMimeTypeSchema.safeParse(audio.contentType)
  if (!mimeType.success) throw httpError(415, 'UNSUPPORTED_AUDIO_FORMAT', `不支持的音频格式：${audio.contentType || 'unknown'}`, false)
  const metadata = voiceTranscriptionMetadataSchema.safeParse({
    fixtureId: parts.find((part) => part.name === 'fixtureId')?.body.toString('utf8'),
    language: parts.find((part) => part.name === 'language')?.body.toString('utf8'),
  })
  if (!metadata.success) throw httpError(400, 'TRANSCRIPTION_FAILED', '音频元数据无效', false)
  return {
    audio: audio.body,
    mimeType: mimeType.data,
    ...metadata.data,
  }
}

async function readBody(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    request.resume()
    throw httpError(413, 'AUDIO_TOO_LONG', `请求体不得超过 ${limitBytes} 字节`, false)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limitBytes) {
      request.resume()
      throw httpError(413, 'AUDIO_TOO_LONG', `请求体不得超过 ${limitBytes} 字节`, false)
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) throw httpError(400, 'AUDIO_TOO_SHORT', '请求体不能为空', false)
  return Buffer.concat(chunks)
}

function transcriptionStatus(body: VoiceTranscriptionHttpResponse): number {
  if (body.ok) return 200
  switch (body.error.code) {
    case 'NO_SPEECH_DETECTED': return 422
    case 'TRANSCRIPTION_TIMEOUT': return 504
    case 'UNSUPPORTED_AUDIO_FORMAT': return 415
    default: return 502
  }
}

function failure(
  requestId: string,
  code: VoiceErrorCode,
  message: string,
  retryable: boolean,
): VoiceTranscriptionHttpResponse {
  return voiceTranscriptionHttpResponseSchema.parse({
    requestId,
    ok: false,
    result: null,
    error: { code, message, retryable },
  })
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: VoiceTranscriptionHttpResponse,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': body.requestId,
    ...extraHeaders,
  })
  response.end(JSON.stringify(body))
}

function headerRequestId(request: IncomingMessage, createRequestId: () => string): string {
  const value = singleHeader(request.headers['x-request-id'])?.trim()
  return value ? value.slice(0, 200) : createRequestId()
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

type MultipartPart = {
  name: string
  filename?: string
  contentType: string
  body: Buffer
}

function multipartBoundary(contentType: string): string {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = match?.[1] ?? match?.[2]?.trim()
  if (!boundary) throw httpError(400, 'TRANSCRIPTION_FAILED', 'multipart 请求缺少 boundary', false)
  return boundary
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: MultipartPart[] = []
  let cursor = body.indexOf(delimiter)
  if (cursor < 0) throw httpError(400, 'TRANSCRIPTION_FAILED', 'multipart 请求边界无效', false)
  while (cursor >= 0) {
    const partStart = cursor + delimiter.length
    if (body.subarray(partStart, partStart + 2).toString('ascii') === '--') break
    const headerStart = partStart + 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart)
    if (headerEnd < 0) throw httpError(400, 'TRANSCRIPTION_FAILED', 'multipart 字段头无效', false)
    const headers = body.subarray(headerStart, headerEnd).toString('utf8')
    const disposition = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers)
    if (!disposition) throw httpError(400, 'TRANSCRIPTION_FAILED', 'multipart 字段缺少 content-disposition', false)
    const contentTypeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers)
    const contentStart = headerEnd + 4
    const nextBoundary = body.indexOf(delimiter, contentStart)
    if (nextBoundary < 0) throw httpError(400, 'TRANSCRIPTION_FAILED', 'multipart 字段未结束', false)
    const contentEnd = nextBoundary - 2
    parts.push({
      name: disposition[1]!,
      ...(disposition[2] !== undefined ? { filename: disposition[2] } : {}),
      contentType: contentTypeMatch?.[1]?.trim() ?? 'text/plain',
      body: body.subarray(contentStart, Math.max(contentStart, contentEnd)),
    })
    cursor = nextBoundary
  }
  return parts
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

function httpError(status: number, code: VoiceErrorCode, message: string, retryable: boolean): VoiceHttpError {
  return { status, code, message, retryable }
}

function asVoiceHttpError(error: unknown): VoiceHttpError {
  if (
    typeof error === 'object'
    && error !== null
    && 'status' in error
    && 'code' in error
    && 'message' in error
    && 'retryable' in error
  ) return error as VoiceHttpError
  return httpError(500, 'TRANSCRIPTION_FAILED', '语音转写服务内部错误', false)
}
