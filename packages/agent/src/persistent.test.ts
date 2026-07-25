import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProviderRegistry, type ProviderRegistry } from '@canvasflow/tools'
import { PersistentAgentRuntime, providerModeFromEnvironment } from './persistent'

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
