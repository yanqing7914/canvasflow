import { z } from 'zod'
import { airportPickupPhaseSchema } from './task'

const gapSchema = z.enum(['none', 'sm', 'md', 'lg'])

export const layoutSpecSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stack'), gap: gapSchema, slots: z.object({ main: z.array(z.string()) }) }),
  z.object({ type: z.literal('row'), gap: gapSchema, slots: z.object({ main: z.array(z.string()) }) }),
  z.object({ type: z.literal('column'), gap: gapSchema, slots: z.object({ main: z.array(z.string()) }) }),
  z.object({
    type: z.literal('split'),
    ratio: z.tuple([z.number().positive(), z.number().positive()]),
    slots: z.object({ primary: z.array(z.string()), secondary: z.array(z.string()) }),
  }),
  z.object({
    type: z.literal('focus'),
    slots: z.object({ primary: z.array(z.string()), secondary: z.array(z.string()) }),
  }),
])

const componentBase = z.object({
  id: z.string().min(1),
  actions: z.array(z.string()).optional(),
  visibility: z.enum(['always', 'parked-only', 'driving-only']).optional(),
})

/**
 * Offline route sketch, carried by the `route-map` panel and — for specs that
 * have no panel — by `navigation-summary`.
 *
 * Every point is fictional fixture data for a static sketch: the renderer
 * normalizes the set into its own view box, so the bounds below exist only to
 * keep an unplottable coordinate out of the drawing, not to claim geographic
 * accuracy. Nothing here is live navigation, GIS, or positioning data.
 */
const routeSketchPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
})

const routeSketchWaypointSchema = routeSketchPointSchema.extend({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
})

export const routeSketchSchema = z.object({
  /** One-line human summary of the route variant, e.g. 经超充站前往机场. */
  summary: z.string().min(1).optional(),
  /** Ordered named markers: first is the origin, last the destination, rest vias. */
  waypoints: z.array(routeSketchWaypointSchema).min(1),
  /** Ordered sketch line; two points is the minimum that can be drawn. */
  polyline: z.array(routeSketchPointSchema).min(2),
  /**
   * Discrete simulated trip progress along the sketch: 0 is the start, 1 the end.
   * Authored per task state by fixtures — the UI never advances it on its own, and
   * an absent value means "no vehicle marker" rather than "at the start".
   */
  progress: z.number().min(0).max(1).optional(),
})

