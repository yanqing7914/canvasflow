import {
  airportPickupEventSchema,
  airportPickupTaskStateSchema,
  type AirportPickupEvent,
  type AirportPickupTaskState,
} from '@canvasflow/schema'
import { memberPreferences, resolveAuthorizedLandingContact, type MemberPreferenceRecord } from '@canvasflow/tools'
import { normalizeFlightNumber } from './flight-number'
import { mergePassengers, parsePassengers } from './passengers'

export * from './effects'
export * from './effect-executor'
export * from './flight-number'
export * from './passengers'
export * from './composer'
export * from './cockpit'
export * from './landing-message-retry'
export * from './lark-calendar-adapter'
export * from './model-gateway'
export * from './openai-compatible-model-adapter'
export * from './gateway'
export * from './orchestration'
export * from './planner'
export * from './store'

export type ApplyEventOptions = {
  /** Gateway-provided Planner output; presence makes these slots authoritative for user.input. */
  userInputSlots?: {
    passengers?: AirportPickupTaskState['passengers']
    flightNumber?: string
  }
}

export function createCockpitTask(taskId = 'pickup-001', updatedAt = new Date().toISOString()): AirportPickupTaskState {
  return airportPickupTaskStateSchema.parse({
    taskId, surfaceId: 'airport-pickup-main', taskRevision: 0, uiRevision: 0, phase: 'collecting-airport',
    passengers: { memberIds: [], names: [], confirmedOnboard: false },
    cockpit: { speedMode: 'normal', hudVisible: true },
    charging: { recommended: false, accepted: false, status: 'none' },
    message: { autoNotifyAuthorized: false, status: 'idle', landingNoticeSent: false },
    processedEventIds: [], updatedAt,
  })
}

export function createInitialTask(taskId = 'pickup-001', updatedAt = '2026-07-22T12:00:00+08:00'): AirportPickupTaskState {
  return airportPickupTaskStateSchema.parse({
    taskId, surfaceId: 'airport-pickup-main', taskRevision: 0, uiRevision: 0, phase: 'collecting-information',
    passengers: { memberIds: [], names: [], confirmedOnboard: false }, charging: { recommended: false, accepted: false, status: 'none' },
    message: { autoNotifyAuthorized: true, status: 'idle', landingNoticeSent: false }, processedEventIds: [],
    updatedAt,
  })
}

function taskFacts(state: AirportPickupTaskState) {
  return {
    ...state,
    updatedAt: '',
    processedEventIds: [],
  }
}

