import type { FlightStatusOutput, RoutePlanOutput, VehicleStatusOutput } from '@canvasflow/schema'
import { FIXTURE_GENERATED_AT } from './result'

/**
 * Deterministic fixture dataset for the airport pickup scenario.
 * All names, contacts and locations are fictional per the tool contract.
 * Values are aligned with fixtures/airport-pickup so Agent, tools and UI
 * tests replay the same timeline.
 */

export type FamilyMemberRecord = {
  memberId: string
  displayName: string
  labels: string[]
  contactId?: string
}

export const familyMembers: FamilyMemberRecord[] = [
  { memberId: 'mom', displayName: '妈妈', labels: ['妈妈'], contactId: 'contact-mom' },
  { memberId: 'dad', displayName: '爸爸', labels: ['爸爸'], contactId: 'contact-dad' },
  { memberId: 'doubao', displayName: '豆豆', labels: ['豆豆'] },
]

export type MemberPreferenceRecord = {
  rearTemperatureC?: number
  mediaTitle?: string
  homeDestinationId?: string
  landingNotificationAuthorized: boolean
}

export const memberPreferences: Record<string, MemberPreferenceRecord> = {
  mom: {
    rearTemperatureC: 25,
    homeDestinationId: 'destination-home',
    landingNotificationAuthorized: true,
  },
  dad: {
    landingNotificationAuthorized: false,
  },
  doubao: {
    mediaTitle: '豆豆故事',
    landingNotificationAuthorized: false,
  },
}

/** Requesting this flight number deterministically simulates PROVIDER_TIMEOUT. */
export const TIMEOUT_FLIGHT_NUMBER = 'MU0000'

/**
 * Requesting a route to this destination id deterministically simulates
 * PROVIDER_TIMEOUT for navigation.plan-route (mirrors MU0000 for flights).
 */
export const TIMEOUT_DESTINATION_ID = 'destination-timeout'

export type FlightRecord = FlightStatusOutput & { date: string }

/**
 * Fixtures are keyed by flight number; `date` must also match the request.
 * MU5102 is the main-demo flight (scheduled baseline; in-air / landed / delayed /
 * cancelled updates arrive as provider pushes on the timeline). MU5103 / MU5104
 * are exception lookup fixtures for delayed and cancelled tool demos.
 */
export const flights: Record<string, FlightRecord> = {
  MU5102: {
    flightNumber: 'MU5102',
    date: '2026-07-22',
    status: 'scheduled',
    scheduledArrival: '2026-07-22T20:30:00+08:00',
    estimatedArrival: '2026-07-22T20:40:00+08:00',
    terminal: 'T2',
    sourceUpdatedAt: FIXTURE_GENERATED_AT,
  },
  MU5103: {
    flightNumber: 'MU5103',
    date: '2026-07-22',
    status: 'delayed',
    scheduledArrival: '2026-07-22T20:30:00+08:00',
    estimatedArrival: '2026-07-22T21:10:00+08:00',
    terminal: 'T1',
    sourceUpdatedAt: FIXTURE_GENERATED_AT,
  },
  MU5104: {
    flightNumber: 'MU5104',
    date: '2026-07-22',
    status: 'cancelled',
    scheduledArrival: '2026-07-22T20:30:00+08:00',
    estimatedArrival: '2026-07-22T20:30:00+08:00',
    terminal: 'T2',
    sourceUpdatedAt: FIXTURE_GENERATED_AT,
  },
}

/** Canonical demo origin used by airport-pickup fixtures (fictional Shanghai CBD). */
export const DEMO_ORIGIN = { latitude: 31.23, longitude: 121.47 } as const

/**
 * Fixture routes keyed by origin, destination, optional via waypoints, and preference flags.
 * Requests that do not match a key must fail explicitly — never silently ignore constraints.
 */
export type RouteFixtureKey = {
  originLatitude: number
  originLongitude: number
  destinationId: string
  viaIds: string[]
  avoidHighway: boolean
  avoidTolls: boolean
}

