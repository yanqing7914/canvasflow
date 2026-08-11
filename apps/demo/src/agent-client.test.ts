import { describe, expect, it, vi } from 'vitest'
import {
  agentResponseSchema,
  type AgentErrorResponse,
  type AgentResponse,
} from '@canvasflow/schema'
import taskCreatedFixture from '../../../fixtures/airport-pickup/task-created.json'
import {
  AgentApiClient,
  AgentApiError,
  AgentApiProtocolError,
  demoVehicleContext,
  isNightAt,
  type TaskUpdateSource,
} from './agent-client'

const fixture = taskCreatedFixture as unknown as {
  expectedTaskState: AgentResponse['task']
  expectedUISpec: AgentResponse['ui']
}

function agentResponse(): AgentResponse {
  return agentResponseSchema.parse({
    requestId: 'server-request',
    task: fixture.expectedTaskState,
    ui: fixture.expectedUISpec,
    effects: [],
    meta: { mode: 'fixture', durationMs: 1, fallbackUsed: false },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

function client(fetchMock: ReturnType<typeof vi.fn>) {
  let id = 0
  return new AgentApiClient('/v1/', {
    fetch: fetchMock as unknown as typeof fetch,
    createId: () => `${++id}`,
    now: () => '2026-07-24T12:00:00.000Z',
  })
}

function taskUpdate(task: AgentResponse['task'], ui: AgentResponse['ui'], cursor = 1) {
  return { type: 'task.updated' as const, cursor, taskId: task.taskId, snapshot: { task, ui } }
}

describe('AgentApiClient', () => {
  it('creates a task with generated request context and parses the response', async () => {
    const result = agentResponse()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result, 201))
    const api = client(fetchMock)

    await expect(api.create('接妈妈，航班 MU5102', {
      source: 'voice', confidence: 0.96,
      destination: { id: 'destination-hongqiao-t2', name: '虹桥接机点' },
    })).resolves.toEqual(result)

    expect(fetchMock).toHaveBeenCalledWith('/v1/tasks', expect.objectContaining({ method: 'POST' }))
    expect(requestBody(fetchMock, 0)).toEqual({
      clientRequestId: 'create-1',
      input: { type: 'text', text: '接妈妈，航班 MU5102', source: 'voice', confidence: 0.96 },
      vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: false },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: true, supportsTts: true, cockpitVersion: '1' },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥接机点' },
    })
  })

  it('routes get, event, action, confirmation, cancel, and reset through canonical endpoints', async () => {
    const result = agentResponse()
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(result)))
    const api = client(fetchMock)

    await api.get('pickup/a')
    await api.event(result.task, { type: 'user.input', text: 'MU5102' })
    await api.action(result, 'start-navigation', 'navigation-plan')
    await api.confirmation(result.task, 'save/memory', 'accept')
    await api.cancel(result.task, '用户取消')
    await api.reset(result.task)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/v1/tasks/pickup%2Fa',
      '/v1/tasks/pickup-001/events',
      '/v1/tasks/pickup-001/actions',
      '/v1/tasks/pickup-001/confirmations/save%2Fmemory',
      '/v1/tasks/pickup-001/cancel',
      '/v1/tasks/pickup-001/reset',
    ])
    expect(requestBody(fetchMock, 1)).toMatchObject({
      clientRequestId: 'event-request-3',
      expectedTaskRevision: result.task.taskRevision,
      event: { eventId: 'event-2', timestamp: '2026-07-24T12:00:00.000Z', type: 'user.input', text: 'MU5102' },
    })
    expect(requestBody(fetchMock, 2)).toMatchObject({
      clientRequestId: 'action-request-5',
      idempotencyKey: 'action-4',
      expectedUiRevision: result.ui.uiRevision,
    })
    expect(requestBody(fetchMock, 3)).toMatchObject({
      clientRequestId: 'confirmation-request-7',
      idempotencyKey: 'confirmation-6',
      decision: 'accept',
    })
    expect(requestBody(fetchMock, 4)).toMatchObject({
      clientRequestId: 'cancel-request-8',
      eventId: 'cancel-event-9',
      reason: '用户取消',
    })
    expect(requestBody(fetchMock, 5)).toMatchObject({ clientRequestId: 'reset-request-10' })
  })

  it('preserves fixture event identity while still generating a request id', async () => {
    const result = agentResponse()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result))
    const api = client(fetchMock)

    await api.event(result.task, {
      eventId: 'fixture-event',
      timestamp: '2026-07-22T20:43:00+08:00',
      type: 'vehicle.entered-airport-geofence',
    })

    expect(requestBody(fetchMock, 0)).toMatchObject({
      clientRequestId: 'event-request-1',
      event: { eventId: 'fixture-event', timestamp: '2026-07-22T20:43:00+08:00' },
    })
  })

  it('throws a typed AgentApiError for canonical API errors', async () => {
    const payload: AgentErrorResponse = {
      requestId: 'conflict-1',
      error: { code: 'TASK_REVISION_CONFLICT', message: 'Task changed', retryable: false },
      latest: { task: fixture.expectedTaskState, ui: fixture.expectedUISpec },
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload, 409))
    const api = client(fetchMock)

    const error = await api.get('pickup-001').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(AgentApiError)
    expect(error).toMatchObject({ status: 409, code: 'TASK_REVISION_CONFLICT', requestId: 'conflict-1', latest: payload.latest })
  })

  it('rejects malformed success and error payloads as protocol errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ task: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500))
    const api = client(fetchMock)

    await expect(api.get('pickup-001')).rejects.toBeInstanceOf(AgentApiProtocolError)
    await expect(api.get('pickup-001')).rejects.toMatchObject({ status: 500 })
  })

  it('subscribes to validated task updates and closes the EventSource', () => {
    const listeners = new Map<string, EventListener>()
    const source: TaskUpdateSource = {
      addEventListener: (type, listener) => listeners.set(type, listener as EventListener),
      removeEventListener: (type) => listeners.delete(type),
      close: vi.fn(),
    }
    const eventSource = vi.fn(() => source)
    const fetchMock = vi.fn()
    const api = new AgentApiClient('/v1/', { fetch: fetchMock as unknown as typeof fetch, eventSource })
    const update = taskUpdate(agentResponse().task, agentResponse().ui)
    const onUpdate = vi.fn()
    const subscription = api.subscribeTaskUpdates('pickup-001', onUpdate)

    expect(eventSource).toHaveBeenCalledWith('/v1/tasks/pickup-001/events')
    listeners.get('task.updated')?.(new MessageEvent('task.updated', { data: JSON.stringify(update) }))
    listeners.get('task.updated')?.(new MessageEvent('task.updated', { data: '{' }))
    listeners.get('task.updated')?.(new MessageEvent('task.updated', { data: JSON.stringify({ ...update, taskId: 'other-task' }) }))
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(update)

    subscription.close()
    expect(source.close).toHaveBeenCalledOnce()
    expect(listeners).toEqual(new Map())
  })
})

