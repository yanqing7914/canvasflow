import {
  agentResponseSchema,
  cancelTaskRequestSchema,
  createTaskRequestSchema,
  resetTaskRequestSchema,
  submitActionRequestSchema,
  submitConfirmationRequestSchema,
  submitEventRequestSchema,
  uiSpecSchema,
  type AgentErrorCode,
  type AgentResponse,
  type AirportPickupTaskState,
  type CancelTaskRequest,
  type CreateTaskRequest,
  type ResetTaskRequest,
  type SubmitActionRequest,
  type SubmitConfirmationRequest,
  type SubmitEventRequest,
  type ReturnTripState,
  type EffectRecord,
  type UISpec,
  type ProviderMode,
  type WeatherOutput,
} from '@canvasflow/schema'
import {
  buildLandingNotifyContent,
  createProviderRegistry,
  issueAutoNotifyAuthorization,
  pickupDestinationForAirport,
  resolveAuthorizedLandingContact,
  resetSideEffectRuntimeTask,
  createSideEffectRuntime,
  type MemberPreferenceRecord,
  type ProviderRegistry,
  type SideEffectRuntime,
} from '@canvasflow/tools'
import { applyEvent, createInitialTask } from './index'
import { mergePassengers } from './passengers'
import { applyRequestPresentation, clockLabel, composeAgentSpec, composeFallbackSpec, departureAtIso, departurePlan, renderedArrivalRows, weatherConditionLabels, type ComposeContext } from './composer'
import { planEffects } from './effects'
import { EffectExecutor, type PolicyGate } from './effect-executor'
import { Planner, planAirportPickup, type Plan, type PlannerInput } from './planner'
import {
  armLandingMessageRetry,
  resolveLandingMeetingEta,
  resolveLandingMessageRetry,
  RETRY_LANDING_MESSAGE_ACTION_ID,
  retryLandingMessageActionToken,
} from './landing-message-retry'
import {
  ReadToolOrchestrationError,
  ReadToolOrchestrator,
  type ReadToolOrchestration,
  type ReadToolResults,
} from './orchestration'
import { MemoryTaskStore, type StoredEventResult, type StoredTask, type TaskStore, type TaskUpdateRead } from './store'

const returnTripPolicyErrorCodes = new Set([
  'TASK_TERMINAL',
  'INVALID_TASK_PHASE',
  'FLIGHT_CANCELLED',
  'VEHICLE_CONTEXT_REQUIRED',
  'VEHICLE_MOVING',
])

/**
 * The operation side answers are replayed under.
 *
 * Deliberately the idempotency keyspace rather than the event one: an ordinary
 * event replay is keyed by the client's own event id, so any key derived from
 * that id and stored beside it could be spelled by a client. Operations are
 * minted here — `task:reset`, `action:…`, `confirmation:…`, and this one — and
 * are not part of the request surface, so a caller cannot land in this row.
 */
const SIDE_ANSWER_OPERATION = 'event:side-answer'

function enforceGatewayProviderMode(registry: ProviderRegistry, mode: ProviderMode): ProviderRegistry {
  return Object.fromEntries(
    Object.entries(registry).map(([name, provider]) => [
      name,
      (context: Parameters<typeof provider>[0], input?: unknown) => {
        const result = provider(context, input)
        if (!result || typeof result !== 'object' || result.meta?.provider !== mode) {
          throw Object.assign(new Error(`Provider ${name} returned an unexpected mode`), { code: 'PROVIDER_FAILED' })
        }
        return result
      },
    ]),
  ) as ProviderRegistry
}

export class AgentGatewayError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly retryable = false,
    readonly latest?: StoredTask,
  ) {
    super(message)
  }
}

export type AgentGatewayOptions = {
  store?: TaskStore
  now?: () => string
  createId?: () => string
  compose?: (
    task: AirportPickupTaskState,
    toolResults?: ReadToolResults,
    preferences?: Record<string, MemberPreferenceRecord>,
    composeContext?: ComposeContext,
  ) => UISpec
  orchestrator?: ReadToolOrchestration
  providers?: ProviderRegistry
  policyGate?: PolicyGate
  planner?: Pick<Planner, 'plan'>
  /** Trusted model provenance supplied by the persistent runtime for this operation. */
  modelUsed?: string
  /**
   * A live schedule reading the persistent runtime prefetched OUTSIDE the
   * SQLite transaction (the gateway itself must never await). When the turn is
   * a check-schedule query it answers from this instead of the fixture
   * calendar; absent — not configured, prefetch failed — the fixture path is
   * the fallback.
   */
  prefetchedSchedule?: ReadToolResults['calendar.query']
  mode?: ProviderMode
  /**
   * Side-effect runtime for opaque confirmations and preference-backed notify.
   * When provided, its preferences are authoritative for landing-notify auth.
   */
  runtime?: SideEffectRuntime
  /** @deprecated Prefer `runtime.preferences`; used only when `runtime` is omitted. */
  preferences?: Record<string, MemberPreferenceRecord>
}