export function routeFixtureKey(key: RouteFixtureKey): string {
  // Via order matters: A→B and B→A are different routes and must not collide.
  const via = key.viaIds.join(',') || '-'
  return `origin=${key.originLatitude},${key.originLongitude}|${key.destinationId}|via=${via}|hw=${key.avoidHighway ? 1 : 0}|toll=${key.avoidTolls ? 1 : 0}`
}

function demoRouteKey(partial: Omit<RouteFixtureKey, 'originLatitude' | 'originLongitude'>): string {
  return routeFixtureKey({
    originLatitude: DEMO_ORIGIN.latitude,
    originLongitude: DEMO_ORIGIN.longitude,
    ...partial,
  })
}

/** Fictional landmark coordinates for static sketch-map demos (not real GIS). */
const GEO = {
  origin: { latitude: DEMO_ORIGIN.latitude, longitude: DEMO_ORIGIN.longitude },
  home: { id: 'destination-home', name: '家', latitude: 31.228, longitude: 121.468 },
  airportT2: {
    id: 'destination-hongqiao-t2',
    name: '虹桥机场 T2',
    latitude: 31.198,
    longitude: 121.336,
  },
  stationHongqiao01: {
    id: 'station-hongqiao-01',
    name: '虹桥枢纽超充站',
    latitude: 31.21,
    longitude: 121.38,
  },
  ringRoad: {
    id: 'via-ring-road-01',
    name: '外环快速路',
    latitude: 31.215,
    longitude: 121.41,
  },
} as const

/**
 * Fixture routes keyed by origin, destination, optional via waypoints, and preference flags.
 * Each entry includes optional sketch geometry (waypoints / polyline / summary) for demo maps.
 */
export const routes: Record<string, RoutePlanOutput> = {
  [demoRouteKey({
    destinationId: 'destination-hongqiao-t2',
    viaIds: [],
    avoidHighway: false,
    avoidTolls: false,
  })]: {
    routeId: 'route-airport-001',
    distanceKm: 32,
    durationMinutes: 20,
    arrivalTime: '2026-07-22T20:25:00+08:00',
    estimatedBatteryAtArrival: 27,
    summary: '直达虹桥机场 T2',
    waypoints: [
      { id: 'origin-demo', name: '出发地', ...GEO.origin },
      GEO.airportT2,
    ],
    polyline: [
      GEO.origin,
      { latitude: 31.222, longitude: 121.44 },
      { latitude: 31.21, longitude: 121.39 },
      GEO.airportT2,
    ],
  },
  [demoRouteKey({
    destinationId: 'destination-hongqiao-t2',
    viaIds: ['station-hongqiao-01'],
    avoidHighway: false,
    avoidTolls: false,
  })]: {
    routeId: 'route-airport-via-charge-001',
    distanceKm: 38,
    durationMinutes: 32,
    arrivalTime: '2026-07-22T20:37:00+08:00',
    estimatedBatteryAtArrival: 55,
    summary: '经虹桥枢纽超充站前往机场',
    waypoints: [
      { id: 'origin-demo', name: '出发地', ...GEO.origin },
      GEO.stationHongqiao01,
      GEO.airportT2,
    ],
    polyline: [
      GEO.origin,
      { latitude: 31.22, longitude: 121.43 },
      GEO.stationHongqiao01,
      { latitude: 31.204, longitude: 121.355 },
      GEO.airportT2,
    ],
  },
  // Congestion alternate: avoid the highway (plan-route with avoidHighway).
  [demoRouteKey({
    destinationId: 'destination-hongqiao-t2',
    viaIds: [],
    avoidHighway: true,
    avoidTolls: false,
  })]: {
    routeId: 'route-airport-avoid-hw-001',
    distanceKm: 36,
    durationMinutes: 28,
    arrivalTime: '2026-07-22T20:33:00+08:00',
    estimatedBatteryAtArrival: 25,
    summary: '避高速地面道路前往机场',
    waypoints: [
      { id: 'origin-demo', name: '出发地', ...GEO.origin },
      GEO.airportT2,
    ],
    polyline: [
      GEO.origin,
      { latitude: 31.225, longitude: 121.45 },
      { latitude: 31.218, longitude: 121.42 },
      { latitude: 31.208, longitude: 121.37 },
      { latitude: 31.2, longitude: 121.345 },
      GEO.airportT2,
    ],
  },
  // Congestion alternate mid-trip: ring-road via for navigation.update-route
  // (update-route schema has via but not preferences).
  [demoRouteKey({
    destinationId: 'destination-hongqiao-t2',
    viaIds: ['via-ring-road-01'],
    avoidHighway: false,
    avoidTolls: false,
  })]: {
    routeId: 'route-airport-bypass-001',
    distanceKm: 40,
    durationMinutes: 30,
    arrivalTime: '2026-07-22T20:35:00+08:00',
    estimatedBatteryAtArrival: 24,
    summary: '经外环快速路改线前往机场',
    waypoints: [
      { id: 'origin-demo', name: '出发地', ...GEO.origin },
      GEO.ringRoad,
      GEO.airportT2,
    ],
    polyline: [
      GEO.origin,
      { latitude: 31.226, longitude: 121.455 },
      GEO.ringRoad,
      { latitude: 31.205, longitude: 121.36 },
      GEO.airportT2,
    ],
  },
  [demoRouteKey({
    destinationId: 'destination-home',
    viaIds: [],
    avoidHighway: false,
    avoidTolls: false,
  })]: {
    routeId: 'route-home-001',
    distanceKm: 32,
    durationMinutes: 40,
    arrivalTime: '2026-07-22T21:35:00+08:00',
    estimatedBatteryAtArrival: 32,
    // Geometry must match plan-route request origin (DEMO_ORIGIN), not the airport —
    // callers today plan home with the same demo origin key as outbound routes.
    summary: '返程回家',
    waypoints: [
      { id: 'origin-demo', name: '出发地', ...GEO.origin },
      GEO.home,
    ],
    polyline: [
      GEO.origin,
      { latitude: 31.225, longitude: 121.45 },
      { latitude: 31.22, longitude: 121.46 },
      GEO.home,
    ],
  },
}

