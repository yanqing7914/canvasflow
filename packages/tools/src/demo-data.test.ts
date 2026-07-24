import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  airportPickupTaskStateSchema,
  demoTimelineSchema,
  vehicleStatusOutputSchema,
  type AirportPickupTaskState,
  type DemoTimeline,
  type DemoTimelineStep,
} from '@canvasflow/schema'
import { applyEvent } from '@canvasflow/agent'
import { recommendCharging } from './charging'
import {
  chargingDensityForSpeed,
  chargingStation,
  chargingStations,
  chargingStationsForDensity,
  DEMO_ORIGIN,
  flights,
  knownRouteIds,
  recommendedMeetingPoints,
  vehicleSnapshots,
} from './data'
import { resolveMembers } from './family'
import { getFlightStatus } from './flight'
import { createSideEffectRuntime, type SideEffectRuntime } from './idempotency'
import { getPreferences } from './memory'
import { createMessagePreparer, issueAutoNotifyAuthorization } from './message'
import { planRoute } from './navigation'
import { createProviderRegistry, toolDefinitions, type ToolName } from './registry'
import type { ToolContext } from './result'
import { getVehicleStatus } from './vehicle'

const ctx: ToolContext = { taskId: 'pickup-001' }

const timeline: DemoTimeline = demoTimelineSchema.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), 'fixtures/airport-pickup/timelines/main-flow.json'), 'utf8')),
)

type ToolPatch = Partial<Pick<AirportPickupTaskState, 'passengers' | 'navigation' | 'charging'>>

/**
 * Execute the tools declared on a timeline step against real fixture providers.
 * Returns the planner-facing state fields that those tools produce. A broken
 * provider input/output contract must fail here instead of being papered over
 * by an unconstrained statePatch.
 */
