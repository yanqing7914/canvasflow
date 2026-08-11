import { describe, expect, it } from 'vitest'
import {
  NAVIGATION_SIMULATION_PROFILES,
  advanceNavigationSimulation,
  changeNavigationSimulationSpeed,
  createNavigationSimulation,
} from './simulator'

function simulation(leg: 'outbound' | 'return' = 'outbound') {
  return createNavigationSimulation({
    leg,
    routeId: `route-${leg}`,
    distanceKm: 30,
    initialBatteryPercent: leg === 'outbound' ? 80 : 65,
    estimatedBatteryAtArrival: leg === 'outbound' ? 65 : 50,
    nowMs: 1_000,
  })
}

describe('navigation simulator', () => {
  it('uses the required credible three-speed profiles', () => {
    expect(NAVIGATION_SIMULATION_PROFILES).toEqual({
      slow: { durationSeconds: 150, displaySpeedKph: 35 },
      normal: { durationSeconds: 90, displaySpeedKph: 55 },
      fast: { durationSeconds: 45, displaySpeedKph: 75 },
    })
  })

  it('advances deterministically and clamps at arrival', () => {
    const state = simulation()
    expect(advanceNavigationSimulation(state, 46_000)).toMatchObject({
      progress: 0.5,
      speedKph: 55,
      remainingDistanceKm: 15,
      batteryPercent: 72.5,
      remainingSeconds: 45,
      arrived: false,
    })
    expect(advanceNavigationSimulation(state, 1_000_000)).toMatchObject({
      progress: 1,
      speedKph: 0,
      remainingDistanceKm: 0,
      batteryPercent: 65,
      remainingSeconds: 0,
      arrived: true,
    })
  })

  it('re-anchors speed changes without resetting progress', () => {
    const state = simulation()
    const halfway = advanceNavigationSimulation(state, 46_000)
    const faster = changeNavigationSimulationSpeed(state, 'up', 46_000)

    expect(faster.changed).toBe(true)
    expect(faster.state.speedMode).toBe('fast')
    expect(faster.state.progress).toBe(halfway.progress)
    expect(advanceNavigationSimulation(faster.state, 46_000).progress).toBe(halfway.progress)
    expect(advanceNavigationSimulation(faster.state, 56_000).progress).toBeGreaterThan(halfway.progress)
  })

  it('reports boundaries and initializes outbound and return independently', () => {
    const slow = { ...simulation(), speedMode: 'slow' as const }
    expect(changeNavigationSimulationSpeed(slow, 'down', 2_000)).toMatchObject({
      changed: false,
      message: '已经是最慢档位',
    })
    const outbound = simulation('outbound')
    const returning = simulation('return')
    expect(returning).toMatchObject({ leg: 'return', progress: 0, initialBatteryPercent: 65 })
    expect(returning.routeId).not.toBe(outbound.routeId)
  })
})
