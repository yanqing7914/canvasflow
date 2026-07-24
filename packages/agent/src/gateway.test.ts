import { describe, expect, it } from 'vitest'
import { AgentGateway, AgentGatewayError } from './gateway'
import { ReadToolOrchestrator } from './orchestration'
import { MemoryTaskStore } from './store'

const now = '2026-07-22T12:00:00+08:00'

function createGateway() {
  return new AgentGateway({
    store: new MemoryTaskStore(),
    now: () => now,
    createId: () => '001',
  })
}

function createRequest(text = '我现在要去机场接妈妈和豆豆') {
  return {
    clientRequestId: 'client-create',
    input: { type: 'text' as const, text },
    vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P' as const, isNight: true },
    clientCapabilities: { uiSchemaVersion: '1.0' as const, supportsSse: true, supportsTts: true },
  }
}

describe('AgentGateway', () => {
  it('creates a recoverable task and asks for the missing flight number', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())

    expect(created.task).toMatchObject({
      taskId: 'pickup-001',
      phase: 'collecting-information',
      passengers: { names: ['妈妈', '豆豆'] },
      taskRevision: 0,
      uiRevision: 1,
    })
    expect(created.assistant?.text).toContain('航班号')
    expect(gateway.getTask(created.task.taskId).task).toEqual(created.task)
  })

  it.each([
    ['MU5102', 'MU5102'],
    ['MU 5102', 'MU5102'],
    ['MU-5102', 'MU5102'],
    ['mu 5102', 'MU5102'],
  ])('normalizes %s in the initial task request', (input, expectedFlightNumber) => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest(`我现在要去机场接妈妈和豆豆，航班 ${input}`))

    expect(created.task.flight?.flightNumber).toBe(expectedFlightNumber)
    expect(created.task.phase).toBe('preparing')
  })

  it.each(['MU', 'MU51', '接机航班是 5102'])('does not create a flight from invalid input %s', (input) => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest(`我现在要去机场接妈妈和豆豆，${input}`))

    expect(created.task.flight).toBeUndefined()
  })

  it('returns the original task for a retried create request', () => {
    const gateway = createGateway()
    const first = gateway.createTask(createRequest())
    gateway.submitEvent(first.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: first.task.taskRevision,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    const retry = gateway.createTask(createRequest())

    expect(retry.task).toEqual(first.task)
    expect(retry.ui).toEqual(first.ui)
    expect(retry.task.taskRevision).toBe(0)
  })

  it('accepts an event at the expected revision and publishes a new UI', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task).toMatchObject({ phase: 'preparing', taskRevision: 1, uiRevision: 2 })
    expect(updated.ui).toMatchObject({ phase: 'preparing', taskRevision: 1, uiRevision: 2 })
    expect(updated.ui.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'flight-status' }),
      expect.objectContaining({ type: 'navigation-summary' }),
      expect.objectContaining({ type: 'charging-recommendation' }),
    ]))
  })

  it('prepares one provider-backed transaction with trusted task and UI values', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task).toMatchObject({
      taskRevision: 1,
      flight: { flightNumber: 'MU5102', status: 'scheduled', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'planned' },
      charging: { recommended: true, status: 'planned' },
      message: { autoNotifyAuthorized: true },
    })
    expect(updated.ui.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'flight-status', props: expect.objectContaining({ scheduledArrival: '2026-07-22T20:30:00+08:00' }) }),
      expect.objectContaining({ id: 'navigation-plan', props: expect.objectContaining({ routeId: 'route-airport-001', distanceKm: 32 }) }),
      expect.objectContaining({ id: 'charging-plan', props: expect.objectContaining({ estimatedFinalBatteryPercent: 18 }) }),
    ]))
    expect(updated).not.toHaveProperty('toolResults')
  })

  it('leaves event state unchanged when provider preparation times out and remains retryable', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => '001', orchestrator: new ReadToolOrchestrator() })
    const created = gateway.createTask(createRequest())
    const request = {
      clientRequestId: 'client-timeout',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-timeout', type: 'user.input' as const, text: 'MU0000', timestamp: '2026-07-22T12:01:00+08:00' },
    }

    expect(() => gateway.submitEvent(created.task.taskId, request)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_TIMEOUT', retryable: true, latest: expect.objectContaining({ task: created.task }) }),
    )
    expect(gateway.getTask(created.task.taskId).task).toEqual(created.task)
    expect(() => gateway.submitEvent(created.task.taskId, request)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_TIMEOUT', retryable: true }),
    )
  })

  it('maps non-timeout provider failures without committing the event', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => '001' })
    const created = gateway.createTask(createRequest())

    expect(() => gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-provider-failed',
      expectedTaskRevision: 0,
      event: { eventId: 'unknown-flight', type: 'user.input', text: 'MU9999', timestamp: '2026-07-22T12:01:00+08:00' },
    })).toThrowError(expect.objectContaining({ code: 'PROVIDER_FAILED', retryable: false, latest: expect.objectContaining({ task: created.task }) }))
    expect(gateway.getTask(created.task.taskId).task).toEqual(created.task)
  })

  it('returns the current snapshot through revision conflict errors', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())

    expect(() => gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-stale',
      expectedTaskRevision: 3,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })).toThrowError(AgentGatewayError)

    try {
      gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-stale',
        expectedTaskRevision: 3,
        event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'TASK_REVISION_CONFLICT', latest: { task: created.task } })
    }
  })

  it('returns the first result when an event request is retried with its original revision', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const request = {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input' as const, text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    }
    const first = gateway.submitEvent(created.task.taskId, request)
    const duplicate = gateway.submitEvent(created.task.taskId, {
      ...request,
      clientRequestId: 'client-flight-duplicate',
    })

    expect(duplicate.task).toEqual(first.task)
    expect(duplicate.ui).toEqual(first.ui)
    expect(duplicate.effects).toEqual(first.effects)
  })

  it('registers and executes the current start-navigation action through the event pipeline', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const prepared = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(prepared.ui.actions).toContainEqual(expect.objectContaining({
      id: 'start-navigation',
      event: { type: 'tool-request', actionToken: 'start-navigation' },
    }))
    expect(prepared.ui.components).toContainEqual(expect.objectContaining({ id: 'navigation-plan', actions: ['start-navigation'] }))

    const request = {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: prepared.task.taskRevision,
      expectedUiRevision: prepared.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'start-navigation-001',
    }
    const started = gateway.submitAction(created.task.taskId, request)
    const duplicate = gateway.submitAction(created.task.taskId, { ...request, clientRequestId: 'client-start-navigation-retry' })

    expect(started.task).toMatchObject({ phase: 'driving-to-airport', taskRevision: 2, navigation: { routeId: 'route-airport-001' } })
    expect(started.effects).toMatchObject([{ type: 'navigation.start', tool: 'navigation.start' }])
    expect(duplicate.task).toEqual(started.task)
    expect(duplicate.ui).toEqual(started.ui)
    expect(duplicate.effects).toEqual(started.effects)
  })

  it('rejects stale and unregistered navigation actions with typed errors', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const prepared = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    const request = {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: prepared.task.taskRevision,
      expectedUiRevision: prepared.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'start-navigation-001',
    }

    expect(() => gateway.submitAction(created.task.taskId, { ...request, expectedUiRevision: 0 })).toThrowError(
      expect.objectContaining({ code: 'UI_REVISION_CONFLICT' }),
    )
    expect(() => gateway.submitAction(created.task.taskId, { ...request, expectedTaskRevision: 0 })).toThrowError(
      expect.objectContaining({ code: 'TASK_REVISION_CONFLICT' }),
    )
    expect(() => gateway.submitAction(created.task.taskId, { ...request, actionId: 'unknown-action' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    )
  })

  it('rejects externally submitted navigation events', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const prepared = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(() => gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-bypass-navigation',
      expectedTaskRevision: prepared.task.taskRevision,
      event: { eventId: 'bypass-navigation', type: 'navigation.started', routeId: 'untrusted-route', timestamp: '2026-07-22T12:02:00+08:00' },
    })).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }))

    const current = gateway.getTask(created.task.taskId).task
    expect(current).toMatchObject({ phase: 'preparing', taskRevision: prepared.task.taskRevision })
    expect(current.navigation).toMatchObject({ routeId: 'route-airport-001', status: 'planned' })
  })

  it('clears a current save-memory confirmation for accept and reject without effects in Fixture mode', () => {
    const acceptGateway = createGateway()
    const accepted = completeTask(acceptGateway)
    const acceptRequest = {
      clientRequestId: 'client-save-memory-accept',
      expectedTaskRevision: accepted.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-accept',
    } as const
    const acceptedResult = acceptGateway.submitConfirmation(accepted.taskId, 'pickup-001:save-memory', acceptRequest)
    const acceptedRetry = acceptGateway.submitConfirmation(accepted.taskId, 'pickup-001:save-memory', {
      ...acceptRequest,
      clientRequestId: 'client-save-memory-accept-retry',
    })

    expect(acceptedResult.task).toMatchObject({ taskRevision: accepted.taskRevision + 1, pendingConfirmation: undefined })
    expect(acceptedResult.effects).toEqual([])
    expect(acceptedRetry.task).toEqual(acceptedResult.task)
    expect(acceptedRetry.ui).toEqual(acceptedResult.ui)

    expect(() => acceptGateway.submitConfirmation(accepted.taskId, 'pickup-001:save-memory', {
      ...acceptRequest,
      clientRequestId: 'client-save-memory-reject-after-accept',
      decision: 'reject',
    })).toThrowError(expect.objectContaining({ code: 'TASK_REVISION_CONFLICT' }))

    const rejectGateway = createGateway()
    const rejected = completeTask(rejectGateway)
    const rejectedResult = rejectGateway.submitConfirmation(rejected.taskId, 'pickup-001:save-memory', {
      clientRequestId: 'client-save-memory-reject',
      expectedTaskRevision: rejected.taskRevision,
      decision: 'reject',
      idempotencyKey: 'save-memory-reject',
    })

    expect(rejectedResult.task).toMatchObject({ taskRevision: rejected.taskRevision + 1, pendingConfirmation: undefined })
    expect(rejectedResult.effects).toEqual([])
  })

  it('preserves trusted provider context when accepting save-memory confirmation', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => '001' })
    const completed = completeTask(gateway)

    gateway.submitConfirmation(completed.taskId, 'pickup-001:save-memory', {
      clientRequestId: 'client-save-memory-context',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-context',
    })

    expect(store.get(completed.taskId)?.toolResults?.['navigation.plan-route']).toMatchObject({
      ok: true,
      data: { routeId: 'route-airport-001' },
    })
  })

  it('does not reuse an action result for a confirmation with the same idempotency key', () => {
    const gateway = createGateway()
    const completed = completeTask(gateway, 'shared-idempotency-key')

    const confirmed = gateway.submitConfirmation(completed.taskId, 'pickup-001:save-memory', {
      clientRequestId: 'client-save-memory',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'shared-idempotency-key',
    })

    expect(confirmed.task).toMatchObject({ taskRevision: completed.taskRevision + 1, pendingConfirmation: undefined })
  })

  it('requires a current save-memory confirmation', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())

    expect(() => gateway.submitConfirmation(created.task.taskId, 'pickup-001:save-memory', {
      clientRequestId: 'client-save-memory',
      expectedTaskRevision: created.task.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-001',
    })).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_EXPIRED' }))
  })

  it('rejects a confirmation request with the wrong confirmation id', () => {
    const gateway = createGateway()
    const completed = completeTask(gateway)

    expect(() => gateway.submitConfirmation(completed.taskId, 'wrong-confirmation', {
      clientRequestId: 'client-save-memory',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-wrong-confirmation',
    })).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_EXPIRED' }))
  })

  it('rejects unknown task ids', () => {
    expect(() => createGateway().getTask('missing')).toThrowError(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    )
  })
})

function completeTask(gateway: AgentGateway, navigationIdempotencyKey = 'start-navigation-001') {
  const created = gateway.createTask(createRequest())
  const prepared = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-flight', expectedTaskRevision: 0,
    event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
  })
  const started = gateway.submitAction(created.task.taskId, {
    clientRequestId: 'client-start-navigation', expectedTaskRevision: prepared.task.taskRevision,
    expectedUiRevision: prepared.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: navigationIdempotencyKey,
  })
  const approaching = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-geofence', expectedTaskRevision: started.task.taskRevision,
    event: { eventId: 'geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
  })
  const waiting = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-parked', expectedTaskRevision: approaching.task.taskRevision,
    event: { eventId: 'parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
  })
  const returning = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-onboard', expectedTaskRevision: waiting.task.taskRevision,
    event: { eventId: 'onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
  })
  const completed = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-arrived', expectedTaskRevision: returning.task.taskRevision,
    event: { eventId: 'arrived', type: 'destination.arrived', destination: '家', timestamp: '2026-07-22T12:05:00+08:00' },
  })

  expect(completed.task.pendingConfirmation).toMatchObject({ action: 'save-memory' })
  return completed.task
}