export class AgentGateway {
  readonly #store: TaskStore
  readonly #now: () => string
  readonly #createId: () => string
  readonly #compose: (
    task: AirportPickupTaskState,
    toolResults?: ReadToolResults,
    preferences?: Record<string, MemberPreferenceRecord>,
    composeContext?: ComposeContext,
  ) => UISpec
  readonly #orchestrator: ReadToolOrchestration
  readonly #effectExecutor: EffectExecutor
  readonly #planner: Pick<Planner, 'plan'>
  readonly #runtime: SideEffectRuntime
  readonly #preferences: Record<string, MemberPreferenceRecord>
  readonly #mode: ProviderMode
  readonly #modelUsed: string | undefined
  readonly #prefetchedSchedule: ReadToolResults['calendar.query']

  constructor(options: AgentGatewayOptions = {}) {
    this.#store = options.store ?? new MemoryTaskStore()
    this.#mode = options.mode ?? 'fixture'
    this.#modelUsed = options.modelUsed
    this.#prefetchedSchedule = options.prefetchedSchedule
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId = options.createId ?? (() => crypto.randomUUID())
    const runtime = options.runtime ?? createSideEffectRuntime()
    if (!options.runtime && options.preferences) {
      for (const key of Object.keys(runtime.preferences)) delete runtime.preferences[key]
      for (const [memberId, record] of Object.entries(options.preferences)) {
        runtime.preferences[memberId] = { ...record }
      }
    }
    this.#runtime = runtime
    this.#preferences = runtime.preferences
    this.#compose = options.compose ?? composeAgentSpec
    const providers = enforceGatewayProviderMode(
      options.providers ?? createProviderRegistry(runtime, this.#mode === 'live' ? 'fixture' : this.#mode),
      this.#mode,
    )
    this.#orchestrator = options.orchestrator ?? new ReadToolOrchestrator({
      registry: providers,
    })
    this.#effectExecutor = new EffectExecutor(providers, options.policyGate)
    this.#planner = options.planner ?? new Planner()
  }

  createTask(input: CreateTaskRequest): AgentResponse {
    const startedAt = performance.now()
    const request = createTaskRequestSchema.parse(input)
    const existing = this.#store.getByClientRequestId(request.clientRequestId)
    if (existing) return this.#response(request.clientRequestId, existing, [], performance.now() - startedAt)
    const taskId = `pickup-${this.#createId()}`
    const timestamp = this.#now()
    let requestContext: NonNullable<StoredTask['requestContext']> = {
      vehicle: request.vehicleContext,
      clientCapabilities: request.clientCapabilities,
      // Only a destination the caller actually named. No 虹桥 default: which
      // airport this trip drives to is a consequence of the flight, and
      // #prepareTask fills this in once the flight has been read.
      ...(request.destination ? { destination: request.destination } : {}),
      ...(request.input.confidence === undefined ? {} : { inputConfidence: request.input.confidence }),
      updatedAt: timestamp,
    }
    if (request.input.confidence !== undefined && request.input.confidence < 0.6) {
      const stored = this.#store.create(this.#publish(createInitialTask(taskId, timestamp), {}, requestContext), request.clientRequestId)
      return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
    }
    let task = createInitialTask(taskId, timestamp)
    const plan = this.#planUserInput(request.input.text, task, `${request.clientRequestId}:input`, timestamp)
    const flightNumber = plan.slotUpdates.flightNumber
    const parsedPassengers = plan.slotUpdates.passengers
    if (parsedPassengers) {
      task = {
        ...task,
        passengers: parsedPassengers,
        message: { ...task.message, autoNotifyAuthorized: false },
      }
    }
    task = applyEvent(task, {
      eventId: `${request.clientRequestId}:input`,
      type: 'user.input',
      text: request.input.text,
      timestamp,
    }, this.#preferences, { userInputSlots: { passengers: parsedPassengers, flightNumber } })
    let toolResults: ReadToolResults = {}
    try {
      const labels = parsedPassengers?.names ?? []
      const passengerReads = this.#orchestrator.resolveInitialPassengers(taskId, request.clientRequestId, labels)
      task = {
        ...task,
        passengers: { ...passengerReads.passengers, confirmedOnboard: false },
        message: { ...task.message, autoNotifyAuthorized: passengerReads.notificationAuthorized },
      }
      toolResults = passengerReads.toolResults
      if (flightNumber && task.passengers.memberIds.length > 0) {
        const prepared = this.#prepareTask(task, request.clientRequestId, flightNumber, requestContext)
        task = prepared.task
        toolResults = { ...toolResults, ...prepared.toolResults }
        requestContext = { ...requestContext, destination: prepared.destination }
      }
      const boarded = this.#withArrivalsBoard(taskId, request.clientRequestId, task, toolResults)
      task = boarded.task
      toolResults = boarded.toolResults
      const stored = this.#store.create(this.#publish(task, toolResults, requestContext), request.clientRequestId)
      return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
    } catch (error) {
      if (error instanceof ReadToolOrchestrationError) {
        const stored = this.#store.create(
          this.#publishFallback(task, toolResults, error, undefined, requestContext),
          request.clientRequestId,
        )
        return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
      }
      this.#throwProviderError(error)
    }
  }

  getTask(taskId: string, requestId = this.#createId()): AgentResponse {
    const startedAt = performance.now()
    const stored = this.#requireTask(taskId)
    return this.#response(requestId, stored, [], performance.now() - startedAt)
  }

  getTaskUpdates(taskId: string, afterCursor?: number): TaskUpdateRead {
    this.#requireTask(taskId)
    return this.#store.readTaskUpdates(taskId, afterCursor)
  }

  hasCreateResult(clientRequestId: string): boolean {
    return this.#store.getByClientRequestId(clientRequestId) !== undefined
  }

  /**
   * Returns the state that may safely be sent to the optional model planner.
   * Replays, stale writes, and terminal tasks are resolved by submitEvent without
   * needing to disclose the caller's text to a model provider.
   */
  userInputPlanningState(taskId: string, input: SubmitEventRequest): AirportPickupTaskState | undefined {
    const request = submitEventRequestSchema.parse(input)
    if (request.event.type !== 'user.input') return undefined
    const current = this.#requireTask(taskId)
    if (this.#store.getEventResult(taskId, request.event.eventId)) return undefined
    if (request.expectedTaskRevision !== current.task.taskRevision) return undefined
    // A side answer that is still true is resolved from the store too, so planning
    // it would disclose the caller's text for a turn submitEvent never sends out.
    if (this.#freshSideAnswer(taskId, current, request.event.eventId)) return undefined
    if (current.task.phase === 'completed' || current.task.phase === 'cancelled') return undefined
    // No timestamp staleness check here: submitEvent clamps user input forward
    // (occupant intent is never stale), so gating planning on the raw client
    // stamp would skip the model for exactly the inputs that will still apply.
    return current.task
  }

  /**
   * Pre-transaction ordinal resolution for the persistent runtime: when this
   * user input is a whole-utterance board pick (第三个) and a board is on
   * screen, returns the flight-number text the ordinal means. The runtime
   * rewrites the request BEFORE planning, so the configured planner — model
   * seam included — interprets the rewritten words exactly as it would the
   * typed number; nothing about planning is bypassed. Returns undefined for
   * every other input, including replays this gateway resolves internally.
   */
  ordinalRewriteText(taskId: string, input: SubmitEventRequest): string | undefined {
    const request = submitEventRequestSchema.parse(input)
    if (request.event.type !== 'user.input') return undefined
    const current = this.#requireTask(taskId)
    if (this.#store.getEventResult(taskId, request.event.eventId)) return undefined
    if (current.task.phase !== 'collecting-information' || current.task.flight) return undefined
    const plan = planAirportPickup({ text: request.event.text })
    if (plan.intent !== 'pick-flight-choice' || plan.slotUpdates.flightChoiceOrdinal === undefined) return undefined
    const picked = this.#renderedArrivalRows(current, request.event.timestamp)?.[plan.slotUpdates.flightChoiceOrdinal - 1]
    return picked ? `航班号 ${picked.flightNumber}` : undefined
  }

  cancelTask(taskId: string, input: CancelTaskRequest): AgentResponse {
    const request = cancelTaskRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    return this.submitEvent(taskId, {
      clientRequestId: request.clientRequestId,
      expectedTaskRevision: request.expectedTaskRevision,
      event: {
        eventId: `cancel:${request.eventId}`,
        type: 'user.cancelled-task',
        ...(request.reason ? { reason: request.reason } : {}),
        timestamp: this.#eventTimestamp(current.task.updatedAt),
      },
    })
  }

  resetTask(taskId: string, input: ResetTaskRequest): AgentResponse {
    // Reset is a demo-replay affordance: it rewinds a task to its initial state and
    // reverts cabin settings and notification authorizations to get there. Against
    // live providers that is a write to the real world in service of a rehearsal, so
    // the operation is refused outright rather than made careful.
    //
    // First statement in the method, deliberately: ahead of the schema parse, the task
    // lookup, the idempotency replay, every compensation branch, and
    // resetSideEffectRuntimeTask. The refusal depends on nothing but this gateway's own
    // mode, so nothing needs to happen before it — including reading the store, which
    // is why the error carries no `latest` snapshot. A forbidden operation should not
    // answer with task state.
    if (this.#mode === 'live') {
      throw new AgentGatewayError('POLICY_DENIED', 'Task reset is not available in live provider mode', false)
    }
    const startedAt = performance.now()
    const request = resetTaskRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    const operation = 'task:reset'
    const previous = this.#store.getIdempotencyResult(taskId, operation, request.clientRequestId)
    if (previous) {
      return this.#response(request.clientRequestId, previous.stored, previous.effects, performance.now() - startedAt)
    }
    this.#assertRevisions(current, request.expectedTaskRevision)

    const activeCabin = current.effectReceipts?.activeCabin
    let effects: AgentResponse['effects'] = []
    let receiptsAfterResetCleanup = current.effectReceipts
    if (activeCabin && (activeCabin.state === 'applied' || activeCabin.state === 'deferred' || activeCabin.state === 'revert-failed')) {
      const policy = this.#effectExecutor.authorizeCabinRevert(current.task, current.requestContext?.vehicle)
      if (!policy.allowed && isDeferredCabinCleanup(policy.errorCode)) {
        effects = [cabinCleanupDeferredEffect(
          `${request.clientRequestId}:reset-cabin`,
          policy.errorCode,
        )]
        receiptsAfterResetCleanup = {
          ...current.effectReceipts,
          activeCabin: { ...activeCabin, state: 'deferred', lastErrorCode: policy.errorCode },
        }
      }
    }

    if (current.task.pendingConfirmation?.action === 'send-message') {
      const revocation = this.#effectExecutor.revokeLandingMessageConfirmation({
        task: current.task,
        confirmationId: current.task.pendingConfirmation.confirmationId,
        idempotencyKey: `${request.clientRequestId}:reset`,
        effectId: `${current.task.pendingConfirmation.confirmationId}:reset`,
      })
      effects = [revocation.effect]
      if (!revocation.succeeded) {
        const reconciled = revocation.ambiguous
          ? this.#store.save(this.#publish(
            { ...current.task, taskRevision: current.task.taskRevision + 1, pendingConfirmation: undefined },
            current.toolResults,
            current.requestContext,
            receiptsAfterResetCleanup,
          ))
          : receiptsAfterResetCleanup?.activeCabin?.state === 'deferred'
            // Preserve the public reset-failure snapshot while retaining private recovery state.
            ? this.#store.save({ ...current, effectReceipts: receiptsAfterResetCleanup })
          : current
        this.#store.recordIdempotencyResult(taskId, operation, request.clientRequestId, { stored: reconciled, effects })
        return this.#response(request.clientRequestId, reconciled, effects, performance.now() - startedAt)
      }
    }

    if (current.task.message.authorizationId) {
      const revocation = this.#effectExecutor.revokeLandingMessageAuthorization({
        task: current.task,
        authorizationId: current.task.message.authorizationId,
        idempotencyKey: `${request.clientRequestId}:reset-authorization`,
        effectId: `${current.task.message.authorizationId}:reset-authorization`,
      })
      effects = [...effects, revocation.effect]
      if (!revocation.succeeded) {
        const reconciled = revocation.ambiguous
          ? this.#store.save(this.#publish(
            {
              ...current.task,
              taskRevision: current.task.taskRevision + 1,
              message: { ...current.task.message, authorizationId: undefined },
            },
            current.toolResults,
            current.requestContext,
            receiptsAfterResetCleanup,
          ))
          : receiptsAfterResetCleanup?.activeCabin?.state === 'deferred'
            // Preserve the public reset-failure snapshot while retaining private recovery state.
            ? this.#store.save({ ...current, effectReceipts: receiptsAfterResetCleanup })
          : current
        this.#store.recordIdempotencyResult(taskId, operation, request.clientRequestId, { stored: reconciled, effects })
        return this.#response(request.clientRequestId, reconciled, effects, performance.now() - startedAt)
      }
    }

    if (effects.length === 0 && activeCabin && (activeCabin.state === 'applied' || activeCabin.state === 'deferred' || activeCabin.state === 'revert-failed')) {
      const cleanup = this.#effectExecutor.revertCabinProfile({
        task: current.task,
        cabinEffectId: activeCabin.providerEffectId,
        idempotencyKey: `${request.clientRequestId}:reset-cabin`,
        effectId: `${request.clientRequestId}:reset-cabin`,
        vehicle: current.requestContext?.vehicle,
      })
      effects = [...effects, cleanup.effect]
      if (!cleanup.succeeded) {
        const reconciled = cleanup.ambiguous
          ? this.#store.save(this.#publish({
              ...current.task,
              taskRevision: current.task.taskRevision + 1,
              updatedAt: this.#eventTimestamp(current.task.updatedAt),
              returnTrip: current.task.returnTrip
                ? {
                    ...current.task.returnTrip,
                    cabin: {
                      ...current.task.returnTrip.cabin,
                      revert: { status: 'unknown', errorCode: cleanup.effect.errorCode ?? 'PROVIDER_FAILED' },
                    },
                  }
                : current.task.returnTrip,
            }, current.toolResults, current.requestContext, {
              ...current.effectReceipts,
              activeCabin: { ...activeCabin, state: 'unknown', lastErrorCode: cleanup.effect.errorCode },
            }))
          : current
        this.#store.recordIdempotencyResult(taskId, operation, request.clientRequestId, { stored: reconciled, effects })
        return this.#response(request.clientRequestId, reconciled, effects, performance.now() - startedAt)
      }
    }

    if (receiptsAfterResetCleanup?.activeCabin?.state !== 'deferred') {
      resetSideEffectRuntimeTask(this.#runtime, taskId)
    }

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const initial = createInitialTask(taskId, timestamp)
    const resetTask: AirportPickupTaskState = {
      ...initial,
      taskRevision: current.task.taskRevision + 1,
      uiRevision: Math.max(current.task.uiRevision, current.ui.uiRevision),
    }
    const requestContext = current.requestContext
      ? {
          ...current.requestContext,
          inputConfidence: undefined,
          updatedAt: Date.parse(current.requestContext.updatedAt ?? timestamp) > Date.parse(timestamp)
            ? current.requestContext.updatedAt
            : timestamp,
        }
      : undefined
    const stored = this.#store.reset(this.#publish(resetTask, undefined, requestContext, receiptsAfterResetCleanup))
    this.#store.recordIdempotencyResult(taskId, operation, request.clientRequestId, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  submitEvent(taskId: string, input: SubmitEventRequest): AgentResponse {
    const startedAt = performance.now()
    const request = submitEventRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    if (request.event.type === 'navigation.started') {
      throw new AgentGatewayError('POLICY_DENIED', 'Navigation must be started through a registered action', false, current)
    }
    const previous = this.#store.getEventResult(taskId, request.event.eventId)
    if (previous) return this.#response(request.clientRequestId, previous.stored, previous.effects, performance.now() - startedAt)
    if (request.expectedTaskRevision !== current.task.taskRevision) {
      throw new AgentGatewayError(
        'TASK_REVISION_CONFLICT',
        `Expected task revision ${request.expectedTaskRevision}, received ${current.task.taskRevision}`,
        false,
        current,
      )
    }

    // Occupant intent is never stale relative to the task's own bookkeeping.
    // Async effect receipts stamp `updatedAt` with a wall clock fresher than the
    // one the cabin stamped this event with, and the reducer's freshness guard
    // would then swallow real input behind an OK response — under load the demo
    // player loses its final timeline steps exactly this way. Clamp forward,
    // the same way cancelTask stamps its synthesized cancel. Vehicle and
    // provider events keep their source timestamps: their ordering semantics
    // (a stale parked signal must lose to a newer moving one) are load-bearing.
    if (
      request.event.type === 'user.input'
      || request.event.type === 'user.confirmed-passengers-onboard'
      || request.event.type === 'destination.arrived'
    ) {
      request.event = { ...request.event, timestamp: this.#eventTimestamp(current.task.updatedAt) }
    }

    const deferredReceipt = current.effectReceipts?.activeCabin
    // A reset starts a new task but can retain an old cabin effect awaiting a
    // parked vehicle. Clean it up alongside (not instead of) this event.
    let resumedCleanupEffects: AgentResponse['effects'] = []
    let resumedCleanupReceipts = current.effectReceipts
    if (
      request.event.type === 'vehicle.parked'
      && current.task.phase === 'collecting-information'
      && deferredReceipt?.state === 'deferred'
    ) {
      const cleanup = this.#effectExecutor.revertCabinProfile({
        task: current.task,
        cabinEffectId: deferredReceipt.providerEffectId,
        idempotencyKey: `${request.event.eventId}:deferred-reset-cabin`,
        effectId: `${request.event.eventId}:deferred-reset-cabin`,
        vehicle: this.#contextAfterEvent(current.requestContext, request.event)?.vehicle,
        allowDeferredCleanup: true,
      })
      resumedCleanupEffects = [cleanup.effect]
      resumedCleanupReceipts = this.#deferredCleanupReceipts(current.effectReceipts, deferredReceipt, cleanup)
      if (cleanup.succeeded) resetSideEffectRuntimeTask(this.#runtime, taskId)
    } else {
      const deferredCleanup = this.#resumeDeferredCabinCleanup(taskId, current, request, startedAt)
      if (deferredCleanup) return deferredCleanup
    }

    let plan = request.event.type === 'user.input'
      ? this.#planUserInput(request.event.text, current.task, request.event.eventId, request.event.timestamp)
      : undefined
    // A spoken ordinal ("第三个") is a faster way to say a flight number, never
    // a second way to set the slot. Resolve it against the same pickable rows
    // the composer rendered, rewrite the event into the number's own words, and
    // fall through to the ordinary flight-number turn. No board, a board that is
    // no longer the set this rank was counted against, or a rank the board does
    // not have keeps the original text and lands on the unknown reply — the
    // reducer treats unparseable input as a no-op.
    if (
      request.event.type === 'user.input'
      && plan?.intent === 'pick-flight-choice'
      && plan.slotUpdates.flightChoiceOrdinal !== undefined
      && current.task.phase === 'collecting-information'
      && !current.task.flight
    ) {
      const rows = this.#renderedArrivalRows(current, request.event.timestamp)
      const picked = rows?.[plan.slotUpdates.flightChoiceOrdinal - 1]
      if (picked) {
        request.event = { ...request.event, text: `航班号 ${picked.flightNumber}` }
        // Re-plan through the configured planner, same as any user input: the
        // persistent runtime's plan stub recognizes rewritten text and falls
        // through to the rules, so a custom or model-backed planner keeps
        // interpreting ordinals exactly as it would the typed number.
        plan = this.#planUserInput(request.event.text, current.task, request.event.eventId, request.event.timestamp)
      }
    }
    // 刷新航班: only where a board could be on screen. Anywhere else the words
    // have nothing to refresh and stay on the ordinary unknown path.
    if (
      request.event.type === 'user.input'
      && plan?.intent === 'refresh-flight-options'
      && current.task.phase === 'collecting-information'
      && !current.task.flight
    ) {
      return this.#refreshFlightOptions(taskId, current, request, startedAt)
    }
    if (
      request.event.type === 'user.input'
      && (plan?.intent === 'check-weather' || plan?.intent === 'check-schedule' || plan?.intent === 'check-departure-time')
      && current.task.phase !== 'completed'
      && current.task.phase !== 'cancelled'
    ) {
      const replayed = this.#replaySideAnswer(taskId, current, request, startedAt)
      if (replayed) return replayed
      return plan.intent === 'check-weather'
        ? this.#submitWeatherQuery(taskId, current, request, startedAt)
        : plan.intent === 'check-schedule'
          ? this.#submitScheduleQuery(taskId, current, request, startedAt)
          : this.#submitDepartureQuery(taskId, current, request, startedAt)
    }
    // The two answers to the departure recommendation. Both need a departure to
    // be about — each handler's own guards decide that — so they ride the same
    // phase window as the question and stay unknown outside it. Only one of the
    // two is a transient answer: 稍后提醒 records something, so it replays off the
    // event log rather than off the side-answer contract, which is defined by the
    // task revision not having moved.
    if (
      request.event.type === 'user.input'
      && plan?.intent === 'remind-later'
      && current.task.phase !== 'completed'
      && current.task.phase !== 'cancelled'
    ) {
      return this.#armDepartureReminder(taskId, current, request, startedAt)
    }
    if (
      request.event.type === 'user.input'
      && plan?.intent === 'view-calendar'
      && current.task.phase !== 'completed'
      && current.task.phase !== 'cancelled'
    ) {
      const replayed = this.#replaySideAnswer(taskId, current, request, startedAt)
      if (replayed) return replayed
      return this.#submitCalendarView(taskId, current, request, startedAt)
    }
    // The two answers to the proactive advisory. Only a prompt still standing
    // gives these words their meaning; anywhere else they stay on the ordinary
    // unknown path and the reducer treats them as a no-op.
    //
    // The umbrella reminder names the weather because that is what it sends. The
    // dismissal does not, and asks `hasActiveAdvisory` instead — the same seam
    // that retires them — so a second kind of advisory becomes dismissible by
    // teaching that one function about it.
    if (
      request.event.type === 'user.input'
      && plan?.intent === 'send-weather-reminder'
      && current.task.weatherAdvisory?.status === 'active'
      && current.task.phase !== 'completed'
      && current.task.phase !== 'cancelled'
    ) {
      return this.#submitWeatherReminder(taskId, current, request, startedAt)
    }
    if (
      request.event.type === 'user.input'
      && plan?.intent === 'dismiss-advisory'
      && hasActiveAdvisory(current.task)
      && current.task.phase !== 'completed'
      && current.task.phase !== 'cancelled'
    ) {
      return this.#dismissAdvisory(taskId, current, request, startedAt)
    }
    let next = applyEvent(
      current.task,
      request.event,
      this.#preferences,
      plan ? { userInputSlots: {
        passengers: plan.slotUpdates.passengers,
        flightNumber: plan.slotUpdates.flightNumber,
      } } : undefined,
    )
    const taskChanged = JSON.stringify(next) !== JSON.stringify(current.task)
    const accepted = taskChanged
      || this.#acceptsContextOnlyEvent(current.task, current.requestContext, request.event)
    if (!accepted) {
      const stored = current
      this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
      return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
    }

    // Only revoke live capabilities after freshness and reducer acceptance checks.
    // A stale terminal event must not consume a credential that remains visible in state.
    let preEffects: AgentResponse['effects'] = resumedCleanupEffects
    let receiptsAfterTerminalCleanup = resumedCleanupReceipts
    const closesTask = request.event.type === 'user.cancelled-task'
      || request.event.type === 'destination.arrived'
      || (request.event.type === 'flight.updated' && request.event.flight.status === 'cancelled')
    const activeCabin = current.effectReceipts?.activeCabin
    if (closesTask && activeCabin && (activeCabin.state === 'applied' || activeCabin.state === 'deferred' || activeCabin.state === 'revert-failed')) {
      const policy = this.#effectExecutor.authorizeCabinRevert(current.task, current.requestContext?.vehicle)
      if (!policy.allowed && isDeferredCabinCleanup(policy.errorCode)) {
        preEffects = [cabinCleanupDeferredEffect(
          `${request.event.eventId}:terminal-cabin`,
          policy.errorCode,
        )]
        if (next.returnTrip) {
          next.returnTrip = {
            ...next.returnTrip,
            cabin: {
              ...next.returnTrip.cabin,
              revert: { status: 'failed', errorCode: policy.errorCode },
            },
          }
        }
        receiptsAfterTerminalCleanup = {
          ...current.effectReceipts,
          activeCabin: { ...activeCabin, state: 'deferred', lastErrorCode: policy.errorCode },
        }
      }
    }
    if (closesTask && preEffects.length === 0 && activeCabin && (activeCabin.state === 'applied' || activeCabin.state === 'deferred' || activeCabin.state === 'revert-failed')) {
      const cleanup = this.#effectExecutor.revertCabinProfile({
        task: current.task,
        cabinEffectId: activeCabin.providerEffectId,
        idempotencyKey: `${request.event.eventId}:terminal-cabin`,
        effectId: `${request.event.eventId}:terminal-cabin`,
        vehicle: current.requestContext?.vehicle,
      })
      preEffects = [cleanup.effect]
      if (!cleanup.succeeded) {
        const reconciled = cleanup.ambiguous
          ? this.#store.save(this.#publish({
              ...current.task,
              taskRevision: current.task.taskRevision + 1,
              updatedAt: this.#eventTimestamp(current.task.updatedAt),
              returnTrip: current.task.returnTrip
                ? {
                    ...current.task.returnTrip,
                    cabin: {
                      ...current.task.returnTrip.cabin,
                      revert: { status: 'unknown', errorCode: cleanup.effect.errorCode ?? 'PROVIDER_FAILED' },
                    },
                  }
                : current.task.returnTrip,
            }, current.toolResults, current.requestContext, {
              ...current.effectReceipts,
              activeCabin: { ...activeCabin, state: 'unknown', lastErrorCode: cleanup.effect.errorCode },
            }))
          : current
        this.#store.recordEventResult(taskId, request.event.eventId, { stored: reconciled, effects: preEffects })
        return this.#response(request.clientRequestId, reconciled, preEffects, performance.now() - startedAt)
      }
      if (next.returnTrip) {
        next.returnTrip = {
          ...next.returnTrip,
          cabin: { ...next.returnTrip.cabin, revert: { status: 'succeeded' } },
        }
      }
      receiptsAfterTerminalCleanup = {
        ...current.effectReceipts,
        activeCabin: { ...activeCabin, state: 'reverted', lastErrorCode: undefined },
      }
    }
    let cleanupTask = current.task
    const terminalEvent = request.event.type === 'user.cancelled-task'
      || (request.event.type === 'flight.updated' && request.event.flight.status === 'cancelled')
      || (request.event.type === 'message.failed' && current.task.message.pendingMessageId === request.event.messageId)
    if (terminalEvent && current.task.message.authorizationId) {
      const revocation = this.#effectExecutor.revokeLandingMessageAuthorization({
        task: current.task,
        authorizationId: current.task.message.authorizationId,
        idempotencyKey: `${request.event.eventId}:landing-authorization`,
        effectId: `${request.event.eventId}:landing-authorization`,
      })
      preEffects = [...preEffects, revocation.effect]
      if (!revocation.succeeded) {
        const cabinWasReverted = receiptsAfterTerminalCleanup?.activeCabin?.state === 'reverted'
          && current.effectReceipts?.activeCabin?.state !== 'reverted'
        const cleanupState = cabinWasReverted && cleanupTask.returnTrip
          ? {
              ...cleanupTask,
              taskRevision: cleanupTask.taskRevision + 1,
              updatedAt: this.#eventTimestamp(cleanupTask.updatedAt),
              returnTrip: {
                ...cleanupTask.returnTrip,
                cabin: { ...cleanupTask.returnTrip.cabin, revert: { status: 'succeeded' as const } },
              },
            }
          : cleanupTask
        const reconciled = revocation.ambiguous
          ? this.#store.save(this.#publish({
              ...cleanupState,
              taskRevision: cleanupState.taskRevision + 1,
              message: { ...cleanupState.message, authorizationId: undefined },
            }, current.toolResults, current.requestContext, receiptsAfterTerminalCleanup))
          : cleanupState === current.task
            ? current
            : this.#store.save(this.#publish(
                cleanupState,
                current.toolResults,
                current.requestContext,
                receiptsAfterTerminalCleanup,
              ))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored: reconciled, effects: preEffects })
        return this.#response(request.clientRequestId, reconciled, preEffects, performance.now() - startedAt)
      }
      cleanupTask = {
        ...cleanupTask,
        taskRevision: cleanupTask.taskRevision + 1,
        message: { ...cleanupTask.message, authorizationId: undefined },
      }
    }
    if (terminalEvent && current.task.pendingConfirmation?.action === 'send-message') {
      const revocation = this.#effectExecutor.revokeLandingMessageConfirmation({
        task: current.task,
        confirmationId: current.task.pendingConfirmation.confirmationId,
        idempotencyKey: `${request.event.eventId}:terminal-message`,
        effectId: `${current.task.pendingConfirmation.confirmationId}:terminal-message`,
      })
      preEffects = [...preEffects, revocation.effect]
      if (!revocation.succeeded) {
        const reconciledTask = revocation.ambiguous
          ? { ...cleanupTask, taskRevision: cleanupTask.taskRevision + 1, pendingConfirmation: undefined }
          : cleanupTask
        const stored = reconciledTask === current.task
          ? current
          : this.#store.save(this.#publish(
              reconciledTask,
              current.toolResults,
              current.requestContext,
              receiptsAfterTerminalCleanup,
            ))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: preEffects })
        return this.#response(request.clientRequestId, stored, preEffects, performance.now() - startedAt)
      }
      cleanupTask = { ...cleanupTask, taskRevision: cleanupTask.taskRevision + 1, pendingConfirmation: undefined }
    }
    if (terminalEvent && preEffects.length > 0) next = { ...next, pendingConfirmation: undefined }
    if (request.event.type === 'flight.updated' && request.event.flight.status === 'cancelled') {
      next = {
        ...next,
        message: {
          ...next.message,
          status: next.message.status === 'scheduled' ? 'cancelled' : next.message.status,
          pendingMessageId: undefined,
          pendingText: undefined,
          authorizationId: undefined,
        },
      }
    }
    let requestContext = this.#contextAfterEvent(current.requestContext, request.event)
    const effects = [
      ...preEffects,
      ...planEffects(current.task, request.event, current.toolResults ?? {}, this.#preferences),
    ]
    if (
      request.event.type === 'user.input'
      && current.task.phase === 'returning-home'
      && plan?.intent === 'apply-cabin-preferences'
    ) {
      const policy = this.#effectExecutor.authorizeReturnTrip(current.task, current.requestContext?.vehicle)
      if (!policy.allowed) {
        const effects: AgentResponse['effects'] = [{
          effectId: `${request.event.eventId}:0`,
          type: 'vehicle.apply-cabin-profile',
          status: 'failed',
          tool: 'vehicle.apply-cabin-profile',
          errorCode: policy.errorCode,
        }]
        this.#store.recordEventResult(taskId, request.event.eventId, { stored: current, effects })
        return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
      }
      let preferences: ReadToolResults['memory.get-preferences']
      try {
        preferences = this.#orchestrator.resolveReturnTripPreferences(
          taskId,
          request.clientRequestId,
          current.task.passengers.memberIds,
        )
      } catch (error) {
        if (error instanceof ReadToolOrchestrationError) {
          const stored = this.#store.save(this.#publishFallback(
            current.task,
            current.toolResults,
            error,
            undefined,
            current.requestContext,
            receiptsAfterTerminalCleanup,
          ))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
          return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
        }
        this.#throwProviderError(error, current)
      }
      const records = preferences.data.members
      const cabinMember = records.find((member) => member.rearTemperatureC !== undefined || member.mediaTitle !== undefined)
      const mediaMember = records.find((member) => member.mediaTitle !== undefined)
      let replacementEffects: AgentResponse['effects'] = []
      let cabinBaseTask = current.task
      let cabinBaseReceipts = current.effectReceipts
      const activeCabin = current.effectReceipts?.activeCabin
      if (activeCabin?.state === 'applied' || activeCabin?.state === 'revert-failed') {
        const replacement = this.#effectExecutor.revertCabinProfile({
          task: current.task,
          cabinEffectId: activeCabin.providerEffectId,
          idempotencyKey: `${request.event.eventId}:replace-cabin`,
          effectId: `${request.event.eventId}:replace-cabin`,
          vehicle: current.requestContext?.vehicle,
        })
        replacementEffects = [replacement.effect]
        if (!replacement.succeeded) {
          const replacementTask = replacement.ambiguous
            ? {
                ...current.task,
                taskRevision: current.task.taskRevision + 1,
                updatedAt: this.#eventTimestamp(current.task.updatedAt),
                returnTrip: current.task.returnTrip
                  ? {
                      ...current.task.returnTrip,
                      cabin: {
                        ...current.task.returnTrip.cabin,
                        revert: { status: 'unknown' as const, errorCode: replacement.effect.errorCode ?? 'PROVIDER_FAILED' },
                      },
                    }
                  : current.task.returnTrip,
              }
            : current.task
          const replacementReceipts = replacement.ambiguous
            ? {
                ...current.effectReceipts,
                activeCabin: { ...activeCabin, state: 'unknown' as const, lastErrorCode: replacement.effect.errorCode },
              }
            : current.effectReceipts
          const stored = replacementTask === current.task
            ? current
            : this.#store.save(this.#publish(replacementTask, current.toolResults, current.requestContext, replacementReceipts))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: replacementEffects })
          return this.#response(request.clientRequestId, stored, replacementEffects, performance.now() - startedAt)
        }
        cabinBaseTask = current.task.returnTrip
          ? {
              ...current.task,
              taskRevision: current.task.taskRevision + 1,
              updatedAt: this.#eventTimestamp(current.task.updatedAt),
              returnTrip: {
                ...current.task.returnTrip,
                cabin: { ...current.task.returnTrip.cabin, revert: { status: 'succeeded' as const } },
              },
            }
          : current.task
        cabinBaseReceipts = {
          ...current.effectReceipts,
          activeCabin: { ...activeCabin, state: 'reverted', lastErrorCode: undefined },
        }
      }
      const execution = this.#effectExecutor.applyCabinPreferences({
        task: current.task,
        memberIds: current.task.passengers.memberIds,
        temperatureC: cabinMember?.rearTemperatureC,
        mediaTitle: mediaMember?.mediaTitle,
        idempotencyKey: request.event.eventId,
        effectId: `${request.event.eventId}:0`,
        vehicle: current.requestContext?.vehicle,
      })
      if (!execution.succeeded) {
        const executionEffects = [...replacementEffects, execution.effect, ...(execution.compensationEffect ? [execution.compensationEffect] : [])]
        const residualTask = execution.residualApplied
          ? {
              ...cabinBaseTask,
              returnTrip: {
                workflowId: request.event.eventId,
                homeDestinationId: cabinBaseTask.returnTrip?.homeDestinationId,
                route: cabinBaseTask.returnTrip?.route ?? { status: 'succeeded' as const, routeId: cabinBaseTask.navigation?.routeId, eta: cabinBaseTask.navigation?.eta },
                cabin: {
                  status: 'succeeded' as const,
                  errorCode: 'COMPENSATION_FAILED',
                  revert: { status: 'available' as const },
                },
                media: cabinBaseTask.returnTrip?.media ?? { status: 'pending' as const },
              },
            }
          : cabinBaseTask
        const effectReceipts = execution.residualApplied && execution.cabinEffectId
          ? this.#appliedCabinReceipt(cabinBaseReceipts, request.event.eventId, execution.cabinEffectId)
          : cabinBaseReceipts
        const stored = this.#store.save(this.#publishFallback(
          residualTask,
          current.toolResults,
          new ReadToolOrchestrationError(
            execution.effect.errorCode === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_FAILED',
            `vehicle.apply-cabin-profile: ${execution.effect.errorCode ?? 'PROVIDER_FAILED'}`,
            execution.effect.errorCode === 'PROVIDER_TIMEOUT',
          ),
          undefined,
          current.requestContext,
          effectReceipts,
        ))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: executionEffects })
        return this.#response(request.clientRequestId, stored, executionEffects, performance.now() - startedAt)
      }
      const previousCabin = next.returnTrip?.cabin
      const cabinChanged = previousCabin?.status !== 'succeeded' || previousCabin.errorCode !== undefined
      const successfulTask = {
        ...cabinBaseTask,
        ...(cabinBaseTask.returnTrip ? {
          taskRevision: cabinBaseTask.taskRevision + (cabinChanged ? 1 : 0),
          returnTrip: {
            ...cabinBaseTask.returnTrip,
            cabin: { status: 'succeeded' as const, revert: { status: 'available' as const } },
          },
        } : {}),
      }
      const effectReceipts = execution.cabinEffectId
        ? this.#appliedCabinReceipt(cabinBaseReceipts, request.event.eventId, execution.cabinEffectId)
        : cabinBaseReceipts
      const stored = this.#store.save(this.#publish(successfulTask, {
        ...current.toolResults,
        'memory.get-preferences': preferences,
      }, requestContext, effectReceipts))
      const allEffects = [...replacementEffects, execution.effect]
      this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: allEffects })
      return this.#response(request.clientRequestId, stored, allEffects, performance.now() - startedAt)
    }
    if (request.event.type === 'message.sent') {
      if (current.task.message.pendingMessageId !== request.event.messageId) {
        throw new AgentGatewayError('INVALID_REQUEST', 'Message is not pending for this task', false, current)
      }
      const execution = this.#effectExecutor.sendLandingMessage({ task: current.task, idempotencyKey: current.task.message.idempotencyKey ?? request.event.eventId, effectId: `${request.event.eventId}:0` })
      if (!execution.succeeded) {
        const revokeAuthorization = current.task.message.authorizationId
          ? this.#effectExecutor.revokeLandingMessageAuthorization({
              task: current.task,
              authorizationId: current.task.message.authorizationId,
              idempotencyKey: `${request.event.eventId}:send-failed`,
              effectId: `${request.event.eventId}:send-failed`,
            })
          : undefined
        if (revokeAuthorization && !revokeAuthorization.succeeded && !execution.ambiguousApplied) {
          const failedEffects = [execution.effect, revokeAuthorization.effect]
          const reconciled = revokeAuthorization.ambiguous
            ? this.#store.save(this.#publish(applyEvent(current.task, {
                eventId: request.event.eventId,
                type: 'message.failed',
                messageId: request.event.messageId,
                errorCode: execution.effect.errorCode ?? 'SEND_FAILED',
                timestamp: request.event.timestamp,
              }, this.#preferences), current.toolResults, requestContext, current.effectReceipts))
            : current
          this.#store.recordEventResult(taskId, request.event.eventId, { stored: reconciled, effects: failedEffects })
          return this.#response(request.clientRequestId, reconciled, failedEffects, performance.now() - startedAt)
        }
        if (execution.ambiguousApplied) {
          const unknown = this.#store.save(this.#publish(applyEvent(current.task, {
            eventId: request.event.eventId,
            type: 'message.failed',
            messageId: request.event.messageId,
            errorCode: 'PROVIDER_FAILED',
            timestamp: request.event.timestamp,
          }, this.#preferences), current.toolResults, requestContext, current.effectReceipts))
          const ambiguousEffects = [execution.effect, ...(revokeAuthorization ? [revokeAuthorization.effect] : [])]
          this.#store.recordEventResult(taskId, request.event.eventId, { stored: unknown, effects: ambiguousEffects })
          return this.#response(request.clientRequestId, unknown, ambiguousEffects, performance.now() - startedAt)
        }
        const failed = this.#store.save(this.#publish(applyEvent(current.task, {
          eventId: request.event.eventId,
          type: 'message.failed',
          messageId: request.event.messageId,
          errorCode: execution.effect.errorCode ?? 'SEND_FAILED',
          timestamp: request.event.timestamp,
        }, this.#preferences), current.toolResults, requestContext, current.effectReceipts))
        const failedEffects = [execution.effect, ...(revokeAuthorization ? [revokeAuthorization.effect] : [])]
        this.#store.recordEventResult(taskId, request.event.eventId, { stored: failed, effects: failedEffects })
        return this.#response(request.clientRequestId, failed, failedEffects, performance.now() - startedAt)
      }
      const sent = this.#store.save(this.#publish(next, current.toolResults, requestContext, current.effectReceipts))
      this.#store.recordEventResult(taskId, request.event.eventId, { stored: sent, effects: [execution.effect] })
      return this.#response(request.clientRequestId, sent, [execution.effect], performance.now() - startedAt)
    }
    if (request.event.type === 'flight.updated' && request.event.flight.status === 'landed' && next.message.pendingContactId && next.message.pendingMessageId) {
      next.message.authorizationId = issueAutoNotifyAuthorization(this.#runtime, {
        taskId,
        contactId: next.message.pendingContactId,
        messageId: next.message.pendingMessageId,
        text: `我已到达机场接机点，航班 ${request.event.flight.flightNumber}，预计 ${next.navigation?.eta ?? request.event.flight.estimatedArrival} 会合。`,
      })
    }
    // The one proactive weather prompt of the trip. The IN-AIR flight update
    // while driving is the moment the arrival window firms up — early enough
    // for an umbrella reminder to be useful. A landed flight is past the
    // moment: prompting to warn about arrival rain after the passenger has
    // arrived would be advice about the past, so no other status triggers.
    // Rain over the arrival sets the advisory once; dismissed or resolved it
    // never returns, and a failed read costs the driver a prompt, never the
    // turn. The reading is PERSISTED (unlike the transient query card) — the
    // advisory card must survive every recompose until the driver answers it.
    let advisoryWeather: ReadToolResults['weather.advisory']
    if (
      request.event.type === 'flight.updated'
      && request.event.flight.status === 'in-air'
      && next.phase === 'driving-to-airport'
      && next.weatherAdvisory === undefined
      && next.flight
      && next.flight.status === 'in-air'
      && next !== current.task
    ) {
      try {
        // Rain has to be read over the airport the car is driving to. The trip's
        // settled destination is the first source; a flight that knows its own
        // airport is the second, for a task prepared before this field existed.
        // Without either there is no place to ask about, so the advisory is
        // skipped — an umbrella warning about 虹桥 while the family lands at
        // 浦东 is worse than no warning at all.
        const locationId = requestContext?.destination?.id
          ?? (next.flight.arrivalAirport ? pickupDestinationForAirport(next.flight.arrivalAirport).id : undefined)
        const reading = locationId === undefined ? undefined : this.#orchestrator.resolveWeather?.(taskId, `${request.clientRequestId}:advisory`, {
          locationId,
          at: next.flight.estimatedArrival,
        })
        const raining = reading?.data.condition === 'light-rain' || reading?.data.condition === 'heavy-rain'
        if (raining) {
          next = { ...next, weatherAdvisory: { status: 'active', advisedAt: this.#now() } }
          advisoryWeather = reading
        }
      } catch {
        // A weather provider failure must never take down the flight update.
      }
    }
    let toolResults = advisoryWeather
      ? { ...current.toolResults, 'weather.advisory': advisoryWeather }
      : current.toolResults
    const flightNumber = plan?.slotUpdates.flightNumber
    const parsedPassengers = plan?.slotUpdates.passengers
    try {
      if (request.event.type === 'user.input' && parsedPassengers) {
        const mergedPassengers = mergePassengers(current.task.passengers, parsedPassengers)
        const passengerReads = this.#orchestrator.resolveInitialPassengers(
          taskId,
          request.clientRequestId,
          mergedPassengers.names,
        )
        const resolvedPassengers = mergePassengers(current.task.passengers, passengerReads.passengers)
        const changedByResolution = JSON.stringify(next.passengers) !== JSON.stringify(resolvedPassengers)
          || next.message.autoNotifyAuthorized !== passengerReads.notificationAuthorized
        next.passengers = resolvedPassengers
        next.message = { ...next.message, autoNotifyAuthorized: passengerReads.notificationAuthorized }
        toolResults = { ...toolResults, ...passengerReads.toolResults }
        if (next.flight && next.phase === 'collecting-information') next.phase = 'preparing'
        if (changedByResolution && next.taskRevision === current.task.taskRevision) {
          next.taskRevision += 1
        }
      }
    } catch (error) {
      if (error instanceof ReadToolOrchestrationError) {
        const stored = this.#store.save(this.#publishFallback(
          current.task,
          current.toolResults,
          error,
          undefined,
          current.requestContext,
          current.effectReceipts,
        ))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
        return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
      }
      this.#throwProviderError(error, current)
    }
    let boarded = this.#withArrivalsBoard(taskId, request.clientRequestId, next, toolResults)
    next = boarded.task
    toolResults = boarded.toolResults
    const shouldPrepare = request.event.type === 'user.input'
      && next !== current.task
      && next.phase === 'preparing'
      && next.passengers.memberIds.length > 0
      && (
        current.task.phase !== 'preparing'
        || current.task.passengers.memberIds.length !== next.passengers.memberIds.length
        || current.task.flight?.flightNumber !== next.flight?.flightNumber
        || flightNumber !== undefined
      )
    if (shouldPrepare) {
      try {
        const prepared = this.#prepareTask(next, request.clientRequestId, next.flight!.flightNumber, requestContext)
        next = prepared.task
        toolResults = { ...toolResults, ...prepared.toolResults }
        requestContext = requestContext
          ? { ...requestContext, destination: prepared.destination }
          : requestContext
      } catch (error) {
        if (error instanceof ReadToolOrchestrationError) {
          const stored = this.#store.save(this.#publishFallback(
            current.task,
            current.toolResults,
            error,
            undefined,
            current.requestContext,
            receiptsAfterTerminalCleanup,
          ))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
          return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
        }
        this.#throwProviderError(error, current)
      }
    }
    boarded = this.#withArrivalsBoard(taskId, request.clientRequestId, next, toolResults)
    next = boarded.task
    toolResults = boarded.toolResults
    if (
      request.event.type === 'user.confirmed-passengers-onboard'
      && (current.task.phase === 'waiting-for-passengers' || current.task.phase === 'returning-home')
      && next.phase === 'returning-home'
    ) {
      const policy = this.#effectExecutor.authorizeReturnTrip(next, current.requestContext?.vehicle)
      if (!policy.allowed) {
        const effects: AgentResponse['effects'] = [{
          effectId: `${request.event.eventId}:effect:0`,
          type: 'return-trip',
          status: 'failed',
          tool: 'return-trip',
          errorCode: policy.errorCode,
        }]
        this.#store.recordEventResult(taskId, request.event.eventId, { stored: current, effects })
        return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
      }
      try {
        const preferences = this.#orchestrator.resolveReturnTripPreferences(
          taskId,
          request.clientRequestId,
          next.passengers.memberIds,
        )
        toolResults = { ...toolResults, 'memory.get-preferences': preferences }
        const records = preferences.data.members
        const homeDestinationId = records.find((member) => member.homeDestinationId)?.homeDestinationId
        const cabinMember = records.find((member) => member.rearTemperatureC !== undefined || member.mediaTitle !== undefined)
        const mediaMember = records.find((member) => member.mediaTitle !== undefined)
        const execution = this.#effectExecutor.executeReturnTrip({
          task: next,
          memberIds: next.passengers.memberIds,
          preferences: {
            homeDestinationId,
            temperatureC: cabinMember?.rearTemperatureC,
            mediaTitle: mediaMember?.mediaTitle,
            mediaMemberId: mediaMember?.memberId,
          },
          rollbackNavigation: this.#rollbackNavigation(current),
          idempotencyKey: request.event.eventId,
          effectIdPrefix: `${request.event.eventId}:effect`,
          completed: next.returnTrip ? {
            route: next.returnTrip.route.status === 'succeeded',
            cabin: next.returnTrip.cabin.status === 'succeeded',
            media: next.returnTrip.media.status === 'succeeded',
            cabinEffectId: current.effectReceipts?.activeCabin?.state === 'applied'
              ? current.effectReceipts.activeCabin.providerEffectId
              : undefined,
          } : undefined,
          vehicle: current.requestContext?.vehicle,
        })
        const policyDenied = !execution.succeeded
          && execution.effect.length === 1
          && execution.effect[0]?.type === 'return-trip'
          && returnTripPolicyErrorCodes.has(execution.effect[0]?.errorCode ?? '')
        if (policyDenied) {
          this.#store.recordEventResult(taskId, request.event.eventId, { stored: current, effects: execution.effect })
          return this.#response(request.clientRequestId, current, execution.effect, performance.now() - startedAt)
        }
        if (!execution.succeeded) {
          const failedTask = execution.rolledBack
            ? current.task
            : this.#applyReturnTripExecution(next, request.event.eventId, homeDestinationId, execution)
          const stored = this.#store.save(this.#publishReturnTripFailure(
            current,
            current.toolResults,
            request.event.eventId,
            undefined,
            failedTask,
            execution.cabinEffectIsNew && execution.cabinEffectId
              ? this.#appliedCabinReceipt(current.effectReceipts, request.event.eventId, execution.cabinEffectId)
              : current.effectReceipts,
          ))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: execution.effect })
          return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
        }
        next = this.#applyReturnTripExecution(next, request.event.eventId, homeDestinationId, execution)
        next.uiRevision = Math.max(next.uiRevision, current.ui.uiRevision)
        const effectReceipts = execution.cabinEffectIsNew && execution.cabinEffectId
          ? this.#appliedCabinReceipt(current.effectReceipts, request.event.eventId, execution.cabinEffectId)
          : current.effectReceipts
        const stored = this.#store.save(this.#publish(next, toolResults, requestContext, effectReceipts))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: execution.effect })
        return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
      } catch (error) {
        if (error instanceof ReadToolOrchestrationError) {
          const stored = this.#store.save(this.#publishReturnTripFailure(
            current,
            current.toolResults,
            request.event.eventId,
            error,
          ))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
          return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
        }
        this.#throwProviderError(error, current)
      }
    }
    if (request.event.type === 'destination.arrived' && current.task.phase === 'returning-home' && next.phase === 'completed') {
      const memberId = next.passengers.memberIds.find((candidate) => this.#preferences[candidate]?.rearTemperatureC !== undefined)
      if (!memberId) {
        next.pendingConfirmation = undefined
        next.memoryProposal = { status: 'skipped', errorCode: 'PREFERENCE_UNAVAILABLE' }
        const stored = this.#store.save(this.#publish(next, toolResults, requestContext, receiptsAfterTerminalCleanup))
        const skipped: AgentResponse['effects'] = [{ effectId: `${request.event.eventId}:0`, type: 'memory.propose-update', status: 'cancelled', tool: 'memory.propose-update', errorCode: 'PREFERENCE_UNAVAILABLE' }]
        const completedEffects = [...preEffects, ...skipped]
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: completedEffects })
        return this.#response(request.clientRequestId, stored, completedEffects, performance.now() - startedAt)
      }
      const proposal = this.#effectExecutor.proposeMemoryUpdate({
        task: next,
        memberId,
        changes: { rearTemperatureC: this.#preferences[memberId]!.rearTemperatureC! },
        requestId: request.event.eventId,
        effectId: `${request.event.eventId}:0`,
      })
      if (!proposal.succeeded || !proposal.proposal) {
        const stored = this.#store.save(this.#publish({
          ...next,
          memoryProposal: { status: 'failed', errorCode: proposal.effect.errorCode ?? 'PROVIDER_FAILED' },
          pendingConfirmation: undefined,
        }, toolResults, requestContext, receiptsAfterTerminalCleanup))
        const failedEffects = [...preEffects, proposal.effect]
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: failedEffects })
        return this.#response(request.clientRequestId, stored, failedEffects, performance.now() - startedAt)
      }
      next.memoryProposal = {
        proposalId: proposal.proposal.proposalId,
        memberId: proposal.proposal.memberId,
        confirmationId: proposal.proposal.confirmationId,
        expiresAt: proposal.proposal.expiresAt,
        changes: { rearTemperatureC: this.#preferences[memberId]!.rearTemperatureC! },
        status: 'pending',
      }
      next.pendingConfirmation = {
        confirmationId: proposal.proposal.confirmationId,
        action: 'save-memory',
        expiresAt: proposal.proposal.expiresAt,
      }
      const stored = this.#store.save(this.#publish(next, toolResults, requestContext, receiptsAfterTerminalCleanup))
      const proposalEffects = [...preEffects, proposal.effect]
      this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: proposalEffects })
      return this.#response(request.clientRequestId, stored, proposalEffects, performance.now() - startedAt)
    }
    const stored = this.#store.save(this.#publish(next, toolResults, requestContext, receiptsAfterTerminalCleanup))
    const effectRecords = effects.map((effect, index) => ({ ...effect, effectId: `${request.event.eventId}:${index}` }))
    this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: effectRecords })
    return this.#response(
      request.clientRequestId,
      stored,
      effectRecords,
      performance.now() - startedAt,
    )
  }

  submitAction(taskId: string, input: SubmitActionRequest): AgentResponse {
    const startedAt = performance.now()
    const request = submitActionRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    const operation = `action:${request.actionId}:${request.componentId}`
    const previous = this.#store.getIdempotencyResult(taskId, operation, request.idempotencyKey)
    if (previous) return this.#response(request.clientRequestId, previous.stored, previous.effects, performance.now() - startedAt)
    this.#assertRevisions(current, request.expectedTaskRevision, request.expectedUiRevision)
    if (request.actionId === RETRY_LANDING_MESSAGE_ACTION_ID) {
      return this.#submitRetryLandingMessage(taskId, current, request, operation, startedAt)
    }

    if (request.actionId === 'retry-return-trip') {
      return this.#submitRetryReturnTrip(taskId, current, request, operation, startedAt)
    }

    if (request.actionId === 'revert-cabin-profile') {
      return this.#submitRevertCabinProfile(taskId, current, request, operation, startedAt)
    }

    const action = current.ui.actions.find((candidate) => candidate.id === request.actionId)
    const component = current.ui.components.find((candidate) => candidate.id === request.componentId)
    if (
      action?.event.type !== 'tool-request'
      || action.event.actionToken !== 'start-navigation'
      || request.actionId !== 'start-navigation'
      || component?.id !== 'navigation-plan'
      || !component?.actions?.includes(request.actionId)
      || !current.toolResults?.['navigation.plan-route']
    ) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Action is not registered for the current task state', false, current)
    }

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const event = {
      eventId: `action:${request.idempotencyKey}`,
      type: 'navigation.started' as const,
      routeId: current.toolResults['navigation.plan-route'].data.routeId,
      timestamp,
    }
    const execution = this.#effectExecutor.startNavigation({
      task: current.task,
      routeId: event.routeId,
      idempotencyKey: request.idempotencyKey,
      effectId: `${event.eventId}:0`,
      vehicle: current.requestContext?.vehicle ?? current.toolResults?.['vehicle.get-status']?.data,
    })
    const stored = execution.succeeded
      ? this.#store.save(this.#publish(
          applyEvent(current.task, event, this.#preferences),
          current.toolResults,
          current.requestContext,
          current.effectReceipts,
        ))
      : current
    const effectRecords = [execution.effect]
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects: effectRecords })
    return this.#response(request.clientRequestId, stored, effectRecords, performance.now() - startedAt)
  }

  submitConfirmation(taskId: string, confirmationId: string, input: SubmitConfirmationRequest): AgentResponse {
    const startedAt = performance.now()
    const request = submitConfirmationRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    const operation = `confirmation:${confirmationId}:${request.decision}`
    const previous = this.#store.getIdempotencyResult(taskId, operation, request.idempotencyKey)
    if (previous) return this.#response(request.clientRequestId, previous.stored, previous.effects, performance.now() - startedAt)
    this.#assertRevisions(current, request.expectedTaskRevision)

    const pending = current.task.pendingConfirmation
    if (!pending || pending.confirmationId !== confirmationId) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current confirmation is available', false, current)
    }
    if (pending.action === 'send-message') {
      if (pending.expiresAt && Date.parse(pending.expiresAt) < Date.parse(this.#now())) {
        throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'The confirmation has expired', false, current)
      }
      return this.#submitSendMessageConfirmation(taskId, confirmationId, current, request, operation, startedAt)
    }

    if (pending.action !== 'save-memory') {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current save-memory confirmation is available', false, current)
    }

    const proposal = current.task.memoryProposal
    if (!proposal?.proposalId || proposal.confirmationId !== confirmationId || proposal.status !== 'pending') {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current memory proposal is available', false, current)
    }
    if (pending.expiresAt && Date.parse(pending.expiresAt) < Date.parse(this.#now())) {
      const expiration = this.#effectExecutor.rejectMemoryUpdate({
        task: current.task,
        proposalId: proposal.proposalId,
        confirmationId,
        idempotencyKey: `${request.idempotencyKey}:expired`,
        effectId: `${confirmationId}:expired`,
      })
      if (!expiration.succeeded) {
        const effects = [expiration.effect]
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
        return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
      }
      const expired = {
        ...current.task,
        memoryProposal: { ...proposal, status: 'expired' as const, errorCode: 'PROPOSAL_EXPIRED' },
        pendingConfirmation: undefined,
        taskRevision: current.task.taskRevision + 1,
        updatedAt: this.#eventTimestamp(current.task.updatedAt),
      }
      const effects: AgentResponse['effects'] = [{ ...expiration.effect, status: 'failed', errorCode: 'PROPOSAL_EXPIRED' }]
      const stored = this.#store.save(this.#publish(
        expired,
        current.toolResults,
        current.requestContext,
        current.effectReceipts,
      ))
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
      return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
    }

    let effects: AgentResponse['effects']
    let next: AirportPickupTaskState
    if (request.decision === 'reject') {
      const rejection = this.#effectExecutor.rejectMemoryUpdate({
        task: current.task,
        proposalId: proposal.proposalId,
        confirmationId,
        idempotencyKey: request.idempotencyKey,
        effectId: `${confirmationId}:reject`,
      })
      if (!rejection.succeeded) {
        effects = [rejection.effect]
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
        return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
      }
      next = {
        ...current.task,
        memoryProposal: { ...proposal, status: 'rejected' },
        pendingConfirmation: undefined,
        taskRevision: current.task.taskRevision + 1,
        updatedAt: this.#eventTimestamp(current.task.updatedAt),
      }
      effects = [rejection.effect]
    } else {
      const execution = this.#effectExecutor.confirmMemoryUpdate({
        task: current.task,
        proposalId: proposal.proposalId,
        confirmationId,
        memberId: proposal.memberId ?? '',
        changes: proposal.changes ?? {},
        idempotencyKey: request.idempotencyKey,
        effectId: `${confirmationId}:confirm`,
      })
      if (!execution.succeeded) {
        const errorCode = execution.errorCode ?? 'PROVIDER_FAILED'
        const expired = errorCode === 'PROPOSAL_EXPIRED'
        const failed = {
          ...current.task,
          memoryProposal: { ...proposal, status: expired ? 'expired' as const : 'pending' as const, errorCode },
          ...(expired ? { pendingConfirmation: undefined } : {}),
          taskRevision: current.task.taskRevision + 1,
          updatedAt: this.#eventTimestamp(current.task.updatedAt),
        }
        effects = [execution.effect]
        const stored = this.#store.save(this.#publish(
          failed,
          current.toolResults,
          current.requestContext,
          current.effectReceipts,
        ))
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
        return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
      }
      next = {
        ...current.task,
        memoryProposal: { ...proposal, status: 'accepted', errorCode: undefined },
        pendingConfirmation: undefined,
        taskRevision: current.task.taskRevision + 1,
        updatedAt: this.#eventTimestamp(current.task.updatedAt),
      }
      effects = [execution.effect]
    }
    const stored = this.#store.save(this.#publish(
      next,
      current.toolResults,
      current.requestContext,
      current.effectReceipts,
    ))
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #submitRetryLandingMessage(
    taskId: string,
    current: StoredTask,
    request: SubmitActionRequest,
    operation: string,
    startedAt: number,
  ): AgentResponse {
    const action = current.ui.actions.find((candidate) => candidate.id === request.actionId)
    const component = current.ui.components.find((candidate) => candidate.id === request.componentId)
    const expectedToken = retryLandingMessageActionToken(current.task.taskId)
    if (
      current.task.message.status !== 'failed'
      || request.componentId !== 'message-preview'
      || action?.event.type !== 'tool-request'
      || action.event.actionToken !== expectedToken
      || !component?.actions?.includes(RETRY_LANDING_MESSAGE_ACTION_ID)
      || current.task.pendingConfirmation?.action === 'send-message'
    ) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Retry landing-message action is not registered for the current task state', false, current)
    }

    const contactId = resolveAuthorizedLandingContact(current.task.passengers.memberIds, this.#preferences)
    if (!contactId) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Landing-message retry is not available for the current authorization state', false, current)
    }

    const execution = this.#effectExecutor.prepareLandingMessageRetry({
      task: current.task,
      contactId,
      idempotencyKey: request.idempotencyKey,
      effectId: `action:${request.idempotencyKey}:0`,
    })
    if (!execution.succeeded || !execution.prepared) {
      const effects = [execution.effect]
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
      return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
    }

    const armed = armLandingMessageRetry(current.task, execution.prepared)
    if (!armed) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Landing-message retry is not available for the current task state', false, current)
    }

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const stored = this.#store.save(this.#publish(
      { ...armed, updatedAt: timestamp },
      current.toolResults,
      current.requestContext,
      current.effectReceipts,
    ))
    const effects: AgentResponse['effects'] = [execution.effect]
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #submitRetryReturnTrip(
    taskId: string,
    current: StoredTask,
    request: SubmitActionRequest,
    operation: string,
    startedAt: number,
  ): AgentResponse {
    const action = current.ui.actions.find((candidate) => candidate.id === request.actionId)
    const component = current.ui.components.find((candidate) => candidate.id === request.componentId)
    const actionToken = action?.event.type === 'tool-request' ? action.event.actionToken : undefined
    const workflowId = actionToken?.startsWith(`${current.task.taskId}:retry-return-trip:`)
      ? actionToken.slice(`${current.task.taskId}:retry-return-trip:`.length)
      : current.task.returnTrip?.workflowId
    if (
      (current.task.phase !== 'waiting-for-passengers' && current.task.phase !== 'returning-home')
      || !workflowId
      || action?.event.type !== 'tool-request'
      || (
        action.event.actionToken !== this.#returnTripRetryActionToken(current.task.taskId, workflowId)
        && action.event.actionToken !== `${current.task.taskId}:retry-return-trip`
      )
      || !component?.actions?.includes('retry-return-trip')
    ) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Retry return-trip action is not registered for the current task state', false, current)
    }

    const executionTask = current.task.phase === 'waiting-for-passengers'
      ? applyEvent(current.task, {
          eventId: workflowId,
          type: 'user.confirmed-passengers-onboard',
          timestamp: this.#eventTimestamp(current.task.updatedAt),
        }, this.#preferences)
      : current.task
    const policy = this.#effectExecutor.authorizeReturnTrip(executionTask, current.requestContext?.vehicle)
    if (!policy.allowed) {
      const effects: AgentResponse['effects'] = [{
        effectId: `${workflowId}:retry:${request.idempotencyKey}:0`,
        type: 'return-trip',
        status: 'failed',
        tool: 'return-trip',
        errorCode: policy.errorCode,
      }]
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
      return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
    }

    let preferences
    try {
      preferences = this.#orchestrator.resolveReturnTripPreferences(taskId, request.clientRequestId, current.task.passengers.memberIds)
    } catch (error) {
      if (error instanceof ReadToolOrchestrationError) {
        const stored = this.#store.save(this.#publishReturnTripFailure(
          current,
          current.toolResults,
          workflowId,
          error,
        ))
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects: [] })
        return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
      }
      this.#throwProviderError(error, current)
    }
    const records = preferences.data.members
    const homeDestinationId = records.find((member) => member.homeDestinationId)?.homeDestinationId ?? current.task.returnTrip?.homeDestinationId
    const cabinMember = records.find((member) => member.rearTemperatureC !== undefined || member.mediaTitle !== undefined)
    const mediaMember = records.find((member) => member.mediaTitle !== undefined)
    const execution = this.#effectExecutor.executeReturnTrip({
      task: executionTask,
      memberIds: executionTask.passengers.memberIds,
      preferences: {
        homeDestinationId,
        temperatureC: cabinMember?.rearTemperatureC,
        mediaTitle: mediaMember?.mediaTitle,
        mediaMemberId: mediaMember?.memberId,
      },
      rollbackNavigation: this.#rollbackNavigation(current),
      idempotencyKey: `${workflowId}:retry:${request.idempotencyKey}`,
      effectIdPrefix: `${workflowId}:retry:${request.idempotencyKey}`,
      completed: current.task.returnTrip ? {
        route: current.task.returnTrip.route.status === 'succeeded',
        cabin: current.task.returnTrip.cabin.status === 'succeeded',
        media: current.task.returnTrip.media.status === 'succeeded',
        cabinEffectId: current.effectReceipts?.activeCabin?.state === 'applied'
          ? current.effectReceipts.activeCabin.providerEffectId
          : undefined,
      } : undefined,
      vehicle: current.requestContext?.vehicle,
    })
    if (!execution.succeeded) {
      const policyDenied = execution.effect.length === 1
        && execution.effect[0]?.type === 'return-trip'
        && returnTripPolicyErrorCodes.has(execution.effect[0]?.errorCode ?? '')
      if (policyDenied) {
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects: execution.effect })
        return this.#response(request.clientRequestId, current, execution.effect, performance.now() - startedAt)
      }
      const failedTask = execution.rolledBack
        ? current.task
        : this.#applyReturnTripExecution(executionTask, workflowId, homeDestinationId, execution)
      const stored = this.#store.save(this.#publishReturnTripFailure(
        current,
        current.toolResults,
        workflowId,
        undefined,
        failedTask,
        execution.cabinEffectIsNew && execution.cabinEffectId
          ? this.#appliedCabinReceipt(current.effectReceipts, workflowId, execution.cabinEffectId)
          : current.effectReceipts,
      ))
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects: execution.effect })
      return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
    }
    const executedTask = this.#applyReturnTripExecution(executionTask, workflowId, homeDestinationId, execution)
    const next = {
      ...executedTask,
      uiRevision: Math.max(executionTask.uiRevision, current.ui.uiRevision),
    }
    const effectReceipts = execution.cabinEffectIsNew && execution.cabinEffectId
      ? this.#appliedCabinReceipt(current.effectReceipts, workflowId, execution.cabinEffectId)
      : current.effectReceipts
    const stored = this.#store.save(this.#publish(
      next,
      { ...current.toolResults, 'memory.get-preferences': preferences },
      current.requestContext,
      effectReceipts,
    ))
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects: execution.effect })
    return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
  }

  #submitRevertCabinProfile(
    taskId: string,
    current: StoredTask,
    request: SubmitActionRequest,
    operation: string,
    startedAt: number,
  ): AgentResponse {
    const receipt = current.effectReceipts?.activeCabin
    const action = current.ui.actions.find((candidate) => candidate.id === request.actionId)
    const component = current.ui.components.find((candidate) => candidate.id === request.componentId)
    const actionToken = receipt ? this.#cabinRevertActionToken(taskId, receipt.receiptId) : undefined
    if (
      !receipt
      || receipt.state === 'reverted'
      || action?.event.type !== 'tool-request'
      || action.event.actionToken !== actionToken
      || !component?.actions?.includes(request.actionId)
    ) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Action is not registered for the current cabin state', false, current)
    }

    const providerIdempotencyKey = `${receipt.receiptId}:revert:${request.idempotencyKey}`
    const execution = this.#effectExecutor.revertCabinProfile({
      task: current.task,
      cabinEffectId: receipt.providerEffectId,
      idempotencyKey: providerIdempotencyKey,
      effectId: `action:${request.idempotencyKey}:0`,
      vehicle: current.requestContext?.vehicle,
    })
    const effects = [execution.effect]
    if (!execution.succeeded) {
      if (isCabinRevertPolicyDenial(execution.effect.errorCode)) {
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
        return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
      }
      const shouldReconcile = execution.ambiguous === true
      const state = shouldReconcile ? 'unknown' as const : 'revert-failed' as const
      const nextTask = {
        ...current.task,
        taskRevision: current.task.taskRevision + 1,
        updatedAt: this.#eventTimestamp(current.task.updatedAt),
        returnTrip: current.task.returnTrip
          ? {
              ...current.task.returnTrip,
              cabin: {
                ...current.task.returnTrip.cabin,
                revert: {
                  status: shouldReconcile ? 'unknown' as const : 'failed' as const,
                  errorCode: execution.effect.errorCode ?? 'PROVIDER_FAILED',
                },
              },
            }
          : current.task.returnTrip,
      }
      const stored = this.#store.save(this.#publish(
        nextTask,
        current.toolResults,
        current.requestContext,
        {
          ...current.effectReceipts,
          activeCabin: { ...receipt, state, lastErrorCode: execution.effect.errorCode },
        },
      ))
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
      return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
    }

    const next: AirportPickupTaskState = {
      ...current.task,
      taskRevision: current.task.taskRevision + 1,
      updatedAt: this.#eventTimestamp(current.task.updatedAt),
      returnTrip: current.task.returnTrip
        ? {
            ...current.task.returnTrip,
            cabin: {
              ...current.task.returnTrip.cabin,
              revert: { status: 'succeeded' },
            },
          }
        : current.task.returnTrip,
    }
    const stored = this.#store.save(this.#publish(
      next,
      current.toolResults,
      current.requestContext,
      {
        ...current.effectReceipts,
        activeCabin: { ...receipt, state: 'reverted', lastErrorCode: undefined },
      },
    ))
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #returnTripState(
    task: AirportPickupTaskState,
    workflowId: string,
    homeDestinationId: string | undefined,
    execution: ReturnType<EffectExecutor['executeReturnTrip']>,
  ): ReturnTripState {
    const existing = task.returnTrip
    const failed = (tool: string) => execution.effect.find((effect) => effect.tool === tool && effect.status === 'failed')?.errorCode
    return {
      workflowId,
      homeDestinationId: homeDestinationId ?? existing?.homeDestinationId,
      route: execution.residual.route && execution.navigation
        ? { status: 'succeeded', routeId: execution.navigation.routeId, eta: execution.navigation.eta }
        : { ...(existing?.route ?? { status: 'pending' }), ...(failed('navigation.update-route') ? { status: 'failed' as const, errorCode: failed('navigation.update-route') } : {}) },
      cabin: {
        status: execution.applied.cabin
          ? 'succeeded'
          : execution.skipped.cabin
            ? 'skipped'
            : (failed('vehicle.apply-cabin-profile') ? 'failed' : 'pending'),
        ...(failed('vehicle.apply-cabin-profile') ? { errorCode: failed('vehicle.apply-cabin-profile') } : {}),
        ...(execution.applied.cabin && execution.cabinEffectId
          ? { revert: existing?.cabin.revert ?? { status: 'available' as const } }
          : {}),
      },
      media: {
        status: failed('media.play')
          ? 'failed'
          : execution.applied.media
            ? 'succeeded'
            : execution.skipped.media
              ? 'skipped'
              : 'pending',
        ...(failed('media.play') ? { errorCode: failed('media.play') } : {}),
      },
    }
  }

  #applyReturnTripExecution(
    task: AirportPickupTaskState,
    workflowId: string,
    homeDestinationId: string | undefined,
    execution: ReturnType<EffectExecutor['executeReturnTrip']>,
  ): AirportPickupTaskState {
    return {
      ...task,
      returnTrip: this.#returnTripState(task, workflowId, homeDestinationId, execution),
      ...(execution.residual.route && execution.navigation
        ? {
            navigation: {
              routeId: execution.navigation.routeId,
              destination: execution.navigation.destination,
              eta: execution.navigation.eta,
              status: 'active' as const,
            },
          }
        : {}),
    }
  }

  #rollbackNavigation(current: StoredTask) {
    const navigation = current.task.navigation
    const route = current.toolResults?.['navigation.plan-route']?.data
    const destination = route?.waypoints?.at(-1)
    if (!navigation || !destination) return undefined
    return {
      routeId: navigation.routeId,
      destination: { id: destination.id, name: destination.name },
      eta: navigation.eta,
    }
  }

  #returnTripRetryActionToken(taskId: string, workflowId: string): string {
    return `${taskId}:retry-return-trip:${workflowId}`
  }

  #cabinRevertActionToken(taskId: string, receiptId: string): string {
    return `${taskId}:revert-cabin-profile:${receiptId}`
  }

  #appliedCabinReceipt(
    existing: StoredTask['effectReceipts'],
    receiptId: string,
    providerEffectId: string,
  ): NonNullable<StoredTask['effectReceipts']> {
    return {
      ...existing,
      activeCabin: {
        receiptId,
        providerEffectId,
        state: 'applied',
      },
    }
  }

  #publishReturnTripFailure(
    current: StoredTask,
    toolResults: ReadToolResults | undefined,
    workflowId: string,
    error?: ReadToolOrchestrationError,
    task: AirportPickupTaskState = current.task,
    effectReceipts: StoredTask['effectReceipts'] = current.effectReceipts,
  ): StoredTask {
    const taskChanged = JSON.stringify(task) !== JSON.stringify(current.task)
    const uiBase = {
      ...task,
      uiRevision: Math.max(task.uiRevision, current.ui.uiRevision),
    }
    const ui = applyRequestPresentation(composeFallbackSpec(
      uiBase,
      error?.code === 'PROVIDER_TIMEOUT' ? '返程设置暂时不可用' : '返程设置失败',
      taskChanged
        ? '部分返程操作仍在生效，当前状态已同步显示。请检查路线和座舱后重试未完成的设置。'
        : '返程操作已撤销，任务状态未改变。可以安全重试返程路线、座舱和媒体设置。',
      error?.code === 'PROVIDER_TIMEOUT' ? 'warning' : 'error',
      {
        actionId: 'retry-return-trip',
        label: '重试返程设置',
        componentId: 'return-trip-provider-fallback',
        actionToken: this.#returnTripRetryActionToken(current.task.taskId, workflowId),
      },
    ), current.requestContext)
    return { task, ui, toolResults, effectReceipts, requestContext: current.requestContext }
  }

  #submitSendMessageConfirmation(
    taskId: string,
    confirmationId: string,
    current: StoredTask,
    request: SubmitConfirmationRequest,
    operation: string,
    startedAt: number,
  ): AgentResponse {
    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const pendingMessageId = current.task.message.pendingMessageId
    const pendingContactId = current.task.message.pendingContactId
    const flight = current.task.flight
    if (!pendingMessageId || !pendingContactId || !flight) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current send-message confirmation is available', false, current)
    }

    const content = current.task.message.pendingText
      ? { contactId: pendingContactId, messageId: pendingMessageId, text: current.task.message.pendingText }
      : buildLandingNotifyContent(
          current.task.taskId,
          pendingContactId,
          flight.flightNumber,
          resolveLandingMeetingEta(current.task) ?? '即将到达',
        )
    const execution = request.decision === 'accept'
      ? this.#effectExecutor.sendConfirmedLandingMessage({
          task: current.task,
          contactId: pendingContactId,
          messageId: content.messageId,
          text: content.text,
          confirmationId,
          idempotencyKey: request.idempotencyKey,
          effectId: `${confirmationId}:send`,
        })
      : this.#effectExecutor.revokeLandingMessageConfirmation({
          task: current.task,
          confirmationId,
          idempotencyKey: request.idempotencyKey,
          effectId: `${confirmationId}:revoke`,
        })

    if (request.decision === 'reject' && !execution.succeeded) {
      const effects = [execution.effect]
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
      return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
    }

    let cleanupEffect: AgentResponse['effects'][number] | undefined
    if (request.decision === 'accept' && !execution.succeeded) {
      const revocation = this.#effectExecutor.revokeLandingMessageConfirmation({
        task: current.task,
        confirmationId,
        idempotencyKey: `${request.idempotencyKey}:failed-send`,
        effectId: `${confirmationId}:revoke`,
      })
      if (!revocation.succeeded) {
        const effects = [execution.effect, revocation.effect]
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
        return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
      }
      cleanupEffect = revocation.effect
    }

    const resolved = resolveLandingMessageRetry(
      current.task,
      {
        confirmationId,
        decision: request.decision,
        timestamp,
        sendSucceeded: request.decision === 'reject' ? true : execution.succeeded,
        errorCode: execution.effect.errorCode,
      },
    )
    if (!resolved) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current send-message confirmation is available', false, current)
    }

    let nextTask: AirportPickupTaskState
    let effects: AgentResponse['effects'] = []
    if (resolved.decision === 'reject') {
      nextTask = resolved.task
      effects = [execution.effect]
    } else {
      nextTask = applyEvent(resolved.task, resolved.event, this.#preferences)
      effects = cleanupEffect ? [execution.effect, cleanupEffect] : [execution.effect]
    }

    const stored = this.#store.save(this.#publish(
      nextTask,
      current.toolResults,
      current.requestContext,
      current.effectReceipts,
    ))
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #publish(
    task: AirportPickupTaskState,
    toolResults?: ReadToolResults,
    requestContext?: StoredTask['requestContext'],
    effectReceipts?: StoredTask['effectReceipts'],
    /**
     * Which side question this turn asked, when it asked one. Not derivable from
     * the snapshot — neither answer changes the task — so the asking turn says so.
     */
    queryAnswer?: 'departure' | 'calendar',
  ): StoredTask {
    // A terminal transition may defer a parked-only cabin cleanup. Keep only
    // that private receipt so a later parked event can safely finish it.
    const privateReceipts = task.phase === 'completed' || task.phase === 'cancelled'
      ? effectReceipts?.activeCabin?.state === 'deferred' ? effectReceipts : undefined
      : effectReceipts
    const canSafelyRevertCabin = requestContext !== undefined
      && requestContext.vehicle.speedKph === 0
      && requestContext.vehicle.gear === 'P'
    const cabinRevertActionToken = canSafelyRevertCabin && privateReceipts?.activeCabin
      && (privateReceipts.activeCabin.state === 'applied' || privateReceipts.activeCabin.state === 'revert-failed')
      ? this.#cabinRevertActionToken(task.taskId, privateReceipts.activeCabin.receiptId)
      : undefined
    const ui = applyRequestPresentation(this.#compose(
      task,
      toolResults,
      this.#preferences,
      cabinRevertActionToken || queryAnswer
        ? {
            ...(cabinRevertActionToken ? { cabinRevertActionToken } : {}),
            ...(queryAnswer ? { queryAnswer } : {}),
          }
        : undefined,
    ), requestContext)
    const uiWithoutStartNavigation = {
      ...ui,
      components: ui.components.map((component) => component.actions?.includes('start-navigation')
        ? { ...component, actions: component.actions.filter((actionId) => actionId !== 'start-navigation') }
        : component),
      actions: ui.actions.filter((action) => action.id !== 'start-navigation'),
    }
    const trustedRoute = toolResults?.['navigation.plan-route']
    const trustedRouteId = trustedRoute?.ok === true && trustedRoute.data !== null
      ? trustedRoute.data.routeId
      : undefined
    const canStartNavigation = task.phase === 'preparing'
      && task.flight?.status !== 'cancelled'
      && task.navigation?.status === 'planned'
      && trustedRoute?.ok === true
      && trustedRoute.data !== null
      && task.navigation.routeId === trustedRouteId
      && uiWithoutStartNavigation.components.some((component) => component.id === 'navigation-plan')
    const publishedUi = canStartNavigation
      ? {
          ...uiWithoutStartNavigation,
          // Prepended, not appended: the card can carry the pre-departure question
          // as well, and the control that leaves has to lead the one that asks.
          components: uiWithoutStartNavigation.components.map((component) => component.id === 'navigation-plan'
            ? { ...component, actions: ['start-navigation', ...(component.actions ?? [])] }
            : component),
          actions: [
            ...uiWithoutStartNavigation.actions,
            {
              id: 'start-navigation',
              label: '开始导航',
              style: 'primary' as const,
              event: { type: 'tool-request' as const, actionToken: 'start-navigation' },
            },
          ],
        }
      : uiWithoutStartNavigation
    return {
      task: { ...task, uiRevision: publishedUi.uiRevision },
      ui: publishedUi,
      ...(this.#modelUsed ? { modelUsed: this.#modelUsed } : {}),
      toolResults,
      effectReceipts: privateReceipts,
      requestContext,
    }
  }

  #publishFallback(
    task: AirportPickupTaskState,
    toolResults: ReadToolResults | undefined,
    error: ReadToolOrchestrationError,
    retry?: { actionId: string; label: string; componentId: string; actionToken: string },
    requestContext?: StoredTask['requestContext'],
    effectReceipts?: StoredTask['effectReceipts'],
  ): StoredTask {
    const timeout = error.code === 'PROVIDER_TIMEOUT'
    const baseUi = composeFallbackSpec(
      task,
      timeout ? '数据暂时不可用' : '数据源暂时不可用',
      timeout ? '正在保留当前任务信息，请稍后重试。' : '已保留当前任务信息，请稍后重试。',
      timeout ? 'warning' : 'error',
      retry,
    )
    const cabinReceipt = effectReceipts?.activeCabin
    const canRevertCabin = task.phase === 'returning-home'
      && task.returnTrip?.cabin.status === 'succeeded'
      && cabinReceipt !== undefined
      && (cabinReceipt.state === 'applied' || cabinReceipt.state === 'revert-failed')
      && requestContext !== undefined
      && requestContext.vehicle.speedKph === 0
      && requestContext.vehicle.gear === 'P'
    const fallbackComponentId = retry?.componentId ?? 'provider-fallback'
    const ui = canRevertCabin
      ? uiSpecSchema.parse({
          ...baseUi,
          components: baseUi.components.map((component) => component.id === fallbackComponentId
            ? { ...component, actions: [...(component.actions ?? []), 'revert-cabin-profile'] }
            : component),
          actions: [
            ...baseUi.actions,
            {
              id: 'revert-cabin-profile',
              label: '撤销座舱设置',
              style: 'secondary' as const,
              event: {
                type: 'tool-request' as const,
                actionToken: this.#cabinRevertActionToken(task.taskId, cabinReceipt.receiptId),
              },
            },
          ],
        })
      : baseUi
    return {
      task: { ...task, uiRevision: ui.uiRevision },
      ui: applyRequestPresentation(ui, requestContext),
      ...(this.#modelUsed ? { modelUsed: this.#modelUsed } : {}),
      toolResults,
      effectReceipts,
      requestContext,
    }
  }

  #assertRevisions(current: StoredTask, expectedTaskRevision: number, expectedUiRevision?: number): void {
    if (expectedTaskRevision !== current.task.taskRevision) {
      throw new AgentGatewayError(
        'TASK_REVISION_CONFLICT',
        `Expected task revision ${expectedTaskRevision}, received ${current.task.taskRevision}`,
        false,
        current,
      )
    }
    if (expectedUiRevision !== undefined && expectedUiRevision !== current.ui.uiRevision) {
      throw new AgentGatewayError(
        'UI_REVISION_CONFLICT',
        `Expected UI revision ${expectedUiRevision}, received ${current.ui.uiRevision}`,
        false,
        current,
      )
    }
  }

  #eventTimestamp(updatedAt: string): string {
    const now = this.#now()
    return Date.parse(now) < Date.parse(updatedAt) ? updatedAt : now
  }

  #contextAfterEvent(
    context: StoredTask['requestContext'],
    event: SubmitEventRequest['event'],
  ): StoredTask['requestContext'] {
    if (!context) return undefined
    if (event.type === 'user.input') return { ...context, inputConfidence: undefined }
    const eventTimestamp = Date.parse(event.timestamp)
    const contextTimestamp = context.updatedAt ? Date.parse(context.updatedAt) : undefined
    const equalTimestampParkedWouldClearMoving = event.type === 'vehicle.parked'
      && contextTimestamp === eventTimestamp
      && (context.vehicle.speedKph > 0 || context.vehicle.gear !== 'P')
    const contextEventIsCurrent = (contextTimestamp === undefined || eventTimestamp >= contextTimestamp)
      && !equalTimestampParkedWouldClearMoving
    if (!contextEventIsCurrent) return context
    if (event.type === 'vehicle.moving') {
      return {
        ...context,
        vehicle: {
          ...context.vehicle,
          speedKph: event.speedKph,
          gear: event.speedKph > 0 ? 'D' : context.vehicle.gear,
        },
        updatedAt: event.timestamp,
      }
    }
    if (event.type === 'vehicle.parked') {
      return { ...context, vehicle: { ...context.vehicle, speedKph: 0, gear: 'P' }, updatedAt: event.timestamp }
    }
    if (event.type === 'charging.completed') {
      return {
        ...context,
        vehicle: { ...context.vehicle, batteryPercent: event.batteryPercent },
        updatedAt: event.timestamp,
      }
    }
    return context
  }

  #resumeDeferredCabinCleanup(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse | undefined {
    const receipt = current.effectReceipts?.activeCabin
    if (request.event.type !== 'vehicle.parked' || receipt?.state !== 'deferred') return undefined

    const updatedContext = this.#contextAfterEvent(current.requestContext, request.event)
    const cleanup = this.#effectExecutor.revertCabinProfile({
      task: current.task,
      cabinEffectId: receipt.providerEffectId,
      idempotencyKey: `${request.event.eventId}:deferred-terminal-cabin`,
      effectId: `${request.event.eventId}:deferred-terminal-cabin`,
      vehicle: updatedContext?.vehicle,
      allowDeferredCleanup: true,
    })
    const effectReceipts = this.#deferredCleanupReceipts(current.effectReceipts, receipt, cleanup)
    const stored = this.#store.save(this.#publish(
      current.task,
      current.toolResults,
      updatedContext,
      effectReceipts,
    ))
    if (cleanup.succeeded && current.task.phase === 'collecting-information') {
      resetSideEffectRuntimeTask(this.#runtime, taskId)
    }
    const effects = [cleanup.effect]
    this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #deferredCleanupReceipts(
    existing: StoredTask['effectReceipts'],
    receipt: NonNullable<StoredTask['effectReceipts']>['activeCabin'],
    cleanup: ReturnType<EffectExecutor['revertCabinProfile']>,
  ): StoredTask['effectReceipts'] {
    if (!receipt) return existing
    return cleanup.succeeded
      ? { ...existing, activeCabin: { ...receipt, state: 'reverted' as const, lastErrorCode: undefined } }
      : cleanup.ambiguous
        ? { ...existing, activeCabin: { ...receipt, state: 'unknown' as const, lastErrorCode: cleanup.effect.errorCode } }
        : { ...existing, activeCabin: { ...receipt, state: 'deferred' as const, lastErrorCode: cleanup.effect.errorCode } }
  }

  #acceptsContextOnlyEvent(
    task: AirportPickupTaskState,
    context: StoredTask['requestContext'],
    event: SubmitEventRequest['event'],
  ): boolean {
    if (task.phase === 'completed' || task.phase === 'cancelled') return false
    if (Date.parse(event.timestamp) < Date.parse(task.updatedAt)) return false
    if (context?.updatedAt && Date.parse(event.timestamp) < Date.parse(context.updatedAt)) return false
    return event.type === 'vehicle.moving'
      || event.type === 'vehicle.parked'
      || event.type === 'charging.completed'
  }

  /**
   * Adds or retires the arrivals board for a task snapshot.
   *
   * The board only exists while the flight number is still missing: carried past
   * the pick it would keep offering a choice the driver already made, so a task
   * that has one — or has left the collecting phase — drops the key outright, and
   * the recorded set identity goes with it.
   *
   * Reading it is best-effort. A board is a shortcut for saying the number, not
   * the way to say it, so a provider failure leaves the plain ask standing
   * instead of taking the whole snapshot to the provider fallback.
   *
   * `refresh` throws the memorized board away and reads again. Returns the task
   * alongside the results because the set's identity belongs on the task: the
   * ordinal path has to be able to ask "is the board I am counting against still
   * the one that was recorded", and it can only ask that if both halves were
   * written together. Snapshot identity is preserved when neither half changes,
   * so the caller's own `next !== current.task` reading still means what it says.
   */
  #withArrivalsBoard(
    taskId: string,
    requestId: string,
    task: AirportPickupTaskState,
    toolResults: ReadToolResults | undefined,
    options: { refresh?: boolean } = {},
  ): { task: AirportPickupTaskState; toolResults: ReadToolResults } {
    const carried: ReadToolResults = { ...toolResults }
    if (task.phase !== 'collecting-information' || task.flight) {
      delete carried['flight.list-arrivals']
      return { task: withoutFlightDiscovery(task), toolResults: carried }
    }
    if (options.refresh) delete carried['flight.list-arrivals']
    const memorized = carried['flight.list-arrivals']
    if (memorized) return { task: withFlightDiscovery(task, memorized.data), toolResults: carried }
    try {
      const board = this.#orchestrator.resolveArrivals?.(taskId, `${requestId}:arrivals`)
      return board
        ? {
            task: withFlightDiscovery(task, board.data),
            toolResults: { ...carried, 'flight.list-arrivals': board },
          }
        : { task: withoutFlightDiscovery(task), toolResults: carried }
    } catch {
      return { task: withoutFlightDiscovery(task), toolResults: carried }
    }
  }

  /**
   * The rows the driver is actually looking at, or undefined when there is no
   * board a rank may be counted against as of `at`.
   *
   * Persisted toolResults only — a fresh read here would resolve an ordinal from
   * data the driver has never seen — gated on the composer's own renderability
   * rule via the shared renderedArrivalRows, and on two further questions that
   * are really the same question: is this still the set the rank was spoken
   * against?
   *
   * The board's own `candidateSetId` has to match the one the task recorded when
   * it read it. The two are written together, so a disagreement means something
   * has gotten them out of step — and a rank resolved against a set nobody can
   * name is exactly the mis-pick the identity exists to prevent. Refusing costs
   * the driver a "没听懂"; guessing costs them the wrong flight. A task with no
   * record at all predates the field rather than contradicting it, so its
   * persisted board still stands.
   *
   * And the set has to not have expired. A revision number cannot express this:
   * a task resumed the next morning carries a perfectly current revision and a
   * board describing yesterday's arrivals.
   *
   * That last question is only askable of a board read from a real provider,
   * because only then is the board's clock this clock. A fixture board is
   * authored on one fixed day — every fixture result is stamped with the same
   * `generatedAt` so replays stay byte-for-byte reproducible — so its `expiresAt`
   * is a statement inside that day, not an instant on the wall. Measuring it
   * against `now()` would not make the demo careful; it would retire the spoken
   * ordinal permanently the morning after the fixture date, for a board still
   * being rendered and still perfectly answerable by row. The id and the revision
   * bump are what guard a fixture board, and they are frame-free.
   */
  #renderedArrivalRows(current: StoredTask, at: string) {
    const read = current.toolResults?.['flight.list-arrivals']
    const board = read?.data
    if (!board) return undefined
    const recorded = current.task.flightDiscovery
    if (recorded && recorded.candidateSetId !== board.candidateSetId) return undefined
    if (recorded && read?.meta.provider === 'live' && Date.parse(at) >= Date.parse(recorded.expiresAt)) {
      return undefined
    }
    return renderedArrivalRows(board)
  }

  /**
   * Which airport a "机场天气怎么样" question is about.
   *
   * The trip's settled destination first, then the picked flight's own airport
   * for a task prepared before that field was recorded. 虹桥 only when neither
   * exists — which means no flight has been chosen yet, so there is no chosen
   * airport to be wrong about, and the demo city's main airport is the only
   * sensible reading of the question.
   */
  #arrivalWeatherLocationId(current: StoredTask): string {
    if (current.requestContext?.destination) return current.requestContext.destination.id
    const airport = current.task.flight?.arrivalAirport
    return airport ? pickupDestinationForAirport(airport).id : 'destination-hongqiao-t2'
  }

  #prepareTask(
    task: AirportPickupTaskState,
    requestId: string,
    flightNumber: string,
    requestContext?: StoredTask['requestContext'],
  ) {
    const reads = this.#orchestrator.prepareTrip(task.taskId, requestId, flightNumber, requestContext ? {
      vehicle: requestContext.vehicle,
      ...(requestContext.destination ? { destination: requestContext.destination } : {}),
    } : undefined)
    return {
      task: {
        ...task,
        flight: {
          flightNumber: reads.flight.flightNumber,
          status: reads.flight.status,
          scheduledArrival: reads.flight.scheduledArrival,
          estimatedArrival: reads.flight.estimatedArrival,
          arrivalAirport: reads.flight.arrivalAirport,
          terminal: reads.flight.terminal,
          baggageClaim: reads.flight.baggageClaim,
        },
        navigation: {
          routeId: reads.route.routeId,
          // The destination the drive was actually planned to, not the one the
          // request arrived with — those differ the moment a 浦东 flight is
          // picked, and the label has to name the place the car is going.
          destination: reads.destination.name,
          eta: reads.route.arrivalTime,
          status: 'planned' as const,
        },
        charging: {
          ...task.charging,
          recommended: reads.charging.recommended,
          status: reads.charging.recommended ? 'planned' as const : 'none' as const,
        },
      },
      /**
       * Handed back so the caller can persist it on the request context. Every
       * later turn — the weather advisory in particular — then reads the airport
       * this trip settled on instead of re-deriving it or assuming 虹桥.
       */
      destination: reads.destination,
      toolResults: reads.toolResults,
    }
  }

  #throwProviderError(error: unknown, latest?: StoredTask): never {
    if (error instanceof ReadToolOrchestrationError) {
      throw new AgentGatewayError(error.code, error.message, error.retryable, latest)
    }
    throw error
  }

  #requireTask(taskId: string): StoredTask {
    const stored = this.#store.get(taskId)
    if (!stored) throw new AgentGatewayError('TASK_NOT_FOUND', `Task not found: ${taskId}`)
    return stored
  }

  #planUserInput(text: string, state: AirportPickupTaskState, eventId: string, timestamp: string): Plan {
    const input: PlannerInput = { text, state, eventId, timestamp }
    return this.#planner.plan(input)
  }

  /**
   * Persists the one snapshot a side answer rides on.
   *
   * A side answer changes nothing about the trip, so what stays in the store is
   * the brief that was already there — carrying the answer's revision, so the
   * next compose still moves forward and the client's optimistic concurrency
   * still lines up. The answer itself lives only in the response that carries it:
   * a reconnect, a stream replay, or an event that turns out to be a no-op all
   * show the trip, not yesterday's reading of the weather.
   *
   * Replay for a question is a different animal from replay for an event, so it
   * is kept in its own keyspace and answered by the two helpers below rather than
   * by the general check at the top of `submitEvent`. An event is replayed to
   * avoid applying it twice, which is true forever. A question is replayed to
   * finish a delivery that was interrupted — and that is only true while the trip
   * has not moved since. Past that, the same eventId is answered again from where
   * the car actually is, because the reading it would otherwise replay describes
   * a state that is over: a departure recommendation for a departure already made.
   */
  #persistBriefBehind(published: StoredTask, current: StoredTask): StoredTask {
    return this.#store.save({
      ...current,
      task: { ...current.task, uiRevision: published.task.uiRevision },
      ui: { ...current.ui, uiRevision: published.ui.uiRevision },
    })
  }

  #replaySideAnswer(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse | undefined {
    const previous = this.#freshSideAnswer(taskId, current, request.event.eventId)
    if (!previous) return undefined
    return this.#response(
      request.clientRequestId,
      previous.stored,
      [],
      performance.now() - startedAt,
      previous.assistant,
    )
  }

  /**
   * The recorded side answer for this event id, if replaying it would still be
   * telling the truth. Two things can make it untrue. The trip can move, and the
   * task revision says that. Or another turn can publish over it — including
   * another side answer, which leaves the task revision alone and moves only the
   * UI revision — and the UI revision the brief was left at says that. A retry
   * that matches both is the client asking again for a response it lost, and gets
   * that response back whole: same snapshot, same spoken line, no second bump.
   */
  #freshSideAnswer(taskId: string, current: StoredTask, eventId: string): StoredEventResult | undefined {
    const previous = this.#store.getIdempotencyResult(taskId, SIDE_ANSWER_OPERATION, eventId)
    if (!previous) return undefined
    const fresh = previous.stored.task.taskRevision === current.task.taskRevision
      && previous.stored.ui.uiRevision === current.ui.uiRevision
    return fresh ? previous : undefined
  }

  #recordSideAnswer(
    taskId: string,
    eventId: string,
    stored: StoredTask,
    assistant: { text: string; shouldSpeak: boolean },
  ): void {
    this.#store.recordIdempotencyResult(taskId, SIDE_ANSWER_OPERATION, eventId, { stored, effects: [], assistant })
  }

  /**
   * The check-weather query turn. A query mutates nothing: the task state,
   * revision, and processed-event bookkeeping stay untouched. Only the UI is
   * re-composed with the weather read merged in — and the merged read is
   * deliberately NOT persisted, so the very next accepted event re-composes
   * without it and the card yields the surface back to the trip. Failure
   * degrades to a spoken notice on the unchanged snapshot; the fallback
   * banner is for broken trips, not for a missing side answer.
   */
  #submitWeatherQuery(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse {
    const supportsTts = current.requestContext?.clientCapabilities.supportsTts ?? true
    // Where and when follow the trip, not the request context: once the
    // passengers are onboard the car is routing home, so the airport stored at
    // create time is no longer the place being asked about — and a landed
    // flight's arrival is history, not a forecast moment.
    const returning = current.task.passengers.confirmedOnboard
    const arrivalAhead = !returning
      && current.task.flight !== undefined
      && current.task.flight.status !== 'landed'
      && current.task.flight.status !== 'cancelled'
    let weather: ReadToolResults['weather.get-current']
    try {
      weather = this.#orchestrator.resolveWeather?.(taskId, request.clientRequestId, {
        locationId: returning
          ? current.task.returnTrip?.homeDestinationId ?? 'destination-home'
          : this.#arrivalWeatherLocationId(current),
        ...(arrivalAhead ? { at: current.task.flight!.estimatedArrival } : {}),
      })
    } catch (error) {
      if (!(error instanceof ReadToolOrchestrationError)) this.#throwProviderError(error, current)
      weather = undefined
    }

    // A read that failed is not an answer, so it is not recorded: a retry gets a
    // real attempt at the provider rather than the apology, and there is no state
    // behind it that a second attempt could disturb.
    if (!weather) {
      return this.#response(request.clientRequestId, current, [], performance.now() - startedAt, {
        text: '天气服务暂时不可用，稍后可以再问我。',
        shouldSpeak: supportsTts,
      })
    }

    const published = this.#publish(
      current.task,
      { ...current.toolResults, 'weather.get-current': weather },
      current.requestContext,
      current.effectReceipts,
    )
    // Transience lives in these two lines: the answer is what the caller gets,
    // and the brief is what the store keeps.
    const answered = { ...published, toolResults: current.toolResults }
    this.#persistBriefBehind(published, current)
    const assistant = { text: weatherSpokenSummary(weather.data, arrivalAhead, returning), shouldSpeak: supportsTts }
    this.#recordSideAnswer(taskId, request.event.eventId, answered, assistant)
    return this.#response(request.clientRequestId, answered, [], performance.now() - startedAt, assistant)
  }

  /**
   * The check-schedule query turn. Same transient contract as the weather
   * query: nothing about the task changes, the answer rides one published
   * snapshot, and the next accepted event recomposes without it. The reading
   * goes under its own 'calendar.query' key so the schedule strip's persisted
   * 'calendar.list-upcoming' data is never disturbed.
   */
  #submitScheduleQuery(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse {
    const supportsTts = current.requestContext?.clientCapabilities.supportsTts ?? true
    // A prefetched live reading wins; the deterministic fixture calendar is
    // the fallback for every other case (not configured, prefetch failed, or
    // the synchronous entry point that cannot prefetch at all). The composer
    // reads the provenance off meta.provider, so nothing more is threaded.
    let schedule: ReadToolResults['calendar.query'] = this.#prefetchedSchedule
    if (!schedule) {
      try {
        schedule = this.#orchestrator.resolveSchedule?.(taskId, request.clientRequestId, {
          date: FIXTURE_CALENDAR_DATE,
        })
      } catch (error) {
        if (!(error instanceof ReadToolOrchestrationError)) this.#throwProviderError(error, current)
        schedule = undefined
      }
    }

    // Same as the weather notice: not recorded, so a retry actually retries.
    if (!schedule) {
      return this.#response(request.clientRequestId, current, [], performance.now() - startedAt, {
        text: '日程服务暂时不可用，稍后可以再问我。',
        shouldSpeak: supportsTts,
      })
    }

    const published = this.#publish(
      current.task,
      { ...current.toolResults, 'calendar.query': schedule },
      current.requestContext,
      current.effectReceipts,
    )
    // Same two lines as the weather answer: the caller gets the card, the store
    // keeps the brief.
    const answered = { ...published, toolResults: current.toolResults }
    this.#persistBriefBehind(published, current)
    const assistant = { text: scheduleSpokenSummary(schedule.data.events), shouldSpeak: supportsTts }
    this.#recordSideAnswer(taskId, request.event.eventId, answered, assistant)
    return this.#response(request.clientRequestId, answered, [], performance.now() - startedAt, assistant)
  }

  /**
   * The check-departure-time query turn. Same transient contract as the weather
   * and schedule queries — nothing about the task changes, the answer rides one
   * published snapshot — but with no provider behind it: the landing time and the
   * planned drive are already on the snapshot, so the answer is arithmetic over
   * facts the trip has, not a new read.
   *
   * Nothing to work backwards from (no flight, or no planned route yet) leaves
   * the snapshot untouched and says so out loud. A missing side answer is not a
   * broken trip, so the fallback banner stays out of it.
   */
  #submitDepartureQuery(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse {
    const supportsTts = current.requestContext?.clientCapabilities.supportsTts ?? true
    // Once the car has left, when to leave is not a question with an answer any
    // more, and the pre-departure recommendation is the one thing that must not be
    // repeated: it was worked backwards from the landing, so it still reads as
    // advice long after it stopped being any. What the driver is actually asking
    // at that point is whether they are on time, so they get the arrival they are
    // heading for — no card, and nothing about the trip touched.
    if (hasDeparted(current.task)) {
      const eta = current.task.navigation?.eta
      const underway = {
        text: eta && current.task.navigation?.destination
          ? `已经在路上了，预计 ${clockLabel(eta)} 到${current.task.navigation.destination}。`
          : '已经出发了，我会跟着行程提醒你。',
        shouldSpeak: supportsTts,
      }
      this.#recordSideAnswer(taskId, request.event.eventId, current, underway)
      return this.#response(request.clientRequestId, current, [], performance.now() - startedAt, underway)
    }
    const plan = departurePlan(current.task, current.toolResults?.['navigation.plan-route']?.data)
    if (!plan) {
      const nothingYet = { text: '还没有航班和路线可以推算出发时间。', shouldSpeak: supportsTts }
      this.#recordSideAnswer(taskId, request.event.eventId, current, nothingYet)
      return this.#response(request.clientRequestId, current, [], performance.now() - startedAt, nothingYet)
    }
    const published = this.#publish(
      current.task,
      current.toolResults,
      current.requestContext,
      current.effectReceipts,
      'departure',
    )
    // The card is not in the persisted toolResults to begin with — it exists
    // because this turn asked — so the brief goes back behind it the same way.
    this.#persistBriefBehind(published, current)
    const assistant = {
      text: `建议 ${plan.departAtLabel} 出发，路上约 ${plan.driveMinutes} 分钟，比落地早 ${plan.bufferMinutes} 分钟到。`,
      shouldSpeak: supportsTts,
    }
    this.#recordSideAnswer(taskId, request.event.eventId, published, assistant)
    return this.#response(request.clientRequestId, published, [], performance.now() - startedAt, assistant)
  }

  /**
   * 稍后提醒: record the departure the driver was just told about, so they do not
   * have to hold it.
   *
   * No provider, no message, no timer — this demo has no scheduler, and inventing
   * one behind a button would be the dishonest version of this feature. What the
   * driver gets is real and bounded: the time is recorded, said back, and stated
   * on the departure card from here on, so 什么时候出发 answers with the reminder
   * instead of re-asking the question.
   *
   * The time is recomputed from the same landing and route the card was drawn
   * from, not taken from the request, so the reminder can only ever name a time
   * the driver could have seen. Nothing to work backwards from means nothing to
   * promise, and once the car has left there is no departure ahead to remind about.
   */
  #armDepartureReminder(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse {
    const replayed = this.#store.getEventResult(taskId, request.event.eventId)
    if (replayed) return this.#response(request.clientRequestId, replayed.stored, replayed.effects, performance.now() - startedAt)
    const supportsTts = current.requestContext?.clientCapabilities.supportsTts ?? true
    const route = current.toolResults?.['navigation.plan-route']?.data
    const plan = hasDeparted(current.task) ? undefined : departurePlan(current.task, route)
    const remindAt = plan ? departureAtIso(current.task, route) : undefined
    if (!plan || !remindAt) {
      const nothingToPromise = {
        text: hasDeparted(current.task) ? '已经在路上了，不用再提醒出发。' : '还没有航班和路线可以推算出发时间。',
        shouldSpeak: supportsTts,
      }
      return this.#response(request.clientRequestId, current, [], performance.now() - startedAt, nothingToPromise)
    }
    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const armed = withDepartureReminder(current.task, remindAt, timestamp)
    // Re-arming the same time claims nothing new, so the snapshot is handed back
    // untouched and the driver still hears the confirmation they asked for.
    if (armed === current.task) {
      return this.#response(request.clientRequestId, current, [], performance.now() - startedAt, {
        text: `已经设好了，${plan.departAtLabel} 提醒你出发。`,
        shouldSpeak: supportsTts,
      })
    }
    const next: AirportPickupTaskState = {
      ...armed,
      taskRevision: current.task.taskRevision + 1,
      updatedAt: timestamp,
    }
    const stored = this.#store.save(this.#publish(next, current.toolResults, current.requestContext, current.effectReceipts))
    this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
    return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt, {
      text: `好的，${plan.departAtLabel} 我提醒你出发。`,
      shouldSpeak: supportsTts,
    })
  }

  /**
   * 查看日程: show the calendar `prepareTrip` already read.
   *
   * Same transient contract as the other side answers and the same card the
   * schedule query draws — the difference is entirely in what it costs. The events
   * are on the snapshot, so this turn calls no provider, which is what makes it
   * safe to put on the departure card as a glance rather than as a request.
   *
   * No read means nothing to show. The driver is told so and pointed at the
   * question that does go and ask, rather than being given an empty card that
   * would read as "you have nothing on today".
   */
  #submitCalendarView(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse {
    const supportsTts = current.requestContext?.clientCapabilities.supportsTts ?? true
    const upcoming = current.toolResults?.['calendar.list-upcoming']
    if (!upcoming || upcoming.data.events.length === 0) {
      const nothingRead = { text: '现在还没有读到日程，可以说「看看日程」我去查一下。', shouldSpeak: supportsTts }
      this.#recordSideAnswer(taskId, request.event.eventId, current, nothingRead)
      return this.#response(request.clientRequestId, current, [], performance.now() - startedAt, nothingRead)
    }
    const published = this.#publish(
      current.task,
      current.toolResults,
      current.requestContext,
      current.effectReceipts,
      'calendar',
    )
    this.#persistBriefBehind(published, current)
    const next = [...upcoming.data.events].sort((left, right) => left.startAt.localeCompare(right.startAt))[0]!
    const assistant = {
      text: `今天还有 ${upcoming.data.events.length} 项安排，下一项是 ${clockLabel(next.startAt)} ${next.title}。`,
      shouldSpeak: supportsTts,
    }
    this.#recordSideAnswer(taskId, request.event.eventId, published, assistant)
    return this.#response(request.clientRequestId, published, [], performance.now() - startedAt, assistant)
  }

  /**
   * 提醒乘客带伞 while the advisory is active: prepare the umbrella reminder
   * with the same provider and confirmation machinery as the landing retry,
   * arm the confirm-then-send window (message scheduled + pendingText +
   * pendingConfirmation), and retire the advisory as resolved. The reminder
   * itself still goes out only after the driver confirms the preview.
   */
  #submitWeatherReminder(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse {
    const replayed = this.#store.getEventResult(taskId, request.event.eventId)
    if (replayed) return this.#response(request.clientRequestId, replayed.stored, replayed.effects, performance.now() - startedAt)
    const supportsTts = current.requestContext?.clientCapabilities.supportsTts ?? true

    const contactId = resolveAuthorizedLandingContact(current.task.passengers.memberIds, this.#preferences)
    if (!contactId) {
      this.#store.recordEventResult(taskId, request.event.eventId, { stored: current, effects: [] })
      return this.#response(request.clientRequestId, current, [], performance.now() - startedAt, {
        text: '没有已授权的提醒联系人，暂时无法发送。',
        shouldSpeak: supportsTts,
      })
    }

    const execution = this.#effectExecutor.prepareWeatherReminder({
      task: current.task,
      contactId,
      idempotencyKey: `${request.event.eventId}:umbrella`,
      effectId: `${request.event.eventId}:effect:0`,
    })
    if (!execution.succeeded || !execution.prepared) {
      const effects = [execution.effect]
      this.#store.recordEventResult(taskId, request.event.eventId, { stored: current, effects })
      return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt, {
        text: '提醒暂时没能准备好，稍后可以再试。',
        shouldSpeak: supportsTts,
      })
    }

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const armed: AirportPickupTaskState = {
      ...current.task,
      taskRevision: current.task.taskRevision + 1,
      weatherAdvisory: { status: 'resolved', advisedAt: current.task.weatherAdvisory!.advisedAt },
      message: {
        ...current.task.message,
        status: 'scheduled',
        pendingMessageId: execution.prepared.messageId,
        pendingContactId: execution.prepared.contactId,
        pendingText: execution.prepared.text,
        idempotencyKey: execution.prepared.messageId,
        scheduledAt: timestamp,
      },
      pendingConfirmation: {
        confirmationId: execution.prepared.confirmationId,
        action: 'send-message',
      },
      updatedAt: timestamp,
    }
    const stored = this.#store.save(this.#publish(armed, current.toolResults, current.requestContext, current.effectReceipts))
    const effects = [execution.effect]
    this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt, {
      text: '带伞提醒已准备好，请确认后发送。',
      shouldSpeak: supportsTts,
    })
  }

  /**
   * 刷新航班: throw the memorized arrivals board away and read it again.
   *
   * A real re-read, not a recompose, and `taskRevision` moves with it. That bump
   * is what protects the turn: a spoken rank already in flight was planned
   * against the board that was on screen a moment ago, and it now fails the
   * ordinary revision guard instead of landing on whichever flight happens to
   * sit third in the new set.
   *
   * Against fixture data the re-read usually returns the same five rows and so
   * the same `candidateSetId`. That is honest rather than disappointing — a set
   * that did not change cannot be mis-picked from — and it is why the identity is
   * not the thing doing the rejecting. Its job is to make which set was picked
   * from inspectable, and to carry the expiry a revision number cannot express.
   */
  #refreshFlightOptions(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse {
    const replayed = this.#store.getEventResult(taskId, request.event.eventId)
    if (replayed) return this.#response(request.clientRequestId, replayed.stored, replayed.effects, performance.now() - startedAt)
    const supportsTts = current.requestContext?.clientCapabilities.supportsTts ?? true

    const refreshed = this.#withArrivalsBoard(
      taskId,
      request.clientRequestId,
      current.task,
      current.toolResults,
      { refresh: true },
    )
    const board = refreshed.toolResults['flight.list-arrivals']
    // Nothing came back, so nothing is claimed and nothing is recorded: the board
    // the driver is looking at stays exactly as it was rather than being cleared
    // by a failed attempt to improve it, and a retry gets a real attempt.
    if (!board) {
      return this.#response(request.clientRequestId, current, [], performance.now() - startedAt, {
        text: '航班列表暂时刷新不了，稍后可以再试。',
        shouldSpeak: supportsTts,
      })
    }

    const next: AirportPickupTaskState = {
      ...refreshed.task,
      taskRevision: current.task.taskRevision + 1,
      updatedAt: this.#eventTimestamp(current.task.updatedAt),
    }
    const stored = this.#store.save(this.#publish(next, refreshed.toolResults, current.requestContext, current.effectReceipts))
    this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
    // The count is the rows the card will draw, not the rows the board carries: a
    // cancelled flight is not a choice, and a spoken number that disagrees with
    // the list in front of the driver is worse than no number at all.
    const shown = renderedArrivalRows(board.data)
    return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt, {
      text: shown
        ? `航班列表已刷新，${board.data.arrivalCityName}还有 ${shown.length} 个到达航班。`
        : '刷新后没有可选的到达航班，直接告诉我航班号也可以。',
      shouldSpeak: supportsTts,
    })
  }

  /**
   * 暂不处理: retire whichever advisory is on screen, for good.
   *
   * One path for the family. The words never name the prompt, so the handler does
   * not either — `retireActiveAdvisories` is the single place that knows which
   * fields an advisory lives in, and it is the place the `advisories[]` P1 lands.
   * Today that is exactly one field, and saying so here is cheaper than pretending
   * otherwise.
   *
   * That something is active is the dispatcher's condition, checked through the
   * same `hasActiveAdvisory` seam, so the retirement here always claims something
   * and the bump is unconditional.
   */
  #dismissAdvisory(
    taskId: string,
    current: StoredTask,
    request: SubmitEventRequest,
    startedAt: number,
  ): AgentResponse {
    const replayed = this.#store.getEventResult(taskId, request.event.eventId)
    if (replayed) return this.#response(request.clientRequestId, replayed.stored, replayed.effects, performance.now() - startedAt)
    const supportsTts = current.requestContext?.clientCapabilities.supportsTts ?? true
    const dismissed: AirportPickupTaskState = {
      ...retireActiveAdvisories(current.task),
      taskRevision: current.task.taskRevision + 1,
      updatedAt: this.#eventTimestamp(current.task.updatedAt),
    }
    const stored = this.#store.save(this.#publish(dismissed, current.toolResults, current.requestContext, current.effectReceipts))
    this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
    return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt, {
      text: '好的，先不处理。',
      shouldSpeak: supportsTts,
    })
  }

  #response(
    requestId: string,
    stored: StoredTask,
    effects: AgentResponse['effects'],
    durationMs: number,
    assistantOverride?: { text: string; shouldSpeak: boolean },
  ): AgentResponse {
    const assistant = assistantOverride ?? (stored.task.phase === 'collecting-information'
      ? {
          text: stored.requestContext?.inputConfidence !== undefined && stored.requestContext.inputConfidence < 0.6
            ? '我不太确定刚才的内容，请确认或编辑后再试一次。'
            : stored.task.flight === undefined
            ? '好的，请告诉我她们的航班号。'
            : '好的，请告诉我要接哪位家人。',
          shouldSpeak: stored.requestContext?.clientCapabilities.supportsTts ?? true,
        }
      : undefined)
    return agentResponseSchema.parse({
      requestId,
      task: stored.task,
      ui: stored.ui,
      assistant,
      effects,
      meta: {
        mode: this.#mode,
        durationMs,
        ...(stored.modelUsed ? { modelUsed: stored.modelUsed } : {}),
        fallbackUsed: stored.ui.meta.generatedBy === 'fallback',
      },
    })
  }
}

