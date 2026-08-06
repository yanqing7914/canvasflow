import { describe, expect, it } from 'vitest'
import { ARRIVAL_CITY, arrivalBoard, flights } from './data'
import { getFlightStatus, listFlightArrivals } from './flight'
import type { ToolContext } from './result'

const ctx: ToolContext = { taskId: 'pickup-001' }
const DEMO_DATE = '2026-07-22'

describe('flight.list-arrivals', () => {
  it('lists the authored board for the demo city and date', () => {
    const result = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE })

    expect(result.ok).toBe(true)
    expect(result.data?.arrivalCityName).toBe('上海')
    expect(result.data?.arrivals.map((arrival) => arrival.flightNumber))
      .toEqual(arrivalBoard.map((row) => row.flightNumber))
  })

  it('offers more than one airline so the rows are told apart by more than a time', () => {
    const result = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE })
    const arrivals = result.data?.arrivals ?? []

    expect(arrivals.length).toBeGreaterThanOrEqual(5)
    expect(new Set(arrivals.map((arrival) => arrival.airlineName)).size).toBeGreaterThan(1)
    expect(new Set(arrivals.map((arrival) => arrival.originName)).size).toBe(arrivals.length)
  })

  it('quotes each row exactly as the status lookup behind it would', () => {
    const arrivals = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE }).data?.arrivals ?? []

    for (const arrival of arrivals) {
      const status = getFlightStatus(ctx, { flightNumber: arrival.flightNumber, date: DEMO_DATE })
      expect(status.ok, `${arrival.flightNumber} must be preparable`).toBe(true)
      expect(status.data).toMatchObject({
        status: arrival.status,
        scheduledArrival: arrival.scheduledArrival,
        estimatedArrival: arrival.estimatedArrival,
        terminal: arrival.terminal,
      })
    }
  })

  it('presents the rows earliest scheduled arrival first', () => {
    const arrivals = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE }).data?.arrivals ?? []
    const times = arrivals.map((arrival) => Date.parse(arrival.scheduledArrival))

    expect(times).toEqual([...times].sort((left, right) => left - right))
  })

  it('caps the board at the caller’s limit', () => {
    const result = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE, limit: 3 })

    expect(result.data?.arrivals).toHaveLength(3)
  })

  it('answers a date with nothing scheduled with an empty board rather than an error', () => {
    const result = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: '2026-07-23' })

    expect(result.ok).toBe(true)
    expect(result.data?.arrivals).toEqual([])
  })

  it('rejects a city the fixtures do not cover, without retry', () => {
    const result = listFlightArrivals(ctx, { arrivalCityId: 'arrival-city-atlantis', date: DEMO_DATE })

    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code: 'CITY_NOT_FOUND', retryable: false })
  })

  it('rejects a request missing the city or the date', () => {
    expect(listFlightArrivals(ctx, { date: DEMO_DATE }).error?.code).toBe('INVALID_ARGUMENT')
    expect(listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id }).error?.code).toBe('INVALID_ARGUMENT')
  })

  it('leaves the cancelled exception fixture off the board', () => {
    const arrivals = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE }).data?.arrivals ?? []

    expect(flights.MU5104?.status).toBe('cancelled')
    expect(arrivals.some((arrival) => arrival.flightNumber === 'MU5104')).toBe(false)
  })
})
