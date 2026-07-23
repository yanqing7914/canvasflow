import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  airportPickupTaskStateSchema,
  demoTimelineSchema,
  vehicleStatusOutputSchema,
  type AirportPickupTaskState,
  type DemoTimeline,
} from '@canvasflow/schema'
import { applyEvent } from '@canvasflow/agent'
import { recommendCharging } from './charging'
import {
  chargingStation,
  chargingStations,
  flights,
  knownRouteIds,
  recommendedMeetingPoints,
  vehicleSnapshots,
} from './data'
import { getVehicleStatus } from './vehicle'
import { toolDefinitions } from './registry'
import type { ToolContext } from './result'

const ctx: ToolContext = { taskId: 'pickup-001' }

const timeline: DemoTimeline = demoTimelineSchema.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), 'fixtures/airport-pickup/timelines/main-flow.json'), 'utf8')),
)

function replayTimeline(): AirportPickupTaskState {
  let state = timeline.initialTaskState
  for (const step of timeline.steps) {
    const next = applyEvent(state, step.event)
    if (step.advisory) {
      // 传感器事件只形成建议：不得改变任务事实，也不得占用事件去重账本
      expect(next, step.event.eventId).toEqual(state)
      expect(next.processedEventIds, step.event.eventId).not.toContain(step.event.eventId)
    } else {
      expect(next.processedEventIds, step.event.eventId).toContain(step.event.eventId)
      // 重复投递同一事件必须是幂等 no-op
      expect(applyEvent(next, step.event), step.event.eventId).toEqual(next)
    }
    state = step.statePatch
      ? airportPickupTaskStateSchema.parse({ ...next, ...step.statePatch })
      : next
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
      const navigation = (step.statePatch as { navigation?: { routeId?: string } } | undefined)?.navigation
      if (navigation?.routeId) {
        expect(knownRouteIds.has(navigation.routeId), `${step.event.eventId}:${navigation.routeId}`).toBe(true)
      }
    }
  })

  it('event timestamps are monotonically non-decreasing', () => {
    const times = timeline.steps.map((step) => Date.parse(step.event.timestamp))
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index], timeline.steps[index].event.eventId).toBeGreaterThanOrEqual(times[index - 1])
    }
  })

  it('replays from task creation to completion deterministically', () => {
    const first = replayTimeline()
    expect(first.phase).toBe('completed')
    expect(first.message).toMatchObject({ status: 'sent', landingNoticeSent: true })
    expect(first.charging.status).toBe('completed')
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