function executeStepTools(
  step: DemoTimelineStep,
  state: AirportPickupTaskState,
  registry: ReturnType<typeof createProviderRegistry>,
  runtime: SideEffectRuntime,
): ToolPatch {
  const patch: ToolPatch = {}
  const prepareMessage = createMessagePreparer(runtime)
  for (const tool of step.toolCalls ?? []) {
    expect(Object.keys(toolDefinitions), `${step.event.eventId}:${tool}`).toContain(tool)
    switch (tool as ToolName) {
      case 'family.resolve-members': {
        const result = resolveMembers(ctx, { labels: ['妈妈', '豆豆'] })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        patch.passengers = {
          memberIds: result.data!.members.map((member) => member.memberId),
          names: result.data!.members.map((member) => member.displayName),
          confirmedOnboard: false,
        }
        break
      }
      case 'flight.get-status': {
        const flightNumber = state.flight?.flightNumber ?? 'MU5102'
        const result = getFlightStatus(ctx, { flightNumber, date: '2026-07-22' })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        expect(result.data).toMatchObject({ flightNumber })
        break
      }
      case 'vehicle.get-status': {
        const snapshot =
          step.event.type === 'charging.completed'
            ? 'post-charge'
            : step.event.type === 'vehicle.parked'
              ? 'airport-parked'
              : 'parked'
        const result = getVehicleStatus(ctx, { snapshot })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        break
      }
      case 'charging.recommend': {
        const lowBattery = vehicleSnapshots['low-battery-parked']
        const result = recommendCharging(ctx, {
          batteryPercent: 42,
          remainingRangeKm: lowBattery.remainingRangeKm,
          outboundDistanceKm: 32,
          returnDistanceKm: 32,
          safetyReservePercent: 20,
        })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        expect(result.data).toMatchObject({ recommended: true, stationId: chargingStations[0].stationId })
        // Provider output must drive planner state — not only the “补能” text parse path.
        patch.charging = {
          recommended: result.data!.recommended,
          accepted: false,
          status: result.data!.recommended ? 'planned' : 'none',
        }
        break
      }
      case 'navigation.plan-route': {
        // Use the registry planner so the route is recorded for later start/update.
        const result = registry['navigation.plan-route'](ctx, {
          origin: { latitude: DEMO_ORIGIN.latitude, longitude: DEMO_ORIGIN.longitude },
          destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
        })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        expect(result.data?.routeId).toBe('route-airport-001')
        break
      }
      case 'navigation.start': {
        const routeId = state.navigation?.routeId ?? 'route-airport-001'
        const result = registry['navigation.start'](ctx, {
          routeId,
          idempotencyKey: `${state.taskId}:nav-start:${routeId}`,
        })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        expect(result.data).toMatchObject({ routeId, status: 'active' })
        break
      }
      case 'navigation.update-route': {
        if (step.event.type === 'charging.started') {
          const planned = registry['navigation.plan-route'](ctx, {
            origin: { latitude: DEMO_ORIGIN.latitude, longitude: DEMO_ORIGIN.longitude },
            destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
            via: [{ id: 'station-hongqiao-01', name: '虹桥超充站' }],
          })
          expect(planned.ok, `${step.event.eventId}:plan-via`).toBe(true)
          const updated = registry['navigation.update-route'](ctx, {
            routeId: state.navigation!.routeId,
            destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
            via: [{ id: 'station-hongqiao-01', name: '虹桥超充站' }],
            idempotencyKey: `${state.taskId}:nav-via-charge`,
          })
          expect(updated.ok, `${step.event.eventId}:${tool}`).toBe(true)
          patch.navigation = {
            routeId: updated.data!.routeId,
            destination: updated.data!.destination,
            eta: planned.data!.arrivalTime,
            status: 'active',
          }
        } else if (step.event.type === 'user.confirmed-passengers-onboard') {
          const planned = planRoute(ctx, {
            origin: { latitude: DEMO_ORIGIN.latitude, longitude: DEMO_ORIGIN.longitude },
            destination: { id: 'destination-home', name: '家' },
          })
          expect(planned.ok, `${step.event.eventId}:plan-home`).toBe(true)
          const updated = registry['navigation.update-route'](ctx, {
            routeId: state.navigation?.routeId ?? 'route-airport-001',
            destination: { id: 'destination-home', name: '家' },
            idempotencyKey: `${state.taskId}:nav-update-home`,
          })
          expect(updated.ok, `${step.event.eventId}:${tool}`).toBe(true)
          patch.navigation = {
            routeId: updated.data!.routeId,
            destination: updated.data!.destination,
            eta: planned.data!.arrivalTime,
            status: 'active',
          }
        } else {
          throw new Error(`${step.event.eventId}: unexpected navigation.update-route context`)
        }
        break
      }
      case 'message.prepare': {
        const result = prepareMessage(ctx, {
          contactId: 'contact-mom',
          flightNumber: state.flight!.flightNumber,
          eta: '20:40',
        })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        expect(result.data!.messageId).toBe(state.message.idempotencyKey)
        expect(result.data!.messageId).toBe(`${state.taskId}:${state.message.pendingMessageId}`)
        break
      }
      case 'message.send': {
        const prepared = prepareMessage(ctx, {
          contactId: 'contact-mom',
          flightNumber: state.flight!.flightNumber,
          eta: '20:40',
        })
        expect(prepared.ok, `${step.event.eventId}:prepare-before-send`).toBe(true)
        const sendInput = {
          contactId: prepared.data!.contactId,
          messageId: prepared.data!.messageId,
          text: prepared.data!.text,
          authorizationId: issueAutoNotifyAuthorization(runtime, {
            taskId: state.taskId,
            contactId: prepared.data!.contactId,
            messageId: prepared.data!.messageId,
            text: prepared.data!.text,
          }),
          idempotencyKey: state.message.idempotencyKey!,
        }
        const first = registry['message.send'](ctx, sendInput)
        const second = registry['message.send'](ctx, sendInput)
        expect(first.ok, `${step.event.eventId}:${tool}`).toBe(true)
        expect(second).toBe(first)
        expect(first.data).toMatchObject({ status: 'sent', messageId: prepared.data!.messageId })
        break
      }
      case 'memory.get-preferences': {
        const result = getPreferences(ctx, {
          memberIds: state.passengers.memberIds,
          scopes: ['cabin', 'media'],
        })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        expect(result.data!.members.length).toBeGreaterThan(0)
        break
      }
      case 'vehicle.apply-cabin-profile': {
        const preferences = getPreferences(ctx, {
          memberIds: state.passengers.memberIds,
          scopes: ['cabin', 'media'],
        })
        expect(preferences.ok).toBe(true)
        const temperatureC = preferences.data!.members.find((member) => member.rearTemperatureC !== undefined)?.rearTemperatureC
        const mediaTitle = preferences.data!.members.find((member) => member.mediaTitle !== undefined)?.mediaTitle
        const input = {
          zone: 'rear' as const,
          ...(temperatureC !== undefined ? { temperatureC } : {}),
          ...(mediaTitle !== undefined ? { mediaTitle } : {}),
          sourceMemberIds: state.passengers.memberIds,
          idempotencyKey: `${state.taskId}:cabin-rear-v1`,
        }
        const result = registry['vehicle.apply-cabin-profile'](ctx, input)
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        break
      }
      case 'media.play': {
        const preferences = getPreferences(ctx, {
          memberIds: state.passengers.memberIds,
          scopes: ['media'],
        })
        const mediaTitle = preferences.data!.members.find((member) => member.mediaTitle !== undefined)?.mediaTitle
        expect(mediaTitle, `${step.event.eventId}:mediaTitle`).toBeDefined()
        const result = registry['media.play'](ctx, {
          mediaTitle,
          sourceMemberId: 'doubao',
          idempotencyKey: `${state.taskId}:media-play`,
        })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        break
      }
      case 'memory.propose-update': {
        const result = registry['memory.propose-update'](ctx, {
          memberId: 'mom',
          changes: { rearTemperatureC: 25 },
        })
        expect(result.ok, `${step.event.eventId}:${tool}`).toBe(true)
        expect(result.data?.proposalId).toBeTruthy()
        break
      }
      default:
        throw new Error(`${step.event.eventId}: unhandled tool in demo replay: ${tool}`)
    }
  }
  return patch
}

