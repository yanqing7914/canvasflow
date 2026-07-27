import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentErrorResponse, AgentResponse, CreateTaskRequest } from '@canvasflow/schema'
import { AgentGateway } from './gateway'
import { createAgentHttpServer, writeTaskUpdates, type SseWritable } from './http'
import { ModelGateway } from './model-gateway'
import { PersistentAgentRuntime } from './persistent'
import { MemoryTaskStore } from './store'

const now = '2026-07-22T12:00:00+08:00'
const servers: Server[] = []
const streamReaders: ReadableStreamDefaultReader<Uint8Array>[] = []
const persistentRuntimes: PersistentAgentRuntime[] = []
const temporaryDirectories: string[] = []

function createRequest(text = '接妈妈，航班 MU5102', clientRequestId = 'create-001'): CreateTaskRequest {
  return {
    clientRequestId,
    input: { type: 'text', text },
    vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: true },
    clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: true },
  }
}

async function startServer(options: { bodyLimitBytes?: number; eventPollIntervalMs?: number; heartbeatIntervalMs?: number } = {}) {
  let id = 0
  const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => `http-${String(++id).padStart(3, '0')}` })
  const server = createAgentHttpServer(gateway, { ...options, createRequestId: () => 'generated-http-request' })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { gateway, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function startPersistentServer(options: Omit<ConstructorParameters<typeof PersistentAgentRuntime>[0], 'databasePath' | 'now'> & { databasePath?: string } = {}) {
  const { databasePath = ':memory:', ...runtimeOptions } = options
  const runtime = new PersistentAgentRuntime({ databasePath, now: () => now, ...runtimeOptions })
  persistentRuntimes.push(runtime)
  const server = createAgentHttpServer(runtime, { createRequestId: () => 'persistent-http-request' })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { runtime, baseUrl: `http://127.0.0.1:${address.port}` }
}

function streamId(taskId: string, cursor: number): string {
  return `${Buffer.from(taskId).toString('base64url')}.${cursor}`
}

async function readStreamChunk(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  streamReaders.push(reader)
  const { value } = await reader.read()
  return new TextDecoder().decode(value)
}

async function readStreamThrough(response: Response, marker: string): Promise<string> {
  const reader = response.body!.getReader()
  streamReaders.push(reader)
  const decoder = new TextDecoder()
  let content = ''
  while (!content.includes(marker)) {
    const { value, done } = await reader.read()
    if (done) break
    content += decoder.decode(value, { stream: true })
  }
  return content + decoder.decode()
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const clientRequestId = typeof body === 'object' && body !== null && 'clientRequestId' in body
    ? (body as { clientRequestId?: unknown }).clientRequestId
    : undefined
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(typeof clientRequestId === 'string' ? { 'x-request-id': clientRequestId } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

afterEach(async () => {
  await Promise.all(streamReaders.splice(0).map((reader) => reader.cancel().catch(() => undefined)))
  for (const server of servers) server.closeAllConnections()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
  for (const runtime of persistentRuntimes.splice(0)) runtime.close()
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('Agent HTTP API', () => {
  it('creates, retrieves, and replays a task without changing the original result', async () => {
    const { baseUrl } = await startServer()
    const request = createRequest()
    const createdResponse = await post(baseUrl, '/v1/tasks', request, { 'x-request-id': request.clientRequestId })
    const created = await createdResponse.json() as AgentResponse
    expect(createdResponse.status).toBe(201)
    expect(createdResponse.headers.get('x-request-id')).toBe(request.clientRequestId)
    expect(createdResponse.headers.get('location')).toBe('/v1/tasks/pickup-http-001')
    expect(created).toMatchObject({ requestId: request.clientRequestId, task: { taskId: 'pickup-http-001', phase: 'preparing' } })

    const fetchedResponse = await fetch(`${baseUrl}/v1/tasks/${created.task.taskId}`, { headers: { 'x-request-id': 'get-001' } })
    const fetched = await fetchedResponse.json() as AgentResponse
    expect(fetchedResponse.status).toBe(200)
    expect(fetchedResponse.headers.get('x-request-id')).toBe('get-001')
    expect(fetched.task).toEqual(created.task)

    const replayResponse = await post(baseUrl, '/v1/tasks', request, { 'x-request-id': request.clientRequestId })
    const replay = await replayResponse.json() as AgentResponse
    expect(replayResponse.status).toBe(200)
    expect(replay.task).toEqual(created.task)
    expect(replay.ui).toEqual(created.ui)
  })

  it('routes event, action, confirmation, cancellation, and reset requests', async () => {
    const { baseUrl } = await startServer()
    const created = await (await post(baseUrl, '/v1/tasks', createRequest())).json() as AgentResponse
    const taskId = created.task.taskId

    const eventResponse = await post(baseUrl, `/v1/tasks/${taskId}/events`, {
      clientRequestId: 'event-001', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'event-provider-timeout', type: 'provider.timeout', provider: 'flight.get-status', timestamp: now },
    }, { 'x-request-id': 'event-001' })
    expect(eventResponse.status).toBe(200)
    const afterEvent = await eventResponse.json() as AgentResponse
    expect(afterEvent.requestId).toBe('event-001')

    const actionResponse = await post(baseUrl, `/v1/tasks/${taskId}/actions`, {
      clientRequestId: 'action-001', expectedTaskRevision: afterEvent.task.taskRevision,
      expectedUiRevision: afterEvent.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'start-navigation-001',
    })
    expect(actionResponse.status).toBe(200)
    const afterAction = await actionResponse.json() as AgentResponse
    expect(afterAction.task.phase).toBe('driving-to-airport')

    const confirmationResponse = await post(baseUrl, `/v1/tasks/${taskId}/confirmations/missing-confirmation`, {
      clientRequestId: 'confirmation-001', expectedTaskRevision: afterAction.task.taskRevision,
      decision: 'accept', idempotencyKey: 'confirmation-key-001',
    }, { 'x-request-id': 'confirmation-001' })
    expect(confirmationResponse.status).toBe(410)
    expect(await confirmationResponse.json()).toMatchObject({ requestId: 'confirmation-001', error: { code: 'CONFIRMATION_EXPIRED' }, latest: { task: { taskId } } })

    const cancelResponse = await post(baseUrl, `/v1/tasks/${taskId}/cancel`, {
      clientRequestId: 'cancel-001', expectedTaskRevision: afterAction.task.taskRevision, eventId: 'cancel-event-001', reason: '用户取消',
    })
    expect(cancelResponse.status).toBe(200)
    const cancelled = await cancelResponse.json() as AgentResponse
    expect(cancelled.task.phase).toBe('cancelled')

    const resetResponse = await post(baseUrl, `/v1/tasks/${taskId}/reset`, {
      clientRequestId: 'reset-001', expectedTaskRevision: cancelled.task.taskRevision,
    })
    expect(resetResponse.status).toBe(200)
    const reset = await resetResponse.json() as AgentResponse
    expect(reset.task).toMatchObject({ taskId, phase: 'collecting-information' })
    expect(reset.task.flight).toBeUndefined()
    expect(reset.task.taskRevision).toBe(cancelled.task.taskRevision + 1)

    const createRetry = await post(baseUrl, '/v1/tasks', createRequest())
    expect(createRetry.status).toBe(200)
    expect((await createRetry.json()).task).toEqual(reset.task)
  })

  it('returns one error shape for invalid requests, missing tasks, and revision conflicts', async () => {
    const { baseUrl } = await startServer()
    const invalidResponse = await post(baseUrl, '/v1/tasks', { clientRequestId: 'invalid-001' }, { 'x-request-id': 'invalid-001' })
    const invalid = await invalidResponse.json() as AgentErrorResponse
    expect(invalidResponse.status).toBe(400)
    expect(invalid).toMatchObject({ requestId: 'invalid-001', error: { code: 'INVALID_REQUEST', retryable: false } })
    expect(invalid.error.details).toHaveProperty('issues')

    const missingResponse = await fetch(`${baseUrl}/v1/tasks/missing`, { headers: { 'x-request-id': 'missing-001' } })
    expect(missingResponse.status).toBe(404)
    expect(await missingResponse.json()).toMatchObject({ requestId: 'missing-001', error: { code: 'TASK_NOT_FOUND' } })

    const created = await (await post(baseUrl, '/v1/tasks', createRequest())).json() as AgentResponse
    const conflictResponse = await post(baseUrl, `/v1/tasks/${created.task.taskId}/events`, {
      clientRequestId: 'conflict-001', expectedTaskRevision: created.task.taskRevision + 1,
      event: { eventId: 'late-input', type: 'user.input', text: 'MU5102', timestamp: now },
    }, { 'x-request-id': 'conflict-001' })
    expect(conflictResponse.status).toBe(409)
    expect(await conflictResponse.json()).toMatchObject({ requestId: 'conflict-001', error: { code: 'TASK_REVISION_CONFLICT' }, latest: { task: created.task } })
  })

  it('preserves INVALID_REQUEST responses when the persistent runtime preflights async model planning', async () => {
    const { baseUrl } = await startPersistentServer()
    const invalidCreate = await post(baseUrl, '/v1/tasks', { clientRequestId: 'persistent-invalid-create' })
    expect(invalidCreate.status).toBe(400)
    await expect(invalidCreate.json()).resolves.toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    })

    const created = await (await post(baseUrl, '/v1/tasks', createRequest('接妈妈，航班 MU5102', 'persistent-create'))).json() as AgentResponse
    const invalidEvent = await post(baseUrl, `/v1/tasks/${created.task.taskId}/events`, {
      clientRequestId: 'persistent-invalid-event',
    })
    expect(invalidEvent.status).toBe(400)
    await expect(invalidEvent.json()).resolves.toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    })
  })

  it('returns a replay response when a duplicate create joins an async model preflight', async () => {
    let startedPlanning: (() => void) | undefined
    let releasePlanning: ((value: unknown) => void) | undefined
    const planningStarted = new Promise<void>((resolve) => { startedPlanning = resolve })
    const modelOutput = new Promise<unknown>((resolve) => { releasePlanning = resolve })
    const modelGateway = new ModelGateway({
      adapter: {
        modelId: 'waiting-model',
        plan: vi.fn(async () => {
          startedPlanning!()
          return modelOutput
        }),
      },
    })
    const { baseUrl, runtime } = await startPersistentServer({ createId: () => 'concurrent', modelGateway })
    const createTaskWithStatus = vi.spyOn(runtime, 'createTaskWithStatusAsync')
    const request = createRequest('劳驾替我去航站楼把妈妈接回来', 'concurrent-create')

    const first = post(baseUrl, '/v1/tasks', request)
    await planningStarted
    const replay = post(baseUrl, '/v1/tasks', request)
    await vi.waitFor(() => expect(createTaskWithStatus).toHaveBeenCalledTimes(2))
    releasePlanning!({
      confidence: 0.95,
      canonicalInput: '去机场接妈妈',
      intentHint: 'create-airport-pickup',
      evidence: { passengers: ['妈妈'] },
    })

    const [createdResponse, replayResponse] = await Promise.all([first, replay])
    expect(createdResponse.status).toBe(201)
    expect(createdResponse.headers.get('location')).toBe('/v1/tasks/pickup-concurrent')
    expect(replayResponse.status).toBe(200)
    expect(replayResponse.headers.get('location')).toBeNull()
    const created = await createdResponse.json() as AgentResponse
    const replayed = await replayResponse.json() as AgentResponse
    expect(replayed).toMatchObject({ task: created.task, ui: created.ui, effects: created.effects })
  })

  it('returns a replay response when another persistent runtime wins the shared SQLite create', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvasflow-http-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'agent.sqlite')
    let startedPlanning: (() => void) | undefined
    let releasePlanning: ((value: unknown) => void) | undefined
    const planningStarted = new Promise<void>((resolve) => { startedPlanning = resolve })
    const modelOutput = new Promise<unknown>((resolve) => { releasePlanning = resolve })
    const slowModel = new ModelGateway({
      adapter: {
        modelId: 'slow-model',
        plan: vi.fn(async () => {
          startedPlanning!()
          return modelOutput
        }),
      },
    })
    const first = await startPersistentServer({ databasePath, createId: () => 'first', modelGateway: slowModel })
    const second = await startPersistentServer({ databasePath, createId: () => 'second' })
    const request = createRequest('劳驾替我去航站楼把妈妈接回来', 'cross-runtime-create')

    const delayed = post(first.baseUrl, '/v1/tasks', request)
    await planningStarted
    const created = await post(second.baseUrl, '/v1/tasks', request)
    releasePlanning!({
      confidence: 0.95,
      canonicalInput: '去机场接妈妈',
      intentHint: 'create-airport-pickup',
      evidence: { passengers: ['妈妈'] },
    })
    const replay = await delayed

    expect(created.status).toBe(201)
    expect(created.headers.get('location')).toBe('/v1/tasks/pickup-second')
    expect(replay.status).toBe(200)
    expect(replay.headers.get('location')).toBeNull()
    const createdResponse = await created.json() as AgentResponse
    const replayedResponse = await replay.json() as AgentResponse
    expect(replayedResponse).toMatchObject({ task: createdResponse.task, ui: createdResponse.ui, effects: createdResponse.effects })
  })

  it('preserves each caller request ID when duplicate events join an async model preflight', async () => {
    let startedPlanning: (() => void) | undefined
    let releasePlanning: ((value: unknown) => void) | undefined
    const planningStarted = new Promise<void>((resolve) => { startedPlanning = resolve })
    const modelOutput = new Promise<unknown>((resolve) => { releasePlanning = resolve })
    const modelGateway = new ModelGateway({
      adapter: {
        modelId: 'waiting-event-model',
        plan: vi.fn(async () => {
          startedPlanning!()
          return modelOutput
        }),
      },
    })
    const { baseUrl, runtime } = await startPersistentServer({ modelGateway })
    const created = await (await post(baseUrl, '/v1/tasks', createRequest())).json() as AgentResponse
    const submitEvent = vi.spyOn(runtime, 'submitEventAsync')
    const event = {
      eventId: 'duplicate-unknown-input', type: 'user.input' as const, text: '完全未知的表达', timestamp: '2026-07-22T12:01:00+08:00',
    }
    const first = post(baseUrl, `/v1/tasks/${created.task.taskId}/events`, {
      clientRequestId: 'event-first', expectedTaskRevision: created.task.taskRevision, event,
    })
    await planningStarted
    const replay = post(baseUrl, `/v1/tasks/${created.task.taskId}/events`, {
      clientRequestId: 'event-retry', expectedTaskRevision: created.task.taskRevision, event,
    })
    await vi.waitFor(() => expect(submitEvent).toHaveBeenCalledTimes(2))
    releasePlanning!({
      confidence: 0.2,
      canonicalInput: '去机场接妈妈',
      intentHint: 'create-airport-pickup',
      evidence: { passengers: ['妈妈'] },
    })

    const [firstResponse, replayResponse] = await Promise.all([first, replay])
    expect(firstResponse.status).toBe(200)
    expect(replayResponse.status).toBe(200)
    const firstBody = await firstResponse.json() as AgentResponse
    const replayBody = await replayResponse.json() as AgentResponse
    expect(firstBody.requestId).toBe('event-first')
    expect(replayBody.requestId).toBe('event-retry')
    expect(replayBody).toMatchObject({ task: firstBody.task, ui: firstBody.ui, effects: firstBody.effects })
  })

  it('rejects malformed transport input and enforces the body limit', async () => {
    const { baseUrl } = await startServer({ bodyLimitBytes: 64 })
    const contentTypeResponse = await fetch(`${baseUrl}/v1/tasks`, { method: 'POST', body: '{}' })
    expect(contentTypeResponse.status).toBe(400)
    expect(await contentTypeResponse.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } })

    const malformedResponse = await post(baseUrl, '/v1/tasks', '{')
    expect(malformedResponse.status).toBe(400)
    expect(await malformedResponse.json()).toMatchObject({ error: { message: 'Request body must be valid JSON' } })

    const oversizedResponse = await post(baseUrl, '/v1/tasks', { clientRequestId: 'large-001', input: { text: 'x'.repeat(100) } })
    expect(oversizedResponse.status).toBe(413)
    expect(await oversizedResponse.json()).toMatchObject({ requestId: 'large-001', error: { code: 'INVALID_REQUEST' } })

    const methodResponse = await fetch(`${baseUrl}/v1/tasks`, { method: 'PUT' })
    expect(methodResponse.status).toBe(405)
    expect(methodResponse.headers.get('allow')).toBe('GET, POST')
    expect((await fetch(`${baseUrl}/v1/unknown`)).status).toBe(404)
  })

  it('keeps the transport surface scoped to the canonical /v1 prefix', async () => {
    const { baseUrl } = await startServer()
    const response = await post(baseUrl, '/api/v1/tasks', createRequest('接爸爸，航班 MU5102', 'alias-001'))
    expect(response.status).toBe(404)
  })

  it('streams the exact current snapshot frame and never exposes private stored fields', async () => {
    const { baseUrl } = await startServer()
    const created = await (await post(baseUrl, '/v1/tasks', createRequest())).json() as AgentResponse
    const response = await fetch(`${baseUrl}/v1/tasks/${created.task.taskId}/events`, {
      headers: { accept: 'text/event-stream' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    const chunk = await readStreamChunk(response)
    const envelope = { type: 'task.updated', cursor: 1, taskId: created.task.taskId, snapshot: { task: created.task, ui: created.ui } }
    expect(chunk).toBe(`id: ${streamId(created.task.taskId, 1)}\nevent: task.updated\ndata: ${JSON.stringify(envelope)}\n\n`)
    expect(chunk).not.toContain('toolResults')
    expect(chunk).not.toContain('requestContext')
    await streamReaders.at(-1)?.cancel()
  })

  it('exclusively replays ordered updates after a task-bound Last-Event-ID', async () => {
    const { gateway, baseUrl } = await startServer()
    const created = await (await post(baseUrl, '/v1/tasks', createRequest())).json() as AgentResponse
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'moving', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'moving', type: 'vehicle.moving', speedKph: 80, timestamp: '2026-07-22T12:01:00+08:00' },
    })
    gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'parked', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    const response = await fetch(`${baseUrl}/v1/tasks/${created.task.taskId}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': streamId(created.task.taskId, 1) },
    })
    const chunk = await readStreamThrough(response, `id: ${streamId(created.task.taskId, 3)}\n`)
    expect(chunk).not.toContain(`id: ${streamId(created.task.taskId, 1)}\n`)
    expect(chunk.indexOf(`id: ${streamId(created.task.taskId, 2)}\n`)).toBeGreaterThanOrEqual(0)
    expect(chunk.indexOf(`id: ${streamId(created.task.taskId, 3)}\n`)).toBeGreaterThan(
      chunk.indexOf(`id: ${streamId(created.task.taskId, 2)}\n`),
    )
    await streamReaders.at(-1)?.cancel()
  })

  it('rejects invalid, foreign-task, and future Last-Event-ID values before SSE headers', async () => {
    const { baseUrl } = await startServer()
    const first = await (await post(baseUrl, '/v1/tasks', createRequest('接妈妈，航班 MU5102', 'first'))).json() as AgentResponse
    const second = await (await post(baseUrl, '/v1/tasks', createRequest('接爸爸，航班 MU5102', 'second'))).json() as AgentResponse
    for (const value of ['bad', streamId(second.task.taskId, 1), streamId(first.task.taskId, 99)]) {
      const response = await fetch(`${baseUrl}/v1/tasks/${first.task.taskId}/events`, {
        headers: { accept: 'text/event-stream', 'last-event-id': value },
      })
      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
    }
    const missingAccept = await fetch(`${baseUrl}/v1/tasks/${first.task.taskId}/events`)
    expect(missingAccept.status).toBe(400)
    expect(missingAccept.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const missingTask = await fetch(`${baseUrl}/v1/tasks/missing/events`, { headers: { accept: 'text/event-stream' } })
    expect(missingTask.status).toBe(404)
    expect(missingTask.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })

  it('sends heartbeats and cleans up a disconnected stream so the server can close', async () => {
    const { baseUrl } = await startServer({ heartbeatIntervalMs: 10 })
    const created = await (await post(baseUrl, '/v1/tasks', createRequest())).json() as AgentResponse
    const response = await fetch(`${baseUrl}/v1/tasks/${created.task.taskId}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': streamId(created.task.taskId, 1) },
    })
    expect(await readStreamChunk(response)).toBe(': heartbeat\n\n')
    await streamReaders.at(-1)?.cancel()
  })

  it('waits for drain before writing the next update without dropping or reordering frames', async () => {
    class BackpressuredWritable extends EventEmitter {
      readonly chunks: string[] = []

      write(chunk: string): boolean {
        this.chunks.push(chunk)
        return this.chunks.length !== 1
      }
    }
    const writable = new BackpressuredWritable()
    const updates = [1, 2].map((cursor) => ({
      type: 'task.updated' as const,
      cursor,
      taskId: 'task-backpressure',
      snapshot: {
        task: { taskId: 'task-backpressure' },
        ui: { taskId: 'task-backpressure' },
      },
    }))
    const writing = writeTaskUpdates(writable as SseWritable, {
      updates: updates as never,
      latestCursor: 2,
      staleCursor: false,
    })

    await Promise.resolve()
    expect(writable.chunks).toHaveLength(1)
    let completed = false
    void writing.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)

    writable.emit('drain')
    await expect(writing).resolves.toBe(2)
    expect(writable.chunks).toHaveLength(2)
    expect(writable.chunks[0]).toContain('id: dGFzay1iYWNrcHJlc3N1cmU.1\n')
    expect(writable.chunks[1]).toContain('id: dGFzay1iYWNrcHJlc3N1cmU.2\n')
  })
})
