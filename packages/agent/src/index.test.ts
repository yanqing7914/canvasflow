import { describe, expect, it } from 'vitest'
import { applyEvent, createInitialTask, planEffects, resolveConfirmation } from './index'

describe('airport pickup task engine', () => {
  it('ignores duplicate events and advances through the demo phases', () => {
    let state = createInitialTask()
    state = { ...state, passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false } }
    const flightInput = { eventId: 'flight-number', type: 'user.input' as const, text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' }
    state = applyEvent(state, flightInput)
    expect(state.phase).toBe('preparing')
    expect(applyEvent(state, flightInput)).toEqual(state)
    state = applyEvent(state, { eventId: 'start', type: 'navigation.started', routeId: 'route-001', timestamp: '2026-07-22T12:02:00+08:00' })
    expect(state.phase).toBe('driving-to-airport')
  })

  it('does not mutate terminal tasks when late events arrive', () => {
    const completed = { ...createInitialTask(), phase: 'completed' as const, taskRevision: 4 }
    const lateEvent = { eventId: 'late-cancel', type: 'user.cancelled-task' as const, timestamp: '2026-07-22T12:10:00+08:00' }
    expect(applyEvent(completed, lateEvent)).toEqual(completed)
  })

  it('does not plan duplicate external effects', () => {
    const state = { ...createInitialTask(), processedEventIds: ['landed'] }
    const event = { eventId: 'landed', type: 'flight.updated' as const, flight: { flightNumber: 'MU5102', status: 'landed' as const, estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' }
    expect(planEffects(state, event, {})).toEqual([])
  })

  it('schedules a landing notification only once across provider updates', () => {
    const first = { eventId: 'landed-1', type: 'flight.updated' as const, flight: { flightNumber: 'MU5102', status: 'landed' as const, estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' }
    const second = { ...first, eventId: 'landed-2', timestamp: '2026-07-22T20:41:00+08:00' }
    const state = { ...createInitialTask(), phase: 'driving-to-airport' as const }
    expect(planEffects(state, first, {})).toHaveLength(1)
    const scheduled = applyEvent(state, first)
    expect(planEffects(scheduled, second, {})).toEqual([])
    expect(scheduled.message.idempotencyKey).toBe('pickup-001:MU5102:landing')
  })

  it('does not plan effects for out-of-order events', () => {
    const state = createInitialTask()
    expect(planEffects(state, { eventId: 'nav', type: 'navigation.started', routeId: 'route', timestamp: state.updatedAt }, {})).toEqual([])
    expect(planEffects(state, { eventId: 'onboard', type: 'user.confirmed-passengers-onboard', timestamp: state.updatedAt }, {})).toEqual([])
    expect(planEffects(state, { eventId: 'arrived', type: 'destination.arrived', destination: '家', timestamp: state.updatedAt }, {})).toEqual([])
  })

  it('does not reapply cabin preferences for repeated passenger confirmation', () => {
    const state = { ...createInitialTask(), phase: 'returning-home' as const, passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true } }
    const repeated = { eventId: 'onboard-again', type: 'user.confirmed-passengers-onboard' as const, timestamp: state.updatedAt }
    expect(planEffects(state, repeated, { 'memory.get-preferences': {} })).toEqual([])
    expect(applyEvent(state, repeated).taskRevision).toBe(state.taskRevision)
  })

  it('allows an out-of-order event to be replayed after its precondition is met', () => {
    const event = { eventId: 'nav-later', type: 'navigation.started' as const, routeId: 'route', timestamp: '2026-07-22T12:30:00+08:00' }
    const initial = createInitialTask()
    const ignored = applyEvent(initial, event)
    expect(ignored.processedEventIds).not.toContain(event.eventId)
    const preparing = { ...ignored, phase: 'preparing' as const }
    expect(applyEvent(preparing, event).phase).toBe('driving-to-airport')
  })

  it('records message send outcomes and confirmation resolution', () => {
    const scheduled = { ...createInitialTask(), message: { ...createInitialTask().message, status: 'scheduled' as const, pendingMessageId: 'MU5102:landing' } }
    const sent = applyEvent(scheduled, { eventId: 'sent', type: 'message.sent', messageId: 'MU5102:landing', timestamp: '2026-07-22T20:41:00+08:00' })
    expect(sent.message).toMatchObject({ status: 'sent', landingNoticeSent: true })
    const completed = { ...sent, phase: 'completed' as const, pendingConfirmation: { confirmationId: 'pickup-001:save-memory', action: 'save-memory' as const } }
    expect(resolveConfirmation(completed, 'pickup-001:save-memory').pendingConfirmation).toBeUndefined()
  })
})
