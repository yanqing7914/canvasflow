const DEFAULT_SAMPLE_RATE = 16_000
const DEFAULT_SECONDS = 1.5

/** Fixed-size chronological PCM history used as wake-word pre-roll. */
export class PcmRing {
  readonly sampleRate: number
  readonly capacity: number

  #buffer: Float32Array
  #length = 0
  #writeIndex = 0

  constructor(sampleRate = DEFAULT_SAMPLE_RATE, seconds = DEFAULT_SECONDS) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('sampleRate must be a positive finite number')
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new RangeError('seconds must be a positive finite number')
    }

    this.sampleRate = sampleRate
    this.capacity = Math.max(1, Math.round(sampleRate * seconds))
    this.#buffer = new Float32Array(this.capacity)
  }

  get length(): number {
    return this.#length
  }

  get durationSeconds(): number {
    return this.#length / this.sampleRate
  }

  append(input: Float32Array): void {
    if (input.length === 0) return

    if (input.length >= this.capacity) {
      this.#buffer.set(input.subarray(input.length - this.capacity))
      this.#length = this.capacity
      this.#writeIndex = 0
      return
    }

    const firstLength = Math.min(input.length, this.capacity - this.#writeIndex)
    this.#buffer.set(input.subarray(0, firstLength), this.#writeIndex)
    if (firstLength < input.length) {
      this.#buffer.set(input.subarray(firstLength), 0)
    }

    this.#writeIndex = (this.#writeIndex + input.length) % this.capacity
    this.#length = Math.min(this.capacity, this.#length + input.length)
  }

  /** Returns a copy ordered from oldest to newest. */
  readLatest(sampleCount = this.#length): Float32Array {
    const length = Math.min(this.#length, Math.max(0, Math.floor(sampleCount)))
    const output = new Float32Array(length)
    if (length === 0) return output

    const start = (this.#writeIndex - length + this.capacity) % this.capacity
    const firstLength = Math.min(length, this.capacity - start)
    output.set(this.#buffer.subarray(start, start + firstLength))
    if (firstLength < length) {
      output.set(this.#buffer.subarray(0, length - firstLength), firstLength)
    }
    return output
  }

  clear(): void {
    this.#buffer.fill(0)
    this.#length = 0
    this.#writeIndex = 0
  }
}