export function applyEvent(
  state: AirportPickupTaskState,
  input: AirportPickupEvent,
  preferences: Record<string, MemberPreferenceRecord> = memberPreferences,
  options: ApplyEventOptions = {},
): AirportPickupTaskState {
  const event = airportPickupEventSchema.parse(input)
  if (state.processedEventIds.includes(event.eventId)) return state
  if (state.phase === 'completed' || state.phase === 'cancelled') return state
  if (Date.parse(event.timestamp) < Date.parse(state.updatedAt)) return state
  if (event.type === 'flight.updated' && Date.parse(event.timestamp) === Date.parse(state.updatedAt) && state.flight) return state
  const next = structuredClone(state)
  const beforeFacts = taskFacts(state)
  let handled = false

  switch (event.type) {
    case 'pickup.airport-selected':
      if (next.phase === 'collecting-airport') {
        next.pickupAirport = event.airport
        next.phase = 'choosing-flight'
      }
      break
    case 'navigation.outbound-arrived':
      if (next.phase === 'outbound-driving') {
        next.phase = 'waiting-for-passengers'
        if (next.navigation) next.navigation.status = 'arrived'
      }
      break
    case 'passengers.onboard':
      if (next.phase === 'waiting-for-passengers') {
        next.passengers.confirmedOnboard = true
        next.phase = 'passengers-onboard'
      }
      break
    case 'navigation.return-arrived':
      if (next.phase === 'return-driving') {
        next.phase = 'completed'
        next.flight = undefined
        next.flightDiscovery = undefined
        next.pickupAirport = undefined
        next.navigation = undefined
        next.navigationSimulation = undefined
        next.cockpit = undefined
        next.returnTrip = undefined
        next.passengers = { memberIds: [], names: [], confirmedOnboard: false }
      }
      break
    case 'user.input':
      {
        const flightNumber = options.userInputSlots
          ? options.userInputSlots.flightNumber
          : normalizeFlightNumber(event.text)
        const passengers = options.userInputSlots
          ? options.userInputSlots.passengers
          : parsePassengers(event.text)
        handled = flightNumber !== undefined || passengers !== undefined || /机场|接妈妈|接爸爸|接豆豆|补能|充电|座舱|偏好|温度|媒体/.test(event.text)
        // Gateway resolves passengers during task creation; the reducer only
        // fills a passenger slot when this event can complete an existing trip.
        if (passengers && (flightNumber !== undefined || next.flight !== undefined || next.passengers.memberIds.length > 0)) {
          next.passengers = mergePassengers(next.passengers, passengers)
        }
        if (flightNumber) next.flight = { flightNumber, trusted: false, status: 'scheduled', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }
      }
      if (/补能|充电/.test(event.text)) {
        const accepted = /先去(?:充电|补能)/.test(event.text)
        next.charging = { ...next.charging, recommended: true, accepted: next.charging.accepted || accepted, status: 'planned' }
      }
      if (next.flight && next.passengers.names.length > 0 && next.phase === 'collecting-information') next.phase = 'preparing'
      break
    case 'flight.updated':
      // A provider push carries the flight's own facts and replaces them wholesale
      // — except the airport, which a status update has no reason to restate. If a
      // push that omits it were allowed to blank it, a 浦东 pickup would lose its
      // destination on a routine delay notice, so a known airport is carried
      // forward and only an explicitly stated one overrides it.
      next.flight = event.flight.arrivalAirport === undefined && next.flight?.arrivalAirport !== undefined
        ? { ...event.flight, arrivalAirport: next.flight.arrivalAirport }
        : event.flight
      if (
        next.phase === 'driving-to-airport'
        && event.flight.status === 'landed'
        && next.message.autoNotifyAuthorized
        && !next.message.landingNoticeSent
        // A sent umbrella reminder must not block the landing notice — only a
        // message still in flight (scheduled/failed with pending state) does.
        && (next.message.status === 'idle' || next.message.status === 'sent')
        && !next.message.pendingMessageId
      ) {
        // Never enter scheduled without a currently authorized recipient — otherwise
        // planEffects/UI can trap the task in a high-priority notify state with no recovery.
        const contactId = resolveAuthorizedLandingContact(next.passengers.memberIds, preferences)
        if (contactId) {
          next.message.status = 'scheduled'
          next.message.pendingMessageId = `${event.flight.flightNumber}:landing`
          next.message.idempotencyKey = `${next.taskId}:${event.flight.flightNumber}:landing`
          next.message.pendingContactId = contactId
        }
      }
      break
    case 'navigation.started':
      if (next.phase === 'confirming-outbound') {
        next.phase = 'outbound-driving'
        next.navigation = next.navigation ? { ...next.navigation, routeId: event.routeId, status: 'active' } : undefined
      } else if (next.phase === 'confirming-return') {
        next.phase = 'return-driving'
        next.navigation = next.navigation ? { ...next.navigation, routeId: event.routeId, status: 'active' } : undefined
      } else if (next.phase === 'preparing') {
        next.phase = 'driving-to-airport'
        next.navigation = {
          routeId: event.routeId,
          destination: next.navigation?.destination ?? '虹桥机场 T2',
          eta: next.navigation?.eta ?? '2026-07-22T20:25:00+08:00',
          status: 'active',
        }
        // A reminder to leave is spent the moment the car does. Left standing it
        // would be state that contradicts the trip it belongs to.
        delete next.departureReminder
      }
      break
    case 'vehicle.moving': break
    case 'vehicle.entered-airport-geofence': if (next.phase === 'driving-to-airport') next.phase = 'approaching-airport'; break
    case 'vehicle.parked': if (next.phase === 'approaching-airport') next.phase = 'waiting-for-passengers'; break
    case 'user.confirmed-passengers-onboard': if (next.phase === 'waiting-for-passengers') { next.passengers.confirmedOnboard = true; next.phase = 'returning-home' } break
    case 'destination.arrived': if (next.phase === 'returning-home') { next.phase = 'completed'; next.navigation = next.navigation ? { ...next.navigation, destination: event.destination, status: 'arrived' } : undefined; next.pendingConfirmation = { confirmationId: `${next.taskId}:save-memory`, action: 'save-memory' } } break
    case 'charging.started':
      if (next.phase === 'driving-to-airport' && next.charging.status === 'planned') {
        // Starting charging records that the user accepted the recommended plan.
        next.charging = { ...next.charging, accepted: true, status: 'active' }
      }
      break
    case 'charging.completed': if (next.charging.status === 'active') next.charging.status = 'completed'; break
    case 'charging.cancelled': if (next.charging.status === 'planned' || next.charging.status === 'active') next.charging = { ...next.charging, accepted: false, status: 'none' }; break
    case 'user.cancelled-task':
      next.phase = 'cancelled'
      next.pendingConfirmation = undefined
      next.message.pendingMessageId = undefined
      next.message.pendingText = undefined
      next.message.authorizationId = undefined
      if (next.message.status === 'scheduled') next.message.status = 'cancelled'
      break
    case 'provider.timeout': handled = true; break
    case 'message.sent':
      if (next.message.pendingMessageId === event.messageId) {
        next.message.status = 'sent'
        // Only the landing notice claims the landing bookkeeping: an umbrella
        // reminder sent en route must not block the real landing notify later.
        if (event.messageId.endsWith(':landing')) next.message.landingNoticeSent = true
        next.message.sentAt = event.timestamp
        next.message.pendingMessageId = undefined
        next.message.pendingText = undefined
        next.message.pendingContactId = undefined
        next.message.authorizationId = undefined
      }
      break
    case 'message.failed':
      if (next.message.pendingMessageId === event.messageId) {
        next.message.status = 'failed'
        next.message.pendingMessageId = undefined
        next.message.pendingText = undefined
        next.message.authorizationId = undefined
        // Keep pendingContactId so explicit retry targets the original recipient.
      }
      break
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
