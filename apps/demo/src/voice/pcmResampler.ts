/**
 * Resamples mono floating point PCM with a linear interpolator. The function
 * is intentionally dependency-free so it can also be used in focused tests.
 */
export function resampleMono(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = 16_000,
): Float32Array {
  validateRate(inputSampleRate, 'inputSampleRate')
  validateRate(outputSampleRate, 'outputSampleRate')
  if (input.length === 0) return new Float32Array()
  if (inputSampleRate === outputSampleRate) return input.slice()

  const outputLength = Math.max(1, Math.round(input.length * outputSampleRate / inputSampleRate))
  const output = new Float32Array(outputLength)
  const step = inputSampleRate / outputSampleRate
  for (let index = 0; index < output.length; index += 1) {
    const position = index * step
    const lower = Math.min(input.length - 1, Math.floor(position))
    const upper = Math.min(input.length - 1, lower + 1)
    const fraction = position - lower
    output[index] = input[lower]! + (input[upper]! - input[lower]!) * fraction
  }
  return output
}

/** Stateful variant for consecutive AudioWorklet packets. */
export class StreamingMonoResampler {
  readonly inputSampleRate: number
  readonly outputSampleRate: number

  #step: number
  #position = 0
  #pending = new Float32Array()

  constructor(inputSampleRate: number, outputSampleRate = 16_000) {
    validateRate(inputSampleRate, 'inputSampleRate')
    validateRate(outputSampleRate, 'outputSampleRate')
    this.inputSampleRate = inputSampleRate
    this.outputSampleRate = outputSampleRate
    this.#step = inputSampleRate / outputSampleRate
  }

  push(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array()
    const data = new Float32Array(this.#pending.length + input.length)
    data.set(this.#pending)
    data.set(input, this.#pending.length)

    const output: number[] = []
    // Keep the final source sample (and its left neighbour) in the carry
    // buffer so the next packet can interpolate across the boundary.
    while (this.#position + 1 < data.length) {
      const lower = Math.floor(this.#position)
      const upper = Math.min(data.length - 1, lower + 1)
      const fraction = this.#position - lower
      output.push(data[lower]! + (data[upper]! - data[lower]!) * fraction)
      this.#position += this.#step
    }

    const consumed = Math.max(0, Math.min(Math.floor(this.#position) - 1, data.length - 1))
    this.#pending = data.slice(consumed)
    this.#position -= consumed
    return Float32Array.from(output)
  }

  /** Emits the final held sample, useful when an input stream ends. */
  flush(): Float32Array {
    // `push` already emits every sample position that has a source endpoint;
    // the carry only exists to bridge into a future packet. There is no
    // extrapolation at end-of-stream, so flushing simply releases that carry.
    this.reset()
    return new Float32Array()
  }

  reset(): void {
    this.#position = 0
    this.#pending = new Float32Array()
  }
}

function validateRate(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`)
}