function replayTimeline(): AirportPickupTaskState {
  const runtime = createSideEffectRuntime()
  const registry = createProviderRegistry(runtime)
  let state = timeline.initialTaskState
  for (const step of timeline.steps) {
    const next = applyEvent(state, step.event)
    if (step.advisory) {
      // 传感器事件只形成建议：不得改变任务事实，也不得占用事件去重账本
      expect(next, step.event.eventId).toEqual(state)
      expect(next.processedEventIds, step.event.eventId).not.toContain(step.event.eventId)
      state = next
    } else {
      expect(next.processedEventIds, step.event.eventId).toContain(step.event.eventId)
      // 重复投递同一事件必须是幂等 no-op
      expect(applyEvent(next, step.event), step.event.eventId).toEqual(next)

      const toolPatch = executeStepTools(step, next, registry, runtime)
      if (step.statePatch) {
        // Fixture patch must match what real tools produced for overlapping keys.
        for (const key of Object.keys(step.statePatch) as Array<keyof typeof step.statePatch>) {
          if (key in toolPatch) {
            expect(step.statePatch[key], `${step.event.eventId}:statePatch.${String(key)}`).toEqual(
              toolPatch[key as keyof ToolPatch],
            )
          }
        }
      }

      state = airportPickupTaskStateSchema.parse({ ...next, ...toolPatch, ...step.statePatch })

      if (state.charging.status === 'active' || state.charging.status === 'completed') {
        expect(state.charging.accepted, step.event.eventId).toBe(true)
      }
    }

    expect(state.phase, step.event.eventId).toBe(step.expectedPhase)
    expect(state.taskRevision, step.event.eventId).toBe(step.expectedTaskRevision)
  }
  return state
}

describe('demo main-flow timeline fixture', () => {
  it('only references registered tools and known routes', () => {
    for (const step of timeline.steps) {
      for (const tool of step.toolCalls ?? []) {
        expect(Object.keys(toolDefinitions), `${step.event.eventId}:${tool}`).toContain(tool)
      }
      if (step.statePatch?.navigation?.routeId) {
        expect(knownRouteIds.has(step.statePatch.navigation.routeId), `${step.event.eventId}:${step.statePatch.navigation.routeId}`).toBe(true)
      }
    }
  })

  it('event timestamps are monotonically non-decreasing', () => {
    const times = timeline.steps.map((step) => Date.parse(step.event.timestamp))
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index], timeline.steps[index].event.eventId).toBeGreaterThanOrEqual(times[index - 1])
    }
  })

  it('replays from task creation to completion against real fixture tools', () => {
    const first = replayTimeline()
    expect(first.phase).toBe('completed')
    expect(first.message).toMatchObject({ status: 'sent', landingNoticeSent: true })
    expect(first.charging).toMatchObject({ accepted: true, status: 'completed' })
    expect(first.navigation).toMatchObject({ routeId: 'route-home-001', destination: '家', status: 'arrived' })
    expect(first.pendingConfirmation).toEqual({ confirmationId: 'pickup-001:save-memory', action: 'save-memory' })
    expect(replayTimeline()).toEqual(first)
  })
})

