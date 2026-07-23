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
    props: z.object({
      zone: z.literal('rear'), temperatureC: z.number(), fanLevel: z.number().optional(), mediaTitle: z.string().optional(),
      appliedFromMemory: z.boolean(), reversible: z.boolean(),
    }),
  }),
  componentBase.extend({
    type: z.literal('task-progress'),
    props: z.object({
      currentPhase: airportPickupPhaseSchema,
      steps: z.array(z.object({ phase: airportPickupPhaseSchema, label: z.string(), status: z.enum(['pending', 'active', 'completed']) })).max(5),
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
export type UISpec = z.infer<typeof uiSpecSchema>
