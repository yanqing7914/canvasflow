import type { AirportPickupEvent, AirportPickupTaskState } from '@canvasflow/schema'

export type PlannedEffect = { type: string; status: 'planned' | 'pending-confirmation' | 'succeeded' | 'failed' | 'cancelled'; tool?: string }

export function planEffects(state: AirportPickupTaskState, event: AirportPickupEvent, toolResults: Record<string, unknown>): PlannedEffect[] {
  if (state.processedEventIds.includes(event.eventId)) return []
  if (event.type === 'navigation.started') return [{ type: 'navigation.start', status: 'succeeded', tool: 'navigation.start' }]
  if (event.type === 'flight.updated' && event.flight.status === 'landed' && state.message.autoNotifyAuthorized && !state.message.landingNoticeSent) return [{ type: 'message.send', status: 'planned', tool: 'message.send' }]
  if (event.type === 'user.confirmed-passengers-onboard' && 'memory.get-preferences' in toolResults) return [{ type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' }]
  if (event.type === 'user.confirmed-passengers-onboard') return [{ type: 'navigation.update-route', status: 'succeeded', tool: 'navigation.update-route' }]
  if (event.type === 'destination.arrived') return [{ type: 'memory.propose-update', status: 'pending-confirmation', tool: 'memory.propose-update' }]
  return []
}