/**
 * Records which set of arrivals the driver is choosing from.
 *
 * Identity only — the rows themselves stay in the persisted tool result, and a
 * second copy on the task would be a second truth to keep in step. Returns the
 * same snapshot when the record already says this, so writing it cannot make an
 * unrelated event look like it changed the task.
 */
function withFlightDiscovery(
  task: AirportPickupTaskState,
  board: { candidateSetId: string; expiresAt: string },
): AirportPickupTaskState {
  const recorded = task.flightDiscovery
  if (recorded?.candidateSetId === board.candidateSetId && recorded.expiresAt === board.expiresAt) return task
  return { ...task, flightDiscovery: { candidateSetId: board.candidateSetId, expiresAt: board.expiresAt } }
}

/** Drops the record with the board it described, on the same identity terms. */
function withoutFlightDiscovery(task: AirportPickupTaskState): AirportPickupTaskState {
  if (task.flightDiscovery === undefined) return task
  const rest = { ...task }
  delete rest.flightDiscovery
  return rest
}

/**
 * Retires every advisory currently prompting, and returns the same snapshot when
 * none was.
 *
 * The one place that knows where advisories live. Today the answer is a single
 * `weatherAdvisory` field, so this reads as a long way to write one assignment —
 * but it is the seam the `advisories[]` P1 replaces, and having the dismissal
 * path go through it now means that change is local to this function instead of
 * being spread across a handler that names the weather.
 *
 * `dismissed` rather than deleted: the trip must never re-prompt, and an absent
 * field is indistinguishable from one that never fired.
 */
