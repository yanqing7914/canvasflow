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
  doubao: {
    mediaTitle: '豆豆故事',
    landingNotificationAuthorized: false,
  },
}

/** Requesting this flight number deterministically simulates PROVIDER_TIMEOUT. */
export const TIMEOUT_FLIGHT_NUMBER = 'MU0000'

export type FlightRecord = FlightStatusOutput & { date: string }

/** Fixtures are keyed by flight number; `date` must also match the request. */
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
  },
}

export type VehicleSnapshotName = 'parked' | 'city-driving' | 'highway-driving'

export const DEFAULT_VEHICLE_SNAPSHOT: VehicleSnapshotName = 'parked'

/** Speed / battery / gear / night presets used to drive UI density scenarios. */
export const vehicleSnapshots: Record<VehicleSnapshotName, VehicleStatusOutput> = {
  parked: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: true, rearOccupied: false },
  'city-driving': { speedKph: 35, batteryPercent: 35, remainingRangeKm: 93, gear: 'D', isNight: true, rearOccupied: false },
  'highway-driving': { speedKph: 80, batteryPercent: 30, remainingRangeKm: 80, gear: 'D', isNight: true, rearOccupied: false },
}

export const chargingStation = {
  stationId: 'station-hongqiao-01',
  suggestedDurationMinutes: 10,
  etaImpactMinutes: 12,
}