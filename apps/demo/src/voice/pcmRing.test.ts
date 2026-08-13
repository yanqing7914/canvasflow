import { PcmRing } from './pcmRing'

describe('PcmRing', () => {
  it('defaults to 1.5 seconds of 16 kHz PCM', () => {
    const ring = new PcmRing()

    expect(ring.sampleRate).toBe(16_000)
    expect(ring.capacity).toBe(24_000)
    expect(ring.length).toBe(0)
  })

  it('keeps samples in chronological order across a wrap', () => {
    const ring = new PcmRing(4, 1)
    ring.append(Float32Array.of(1, 2, 3))
    ring.append(Float32Array.of(4, 5))

    expect([...ring.readLatest()]).toEqual([2, 3, 4, 5])
    expect([...ring.readLatest(2)]).toEqual([4, 5])
    expect(ring.durationSeconds).toBe(1)
  })

  it('keeps only the tail when one append exceeds capacity', () => {
    const ring = new PcmRing(3, 1)
    ring.append(Float32Array.of(1, 2, 3, 4, 5))

    expect([...ring.readLatest()]).toEqual([3, 4, 5])
  })

  it('returns copies and clears retained audio', () => {
    const ring = new PcmRing(4, 1)
    ring.append(Float32Array.of(1, 2))
    const copy = ring.readLatest()
    copy[0] = 99

    expect([...ring.readLatest()]).toEqual([1, 2])
    ring.clear()
    expect(ring.length).toBe(0)
    expect([...ring.readLatest()]).toEqual([])
  })

  it('rejects invalid dimensions', () => {
    expect(() => new PcmRing(0, 1)).toThrow(RangeError)
    expect(() => new PcmRing(16_000, 0)).toThrow(RangeError)
  })
})