function retireActiveAdvisories(task: AirportPickupTaskState): AirportPickupTaskState {
  if (task.weatherAdvisory?.status !== 'active') return task
  return { ...task, weatherAdvisory: { status: 'dismissed', advisedAt: task.weatherAdvisory.advisedAt } }
}

/**
 * Whether any advisory is still prompting — the question 暂不处理 needs answered
 * before it means anything.
 *
 * Paired with `retireActiveAdvisories` deliberately: the predicate and the
 * retirement have to agree about where advisories live, so they sit together and
 * a second kind of advisory is two edits in one place rather than a search.
 */
function hasActiveAdvisory(task: AirportPickupTaskState): boolean {
  return task.weatherAdvisory?.status === 'active'
}

/**
 * Records a standing departure reminder, and returns the same snapshot when one
 * already says this.
 *
 * The recommendation is recomputed here rather than passed in so the reminder can
 * only ever name a time the card could have shown. `armedAt` is what makes a
 * re-arm visible: the same `remindAt` set twice is not the same fact twice.
 */
function withDepartureReminder(
  task: AirportPickupTaskState,
  remindAt: string,
  armedAt: string,
): AirportPickupTaskState {
  const standing = task.departureReminder
  if (standing?.remindAt === remindAt) return task
  return { ...task, departureReminder: { remindAt, armedAt } }
}

