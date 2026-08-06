import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CrawlScheduler, prefersReducedMotion, startCrawl } from './crawl'

/**
 * A scheduler that only advances when the test says so.
 *
 * The driver takes its timestamp from the callback, so stepping time here is the
 * whole of the clock: no fake timers, no waiting on real frames, and every
 * assertion below is about an exact position rather than an approximate one.
 */
function manualScheduler() {
  let next = 1
  const pending = new Map<number, (timestampMs: number) => void>()
  const scheduler: CrawlScheduler = {
    request: (callback) => {
      const handle = next++
      pending.set(handle, callback)
      return handle
    },
    cancel: (handle) => { pending.delete(handle) },
  }
  return {
    scheduler,
    get pendingCount() { return pending.size },
    /** Fires every callback queued right now at `timestampMs`. */
    step(timestampMs: number) {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, callback] of due) callback(timestampMs)
    },
  }
}

function recorder() {
  const seen: number[] = []
  return { seen, onProgress: (progress: number) => { seen.push(progress) } }
}

afterEach(() => { vi.unstubAllGlobals() })

/** jsdom has no matchMedia, so a test that needs an answer has to supply one. */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('startCrawl', () => {
  const span = { toProgress: 0.34, durationSeconds: 10 }

  it('interpolates from the authored start towards the authored bound', () => {
    const clock = manualScheduler()
    const { seen, onProgress } = recorder()
    startCrawl({ from: 0.08, span, onProgress, scheduler: clock.scheduler })

    // The first tick sets the origin, so it reports the start rather than a jump.
    clock.step(1000)
    expect(seen).toEqual([0.08])

    clock.step(3500)
    expect(seen[1]).toBeCloseTo(0.08 + 0.26 * 0.25, 10)

    clock.step(6000)
    expect(seen[2]).toBeCloseTo(0.08 + 0.26 * 0.5, 10)
  })

  it('lands exactly on the bound and stops there', () => {
    const clock = manualScheduler()
    const { seen, onProgress } = recorder()
    startCrawl({ from: 0.08, span, onProgress, scheduler: clock.scheduler })

    clock.step(0)
    // Deliberately overshooting: a frame that lands late must not report a
    // position past the bound, which is the fixture's own authored limit.
    clock.step(14_000)

    expect(seen.at(-1)).toBe(0.34)
    expect(clock.pendingCount).toBe(0)
  })

  it('reports nothing further once stopped', () => {
    const clock = manualScheduler()
    const { seen, onProgress } = recorder()
    const handle = startCrawl({ from: 0.08, span, onProgress, scheduler: clock.scheduler })

    clock.step(0)
    handle!.stop()
    clock.step(5000)

    expect(seen).toEqual([0.08])
    expect(clock.pendingCount).toBe(0)
  })

  it('does not start when the bound is already reached or behind', () => {
    const clock = manualScheduler()
    const { onProgress } = recorder()
    expect(startCrawl({ from: 0.34, span, onProgress, scheduler: clock.scheduler })).toBeNull()
    expect(startCrawl({ from: 0.5, span, onProgress, scheduler: clock.scheduler })).toBeNull()
    expect(clock.pendingCount).toBe(0)
  })

  it('does not start on a duration of zero', () => {
    const clock = manualScheduler()
    const { onProgress } = recorder()
    expect(startCrawl({
      from: 0.08,
      span: { toProgress: 0.34, durationSeconds: 0 },
      onProgress,
      scheduler: clock.scheduler,
    })).toBeNull()
    expect(clock.pendingCount).toBe(0)
  })

  it('does not start for a viewer who asked for reduced motion', () => {
    stubReducedMotion(true)
    const clock = manualScheduler()
    const { onProgress } = recorder()

    expect(startCrawl({ from: 0.08, span, onProgress, scheduler: clock.scheduler })).toBeNull()
    expect(clock.pendingCount).toBe(0)
  })

  it('starts for a viewer who did not', () => {
    stubReducedMotion(false)
    const clock = manualScheduler()
    const { onProgress } = recorder()

    expect(startCrawl({ from: 0.08, span, onProgress, scheduler: clock.scheduler })).not.toBeNull()
  })
})

describe('prefersReducedMotion', () => {
  it('is false where the query cannot be asked', () => {
    expect(prefersReducedMotion()).toBe(false)
  })

  it('treats a throwing matchMedia as a request for less movement', () => {
    vi.stubGlobal('matchMedia', () => { throw new Error('unsupported query') })
    expect(prefersReducedMotion()).toBe(true)
  })
})
