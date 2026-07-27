import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  AgentResponse,
  CancelTaskRequest,
  CreateTaskRequest,
  ResetTaskRequest,
  SubmitActionRequest,
  SubmitConfirmationRequest,
  SubmitEventRequest,
} from '@canvasflow/schema'
import { AgentGatewayError } from './gateway'
import type { TaskUpdateRead } from './store'

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024
const DEFAULT_EVENT_POLL_INTERVAL_MS = 250
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

export interface AgentHttpGateway {
  createTask(input: CreateTaskRequest): AgentResponse
  getTask(taskId: string, requestId?: string): AgentResponse
  submitEvent(taskId: string, input: SubmitEventRequest): AgentResponse
  submitAction(taskId: string, input: SubmitActionRequest): AgentResponse
  submitConfirmation(taskId: string, confirmationId: string, input: SubmitConfirmationRequest): AgentResponse
  cancelTask(taskId: string, input: CancelTaskRequest): AgentResponse
  resetTask(taskId: string, input: ResetTaskRequest): AgentResponse
  getTaskUpdates(taskId: string, afterCursor?: number): TaskUpdateRead
  hasCreateResult?(clientRequestId: string): boolean
  /** Optional preflight methods for runtimes that need async work before a write transaction. */
  createTaskAsync?(input: CreateTaskRequest): Promise<AgentResponse>
  /** Reports whether the durable create transaction replayed an existing result. */
  createTaskWithStatusAsync?(input: CreateTaskRequest): Promise<{ response: AgentResponse; replay: boolean }>
  submitEventAsync?(taskId: string, input: SubmitEventRequest): Promise<AgentResponse>
}

export type AgentHttpOptions = {
  bodyLimitBytes?: number
  createRequestId?: () => string
  eventPollIntervalMs?: number
  heartbeatIntervalMs?: number
}

type ErrorCode =
  | 'INVALID_REQUEST'
  | 'TASK_NOT_FOUND'
  | 'TASK_REVISION_CONFLICT'
  | 'UI_REVISION_CONFLICT'
  | 'CONFIRMATION_EXPIRED'
  | 'POLICY_DENIED'
  | 'PROVIDER_FAILED'
  | 'PROVIDER_TIMEOUT'

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

function routeSegments(request: IncomingMessage): string[] {
  let pathname: string
  try {
    pathname = new URL(request.url ?? '/', 'http://canvasflow.local').pathname
  } catch {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Invalid request URL')
  }

  try {
    return pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
  } catch {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Invalid URL encoding')
  }
}

function headerRequestId(request: IncomingMessage, createRequestId: () => string): string {
  const value = request.headers['x-request-id']
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200)
  if (Array.isArray(value)) {
    const first = value.find((candidate) => candidate.trim())
    if (first) return first.trim().slice(0, 200)
  }
  return createRequestId()
}

function bodyClientRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('clientRequestId' in value)) return undefined
  const clientRequestId = (value as { clientRequestId?: unknown }).clientRequestId
  return typeof clientRequestId === 'string' ? clientRequestId : undefined
}

async function readJson(request: IncomingMessage, limitBytes: number): Promise<unknown> {
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Content-Type must be application/json')
  }

  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    request.resume()
    throw new HttpRequestError(413, 'INVALID_REQUEST', `Request body exceeds ${limitBytes} bytes`)
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limitBytes) {
      request.resume()
      throw new HttpRequestError(413, 'INVALID_REQUEST', `Request body exceeds ${limitBytes} bytes`)
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) throw new HttpRequestError(400, 'INVALID_REQUEST', 'Request body is required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Request body must be valid JSON')
  }
}

function gatewayStatus(code: ErrorCode): number {
  switch (code) {
    case 'TASK_NOT_FOUND': return 404
    case 'TASK_REVISION_CONFLICT':
    case 'UI_REVISION_CONFLICT': return 409
    case 'CONFIRMATION_EXPIRED': return 410
    case 'POLICY_DENIED': return 403
    case 'PROVIDER_FAILED': return 502
    case 'PROVIDER_TIMEOUT': return 504
    default: return 400
  }
}

function writeJson(response: ServerResponse, status: number, requestId: string, body: unknown, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': requestId,
    ...extraHeaders,
  })
  response.end(JSON.stringify(body))
}

function responseWithRequestId(result: AgentResponse, requestId: string): AgentResponse {
  return { ...result, requestId }
}

function isValidationError(error: unknown): error is { issues: unknown[] } {
  return error instanceof Error
    && error.name === 'ZodError'
    && Array.isArray((error as Error & { issues?: unknown }).issues)
}

function positiveInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