/** One short cabin-appropriate sentence; the card carries the detail. */
function weatherSpokenSummary(data: WeatherOutput, forArrival: boolean, returning: boolean): string {
  const moment = forArrival ? '到达时' : '现在'
  const rain = data.condition === 'light-rain' || data.condition === 'heavy-rain'
  // The wait-indoors suggestion is for family still to be picked up; on the way
  // home with everyone onboard the rain is just a fact worth hearing.
  const closing = rain
    ? returning ? '，路上请慢行' : '，建议家人在到达层室内等候'
    : returning ? '' : '，适合接机'
  return `${moment}${data.locationName}${weatherConditionLabels[data.condition]} ${Math.round(data.temperatureC)} 度${closing}。`
}

/** The demo calendar's fixture day; the shipped fixture data lives on it. */
const FIXTURE_CALENDAR_DATE = '2026-07-22'

/**
 * Whether the car has already left for the airport.
 *
 * Phase alone is the wrong test on its own — a trip can be `preparing` with a
 * planned route and no wheels turning, and that is exactly when the departure
 * question belongs. What marks the crossing is navigation going active, which is
 * what `start-navigation` does and what every later phase inherits.
 */
function hasDeparted(task: AirportPickupTaskState): boolean {
  return task.navigation?.status === 'active'
    || task.phase === 'driving-to-airport'
    || task.phase === 'approaching-airport'
    || task.phase === 'waiting-for-passengers'
    || task.phase === 'returning-home'
}

