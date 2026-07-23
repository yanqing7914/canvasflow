import { describe, expect, it } from 'vitest'
import { applyEvent, createInitialTask } from './index'
import { Planner, planAirportPickup } from './planner'

const timestamp = '2026-07-22T20:00:00+08:00'

describe('airport pickup Planner', () => {
  it('collects passengers and asks for a missing flight number', () => {
    const state = createInitialTask('pickup-001', timestamp)
    const before = structuredClone(state)
    const plan = planAirportPickup({ text: '去机场接妈妈和豆豆', state, eventId: 'input-1' })

    expect(plan).toMatchObject({
      intent: 'create-airport-pickup',
      confidence: 0.99,
      slotUpdates: { passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false } },
      missingSlots: ['flightNumber'],
      proposedEvents: [{ eventId: 'input-1', timestamp, type: 'user.input', text: '去机场接妈妈和豆豆' }],
    })
    expect(plan.assistantText).toContain('航班号')
    expect(state).toEqual(before)
  })

  it('normalizes an MU flight number and fills the last required slot', () => {
    const state = createInitialTask('pickup-001', timestamp)
    state.passengers = { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false }

    expect(planAirportPickup({ text: '航班是 mu 5102', state, eventId: 'input-2' })).toMatchObject({
      intent: 'provide-flight-number',
      slotUpdates: { flightNumber: 'MU5102' },
      missingSlots: [],
      proposedEvents: [{ type: 'user.input', text: '航班是 mu 5102' }],
    })
  })

  it.each(['MU 5102', 'MU-5102', 'mu 5102'])('keeps %s consistent through Planner, event, and reducer', (input) => {
    const state = {
      ...createInitialTask('pickup-001', timestamp),
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
    }
    const plan = planAirportPickup({ text: `航班是 ${input}`, state, eventId: `flight-${input}`, timestamp })
    const event = plan.proposedEvents[0]

    expect(plan.slotUpdates.flightNumber).toBe('MU5102')
    expect(event).toMatchObject({ type: 'user.input' })
    expect(applyEvent(state, event!).flight?.flightNumber).toBe('MU5102')
  })

  it.each(['MU', 'MU51', '航班是 5102'])('does not propose a flight for invalid input %s', (input) => {
    const state = createInitialTask('pickup-001', timestamp)
    const plan = planAirportPickup({ text: input, state, eventId: `invalid-${input}`, timestamp })

    expect(plan.slotUpdates.flightNumber).toBeUndefined()
    expect(plan.proposedEvents).toEqual([])
    expect(applyEvent(state, { eventId: `reducer-${input}`, type: 'user.input', text: input, timestamp }).flight).toBeUndefined()
  })

  it('proposes a navigation event without applying it', () => {
    const state = createInitialTask('pickup-001', timestamp)
    state.passengers = { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false }
    state.flight = { flightNumber: 'MU5102', status: 'scheduled', estimatedArrival: timestamp, terminal: 'T2' }

    const plan = new Planner().plan({ text: '开始导航', state, eventId: 'nav-1', routeId: 'route-airport-001' })

    expect(plan).toMatchObject({
      intent: 'start-navigation',
      slotUpdates: { navigation: { requested: true } },
      missingSlots: [],
      proposedEvents: [{ eventId: 'nav-1', timestamp, type: 'navigation.started', routeId: 'route-airport-001' }],
    })
    expect(state.navigation).toBeUndefined()
  })

  it.each(['先去充电', '先去补能'])('plans charging for %s', (text) => {
    expect(planAirportPickup({ text, eventId: 'charge-1', timestamp })).toMatchObject({
      intent: 'plan-charging',
      slotUpdates: { charging: { recommended: true, accepted: true, status: 'planned' } },
      proposedEvents: [{ type: 'user.input', text }],
    })
  })

  it.each(['已经接到她们', '家人上车'])('maps %s to the onboard domain event', (text) => {
    const state = { ...createInitialTask('pickup-001', timestamp), phase: 'waiting-for-passengers' as const }
    expect(planAirportPickup({ text, state, eventId: 'onboard-1', timestamp })).toMatchObject({
      intent: 'confirm-passengers-onboard',
      slotUpdates: { passengersOnboard: true },
      missingSlots: [],
      proposedEvents: [{ type: 'user.confirmed-passengers-onboard' }],
    })
  })

  it('does not bypass the waiting-for-passengers precondition', () => {
    const plan = planAirportPickup({ text: '已经接到她们', state: createInitialTask('pickup-001', timestamp), eventId: 'onboard-1', timestamp })

    expect(plan).toMatchObject({ intent: 'confirm-passengers-onboard', proposedEvents: [] })
    expect(plan.assistantText).toContain('停稳')
  })

  it.each(['取消接机任务', '不用接了'])('maps %s to task cancellation', (text) => {
    expect(planAirportPickup({ text, eventId: 'cancel-1', timestamp })).toMatchObject({
      intent: 'cancel-task',
      slotUpdates: { cancelled: true },
      missingSlots: [],
      proposedEvents: [{ type: 'user.cancelled-task', reason: text }],
    })
  })

  it('returns the same fallback metadata and event for identical inputs', () => {
    const first = new Planner().plan('开始导航')
    const second = new Planner().plan('开始导航')

    expect(second).toEqual(first)
  })

  it('does not invent an event for unsupported language', () => {
    expect(planAirportPickup({ text: '今天天气怎么样', timestamp })).toMatchObject({
      intent: 'unknown',
      confidence: 0.2,
      slotUpdates: {},
      proposedEvents: [],
    })
  })
})
