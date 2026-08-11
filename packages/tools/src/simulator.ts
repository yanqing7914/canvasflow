import {
  type NavigationSimulationLeg,
  type NavigationSimulationProfiles,
  type NavigationSimulationSeed,
  type NavigationSimulationSpeedMode,
} from '@canvasflow/schema'

export const NAVIGATION_SIMULATION_PROFILES: NavigationSimulationProfiles = {
  slow: { durationSeconds: 150, displaySpeedKph: 35 },
  normal: { durationSeconds: 90, displaySpeedKph: 55 },
  fast: { durationSeconds: 45, displaySpeedKph: 75 },
}

export type NavigationSimulationState = NavigationSimulationSeed & {
  speedMode: NavigationSimulationSpeedMode
  progress: number
  anchoredAtMs: number
  anchoredProgress: number
  arrived: boolean
}

export type NavigationSimulationSnapshot = NavigationSimulationState & {
  speedKph: number
  elapsedSeconds: number
  remainingSeconds: number
  remainingDistanceKm: number
  traveledDistanceKm: number
  batteryPercent: number
  etaMs: number
}

export type NavigationSimulationSpeedChange = {
  state: NavigationSimulationState
  changed: boolean
  message: string
}

export function createNavigationSimulation(input: {
  leg: NavigationSimulationLeg
  routeId: string
  distanceKm: number
  initialBatteryPercent: number
  estimatedBatteryAtArrival: number
  nowMs: number
  speedMode?: NavigationSimulationSpeedMode
  profiles?: NavigationSimulationProfiles
}): NavigationSimulationState {
  assertFiniteTimestamp(input.nowMs)
  validateSeed(input)
  const seed: NavigationSimulationSeed = {
    leg: input.leg,
    routeId: input.routeId,
    distanceKm: input.distanceKm,
    initialBatteryPercent: input.initialBatteryPercent,
    estimatedBatteryAtArrival: input.estimatedBatteryAtArrival,
    profiles: input.profiles ?? NAVIGATION_SIMULATION_PROFILES,
  }
  return {
    ...seed,
    speedMode: input.speedMode ?? 'normal',
    progress: 0,
    anchoredAtMs: input.nowMs,
    anchoredProgress: 0,
    arrived: false,
  }
}

export function advanceNavigationSimulation(
  state: NavigationSimulationState,
  nowMs: number,
): NavigationSimulationSnapshot {
  assertFiniteTimestamp(nowMs)
  const profile = state.profiles[state.speedMode]
  const elapsedSeconds = Math.max(0, (nowMs - state.anchoredAtMs) / 1_000)
  const remainingProgressAtAnchor = 1 - clampProgress(state.anchoredProgress)
  const progress = state.arrived
    ? 1
    : clampProgress(state.anchoredProgress + elapsedSeconds / profile.durationSeconds)
  const arrived = progress >= 1
  const traveledDistanceKm = state.distanceKm * progress
  const remainingDistanceKm = Math.max(0, state.distanceKm - traveledDistanceKm)
  const batteryDrop = state.initialBatteryPercent - state.estimatedBatteryAtArrival
  const batteryPercent = clampPercent(state.initialBatteryPercent - batteryDrop * progress)
  const remainingSeconds = arrived
    ? 0
    : Math.max(0, profile.durationSeconds * (1 - progress))

  return {
    ...state,
    progress,
    arrived,
    speedKph: arrived ? 0 : profile.displaySpeedKph,
    elapsedSeconds: Math.min(elapsedSeconds, profile.durationSeconds * remainingProgressAtAnchor),
    remainingSeconds,
    remainingDistanceKm,
    traveledDistanceKm,
    batteryPercent,
    etaMs: nowMs + remainingSeconds * 1_000,
  }
}

/**
 * Re-anchors at the current position before changing speed, so mode changes
 * affect only future motion and never reset or jump the vehicle.
 */
export function setNavigationSimulationSpeed(
  state: NavigationSimulationState,
  speedMode: NavigationSimulationSpeedMode,
  nowMs: number,
): NavigationSimulationSpeedChange {
  const snapshot = advanceNavigationSimulation(state, nowMs)
  if (snapshot.arrived) {
    return { state: snapshotState(snapshot), changed: false, message: '车辆已到达目的地' }
  }
  if (state.speedMode === speedMode) {
    return { state: snapshotState(snapshot), changed: false, message: `已经是${speedModeLabel(speedMode)}档位` }
  }
  return {
    state: {
      ...snapshotState(snapshot),
      speedMode,
      anchoredAtMs: nowMs,
      anchoredProgress: snapshot.progress,
    },
    changed: true,
    message: `已切换到${speedModeLabel(speedMode)}模式`,
  }
}

export function changeNavigationSimulationSpeed(
  state: NavigationSimulationState,
  direction: 'up' | 'down',
  nowMs: number,
): NavigationSimulationSpeedChange {
  const modes: NavigationSimulationSpeedMode[] = ['slow', 'normal', 'fast']
  const currentIndex = modes.indexOf(state.speedMode)
  const nextIndex = Math.min(modes.length - 1, Math.max(0, currentIndex + (direction === 'up' ? 1 : -1)))
  if (nextIndex === currentIndex) {
    const snapshot = advanceNavigationSimulation(state, nowMs)
    return {
      state: snapshotState(snapshot),
      changed: false,
      message: direction === 'up' ? '已经是最快档位' : '已经是最慢档位',
    }
  }
  return setNavigationSimulationSpeed(state, modes[nextIndex]!, nowMs)
}

function snapshotState(snapshot: NavigationSimulationSnapshot): NavigationSimulationState {
  return {
    leg: snapshot.leg,
    routeId: snapshot.routeId,
    distanceKm: snapshot.distanceKm,
    initialBatteryPercent: snapshot.initialBatteryPercent,
    estimatedBatteryAtArrival: snapshot.estimatedBatteryAtArrival,
    profiles: snapshot.profiles,
    speedMode: snapshot.speedMode,
    progress: snapshot.progress,
    anchoredAtMs: snapshot.anchoredAtMs,
    anchoredProgress: snapshot.anchoredProgress,
    arrived: snapshot.arrived,
  }
}

function clampProgress(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function assertFiniteTimestamp(value: number): void {
  if (!Number.isFinite(value)) throw new TypeError('nowMs must be finite')
}

function validateSeed(input: {
  routeId: string
  distanceKm: number
  initialBatteryPercent: number
  estimatedBatteryAtArrival: number
}): void {
  if (!input.routeId.trim()) throw new TypeError('routeId is required')
  if (!Number.isFinite(input.distanceKm) || input.distanceKm <= 0) throw new RangeError('distanceKm must be positive')
  for (const [name, value] of [
    ['initialBatteryPercent', input.initialBatteryPercent],
    ['estimatedBatteryAtArrival', input.estimatedBatteryAtArrival],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError(`${name} must be between 0 and 100`)
  }
}

function speedModeLabel(mode: NavigationSimulationSpeedMode): string {
  if (mode === 'slow') return '慢速'
  if (mode === 'fast') return '快速'
  return '正常'
}