function scheduleSpokenSummary(events: Array<{ title: string; startAt: string }>): string {
  if (events.length === 0) return '今天没有更多安排了。'
  const nextClock = events[0]!.startAt.match(/T(\d{2}:\d{2})/)?.[1]
  const nextPart = nextClock ? `，最近是 ${nextClock} 的${events[0]!.title}` : ''
  return `今天还有 ${events.length} 项安排${nextPart}。`
}

function isCabinRevertPolicyDenial(errorCode: string | undefined): boolean {
  return errorCode === 'TASK_TERMINAL'
    || errorCode === 'INVALID_TASK_PHASE'
    || errorCode === 'FLIGHT_CANCELLED'
    || errorCode === 'INVALID_TASK_STATE'
    || errorCode === 'VEHICLE_CONTEXT_REQUIRED'
    || errorCode === 'VEHICLE_MOVING'
}

function isDeferredCabinCleanup(errorCode: string | undefined): errorCode is 'VEHICLE_CONTEXT_REQUIRED' | 'VEHICLE_MOVING' {
  return errorCode === 'VEHICLE_CONTEXT_REQUIRED' || errorCode === 'VEHICLE_MOVING'
}

function cabinCleanupDeferredEffect(effectId: string, errorCode: 'VEHICLE_CONTEXT_REQUIRED' | 'VEHICLE_MOVING'): EffectRecord {
  return {
    effectId,
    type: 'vehicle.revert-cabin-profile',
    status: 'failed',
    tool: 'vehicle.revert-cabin-profile',
    errorCode,
  }
}
