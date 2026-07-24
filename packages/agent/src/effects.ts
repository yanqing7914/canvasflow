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
  if (event.type === 'navigation.started' && state.phase === 'preparing') return [{ type: 'navigation.start', status: 'succeeded', tool: 'navigation.start' }]
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
  const preferencesResult = toolResults['memory.get-preferences']
  if (event.type === 'user.input' && state.phase === 'returning-home' && /座舱|偏好|温度|媒体/.test(event.text) && isSuccessfulPreferences(preferencesResult)) return [{ type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' }]
  if (event.type === 'user.confirmed-passengers-onboard' && state.phase === 'waiting-for-passengers') return [{ type: 'navigation.update-route', status: 'succeeded', tool: 'navigation.update-route' }]
  if (event.type === 'destination.arrived' && state.phase === 'returning-home') return [{ type: 'memory.propose-update', status: 'pending-confirmation', tool: 'memory.propose-update' }]
  return []
}

/** Matches the memory.get-preferences output contract: any applicable cabin/media preference counts. */
function isSuccessfulPreferences(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || (value as { ok?: unknown }).ok !== true) return false
  const data = (value as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return false
  const members = (data as { members?: unknown }).members
  return Array.isArray(members) && members.some((member) => {
    if (typeof member !== 'object' || member === null) return false
    const record = member as { rearTemperatureC?: unknown; mediaTitle?: unknown }
    return typeof record.rearTemperatureC === 'number' || typeof record.mediaTitle === 'string'
  })
}
