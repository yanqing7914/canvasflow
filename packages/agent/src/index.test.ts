import { describe, expect, it } from 'vitest'
import { applyEvent, createInitialTask } from './index'

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
})
