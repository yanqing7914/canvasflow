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
    /** False means only the locally parsed number is known; provider facts are not verified. */
    trusted: z.boolean().optional(),
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

const returnTripEffectStateSchema = z.object({
  status: z.enum(['pending', 'succeeded', 'failed', 'skipped']),
  errorCode: z.string().optional(),
})

export const memoryProposalStateSchema = z.object({
  proposalId: z.string().min(1).optional(),
  memberId: z.string().min(1).optional(),
  confirmationId: z.string().min(1).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  changes: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['pending', 'accepted', 'rejected', 'expired', 'failed', 'skipped']),
  errorCode: z.string().optional(),
})

export const returnTripStateSchema = z.object({
  workflowId: z.string().min(1),
  homeDestinationId: z.string().min(1).optional(),
  route: returnTripEffectStateSchema.extend({
    routeId: z.string().min(1).optional(),
    eta: z.iso.datetime({ offset: true }).optional(),
  }),
  cabin: returnTripEffectStateSchema.extend({
    revert: z
      .object({
        status: z.enum(['available', 'succeeded', 'failed', 'unknown']),
        errorCode: z.string().optional(),
      })
      .optional(),
  }),
  media: returnTripEffectStateSchema,
})

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
  returnTrip: returnTripStateSchema.optional(),
  memoryProposal: memoryProposalStateSchema.optional(),
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
    /** Exact provider-prepared payload shown to the user and sent after confirmation. */
    pendingText: z.string().optional(),
    authorizationId: z.string().optional(),
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
export type ReturnTripState = z.infer<typeof returnTripStateSchema>
export type MemoryProposalState = z.infer<typeof memoryProposalStateSchema>
export type AirportPickupTaskState = z.infer<typeof airportPickupTaskStateSchema>
export type AirportPickupEvent = z.infer<typeof airportPickupEventSchema>
