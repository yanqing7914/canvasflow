export type NavigationLeg = 'outbound' | 'return'
export type SpeedTier = 'slow' | 'normal' | 'fast'
export type NavigationRunState = 'idle' | 'driving' | 'arrived'
export type NavigationSpeedProfile = { durationSeconds: number; speedKph: number; label: string }

export type NavigationClock = {
  now: () => number
  schedule: (callback: () => void) => () => void
}

export type NavigationSimulatorConfig = {
  distanceKm: Record<NavigationLeg, number>
  initialBatteryPercent: number
  fullRangeKm: number
  consumptionPercentPerKm: number
  profiles: Record<SpeedTier, NavigationSpeedProfile>
}

export type NavigationSimulatorState = {
  leg?: NavigationLeg
  runState: NavigationRunState
  speedTier: SpeedTier
  progress: number
  anchorProgress: number
  anchorTimeMs: number
  batteryAtLegStart: number
  completedDistanceKm: number
  remindedManeuvers: string[]
}

export type NavigationSnapshot = {
  leg?: NavigationLeg
  runState: NavigationRunState
  speedTier: SpeedTier
  speedKph: number
  progress: number
  distanceKm: number
  travelledKm: number
  remainingDistanceKm: number
  batteryPercent: number
  remainingRangeKm: number
  remainingSeconds: number
  etaMs?: number
  road: string
  maneuver: string
  maneuverId?: string
  maneuverDistanceMeters?: number
  destination: string
}

export const SPEED_TIERS: Record<SpeedTier, NavigationSpeedProfile> = {
  slow: { durationSeconds: 150, speedKph: 35, label: '慢速' },
  normal: { durationSeconds: 90, speedKph: 55, label: '正常' },
  fast: { durationSeconds: 45, speedKph: 75, label: '快速' },
} as const

export const DEFAULT_SIMULATOR_CONFIG: NavigationSimulatorConfig = {
  distanceKm: { outbound: 32, return: 29 },
  initialBatteryPercent: 72,
  fullRangeKm: 420,
  consumptionPercentPerKm: 0.42,
  profiles: SPEED_TIERS,
}

type RoadSegment = {
  from: number
  road: string
  maneuver: string
  maneuverId?: string
  maneuverAt?: number
}

const ROADS: Record<NavigationLeg, RoadSegment[]> = {
  outbound: [
    { from: 0, road: '当前位置附近道路', maneuver: '沿道路向西行驶', maneuverId: 'outbound-west', maneuverAt: 0.18 },
    { from: 0.18, road: '延安西路', maneuver: '前方右转进入内环高架', maneuverId: 'outbound-inner-ring', maneuverAt: 0.43 },
    { from: 0.43, road: '内环高架', maneuver: '沿内环高架直行', maneuverId: 'outbound-hongqiao-road', maneuverAt: 0.72 },
    { from: 0.72, road: '虹桥路', maneuver: '靠右驶向机场到达层', maneuverId: 'outbound-terminal', maneuverAt: 0.92 },
    { from: 0.92, road: '机场到达通道', maneuver: '前方到达机场接人点' },
  ],
  return: [
    { from: 0, road: '机场出发通道', maneuver: '驶离航站楼', maneuverId: 'return-hongqiao-road', maneuverAt: 0.17 },
    { from: 0.17, road: '虹桥路', maneuver: '前方左转进入延安高架', maneuverId: 'return-elevated', maneuverAt: 0.46 },
    { from: 0.46, road: '延安高架', maneuver: '沿延安高架直行', maneuverId: 'return-surface', maneuverAt: 0.78 },
    { from: 0.78, road: '延安西路', maneuver: '靠右驶入地面道路', maneuverId: 'return-home', maneuverAt: 0.94 },
    { from: 0.94, road: '家附近道路', maneuver: '前方到达家' },
  ],
}

export const browserNavigationClock: NavigationClock = {
  now: () => Date.now(),
  schedule: (callback) => {
    const timer = window.setInterval(callback, 100)
    return () => window.clearInterval(timer)
  },
}

export function createNavigationSimulatorState(nowMs = 0): NavigationSimulatorState {
  return {
    runState: 'idle',
    speedTier: 'normal',
    progress: 0,
    anchorProgress: 0,
    anchorTimeMs: nowMs,
    batteryAtLegStart: DEFAULT_SIMULATOR_CONFIG.initialBatteryPercent,
    completedDistanceKm: 0,
    remindedManeuvers: [],
  }
}

export type NavigationSimulatorAction =
  | { type: 'start-leg'; leg: NavigationLeg; nowMs: number; batteryPercent?: number }
  | { type: 'tick'; nowMs: number; durationSeconds?: number }
  | { type: 'set-speed'; speedTier: SpeedTier; nowMs: number; currentDurationSeconds?: number }
  | { type: 'mark-reminded'; maneuverId: string }
  | { type: 'reset'; nowMs: number }

