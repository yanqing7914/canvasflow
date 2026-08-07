import { z } from 'zod'
import {
  airportPickupPhaseSchema,
  type AirportPickupTaskState,
  type RouteSketch,
} from '@canvasflow/schema'
import { routes } from './data'
// One small contract fixture, not the scenario catalog: it lives in its own
// subdirectory because the fixture root is the scenario catalog, and the README
// keeps `demo-fixtures` as the subpath so provider consumers do not load every
// timeline. Loading nine progress checkpoints here does not reopen that.
import routeProgressJson from '../../../fixtures/airport-pickup/route-sketch/progress.json'

/**
 * Task-state predicate for one authored progress checkpoint. Every field is
 * explicit — an unlisted field means "any value" — so a fixture can stage a
 * value without the composer inventing conditions of its own.
 */
const routeProgressConditionSchema = z.object({
  phase: airportPickupPhaseSchema,
  chargingStatus: z.enum(['none', 'planned', 'active', 'completed']).optional(),
  flightStatus: z.enum(['scheduled', 'in-air', 'landed', 'delayed', 'cancelled']).optional(),
  /** Rear cabin preferences applied on the return leg (`returnTrip.cabin.status`). */
  returnCabinApplied: z.boolean().optional(),
})

const routeProgressFixtureSchema = z.object({
  id: z.literal('route-progress'),
  version: z.literal('1.0'),
  description: z.string().min(1),
  matching: z.string().min(1),
  crawling: z.string().min(1),
  checkpoints: z.array(z.object({
    id: z.string().min(1),
    progress: z.number().min(0).max(1),
    /**
     * The authored span the marker may crawl across while this checkpoint holds.
     * Parsed here rather than trusted, because a bound at or behind `progress`
     * would send the car backwards and a zero duration would divide by nothing.
     */
    crawl: z.object({
      toProgress: z.number().min(0).max(1),
      durationSeconds: z.number().positive(),
    }).optional(),
    when: routeProgressConditionSchema,
    note: z.string().min(1).optional(),
  }).refine(
    (checkpoint) => checkpoint.crawl === undefined || checkpoint.crawl.toProgress > checkpoint.progress,
    { message: 'crawl.toProgress must be beyond the checkpoint progress', path: ['crawl', 'toProgress'] },
  )).min(1),
})

export type RouteProgressCheckpoint = z.infer<typeof routeProgressFixtureSchema>['checkpoints'][number]

/** Authored, ordered progress ladder; see the fixture's own `matching` note. */
export const routeProgressCheckpoints: readonly RouteProgressCheckpoint[] =
  routeProgressFixtureSchema.parse(routeProgressJson).checkpoints

function matchesTask(when: RouteProgressCheckpoint['when'], task: AirportPickupTaskState): boolean {
  if (when.phase !== task.phase) return false
  if (when.chargingStatus !== undefined && when.chargingStatus !== task.charging.status) return false
  if (when.flightStatus !== undefined && when.flightStatus !== task.flight?.status) return false
  if (when.returnCabinApplied !== undefined
    && when.returnCabinApplied !== (task.returnTrip?.cabin.status === 'succeeded')) return false
  return true
}

/**
 * The authored checkpoint for the current task state, or `undefined` when none
 * applies (a planned-but-not-started trip, for instance). Later matches win
 * because the fixture lists checkpoints in trip order.
 */
export function routeSketchCheckpoint(
  task: AirportPickupTaskState,
): RouteProgressCheckpoint | undefined {
  let match: RouteProgressCheckpoint | undefined
  for (const checkpoint of routeProgressCheckpoints) {
    if (matchesTask(checkpoint.when, task)) match = checkpoint
  }
  return match
}

/**
 * Simulated progress for the current task state. Where the checkpoint authors a
 * crawl this is the near end of its span rather than a fixed point; see
 * {@link routeSketchCheckpoint} for the span itself.
 */
export function routeSketchProgress(task: AirportPickupTaskState): number | undefined {
  return routeSketchCheckpoint(task)?.progress
}

/** Sketch geometry of a fixture route, looked up by the route the task is on. */
export function routeSketchGeometry(routeId: string): Pick<RouteSketch, 'summary' | 'waypoints' | 'polyline'> | undefined {
  const route = Object.values(routes).find((candidate) => candidate.routeId === routeId)
  return route ? sketchGeometryOf(route) : undefined
}

function sketchGeometryOf(route: {
  summary?: string
  waypoints?: RouteSketch['waypoints']
  polyline?: RouteSketch['polyline']
}): Pick<RouteSketch, 'summary' | 'waypoints' | 'polyline'> | undefined {
  const { summary, waypoints, polyline } = route
  // A single point cannot be drawn as a route, and an unnamed marker cannot be
  // labelled, so an incomplete fixture yields no sketch rather than half of one.
  if (!waypoints?.length || !polyline || polyline.length < 2) return undefined
  return { ...(summary !== undefined ? { summary } : {}), waypoints, polyline }
}

/**
 * Sketch for the route a task is currently on, with the staged progress attached.
 *
 * `route` carries the plan-route output when the composer has one in hand;
 * otherwise only the id is known and the geometry is looked up from the same
 * fixture routes. Returns `undefined` when the route has no sketch geometry —
 * the navigation card then renders its text alone, as it did before.
 */
export function routeSketchFor(
  task: AirportPickupTaskState,
  route: {
    routeId: string
    summary?: string
    waypoints?: RouteSketch['waypoints']
    polyline?: RouteSketch['polyline']
  },
): RouteSketch | undefined {
  const geometry = sketchGeometryOf(route) ?? routeSketchGeometry(route.routeId)
  if (!geometry) return undefined
  const checkpoint = routeSketchCheckpoint(task)
  if (!checkpoint) return geometry
  return {
    ...geometry,
    progress: checkpoint.progress,
    // Only a checkpoint that authored one; the sketch carries no crawl otherwise
    // and the marker holds where the task state put it.
    ...(checkpoint.crawl ? { crawl: checkpoint.crawl } : {}),
  }
}
