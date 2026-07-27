import { describe, expect, it, vi } from 'vitest'
import { buildLandingNotifyContent, createProviderRegistry, createSideEffectRuntime } from '@canvasflow/tools'
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

const failedLandingTask = {
  ...task,
  phase: 'driving-to-airport' as const,
  flight: { ...task.flight, status: 'landed' as const },
  navigation: { ...task.navigation, status: 'active' as const },
  message: {
    ...task.message,
    status: 'failed' as const,
    pendingContactId: 'contact-mom',
  },
}

const providerMeta = (taskId: string, tool: string, requestId: string) => ({
  requestId,
  taskId,
  tool,
  provider: 'fixture' as const,
  durationMs: 1,
  generatedAt: '2026-07-22T12:00:00+08:00',
})

describe('EffectExecutor', () => {
  it('applies a returning-home cabin preference through the provider', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const applyCabin = vi.fn(registry['vehicle.apply-cabin-profile'])
    const executor = new EffectExecutor({ ...registry, 'vehicle.apply-cabin-profile': applyCabin })
    const returning = {
      ...task,
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true },
      navigation: { ...task.navigation, status: 'active' as const },
    }

    const result = executor.applyCabinPreferences({
      task: returning,
      memberIds: ['mom'],
      temperatureC: 25,
      idempotencyKey: 'cabin-001',
      effectId: 'cabin-001:0',
    })

    expect(applyCabin).toHaveBeenCalledWith(
      { taskId: task.taskId, requestId: 'pickup-001:vehicle.apply-cabin-profile:cabin-001' },
      { zone: 'rear', temperatureC: 25, sourceMemberIds: ['mom'], idempotencyKey: 'cabin-001' },
    )
    expect(result).toEqual({
      succeeded: true,
      effect: { effectId: 'cabin-001:0', type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' },
      cabinEffectId: 'pickup-001:cabin:cabin-001',
    })
  })

  it('policy-denies cabin preference execution without calling the provider', () => {
    const registry = createProviderRegistry()
    const applyCabin = vi.fn(registry['vehicle.apply-cabin-profile'])
    const result = new EffectExecutor({ ...registry, 'vehicle.apply-cabin-profile': applyCabin }).applyCabinPreferences({
      task,
      memberIds: ['mom'],
      temperatureC: 25,
      idempotencyKey: 'cabin-denied',
      effectId: 'cabin-denied:0',
    })
    expect(applyCabin).not.toHaveBeenCalled()
    expect(result).toMatchObject({ succeeded: false, effect: { status: 'failed', errorCode: 'INVALID_TASK_PHASE' } })
  })

  it('reverts the applied cabin effect through the provider while parked', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const returning = {
      ...task,
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true },
      navigation: { ...task.navigation, status: 'active' as const },
      returnTrip: {
        workflowId: 'return-home',
        route: { status: 'succeeded' as const },
        cabin: { status: 'succeeded' as const },
        media: { status: 'succeeded' as const },
      },
    }
    const applied = registry['vehicle.apply-cabin-profile']({ taskId: task.taskId }, {
      zone: 'rear', temperatureC: 25, sourceMemberIds: ['mom'], idempotencyKey: 'apply-for-revert',
    })
    const revert = vi.fn(registry['vehicle.revert-cabin-profile'])

    const result = new EffectExecutor({ ...registry, 'vehicle.revert-cabin-profile': revert }).revertCabinProfile({
      task: returning,
      cabinEffectId: applied.data!.effectId,
      idempotencyKey: 'revert-001',
      effectId: 'revert-001:0',
      vehicle: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: false },
    })

    expect(revert).toHaveBeenCalledWith(
      { taskId: task.taskId, requestId: 'pickup-001:vehicle.revert-cabin-profile:revert-001' },
      { effectId: applied.data!.effectId, idempotencyKey: 'revert-001' },
    )
    expect(result).toMatchObject({
      succeeded: true,
      effect: { type: 'vehicle.revert-cabin-profile', status: 'succeeded' },
      current: { temperatureC: 22 },
    })
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  it('policy-denies cabin revert while moving without calling the provider', () => {
    const registry = createProviderRegistry()
    const revert = vi.fn(registry['vehicle.revert-cabin-profile'])
    const returning = {
      ...task,
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true },
      returnTrip: {
        workflowId: 'return-home',
        route: { status: 'succeeded' as const },
        cabin: { status: 'succeeded' as const },
        media: { status: 'succeeded' as const },
      },
    }

    const result = new EffectExecutor({ ...registry, 'vehicle.revert-cabin-profile': revert }).revertCabinProfile({
      task: returning,
      cabinEffectId: 'pickup-001:cabin:apply',
      idempotencyKey: 'revert-moving',
      effectId: 'revert-moving:0',
      vehicle: { speedKph: 20, batteryPercent: 42, remainingRangeKm: 210, gear: 'D', isNight: false },
    })

    expect(revert).not.toHaveBeenCalled()
    expect(result).toMatchObject({ succeeded: false, effect: { status: 'failed', errorCode: 'VEHICLE_MOVING' } })
  })

  it('marks a provider-reported revert with invalid metadata as ambiguous', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const returning = {
      ...task,
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true },
      returnTrip: {
        workflowId: 'return-home',
        route: { status: 'succeeded' as const },
        cabin: { status: 'succeeded' as const },
        media: { status: 'succeeded' as const },
      },
    }
    const applied = registry['vehicle.apply-cabin-profile']({ taskId: task.taskId }, {
      zone: 'rear', temperatureC: 25, sourceMemberIds: ['mom'], idempotencyKey: 'apply-ambiguous-revert',
    })
    const executor = new EffectExecutor({
      ...registry,
      'vehicle.revert-cabin-profile': (ctx, input) => {
        const result = registry['vehicle.revert-cabin-profile'](ctx, input)
        return { ...result, meta: { ...result.meta, requestId: 'wrong-request' } }
      },
    })

    expect(executor.revertCabinProfile({
      task: returning,
      cabinEffectId: applied.data!.effectId,
      idempotencyKey: 'revert-ambiguous',
      effectId: 'revert-ambiguous:0',
      vehicle: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: false },
    })).toMatchObject({
      succeeded: false,
      ambiguous: true,
      effect: { status: 'failed', errorCode: 'PROVIDER_FAILED' },
      current: { temperatureC: 22 },
    })
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  it('fails closed when cabin provider metadata does not match the request', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const returning = {
      ...task,
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true },
      navigation: { ...task.navigation, status: 'active' as const },
    }
    const executor = new EffectExecutor({
      ...registry,
      'vehicle.apply-cabin-profile': (ctx, input) => {
        const result = registry['vehicle.apply-cabin-profile'](ctx, input)
        return { ...result, meta: { ...result.meta, requestId: 'wrong-request' } }
      },
    })
    expect(executor.applyCabinPreferences({
      task: returning, memberIds: ['mom'], temperatureC: 25,
      idempotencyKey: 'cabin-wrong-meta', effectId: 'cabin-wrong-meta:0',
    })).toMatchObject({ succeeded: false, effect: { status: 'failed', errorCode: 'PROVIDER_FAILED' } })
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  it('compensates a semantically invalid cabin apply before reporting failure', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const revert = vi.fn(registry['vehicle.revert-cabin-profile'])
    const returning = {
      ...task,
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true },
      navigation: { ...task.navigation, status: 'active' as const },
    }
    const executor = new EffectExecutor({
      ...registry,
      'vehicle.apply-cabin-profile': (ctx, input) => {
        const result = registry['vehicle.apply-cabin-profile'](ctx, input)
        return result.ok && result.data
          ? { ...result, data: { ...result.data, current: { ...result.data.current, temperatureC: 24 } } }
          : result
      },
      'vehicle.revert-cabin-profile': revert,
    })

    const result = executor.applyCabinPreferences({
      task: returning, memberIds: ['mom'], temperatureC: 25,
      idempotencyKey: 'cabin-invalid-output', effectId: 'cabin-invalid-output:0',
    })

    expect(revert).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      succeeded: false,
      effect: { status: 'failed', errorCode: 'PROVIDER_FAILED' },
      compensationEffect: { type: 'vehicle.revert-cabin-profile', status: 'succeeded' },
      residualApplied: false,
    })
  })

  it('keeps cabin state residual when rollback metadata is invalid', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const returning = {
      ...task,
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true },
      navigation: { ...task.navigation, status: 'active' as const },
    }
    const executor = new EffectExecutor({
      ...registry,
      'vehicle.apply-cabin-profile': (ctx, input) => {
        const result = registry['vehicle.apply-cabin-profile'](ctx, input)
        return result.ok && result.data
          ? { ...result, data: { ...result.data, current: { ...result.data.current, temperatureC: 24 } } }
          : result
      },
      'vehicle.revert-cabin-profile': (ctx, input) => {
        const result = registry['vehicle.revert-cabin-profile'](ctx, input)
        return { ...result, meta: { ...result.meta, requestId: 'wrong-request' } }
      },
    })

    expect(executor.applyCabinPreferences({
      task: returning, memberIds: ['mom'], temperatureC: 25,
      idempotencyKey: 'cabin-wrong-rollback-meta', effectId: 'cabin-wrong-rollback-meta:0',
    })).toMatchObject({ succeeded: false, residualApplied: true, cabinEffectId: expect.any(String) })
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  it('fails closed when authorization revocation metadata does not match the request', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const authorizationId = runtime.confirmations.issueAutoNotifyAuthorization({
      taskId: task.taskId, contactId: 'contact-mom', messageId: 'message-1', text: 'hello',
    })
    const scheduled = { ...task, message: { ...task.message, authorizationId } }
    const executor = new EffectExecutor({
      ...registry,
      'message.revoke-authorization': (ctx, input) => {
        const result = registry['message.revoke-authorization'](ctx, input)
        return { ...result, meta: { ...result.meta, requestId: 'wrong-request' } }
      },
    })
    expect(executor.revokeLandingMessageAuthorization({
      task: scheduled, authorizationId, idempotencyKey: 'wrong-revoke-meta', effectId: 'wrong-revoke-meta:0',
    })).toMatchObject({ succeeded: false, ambiguous: true, effect: { status: 'failed', errorCode: 'PROVIDER_FAILED' } })
    expect(registry['message.send']({ taskId: task.taskId }, {
      contactId: 'contact-mom', messageId: 'message-1', text: 'hello', authorizationId, idempotencyKey: 'send-after-wrong-revoke',
    }).error?.code).toBe('AUTHORIZATION_REQUIRED')
  })

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
    [{ speedKph: 10, batteryPercent: 42, remainingRangeKm: 210, gear: 'P' as const, isNight: false }, false],
    [{ speedKph: 10, batteryPercent: 42, remainingRangeKm: 210, gear: 'D' as const, isNight: false }, false],
    [{ speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P' as const, isNight: false }, true],
    [{ speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'D' as const, isNight: false }, false],
  ])('gates navigation against parked vehicle state %#', (vehicle, allowed) => {
    expect(new DefaultPolicyGate().authorizeNavigationStart(task, task.navigation.routeId, vehicle).allowed).toBe(allowed)
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

  it('prepares a deterministic landing retry through the injected registry', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const prepare = vi.fn(registry['message.prepare'])
    const executor = new EffectExecutor({ ...registry, 'message.prepare': prepare })

    const result = executor.prepareLandingMessageRetry({
      task: failedLandingTask,
      contactId: 'contact-mom',
      idempotencyKey: 'retry-landing-001',
      effectId: 'retry-landing-001:0',
    })

    expect(prepare).toHaveBeenCalledWith(
      { taskId: task.taskId, requestId: 'pickup-001:message.prepare:retry-landing-001' },
      { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:25' },
    )
    expect(result).toMatchObject({
      succeeded: true,
      effect: {
        effectId: 'retry-landing-001:0',
        type: 'message.prepare',
        tool: 'message.prepare',
        status: 'pending-confirmation',
      },
      prepared: buildLandingNotifyContent(task.taskId, 'contact-mom', 'MU5102', '20:25'),
    })
    expect(result.prepared?.confirmationId).toMatch(/^cnf_/)
  })

  it.each([
    ['malformed envelope', () => ({ unexpected: true }), 'PROVIDER_FAILED'],
    ['wrong metadata', (ctx: { taskId: string; requestId?: string }) => ({
      ok: true,
      data: { ...buildLandingNotifyContent(ctx.taskId, 'contact-mom', 'MU5102', '20:25'), confirmationId: 'cnf_test' },
      error: null,
      meta: providerMeta(ctx.taskId, 'message.prepare', 'wrong-request'),
    }), 'COMPENSATION_FAILED'],
    ['wrong semantic payload', (ctx: { taskId: string; requestId?: string }) => ({
      ok: true,
      data: { ...buildLandingNotifyContent(ctx.taskId, 'contact-mom', 'MU5102', '20:26'), confirmationId: 'cnf_test' },
      error: null,
      meta: providerMeta(ctx.taskId, 'message.prepare', ctx.requestId!),
    }), 'COMPENSATION_FAILED'],
  ])('rejects %s from message.prepare', (_label, prepare, errorCode) => {
    const registry = createProviderRegistry()
    const executor = new EffectExecutor({ ...registry, 'message.prepare': prepare as typeof registry['message.prepare'] })

    expect(executor.prepareLandingMessageRetry({
      task: failedLandingTask,
      contactId: 'contact-mom',
      idempotencyKey: 'retry-invalid',
      effectId: 'retry-invalid:0',
    })).toMatchObject({
      succeeded: false,
      effect: { type: 'message.prepare', status: 'failed', errorCode },
    })
  })

  it('sends a confirmed retry with exact request metadata and no auto-notify credential', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const executor = new EffectExecutor(registry)
    const prepared = executor.prepareLandingMessageRetry({
      task: failedLandingTask,
      contactId: 'contact-mom',
      idempotencyKey: 'retry-to-send',
      effectId: 'retry-to-send:prepare',
    }).prepared!
    const send = vi.fn(registry['message.send'])
    const sendExecutor = new EffectExecutor({ ...registry, 'message.send': send })
    const armedTask = {
      ...failedLandingTask,
      message: {
        ...failedLandingTask.message,
        pendingContactId: prepared.contactId,
        pendingMessageId: prepared.messageId,
        pendingText: prepared.text,
      },
      pendingConfirmation: { confirmationId: prepared.confirmationId, action: 'send-message' as const },
    }

    const result = sendExecutor.sendConfirmedLandingMessage({
      task: armedTask,
      ...prepared,
      idempotencyKey: 'confirm-retry-001',
      effectId: 'confirm-retry-001:0',
    })

    expect(send).toHaveBeenCalledWith(
      { taskId: task.taskId, requestId: 'pickup-001:message.send:confirm-retry-001' },
      {
        contactId: prepared.contactId,
        messageId: prepared.messageId,
        text: prepared.text,
        confirmationId: prepared.confirmationId,
        idempotencyKey: 'confirm-retry-001',
      },
    )
    expect(result).toEqual({
      succeeded: true,
      effect: {
        effectId: 'confirm-retry-001:0',
        type: 'message.send',
        tool: 'message.send',
        status: 'succeeded',
      },
    })
  })

  it('sends the exact prepared text even when the route ETA changes before confirmation', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const executor = new EffectExecutor(registry)
    const prepared = executor.prepareLandingMessageRetry({
      task: failedLandingTask, contactId: 'contact-mom', idempotencyKey: 'prepare-stable-text', effectId: 'prepare-stable-text:0',
    }).prepared!
    const send = vi.fn(registry['message.send'])
    const armedTask = {
      ...failedLandingTask,
      navigation: { ...failedLandingTask.navigation, eta: '2026-07-22T21:10:00+08:00' },
      message: {
        ...failedLandingTask.message,
        pendingContactId: prepared.contactId,
        pendingMessageId: prepared.messageId,
        pendingText: prepared.text,
      },
      pendingConfirmation: { confirmationId: prepared.confirmationId, action: 'send-message' as const },
    }
    const result = new EffectExecutor({ ...registry, 'message.send': send }).sendConfirmedLandingMessage({
      task: armedTask, ...prepared, idempotencyKey: 'confirm-stable-text', effectId: 'confirm-stable-text:0',
    })
    expect(result.succeeded).toBe(true)
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: prepared.text }))
  })

  it('uses the injected retry policy and never calls providers when denied', () => {
    const registry = createProviderRegistry()
    const prepare = vi.fn(registry['message.prepare'])
    const send = vi.fn(registry['message.send'])
    const policy = {
      ...new DefaultPolicyGate(),
      authorizeNavigationStart: new DefaultPolicyGate().authorizeNavigationStart.bind(new DefaultPolicyGate()),
      authorizeReturnTrip: new DefaultPolicyGate().authorizeReturnTrip.bind(new DefaultPolicyGate()),
      authorizeCabinRevert: new DefaultPolicyGate().authorizeCabinRevert.bind(new DefaultPolicyGate()),
      authorizeLandingMessage: new DefaultPolicyGate().authorizeLandingMessage.bind(new DefaultPolicyGate()),
      authorizeLandingMessageRetry: () => ({ allowed: false as const, errorCode: 'POLICY_DENIED' }),
    }
    const executor = new EffectExecutor({ ...registry, 'message.prepare': prepare, 'message.send': send }, policy)
    expect(executor.prepareLandingMessageRetry({
      task: failedLandingTask, contactId: 'contact-mom', idempotencyKey: 'denied-prepare', effectId: 'denied-prepare:0',
    })).toMatchObject({ succeeded: false, effect: { errorCode: 'POLICY_DENIED' } })
    expect(executor.sendConfirmedLandingMessage({
      task: {
        ...failedLandingTask,
        pendingConfirmation: { confirmationId: 'cnf-denied', action: 'send-message' },
      },
      contactId: 'contact-mom', messageId: 'pickup-001:MU5102:landing', text: 'denied',
      confirmationId: 'cnf-denied', idempotencyKey: 'denied-send', effectId: 'denied-send:0',
    })).toMatchObject({ succeeded: false, effect: { errorCode: 'POLICY_DENIED' } })
    expect(prepare).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed envelope', () => ({ unexpected: true })],
    ['wrong metadata', (ctx: { taskId: string; requestId?: string }, input: { messageId: string }) => ({
      ok: true,
      data: { messageId: input.messageId, status: 'sent', sentAt: '2026-07-22T20:25:00+08:00' },
      error: null,
      meta: providerMeta(ctx.taskId, 'message.send', 'wrong-request'),
    })],
    ['wrong semantic payload', (ctx: { taskId: string; requestId?: string }) => ({
      ok: true,
      data: { messageId: 'wrong-message', status: 'sent', sentAt: '2026-07-22T20:25:00+08:00' },
      error: null,
      meta: providerMeta(ctx.taskId, 'message.send', ctx.requestId!),
    })],
  ])('rejects %s from confirmed message.send', (_label, send) => {
    const registry = createProviderRegistry()
    const prepared = buildLandingNotifyContent(task.taskId, 'contact-mom', 'MU5102', '20:25')
    const executor = new EffectExecutor({ ...registry, 'message.send': send as typeof registry['message.send'] })
    const armedTask = {
      ...failedLandingTask,
      message: { ...failedLandingTask.message, pendingMessageId: prepared.messageId },
      pendingConfirmation: { confirmationId: 'cnf_test', action: 'send-message' as const },
    }

    expect(executor.sendConfirmedLandingMessage({
      task: armedTask,
      ...prepared,
      confirmationId: 'cnf_test',
      idempotencyKey: 'send-invalid',
      effectId: 'send-invalid:0',
    })).toMatchObject({
      succeeded: false,
      effect: { type: 'message.send', status: 'failed', errorCode: 'PROVIDER_FAILED' },
    })
  })

  it('preserves a confirmed send provider error code', () => {
    const registry = createProviderRegistry()
    const prepared = buildLandingNotifyContent(task.taskId, 'contact-mom', 'MU5102', '20:25')
    const executor = new EffectExecutor({
      ...registry,
      'message.send': (ctx) => ({
        ok: false,
        data: null,
        error: { code: 'SEND_FAILED', message: 'failed', retryable: true },
        meta: providerMeta(ctx.taskId, 'message.send', ctx.requestId!),
      }),
    })

    expect(executor.sendConfirmedLandingMessage({
      task: {
        ...failedLandingTask,
        message: { ...failedLandingTask.message, pendingMessageId: prepared.messageId },
        pendingConfirmation: { confirmationId: 'cnf_test', action: 'send-message' },
      },
      ...prepared,
      confirmationId: 'cnf_test',
      idempotencyKey: 'send-failed',
      effectId: 'send-failed:0',
    })).toMatchObject({
      succeeded: false,
      effect: { status: 'failed', errorCode: 'SEND_FAILED' },
    })
  })
})