describe('demo light conditions', () => {
  it('calls the hours before 06:00 and from 18:00 onward night, in local time', () => {
    // The boundaries are the whole point of the function, so they are what the
    // test pins: one minute either side of each, plus a midday control.
    expect(isNightAt(new Date(2026, 6, 24, 5, 59))).toBe(true)
    expect(isNightAt(new Date(2026, 6, 24, 6, 0))).toBe(false)
    expect(isNightAt(new Date(2026, 6, 24, 12, 0))).toBe(false)
    expect(isNightAt(new Date(2026, 6, 24, 17, 59))).toBe(false)
    expect(isNightAt(new Date(2026, 6, 24, 18, 0))).toBe(true)
    expect(isNightAt(new Date(2026, 6, 24, 23, 59))).toBe(true)
  })

  it('follows the clock on auto and ignores it when a light condition is pinned', () => {
    const noon = new Date(2026, 6, 24, 12, 0)
    const evening = new Date(2026, 6, 24, 20, 25)

    expect(demoVehicleContext('auto', noon).isNight).toBe(false)
    expect(demoVehicleContext('auto', evening).isNight).toBe(true)
    expect(demoVehicleContext('night', noon).isNight).toBe(true)
    expect(demoVehicleContext('day', evening).isNight).toBe(false)
  })

  it('changes nothing about the reading except the light condition', () => {
    const { isNight, ...rest } = demoVehicleContext('night', new Date(2026, 6, 24, 12, 0))
    expect(isNight).toBe(true)
    expect(rest).toEqual({ speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P' })
  })
})
