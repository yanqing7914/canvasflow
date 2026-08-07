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

  /**
   * Fires a run of frames at a steady rate, the way a painting tab delivers
   * them. Each gap is inside the clamp, so a run of them is elapsed time.
   * Timestamps continue from `since`, and the last one is returned so the next
   * run — or a deliberate gap — can carry on from it.
   */
  function runFrames(clock: ReturnType<typeof manualScheduler>, since: number, count: number, stepMs = 100) {
    let at = since
    for (let frame = 1; frame <= count; frame += 1) {
      at = since + frame * stepMs
      clock.step(at)
    }
    return at
  }

  it('interpolates from the authored start towards the authored bound', () => {
    const clock = manualScheduler()
    const { seen, onProgress } = recorder()
    startCrawl({ from: 0.08, span, onProgress, scheduler: clock.scheduler })

    // The first tick sets the origin, so it reports the start rather than a jump.
    clock.step(1000)
    expect(seen).toEqual([0.08])

    // A quarter of the span is 25 frames of the 100ms the run below delivers.
    const quarter = runFrames(clock, 1000, 25)
    expect(seen.at(-1)).toBeCloseTo(0.08 + 0.26 * 0.25, 10)

    runFrames(clock, quarter, 25)
    expect(seen.at(-1)).toBeCloseTo(0.08 + 0.26 * 0.5, 10)
  })

  it('lands exactly on the bound and stops there', () => {
    const clock = manualScheduler()
    const { seen, onProgress } = recorder()
    startCrawl({ from: 0.08, span, onProgress, scheduler: clock.scheduler })

    clock.step(0)
    // Deliberately overshooting: the last frame carries the span past its end,
    // and the reported position must be the fixture's authored limit rather
    // than wherever the arithmetic landed.
    runFrames(clock, 0, 101)

    expect(seen.at(-1)).toBe(0.34)
    expect(clock.pendingCount).toBe(0)
  })

  /**
   * A background tab stops delivering frames entirely, so the gap between the
   * last frame before it left and the first frame after it returns is the whole
   * time it was away. Counting that as elapsed would spend the span while nobody
   * was watching and snap the marker to the bound on the driver's return — the
   * teleport this animation exists to avoid.
   */
  it('does not spend the span while the frame loop is not running', () => {
    const clock = manualScheduler()
    const { seen, onProgress } = recorder()
    startCrawl({ from: 0.08, span, onProgress, scheduler: clock.scheduler })

    clock.step(0)
    const hidAt = runFrames(clock, 0, 10) // A second of crawling, then the tab leaves.
    expect(seen.at(-1)).toBeCloseTo(0.08 + 0.26 * 0.1, 10)

    // Thirty seconds later, three times the whole span, one frame arrives.
    clock.step(hidAt + 30_000)
    // It counts for one slow frame, not for thirty seconds: the marker resumes
    // from where the driver left it rather than at the bound.
    expect(seen.at(-1)).toBeCloseTo(0.08 + 0.26 * 0.12, 10)
    expect(clock.pendingCount).toBe(1)

    // And the rest of the span is still there to be walked.
    runFrames(clock, hidAt + 30_000, 100)
    expect(seen.at(-1)).toBe(0.34)
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
