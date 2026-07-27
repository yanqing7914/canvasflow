import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createProviderRegistry, type ProviderRegistry } from '@canvasflow/tools'
import { ModelGateway } from './model-gateway'
import { PersistentAgentRuntime, providerModeFromEnvironment } from './persistent'
import type { Plan } from './planner'

const now = '2026-07-22T12:00:00+08:00'
const runtimes: PersistentAgentRuntime[] = []
const temporaryDirectories: string[] = []

function createRequest(clientRequestId = 'create-001') {
  return {
    clientRequestId,
    input: { type: 'text' as const, text: '接妈妈，航班 MU5102' },
    vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P' as const, isNight: true },
    clientCapabilities: { uiSchemaVersion: '1.0' as const, supportsSse: true, supportsTts: true },
  }
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'canvasflow-agent-'))
  temporaryDirectories.push(directory)
  return join(directory, 'agent.sqlite')
}

function runtime(path: string, options: Partial<ConstructorParameters<typeof PersistentAgentRuntime>[0]> = {}) {
  const instance = new PersistentAgentRuntime({
    databasePath: path,
    now: () => now,
    nowMs: () => Date.parse('2026-07-22T12:00:00Z'),
    createId: () => 'persistent-001',
    ...options,
  })
  runtimes.push(instance)
  return instance
}

