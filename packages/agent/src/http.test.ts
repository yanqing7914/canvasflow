import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentErrorResponse, AgentResponse, CreateTaskRequest } from '@canvasflow/schema'
import { AgentGateway } from './gateway'
import { createAgentHttpServer } from './http'
import { MemoryTaskStore } from './store'

const now = '2026-07-22T12:00:00+08:00'
const servers: Server[] = []

function createRequest(text = '接妈妈，航班 MU5102', clientRequestId = 'create-001'): CreateTaskRequest {
  return {
    clientRequestId,
    input: { type: 'text', text },
    vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: true },
    clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: true },
  }
}

async function startServer(options: { bodyLimitBytes?: number } = {}) {
  const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => 'http-001' })
  const server = createAgentHttpServer(gateway, { ...options, createRequestId: () => 'generated-http-request' })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { gateway, baseUrl: `http://127.0.0.1:${address.port}` }
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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
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
})
