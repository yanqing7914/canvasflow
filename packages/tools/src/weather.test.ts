import { describe, expect, it } from 'vitest'
import { TIMEOUT_WEATHER_LOCATION_ID } from './data'
import type { ToolContext } from './result'
import { getWeather } from './weather'

const ctx: ToolContext = { taskId: 'pickup-001' }

describe('weather.get-current', () => {
  it('returns the deterministic snapshot for a known location', () => {
    const result = getWeather(ctx, { locationId: 'destination-hongqiao-t2' })

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({
      locationId: 'destination-hongqiao-t2',
      locationName: '虹桥机场 T2',
      temperatureC: 24,
      condition: 'light-rain',
    })
  })

  it('answers the same reading whether or not a forecast moment is supplied', () => {
    const now = getWeather(ctx, { locationId: 'destination-home' })
    const later = getWeather(ctx, { locationId: 'destination-home', at: '2026-07-22T20:40:00+08:00' })

    expect(now.ok).toBe(true)
    expect(later.ok).toBe(true)
    expect(later.data).toEqual(now.data)
  })

  it('rejects an unknown location without retry', () => {
    const result = getWeather(ctx, { locationId: 'destination-atlantis' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code: 'LOCATION_NOT_FOUND', retryable: false })
  })

  it('simulates a retryable provider timeout for the sentinel location', () => {
    const result = getWeather(ctx, { locationId: TIMEOUT_WEATHER_LOCATION_ID })

    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
  })

  it('rejects a request without a locationId', () => {
    const result = getWeather(ctx, {})

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })
})
