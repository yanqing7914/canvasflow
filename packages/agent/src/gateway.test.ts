import { describe, expect, it, vi } from 'vitest'
import { createProviderRegistry, createSideEffectRuntime } from '@canvasflow/tools'
import { AgentGateway, AgentGatewayError } from './gateway'
import { ReadToolOrchestrationError, ReadToolOrchestrator } from './orchestration'
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
  it('cancels and idempotently resets only the requested task', () => {
    let id = 0
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => `${++id}`,
    })
    const first = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const second = gateway.createTask({ ...createRequest('接爸爸，航班 MU5102'), clientRequestId: 'create-second' })

    const cancelled = gateway.cancelTask(first.task.taskId, {
      clientRequestId: 'cancel-first',
      expectedTaskRevision: first.task.taskRevision,
      eventId: 'cancel-event',
      reason: '用户取消',
    })
    const duplicateCancel = gateway.cancelTask(first.task.taskId, {
      clientRequestId: 'cancel-first-retry',
      expectedTaskRevision: first.task.taskRevision,
      eventId: 'cancel-event',
      reason: '用户取消',
    })
    expect(cancelled.task.phase).toBe('cancelled')
    expect(duplicateCancel.task).toEqual(cancelled.task)

    const reset = gateway.resetTask(first.task.taskId, {
      clientRequestId: 'reset-first',
      expectedTaskRevision: cancelled.task.taskRevision,
    })
    const duplicateReset = gateway.resetTask(first.task.taskId, {
      clientRequestId: 'reset-first',
      expectedTaskRevision: cancelled.task.taskRevision,
    })
    expect(reset.task.phase).toBe('collecting-information')
    expect(reset.task.taskRevision).toBe(cancelled.task.taskRevision + 1)
    expect(reset.task.uiRevision).toBeGreaterThan(cancelled.task.uiRevision)
    expect(duplicateReset.task).toEqual(reset.task)
    expect(gateway.createTask(createRequest('接妈妈，航班 MU5102')).task).toEqual(reset.task)
    expect(gateway.getTask(second.task.taskId).task).toEqual(second.task)
  })

  it('does not replay a non-cancel event when cancel uses the same external event id', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const afterEvent = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'ordinary-event',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'shared-event-id', type: 'provider.timeout', provider: 'flight.get-status', timestamp: now },
    })
    const cancelled = gateway.cancelTask(created.task.taskId, {
      clientRequestId: 'cancel-collision',
      expectedTaskRevision: afterEvent.task.taskRevision,
      eventId: 'shared-event-id',
    })
    expect(cancelled.task.phase).toBe('cancelled')
  })

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

  it('keeps low-confidence input recoverable without applying parsed slots', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      input: { type: 'text', text: '接妈妈，航班 MU5102', source: 'voice', confidence: 0.59 },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: false },
    })

    expect(created.task).toMatchObject({ phase: 'collecting-information', passengers: { memberIds: [] } })
    expect(created.task.flight).toBeUndefined()
    expect(created.assistant).toEqual({ text: '我不太确定刚才的内容，请确认或编辑后再试一次。', shouldSpeak: false })

    const corrected = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'correct-low-confidence',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'correct-low-confidence', type: 'user.input', text: '接妈妈', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(corrected.task.passengers).toMatchObject({ memberIds: ['mom'], names: ['妈妈'] })
    expect(corrected.task.taskRevision).toBe(created.task.taskRevision + 1)
    expect(corrected.assistant).toEqual({ text: '好的，请告诉我她们的航班号。', shouldSpeak: false })
  })

  it('does not let stale or terminal events mutate request context or passenger facts', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      vehicleContext: { speedKph: 80, batteryPercent: 90, remainingRangeKm: 240, gear: 'D', isNight: false },
    })
    const stale = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'stale-parked', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'stale-parked', type: 'vehicle.parked', timestamp: '2026-07-22T11:59:00+08:00' },
    })
    expect(stale.task).toEqual(created.task)
    expect(stale.ui).toEqual(created.ui)

    const cancelled = gateway.cancelTask(created.task.taskId, {
      clientRequestId: 'cancel-terminal-input', expectedTaskRevision: created.task.taskRevision,
      eventId: 'cancel-terminal-input',
    })
    const terminal = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'terminal-passenger', expectedTaskRevision: cancelled.task.taskRevision,
      event: { eventId: 'terminal-passenger', type: 'user.input', text: '接爸爸', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(terminal.task).toEqual(cancelled.task)
    expect(terminal.ui).toEqual(cancelled.ui)
  })

  it('uses vehicle context for charging and preserves presentation across events', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      vehicleContext: { speedKph: 0, batteryPercent: 90, remainingRangeKm: 240, gear: 'P', isNight: false },
    })

    expect(created.task.charging.recommended).toBe(false)
    expect(created.ui.presentation).toMatchObject({ density: 'full', theme: 'light' })
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'vehicle-moving', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'vehicle-moving', type: 'vehicle.moving', speedKph: 80, timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(moving.ui.presentation).toMatchObject({ density: 'minimal', theme: 'light' })
    const denied = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'moving-navigation', expectedTaskRevision: moving.task.taskRevision,
      expectedUiRevision: moving.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'moving-navigation',
    })
    expect(denied.task).toEqual(moving.task)
    expect(denied.effects).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'VEHICLE_MOVING' })])

    const parked = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'vehicle-parked', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'vehicle-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    expect(parked.ui.presentation).toMatchObject({ density: 'full', theme: 'light' })
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'parked-navigation', expectedTaskRevision: parked.task.taskRevision,
      expectedUiRevision: parked.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'parked-navigation',
    })
    expect(started.task.phase).toBe('driving-to-airport')
  })

  it('rejects stale parked context after a newer moving event without changing task facts', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      vehicleContext: { speedKph: 0, batteryPercent: 90, remainingRangeKm: 240, gear: 'P', isNight: false },
    })

    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'ordered-moving', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'ordered-moving', type: 'vehicle.moving', speedKph: 80, timestamp: '2026-07-22T12:02:00+08:00' },
    })
    expect(moving.task).toMatchObject({
      taskRevision: created.task.taskRevision,
      updatedAt: created.task.updatedAt,
      processedEventIds: created.task.processedEventIds,
    })
    expect(moving.task.processedEventIds).not.toContain('ordered-moving')
    expect(moving.ui.presentation.density).toBe('minimal')

    const staleParked = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'stale-ordered-parked', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'stale-ordered-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(staleParked.task).toEqual(moving.task)
    expect(staleParked.ui).toEqual(moving.ui)
    expect(staleParked.task.processedEventIds).not.toContain('stale-ordered-parked')

    const denied = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'stale-parked-navigation', expectedTaskRevision: staleParked.task.taskRevision,
      expectedUiRevision: staleParked.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'stale-parked-navigation',
    })
    expect(denied.effects).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'VEHICLE_MOVING' })])
  })

  it('advances event ordering for a context-only charging completion', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))

    const charged = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'context-charging-completed', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'context-charging-completed', type: 'charging.completed', batteryPercent: 88, timestamp: '2026-07-22T12:02:00+08:00' },
    })
    expect(charged.task).toMatchObject({
      taskRevision: created.task.taskRevision,
      updatedAt: created.task.updatedAt,
      processedEventIds: created.task.processedEventIds,
    })
    expect(charged.task.processedEventIds).not.toContain('context-charging-completed')

    const staleMoving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'stale-after-charging', expectedTaskRevision: charged.task.taskRevision,
      event: { eventId: 'stale-after-charging', type: 'vehicle.moving', speedKph: 80, timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(staleMoving.task).toEqual(charged.task)
    expect(staleMoving.ui).toEqual(charged.ui)
  })

  it('does not let a newer sensor watermark reject a valid task event', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈'))
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'future-sensor', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'future-sensor', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:02:00+08:00' },
    })

    const flight = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'task-after-sensor', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'task-after-sensor', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(flight.task).toMatchObject({ phase: 'preparing', flight: { flightNumber: 'MU5102' } })
    expect(flight.ui.presentation.density).toBe('compact')
  })

  it('does not let a newer moving watermark reject a valid parked phase transition', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'mixed-start', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'mixed-start',
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'mixed-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-moving', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'mixed-moving', type: 'vehicle.moving', speedKph: 20, timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const parked = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-parked', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'mixed-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:02:00+08:00' },
    })

    expect(parked.task.phase).toBe('waiting-for-passengers')
    expect(parked.ui.presentation.density).toBe('full')
  })

  it('does not let a newer moving watermark reject active charging completion', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'mixed-charge-navigation', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'mixed-charge-navigation',
    })
    const charging = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-charge-plan', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'mixed-charge-plan', type: 'user.input', text: '先去充电', timestamp: '2026-07-22T12:00:30+08:00' },
    })
    const active = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-charge-start', expectedTaskRevision: charging.task.taskRevision,
      event: { eventId: 'mixed-charge-start', type: 'charging.started', stationId: 'station-hongqiao-01', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-charge-moving', expectedTaskRevision: active.task.taskRevision,
      event: { eventId: 'mixed-charge-moving', type: 'vehicle.moving', speedKph: 10, timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const completed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-charge-completed', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'mixed-charge-completed', type: 'charging.completed', batteryPercent: 88, timestamp: '2026-07-22T12:02:00+08:00' },
    })

    expect(completed.task.charging).toMatchObject({ accepted: true, status: 'completed' })
    expect(completed.ui.components).toContainEqual(expect.objectContaining({
      type: 'charging-recommendation', props: expect.objectContaining({ currentBatteryPercent: 88 }),
    }))
  })

  it('persists a custom destination through passenger-first slot filling', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const planRoute = vi.fn(base['navigation.plan-route'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'navigation.plan-route': planRoute },
      orchestrator: new ReadToolOrchestrator({ registry: { ...base, 'navigation.plan-route': planRoute } }),
    })
    const created = gateway.createTask({
      ...createRequest('接妈妈'),
      destination: { id: 'destination-hongqiao-t2', name: '虹桥接机点' },
    })
    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'destination-flight', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'destination-flight', type: 'user.input', text: '航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(planRoute).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: created.task.taskId }),
      expect.objectContaining({ destination: { id: 'destination-hongqiao-t2', name: '虹桥接机点' } }),
    )
    expect(updated.task.navigation?.destination).toBe('虹桥接机点')
  })

  it('clears low-confidence guidance when fixture state is reset', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      input: { type: 'text', text: '接妈妈，航班 MU5102', source: 'voice', confidence: 0.2 },
    })

    const reset = gateway.resetTask(created.task.taskId, {
      clientRequestId: 'reset-low-confidence',
      expectedTaskRevision: created.task.taskRevision,
    })

    expect(reset.assistant?.text).toContain('航班号')
    expect(reset.assistant?.text).not.toContain('不太确定')
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

  it('fills passengers after a flight-first create request', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('航班 MU5102'))
    expect(created.task.phase).toBe('collecting-information')

    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-passenger',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'passenger-input', type: 'user.input', text: '接爸爸', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task).toMatchObject({
      phase: 'preparing',
      passengers: { memberIds: ['dad'], names: ['爸爸'] },
      flight: { flightNumber: 'MU5102' },
      navigation: { routeId: 'route-airport-001' },
    })
  })

  it('fills passengers after a passenger-first create request', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接爸爸'))
    expect(created.task).toMatchObject({ phase: 'collecting-information', passengers: { memberIds: ['dad'], names: ['爸爸'] } })

    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'flight-input', type: 'user.input', text: '航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task).toMatchObject({ phase: 'preparing', passengers: { names: ['爸爸'] }, flight: { flightNumber: 'MU5102' } })
  })

  it('preserves an authorized landing contact when an unauthorized passenger is added', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈'))
    expect(created.task.message.autoNotifyAuthorized).toBe(true)

    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-add-dad',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'add-dad', type: 'user.input', text: '接爸爸，航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task.passengers.names).toEqual(['妈妈', '爸爸'])
    expect(updated.task.message.autoNotifyAuthorized).toBe(true)
  })

  it('enables landing notification when an authorized passenger is added', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接爸爸'))
    expect(created.task.message.autoNotifyAuthorized).toBe(false)

    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-add-mom',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'add-mom', type: 'user.input', text: '接妈妈，航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task.passengers.names).toEqual(['爸爸', '妈妈'])
    expect(updated.task.message.autoNotifyAuthorized).toBe(true)
  })

  it('keeps unresolved passengers missing while still accepting the flight slot', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接叔叔，航班 MU5102'))

    expect(created.task).toMatchObject({ phase: 'collecting-information', flight: { flightNumber: 'MU5102' }, passengers: { memberIds: [], names: [] } })
    expect(created.assistant?.text).toContain('哪位家人')
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
      charging: { recommended: false, status: 'none' },
      message: { autoNotifyAuthorized: true },
    })
    expect(updated.ui.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'flight-status', props: expect.objectContaining({ scheduledArrival: '2026-07-22T20:30:00+08:00' }) }),
      expect.objectContaining({ id: 'navigation-plan', props: expect.objectContaining({ routeId: 'route-airport-001', distanceKm: 32 }) }),
      expect.objectContaining({ id: 'charging-plan', props: expect.objectContaining({ estimatedFinalBatteryPercent: 29 }) }),
    ]))
    expect(updated).not.toHaveProperty('toolResults')
  })

  it('leaves event state unchanged when provider preparation times out and returns deterministic fallback UI', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => '001', orchestrator: new ReadToolOrchestrator() })
    const created = gateway.createTask(createRequest())
    const request = {
      clientRequestId: 'client-timeout',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-timeout', type: 'user.input' as const, text: 'MU0000', timestamp: '2026-07-22T12:01:00+08:00' },
    }

    const first = gateway.submitEvent(created.task.taskId, request)
    expect(first.task).toMatchObject({
      uiRevision: created.task.uiRevision + 1,
      taskRevision: created.task.taskRevision,
      phase: created.task.phase,
    })
    expect(first.task.flight).toBeUndefined()
    expect(first.ui.meta.generatedBy).toBe('fallback')
    expect(first.meta.fallbackUsed).toBe(true)
    const duplicate = gateway.submitEvent(created.task.taskId, { ...request, clientRequestId: 'client-timeout-retry' })
    expect(duplicate.task).toEqual(first.task)
    expect(duplicate.ui).toEqual(first.ui)
    expect(duplicate.effects).toEqual(first.effects)
  })

  it('maps non-timeout provider failures to a deterministic fallback without committing the event', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => '001' })
    const created = gateway.createTask(createRequest())

    const failed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-provider-failed',
      expectedTaskRevision: 0,
      event: { eventId: 'unknown-flight', type: 'user.input', text: 'MU9999', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(failed.task).toMatchObject({
      uiRevision: created.task.uiRevision + 1,
      taskRevision: created.task.taskRevision,
      phase: created.task.phase,
    })
    expect(failed.task.flight).toBeUndefined()
    expect(failed.ui.meta.generatedBy).toBe('fallback')
    expect(failed.meta.fallbackUsed).toBe(true)
  })

  it('stores and replays the same fallback when initial trip preparation times out', () => {
    const gateway = createGateway()
    const request = createRequest('接妈妈，航班 MU0000')

    const first = gateway.createTask(request)
    const duplicate = gateway.createTask(request)

    expect(first.task).toMatchObject({
      taskRevision: 1,
      flight: { flightNumber: 'MU0000' },
      passengers: { memberIds: ['mom'], names: ['妈妈'] },
    })
    expect(first.ui.meta.generatedBy).toBe('fallback')
    expect(first.meta.fallbackUsed).toBe(true)
    expect(duplicate.task).toEqual(first.task)
    expect(duplicate.ui).toEqual(first.ui)
    expect(duplicate.effects).toEqual(first.effects)
  })

  it('preserves locally parsed passenger and flight facts when initial passenger lookup fails', () => {
    const base = new ReadToolOrchestrator()
    let passengerReads = 0
    const orchestrator = {
      resolveInitialPassengers: (taskId: string, requestId: string, labels: string[]) => {
        passengerReads += 1
        if (passengerReads === 1) throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'family timeout', true)
        return base.resolveInitialPassengers(taskId, requestId, labels)
      },
      prepareTrip: base.prepareTrip.bind(base),
      resolveReturnTripPreferences: base.resolveReturnTripPreferences.bind(base),
    }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator })
    const request = createRequest('接妈妈，航班 MU5102')

    const fallback = gateway.createTask(request)

    expect(fallback.task).toMatchObject({
      phase: 'preparing',
      passengers: { memberIds: ['mom'], names: ['妈妈'] },
      flight: { flightNumber: 'MU5102', trusted: false },
      message: { autoNotifyAuthorized: false },
    })
    expect(fallback.assistant).toBeUndefined()
    expect(fallback.meta.fallbackUsed).toBe(true)

    const recovered = gateway.submitEvent(fallback.task.taskId, {
      clientRequestId: 'client-create-retry',
      expectedTaskRevision: fallback.task.taskRevision,
      event: { eventId: 'retry-input', type: 'user.input', text: request.input.text, timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(recovered.meta.fallbackUsed).toBe(false)
    expect(recovered.task).toMatchObject({
      passengers: { memberIds: ['mom'], names: ['妈妈'] },
      flight: { flightNumber: 'MU5102' },
      navigation: { routeId: 'route-airport-001' },
      message: { autoNotifyAuthorized: true },
    })
  })

  it('preserves the previous task snapshot when incremental flight preparation fails', () => {
    const base = new ReadToolOrchestrator()
    const orchestrator = {
      resolveInitialPassengers: base.resolveInitialPassengers.bind(base),
      prepareTrip: () => { throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'flight timeout', true) },
      resolveReturnTripPreferences: base.resolveReturnTripPreferences.bind(base),
    }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator })
    const created = gateway.createTask(createRequest('接妈妈'))

    const fallback = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight-input',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'flight-input', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(fallback.meta.fallbackUsed).toBe(true)
    expect(fallback.task).toMatchObject({
      phase: created.task.phase,
      taskRevision: created.task.taskRevision,
      passengers: { memberIds: ['mom'], names: ['妈妈'] },
    })
    expect(fallback.task.flight).toBeUndefined()
    const duplicate = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight-input-retry',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'flight-input', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(duplicate.task).toEqual(fallback.task)
    expect(duplicate.ui).toEqual(fallback.ui)
  })

  it('returns deterministic fallback when incremental passenger resolution times out', () => {
    const base = new ReadToolOrchestrator()
    const orchestrator = {
      resolveInitialPassengers: (taskId: string, requestId: string, labels: string[]) => {
        if (labels.includes('爸爸')) throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'family timeout', true)
        return base.resolveInitialPassengers(taskId, requestId, labels)
      },
      prepareTrip: base.prepareTrip.bind(base),
      resolveReturnTripPreferences: base.resolveReturnTripPreferences.bind(base),
    }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator })
    const created = gateway.createTask(createRequest('航班 MU5102'))

    const fallback = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'passenger-timeout', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'passenger-timeout', type: 'user.input', text: '接爸爸', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(fallback.meta.fallbackUsed).toBe(true)
    expect(fallback.task.flight?.flightNumber).toBe('MU5102')
    expect(fallback.task.passengers.names).not.toContain('爸爸')
    expect(fallback.task.taskRevision).toBe(created.task.taskRevision)
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

  it('executes navigation.start before committing the navigation event', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const startNavigation = vi.fn(base['navigation.start'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => '001',
      runtime,
      providers: { ...base, 'navigation.start': startNavigation },
    })
    const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-provider-001',
    })

    expect(startNavigation).toHaveBeenCalledTimes(1)
    expect(startNavigation).toHaveBeenCalledWith(
      { taskId: created.task.taskId, requestId: 'pickup-001:navigation.start:nav-provider-001' },
      { routeId: 'route-airport-001', idempotencyKey: 'nav-provider-001' },
    )
    expect(started.task).toMatchObject({ phase: 'driving-to-airport', navigation: { status: 'active' } })
    expect(started.effects).toEqual([{
      effectId: 'action:nav-provider-001:0',
      type: 'navigation.start',
      status: 'succeeded',
      tool: 'navigation.start',
    }])

    const duplicate = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation-retry',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-provider-001',
    })
    expect(startNavigation).toHaveBeenCalledTimes(1)
    expect(duplicate.task).toEqual(started.task)
    expect(duplicate.effects).toEqual(started.effects)
  })

  it('executes the return-trip route, cabin, and media providers after passengers board', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const updateRoute = vi.fn(base['navigation.update-route'])
    const applyCabin = vi.fn(base['vehicle.apply-cabin-profile'])
    const playMedia = vi.fn(base['media.play'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'navigation.update-route': updateRoute, 'vehicle.apply-cabin-profile': applyCabin, 'media.play': playMedia },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'return-nav-start',
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'return-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    const waiting = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-parked', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'return-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const returning = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-onboard', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'return-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
    })

    expect(returning.task).toMatchObject({ phase: 'returning-home', passengers: { confirmedOnboard: true }, navigation: { destination: '家', status: 'active' } })
    expect(returning.effects).toEqual([
      { effectId: 'return-onboard:effect:0', type: 'navigation.update-route', status: 'succeeded', tool: 'navigation.update-route' },
      { effectId: 'return-onboard:effect:1', type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' },
      { effectId: 'return-onboard:effect:2', type: 'media.play', status: 'succeeded', tool: 'media.play' },
    ])
    expect(updateRoute).toHaveBeenCalledTimes(1)
    expect(applyCabin).toHaveBeenCalledTimes(1)
    expect(playMedia).toHaveBeenCalledTimes(1)
    expect(applyCabin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ zone: 'rear', temperatureC: 25, mediaTitle: '豆豆故事', sourceMemberIds: ['mom', 'doubao'] }))
    expect(playMedia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mediaTitle: '豆豆故事', sourceMemberId: 'doubao' }))

    const duplicate = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-onboard-retry', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'return-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
    })
    expect(duplicate.task).toEqual(returning.task)
    expect(updateRoute).toHaveBeenCalledTimes(1)
    expect(applyCabin).toHaveBeenCalledTimes(1)
    expect(playMedia).toHaveBeenCalledTimes(1)
  })

  it('keeps the original task snapshot when a later return-trip provider fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    let mediaCalls = 0
    const updateRoute = vi.fn(base['navigation.update-route'])
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'navigation.update-route': updateRoute,
        'vehicle.revert-cabin-profile': revertCabin,
        'media.play': (ctx, input) => {
          mediaCalls += 1
          if (mediaCalls === 1) return { ok: false, data: null, error: { code: 'MEDIA_UNAVAILABLE', message: 'offline', retryable: false }, meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'media.play', provider: 'fixture', durationMs: 1, generatedAt: now } }
          return base['media.play'](ctx, input)
        },
      },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 's', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 's' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'g', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'g', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'p', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'p', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    expect(waiting.task.phase).toBe('waiting-for-passengers')
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'o', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'o', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })
    expect(failed.task).toEqual(waiting.task)
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'media.play', status: 'failed', errorCode: 'MEDIA_UNAVAILABLE' }))
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'vehicle.revert-cabin-profile', status: 'succeeded' }))
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'navigation.update-route.rollback', status: 'succeeded' }))
    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(updateRoute).toHaveBeenCalledTimes(2)
    expect(updateRoute).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      routeId: 'route-airport-001',
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
    }))
    expect(failed.ui.components).toContainEqual(expect.objectContaining({
      type: 'status-banner',
      props: expect.objectContaining({ message: expect.stringContaining('返程操作已撤销') }),
    }))
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))
    const retry = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'o-retry', expectedTaskRevision: failed.task.taskRevision, expectedUiRevision: failed.ui.uiRevision,
      actionId: 'retry-return-trip', componentId: 'return-trip-provider-fallback', idempotencyKey: 'return-retry',
    })
    const duplicateRetry = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'o-retry-duplicate', expectedTaskRevision: failed.task.taskRevision, expectedUiRevision: failed.ui.uiRevision,
      actionId: 'retry-return-trip', componentId: 'return-trip-provider-fallback', idempotencyKey: 'return-retry',
    })
    expect(mediaCalls).toBe(2)
    expect(retry.task).toMatchObject({
      phase: 'returning-home',
      passengers: { confirmedOnboard: true },
      navigation: { routeId: 'route-home-001', destination: '家', status: 'active' },
    })
    expect(retry.task.returnTrip).toMatchObject({ route: { status: 'succeeded' }, cabin: { status: 'succeeded' }, media: { status: 'succeeded' } })
    expect(retry.effects).toContainEqual(expect.objectContaining({ type: 'media.play', status: 'succeeded' }))
    expect(duplicateRetry.task).toEqual(retry.task)
    expect(duplicateRetry.effects).toEqual(retry.effects)
  })

  it('publishes remaining side effects when compensation cannot restore navigation', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const updateRoute = vi.fn((ctx: { taskId: string; requestId?: string }, input: unknown) => {
      const parsed = input as { idempotencyKey: string }
      if (parsed.idempotencyKey.endsWith(':rollback:route')) {
        return {
          ok: false as const,
          data: null,
          error: { code: 'ROLLBACK_FAILED', message: 'cannot restore route', retryable: false },
          meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'navigation.update-route', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
        }
      }
      return base['navigation.update-route'](ctx, input)
    })
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'navigation.update-route': updateRoute,
        'media.play': (ctx) => ({
          ok: false as const,
          data: null,
          error: { code: 'MEDIA_UNAVAILABLE', message: 'offline', retryable: false },
          meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'media.play', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
        }),
      },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'rollback-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'rollback-start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'rollback-geofence', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'rollback-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'rollback-parked', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'rollback-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })

    const failed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'rollback-onboard', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'rollback-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
    })

    expect(failed.task).toMatchObject({
      phase: 'returning-home',
      passengers: { confirmedOnboard: true },
      navigation: { routeId: 'route-home-001', destination: '家', status: 'active' },
      returnTrip: { route: { status: 'succeeded' }, cabin: { status: 'pending' }, media: { status: 'failed' } },
    })
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'navigation.update-route.rollback', status: 'failed', errorCode: 'ROLLBACK_FAILED' }))
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))
    expect(failed.ui.components).toContainEqual(expect.objectContaining({
      type: 'status-banner',
      props: expect.objectContaining({ message: expect.stringContaining('部分返程操作仍在生效') }),
    }))
  })

  it('keeps semantically invalid media output failed and retries it', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    let mediaCalls = 0
    const media = vi.fn((ctx: { taskId: string; requestId?: string }, input: unknown) => {
      mediaCalls += 1
      if (mediaCalls === 1) {
        return {
          ok: true as const,
          data: { playbackId: 'wrong-playback', title: '轻音乐', status: 'playing' as const, reversible: true as const },
          error: null,
          meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'media.play', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
        }
      }
      return base['media.play'](ctx, input)
    })
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime, providers: { ...base, 'media.play': media } })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'invalid-media-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'invalid-media-start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-media-geofence', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'invalid-media-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-media-parked', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'invalid-media-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-media-onboard', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'invalid-media-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })

    expect(failed.task.returnTrip).toMatchObject({ media: { status: 'failed', errorCode: 'PROVIDER_FAILED' } })
    const retry = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'invalid-media-retry', expectedTaskRevision: failed.task.taskRevision, expectedUiRevision: failed.ui.uiRevision,
      actionId: 'retry-return-trip', componentId: 'return-trip-provider-fallback', idempotencyKey: 'invalid-media-retry',
    })

    expect(media).toHaveBeenCalledTimes(2)
    expect(retry.task.returnTrip?.media.status).toBe('succeeded')
  })

  it('keeps invalid cabin output failed when cabin compensation also fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const applyCabin = vi.fn((ctx: { taskId: string; requestId?: string }) => ({
      ok: true as const,
      data: { effectId: `${ctx.taskId}:cabin:invalid`, applied: true, previous: { temperatureC: 22, fanLevel: 2 }, current: { temperatureC: 19, fanLevel: 2 }, reversible: true },
      error: null,
      meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'vehicle.apply-cabin-profile', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
    }))
    const revertCabin = vi.fn((ctx: { taskId: string; requestId?: string }) => ({
      ok: false as const,
      data: null,
      error: { code: 'ROLLBACK_FAILED', message: 'cannot revert cabin', retryable: false },
      meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'vehicle.revert-cabin-profile', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
    }))
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.apply-cabin-profile': applyCabin, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'invalid-cabin-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'invalid-cabin-start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-cabin-geofence', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'invalid-cabin-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-cabin-parked', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'invalid-cabin-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-cabin-onboard', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'invalid-cabin-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })

    expect(failed.task.returnTrip).toMatchObject({ cabin: { status: 'failed', errorCode: 'PROVIDER_FAILED' } })
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'vehicle.revert-cabin-profile', status: 'failed', errorCode: 'ROLLBACK_FAILED' }))
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))
  })

  it.each([
    ['navigation.update-route', 'ROUTE_PROVIDER_FAILED'],
    ['vehicle.apply-cabin-profile', 'CABIN_PROVIDER_FAILED'],
  ] as const)('does not commit onboard facts when %s fails', (tool, errorCode) => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const failedProvider = vi.fn((ctx: { taskId: string; requestId?: string }) => ({
      ok: false as const,
      data: null,
      error: { code: errorCode, message: 'failed', retryable: false },
      meta: {
        requestId: ctx.requestId!, taskId: ctx.taskId, tool, provider: 'fixture' as const,
        durationMs: 1, generatedAt: now,
      },
    }))
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, [tool]: failedProvider },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: `s-${tool}`, expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: `s-${tool}` })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: `g-${tool}`, expectedTaskRevision: started.task.taskRevision, event: { eventId: `g-${tool}`, type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: `p-${tool}`, expectedTaskRevision: approaching.task.taskRevision, event: { eventId: `p-${tool}`, type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const event = { eventId: `onboard-${tool}`, type: 'user.confirmed-passengers-onboard' as const, timestamp: '2026-07-22T12:04:00+08:00' }

    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: `o-${tool}`, expectedTaskRevision: waiting.task.taskRevision, event })
    const duplicate = gateway.submitEvent(created.task.taskId, { clientRequestId: `o-${tool}-retry`, expectedTaskRevision: waiting.task.taskRevision, event })

    expect(failed.task).toEqual(waiting.task)
    expect(failed.effects).toContainEqual(expect.objectContaining({ tool, status: 'failed', errorCode }))
    expect(duplicate.task).toEqual(failed.task)
    expect(duplicate.ui).toEqual(failed.ui)
    expect(duplicate.effects).toEqual(failed.effects)
    expect(failedProvider).toHaveBeenCalledTimes(1)
  })

  it('keeps a retry action when return-trip preference lookup falls back', () => {
    const runtime = createSideEffectRuntime()
    const base = new ReadToolOrchestrator({ registry: createProviderRegistry(runtime) })
    let preferenceReads = 0
    const orchestrator = {
      resolveInitialPassengers: base.resolveInitialPassengers.bind(base),
      prepareTrip: base.prepareTrip.bind(base),
      resolveReturnTripPreferences: (taskId: string, requestId: string, memberIds: string[]) => {
        preferenceReads += 1
        if (preferenceReads === 1) throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'preference timeout', true)
        return base.resolveReturnTripPreferences(taskId, requestId, memberIds)
      },
    }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime, orchestrator })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 's', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 's' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'g', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'g', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'p', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'p', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const fallback = gateway.submitEvent(created.task.taskId, { clientRequestId: 'o', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'o', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })

    expect(fallback.task).toEqual(waiting.task)
    expect(preferenceReads).toBe(1)
    expect(fallback.meta.fallbackUsed).toBe(true)
    expect(fallback.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))

    const retry = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'o-retry', expectedTaskRevision: fallback.task.taskRevision, expectedUiRevision: fallback.ui.uiRevision,
      actionId: 'retry-return-trip', componentId: 'return-trip-provider-fallback', idempotencyKey: 'return-retry',
    })
    expect(retry.meta.fallbackUsed).toBe(false)
    expect(retry.task.phase).toBe('returning-home')
    expect(retry.task.returnTrip?.route.status).toBe('succeeded')
  })

  it('marks a previously failed route succeeded when retry resumes later effects', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const prepared = gateway.submitEvent(created.task.taskId, { clientRequestId: 'flight', expectedTaskRevision: created.task.taskRevision, event: { eventId: 'flight', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' } })
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'start', expectedTaskRevision: prepared.task.taskRevision, expectedUiRevision: prepared.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'g', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'g', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'p', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'p', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const first = gateway.submitEvent(created.task.taskId, { clientRequestId: 'o', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'o', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })
    expect(first.task.returnTrip?.route.status).toBe('succeeded')
  })

  it('does not retain the outbound route when return-home address lookup fails', () => {
    const runtime = createSideEffectRuntime()
    runtime.preferences.mom = { ...runtime.preferences.mom, homeDestinationId: undefined }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 's', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 's' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'g', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'g', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'p', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'p', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'o', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'o', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })

    expect(failed.task).toEqual(waiting.task)
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'navigation.update-route', status: 'failed', errorCode: 'PREFERENCE_UNAVAILABLE' }))
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))
  })

  it('keeps the original snapshot and records a failed effect when navigation.start fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const startNavigation = vi.fn((ctx: { taskId: string; requestId?: string }) => ({
      ok: false,
      data: null,
      error: { code: 'PROVIDER_TIMEOUT', message: 'navigation timeout', retryable: true },
      meta: {
        requestId: ctx.requestId!,
        taskId: ctx.taskId,
        tool: 'navigation.start',
        provider: 'fixture' as const,
        durationMs: 1,
        generatedAt: '2026-07-22T12:00:00+08:00',
      },
    }))
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => '001',
      runtime,
      providers: { ...base, 'navigation.start': startNavigation },
    })
    const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆，航班 MU5102'))
    const failed = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-provider-timeout',
    })

    expect(failed.task).toEqual(created.task)
    expect(failed.ui).toEqual(created.ui)
    expect(failed.effects).toEqual([expect.objectContaining({
      type: 'navigation.start', status: 'failed', tool: 'navigation.start', errorCode: 'PROVIDER_TIMEOUT',
    })])
    expect(gateway.getTask(created.task.taskId).task).toEqual(created.task)

    const duplicate = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation-retry',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-provider-timeout',
    })
    expect(startNavigation).toHaveBeenCalledTimes(1)
    expect(duplicate.effects).toEqual(failed.effects)
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

  it('does not publish or execute navigation after the flight is cancelled', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const startNavigation = vi.fn(base['navigation.start'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => '001',
      runtime,
      providers: { ...base, 'navigation.start': startNavigation },
    })
    const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆，航班 MU5102'))
    const cancelled = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight-cancelled',
      expectedTaskRevision: created.task.taskRevision,
      event: {
        eventId: 'flight-cancelled',
        type: 'flight.updated',
        flight: {
          flightNumber: 'MU5102',
          status: 'cancelled',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T20:30:00+08:00',
          terminal: 'T2',
        },
        timestamp: '2026-07-22T12:01:00+08:00',
      },
    })

    expect(cancelled.task.flight?.status).toBe('cancelled')
    expect(cancelled.ui.actions.some((action) => action.id === 'start-navigation')).toBe(false)
    expect(() => gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-cancelled',
      expectedTaskRevision: cancelled.task.taskRevision,
      expectedUiRevision: cancelled.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-cancelled',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(startNavigation).not.toHaveBeenCalled()
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

  it('proposes and accepts the arrival memory update through the provider', () => {
    const runtime = createSideEffectRuntime()
    const acceptGateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime })
    const accepted = completeTask(acceptGateway)
    expect(accepted.memoryProposal).toMatchObject({ status: 'pending', memberId: 'mom' })
    expect(accepted.pendingConfirmation?.confirmationId).toBe(accepted.memoryProposal?.confirmationId)
    const acceptRequest = {
      clientRequestId: 'client-save-memory-accept',
      expectedTaskRevision: accepted.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-accept',
    } as const
    const confirmationId = accepted.pendingConfirmation!.confirmationId
    const acceptedResult = acceptGateway.submitConfirmation(accepted.taskId, confirmationId, acceptRequest)
    const acceptedRetry = acceptGateway.submitConfirmation(accepted.taskId, confirmationId, {
      ...acceptRequest,
      clientRequestId: 'client-save-memory-accept-retry',
    })

    expect(acceptedResult.task).toMatchObject({ taskRevision: accepted.taskRevision + 1, pendingConfirmation: undefined, memoryProposal: { status: 'accepted' } })
    expect(acceptedResult.effects).toEqual([expect.objectContaining({ type: 'memory.confirm-update', status: 'succeeded' })])
    expect(runtime.preferences.mom.rearTemperatureC).toBe(25)
    expect(acceptedRetry.task).toEqual(acceptedResult.task)
    expect(acceptedRetry.ui).toEqual(acceptedResult.ui)

    expect(() => acceptGateway.submitConfirmation(accepted.taskId, confirmationId, {
      ...acceptRequest,
      clientRequestId: 'client-save-memory-reject-after-accept',
      decision: 'reject',
    })).toThrowError(expect.objectContaining({ code: 'TASK_REVISION_CONFLICT' }))

    const rejectGateway = createGateway()
    const rejected = completeTask(rejectGateway)
    const rejectedResult = rejectGateway.submitConfirmation(rejected.taskId, rejected.pendingConfirmation!.confirmationId, {
      clientRequestId: 'client-save-memory-reject',
      expectedTaskRevision: rejected.taskRevision,
      decision: 'reject',
      idempotencyKey: 'save-memory-reject',
    })

    expect(rejectedResult.task).toMatchObject({ taskRevision: rejected.taskRevision + 1, pendingConfirmation: undefined, memoryProposal: { status: 'rejected' } })
    expect(rejectedResult.effects).toEqual([expect.objectContaining({ type: 'memory.reject-update', status: 'cancelled', errorCode: 'USER_REJECTED' })])
  })

  it('does not confirm an expired proposal when the gateway clock is ahead of the provider clock', () => {
    const runtime = createSideEffectRuntime(() => Date.parse('2026-07-22T12:00:00Z'))
    let gatewayNow = now
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => gatewayNow,
      createId: () => '001',
      runtime,
    })
    const completed = completeTask(gateway)
    expect(completed.pendingConfirmation?.expiresAt).toBe('2026-07-22T12:30:00.000Z')
    gatewayNow = '2026-07-22T12:31:00Z'

    const expired = gateway.submitConfirmation(completed.taskId, completed.pendingConfirmation!.confirmationId, {
      clientRequestId: 'client-save-memory-expired',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-expired',
    })

    expect(expired.task).toMatchObject({ pendingConfirmation: undefined, memoryProposal: { status: 'expired', errorCode: 'PROPOSAL_EXPIRED' } })
    expect(expired.effects).toEqual([expect.objectContaining({ type: 'memory.reject-update', status: 'failed', errorCode: 'PROPOSAL_EXPIRED' })])
    expect(runtime.preferences.mom.rearTemperatureC).toBe(25)
  })

  it('revokes rejected proposals through the injected provider runtime', () => {
    const providerRuntime = createSideEffectRuntime()
    const providers = createProviderRegistry(providerRuntime)
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', providers })
    const completed = completeTask(gateway)
    const confirmationId = completed.pendingConfirmation!.confirmationId
    const proposalId = completed.memoryProposal!.proposalId!

    gateway.submitConfirmation(completed.taskId, confirmationId, {
      clientRequestId: 'client-provider-runtime-reject',
      expectedTaskRevision: completed.taskRevision,
      decision: 'reject',
      idempotencyKey: 'provider-runtime-reject',
    })

    const retained = providers['memory.confirm-update'](
      { taskId: completed.taskId, requestId: 'stolen-confirm' },
      { proposalId, confirmationId, idempotencyKey: 'stolen-confirm' },
    )
    expect(retained.error?.code).toBe('PROPOSAL_EXPIRED')
    expect(providerRuntime.preferences.mom.rearTemperatureC).toBe(25)
  })

  it('dismisses an expired prompt when the provider already removed the proposal', () => {
    let providerNow = Date.parse('2026-07-22T12:00:00Z')
    let gatewayNow = now
    const providerRuntime = createSideEffectRuntime(() => providerNow)
    const providers = createProviderRegistry(providerRuntime)
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => gatewayNow, createId: () => '001', providers })
    const completed = completeTask(gateway)
    const confirmationId = completed.pendingConfirmation!.confirmationId
    const proposalId = completed.memoryProposal!.proposalId!

    providerNow = Date.parse('2026-07-22T12:31:00Z')
    providers['memory.confirm-update'](
      { taskId: completed.taskId, requestId: 'provider-expiry-cleanup' },
      { proposalId, confirmationId, idempotencyKey: 'provider-expiry-cleanup' },
    )
    gatewayNow = '2026-07-22T12:31:00Z'

    const expired = gateway.submitConfirmation(completed.taskId, confirmationId, {
      clientRequestId: 'client-provider-first-expiry',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'provider-first-expiry',
    })

    expect(expired.task).toMatchObject({ pendingConfirmation: undefined, memoryProposal: { status: 'expired' } })
    expect(expired.ui.actions).toEqual([])
  })

  it('preserves trusted provider context when accepting save-memory confirmation', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => '001' })
    const completed = completeTask(gateway)

    gateway.submitConfirmation(completed.taskId, completed.pendingConfirmation!.confirmationId, {
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

    const confirmed = gateway.submitConfirmation(completed.taskId, completed.pendingConfirmation!.confirmationId, {
      clientRequestId: 'client-save-memory',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'shared-idempotency-key',
    })

    expect(confirmed.task).toMatchObject({ taskRevision: completed.taskRevision + 1, pendingConfirmation: undefined, memoryProposal: { status: 'accepted' } })
  })

  it('requires a current save-memory confirmation', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())

    expect(() => gateway.submitConfirmation(created.task.taskId, 'missing-confirmation', {
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
      componentId: 'navigation-plan',
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

  it('executes the scheduled landing message before committing the sent state', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const sendMessage = vi.fn(base['message.send'])
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime, providers: { ...base, 'message.send': sendMessage } })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'message-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'message-nav',
    })
    const landed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'message-landed', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'message-landed-event', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' },
    })
    expect(landed.task.message).toMatchObject({ status: 'scheduled', authorizationId: expect.stringMatching(/^cnf_/) })

    const sent = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'message-sent', expectedTaskRevision: landed.task.taskRevision,
      event: { eventId: 'message-sent-event', type: 'message.sent', messageId: landed.task.message.pendingMessageId!, timestamp: '2026-07-22T20:41:00+08:00' },
    })
    const duplicate = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'message-sent-retry', expectedTaskRevision: landed.task.taskRevision,
      event: { eventId: 'message-sent-event', type: 'message.sent', messageId: landed.task.message.pendingMessageId!, timestamp: '2026-07-22T20:41:00+08:00' },
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sent.task.message).toMatchObject({ status: 'sent', landingNoticeSent: true, authorizationId: undefined })
    expect(sent.effects).toEqual([expect.objectContaining({ type: 'message.send', status: 'succeeded' })])
    expect(duplicate.task).toEqual(sent.task)
  })

  it('keeps the scheduled snapshot when the landing message provider fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'message.send': (ctx) => ({ ok: false as const, data: null, error: { code: 'SEND_FAILED', message: 'failed', retryable: false }, meta: { taskId: ctx.taskId, tool: 'message.send', requestId: ctx.requestId ?? `${ctx.taskId}:message.send`, provider: 'fixture' as const, durationMs: 1, generatedAt: now } }) },
    })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'failed-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'failed-nav' })
    const landed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'failed-landed', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'failed-landed-event', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' } })
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'failed-sent', expectedTaskRevision: landed.task.taskRevision, event: { eventId: 'failed-sent-event', type: 'message.sent', messageId: landed.task.message.pendingMessageId!, timestamp: '2026-07-22T20:41:00+08:00' } })
    expect(failed.task.message).toMatchObject({ status: 'failed', pendingContactId: 'contact-mom', pendingMessageId: undefined, authorizationId: undefined })
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-landing-message' }))
    expect(failed.effects).toEqual([expect.objectContaining({ type: 'message.send', status: 'failed', errorCode: 'SEND_FAILED' })])
  })

  it('hides retry and surfaces unavailable UI when failed notify has no authorized contact', () => {
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
      componentId: 'navigation-plan',
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
    expect(failed.ui.actions.some((action) => action.id === 'retry-landing-message')).toBe(true)

    // Revoke authorization after failure; next publish must not keep a dead retry button.
    runtime.preferences.mom = { ...runtime.preferences.mom, landingNotificationAuthorized: false }
    const view = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-auth-revoked-view',
      expectedTaskRevision: failed.task.taskRevision,
      event: {
        eventId: 'timeout-after-revoke',
        type: 'provider.timeout',
        provider: 'flight',
        timestamp: '2026-07-22T20:41:30+08:00',
      },
    })
    expect(view.ui.actions.some((action) => action.id === 'retry-landing-message')).toBe(false)
    expect(view.ui.components).toContainEqual(expect.objectContaining({
      type: 'status-banner',
      props: {
        level: 'error',
        title: '无法重试发送',
        message: '没有已授权的落地通知联系人',
      },
    }))
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
