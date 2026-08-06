import { describe, expect, it } from 'vitest'
import { normalizeFlightNumber } from './flight-number'

describe('normalizeFlightNumber', () => {
  it('reads every carrier the arrivals board offers', () => {
    expect(normalizeFlightNumber('航班号 MU5102')).toBe('MU5102')
    expect(normalizeFlightNumber('航班号 CA1516')).toBe('CA1516')
    expect(normalizeFlightNumber('航班号 CZ3588')).toBe('CZ3588')
    expect(normalizeFlightNumber('航班号 HO1252')).toBe('HO1252')
    expect(normalizeFlightNumber('航班号 FM9101')).toBe('FM9101')
  })

  it('canonicalizes lower case and the ways a prefix gets separated', () => {
    expect(normalizeFlightNumber('ca 1516')).toBe('CA1516')
    expect(normalizeFlightNumber('cz-3588')).toBe('CZ3588')
    expect(normalizeFlightNumber('ho - 1252')).toBe('HO1252')
  })

  it('ignores a carrier code that is part of a longer token', () => {
    expect(normalizeFlightNumber('XCA1516')).toBeUndefined()
    expect(normalizeFlightNumber('CA15169')).toBeUndefined()
  })

  it('does not treat an unlisted airline as a flight number', () => {
    expect(normalizeFlightNumber('航班号 AB1234')).toBeUndefined()
    expect(normalizeFlightNumber('航班号 3U8888')).toBeUndefined()
  })

  it('finds nothing in an utterance that carries no flight number', () => {
    expect(normalizeFlightNumber('我现在要去机场接妈妈和豆豆')).toBeUndefined()
    expect(normalizeFlightNumber('电话是 13800001234')).toBeUndefined()
  })
})
