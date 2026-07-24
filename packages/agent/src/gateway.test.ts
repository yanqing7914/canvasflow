import { describe, expect, it } from 'vitest'
import { createSideEffectRuntime } from '@canvasflow/tools'
import { AgentGateway, AgentGatewayError } from './gateway'
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
    expect(updated.ui.components).toMatchObject([{ type: 'flight-status' }])
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
    expect(prepared.ui.components).toContainEqual(expect.objectContaining({ id: 'flight-status', actions: ['start-navigation'] }))

    const request = {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: prepared.task.taskRevision,
      expectedUiRevision: prepared.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'flight-status',
      idempotencyKey: 'start-navigation-001',
    }
    const started = gateway.submitAction(created.task.taskId, request)
    const duplicate = gateway.submitAction(created.task.taskId, { ...request, clientRequestId: 'client-start-navigation-retry' })

    expect(started.task).toMatchObject({ phase: 'driving-to-airport', taskRevision: 2, navigation: { routeId: 'route-airport-pickup-001' } })
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
      componentId: 'flight-status',
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
    expect(current.navigation).toBeUndefined()
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

  it('retries a failed landing message through action → confirmation → send', () => {
    const runtime = createSideEffectRuntime()
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => '001',
      runtime,
    })
    const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'flight-status',
      idempotencyKey: 'start-navigation-001',
    })
    const landed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight-landed',
      expectedTaskRevision: started.task.taskRevision,
      event: {
        eventId: 'flight-landed',
        type: 'flight.updated',
        flight: {
          flightNumber: 'MU5102',
          status: 'landed',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T20:40:00+08:00',
          terminal: 'T2',
        },
        timestamp: '2026-07-22T20:40:00+08:00',
      },
    })
    expect(landed.task.message).toMatchObject({ status: 'scheduled', pendingContactId: 'contact-mom' })

    const failed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-message-failed',
      expectedTaskRevision: landed.task.taskRevision,
      event: {
        eventId: 'message-failed',
        type: 'message.failed',
        messageId: landed.task.message.pendingMessageId!,
        errorCode: 'SEND_FAILED',
        timestamp: '2026-07-22T20:41:00+08:00',
      },
    })
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({
      id: 'retry-landing-message',
      event: { type: 'tool-request', actionToken: 'pickup-001:retry-landing-message' },
    }))
    expect(failed.ui.components).toContainEqual(expect.objectContaining({
      id: 'message-preview',
      actions: ['retry-landing-message'],
    }))

    const armed = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-retry-landing',
      expectedTaskRevision: failed.task.taskRevision,
      expectedUiRevision: failed.ui.uiRevision,
      actionId: 'retry-landing-message',
      componentId: 'message-preview',
      idempotencyKey: 'retry-landing-001',
    })
    expect(armed.task.pendingConfirmation).toMatchObject({ action: 'send-message' })
    expect(armed.task.message).toMatchObject({
      status: 'failed',
      pendingContactId: 'contact-mom',
      idempotencyKey: 'pickup-001:MU5102:landing',
    })
    expect(armed.ui.actions).toContainEqual(expect.objectContaining({
      id: 'confirm-retry-landing-message',
      event: {
        type: 'confirmation',
        confirmationId: armed.task.pendingConfirmation!.confirmationId,
        decision: 'accept',
      },
    }))

    const sent = gateway.submitConfirmation(
      created.task.taskId,
      armed.task.pendingConfirmation!.confirmationId,
      {
        clientRequestId: 'client-confirm-retry',
        expectedTaskRevision: armed.task.taskRevision,
        decision: 'accept',
        idempotencyKey: 'confirm-retry-001',
      },
    )
    expect(sent.task.message).toMatchObject({ status: 'sent', landingNoticeSent: true })
    expect(sent.task.pendingConfirmation).toBeUndefined()
    expect(sent.effects).toMatchObject([{ type: 'message.send', status: 'succeeded', tool: 'message.send' }])
    expect(sent.ui.actions.some((action) => action.id === 'retry-landing-message')).toBe(false)
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
    expectedUiRevision: prepared.ui.uiRevision, actionId: 'start-navigation', componentId: 'flight-status', idempotencyKey: navigationIdempotencyKey,
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
