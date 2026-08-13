import { resampleMono, StreamingMonoResampler } from './pcmResampler'

describe('PCM resampling', () => {
  it('copies a stream already at the target rate', () => {
    const source = Float32Array.of(-1, 0, 1)
    const result = resampleMono(source, 16_000)

    expect([...result]).toEqual([...source])
    expect(result).not.toBe(source)
  })

  it('linearly interpolates a downsampled ramp', () => {
    const result = resampleMono(Float32Array.of(0, 1, 2, 3), 4, 2)

    expect([...result]).toEqual([0, 2])
  })

  it('retains a bounded output for an empty packet and validates rates', () => {
    expect(resampleMono(new Float32Array(), 48_000)).toHaveLength(0)
    expect(() => resampleMono(Float32Array.of(1), 0)).toThrow(RangeError)
    expect(() => resampleMono(Float32Array.of(1), 48_000, 0)).toThrow(RangeError)
  })

  it('keeps phase across packet boundaries', () => {
    const stream = new StreamingMonoResampler(4, 2)
    const first = stream.push(Float32Array.of(0, 1, 2))
    const second = stream.push(Float32Array.of(3, 4))
    const final = stream.flush()

    expect([...first, ...second, ...final]).toEqual([0, 2])
  })

  it('matches one-shot output when a 48 kHz stream is split into packets', () => {
    const source = Float32Array.from({ length: 960 }, (_, index) => Math.sin(index / 17))
    const expected = resampleMono(source, 48_000, 16_000)
    const stream = new StreamingMonoResampler(48_000, 16_000)
    const output: number[] = []
    for (let offset = 0; offset < source.length; offset += 128) {
      output.push(...stream.push(source.slice(offset, offset + 128)))
    }
    output.push(...stream.flush())

    expect(output).toHaveLength(expected.length)
    expect(output).toEqual(Array.from(expected, (value) => expect.closeTo(value, 5)))
  })
})
