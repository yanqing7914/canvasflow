import { describe, expect, it, vi } from 'vitest'
import { createProviderRegistry, createSideEffectRuntime } from '@canvasflow/tools'
import { createInitialTask } from './index'
import { DefaultPolicyGate, EffectExecutor } from './effect-executor'

const task = {
  ...createInitialTask(),
  phase: 'preparing' as const,
  flight: {
    flightNumber: 'MU5102',
    status: 'scheduled' as const,
    scheduledArrival: '2026-07-22T20:30:00+08:00',
    estimatedArrival: '2026-07-22T20:40:00+08:00',
    terminal: 'T2',
  },
  navigation: {
    routeId: 'route-airport-001',
    destination: '虹桥机场 T2',
    eta: '2026-07-22T20:25:00+08:00',
    status: 'planned' as const,
  },
}

describe('EffectExecutor', () => {
  it('policy-gates return-trip effects and does not call providers for cancelled flights', () => {
    const registry = createProviderRegistry()
    const plan = vi.fn(registry['navigation.plan-route'])
    const executor = new EffectExecutor({ ...registry, 'navigation.plan-route': plan })
    const result = executor.executeReturnTrip({
      task: { ...createInitialTask(), phase: 'returning-home', passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true }, flight: { ...task.flight, status: 'cancelled' } },
      memberIds: ['mom'], preferences: { homeDestinationId: 'destination-home' }, idempotencyKey: 'cancelled-return', effectIdPrefix: 'cancelled-return:effect',
    })
    expect(plan).not.toHaveBeenCalled()
    expect(result).toMatchObject({ succeeded: false, effect: [{ type: 'return-trip', errorCode: 'FLIGHT_CANCELLED' }] })
  })
  it('calls navigation.start with stable request metadata and returns a succeeded receipt', () => {
    const runtime = createSideEffectRuntime()
    runtime.plannedRouteIdsByTask.set(task.taskId, new Set([task.navigation.routeId]))
    const registry = createProviderRegistry(runtime)
    const start = vi.fn(registry['navigation.start'])
    const executor = new EffectExecutor({ ...registry, 'navigation.start': start })

    const result = executor.startNavigation({
      task,
      routeId: task.navigation.routeId,
      idempotencyKey: 'nav-001',
      effectId: 'action:nav-001:0',
    })

    expect(start).toHaveBeenCalledWith(
      { taskId: task.taskId, requestId: 'pickup-001:navigation.start:nav-001' },
      { routeId: task.navigation.routeId, idempotencyKey: 'nav-001' },
    )
    expect(result).toEqual({
      succeeded: true,
      effect: {
        effectId: 'action:nav-001:0',
        type: 'navigation.start',
        status: 'succeeded',
        tool: 'navigation.start',
      },
    })
  })

  it.each([
    [{ ...task, phase: 'cancelled' as const }, 'TASK_TERMINAL'],
    [{ ...task, phase: 'driving-to-airport' as const }, 'INVALID_TASK_PHASE'],
    [{ ...task, flight: { ...task.flight, status: 'cancelled' as const } }, 'FLIGHT_CANCELLED'],
    [{ ...task, navigation: { ...task.navigation, status: 'active' as const } }, 'ROUTE_NOT_PLANNED'],
  ])('denies unsafe task state without calling the provider', (unsafeTask, errorCode) => {
    const registry = createProviderRegistry()
    const start = vi.fn(registry['navigation.start'])
    const executor = new EffectExecutor({ ...registry, 'navigation.start': start })

    const result = executor.startNavigation({
      task: unsafeTask,
      routeId: task.navigation.routeId,
      idempotencyKey: 'nav-policy',
      effectId: 'action:nav-policy:0',
    })

    expect(start).not.toHaveBeenCalled()
    expect(result).toMatchObject({ succeeded: false, effect: { status: 'failed', errorCode } })
  })

  it('denies a route that does not match the task plan', () => {
    const decision = new DefaultPolicyGate().authorizeNavigationStart(task, 'route-home-001')
    expect(decision).toEqual({ allowed: false, errorCode: 'ROUTE_MISMATCH' })
  })

  it.each([
    ['bad envelope', () => ({ unexpected: true })],
    ['wrong request metadata', () => ({
      ok: true,
      data: { navigationId: 'nav', routeId: task.navigation.routeId, status: 'active' },
      error: null,
      meta: {
        requestId: 'wrong', taskId: task.taskId, tool: 'navigation.start', provider: 'fixture', durationMs: 1,
        generatedAt: '2026-07-22T12:00:00+08:00',
      },
    })],
    ['wrong route output', (ctx: { taskId: string; requestId?: string }) => ({
      ok: true,
      data: { navigationId: 'nav', routeId: 'route-home-001', status: 'active' },
      error: null,
      meta: {
        requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'navigation.start', provider: 'fixture', durationMs: 1,
        generatedAt: '2026-07-22T12:00:00+08:00',
      },
    })],
  ])('maps %s to a provider failure receipt', (_label, startNavigation) => {
    const registry = createProviderRegistry()
    const executor = new EffectExecutor({ ...registry, 'navigation.start': startNavigation as typeof registry['navigation.start'] })

    expect(executor.startNavigation({
      task,
      routeId: task.navigation.routeId,
      idempotencyKey: 'nav-invalid',
      effectId: 'action:nav-invalid:0',
    })).toMatchObject({
      succeeded: false,
      effect: { status: 'failed', errorCode: 'PROVIDER_FAILED' },
    })
  })

  it('preserves provider error codes in failed receipts', () => {
    const registry = createProviderRegistry()
    const executor = new EffectExecutor({
      ...registry,
      'navigation.start': (ctx) => ({
        ok: false,
        data: null,
        error: { code: 'ROUTE_EXPIRED', message: 'expired', retryable: false },
        meta: {
          requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'navigation.start', provider: 'fixture', durationMs: 1,
          generatedAt: '2026-07-22T12:00:00+08:00',
        },
      }),
    })

    expect(executor.startNavigation({
      task,
      routeId: task.navigation.routeId,
      idempotencyKey: 'nav-expired',
      effectId: 'action:nav-expired:0',
    })).toMatchObject({
      succeeded: false,
      effect: { status: 'failed', errorCode: 'ROUTE_EXPIRED' },
    })
  })
})
