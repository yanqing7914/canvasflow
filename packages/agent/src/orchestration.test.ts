import type { FlightStatusOutput, GetPreferencesOutput, ToolResult } from '@canvasflow/schema'
import { createProviderRegistry, DEMO_PICKUP_POINT, type ProviderRegistry, type ToolContext } from '@canvasflow/tools'
import { describe, expect, it, vi } from 'vitest'
import { ReadToolOrchestrationError, ReadToolOrchestrator } from './orchestration'

type MutableProviderRegistry = { -readonly [K in keyof ProviderRegistry]: ProviderRegistry[K] }

function createMutableRegistry(): MutableProviderRegistry {
  return { ...createProviderRegistry() }
}

function successfulResult<T>(tool: string, data: T, requestId = `request:${tool}`): ToolResult<T> {
  return {
    ok: true,
    data,
    error: null,
    meta: {
      requestId,
      taskId: 'pickup-001',
      tool,
      provider: 'fixture',
      durationMs: 1,
      generatedAt: '2026-07-22T12:00:00+08:00',
    },
  }
}

describe('ReadToolOrchestrator', () => {
  it('wires passenger and trip reads through validated provider results', () => {
    const base = createProviderRegistry()
    const registry = Object.fromEntries(Object.entries(base).map(([name, handler]) => [name, vi.fn(handler)])) as unknown as MutableProviderRegistry
    const orchestrator = new ReadToolOrchestrator({ registry })

    const passengers = orchestrator.resolveInitialPassengers('pickup-001', 'create-001', ['妈妈', '豆豆'])
    const prepared = orchestrator.prepareTrip('pickup-001', 'event-001', 'MU5102')

    expect(passengers).toMatchObject({
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'] },
      notificationAuthorized: true,
    })
    expect(prepared).toMatchObject({
      flight: { flightNumber: 'MU5102', terminal: 'T2' },
      route: { routeId: 'route-airport-001', distanceKm: 32, arrivalTime: '2026-07-22T20:25:00+08:00' },
      vehicle: { batteryPercent: 42, remainingRangeKm: 112 },
      charging: { recommended: true, estimatedFinalBatteryPercent: 18 },
    })
    expect(registry['memory.get-preferences']).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'pickup-001' }),
      { memberIds: ['mom', 'doubao'], scopes: ['notification'] },
    )
    expect(registry['charging.recommend']).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'pickup-001' }),
      { batteryPercent: 42, remainingRangeKm: 112, outboundDistanceKm: 32, returnDistanceKm: 32, safetyReservePercent: 20 },
    )
  })

  it('uses request vehicle context and destination for trip preparation', () => {
    const base = createProviderRegistry()
    const registry = Object.fromEntries(Object.entries(base).map(([name, handler]) => [name, vi.fn(handler)])) as unknown as MutableProviderRegistry
    registry['navigation.plan-route'] = vi.fn((ctx) => successfulResult('navigation.plan-route', {
      routeId: 'route-airport-t1',
      distanceKm: 30,
      durationMinutes: 18,
      arrivalTime: '2026-07-22T20:23:00+08:00',
      estimatedBatteryAtArrival: 78,
      waypoints: [
        { id: 'origin-demo', name: '出发地', latitude: 31.23, longitude: 121.47 },
        { id: 'destination-hongqiao-t1', name: '虹桥机场 T1', latitude: 31.19, longitude: 121.34 },
      ],
    }, ctx.requestId))
    const orchestrator = new ReadToolOrchestrator({ registry })

    orchestrator.prepareTrip('pickup-001', 'event-context', 'MU5102', {
      vehicle: { speedKph: 0, batteryPercent: 90, remainingRangeKm: 240, gear: 'P', isNight: false },
      destination: { id: 'destination-hongqiao-t1', name: '虹桥机场 T1' },
    })

    expect(registry['vehicle.get-status']).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'pickup-001' }),
      { context: { speedKph: 0, batteryPercent: 90, remainingRangeKm: 240, gear: 'P', isNight: false } },
    )
    expect(registry['navigation.plan-route']).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'pickup-001' }),
      expect.objectContaining({ destination: { id: 'destination-hongqiao-t1', name: '虹桥机场 T1' } }),
    )
  })

  it('plans the cockpit return from the fixed pickup point, not the demo origin', () => {
    const registry = createMutableRegistry()
    registry['charging.recommend'] = vi.fn(registry['charging.recommend'])
    const orchestrator = new ReadToolOrchestrator({ registry })

    const result = orchestrator.resolveCockpitRoute('pickup-001', 'return-from-pickup', { leg: 'return' })

    expect(result.route.data.routeId).toBe('route-home-from-pickup-001')
    expect(result.route.data.waypoints?.[0]).toMatchObject({
      id: 'pickup-demo', latitude: DEMO_PICKUP_POINT.latitude, longitude: DEMO_PICKUP_POINT.longitude,
    })
    expect(registry['charging.recommend']).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'pickup-001', requestId: 'return-from-pickup:charging.recommend' }),
      {
        batteryPercent: 42,
        remainingRangeKm: 112,
        outboundDistanceKm: result.route.data.distanceKm,
        returnDistanceKm: 0,
        safetyReservePercent: 20,
      },
    )
    expect(result.charging.data).toMatchObject({ recommended: false, estimatedFinalBatteryPercent: 30 })
  })

  it('re-evaluates charging from the vehicle and route distances supplied at query time', () => {
    const registry = createMutableRegistry()
    registry['charging.recommend'] = vi.fn(registry['charging.recommend'])
    const orchestrator = new ReadToolOrchestrator({ registry })

    const result = orchestrator.resolveCharging('pickup-001', 'charging-now', {
      batteryPercent: 31,
      remainingRangeKm: 82,
      outboundDistanceKm: 12,
      returnDistanceKm: 32,
    })

    expect(registry['charging.recommend']).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'pickup-001', requestId: 'charging-now:charging.recommend' }),
      {
        batteryPercent: 31,
        remainingRangeKm: 82,
        outboundDistanceKm: 12,
        returnDistanceKm: 32,
        safetyReservePercent: 20,
      },
    )
    expect(result.data.estimatedFinalBatteryPercent).toBe(14)
    expect(result.data.recommended).toBe(true)
  })

  it('rejects invalid envelopes before using provider data', () => {
    const registry = createMutableRegistry()
    registry['family.resolve-members'] = () => ({ ok: true, data: { members: [] } }) as unknown as ReturnType<ProviderRegistry['family.resolve-members']>
    const orchestrator = new ReadToolOrchestrator({ registry })

    expect(() => orchestrator.resolveInitialPassengers('pickup-001', 'create-001', ['妈妈'])).toThrowError(
      expect.objectContaining<Partial<ReadToolOrchestrationError>>({ code: 'PROVIDER_FAILED', retryable: false }),
    )
  })

  it('rejects a valid envelope from a different provider request', () => {
    const registry = createMutableRegistry()
    const original = registry['family.resolve-members']
    registry['family.resolve-members'] = (ctx, input) => {
      const result = original(ctx, input)
      return { ...result, meta: { ...result.meta, requestId: 'stale-request:family.resolve-members' } }
    }
    const orchestrator = new ReadToolOrchestrator({ registry })

    expect(() => orchestrator.resolveInitialPassengers('pickup-001', 'create-001', ['妈妈'])).toThrowError(
      expect.objectContaining<Partial<ReadToolOrchestrationError>>({ code: 'PROVIDER_FAILED', retryable: false }),
    )
  })

  it('authorizes notification when a later contactable member has valid authorization', () => {
    const registry = createMutableRegistry()
    registry['family.resolve-members'] = (ctx) => successfulResult('family.resolve-members', {
      members: [
        { memberId: 'doubao', displayName: '豆豆' },
        { memberId: 'mom', displayName: '妈妈', contactId: 'contact-mom' },
      ],
      unresolvedLabels: [],
    }, ctx.requestId)
    registry['memory.get-preferences'] = (ctx: ToolContext, input?: unknown) => {
      expect(input).toEqual({ memberIds: ['doubao', 'mom'], scopes: ['notification'] })
      return successfulResult<GetPreferencesOutput>('memory.get-preferences', {
        members: [
          { memberId: 'doubao', landingNotificationAuthorized: false },
          { memberId: 'mom', landingNotificationAuthorized: true },
        ],
      }, ctx.requestId)
    }

    expect(new ReadToolOrchestrator({ registry }).resolveInitialPassengers(
      'pickup-001',
      'create-001',
      ['妈妈', '豆豆'],
    ).notificationAuthorized).toBe(true)
  })

  it('does not authorize notification for an authorized member without a contact id', () => {
    const registry = createMutableRegistry()
    registry['memory.get-preferences'] = (ctx) => successfulResult<GetPreferencesOutput>('memory.get-preferences', {
      members: [{ memberId: 'doubao', landingNotificationAuthorized: true }],
    }, ctx.requestId)

    expect(new ReadToolOrchestrator({ registry }).resolveInitialPassengers(
      'pickup-001',
      'create-001',
      ['豆豆'],
    ).notificationAuthorized).toBe(false)
  })

  it('retries flight status exactly once after a retryable failure', () => {
    const registry = createMutableRegistry()
    const success = registry['flight.get-status']
    registry['flight.get-status'] = vi.fn()
      .mockImplementationOnce((ctx) => ({
        ...successfulResult<FlightStatusOutput>('flight.get-status', {
          flightNumber: 'MU5102',
          status: 'scheduled',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T20:40:00+08:00',
          arrivalAirport: 'SHA',
          arrivalAirportName: '虹桥机场',
          terminal: 'T2',
          sourceUpdatedAt: '2026-07-22T12:00:00+08:00',
        }),
        ok: false,
        data: null,
        error: { code: 'PROVIDER_TIMEOUT', message: 'temporary timeout', retryable: true },
        meta: { ...successfulResult<FlightStatusOutput>('flight.get-status', { flightNumber: 'MU5102', status: 'scheduled', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', arrivalAirport: 'SHA', arrivalAirportName: '虹桥机场', terminal: 'T2', sourceUpdatedAt: '2026-07-22T12:00:00+08:00' }).meta, requestId: ctx.requestId },
      }))
      .mockImplementation(success)

    expect(new ReadToolOrchestrator({ registry }).prepareTrip('pickup-001', 'event-001', 'MU5102').flight.flightNumber)
      .toBe('MU5102')
    expect(registry['flight.get-status']).toHaveBeenCalledTimes(2)
  })

  it('retries route planning once, then returns the second retryable failure', () => {
    const registry = createMutableRegistry()
    const failure = {
      ok: false,
      data: null,
      error: { code: 'PROVIDER_TIMEOUT', message: 'route timeout', retryable: true },
      meta: {
        requestId: 'event-001:navigation.plan-route', taskId: 'pickup-001', tool: 'navigation.plan-route',
        provider: 'fixture' as const, durationMs: 1, generatedAt: '2026-07-22T12:00:00+08:00',
      },
    }
    registry['navigation.plan-route'] = vi.fn().mockReturnValue(failure)

    expect(() => new ReadToolOrchestrator({ registry }).prepareTrip('pickup-001', 'event-001', 'MU5102')).toThrowError(
      expect.objectContaining<Partial<ReadToolOrchestrationError>>({ code: 'PROVIDER_TIMEOUT', retryable: true }),
    )
    expect(registry['navigation.plan-route']).toHaveBeenCalledTimes(2)
  })

  it('maps provider timeout results to a retryable typed error', () => {
    const registry = createMutableRegistry()
    registry['flight.get-status'] = vi.fn(registry['flight.get-status'])
    const orchestrator = new ReadToolOrchestrator({ registry })

    expect(() => orchestrator.prepareTrip('pickup-001', 'event-001', 'MU0000')).toThrowError(
      expect.objectContaining<Partial<ReadToolOrchestrationError>>({ code: 'PROVIDER_TIMEOUT', retryable: true }),
    )
    expect(registry['flight.get-status']).toHaveBeenCalledTimes(2)
  })
})