export type VehicleSnapshotName =
  | 'parked'
  | 'city-driving'
  | 'highway-driving'
  | 'post-charge'
  | 'airport-parked'
  | 'rear-occupied'
  | 'low-battery-parked'
  | 'low-battery-city'
  | 'low-battery-highway'

export const DEFAULT_VEHICLE_SNAPSHOT: VehicleSnapshotName = 'parked'

/**
 * Speed / battery / gear / night presets used to drive UI density scenarios.
 * `post-charge` mirrors the charging-completed fixture (78%), `airport-parked`
 * mirrors waiting-for-passengers (parked at the pickup point, rear empty),
 * `rear-occupied` mirrors passengers-onboard (51%, rear seats occupied).
 * The `low-battery-*` presets (battery < 20%) pair with
 * {@link chargingStationsForDensity}: parked→full(3), city→compact(2),
 * highway→minimal(1).
 */
export const vehicleSnapshots: Record<VehicleSnapshotName, VehicleStatusOutput> = {
  parked: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: true, rearOccupied: false },
  'city-driving': { speedKph: 35, batteryPercent: 35, remainingRangeKm: 93, gear: 'D', isNight: true, rearOccupied: false },
  'highway-driving': { speedKph: 80, batteryPercent: 30, remainingRangeKm: 80, gear: 'D', isNight: true, rearOccupied: false },
  'post-charge': { speedKph: 0, batteryPercent: 78, remainingRangeKm: 208, gear: 'P', isNight: true, rearOccupied: false },
  'airport-parked': { speedKph: 0, batteryPercent: 52, remainingRangeKm: 138, gear: 'P', isNight: true, rearOccupied: false },
  'rear-occupied': { speedKph: 0, batteryPercent: 51, remainingRangeKm: 136, gear: 'P', isNight: true, rearOccupied: true },
  'low-battery-parked': { speedKph: 0, batteryPercent: 18, remainingRangeKm: 46, gear: 'P', isNight: true, rearOccupied: false },
  'low-battery-city': { speedKph: 30, batteryPercent: 18, remainingRangeKm: 46, gear: 'D', isNight: true, rearOccupied: false },
  'low-battery-highway': { speedKph: 80, batteryPercent: 16, remainingRangeKm: 40, gear: 'D', isNight: true, rearOccupied: false },
}