afterEach(async () => {
  for (const instance of runtimes.splice(0)) instance.close()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('PersistentAgentRuntime', () => {
  it('preserves validated model provenance on durable create replays after restart', async () => {
    const path = await databasePath()
    const modelGateway = new ModelGateway({
      adapter: {
        modelId: 'fixture-model',
        plan: async () => ({
          confidence: 0.95,
          canonicalInput: '去机场接妈妈',
          intentHint: 'create-airport-pickup',
          evidence: { passengers: ['妈妈'] },
        }),
      },
    })
    const plan = vi.spyOn(modelGateway, 'plan')
    const agent = runtime(path, { modelGateway })

    const created = await agent.createTaskAsync({
      ...createRequest(),
      input: { type: 'text', text: '劳驾替我去航站楼把妈妈接回来' },
    })

    expect(plan).toHaveBeenCalledOnce()
    expect(created.task).toMatchObject({
      phase: 'collecting-information', passengers: { names: ['妈妈'] },
    })
    expect(created.meta.modelUsed).toBe('fixture-model')
    agent.close()

    const replayModelGateway = { plan: vi.fn() }
    const restarted = runtime(path, { modelGateway: replayModelGateway })
    const replayed = await restarted.createTaskAsync({
      ...createRequest(),
      input: { type: 'text', text: '劳驾替我去航站楼把妈妈接回来' },
    })

    expect(replayModelGateway.plan).not.toHaveBeenCalled()
    expect(replayed.task).toEqual(created.task)
    expect(replayed.meta.modelUsed).toBe('fixture-model')
  })

  it('does not call the model for rule-recognized input or duplicate creates', async () => {
    const path = await databasePath()
    const modelGateway = new ModelGateway({
      adapter: { modelId: 'unexpected', plan: async () => { throw new Error('rules should bypass the model') } },
    })
    const plan = vi.spyOn(modelGateway, 'plan')
    const agent = runtime(path, { modelGateway })

    const request = createRequest()
    const first = await agent.createTaskAsync(request)
    const replay = await agent.createTaskAsync(request)

    expect(plan).toHaveBeenCalledTimes(1)
    expect(first.task).toEqual(replay.task)
  })

  it('does not hold a SQLite write transaction while waiting for model planning', async () => {
    const path = await databasePath()
    let resolvePlan: ((value: Awaited<ReturnType<ModelGateway['plan']>>) => void) | undefined
    const waitingPlan = new Promise<Awaited<ReturnType<ModelGateway['plan']>>>((resolve) => { resolvePlan = resolve })
    const first = runtime(path, { createId: () => 'waiting', modelGateway: { plan: vi.fn(() => waitingPlan) } })
    const second = runtime(path, { createId: () => 'concurrent' })

    const pending = first.createTaskAsync({
      ...createRequest('model-waiting'),
      input: { type: 'text', text: '麻烦去航站楼把妈妈接回来' },
    })
    const other = second.createTask(createRequest('concurrent-write'))
    resolvePlan!({
      source: 'fallback',
      plan: {
        intent: 'unknown', confidence: 0.2, slotUpdates: {}, missingSlots: ['passengers', 'flightNumber'],
        proposedEvents: [], assistantText: '我还不能确定你的接机安排，请换一种说法。',
      },
    })

    await expect(pending).resolves.toMatchObject({ task: { phase: 'collecting-information' } })
    expect(other.task.taskId).toBe('pickup-concurrent')
  })

  it('coalesces concurrent duplicate create preflights without holding a write transaction', async () => {
    const path = await databasePath()
    let resolvePlan: ((value: Awaited<ReturnType<ModelGateway['plan']>>) => void) | undefined
    const waitingPlan = new Promise<Awaited<ReturnType<ModelGateway['plan']>>>((resolve) => { resolvePlan = resolve })
    const plan = vi.fn(() => waitingPlan)
    const agent = runtime(path, { modelGateway: { plan } })
    const request = {
      ...createRequest('same-create'),
      input: { type: 'text' as const, text: '麻烦去航站楼把妈妈接回来' },
    }

    const first = agent.createTaskAsync(request)
    const second = agent.createTaskAsync(request)
    expect(plan).toHaveBeenCalledOnce()
    resolvePlan!({
      source: 'fallback',
      plan: { intent: 'unknown', confidence: 0.2, slotUpdates: {}, missingSlots: ['passengers', 'flightNumber'], proposedEvents: [], assistantText: 'fallback' },
    })

    const [created, replayed] = await Promise.all([first, second])
    expect(replayed.task).toEqual(created.task)
  })

  it('validates async preflight inputs before reading model fields', async () => {
    const path = await databasePath()
    const plan = vi.fn()
    const agent = runtime(path, { modelGateway: { plan } })

    await expect(agent.createTaskAsync({ clientRequestId: 'invalid' } as never)).rejects.toMatchObject({ name: 'ZodError' })
    await expect(agent.submitEventAsync('missing', { clientRequestId: 'invalid' } as never)).rejects.toMatchObject({ name: 'ZodError' })
    expect(plan).not.toHaveBeenCalled()
  })

  it('falls back unchanged when the model planner rejects an unknown event', async () => {
    const path = await databasePath()
    const fallbackPlan: Plan = {
      intent: 'unknown', confidence: 0.2, slotUpdates: {}, missingSlots: ['passengers', 'flightNumber'], proposedEvents: [], assistantText: 'fallback',
    }
    const plan = vi.fn(async () => ({
      source: 'fallback' as const,
      plan: fallbackPlan,
    }))
    const agent = runtime(path, { modelGateway: { plan } })
    const created = agent.createTask(createRequest())

    const updated = await agent.submitEventAsync(created.task.taskId, {
      clientRequestId: 'unknown-event', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'unknown-event', type: 'user.input', text: '完全未知的表达', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(plan).toHaveBeenCalledOnce()
    expect(updated.task.phase).toBe(created.task.phase)
    expect(updated.task.flight?.flightNumber).toBe(created.task.flight?.flightNumber)
    expect(updated.task.passengers).toEqual(created.task.passengers)
    expect(updated.task.processedEventIds).toEqual(created.task.processedEventIds)
    expect(updated.meta.modelUsed).toBeUndefined()
  })

  it('preserves model provenance on durable user-input event replays after restart', async () => {
    const path = await databasePath()
    const modelGateway = new ModelGateway({
      adapter: {
        modelId: 'event-model',
        plan: async () => ({
          confidence: 0.95,
          canonicalInput: '去机场接妈妈',
          intentHint: 'create-airport-pickup',
          evidence: { passengers: ['妈妈'] },
        }),
      },
    })
    const agent = runtime(path, { modelGateway })
    const created = agent.createTask({
      ...createRequest('empty-task'),
      input: { type: 'text', text: '先创建任务', confidence: 0.5 },
    })
    const event = {
      clientRequestId: 'model-event',
      expectedTaskRevision: created.task.taskRevision,
      event: {
        eventId: 'model-event',
        type: 'user.input' as const,
        text: '劳驾替我去航站楼把妈妈接回来',
        timestamp: '2026-07-22T12:01:00+08:00',
      },
    }

    const updated = await agent.submitEventAsync(created.task.taskId, event)
    expect(updated.task.passengers.names).toEqual(['妈妈'])
    expect(updated.meta.modelUsed).toBe('event-model')
    agent.close()

    const replayModelGateway = { plan: vi.fn() }
    const restarted = runtime(path, { modelGateway: replayModelGateway })
    const replayed = await restarted.submitEventAsync(created.task.taskId, {
      ...event,
      clientRequestId: 'model-event-retry',
    })

    expect(replayModelGateway.plan).not.toHaveBeenCalled()
    expect(replayed.task).toEqual(updated.task)
    expect(replayed.meta.modelUsed).toBe('event-model')
  })

  it('restores tasks and original create results after a process restart', async () => {
    const path = await databasePath()
    const firstRuntime = runtime(path)
    const created = firstRuntime.createTask(createRequest())
    const updated = firstRuntime.submitEvent(created.task.taskId, {
      clientRequestId: 'event-001',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'event-timeout', type: 'provider.timeout', provider: 'flight.get-status', timestamp: now },
    })
    expect(updated.task.processedEventIds).toContain('event-timeout')
    firstRuntime.close()

    const restarted = runtime(path)
    expect(restarted.getTask(created.task.taskId).task).toEqual(updated.task)
    expect(restarted.createTask(createRequest()).task).toEqual(created.task)
  })

  it('restores update cursors after restart and exposes cross-runtime writes', async () => {
    const path = await databasePath()
    const firstRuntime = runtime(path)
    const secondRuntime = runtime(path)
    const created = firstRuntime.createTask(createRequest())
    expect(secondRuntime.getTaskUpdates(created.task.taskId)).toMatchObject({
      latestCursor: 1, updates: [expect.objectContaining({ cursor: 1 })],
    })
    const moving = firstRuntime.submitEvent(created.task.taskId, {
      clientRequestId: 'moving', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'moving', type: 'vehicle.moving', speedKph: 80, timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(moving.task.taskRevision).toBe(created.task.taskRevision)
    expect(secondRuntime.getTaskUpdates(created.task.taskId, 1).updates).toEqual([
      expect.objectContaining({ cursor: 2, snapshot: expect.objectContaining({ ui: moving.ui }) }),
    ])
    firstRuntime.close()
    secondRuntime.close()

    const restarted = runtime(path)
    expect(restarted.getTaskUpdates(created.task.taskId, 1)).toMatchObject({
      latestCursor: 2, updates: [expect.objectContaining({ cursor: 2 })],
    })
  })

  it('backfills an authoritative stream snapshot for databases created before task updates', async () => {
    const path = await databasePath()
    const firstRuntime = runtime(path)
    const created = firstRuntime.createTask(createRequest())
    firstRuntime.close()
    const database = new DatabaseSync(path)
    database.exec('DROP TABLE agent_task_updates; DROP TABLE agent_task_update_cursors;')
    database.close()

    const migrated = runtime(path)
    expect(migrated.getTaskUpdates(created.task.taskId)).toMatchObject({
      latestCursor: 1,
      updates: [expect.objectContaining({ cursor: 1, snapshot: expect.objectContaining({ task: created.task }) })],
    })
    const secondOpening = runtime(path)
    expect(secondOpening.getTaskUpdates(created.task.taskId)).toMatchObject({
      latestCursor: 1,
      updates: [expect.objectContaining({ cursor: 1 })],
    })
  })

  it('repairs an interrupted migration with a cursor but no matching envelope', async () => {
    const path = await databasePath()
    const firstRuntime = runtime(path)
    const created = firstRuntime.createTask(createRequest())
    firstRuntime.close()
    const database = new DatabaseSync(path)
    database.prepare('UPDATE agent_task_update_cursors SET latest_cursor = 4 WHERE task_id = ?')
      .run(created.task.taskId)
    database.prepare('DELETE FROM agent_task_updates WHERE task_id = ?').run(created.task.taskId)
    database.close()

    const repaired = runtime(path)
    expect(repaired.getTaskUpdates(created.task.taskId)).toMatchObject({
      latestCursor: 4,
      updates: [expect.objectContaining({ cursor: 4, snapshot: expect.objectContaining({ task: created.task }) })],
    })
    const reopened = runtime(path)
    expect(reopened.getTaskUpdates(created.task.taskId)).toMatchObject({
      latestCursor: 4,
      updates: [expect.objectContaining({ cursor: 4 })],
    })
  })

  it('restores request presentation context after a process restart', async () => {
    const path = await databasePath()
    const firstRuntime = runtime(path)
    const created = firstRuntime.createTask({
      ...createRequest(),
      input: { type: 'text', text: '接妈妈，航班 MU5102' },
      vehicleContext: { speedKph: 0, batteryPercent: 90, remainingRangeKm: 240, gear: 'P', isNight: false },
    })
    expect(created.ui.presentation.theme).toBe('light')
    firstRuntime.close()

    const restarted = runtime(path)
    const moving = restarted.submitEvent(created.task.taskId, {
      clientRequestId: 'restart-moving',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'restart-moving', type: 'vehicle.moving', speedKph: 80, timestamp: now },
    })
    expect(moving.ui.presentation).toMatchObject({ density: 'minimal', theme: 'light' })
  })

  it('replays an action receipt after restart without invoking the provider again', async () => {
    const path = await databasePath()
    let startCalls = 0
    const providerFactory = (sideEffectRuntime: Parameters<typeof createProviderRegistry>[0]): ProviderRegistry => {
      const providers = createProviderRegistry(sideEffectRuntime)
      return {
        ...providers,
        'navigation.start': (context, input) => {
          startCalls += 1
          return providers['navigation.start'](context, input)
        },
      }
    }
    const firstRuntime = runtime(path, { providerFactory })
    const created = firstRuntime.createTask(createRequest())
    const request = {
      clientRequestId: 'action-001',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'start-navigation-001',
    }
    const started = firstRuntime.submitAction(created.task.taskId, request)
    firstRuntime.close()

    const restarted = runtime(path, { providerFactory })
    const duplicate = restarted.submitAction(created.task.taskId, { ...request, clientRequestId: 'action-002' })
    expect(startCalls).toBe(1)
    expect(duplicate.task).toEqual(started.task)
    expect(duplicate.effects).toEqual(started.effects)
  })

  it('shares action receipts across two runtime instances on the same database', async () => {
    const path = await databasePath()
    let startCalls = 0
    const providerFactory: import('./persistent').ProviderFactory = (sideEffectRuntime) => {
      const providers = createProviderRegistry(sideEffectRuntime)
      return {
        ...providers,
        'navigation.start': (context, input) => {
          startCalls += 1
          return providers['navigation.start'](context, input)
        },
      }
    }
    const firstRuntime = runtime(path, { providerFactory })
    const secondRuntime = runtime(path, { providerFactory })
    const created = firstRuntime.createTask(createRequest())
    const request = {
      clientRequestId: 'instance-a-action', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'shared-instance-action',
    }

    const first = firstRuntime.submitAction(created.task.taskId, request)
    const duplicate = secondRuntime.submitAction(created.task.taskId, { ...request, clientRequestId: 'instance-b-action' })

    expect(startCalls).toBe(1)
    expect(duplicate.task).toEqual(first.task)
    expect(duplicate.effects).toEqual(first.effects)
  })

  it('restores the cabin undo receipt after restart and replays the first result', async () => {
    const path = await databasePath()
    let revertCalls = 0
    const providerFactory: import('./persistent').ProviderFactory = (sideEffectRuntime) => {
      const providers = createProviderRegistry(sideEffectRuntime)
      return {
        ...providers,
        'vehicle.revert-cabin-profile': (context, input) => {
          revertCalls += 1
          return providers['vehicle.revert-cabin-profile'](context, input)
        },
      }
    }
    const firstRuntime = runtime(path, { providerFactory })
    const returning = returningTask(firstRuntime)
    expect(returning.ui.actions).toContainEqual(expect.objectContaining({ id: 'revert-cabin-profile' }))
    firstRuntime.close()

    const restarted = runtime(path, { providerFactory })
    const request = {
      clientRequestId: 'persistent-cabin-revert', expectedTaskRevision: returning.task.taskRevision,
      expectedUiRevision: returning.ui.uiRevision, actionId: 'revert-cabin-profile',
      componentId: 'cabin-profile', idempotencyKey: 'persistent-cabin-revert',
    }
    const reverted = restarted.submitAction(returning.task.taskId, request)
    restarted.close()

    const replayRuntime = runtime(path, { providerFactory })
    const replay = replayRuntime.submitAction(returning.task.taskId, {
      ...request,
      clientRequestId: 'persistent-cabin-revert-replay',
    })
    expect(revertCalls).toBe(1)
    expect(reverted.task.returnTrip?.cabin.revert?.status).toBe('succeeded')
    expect(replay.task).toEqual(reverted.task)
    expect(replay.effects).toEqual(reverted.effects)
  })

  it('restores pending memory confirmations so accept remains executable after restart', async () => {
    const path = await databasePath()
    const firstRuntime = runtime(path)
    const completed = completeTask(firstRuntime)
    firstRuntime.close()

    const restarted = runtime(path)
    const accepted = restarted.submitConfirmation(
      completed.taskId,
      completed.pendingConfirmation!.confirmationId,
      {
        clientRequestId: 'confirm-001',
        expectedTaskRevision: completed.taskRevision,
        decision: 'accept',
        idempotencyKey: 'confirm-memory-001',
      },
    )
    expect(accepted.task.memoryProposal).toMatchObject({ status: 'accepted' })
    expect(accepted.effects).toEqual([
      expect.objectContaining({ type: 'memory.confirm-update', status: 'succeeded' }),
    ])
  })

  it('clears target-task event and action receipts across reset and restart', async () => {
    const path = await databasePath()
    let startCalls = 0
    const providerFactory: import('./persistent').ProviderFactory = (sideEffectRuntime) => {
      const providers = createProviderRegistry(sideEffectRuntime)
      return {
        ...providers,
        'navigation.start': (context, input) => {
          startCalls += 1
          return providers['navigation.start'](context, input)
        },
      }
    }
    const firstRuntime = runtime(path, { providerFactory })
    const created = firstRuntime.createTask(createRequest())
    const started = firstRuntime.submitAction(created.task.taskId, {
      clientRequestId: 'action-before-reset', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'shared-action-key',
    })
    const reset = firstRuntime.resetTask(created.task.taskId, {
      clientRequestId: 'reset-001', expectedTaskRevision: started.task.taskRevision,
    })
    firstRuntime.close()

    const restarted = runtime(path, { providerFactory })
    const prepared = restarted.submitEvent(created.task.taskId, {
      clientRequestId: 'reprepare', expectedTaskRevision: reset.task.taskRevision,
      event: { eventId: 'new-input', type: 'user.input', text: '接妈妈，航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    restarted.submitAction(created.task.taskId, {
      clientRequestId: 'action-after-reset', expectedTaskRevision: prepared.task.taskRevision,
      expectedUiRevision: prepared.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'shared-action-key',
    })

    expect(startCalls).toBe(2)
  })

  it('rolls back task and side-effect state when persistence fails before commit', async () => {
    const path = await databasePath()
    const baseFactory = vi.fn((sideEffectRuntime, mode) => (
      mode === 'live'
        ? createProviderRegistry(sideEffectRuntime)
        : createProviderRegistry(sideEffectRuntime, mode)
    )) satisfies import('./persistent').ProviderFactory
    const instance = runtime(path, { providerFactory: baseFactory })
    const created = instance.createTask(createRequest())
    instance.close()

    const databaseModule = await import('node:sqlite')
    const database = new databaseModule.DatabaseSync(path)
    database.exec(`
      CREATE TRIGGER fail_navigation_state BEFORE UPDATE ON agent_runtime_state
      BEGIN SELECT RAISE(ABORT, 'forced runtime save failure'); END;
    `)
    database.close()

    const failing = runtime(path, { providerFactory: baseFactory })
    expect(() => failing.submitAction(created.task.taskId, {
      clientRequestId: 'action-failing',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'start-navigation-failing',
    })).toThrow('forced runtime save failure')
    failing.close()

    const databaseAfter = new databaseModule.DatabaseSync(path)
    databaseAfter.exec('DROP TRIGGER fail_navigation_state')
    databaseAfter.close()
    const recovered = runtime(path)
    expect(recovered.getTask(created.task.taskId).task).toEqual(created.task)
    expect(recovered.getTaskUpdates(created.task.taskId)).toMatchObject({
      latestCursor: 1, updates: [expect.objectContaining({ cursor: 1 })],
    })
  })

  it('keeps stream history across reset and returns an authoritative snapshot for stale retained cursors', async () => {
    const path = await databasePath()
    const instance = runtime(path, { maxTaskUpdatesPerTask: 2 })
    const created = instance.createTask(createRequest())
    const cancelled = instance.cancelTask(created.task.taskId, {
      clientRequestId: 'cancel-retained', expectedTaskRevision: created.task.taskRevision, eventId: 'cancel-retained',
    })
    const reset = instance.resetTask(created.task.taskId, {
      clientRequestId: 'reset-retained', expectedTaskRevision: cancelled.task.taskRevision,
    })
    expect(instance.getTaskUpdates(created.task.taskId, 0)).toMatchObject({
      latestCursor: 3, staleCursor: true,
      updates: [expect.objectContaining({ cursor: 3, snapshot: expect.objectContaining({ task: reset.task }) })],
    })
  })

  it('binds a database to one explicit provider mode', async () => {
    const path = await databasePath()
    const fixture = runtime(path)
    const created = fixture.createTask(createRequest())
    expect(created.meta.mode).toBe('fixture')
    fixture.close()

    expect(() => runtime(path, { mode: 'mock', providerFactory: (sideEffectRuntime) => createProviderRegistry(sideEffectRuntime, 'mock') }))
      .toThrow('created for provider mode fixture')
    expect(() => new PersistentAgentRuntime({ databasePath: ':memory:', mode: 'live' }))
      .toThrow('durableExternalIdempotency')

    const mockRuntime = runtime(await databasePath(), { mode: 'mock' })
    expect(mockRuntime.createTask(createRequest('mock-create')).meta.mode).toBe('mock')
  })

  it('parses configured provider modes and rejects typos', () => {
    expect(providerModeFromEnvironment({})).toBe('fixture')
    expect(providerModeFromEnvironment({ AGENT_PROVIDER_MODE: 'mock' })).toBe('mock')
    expect(() => providerModeFromEnvironment({ AGENT_PROVIDER_MODE: 'fixtures' })).toThrow('Unsupported AGENT_PROVIDER_MODE')
  })

  it('does not accept fixture envelopes from a configured live adapter', () => {
    const providerFactory = ((sideEffectRuntime) => createProviderRegistry(sideEffectRuntime, 'fixture')) as import('./persistent').ProviderFactory
    providerFactory.durableExternalIdempotency = true
    const live = runtime(':memory:', { mode: 'live', providerFactory })
    const created = live.createTask(createRequest('live-create'))

    expect(created.meta).toMatchObject({ mode: 'live', fallbackUsed: true })
    expect(created.task.flight).toMatchObject({ flightNumber: 'MU5102', trusted: false })
  })
})

function returningTask(agent: PersistentAgentRuntime) {
  const created = agent.createTask(createRequest())
  const started = agent.submitAction(created.task.taskId, {
    clientRequestId: 'persistent-return-start', expectedTaskRevision: created.task.taskRevision,
    expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation',
    componentId: 'navigation-plan', idempotencyKey: 'persistent-return-start',
  })
  const approaching = agent.submitEvent(created.task.taskId, {
    clientRequestId: 'persistent-return-geofence', expectedTaskRevision: started.task.taskRevision,
    event: { eventId: 'persistent-return-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
  })
  const waiting = agent.submitEvent(created.task.taskId, {
    clientRequestId: 'persistent-return-parked', expectedTaskRevision: approaching.task.taskRevision,
    event: { eventId: 'persistent-return-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
  })
  return agent.submitEvent(created.task.taskId, {
    clientRequestId: 'persistent-return-onboard', expectedTaskRevision: waiting.task.taskRevision,
    event: { eventId: 'persistent-return-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
  })
}

function completeTask(agent: PersistentAgentRuntime) {
  const created = agent.createTask(createRequest())
  const started = agent.submitAction(created.task.taskId, {
    clientRequestId: 'start-navigation',
    expectedTaskRevision: created.task.taskRevision,
    expectedUiRevision: created.ui.uiRevision,
    actionId: 'start-navigation',
    componentId: 'navigation-plan',
    idempotencyKey: 'start-navigation-001',
  })
  const approaching = agent.submitEvent(created.task.taskId, {
    clientRequestId: 'geofence', expectedTaskRevision: started.task.taskRevision,
    event: { eventId: 'geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
  })
  const waiting = agent.submitEvent(created.task.taskId, {
    clientRequestId: 'parked', expectedTaskRevision: approaching.task.taskRevision,
    event: { eventId: 'parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
  })
  const returning = agent.submitEvent(created.task.taskId, {
    clientRequestId: 'onboard', expectedTaskRevision: waiting.task.taskRevision,
    event: { eventId: 'onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
  })
  return agent.submitEvent(created.task.taskId, {
    clientRequestId: 'arrived', expectedTaskRevision: returning.task.taskRevision,
    event: { eventId: 'arrived', type: 'destination.arrived', destination: '家', timestamp: '2026-07-22T12:05:00+08:00' },
  }).task
}
