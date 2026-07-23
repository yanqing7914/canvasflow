import {
  airportPickupEventSchema,
  airportPickupTaskStateSchema,
  type AirportPickupEvent,
  type AirportPickupTaskState,
} from '@canvasflow/schema'

export * from './effects'

export function createInitialTask(taskId = 'pickup-001'): AirportPickupTaskState {
  return airportPickupTaskStateSchema.parse({
    taskId, surfaceId: 'airport-pickup-main', taskRevision: 0, uiRevision: 0, phase: 'collecting-information',
    passengers: { memberIds: [], names: [], confirmedOnboard: false }, charging: { recommended: false, accepted: false, status: 'none' },
    message: { autoNotifyAuthorized: true, status: 'idle', landingNoticeSent: false }, processedEventIds: [],
    updatedAt: '2026-07-22T12:00:00+08:00',
  })
}

function taskFacts(state: AirportPickupTaskState) {
  return {
    ...state,
    updatedAt: '',
    processedEventIds: [],
  }
}

export function applyEvent(state: AirportPickupTaskState, input: AirportPickupEvent): AirportPickupTaskState {
  const event = airportPickupEventSchema.parse(input)
  if (state.processedEventIds.includes(event.eventId)) return state
  if (state.phase === 'completed' || state.phase === 'cancelled') return state
  const next = structuredClone(state)
  const beforeFacts = taskFacts(state)
  let handled = false

  switch (event.type) {
    case 'user.input':
      handled = true
      if (/MU\d+/i.test(event.text)) next.flight = { flightNumber: event.text.match(/MU\d+/i)?.[0].toUpperCase() ?? event.text, status: 'scheduled', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }
      if (/补能|充电/.test(event.text)) next.charging = { ...next.charging, recommended: true, status: 'planned' }
      if (next.flight && next.passengers.names.length > 0 && next.phase === 'collecting-information') next.phase = 'preparing'
      break
    case 'flight.updated':
      next.flight = event.flight
      if (event.flight.status === 'landed' && next.message.autoNotifyAuthorized && !next.message.landingNoticeSent && next.message.status === 'idle') {
        next.message.status = 'scheduled'
        next.message.pendingMessageId = `${event.flight.flightNumber}:landing`
        next.message.idempotencyKey = `${next.taskId}:${event.flight.flightNumber}:landing`
      }
      break
    case 'navigation.started':
      if (next.phase === 'preparing') {
        next.phase = 'driving-to-airport'
        next.navigation = { routeId: event.routeId, destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' }
      }
      break
    case 'vehicle.entered-airport-geofence': if (next.phase === 'driving-to-airport') next.phase = 'approaching-airport'; break
    case 'vehicle.parked': if (next.phase === 'approaching-airport') next.phase = 'waiting-for-passengers'; break
    case 'user.confirmed-passengers-onboard': if (next.phase === 'waiting-for-passengers') { next.passengers.confirmedOnboard = true; next.phase = 'returning-home' } break
    case 'destination.arrived': if (next.phase === 'returning-home') { next.phase = 'completed'; next.navigation = next.navigation ? { ...next.navigation, destination: event.destination, status: 'arrived' } : undefined; next.pendingConfirmation = { confirmationId: `${next.taskId}:save-memory`, action: 'save-memory' } } break
    case 'charging.started': if (next.phase === 'driving-to-airport' && next.charging.status === 'planned') next.charging.status = 'active'; break
    case 'charging.completed': if (next.charging.status === 'active') next.charging.status = 'completed'; break
    case 'charging.cancelled': if (next.charging.status === 'planned' || next.charging.status === 'active') next.charging = { ...next.charging, accepted: false, status: 'none' }; break
    case 'user.cancelled-task': next.phase = 'cancelled'; break
    case 'provider.timeout': handled = true; break
    case 'message.sent': if (next.message.pendingMessageId === event.messageId) { next.message.status = 'sent'; next.message.landingNoticeSent = true; next.message.sentAt = event.timestamp; next.message.pendingMessageId = undefined } break
    case 'message.failed': if (next.message.pendingMessageId === event.messageId) { next.message.status = 'failed'; next.message.pendingMessageId = undefined } break
    default: break
  }
  const afterFacts = taskFacts(next)
  if (JSON.stringify(afterFacts) !== JSON.stringify(beforeFacts) || handled) {
    if (JSON.stringify(afterFacts) !== JSON.stringify(beforeFacts)) next.taskRevision += 1
    next.processedEventIds.push(event.eventId)
    next.updatedAt = event.timestamp
  }
  return airportPickupTaskStateSchema.parse(next)
}

export function resolveConfirmation(state: AirportPickupTaskState, confirmationId: string): AirportPickupTaskState {
  if (state.pendingConfirmation?.confirmationId !== confirmationId) return state
  return airportPickupTaskStateSchema.parse({ ...state, pendingConfirmation: undefined, taskRevision: state.taskRevision + 1 })
}
