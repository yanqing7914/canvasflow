import { describe, expect, it } from 'vitest'
import { vehicleSnapshots } from '@canvasflow/tools'
import { applyEvent, createCockpitTask } from './index'
import { isCockpitActionAllowed, requestCockpitReturn, selectCockpitFlight } from './cockpit'

const t0 = '2026-08-11T09:00:00+08:00'
const flight = {
  flightNumber: 'MU1234', airlineName: '东方航空', originName: '北京首都', status: 'in-air' as const,
  scheduledArrival: '2026-08-11T10:00:00+08:00', estimatedArrival: '2026-08-11T10:08:00+08:00',
  arrivalAirport: 'SHA' as const, arrivalAirportName: '虹桥机场', terminal: 'T2',
}
const outboundRoute = { routeId: 'route-outbound', distanceKm: 32, durationMinutes: 20, arrivalTime: '2026-08-11T09:25:00+08:00', estimatedBatteryAtArrival: 65 }
const returnRoute = { routeId: 'route-return', distanceKm: 32, durationMinutes: 40, arrivalTime: '2026-08-11T11:00:00+08:00', estimatedBatteryAtArrival: 50 }

describe('cockpit airport pickup state machine', () => {
  it('asks for airport first and lets passenger remain empty', () => {
    const next = applyEvent(createCockpitTask('cockpit-1', t0), { eventId: 'airport', type: 'pickup.airport-selected', airport: { label: '虹桥机场', code: 'SHA' }, timestamp: t0 })
    expect(next).toMatchObject({ phase: 'choosing-flight', pickupAirport: { label: '虹桥机场', code: 'SHA' }, passengers: { names: [] } })
  })

  it('selection opens confirmation but only the whitelisted action may drive', () => {
    const choosing = applyEvent(createCockpitTask('cockpit-1', t0), { eventId: 'airport', type: 'pickup.airport-selected', airport: { label: '虹桥机场', code: 'SHA' }, timestamp: t0 })
    const selected = selectCockpitFlight({ task: choosing, flight, route: outboundRoute, vehicle: vehicleSnapshots.parked, at: t0 })
    expect(selected).toMatchObject({ phase: 'confirming-outbound', flight, navigation: { status: 'planned' }, navigationSimulation: { leg: 'outbound' } })
    expect(isCockpitActionAllowed(selected, 'start-outbound')).toBe(true)
    expect(isCockpitActionAllowed(selected, 'start-return')).toBe(false)
    expect(applyEvent(selected, { eventId: 'start', type: 'navigation.started', routeId: outboundRoute.routeId, timestamp: t0 }).phase).toBe('outbound-driving')
  })

  it('guards onboard and return confirmation, then clears context at home', () => {
    const choosing = applyEvent(createCockpitTask('cockpit-1', t0), { eventId: 'airport', type: 'pickup.airport-selected', airport: { label: '虹桥机场', code: 'SHA' }, timestamp: t0 })
    const selected = selectCockpitFlight({ task: choosing, flight, route: outboundRoute, vehicle: vehicleSnapshots.parked, at: t0 })
    const driving = applyEvent(selected, { eventId: 'start', type: 'navigation.started', routeId: outboundRoute.routeId, timestamp: t0 })
    expect(applyEvent(driving, { eventId: 'early', type: 'passengers.onboard', timestamp: t0 })).toEqual(driving)
    const waiting = applyEvent(driving, { eventId: 'arrived', type: 'navigation.outbound-arrived', timestamp: t0 })
    const onboard = applyEvent(waiting, { eventId: 'onboard', type: 'passengers.onboard', timestamp: t0 })
    const confirming = requestCockpitReturn(onboard, { route: returnRoute, batteryPercent: 65, at: t0 })
    expect(isCockpitActionAllowed(confirming, 'start-return')).toBe(true)
    const returning = applyEvent(confirming, { eventId: 'return', type: 'navigation.started', routeId: returnRoute.routeId, timestamp: t0 })
    const completed = applyEvent(returning, { eventId: 'home', type: 'navigation.return-arrived', timestamp: t0 })
    expect(completed).toMatchObject({ phase: 'completed', passengers: { names: [], confirmedOnboard: false } })
    expect(completed.flight).toBeUndefined()
    expect(completed.pickupAirport).toBeUndefined()
    expect(completed.navigationSimulation).toBeUndefined()
  })
})
