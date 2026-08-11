import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIMULATOR_CONFIG,
  SPEED_TIERS,
  createNavigationSimulatorState,
  navigationSimulatorReducer,
  nextSpeedTier,
  pendingManeuverReminder,
  simulatorSnapshot,
} from './simulator'

describe('navigation simulator', () => {
  it.each([
    ['slow', 150],
    ['normal', 90],
    ['fast', 45],
  ] as const)('finishes the %s tier in %s seconds', (speedTier, durationSeconds) => {
    let state = navigationSimulatorReducer(createNavigationSimulatorState(0), {
      type: 'start-leg', leg: 'outbound', nowMs: 0,
    })
    if (speedTier !== 'normal') state = navigationSimulatorReducer(state, { type: 'set-speed', speedTier, nowMs: 0 })
    expect(simulatorSnapshot(state, durationSeconds * 500).progress).toBeCloseTo(0.5)
    state = navigationSimulatorReducer(state, { type: 'tick', nowMs: durationSeconds * 1000 })
    expect(state.simulation?.progress).toBe(1)
    expect(state.simulation?.arrived).toBe(true)
    expect(simulatorSnapshot(state, durationSeconds * 2000).progress).toBe(1)
  })

  it('re-anchors a speed change without resetting or teleporting', () => {
    let state = navigationSimulatorReducer(createNavigationSimulatorState(0), {
      type: 'start-leg', leg: 'outbound', nowMs: 0,
    })
    const before = simulatorSnapshot(state, 30_000).progress
    state = navigationSimulatorReducer(state, { type: 'set-speed', speedTier: 'fast', nowMs: 30_000 })
    expect(state.simulation?.progress).toBeCloseTo(before)
    expect(simulatorSnapshot(state, 30_000).progress).toBeCloseTo(before)
    expect(simulatorSnapshot(state, 45_000).progress).toBeGreaterThan(before)
  })

  it('keeps credible display speeds and clamps tier boundaries', () => {
    expect(SPEED_TIERS.slow.speedKph).toBe(35)
    expect(SPEED_TIERS.normal.speedKph).toBe(55)
    expect(SPEED_TIERS.fast.speedKph).toBe(75)
    expect(nextSpeedTier('fast', 'faster')).toBe('fast')
    expect(nextSpeedTier('slow', 'slower')).toBe('slow')
  })

  it('updates distance, battery, range and ETA deterministically', () => {
    const state = navigationSimulatorReducer(createNavigationSimulatorState(0), {
      type: 'start-leg', leg: 'outbound', nowMs: 0, batteryPercent: 80,
    })
    const snapshot = simulatorSnapshot(state, 45_000)
    expect(snapshot.progress).toBeCloseTo(0.5)
    expect(snapshot.remainingDistanceKm).toBeCloseTo(DEFAULT_SIMULATOR_CONFIG.distanceKm.outbound / 2)
    expect(snapshot.batteryPercent).toBeCloseTo(80 - 16 * DEFAULT_SIMULATOR_CONFIG.consumptionPercentPerKm)
    expect(snapshot.remainingRangeKm).toBeCloseTo(snapshot.batteryPercent / 100 * DEFAULT_SIMULATOR_CONFIG.fullRangeKm)
    expect(snapshot.remainingSeconds).toBeCloseTo(45)
    expect(snapshot.etaMs).toBe(90_000)
  })

  it('starts each leg at zero and carries battery into the return leg', () => {
    let state = navigationSimulatorReducer(createNavigationSimulatorState(0), {
      type: 'start-leg', leg: 'outbound', nowMs: 0, batteryPercent: 72,
    })
    state = navigationSimulatorReducer(state, { type: 'tick', nowMs: 90_000 })
    const arrived = simulatorSnapshot(state, 90_000)
    state = navigationSimulatorReducer(state, {
      type: 'start-leg', leg: 'return', nowMs: 91_000, batteryPercent: arrived.batteryPercent,
    })
    const returning = simulatorSnapshot(state, 91_000)
    expect(returning.leg).toBe('return')
    expect(returning.progress).toBe(0)
    expect(returning.batteryPercent).toBeCloseTo(arrived.batteryPercent)
  })

  it('offers each 300 metre reminder once', () => {
    let state = navigationSimulatorReducer(createNavigationSimulatorState(0), {
      type: 'start-leg', leg: 'outbound', nowMs: 0,
    })
    state = navigationSimulatorReducer(state, { type: 'tick', nowMs: 15_700 })
    const snapshot = simulatorSnapshot(state, 15_700)
    const reminder = pendingManeuverReminder(state, snapshot)
    expect(reminder?.text).toMatch(/300 米/u)
    state = navigationSimulatorReducer(state, { type: 'mark-reminded', maneuverId: reminder!.id })
    expect(pendingManeuverReminder(state, snapshot)).toBeUndefined()
  })
})
