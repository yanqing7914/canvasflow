import type { RouteSketch } from '@canvasflow/schema'

/**
 * The vehicle marker's crawl between two fixture-authored points.
 *
 * The demo's standing rule is that the fixture is the only source of truth for
 * where the car is, and this does not change that: both ends of the span and the
 * time it takes come from the checkpoint the Agent's UISpec carried. What moves
 * is the position *within* that span, so a car that is under way looks under way
 * instead of frozen between events. It cannot reach a stage the Agent has not
 * sent — the fixture stops every bound short of the next checkpoint — and it
 * stops at the bound rather than easing on or wrapping around.
 *
 * The clock and the scheduler are injected rather than reached for, so the tests
 * below step time by hand instead of waiting for real frames.
 *
 * Nothing here is a position claim. The caption says 模拟行程进度 throughout, and
 * this interpolates a staged figure; it is not a GPS fix, a road-speed estimate,
 * or a measurement of anything.
 */

export type CrawlSpan = NonNullable<RouteSketch['crawl']>

export type CrawlScheduler = {
  /** Requests the next tick and returns a handle the driver can cancel with. */
  request: (callback: (timestampMs: number) => void) => number
  cancel: (handle: number) => void
}

export type CrawlOptions = {
  /** The near end of the span: the checkpoint's own authored progress. */
  from: number
  span: CrawlSpan
  /** Called with each new position, including the final one at the bound. */
  onProgress: (progress: number) => void
  scheduler?: CrawlScheduler
}

export type CrawlHandle = { stop: () => void }

/**
 * The browser's own frame loop, which already pauses in a background tab.
 *
 * Timestamps come from the callback rather than from `performance.now()` so a
 * test scheduler can supply its own without the driver noticing the difference.
 */
const frameScheduler: CrawlScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
}

/** Whether the viewer has asked for less movement. Static in SSR and in jsdom. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // A matchMedia that throws on an unsupported query is not a reason to move;
    // treat it as the quieter of the two answers.
    return true
  }
}

/**
 * Starts a crawl and returns a handle that stops it.
 *
 * Returns `null` when there is nothing to animate — no span, a bound already
 * reached, or a viewer who asked for reduced motion — so the caller can treat
 * "did not start" and "finished" the same way and leave the marker at `from`.
 */
export function startCrawl(options: CrawlOptions): CrawlHandle | null {
  const { from, span, onProgress } = options
  const scheduler = options.scheduler ?? frameScheduler

  const distance = span.toProgress - from
  if (!(distance > 0) || !(span.durationSeconds > 0)) return null
  if (prefersReducedMotion()) return null

  const durationMs = span.durationSeconds * 1000
  let startedAt: number | undefined
  let handle: number | undefined
  let stopped = false

  const tick = (timestampMs: number) => {
    if (stopped) return
    // The first callback establishes the origin rather than a separate clock
    // read, so a scheduler that fires late does not lose the elapsed time.
    if (startedAt === undefined) startedAt = timestampMs
    const elapsed = timestampMs - startedAt
    const fraction = elapsed / durationMs

    if (fraction >= 1) {
      // Land exactly on the authored bound. Reporting `from + distance * fraction`
      // here would overshoot it by however late the last frame ran.
      onProgress(span.toProgress)
      stopped = true
      return
    }

    onProgress(from + distance * Math.max(0, fraction))
    handle = scheduler.request(tick)
  }

  handle = scheduler.request(tick)

  return {
    stop: () => {
      stopped = true
      if (handle !== undefined) scheduler.cancel(handle)
    },
  }
}