export const componentSpecSchema = z.discriminatedUnion('type', [
  componentBase.extend({
    type: z.literal('pickup-overview'),
    props: z.object({
      passengers: z.array(z.string()), flightNumber: z.string(), airport: z.string(), terminal: z.string(), phaseLabel: z.string(),
    }),
  }),
  componentBase.extend({
    type: z.literal('flight-status'),
    props: z.object({
      flightNumber: z.string(), status: z.enum(['scheduled', 'in-air', 'landed', 'delayed', 'cancelled']),
      scheduledArrival: z.string(), estimatedArrival: z.string(), terminal: z.string(), baggageClaim: z.string().optional(),
      freshness: z.enum(['live', 'cached', 'fixture']),
    }),
  }),
  componentBase.extend({
    type: z.literal('navigation-summary'),
    props: z.object({
      routeId: z.string(), destination: z.string(), eta: z.string(), distanceKm: z.number(), estimatedBatteryAtArrival: z.number(),
      /**
       * Optional offline sketch geometry. Dropped rather than rejected so a bad
       * sketch costs the driver the drawing, not the destination and ETA that the
       * rest of the card carries — {@link routeSketchSchema} stays strict for
       * producers and contract tests.
       */
      routeSketch: routeSketchSchema.optional().catch(undefined),
    }),
  }),
  componentBase.extend({
    type: z.literal('route-map'),
    props: z.object({
      /** Human destination label. Never an internal route identifier. */
      destination: z.string().min(1),
      /**
       * View intent, not camera state. The composer says whether the driver
       * needs the whole trip or the part they are on; how that becomes a zoom,
       * a pitch, or a bearing is the renderer's business alone.
       */
      mode: z.enum(['overview', 'follow']),
      /**
       * Geometry the composer attached from the fixture routes. Required and
       * deliberately not `.catch(undefined)`: a navigation card without a sketch
       * still carries the destination and the ETA, but a map without geometry is
       * an empty box, so an unusable one drops the whole component and lets the
       * renderer's per-component fallback take the slot.
       */
      routeSketch: routeSketchSchema,
    }),
  }),
  componentBase.extend({
    type: z.literal('charging-recommendation'),
    props: z.object({
      recommended: z.boolean(), reason: z.string(), currentBatteryPercent: z.number(), estimatedFinalBatteryPercent: z.number(),
      suggestedDurationMinutes: z.number().optional(), etaImpactMinutes: z.number().optional(),
    }),
  }),
  componentBase.extend({
    type: z.literal('message-preview'),
    props: z.object({
      contactLabel: z.string(), textPreview: z.string(), status: z.enum(['scheduled', 'sending', 'sent', 'cancelled', 'failed']),
      cancellable: z.boolean(), scheduledAt: z.string().optional(),
    }),
  }),
  componentBase.extend({
    type: z.literal('passenger-status'),
    props: z.object({
      label: z.string(), status: z.enum(['in-flight', 'landed', 'waiting', 'possibly-onboard', 'confirmed-onboard']), meetingPoint: z.string().optional(),
    }),
  }),
  componentBase.extend({
    type: z.literal('cabin-profile'),
    props: z
      .object({
        zone: z.literal('rear'),
        temperatureC: z.number().optional(),
        fanLevel: z.number().optional(),
        mediaTitle: z.string().min(1).optional(),
        appliedFromMemory: z.boolean(),
        reversible: z.boolean(),
      })
      .refine(
        (props) =>
          props.temperatureC !== undefined ||
          props.fanLevel !== undefined ||
          (props.mediaTitle !== undefined && props.mediaTitle.length > 0),
        { message: 'cabin-profile requires at least one of temperatureC, fanLevel, or mediaTitle' },
      ),
  }),
  componentBase.extend({
    type: z.literal('task-progress'),
    props: z.object({
      currentPhase: airportPickupPhaseSchema,
      steps: z.array(z.object({ phase: airportPickupPhaseSchema, label: z.string(), status: z.enum(['pending', 'active', 'completed']) })).max(5),
    }),
  }),
  componentBase.extend({
    type: z.literal('schedule-strip'),
    props: z.object({
      /**
       * Task milestones and calendar events on one ordered band. `kind` keeps
       * their provenance apart (solid vs hollow markers); `at-risk` marks a
       * calendar entry the task's projected timing may miss. Deliberately no
       * "now" marker: the fixture timeline and the wall clock disagree, and a
       * clock the brief cannot honor is worse than none.
       */
      milestones: z.array(z.object({
        label: z.string().min(1),
        time: z.string(),
        kind: z.enum(['task', 'calendar']),
        status: z.enum(['done', 'next', 'upcoming', 'at-risk']),
      })).min(2).max(5),
    }),
  }),
  componentBase.extend({
    type: z.literal('weather-card'),
    props: z.object({
      /** Human place label the reading is for, e.g. 虹桥机场 T2. */
      location: z.string().min(1),
      /** Which moment the reading describes, e.g. 20:40 到达时 or 现在. */
      timeLabel: z.string().min(1),
      temperatureC: z.number(),
      condition: z.enum(['sunny', 'cloudy', 'overcast', 'light-rain', 'heavy-rain', 'fog']),
      /** Localized condition copy; the enum stays stable for renderers. */
      conditionLabel: z.string().min(1),
      windLevel: z.number().int().min(0).max(12).optional(),
      precipitationChance: z.number().min(0).max(100).optional(),
      /** One pickup-relevant suggestion; absent when the weather needs none. */
      advisory: z.string().min(1).optional(),
      freshness: z.enum(['live', 'cached', 'fixture']),
    }),
  }),
  componentBase.extend({
    type: z.literal('alert'),
    props: z.object({ level: z.enum(['info', 'warning', 'critical']), title: z.string(), message: z.string().optional() }),
  }),
  componentBase.extend({
    type: z.literal('status-banner'),
    props: z.object({ level: z.enum(['info', 'warning', 'error']), title: z.string(), message: z.string().optional() }),
  }),
])

export const actionSpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  style: z.enum(['primary', 'secondary', 'danger']),
  event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('agent-message'), text: z.string() }),
    z.object({ type: z.literal('tool-request'), actionToken: z.string() }),
    z.object({ type: z.literal('confirmation'), confirmationId: z.string(), decision: z.enum(['accept', 'reject']) }),
    z.object({ type: z.literal('dismiss'), targetId: z.string() }),
  ]),
})

export const uiSpecSchema = z
  .object({
    version: z.literal('1.0'),
    taskId: z.string(),
    surfaceId: z.string(),
    taskRevision: z.number().int().nonnegative(),
    uiRevision: z.number().int().nonnegative(),
    phase: airportPickupPhaseSchema,
    title: z.string(),
    presentation: z.object({
      mode: z.literal('replace'), density: z.enum(['full', 'compact', 'minimal']), theme: z.enum(['light', 'dark']),
      priority: z.enum(['normal', 'high', 'critical']),
    }),
    layout: layoutSpecSchema,
    components: z.array(componentSpecSchema),
    actions: z.array(actionSpecSchema),
    meta: z.object({
      generatedBy: z.enum(['llm', 'composer', 'fallback']), sourceTaskRevision: z.number().int().nonnegative(),
      requiresConfirm: z.boolean(), generatedAt: z.iso.datetime({ offset: true }), traceId: z.string(),
    }),
  })
  .superRefine((spec, context) => {
    if (spec.meta.sourceTaskRevision !== spec.taskRevision) {
      context.addIssue({ code: 'custom', path: ['meta', 'sourceTaskRevision'], message: 'Must match taskRevision' })
    }
    const ids = spec.components.map((component) => component.id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['components'], message: 'Component ids must be unique' })
    }
    const slotIds = Object.values(spec.layout.slots).flat()
    if (slotIds.length !== ids.length || new Set(slotIds).size !== slotIds.length || slotIds.some((id) => !ids.includes(id))) {
      context.addIssue({ code: 'custom', path: ['layout', 'slots'], message: 'Slots must reference each component exactly once' })
    }
  })

export type ComponentSpec = z.infer<typeof componentSpecSchema>
export type ActionSpec = z.infer<typeof actionSpecSchema>
export type RouteSketch = z.infer<typeof routeSketchSchema>
export type UISpec = z.infer<typeof uiSpecSchema>
