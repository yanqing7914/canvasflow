import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { z } from 'zod'
import {
  applyCabinProfileOutputSchema,
  chargingRecommendationOutputSchema,
  listUpcomingEventsOutputSchema,
  confirmMemoryUpdateOutputSchema,
  flightStatusOutputSchema,
  getPreferencesOutputSchema,
  mediaPlayOutputSchema,
  messagePrepareOutputSchema,
  messageSendOutputSchema,
  revokeMessageConfirmationOutputSchema,
  revokeMessageAuthorizationOutputSchema,
  navigationStartOutputSchema,
  navigationUpdateRouteOutputSchema,
  proposeMemoryUpdateOutputSchema,
  rejectMemoryUpdateOutputSchema,
  resolveMembersOutputSchema,
  revertCabinProfileOutputSchema,
  routePlanOutputSchema,
  scenarioFixtureSchema,
  toolResultSchema,
  vehicleStatusOutputSchema,
  type AirportPickupEvent,
  type AirportPickupTaskState,
  type ScenarioFixture,
} from '@canvasflow/schema'
import { applyEvent } from '@canvasflow/agent'
import { recommendCharging } from './charging'
import { resolveMembers } from './family'
import { getFlightStatus } from './flight'
import { getPreferences } from './memory'
import { createMessagePreparer, issueAutoNotifyAuthorization } from './message'
import { planRoute } from './navigation'
import { createSideEffectRuntime } from './idempotency'
import { createProviderRegistry, toolDefinitions, type ToolName } from './registry'
import type { ToolContext } from './result'
import { getVehicleStatus } from './vehicle'

const FIXTURE_DIR = resolve(process.cwd(), 'fixtures/airport-pickup')

/** `ui.validate` documents UI-side spec validation; it is not a registry tool. */
const NON_REGISTRY_RESULT_KEYS = new Set(['ui.validate'])

const outputSchemas: Record<ToolName, z.ZodType> = {
  'family.resolve-members': resolveMembersOutputSchema,
  'memory.get-preferences': getPreferencesOutputSchema,
  'memory.propose-update': proposeMemoryUpdateOutputSchema,
  'memory.confirm-update': confirmMemoryUpdateOutputSchema,
  'memory.reject-update': rejectMemoryUpdateOutputSchema,
  'flight.get-status': flightStatusOutputSchema,
  'navigation.plan-route': routePlanOutputSchema,
  'navigation.start': navigationStartOutputSchema,
  'navigation.update-route': navigationUpdateRouteOutputSchema,
  'vehicle.get-status': vehicleStatusOutputSchema,
  'vehicle.apply-cabin-profile': applyCabinProfileOutputSchema,
  'vehicle.revert-cabin-profile': revertCabinProfileOutputSchema,
  'charging.recommend': chargingRecommendationOutputSchema,
  'calendar.list-upcoming': listUpcomingEventsOutputSchema,
  'media.play': mediaPlayOutputSchema,
  'message.prepare': messagePrepareOutputSchema,
  'message.send': messageSendOutputSchema,
  'message.revoke-confirmation': revokeMessageConfirmationOutputSchema,
  'message.revoke-authorization': revokeMessageAuthorizationOutputSchema,
}

function loadFixtures(): ScenarioFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => scenarioFixtureSchema.parse(JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), 'utf8'))))
}

const fixtures = loadFixtures()
const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]))

function toolData(fixtureId: string, tool: string): unknown {
  const fixture = fixtureById.get(fixtureId)
  expect(fixture, fixtureId).toBeDefined()
  const result = fixture!.toolResults[tool] as { data?: unknown } | undefined
  expect(result, `${fixtureId}:${tool}`).toBeDefined()
  return result!.data
}

const ctx: ToolContext = { taskId: 'pickup-001' }