function acceptsEventStream(request: IncomingMessage): boolean {
  const accept = request.headers.accept
  const values: string[] = Array.isArray(accept) ? accept : accept ? [accept] : []
  return values.some((value) => value.split(',').some((item) => item.trim().split(';', 1)[0]?.toLowerCase() === 'text/event-stream'))
}

function eventId(taskId: string, cursor: number): string {
  return `${Buffer.from(taskId).toString('base64url')}.${cursor}`
}

function lastEventCursor(request: IncomingMessage, taskId: string): number | undefined {
  const header = request.headers['last-event-id']
  if (Array.isArray(header)) {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Last-Event-ID must be a single task cursor')
  }
  if (header === undefined) return undefined
  const value = header.trim()
  const match = /^([A-Za-z0-9_-]+)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Last-Event-ID must be a valid task cursor')
  }
  let encodedTaskId: string
  try {
    encodedTaskId = Buffer.from(match[1]!, 'base64url').toString('utf8')
  } catch {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Last-Event-ID must be a valid task cursor')
  }
  if (encodedTaskId !== taskId || Buffer.from(encodedTaskId).toString('base64url') !== match[1]) {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Last-Event-ID belongs to a different task')
  }
  const cursor = Number(match[2])
  if (!Number.isSafeInteger(cursor)) {
    throw new HttpRequestError(400, 'INVALID_REQUEST', 'Last-Event-ID exceeds the supported cursor range')
  }
  return cursor
}

export type SseWritable = {
  write(chunk: string): boolean
  once(event: 'drain' | 'close', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'drain' | 'close', listener: () => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
}

function waitForDrain(writable: SseWritable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.off('drain', onDrain)
      writable.off('close', onClose)
      writable.off('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('SSE connection closed while waiting for drain'))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    writable.once('drain', onDrain)
    writable.once('close', onClose)
    writable.once('error', onError)
  })
}

async function writeSseChunk(writable: SseWritable, chunk: string): Promise<void> {
  if (!writable.write(chunk)) await waitForDrain(writable)
}

export async function writeTaskUpdates(writable: SseWritable, read: TaskUpdateRead): Promise<number | undefined> {
  let lastCursor: number | undefined
  for (const update of read.updates) {
    await writeSseChunk(
      writable,
      `id: ${eventId(update.taskId, update.cursor)}\nevent: task.updated\ndata: ${JSON.stringify(update)}\n\n`,
    )
    lastCursor = update.cursor
  }
  return lastCursor
}