export type ChargingStationRecord = {
  stationId: string
  name: string
  distanceKm: number
  /** Extra minutes added to the airport ETA when charging here. */
  detourMinutes: number
  availableStalls: number
  totalStalls: number
  maxPowerKw: number
  pricePerKwhYuan: number
  open24h: boolean
}

/**
 * Comparison dataset for the low-battery charging branch, sorted by distance.
 * All stations are fictional. The first entry is the recommended station that
 * `charging.recommend` returns; {@link chargingStationsForDensity} projects how
 * many entries the UI should surface for a density tier.
 */
export const chargingStations: ChargingStationRecord[] = [
  { stationId: 'station-hongqiao-01', name: '虹桥枢纽超充站', distanceKm: 2.1, detourMinutes: 12, availableStalls: 6, totalStalls: 8, maxPowerKw: 250, pricePerKwhYuan: 1.6, open24h: true },
  { stationId: 'station-hongqiao-02', name: '申贵路快充站', distanceKm: 3.4, detourMinutes: 16, availableStalls: 2, totalStalls: 4, maxPowerKw: 120, pricePerKwhYuan: 1.3, open24h: true },
  { stationId: 'station-hongqiao-03', name: '北翟路充电站', distanceKm: 5.8, detourMinutes: 22, availableStalls: 4, totalStalls: 10, maxPowerKw: 90, pricePerKwhYuan: 1.1, open24h: false },
]

export type ChargingPresentationDensity = 'full' | 'compact' | 'minimal'

/**
 * Map vehicle speed to charging-list density:
 * parked (0) → full, city (≤60) → compact, highway (>60) → minimal.
 */
export function chargingDensityForSpeed(speedKph: number): ChargingPresentationDensity {
  if (speedKph <= 0) return 'full'
  if (speedKph <= 60) return 'compact'
  return 'minimal'
}

/** Parked/full → 3 stations; city/compact → 2; highway/minimal → nearest only. */
export function chargingStationsForDensity(
  density: ChargingPresentationDensity,
): ChargingStationRecord[] {
  if (density === 'full') return chargingStations.slice()
  if (density === 'compact') return chargingStations.slice(0, 2)
  return chargingStations.slice(0, 1)
}

export const chargingStation = {
  stationId: chargingStations[0].stationId,
  suggestedDurationMinutes: 10,
  etaImpactMinutes: chargingStations[0].detourMinutes,
}

export type MeetingPointRecord = {
  id: string
  terminal: string
  name: string
  description: string
  walkMinutes: number
}

/**
 * Recommended pickup meeting point per terminal, shown in the
 * approaching-airport / waiting-for-passengers phases. POC scope is display
 * only — no parking-spot query, reservation or payment.
 */
export const recommendedMeetingPoints: Record<string, MeetingPointRecord> = {
  T1: {
    id: 'meeting-point-t1-01',
    terminal: 'T1',
    name: 'P1 停车场到达层 5 号门',
    description: '航站楼变更后的推荐接机点；短时停车 15 分钟内免费。',
    walkMinutes: 4,
  },
  T2: {
    id: 'meeting-point-t2-01',
    terminal: 'T2',
    name: 'P2 停车场到达层 3 号门',
    description: '出到达大厅后直行约 50 米，短时停车 15 分钟内免费。',
    walkMinutes: 3,
  },
}

/** Fixture catalog of route IDs. Activation still requires a task-scoped plan. */
export const knownRouteIds = new Set(Object.values(routes).map((route) => route.routeId))

/** Known media titles accepted by cabin/memory/media side effects. */
export const knownMediaTitles = new Set(['豆豆故事', '轻音乐'])

/** Destination / waypoint IDs used by demo routes and preference updates. */
export const knownDestinationIds = new Set([
  'destination-home',
  'destination-hongqiao-t2',
  'station-hongqiao-01',
])