describe('fixture toolResults contract', () => {
  it('covers one output schema per registered tool', () => {
    expect(Object.keys(outputSchemas).sort()).toEqual(Object.keys(toolDefinitions).sort())
  })

  it('validates every fixture toolResults entry against the tool output contract', () => {
    for (const fixture of fixtures) {
      for (const [tool, raw] of Object.entries(fixture.toolResults)) {
        if (NON_REGISTRY_RESULT_KEYS.has(tool)) continue
        const dataSchema = outputSchemas[tool as ToolName]
        expect(dataSchema, `${fixture.id}: 未注册的工具 ${tool}`).toBeDefined()
        const parsed = toolResultSchema(dataSchema).safeParse(raw)
        expect(parsed.success, `${fixture.id}:${tool} ${JSON.stringify(parsed.success ? '' : parsed.error.issues)}`).toBe(true)
        if (!parsed.success) continue
        expect(parsed.data.meta.tool, `${fixture.id}:${tool}`).toBe(tool)
        expect(parsed.data.meta.taskId, `${fixture.id}:${tool}`).toBe(fixture.initialTaskState.taskId)
        if (parsed.data.ok) {
          expect(parsed.data.data, `${fixture.id}:${tool}`).not.toBeNull()
          expect(parsed.data.error, `${fixture.id}:${tool}`).toBeNull()
        } else {
          expect(parsed.data.data, `${fixture.id}:${tool}`).toBeNull()
          expect(parsed.data.error, `${fixture.id}:${tool}`).not.toBeNull()
        }
      }
    }
  })

  it('regenerates read-only tool results from the fixture providers', () => {
    expect(resolveMembers(ctx, { labels: ['妈妈', '豆豆'] }).data)
      .toEqual(toolData('task-created', 'family.resolve-members'))
    expect(getVehicleStatus(ctx, { snapshot: 'parked' }).data)
      .toEqual(toolData('charging-recommended', 'vehicle.get-status'))
    expect(
      recommendCharging(ctx, {
        batteryPercent: 42,
        remainingRangeKm: 112,
        outboundDistanceKm: 32,
        returnDistanceKm: 32,
        safetyReservePercent: 20,
      }).data,
    ).toEqual(toolData('charging-recommended', 'charging.recommend'))
    expect(
      planRoute(ctx, {
        origin: { latitude: 31.23, longitude: 121.47 },
        destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
      }).data,
    ).toEqual(toolData('route-airport', 'navigation.plan-route'))
    const prepareMessage = createMessagePreparer(createSideEffectRuntime())
    for (const fixtureId of ['flight-landed', 'message-scheduled']) {
      const prepared = prepareMessage(ctx, { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:40' })
      expect(prepared.ok).toBe(true)
      expect(prepared.data!.confirmationId.startsWith('cnf_')).toBe(true)
      expect({ ...prepared.data!, confirmationId: '<opaque>' }).toEqual({
        ...(toolData(fixtureId, 'message.prepare') as Record<string, unknown>),
        confirmationId: '<opaque>',
      })
    }
    expect(getVehicleStatus(ctx, { snapshot: 'post-charge' }).data)
      .toEqual(toolData('charging-completed', 'vehicle.get-status'))
    expect(getVehicleStatus(ctx, { snapshot: 'city-driving' }).data)
      .toEqual(toolData('approaching-airport', 'vehicle.get-status'))
    expect(getVehicleStatus(ctx, { snapshot: 'airport-parked' }).data)
      .toEqual(toolData('waiting-for-passengers', 'vehicle.get-status'))
    expect(getVehicleStatus(ctx, { snapshot: 'rear-occupied' }).data)
      .toEqual(toolData('passengers-onboard', 'vehicle.get-status'))
    expect(getPreferences(ctx, { memberIds: ['mom', 'doubao'], scopes: ['cabin', 'media'] }).data)
      .toEqual(toolData('cabin-profile-applied', 'memory.get-preferences'))
  })

  it('regenerates side-effect tool results from the fixture providers', () => {
    const registry = createProviderRegistry(createSideEffectRuntime())
    expect(
      registry['navigation.plan-route'](ctx, {
        origin: { latitude: 31.23, longitude: 121.47 },
        destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
      }).ok,
    ).toBe(true)
    expect(registry['navigation.start'](ctx, { routeId: 'route-airport-001', idempotencyKey: 'nav-start-airport' }).data)
      .toEqual(toolData('route-airport', 'navigation.start'))
    expect(
      registry['navigation.update-route'](ctx, {
        routeId: 'route-airport-001',
        destination: { id: 'destination-home', name: '家' },
        idempotencyKey: 'nav-update-home',
      }).data,
    ).toEqual(toolData('passengers-onboard', 'navigation.update-route'))
    expect(
      registry['vehicle.apply-cabin-profile'](ctx, {
        zone: 'rear',
        temperatureC: 25,
        mediaTitle: '豆豆故事',
        sourceMemberIds: ['mom', 'doubao'],
        idempotencyKey: 'cabin-rear-v1',
      }).data,
    ).toEqual(toolData('cabin-profile-applied', 'vehicle.apply-cabin-profile'))
  })

  it('keeps hand-authored provider pushes consistent with the flight timeline', () => {
    // in-air / landed / delayed / cancelled 表示 provider 在时间线上的推送，静态主航班数据无法重放，只校验关键字段。
    expect(toolData('flight-in-air', 'flight.get-status')).toMatchObject({ flightNumber: 'MU5102', status: 'in-air' })
    expect(toolData('flight-landed', 'flight.get-status')).toMatchObject({ flightNumber: 'MU5102', status: 'landed', baggageClaim: '12' })
    expect(toolData('flight-delayed', 'flight.get-status')).toMatchObject({
      flightNumber: 'MU5102',
      status: 'delayed',
      terminal: 'T1',
      scheduledArrival: '2026-07-22T20:30:00+08:00',
      estimatedArrival: '2026-07-22T21:10:00+08:00',
    })
    expect(toolData('flight-cancelled', 'flight.get-status')).toMatchObject({ flightNumber: 'MU5102', status: 'cancelled' })
    const timeout = fixtureById.get('provider-timeout')!.toolResults['flight.get-status'] as { error: unknown }
    expect(timeout.error).toEqual(getFlightStatus(ctx, { flightNumber: 'MU0000', date: '2026-07-22' }).error)
  })
})

type TimelineRun = {
  finalState: AirportPickupTaskState
  trace: Array<{ eventId: string; phase: string; taskRevision: number }>
  sendResults: unknown[]
  cabinResults: unknown[]
}

/**
 * Replays the demo main flow: fixture input events in timeline order plus the
 * connector events (flight number, charging start, geofence, parked, message
 * sent) that occur between fixture snapshots.
 */
function replayMainTimeline(): TimelineRun {
  const event = (id: string): AirportPickupEvent => fixtureById.get(id)!.inputEvent
  const runtime = createSideEffectRuntime()
  const registry = createProviderRegistry(runtime)

  let state = fixtureById.get('task-created')!.initialTaskState
  const trace: TimelineRun['trace'] = []
  const step = (input: AirportPickupEvent) => {
    const next = applyEvent(state, input)
    // 重复投递同一事件必须是幂等 no-op
    expect(applyEvent(next, input)).toEqual(next)
    trace.push({ eventId: input.eventId, phase: next.phase, taskRevision: next.taskRevision })
    state = next
  }

  step(event('task-created'))
  const resolved = resolveMembers(ctx, { labels: ['妈妈', '豆豆'] })
  expect(resolved.ok).toBe(true)
  state = {
    ...state,
    passengers: {
      memberIds: resolved.data!.members.map((member) => member.memberId),
      names: resolved.data!.members.map((member) => member.displayName),
      confirmedOnboard: false,
    },
  }

  step({ eventId: 'timeline-flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T20:01:00+08:00' })
  expect(state.phase).toBe('preparing')

  step(event('charging-recommended'))
  expect(state.charging).toMatchObject({ recommended: true, status: 'planned' })

  step(event('route-airport'))
  expect(state.phase).toBe('driving-to-airport')
  const planned = registry['navigation.plan-route'](ctx, {
    origin: { latitude: 31.23, longitude: 121.47 },
    destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
  })
  expect(planned.ok).toBe(true)
  expect(planned.data?.routeId).toBe(state.navigation!.routeId)
  const started = registry['navigation.start'](ctx, { routeId: state.navigation!.routeId, idempotencyKey: `${state.taskId}:nav-start` })
  expect(started.ok).toBe(true)

  step({ eventId: 'timeline-charging-started', type: 'charging.started', stationId: 'station-hongqiao-01', timestamp: '2026-07-22T20:06:00+08:00' })
  expect(state.charging).toMatchObject({ accepted: true, status: 'active' })

  step(event('flight-in-air'))
  expect(state.flight?.status).toBe('in-air')

  step(event('charging-completed'))
  expect(state.charging).toMatchObject({ accepted: true, status: 'completed' })

  step(event('flight-landed'))
  expect(state.message).toMatchObject({ status: 'scheduled', idempotencyKey: 'pickup-001:MU5102:landing' })
  const prepared = registry['message.prepare'](ctx, { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:40' })
  expect(prepared.ok).toBe(true)
  expect(prepared.data!.confirmationId.startsWith('cnf_')).toBe(true)
  const sendInput = {
    contactId: 'contact-mom',
    messageId: prepared.data!.messageId,
    text: prepared.data!.text,
    authorizationId: issueAutoNotifyAuthorization(runtime, {
      taskId: state.taskId,
      contactId: 'contact-mom',
      messageId: prepared.data!.messageId,
      text: prepared.data!.text,
    }),
    idempotencyKey: state.message.idempotencyKey!,
  }
  const firstSend = registry['message.send'](ctx, sendInput)
  const secondSend = registry['message.send'](ctx, sendInput)
  expect(firstSend.ok).toBe(true)
  // 同一 idempotencyKey 重复发送必须返回同一结果，不重复发消息
  expect(secondSend).toEqual(firstSend)

  step({ eventId: 'timeline-message-sent', type: 'message.sent', messageId: state.message.pendingMessageId!, timestamp: '2026-07-22T20:41:00+08:00' })
  expect(state.message).toMatchObject({ status: 'sent', landingNoticeSent: true })

  step({ eventId: 'timeline-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T20:45:00+08:00' })
  expect(state.phase).toBe('approaching-airport')

  step({ eventId: 'timeline-parked', type: 'vehicle.parked', timestamp: '2026-07-22T20:50:00+08:00' })
  expect(state.phase).toBe('waiting-for-passengers')

  step(event('passengers-onboard'))
  expect(state.phase).toBe('returning-home')
  const rerouted = registry['navigation.update-route'](ctx, {
    routeId: 'route-airport-001',
    destination: { id: 'destination-home', name: '家' },
    idempotencyKey: `${state.taskId}:nav-update-home`,
  })
  expect(rerouted.ok).toBe(true)

  step(event('cabin-profile-applied'))
  const preferences = getPreferences(ctx, { memberIds: state.passengers.memberIds, scopes: ['cabin', 'media'] })
  expect(preferences.ok).toBe(true)
  const cabinInput = {
    zone: 'rear' as const,
    temperatureC: preferences.data!.members.find((member) => member.rearTemperatureC !== undefined)!.rearTemperatureC,
    mediaTitle: preferences.data!.members.find((member) => member.mediaTitle !== undefined)!.mediaTitle,
    sourceMemberIds: state.passengers.memberIds,
    idempotencyKey: 'cabin-rear-v1',
  }
  const firstApply = registry['vehicle.apply-cabin-profile'](ctx, cabinInput)
  const secondApply = registry['vehicle.apply-cabin-profile'](ctx, cabinInput)
  expect(firstApply.ok).toBe(true)
  expect(secondApply).toEqual(firstApply)

  step(event('trip-completed'))
  expect(state.phase).toBe('completed')
  expect(state.pendingConfirmation).toEqual({ confirmationId: 'pickup-001:save-memory', action: 'save-memory' })

  return {
    finalState: state,
    trace,
    sendResults: [firstSend, secondSend],
    cabinResults: [firstApply, secondApply],
  }
}

describe('timeline replay', () => {
  it('replays the main flow deterministically for 20 consecutive runs', () => {
    const runs = Array.from({ length: 20 }, () => replayMainTimeline())
    const [first, ...rest] = runs
    expect(first.finalState.phase).toBe('completed')
    expect(first.finalState.message).toMatchObject({ status: 'sent', landingNoticeSent: true })
    expect(first.trace.map((entry) => entry.phase)).toEqual([
      'collecting-information',
      'preparing',
      'preparing',
      'driving-to-airport',
      'driving-to-airport',
      'driving-to-airport',
      'driving-to-airport',
      'driving-to-airport',
      'driving-to-airport',
      'approaching-airport',
      'waiting-for-passengers',
      'returning-home',
      'returning-home',
      'completed',
    ])
    for (const run of rest) {
      expect(run).toEqual(first)
    }
  })
})
