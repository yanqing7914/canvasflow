import type { AirportPickupEvent, AirportPickupTaskState } from '@canvasflow/schema'
import { memberPreferences, resolveAuthorizedLandingContact, type MemberPreferenceRecord } from '@canvasflow/tools'

export type PlannedEffect = { type: string; status: 'planned' | 'pending-confirmation' | 'succeeded' | 'failed' | 'cancelled'; tool?: string }

export function planEffects(
  state: AirportPickupTaskState,
  event: AirportPickupEvent,
  toolResults: Record<string, unknown>,
  preferences: Record<string, MemberPreferenceRecord> = memberPreferences,
): PlannedEffect[] {
  if (state.processedEventIds.includes(event.eventId)) return []
  if (state.phase === 'completed' || state.phase === 'cancelled') return []
  if (Date.parse(event.timestamp) < Date.parse(state.updatedAt)) return []
  if (event.type === 'flight.updated' && Date.parse(event.timestamp) === Date.parse(state.updatedAt) && state.flight) return []
  if (
    event.type === 'flight.updated' &&
    state.phase === 'driving-to-airport' &&
    event.flight.status === 'landed' &&
    state.message.autoNotifyAuthorized &&
    !state.message.landingNoticeSent &&
    state.message.status === 'idle' &&
    resolveAuthorizedLandingContact(state.passengers.memberIds, preferences)
  ) {
    return [{ type: 'message.send', status: 'planned', tool: 'message.send' }]
  }
  if (event.type === 'destination.arrived' && state.phase === 'returning-home') return [{ type: 'memory.propose-update', status: 'pending-confirmation', tool: 'memory.propose-update' }]
  return []
}
