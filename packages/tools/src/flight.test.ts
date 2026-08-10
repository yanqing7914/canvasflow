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
        arrivalAirport: arrival.arrivalAirport,
        arrivalAirportName: arrival.arrivalAirportName,
        terminal: arrival.terminal,
      })
    }
  })

  it('offers both Shanghai airports on one board', () => {
    const arrivals = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE }).data?.arrivals ?? []
    const airports = arrivals.map((arrival) => arrival.arrivalAirport)

    // One city, two airports: the choice has to be a difference between rows, or
    // "去浦东的那个" would be a question about the wrong axis.
    expect(new Set(airports)).toEqual(new Set(['SHA', 'PVG']))
    expect(arrivals.every((arrival) => arrival.arrivalAirportName.length > 0)).toBe(true)
  })

  it('names the airport on every row, because a terminal alone no longer places one', () => {
    const arrivals = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE }).data?.arrivals ?? []
    const duplicatedTerminals = arrivals.filter((arrival) => arrival.terminal === 'T2')

    // Several rows read "T2" and they are not the same place. What tells them
    // apart is the airport, which is why it cannot be optional on a row.
    expect(duplicatedTerminals.length).toBeGreaterThan(1)
    expect(new Set(duplicatedTerminals.map((arrival) => arrival.arrivalAirport)).size).toBeGreaterThan(1)
  })

  it('identifies the exact set it returned, reproducibly', () => {
    const first = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE })
    const again = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE })

    expect(first.data?.candidateSetId).toBeTruthy()
    // Same input, same id — otherwise a fixture replay could never assert which
    // set a spoken ordinal was resolved against.
    expect(again.data?.candidateSetId).toBe(first.data?.candidateSetId)
    expect(first.data?.expiresAt).toBe(again.data?.expiresAt)
  })

  it('gives a differently-shaped board a different identity', () => {
    const full = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE })
    const capped = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE, limit: 3 })
    const otherDay = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: '2026-07-23' })

    // "第三个" means something different against three rows than against five, so
    // the two must not share an id.
    expect(capped.data?.candidateSetId).not.toBe(full.data?.candidateSetId)
    expect(otherDay.data?.candidateSetId).not.toBe(full.data?.candidateSetId)
  })

  it('expires the board with the day it answers for', () => {
    const result = listFlightArrivals(ctx, { arrivalCityId: ARRIVAL_CITY.id, date: DEMO_DATE })

    expect(result.data?.expiresAt.startsWith(DEMO_DATE)).toBe(true)
    // Every arrival it lists still falls inside its own validity window.
    for (const arrival of result.data?.arrivals ?? []) {
      expect(Date.parse(arrival.estimatedArrival)).toBeLessThan(Date.parse(result.data!.expiresAt))
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
