import {
  uiSpecSchema,
  type AirportPickupTaskState,
  type FlightArrivalCandidate,
  type RoutePlanOutput,
  type UISpec,
  type VehicleContext,
  type ChargingRecommendationOutput,
  type WindowKind,
} from '@canvasflow/schema'
import { NAVIGATION_SIMULATION_PROFILES } from '@canvasflow/tools'

export const START_OUTBOUND_ACTION_ID = 'start-outbound'
export const START_RETURN_ACTION_ID = 'start-return'

export function selectCockpitFlight(input: {
  task: AirportPickupTaskState
  flight: FlightArrivalCandidate
  route: RoutePlanOutput
  vehicle: VehicleContext
  charging?: ChargingRecommendationOutput
  at: string
}): AirportPickupTaskState {
  if (input.task.phase !== 'choosing-flight' || !input.task.pickupAirport) return input.task
  return {
    ...input.task,
    taskRevision: input.task.taskRevision + 1,
    phase: 'confirming-outbound',
    flight: {
      flightNumber: input.flight.flightNumber,
      airlineName: input.flight.airlineName,
      originName: input.flight.originName,
      status: input.flight.status,
      scheduledArrival: input.flight.scheduledArrival,
      estimatedArrival: input.flight.estimatedArrival,
      arrivalAirport: input.flight.arrivalAirport,
      arrivalAirportName: input.flight.arrivalAirportName,
      terminal: input.flight.terminal,
      trusted: true,
    },
    navigation: { routeId: input.route.routeId, destination: input.task.pickupAirport.label, eta: input.route.arrivalTime, status: 'planned' },
    navigationSimulation: {
      leg: 'outbound', routeId: input.route.routeId, distanceKm: input.route.distanceKm,
      initialBatteryPercent: input.vehicle.batteryPercent,
      estimatedBatteryAtArrival: input.route.estimatedBatteryAtArrival,
      profiles: NAVIGATION_SIMULATION_PROFILES,
    },
    charging: input.charging
      ? { ...input.task.charging, recommended: input.charging.recommended, status: input.charging.recommended ? 'planned' : 'none' }
      : input.task.charging,
    updatedAt: input.at,
  }
}

export function requestCockpitReturn(task: AirportPickupTaskState, input: {
  route: RoutePlanOutput
  batteryPercent: number
  at: string
}): AirportPickupTaskState {
  if (task.phase !== 'passengers-onboard') return task
  return {
    ...task,
    taskRevision: task.taskRevision + 1,
    phase: 'confirming-return',
    navigation: { routeId: input.route.routeId, destination: '家', eta: input.route.arrivalTime, status: 'planned' },
    navigationSimulation: {
      leg: 'return', routeId: input.route.routeId, distanceKm: input.route.distanceKm,
      initialBatteryPercent: input.batteryPercent,
      estimatedBatteryAtArrival: input.route.estimatedBatteryAtArrival,
      profiles: NAVIGATION_SIMULATION_PROFILES,
    },
    updatedAt: input.at,
  }
}

export function isCockpitActionAllowed(task: AirportPickupTaskState, actionId: string): boolean {
  return (actionId === START_OUTBOUND_ACTION_ID && task.phase === 'confirming-outbound'
      && task.flight !== undefined && task.navigation?.status === 'planned' && task.navigationSimulation?.leg === 'outbound')
    || (actionId === START_RETURN_ACTION_ID && task.phase === 'confirming-return'
      && task.passengers.confirmedOnboard && task.navigation?.status === 'planned' && task.navigationSimulation?.leg === 'return')
}

export function composeCockpitWindow(input: {
  task: AirportPickupTaskState
  base: UISpec
  id: string
  kind: WindowKind
  title: string
  componentIds: string[]
  actionIds?: string[]
  size?: 'compact' | 'medium' | 'large'
}): UISpec {
  const windows = input.task.phase === 'completed' ? [] : [...(input.base.windows ?? []), {
    id: input.id,
    kind: input.kind,
    title: input.title,
    componentIds: input.componentIds,
    ...(input.actionIds ? { actionIds: input.actionIds } : {}),
    size: input.size ?? 'medium',
    controls: { closable: true, minimizable: true, maximizable: true },
  }]
  return uiSpecSchema.parse({ ...input.base, windows })
}
