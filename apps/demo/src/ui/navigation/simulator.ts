import {
  advanceNavigationSimulation,
  createNavigationSimulation,
  NAVIGATION_SIMULATION_PROFILES,
  setNavigationSimulationSpeed,
  type NavigationSimulationState,
} from '@canvasflow/tools'

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
  simulation?: NavigationSimulationState
  remindedManeuvers: string[]
}

export type NavigationSnapshot = {
  /** The active simulation route, forwarded only with a later user command. */
  routeId?: string
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
  slow: { durationSeconds: NAVIGATION_SIMULATION_PROFILES.slow.durationSeconds, speedKph: NAVIGATION_SIMULATION_PROFILES.slow.displaySpeedKph, label: '慢速' },
  normal: { durationSeconds: NAVIGATION_SIMULATION_PROFILES.normal.durationSeconds, speedKph: NAVIGATION_SIMULATION_PROFILES.normal.displaySpeedKph, label: '正常' },
  fast: { durationSeconds: NAVIGATION_SIMULATION_PROFILES.fast.durationSeconds, speedKph: NAVIGATION_SIMULATION_PROFILES.fast.displaySpeedKph, label: '快速' },
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

declare global {
  interface Window {
    /** E2E seam installed before the app loads; production never defines it. */
    __canvasflowNavigationClock?: NavigationClock
  }
}

export function resolveNavigationClock(): NavigationClock {
  return typeof window !== 'undefined' && window.__canvasflowNavigationClock
    ? window.__canvasflowNavigationClock
    : browserNavigationClock
}

export function createNavigationSimulatorState(_nowMs?: number): NavigationSimulatorState {
  void _nowMs
  return { remindedManeuvers: [] }
}

export type NavigationSimulatorAction =
  | { type: 'start-leg'; leg: NavigationLeg; nowMs: number; batteryPercent?: number; config?: NavigationSimulatorConfig; routeId?: string }
  | { type: 'tick'; nowMs: number }
  | { type: 'set-speed'; speedTier: SpeedTier; nowMs: number }
  | { type: 'mark-reminded'; maneuverId: string }
  | { type: 'reset'; nowMs: number }

export function navigationSimulatorReducer(
  state: NavigationSimulatorState,
  action: NavigationSimulatorAction,
): NavigationSimulatorState {
  switch (action.type) {
    case 'start-leg':
      return {
        simulation: createNavigationSimulation({
          leg: action.leg,
          routeId: action.routeId ?? action.leg,
          distanceKm: (action.config ?? DEFAULT_SIMULATOR_CONFIG).distanceKm[action.leg],
          initialBatteryPercent: action.batteryPercent ?? currentBattery(state, action.config),
          estimatedBatteryAtArrival: estimatedArrivalBattery(
            action.batteryPercent ?? currentBattery(state, action.config),
            action.leg,
            action.config,
          ),
          nowMs: action.nowMs,
          profiles: toolProfiles(action.config),
        }),
        remindedManeuvers: [],
      }
    case 'tick': {
      if (!state.simulation || state.simulation.arrived) return state
      return { ...state, simulation: snapshotState(advanceNavigationSimulation(state.simulation, action.nowMs)) }
    }
    case 'set-speed': {
      if (!state.simulation) return state
      return { ...state, simulation: setNavigationSimulationSpeed(state.simulation, action.speedTier, action.nowMs).state }
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
  _config?: NavigationSimulatorConfig,
): number {
  void _config
  return state.simulation ? advanceNavigationSimulation(state.simulation, nowMs).progress : 0
}

export function simulatorSnapshot(
  state: NavigationSimulatorState,
  nowMs: number,
  config: NavigationSimulatorConfig = DEFAULT_SIMULATOR_CONFIG,
): NavigationSnapshot {
  const core = state.simulation ? advanceNavigationSimulation(state.simulation, nowMs) : undefined
  const leg = core?.leg
  const progress = core?.progress ?? 0
  const distanceKm = core?.distanceKm ?? 0
  const travelledKm = core?.traveledDistanceKm ?? 0
  const batteryPercent = core?.batteryPercent ?? config.initialBatteryPercent
  const remainingDistanceKm = core?.remainingDistanceKm ?? 0
  const remainingSeconds = core?.remainingSeconds ?? 0
  const runState: NavigationRunState = !core ? 'idle' : core.arrived ? 'arrived' : 'driving'
  const speedTier = core?.speedMode ?? 'normal'
  const road = leg ? roadAt(leg, progress, distanceKm) : undefined
  return {
    ...(core?.routeId ? { routeId: core.routeId } : {}),
    leg,
    runState,
    speedTier,
    speedKph: core?.speedKph ?? 0,
    progress,
    distanceKm,
    travelledKm,
    remainingDistanceKm,
    batteryPercent,
    remainingRangeKm: Math.max(0, (batteryPercent / 100) * config.fullRangeKm),
    remainingSeconds,
    ...(runState === 'driving' ? { etaMs: core?.etaMs } : {}),
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
  if (!state.simulation) return config.initialBatteryPercent
  const drop = state.simulation.initialBatteryPercent - state.simulation.estimatedBatteryAtArrival
  return Math.max(0, state.simulation.initialBatteryPercent - drop * state.simulation.progress)
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

const FLIGHT_LANDING_REMIND_PROGRESS = 0.6

/**
 * Simulated arrival walk-off reminder, offered once per navigation. The
 * minutes are deterministic estimates labelled as such; they are never
 * presented as live airport data.
 */
export function pendingFlightLandingReminder(
  state: NavigationSimulatorState,
  snapshot: NavigationSnapshot,
  flight: {
    flightNumber: string
    estimatedArrival: string
    terminal: string
    airportLabel?: string
    navigationEta?: string
  } | undefined,
): { id: string; text: string } | undefined {
  if (snapshot.runState !== 'driving' || snapshot.leg !== 'outbound') return undefined
  if (snapshot.progress < FLIGHT_LANDING_REMIND_PROGRESS || state.remindedManeuvers.includes('flight-landing')) return undefined
  if (!flight) return undefined
  const arrivalLabel = formatClockLabel(flight.estimatedArrival)
  const driveEtaLabel = snapshot.etaMs ? formatClockLabel(snapshot.etaMs) : flight.navigationEta ? formatClockLabel(flight.navigationEta) : undefined
  const destination = (flight.airportLabel ?? '机场').replace(/\s*T\d+/u, '')
  return {
    id: 'flight-landing',
    text: [
      `${flight.flightNumber} 预计 ${arrivalLabel} 抵达${destination}${flight.terminal ? ` ${flight.terminal}` : ''}，`,
      '模拟估算下机及步行至到达出口约 20 分钟。',
      driveEtaLabel ? `你预计 ${driveEtaLabel} 到达，无需着急。` : '无需着急。',
      '以上为模拟估算，不来自机场实时系统。',
    ].join(''),
  }
}

function formatClockLabel(value: string | number): string {
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestamp))
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

function toolProfiles(config: NavigationSimulatorConfig = DEFAULT_SIMULATOR_CONFIG) {
  return {
    slow: { durationSeconds: config.profiles.slow.durationSeconds, displaySpeedKph: config.profiles.slow.speedKph },
    normal: { durationSeconds: config.profiles.normal.durationSeconds, displaySpeedKph: config.profiles.normal.speedKph },
    fast: { durationSeconds: config.profiles.fast.durationSeconds, displaySpeedKph: config.profiles.fast.speedKph },
  }
}

function estimatedArrivalBattery(
  initialBatteryPercent: number,
  leg: NavigationLeg,
  config: NavigationSimulatorConfig = DEFAULT_SIMULATOR_CONFIG,
): number {
  return Math.max(0, initialBatteryPercent - config.distanceKm[leg] * config.consumptionPercentPerKm)
}

function snapshotState(snapshot: ReturnType<typeof advanceNavigationSimulation>): NavigationSimulationState {
  return {
    leg: snapshot.leg,
    routeId: snapshot.routeId,
    distanceKm: snapshot.distanceKm,
    initialBatteryPercent: snapshot.initialBatteryPercent,
    estimatedBatteryAtArrival: snapshot.estimatedBatteryAtArrival,
    speedMode: snapshot.speedMode,
    progress: snapshot.progress,
    anchoredAtMs: snapshot.anchoredAtMs,
    anchoredProgress: snapshot.anchoredProgress,
    arrived: snapshot.arrived,
    profiles: snapshot.profiles,
  }
}