describe('charging comparison dataset', () => {
  it('provides three fictional stations sorted by distance', () => {
    expect(chargingStations).toHaveLength(3)
    for (let index = 1; index < chargingStations.length; index += 1) {
      expect(chargingStations[index].distanceKm).toBeGreaterThan(chargingStations[index - 1].distanceKm)
    }
    for (const station of chargingStations) {
      expect(station.availableStalls).toBeLessThanOrEqual(station.totalStalls)
      expect(station.availableStalls).toBeGreaterThan(0)
      expect(new Set(chargingStations.map((entry) => entry.stationId)).size).toBe(chargingStations.length)
    }
  })

  it('keeps charging.recommend pointing at the nearest station', () => {
    expect(chargingStation.stationId).toBe(chargingStations[0].stationId)
    expect(chargingStation.etaImpactMinutes).toBe(chargingStations[0].detourMinutes)
    const lowBattery = vehicleSnapshots['low-battery-parked']
    const result = recommendCharging(ctx, {
      batteryPercent: lowBattery.batteryPercent,
      remainingRangeKm: lowBattery.remainingRangeKm,
      outboundDistanceKm: 32,
      returnDistanceKm: 32,
      safetyReservePercent: 20,
    })
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ recommended: true, stationId: chargingStations[0].stationId })
  })

  it('projects 3/2/1 stations for full/compact/minimal density', () => {
    expect(chargingStationsForDensity('full').map((station) => station.stationId)).toEqual([
      'station-hongqiao-01',
      'station-hongqiao-02',
      'station-hongqiao-03',
    ])
    expect(chargingStationsForDensity('compact')).toHaveLength(2)
    expect(chargingStationsForDensity('minimal')).toEqual([chargingStations[0]])
  })
})

describe('vehicle density-control snapshots', () => {
  it('every snapshot satisfies the vehicle status contract and is servable', () => {
    for (const [name, snapshot] of Object.entries(vehicleSnapshots)) {
      expect(vehicleStatusOutputSchema.safeParse(snapshot).success, name).toBe(true)
      const served = getVehicleStatus(ctx, { snapshot: name })
      expect(served.ok, name).toBe(true)
      expect(served.data, name).toEqual(snapshot)
    }
  })

  it('covers the three density tiers of the low-battery charging branch', () => {
    const parked = vehicleSnapshots['low-battery-parked']
    const city = vehicleSnapshots['low-battery-city']
    const highway = vehicleSnapshots['low-battery-highway']
    for (const snapshot of [parked, city, highway]) {
      expect(snapshot.batteryPercent).toBeLessThan(20)
      expect(snapshot.isNight).toBe(true)
    }
    expect(parked.speedKph).toBe(0)
    expect(city.speedKph).toBeGreaterThan(0)
    expect(city.speedKph).toBeLessThanOrEqual(60)
    expect(highway.speedKph).toBeGreaterThan(60)
    expect(chargingDensityForSpeed(parked.speedKph)).toBe('full')
    expect(chargingDensityForSpeed(city.speedKph)).toBe('compact')
    expect(chargingDensityForSpeed(highway.speedKph)).toBe('minimal')
    expect(chargingStationsForDensity(chargingDensityForSpeed(parked.speedKph))).toHaveLength(3)
    expect(chargingStationsForDensity(chargingDensityForSpeed(city.speedKph))).toHaveLength(2)
    expect(chargingStationsForDensity(chargingDensityForSpeed(highway.speedKph))).toHaveLength(1)
  })
})

describe('recommended meeting points', () => {
  it('covers the demo flight terminal and the delayed-terminal alternate', () => {
    const primary = recommendedMeetingPoints[flights.MU5102.terminal]
    expect(primary).toBeDefined()
    expect(primary.terminal).toBe(flights.MU5102.terminal)
    expect(primary.walkMinutes).toBeGreaterThan(0)

    const delayedTerminal = recommendedMeetingPoints[flights.MU5103.terminal]
    expect(delayedTerminal).toBeDefined()
    expect(delayedTerminal.terminal).toBe('T1')
  })
})
