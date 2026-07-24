import { z } from 'zod'

export const airportPickupPhaseSchema = z.enum([
  'collecting-information',
  'preparing',
  'driving-to-airport',
  'approaching-airport',
  'waiting-for-passengers',
  'returning-home',
  'completed',
  'cancelled',
])

export const flightStateSchema = z
  .object({
    flightNumber: z.string().min(1),
    status: z.enum(['scheduled', 'in-air', 'landed', 'delayed', 'cancelled']),
    /**
     * Original published schedule; optional for legacy task/events that only
     * stored estimatedArrival. Normalize fills it from estimatedArrival.
     */
    scheduledArrival: z.iso.datetime({ offset: true }).optional(),
    estimatedArrival: z.iso.datetime({ offset: true }),
    terminal: z.string().min(1),
    baggageClaim: z.string().optional(),
  })
  .transform((flight) => ({
    ...flight,
    scheduledArrival: flight.scheduledArrival ?? flight.estimatedArrival,
  }))

export const airportPickupTaskStateSchema = z.object({
  taskId: z.string().min(1),
  surfaceId: z.string().min(1),
  taskRevision: z.number().int().nonnegative(),
  uiRevision: z.number().int().nonnegative(),
  phase: airportPickupPhaseSchema,
  passengers: z.object({
    memberIds: z.array(z.string()),
    names: z.array(z.string()),
    confirmedOnboard: z.boolean(),
  }),
  flight: flightStateSchema.optional(),
  navigation: z
    .object({
      routeId: z.string(),
      destination: z.string(),
      eta: z.iso.datetime({ offset: true }),
      status: z.enum(['planned', 'active', 'arrived']),
    })
    .optional(),
  charging: z.object({
    recommended: z.boolean(),
    accepted: z.boolean(),
    status: z.enum(['none', 'planned', 'active', 'completed']),
  }),
  message: z.object({
    autoNotifyAuthorized: z.boolean(),
    status: z.enum(['idle', 'scheduled', 'cancelled', 'sending', 'sent', 'failed']),
    landingNoticeSent: z.boolean(),
    pendingMessageId: z.string().optional(),
    /** Authorized recipient retained for schedule/retry; cleared after terminal send outcomes. */
    pendingContactId: z.string().optional(),
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
    sentAt: z.iso.datetime({ offset: true }).optional(),
    idempotencyKey: z.string().optional(),
  }),
  pendingConfirmation: z
    .object({
      confirmationId: z.string(),
      action: z.enum(['send-message', 'apply-cabin-profile', 'save-memory']),
      expiresAt: z.iso.datetime({ offset: true }).optional(),
    })
    .optional(),
  processedEventIds: z.array(z.string()),
  updatedAt: z.iso.datetime({ offset: true }),
})

const eventBase = z.object({
  eventId: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
})

export const airportPickupEventSchema = z.discriminatedUnion('type', [
  eventBase.extend({ type: z.literal('user.input'), text: z.string().min(1) }),
  eventBase.extend({ type: z.literal('navigation.started'), routeId: z.string() }),
  eventBase.extend({ type: z.literal('vehicle.moving'), speedKph: z.number().nonnegative() }),
  eventBase.extend({ type: z.literal('flight.updated'), flight: flightStateSchema }),
  eventBase.extend({ type: z.literal('vehicle.entered-airport-geofence') }),
  eventBase.extend({ type: z.literal('vehicle.parked') }),
  eventBase.extend({ type: z.literal('occupancy.changed'), rearOccupied: z.boolean() }),
  eventBase.extend({ type: z.literal('user.confirmed-passengers-onboard') }),
  eventBase.extend({ type: z.literal('charging.started'), stationId: z.string() }),
  eventBase.extend({ type: z.literal('charging.completed'), batteryPercent: z.number().min(0).max(100) }),
  eventBase.extend({ type: z.literal('charging.cancelled'), reason: z.string().optional() }),
  eventBase.extend({ type: z.literal('destination.arrived'), destination: z.string() }),
  eventBase.extend({ type: z.literal('user.cancelled-task'), reason: z.string().optional() }),
  eventBase.extend({ type: z.literal('provider.timeout'), provider: z.string() }),
  eventBase.extend({ type: z.literal('message.sent'), messageId: z.string() }),
  eventBase.extend({ type: z.literal('message.failed'), messageId: z.string(), errorCode: z.string() }),
])

export type AirportPickupPhase = z.infer<typeof airportPickupPhaseSchema>
export type FlightState = z.infer<typeof flightStateSchema>
export type AirportPickupTaskState = z.infer<typeof airportPickupTaskStateSchema>
export type AirportPickupEvent = z.infer<typeof airportPickupEventSchema>
