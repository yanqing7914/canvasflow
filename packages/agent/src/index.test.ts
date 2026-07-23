import { describe, expect, it } from 'vitest'
import { applyEvent, createInitialTask, planEffects } from './index'

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
    const state = createInitialTask()
    expect(planEffects(state, first, {})).toHaveLength(1)
    const scheduled = applyEvent(state, first)
    expect(planEffects(scheduled, second, {})).toEqual([])
    expect(scheduled.message.idempotencyKey).toBe('pickup-001:MU5102:landing')
  })
})