export function navigationSimulatorReducer(
  state: NavigationSimulatorState,
  action: NavigationSimulatorAction,
): NavigationSimulatorState {
  switch (action.type) {
    case 'start-leg':
      return {
        leg: action.leg,
        runState: 'driving',
        speedTier: 'normal',
        progress: 0,
        anchorProgress: 0,
        anchorTimeMs: action.nowMs,
        batteryAtLegStart: action.batteryPercent ?? currentBattery(state),
        completedDistanceKm: state.completedDistanceKm,
        remindedManeuvers: [],
      }
    case 'tick': {
      if (state.runState !== 'driving' || !state.leg) return state
      const progress = projectedProgressForDuration(
        state,
        action.nowMs,
        action.durationSeconds ?? SPEED_TIERS[state.speedTier].durationSeconds,
      )
      return {
        ...state,
        progress,
        runState: progress >= 1 ? 'arrived' : 'driving',
        ...(progress >= 1 ? { anchorProgress: 1, anchorTimeMs: action.nowMs } : {}),
      }
    }
    case 'set-speed': {
      if (state.runState !== 'driving' || state.speedTier === action.speedTier) return state
      const progress = projectedProgressForDuration(
        state,
        action.nowMs,
        action.currentDurationSeconds ?? SPEED_TIERS[state.speedTier].durationSeconds,
      )
      return {
        ...state,
        speedTier: action.speedTier,
        progress,
        anchorProgress: progress,
        anchorTimeMs: action.nowMs,
        runState: progress >= 1 ? 'arrived' : 'driving',
      }
    }
    case 'mark-reminded':
      return state.remindedManeuvers.includes(action.maneuverId)
        ? state
        : { ...state, remindedManeuvers: [...state.remindedManeuvers, action.maneuverId] }
    case 'reset':
      return createNavigationSimulatorState(action.nowMs)
  }
}

export function nextSpeedTier(current: SpeedTier, direction: 'faster' | 'slower'): SpeedTier {
  const tiers: SpeedTier[] = ['slow', 'normal', 'fast']
  const index = tiers.indexOf(current)
  return tiers[Math.max(0, Math.min(tiers.length - 1, index + (direction === 'faster' ? 1 : -1)))]!
}

export function projectedProgress(
  state: NavigationSimulatorState,
  nowMs: number,
  config: NavigationSimulatorConfig = DEFAULT_SIMULATOR_CONFIG,
): number {
  if (state.runState !== 'driving') return clampProgress(state.progress)
  const elapsedSeconds = Math.max(0, nowMs - state.anchorTimeMs) / 1000
  const gained = elapsedSeconds / config.profiles[state.speedTier].durationSeconds
  return clampProgress(state.anchorProgress + gained)
}

function projectedProgressForDuration(
  state: NavigationSimulatorState,
  nowMs: number,
  durationSeconds: number,
): number {
  if (state.runState !== 'driving') return clampProgress(state.progress)
  const elapsedSeconds = Math.max(0, nowMs - state.anchorTimeMs) / 1000
  return clampProgress(state.anchorProgress + elapsedSeconds / durationSeconds)
}

export function simulatorSnapshot(
  state: NavigationSimulatorState,
  nowMs: number,
  config: NavigationSimulatorConfig = DEFAULT_SIMULATOR_CONFIG,
): NavigationSnapshot {
  const leg = state.leg
  const progress = projectedProgress(state, nowMs, config)
  const distanceKm = leg ? config.distanceKm[leg] : 0
  const travelledKm = distanceKm * progress
  const batteryPercent = Math.max(0, state.batteryAtLegStart - travelledKm * config.consumptionPercentPerKm)
  const remainingDistanceKm = Math.max(0, distanceKm - travelledKm)
  const remainingSeconds = state.runState === 'driving'
    ? Math.max(0, (1 - progress) * config.profiles[state.speedTier].durationSeconds)
    : 0
  const road = leg ? roadAt(leg, progress, distanceKm) : undefined
  return {
    leg,
    runState: state.runState,
    speedTier: state.speedTier,
    speedKph: state.runState === 'driving' ? config.profiles[state.speedTier].speedKph : 0,
    progress,
    distanceKm,
    travelledKm,
    remainingDistanceKm,
    batteryPercent,
    remainingRangeKm: Math.max(0, (batteryPercent / 100) * config.fullRangeKm),
    remainingSeconds,
    ...(state.runState === 'driving' ? { etaMs: nowMs + remainingSeconds * 1000 } : {}),
    road: road?.road ?? '当前位置',
    maneuver: road?.maneuver ?? '等待开始导航',
    ...(road?.maneuverId ? { maneuverId: road.maneuverId } : {}),
    ...(road?.maneuverDistanceMeters !== undefined ? { maneuverDistanceMeters: road.maneuverDistanceMeters } : {}),
    destination: leg === 'return' ? '家' : '机场接人点',
  }
}

export function currentBattery(
  state: NavigationSimulatorState,
  config: NavigationSimulatorConfig = DEFAULT_SIMULATOR_CONFIG,
): number {
  if (!state.leg) return state.batteryAtLegStart
  return Math.max(0, state.batteryAtLegStart - config.distanceKm[state.leg] * state.progress * config.consumptionPercentPerKm)
}

export function pendingManeuverReminder(
  state: NavigationSimulatorState,
  snapshot: NavigationSnapshot,
): { id: string; text: string } | undefined {
  if (snapshot.runState !== 'driving' || !snapshot.maneuverId) return undefined
  if (state.remindedManeuvers.includes(snapshot.maneuverId)) return undefined
  if (snapshot.maneuverDistanceMeters === undefined || snapshot.maneuverDistanceMeters > 300) return undefined
  return { id: snapshot.maneuverId, text: reminderText(snapshot.maneuver) }
}

function roadAt(leg: NavigationLeg, progress: number, distanceKm: number) {
  const segments = ROADS[leg]
  let segment = segments[0]!
  for (const candidate of segments) {
    if (progress >= candidate.from) segment = candidate
  }
  const maneuverDistanceMeters = segment.maneuverAt === undefined
    ? undefined
    : Math.max(0, (segment.maneuverAt - progress) * distanceKm * 1000)
  return { ...segment, maneuverDistanceMeters }
}

function reminderText(maneuver: string): string {
  const normalized = maneuver.replace(/^前方/u, '').replace(/^靠右/u, '靠右')
  return `前方 300 米${normalized}`
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