export function createAgentHttpHandler(gateway: AgentHttpGateway, options: AgentHttpOptions = {}) {
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes <= 0) {
    throw new TypeError('bodyLimitBytes must be a positive safe integer')
  }
  const createRequestId = options.createRequestId ?? randomUUID
  const eventPollIntervalMs = positiveInterval(options.eventPollIntervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS, 'eventPollIntervalMs')
  const heartbeatIntervalMs = positiveInterval(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS, 'heartbeatIntervalMs')

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = headerRequestId(request, createRequestId)
    try {
      const segments = routeSegments(request)
      const v1Prefix = segments[0] === 'v1'
      const prefixLength = 2
      const taskRoot = v1Prefix && segments[1] === 'tasks' && segments.length === prefixLength
      const taskRoute = v1Prefix && segments[1] === 'tasks' && segments.length >= prefixLength + 1

      if (
        request.method === 'GET'
        && taskRoute
        && segments.length === prefixLength + 2
        && segments[prefixLength + 1] === 'events'
      ) {
        if (!acceptsEventStream(request)) {
          throw new HttpRequestError(400, 'INVALID_REQUEST', 'Accept must include text/event-stream')
        }
        const taskId = segments[prefixLength]!
        const afterCursor = lastEventCursor(request, taskId)
        const initial = gateway.getTaskUpdates(taskId, afterCursor)
        if (afterCursor !== undefined && afterCursor > initial.latestCursor) {
          throw new HttpRequestError(400, 'INVALID_REQUEST', 'Last-Event-ID is ahead of the task update stream', {
            latestCursor: initial.latestCursor,
          })
        }

        response.writeHead(200, {
          'cache-control': 'no-cache, no-store',
          connection: 'keep-alive',
          'content-type': 'text/event-stream; charset=utf-8',
          'x-accel-buffering': 'no',
          'x-request-id': requestId,
        })
        response.flushHeaders()
        let cursor = afterCursor ?? 0
        let closed = false
        let writing = false
        const timers: NodeJS.Timeout[] = []
        const cleanup = () => {
          if (closed) return
          closed = true
          for (const timer of timers) clearInterval(timer)
        }
        request.once('aborted', cleanup)
        response.once('close', cleanup)

        const runWrite = async (operation: () => Promise<void>) => {
          if (closed || writing) return
          writing = true
          try {
            await operation()
          } catch {
            cleanup()
            response.destroy()
          } finally {
            writing = false
          }
        }
        await runWrite(async () => {
          const initialCursor = await writeTaskUpdates(response, initial)
          if (initialCursor !== undefined) cursor = initialCursor
        })
        if (closed) return

        const pollTimer = setInterval(() => {
          void runWrite(async () => {
            const read = gateway.getTaskUpdates(taskId, cursor)
            const nextCursor = await writeTaskUpdates(response, read)
            if (nextCursor !== undefined) cursor = nextCursor
          })
        }, eventPollIntervalMs)
        pollTimer.unref()
        timers.push(pollTimer)
        const heartbeatTimer = setInterval(() => {
          void runWrite(() => writeSseChunk(response, ': heartbeat\n\n'))
        }, heartbeatIntervalMs)
        heartbeatTimer.unref()
        timers.push(heartbeatTimer)
        return
      }

      if (request.method === 'POST' && taskRoot) {
        const body = await readJson(request, bodyLimitBytes)
        const clientRequestId = bodyClientRequestId(body)
        const createRequest = body as CreateTaskRequest
        const existingReplay = clientRequestId !== undefined && (gateway.hasCreateResult?.(clientRequestId) ?? false)
        const durableResult = gateway.createTaskWithStatusAsync
          ? await gateway.createTaskWithStatusAsync(createRequest)
          : undefined
        const result = durableResult?.response ?? (gateway.createTaskAsync
          ? await gateway.createTaskAsync(createRequest)
          : gateway.createTask(createRequest))
        const replay = durableResult?.replay ?? existingReplay
        writeJson(
          response,
          replay ? 200 : 201,
          requestId,
          responseWithRequestId(result, requestId),
          replay ? {} : { location: `/v1/tasks/${encodeURIComponent(result.task.taskId)}` },
        )
        return
      }

      if (request.method === 'GET' && taskRoute && segments.length === prefixLength + 1) {
        const result = gateway.getTask(segments[prefixLength]!, requestId)
        writeJson(response, 200, requestId, responseWithRequestId(result, requestId))
        return
      }

      if (request.method === 'POST' && taskRoute) {
        const taskId = segments[prefixLength]!
        const body = await readJson(request, bodyLimitBytes)
        let result: AgentResponse
        const operation = segments[prefixLength + 1]
        if (segments.length === prefixLength + 2 && operation === 'events') {
          const eventRequest = body as SubmitEventRequest
          result = gateway.submitEventAsync
            ? await gateway.submitEventAsync(taskId, eventRequest)
            : gateway.submitEvent(taskId, eventRequest)
        } else if (segments.length === prefixLength + 2 && operation === 'actions') {
          result = gateway.submitAction(taskId, body as SubmitActionRequest)
        } else if (segments.length === prefixLength + 3 && operation === 'confirmations') {
          result = gateway.submitConfirmation(taskId, segments[prefixLength + 2]!, body as SubmitConfirmationRequest)
        } else if (segments.length === prefixLength + 2 && operation === 'cancel') {
          result = gateway.cancelTask(taskId, body as CancelTaskRequest)
        } else if (segments.length === prefixLength + 2 && operation === 'reset') {
          result = gateway.resetTask(taskId, body as ResetTaskRequest)
        } else {
          throw new HttpRequestError(404, 'INVALID_REQUEST', 'Endpoint not found')
        }
        writeJson(response, 200, requestId, responseWithRequestId(result, requestId))
        return
      }

      const knownPath = taskRoot || taskRoute
      throw new HttpRequestError(
        knownPath ? 405 : 404,
        'INVALID_REQUEST',
        knownPath ? 'Method not allowed' : 'Endpoint not found',
      )
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (error instanceof HttpRequestError) {
        writeJson(response, error.status, requestId, {
          requestId,
          error: { code: error.code, message: error.message, retryable: false, ...(error.details ? { details: error.details } : {}) },
        }, error.status === 405 ? { allow: 'GET, POST' } : {})
        return
      }
      if (error instanceof AgentGatewayError) {
        writeJson(response, gatewayStatus(error.code), requestId, {
          requestId,
          error: { code: error.code, message: error.message, retryable: error.retryable },
          ...(error.latest ? { latest: { task: error.latest.task, ui: error.latest.ui } } : {}),
        })
        return
      }
      if (isValidationError(error)) {
        writeJson(response, 400, requestId, {
          requestId,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Request validation failed',
            retryable: false,
            details: { issues: error.issues },
          },
        })
        return
      }
      writeJson(response, 500, requestId, {
        requestId,
        error: { code: 'PROVIDER_FAILED', message: 'Internal server error', retryable: false },
      })
    }
  }
}

export function createAgentHttpServer(gateway: AgentHttpGateway, options: AgentHttpOptions = {}): Server {
  return createServer(createAgentHttpHandler(gateway, options))
}
