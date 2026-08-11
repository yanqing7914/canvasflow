import { z } from 'zod'
import { arrivalAirportSchema, navigationSimulationSeedSchema, pickupAirportSchema } from './tool'

export const airportPickupPhaseSchema = z.enum([
  'collecting-airport',
  'choosing-flight',
  'confirming-outbound',
  'outbound-driving',
  'passengers-onboard',
  'confirming-return',
  'return-driving',
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
    airlineName: z.string().min(1).optional(),
    originName: z.string().min(1).optional(),
    arrivalAirportName: z.string().min(1).optional(),
    /** False means only the locally parsed number is known; provider facts are not verified. */
    trusted: z.boolean().optional(),
    status: z.enum(['scheduled', 'in-air', 'landed', 'delayed', 'cancelled']),
    /**
     * Original published schedule; optional for legacy task/events that only
     * stored estimatedArrival. Normalize fills it from estimatedArrival.
     */
    scheduledArrival: z.iso.datetime({ offset: true }).optional(),
    estimatedArrival: z.iso.datetime({ offset: true }),
    /**
     * Which Shanghai airport the flight lands at. Only the code is held here:
     * the display name lives on the tool result the board renders from, and
     * duplicating it in task state would give the same fact two homes.
     *
     * Optional, and with no default filled in, unlike `scheduledArrival` below.
     * Two reasons, both about not inventing an answer:
     *
     * - A `flight.updated` event replaces this whole object. If an absent airport
     *   normalized to 虹桥, a routine status push on a 浦东 pickup would quietly
     *   move the trip to the other side of the city.
     * - The locally parsed flight number (`trusted: false`) genuinely does not
     *   know the airport yet. Absent says that; 'SHA' would claim otherwise.
     *
     * So consumers read it as "known or not known" and degrade honestly — the
     * meeting point is omitted rather than guessed, and the drive destination
     * comes from the provider read that does know.
     */
    arrivalAirport: arrivalAirportSchema.optional(),
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

export const cockpitContextSchema = z.object({
  speedMode: z.enum(['slow', 'normal', 'fast']),
  hudVisible: z.boolean(),
  activeLeg: z.enum(['outbound', 'return']).optional(),
  routeProgress: z.number().min(0).max(1).optional(),
  currentRoad: z.string().min(1).optional(),
  currentLocationId: z.string().min(1).optional(),
}).strict()

export const airportPickupTaskStateSchema = z.object({
  taskId: z.string().min(1),
  surfaceId: z.string().min(1),
  taskRevision: z.number().int().nonnegative(),
  uiRevision: z.number().int().nonnegative(),
  phase: airportPickupPhaseSchema,
  pickupAirport: pickupAirportSchema.optional(),
  passengers: z.object({
    memberIds: z.array(z.string()),
    names: z.array(z.string()),
    confirmedOnboard: z.boolean(),
  }),
  flight: flightStateSchema.optional(),
  /**
   * Which set of arrivals the driver is currently choosing from.
   *
   * Only the set's identity, never its rows: the candidates themselves live in
   * the persisted `flight.list-arrivals` tool result, and a second copy here
   * would be a second truth to keep in step.
   *
   * Its job is the ordinal path. "第三个" names a row by position, which only
   * means anything against the board that was on screen — so before resolving a
   * rank, the gateway checks the persisted board still carries this id and has
   * not expired. Refresh mints a new id and bumps `taskRevision`, so the
   * ordinary revision guard is what rejects a stale spoken pick; this field is
   * what makes the set that was picked from inspectable, and adds the expiry
   * that a revision number cannot express.
   */
  flightDiscovery: z
    .object({
      candidateSetId: z.string().min(1),
      expiresAt: z.iso.datetime({ offset: true }),
      queryId: z.string().min(1).optional(),
      airportLabel: z.string().min(1).optional(),
      queriedAt: z.iso.datetime({ offset: true }).optional(),
    })
    .optional(),
  navigation: z
    .object({
      routeId: z.string(),
      destination: z.string(),
      eta: z.iso.datetime({ offset: true }),
      status: z.enum(['planned', 'active', 'arrived']),
    })
    .optional(),
  navigationSimulation: navigationSimulationSeedSchema.optional(),
  cockpit: cockpitContextSchema.optional(),
  /**
   * A standing "remind me when it is time to leave", set by 稍后提醒 on the
   * departure answer.
   *
   * A recorded intention, not a timer — this demo has no scheduler, and the field
   * is deliberately named for the time rather than for a firing. What it buys is
   * that the answer stops being a thing the driver has to hold in their head: the
   * departure card states the reminder back on every later ask, so 什么时候出发
   * reads as confirmation instead of as the same unanswered question. Retired
   * once the car actually leaves, because a reminder to depart is then a lie.
   */
  departureReminder: z
    .object({
      remindAt: z.iso.datetime({ offset: true }),
      armedAt: z.iso.datetime({ offset: true }),
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
  /**
   * The one proactive weather prompt of the trip. Set by the gateway when a
   * flight update en route finds rain over the arrival window; `active` keeps
   * the advisory card on the driving rail, `dismissed` and `resolved` (the
   * umbrella reminder was armed) both retire it for good — the trip never
   * re-prompts.
   */
  weatherAdvisory: z
    .object({
      status: z.enum(['active', 'dismissed', 'resolved']),
      advisedAt: z.iso.datetime({ offset: true }),
    })
    .optional(),
  /**
   * The one proactive calendar prompt of the trip. Set by the gateway when a
   * flight update en route pushes the projected home arrival past an event's
   * start; `active` keeps the conflict card on the driving rail, `dismissed`
   * retires it for good — the trip never re-prompts, even if the lateness
   * grows. The event identity and projected lateness are pinned at raise time
   * so the card keeps saying what it said when the driver first saw it.
   */
  calendarAdvisory: z
    .object({
      status: z.enum(['active', 'dismissed', 'resolved']),
      advisedAt: z.iso.datetime({ offset: true }),
      eventId: z.string().min(1),
      eventTitle: z.string().min(1),
      eventStartAt: z.iso.datetime({ offset: true }),
      lateByMinutes: z.number().int().positive(),
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
  eventBase.extend({ type: z.literal('user.input'), text: z.string().min(1), source: z.enum(['text', 'voice']).optional() }),
  eventBase.extend({ type: z.literal('pickup.airport-selected'), airport: pickupAirportSchema }),
  eventBase.extend({ type: z.literal('navigation.outbound-arrived') }),
  eventBase.extend({ type: z.literal('passengers.onboard') }),
  eventBase.extend({ type: z.literal('navigation.return-arrived') }),
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
export type CockpitContext = z.infer<typeof cockpitContextSchema>
export type MemoryProposalState = z.infer<typeof memoryProposalStateSchema>
export type AirportPickupTaskState = z.infer<typeof airportPickupTaskStateSchema>
export type AirportPickupEvent = z.infer<typeof airportPickupEventSchema>
