import type { AirportPickupEvent, AirportPickupTaskState } from '@canvasflow/schema'

export type PlannedEffect = { type: string; status: 'planned' | 'pending-confirmation' | 'succeeded' | 'failed' | 'cancelled'; tool?: string }

export function planEffects(state: AirportPickupTaskState, event: AirportPickupEvent, toolResults: Record<string, unknown>): PlannedEffect[] {
  if (state.processedEventIds.includes(event.eventId)) return []
  if (event.type === 'navigation.started' && state.phase === 'preparing') return [{ type: 'navigation.start', status: 'succeeded', tool: 'navigation.start' }]
  if (event.type === 'flight.updated' && state.phase === 'driving-to-airport' && event.flight.status === 'landed' && state.message.autoNotifyAuthorized && !state.message.landingNoticeSent && state.message.status === 'idle') return [{ type: 'message.send', status: 'planned', tool: 'message.send' }]
  if (event.type === 'user.input' && state.phase === 'returning-home' && /座舱|偏好|温度|媒体/.test(event.text) && 'memory.get-preferences' in toolResults) return [{ type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' }]
  if (event.type === 'user.confirmed-passengers-onboard' && state.phase === 'waiting-for-passengers') return [{ type: 'navigation.update-route', status: 'succeeded', tool: 'navigation.update-route' }]
  if (event.type === 'destination.arrived' && state.phase === 'returning-home') return [{ type: 'memory.propose-update', status: 'pending-confirmation', tool: 'memory.propose-update' }]
  return []
}
