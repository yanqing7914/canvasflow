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

  it('does not schedule landing notifications before driving', () => {
    const event = { eventId: 'early-landed', type: 'flight.updated' as const, flight: { flightNumber: 'MU5102', status: 'landed' as const, estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:00:00+08:00' }
    const next = applyEvent(createInitialTask(), event)
    expect(next.message.status).toBe('idle')
    expect(planEffects(createInitialTask(), event, {})).toEqual([])
  })

  it('rejects stale provider updates delivered after newer state', () => {
    const driving = { ...createInitialTask(), phase: 'driving-to-airport' as const, updatedAt: '2026-07-22T20:30:00+08:00' }
    const landed = applyEvent(driving, { eventId: 'landed-new', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' })
    const stale = applyEvent(landed, { eventId: 'in-air-old', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'in-air', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:35:00+08:00' })
    expect(stale).toEqual(landed)
  })

  it('does not plan effects for stale events', () => {
    const state = { ...createInitialTask(), phase: 'driving-to-airport' as const, updatedAt: '2026-07-22T20:40:00+08:00', flight: { flightNumber: 'MU5102', status: 'landed' as const, estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' } }
    const stale = { eventId: 'stale-landed', type: 'flight.updated' as const, flight: { flightNumber: 'MU5102', status: 'landed' as const, estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:35:00+08:00' }
    expect(planEffects(state, stale, {})).toEqual([])
  })

  it('clears pending confirmations on cancellation', () => {
    const state = { ...createInitialTask(), phase: 'returning-home' as const, pendingConfirmation: { confirmationId: 'confirm', action: 'save-memory' as const } }
    const cancelled = applyEvent(state, { eventId: 'cancel', type: 'user.cancelled-task', timestamp: '2026-07-22T12:10:00+08:00' })
    expect(cancelled.pendingConfirmation).toBeUndefined()
  })

  it('does not advance the ordering watermark for irrelevant input', () => {
    const state = createInitialTask()
    const ignored = applyEvent(state, { eventId: 'small-talk', type: 'user.input', text: '今天天气不错', timestamp: '2026-07-22T12:30:00+08:00' })
    expect(ignored).toEqual(state)
  })

  it('rejects conflicting provider updates at the same timestamp', () => {
    const state = { ...createInitialTask(), phase: 'driving-to-airport' as const, updatedAt: '2026-07-22T20:40:00+08:00', flight: { flightNumber: 'MU5102', status: 'landed' as const, estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' } }
    const event = { eventId: 'same-time', type: 'flight.updated' as const, flight: { flightNumber: 'MU5102', status: 'in-air' as const, estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: state.updatedAt }
    expect(applyEvent(state, event)).toEqual(state)
  })

  it('records charging acceptance when charging.started fires', () => {
    const driving = {
      ...createInitialTask(),
      phase: 'driving-to-airport' as const,
      charging: { recommended: true, accepted: false, status: 'planned' as const },
      updatedAt: '2026-07-22T20:05:00+08:00',
    }
    const started = applyEvent(driving, {
      eventId: 'charge-start',
      type: 'charging.started',
      stationId: 'station-hongqiao-01',
      timestamp: '2026-07-22T20:06:00+08:00',
    })
    expect(started.charging).toMatchObject({ recommended: true, accepted: true, status: 'active' })
    const completed = applyEvent(started, {
      eventId: 'charge-done',
      type: 'charging.completed',
      batteryPercent: 78,
      timestamp: '2026-07-22T20:18:00+08:00',
    })
    expect(completed.charging).toMatchObject({ accepted: true, status: 'completed' })
  })

  it('plans cabin apply for media-only preferences without temperature', () => {
    const state = {
      ...createInitialTask(),
      phase: 'returning-home' as const,
      passengers: { memberIds: ['doubao'], names: ['豆豆'], confirmedOnboard: true },
      updatedAt: '2026-07-22T20:55:00+08:00',
    }
    const event = {
      eventId: 'apply-media',
      type: 'user.input' as const,
      text: '播放豆豆的媒体偏好',
      timestamp: '2026-07-22T20:56:00+08:00',
    }
    const toolResults = {
      'memory.get-preferences': {
        ok: true,
        data: { members: [{ memberId: 'doubao', mediaTitle: '豆豆故事' }] },
        error: null,
      },
    }
    expect(planEffects(state, event, toolResults)).toEqual([
      { type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' },
    ])
  })

  it('plans cabin apply from memory.get-preferences members shape', () => {
    const state = {
      ...createInitialTask(),
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: true },
      updatedAt: '2026-07-22T20:55:00+08:00',
    }
    const event = {
      eventId: 'apply-cabin',
      type: 'user.input' as const,
      text: '应用家庭座舱偏好',
      timestamp: '2026-07-22T20:56:00+08:00',
    }
    const toolResults = {
      'memory.get-preferences': {
        ok: true,
        data: {
          members: [
            { memberId: 'mom', rearTemperatureC: 25 },
            { memberId: 'doubao', mediaTitle: '豆豆故事' },
          ],
        },
        error: null,
      },
    }
    expect(planEffects(state, event, toolResults)).toEqual([
      { type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' },
    ])
    expect(planEffects(state, event, {
      'memory.get-preferences': { ok: true, data: { temperatureC: 25 }, error: null },
    })).toEqual([])
  })
})
